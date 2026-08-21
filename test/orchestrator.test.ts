import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterOrchestrator } from "../src/orchestrator.js";
import { AttemptPersistence } from "../src/attempt-persistence.js";
import { StateStore } from "../src/persistence.js";
import { GitWorktreeManager } from "../src/worktree.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const usage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

class MockModel implements ProviderAdapter {
  readonly provider = "openai-codex" as const;
  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const text = request.stage === "PLAN"
      ? JSON.stringify({ steps: ["edit parser"], allowedFiles: ["src/parser.ts"], constraints: ["no API change"], acceptance: ["tests pass"], validationCommands: ["npm test"] })
      : request.stage === "REVIEW" ? JSON.stringify({ verdict: "pass", findings: [], summary: "accepted" }) : "execution completed";
    return { text, requestId: request.stage, provider: request.route.provider, model: request.route.model, usage };
  }
}
class MockLocal implements ProviderAdapter {
  readonly provider = "local" as const;
  async invoke(request: ProviderRequest): Promise<ProviderResponse> { return { text: JSON.stringify({ passed: true, results: [] }), requestId: "local", provider: "local", model: request.route.model, usage: { ...usage, inputTokens: 0, outputTokens: 0 } }; }
}

class WritingModel extends MockModel {
  readonly workingDirectories: string[] = [];
  override async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.stage === "EXECUTE" || request.stage === "REVIEW") this.workingDirectories.push(request.workingDirectory ?? "");
    if (request.stage === "EXECUTE") await writeFile(path.join(request.workingDirectory!, "src", "parser.ts"), "export const parser = 2;\n");
    return super.invoke(request);
  }
}

class WritingLocal extends MockLocal {
  readonly workingDirectories: string[] = [];
  override async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    this.workingDirectories.push(request.workingDirectory ?? "");
    await mkdir(path.join(request.workingDirectory!, "dist")); await writeFile(path.join(request.workingDirectory!, "dist", "validation.txt"), "synthetic\n");
    return super.invoke(request);
  }
}

class FailingWorktreeManager extends GitWorktreeManager {
  override async prepare(): Promise<never> { throw new Error("synthetic worktree failure"); }
}

class BarrierWorktreeManager extends GitWorktreeManager {
  captures = 0;
  private releaseBarrier: (() => void) | undefined;
  private readonly barrier = new Promise<void>(resolve => { this.releaseBarrier = resolve; });
  override async captureMainWorkspace(directory: string) {
    this.captures++;
    if (this.captures <= 2) {
      if (this.captures === 2) this.releaseBarrier?.();
      await this.barrier;
    }
    return super.captureMainWorkspace(directory);
  }
}

class ScopeViolatingModel extends MockModel {
  override async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.stage === "EXECUTE") await writeFile(path.join(request.workingDirectory!, "outside-plan.txt"), "synthetic violation\n");
    return super.invoke(request);
  }
}

class GateModel extends MockModel {
  executeCalls = 0;
  release: (() => void) | undefined;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  constructor(private readonly failExecution = false) { super(); }
  override async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.stage === "EXECUTE") {
      this.executeCalls++;
      if (this.failExecution) throw new Error("ECONNRESET Bearer mock-secret-value at C:\\Users\\person\\project");
      await this.gate;
    }
    return super.invoke(request);
  }
}

describe("approval workflow", () => {
  it("stops after planning and completes only after approval", async () => {
    const subject = await workflowFixture();
    const router = new RouterOrchestrator(new MockModel(), new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    expect(planned.state).toBe("WAITING_APPROVAL");
    expect(planned.approval).toBeUndefined();
    const completed = await router.approve(planned.taskId, subject.main);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.routeEvidence?.map(item => item.expectedModel)).toEqual(["gpt-5.6-terra", "deepseek-v4-flash", "local-quality-gates", "gpt-5.6-terra"]);
    expect(completed.usage?.cachedInputTokens).toBe(8);
    expect(completed.result).toBe("accepted");
  });

  it("makes concurrent RouterOrchestrator approve calls idempotent", async () => {
    const subject = await workflowFixture();
    const model = new GateModel(); const router = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const first = router.approve(planned.taskId, subject.main);
    const attempts = new AttemptPersistence(subject.store.root);
    while ((await attempts.listAttempts(planned.taskId)).find(item => item.stage === "EXECUTE")?.status !== "SENDING") await new Promise(resolve => setTimeout(resolve, 1));
    const duplicate = await router.approve(planned.taskId, subject.main);
    expect(duplicate.state).toBe("EXECUTING");
    model.release?.(); const completed = await first;
    expect(completed.state).toBe("COMPLETED"); expect(model.executeCalls).toBe(1);
    expect((await attempts.listAttempts(planned.taskId)).filter(item => item.stage === "EXECUTE")).toHaveLength(1);
  });

  it("keeps a truly simultaneous duplicate approval from blocking the active workflow", async () => {
    const subject = await workflowFixture(); const model = new GateModel();
    const worktrees = new BarrierWorktreeManager({ stateRoot: subject.store.root, managedRoot: path.join(subject.root, "barrier-managed") });
    const router = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const first = router.approve(planned.taskId, subject.main); const second = router.approve(planned.taskId, subject.main);
    while (model.executeCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    model.release?.(); await Promise.all([first, second]);
    expect((await subject.store.load(planned.taskId)).state).toBe("COMPLETED");
    expect((await new AttemptPersistence(subject.store.root).loadWorkflow(planned.taskId)).state).not.toBe("BLOCKED");
    expect(model.executeCalls).toBe(1);
  });

  it("serializes worktree handoff across separate Router instances sharing durable state", async () => {
    const subject = await workflowFixture(); const model = new GateModel();
    let entered!: () => void; const preparing = new Promise<void>(resolve => { entered = resolve; });
    let releasePrepare!: () => void; const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
    const firstManager = new GitWorktreeManager({ stateRoot: subject.store.root, managedRoot: path.join(subject.root, "shared-managed"), checkpoint: async checkpoint => { if (checkpoint === "PREPARING") { entered(); await prepareGate; } } });
    const secondManager = new GitWorktreeManager({ stateRoot: subject.store.root, managedRoot: path.join(subject.root, "shared-managed") });
    const firstRouter = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, firstManager);
    const secondRouter = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, secondManager);
    const planned = await firstRouter.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const first = firstRouter.approve(planned.taskId, subject.main); await preparing;
    const duplicate = await secondRouter.approve(planned.taskId, subject.main);
    expect(duplicate.state).toBe("WAITING_APPROVAL");
    releasePrepare(); while (model.executeCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    model.release?.(); expect((await first).state).toBe("COMPLETED");
    expect((await new AttemptPersistence(subject.store.root).loadWorkflow(planned.taskId)).state).not.toBe("BLOCKED");
    expect(model.executeCalls).toBe(1);
  });

  it("returns BLOCKED with a redacted durable AMBIGUOUS attempt on reset", async () => {
    const subject = await workflowFixture();
    const model = new GateModel(true); const router = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const blocked = await router.approve(planned.taskId, subject.main);
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.lastError).not.toContain("mock-secret-value"); expect(blocked.lastError).not.toContain("C:\\Users");
    const persistence = new AttemptPersistence(subject.store.root);
    const attempt = (await persistence.listAttempts(planned.taskId)).find(item => item.stage === "EXECUTE");
    expect(attempt).toMatchObject({ status: "AMBIGUOUS", failure_class: "transport_unknown" });
    expect((await persistence.loadWorkflow(planned.taskId)).state).toBe("BLOCKED");
    const duplicate = await router.approve(planned.taskId, subject.main);
    expect(duplicate.state).toBe("BLOCKED"); expect(model.executeCalls).toBe(1);
  });

  it("runs executor, validation, and review only in the retained isolated checkout", async () => {
    const subject = await workflowFixture(); const model = new WritingModel(); const local = new WritingLocal();
    const router = new RouterOrchestrator(model, local, subject.store, undefined, subject.worktrees);
    const mainContent = await readFile(path.join(subject.main, "src", "parser.ts")); const mainStatus = await git(subject.main, ["status", "--porcelain=v1", "-z"]);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const completed = await router.approve(planned.taskId, subject.main);
    expect(completed.state).toBe("COMPLETED"); expect(model.workingDirectories).toHaveLength(2); expect(local.workingDirectories).toHaveLength(1);
    const isolated = model.workingDirectories[0]; expect(isolated).not.toBe(subject.main); expect(model.workingDirectories[1]).toBe(isolated); expect(local.workingDirectories[0]).toBe(isolated);
    expect(await readFile(path.join(subject.main, "src", "parser.ts"))).toEqual(mainContent); await expect(access(path.join(subject.main, "dist", "validation.txt"))).rejects.toThrow();
    expect(await git(subject.main, ["status", "--porcelain=v1", "-z"])).toBe(mainStatus);
  });

  it("blocks before executor send when isolated worktree preparation fails", async () => {
    const subject = await workflowFixture(); const model = new GateModel();
    const failing = new FailingWorktreeManager({ stateRoot: subject.store.root, managedRoot: path.join(subject.root, "failing-managed") });
    const router = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, failing);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const blocked = await router.approve(planned.taskId, subject.main);
    expect(blocked.state).toBe("BLOCKED"); expect(model.executeCalls).toBe(0);
    const status = await new AttemptPersistence(subject.store.root).listAttempts(planned.taskId);
    expect(status.some(item => item.stage === "EXECUTE")).toBe(false);
  });

  it.each(["direct", "junction alias"])("rejects a %s project-contained state root before the first planning write", async kind => {
    const subject = await workflowFixture(); const before = await git(subject.main, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const stateRoot = kind === "direct" ? path.join(subject.main, ".router-state") : path.join(subject.root, "main-alias", "nested-state");
    if (kind !== "direct") await symlink(subject.main, path.join(subject.root, "main-alias"), "junction");
    const store = new StateStore(stateRoot);
    const worktrees = new GitWorktreeManager({ stateRoot: store.root, managedRoot: path.join(subject.root, "preflight-managed") });
    const router = new RouterOrchestrator(new MockModel(), new MockLocal(), store, undefined, worktrees);
    await expect(router.auto("Fix a bounded parser bug", { projectDirectory: subject.main })).rejects.toThrow(/outside the target repository/);
    expect(await git(subject.main, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before);
    await expect(access(kind === "direct" ? stateRoot : path.join(subject.main, "nested-state"))).rejects.toThrow();
  });

  it("rejects a project-contained legacy state root before approve can create a handoff lock", async () => {
    const subject = await workflowFixture(); const external = new RouterOrchestrator(new MockModel(), new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await external.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const insideStore = new StateStore(path.join(subject.main, ".router-state")); await insideStore.save(planned, true);
    const insideWorktrees = new GitWorktreeManager({ stateRoot: insideStore.root, managedRoot: path.join(subject.root, "approve-managed") });
    const router = new RouterOrchestrator(new MockModel(), new MockLocal(), insideStore, undefined, insideWorktrees);
    const before = await git(subject.main, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    await expect(router.approve(planned.taskId, subject.main)).rejects.toThrow(/outside the target repository/);
    expect(await git(subject.main, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before);
    await expect(access(path.join(insideStore.taskDir(planned.taskId), ".locks"))).rejects.toThrow();
  });

  it("blocks both legacy and durable state after an isolated scope violation", async () => {
    const subject = await workflowFixture(); const router = new RouterOrchestrator(new ScopeViolatingModel(), new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const blocked = await router.approve(planned.taskId, subject.main);
    expect(blocked.state).toBe("BLOCKED");
    expect((await new AttemptPersistence(subject.store.root).loadWorkflow(planned.taskId)).state).toBe("BLOCKED");
    await expect(access(path.join(subject.main, "outside-plan.txt"))).rejects.toThrow();
  });

  it("blocks completion when the main workspace changes during isolated execution", async () => {
    const subject = await workflowFixture(); const model = new GateModel();
    const router = new RouterOrchestrator(model, new MockLocal(), subject.store, undefined, subject.worktrees);
    const planned = await router.auto("Fix a bounded parser bug", { projectDirectory: subject.main });
    const executing = router.approve(planned.taskId, subject.main);
    const attempts = new AttemptPersistence(subject.store.root);
    while ((await attempts.listAttempts(planned.taskId)).find(item => item.stage === "EXECUTE")?.status !== "SENDING") await new Promise(resolve => setTimeout(resolve, 1));
    await writeFile(path.join(subject.main, "src", "parser.ts"), "concurrent user change\n"); model.release?.();
    const blocked = await executing; expect(blocked.state).toBe("BLOCKED");
    expect(await readFile(path.join(subject.main, "src", "parser.ts"), "utf8")).toBe("concurrent user change\n");
  });
});

async function workflowFixture(): Promise<{ root: string; main: string; store: StateStore; worktrees: GitWorktreeManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-flow-")); roots.push(root); const main = path.join(root, "main");
  await mkdir(path.join(main, "src"), { recursive: true }); await git(main, ["init", "-b", "main"]); await git(main, ["config", "user.name", "Synthetic Test"]); await git(main, ["config", "user.email", "synthetic@example.invalid"]);
  await writeFile(path.join(main, "src", "parser.ts"), "export const parser = 1;\n"); await writeFile(path.join(main, ".gitignore"), "dist/\n"); await git(main, ["add", "--", ".gitignore", "src/parser.ts"]); await git(main, ["commit", "-m", "synthetic base"]);
  const store = new StateStore(path.join(root, "state")); const worktrees = new GitWorktreeManager({ stateRoot: store.root, managedRoot: path.join(root, "managed") });
  return { root, main, store, worktrees };
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const child = spawn("git", [...args], { cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); const [code] = await once(child, "close") as [number | null]; if (code !== 0) throw new Error(`Synthetic git command failed: ${args[0]}`); return stdout;
}
