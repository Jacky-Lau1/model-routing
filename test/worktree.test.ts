import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableHash } from "../src/canonical.js";
import { GitWorktreeManager, MainWorkspaceConflictError, type GitCommandResult, type WorktreeBinding, type WorktreeCheckpoint, type WorktreeCleanupCheckpoint } from "../src/worktree.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(safeRemoveFixture)));

interface Fixture {
  root: string;
  main: string;
  state: string;
  managed: string;
  manager: GitWorktreeManager;
}

async function fixture(options: { checkpoint?: (checkpoint: WorktreeCheckpoint) => void | Promise<void>; cleanupCheckpoint?: (checkpoint: WorktreeCleanupCheckpoint) => void | Promise<void>; audit?: string[][] } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-s3-")); roots.push(root);
  const main = path.join(root, "main"); const state = path.join(root, "state"); const managed = path.join(root, "managed");
  await mkdir(path.join(main, "src"), { recursive: true }); await mkdir(path.join(main, "notes"), { recursive: true });
  await git(main, ["init", "-b", "main"]); await git(main, ["config", "user.name", "Synthetic Test"]); await git(main, ["config", "user.email", "synthetic@example.invalid"]);
  await writeFile(path.join(main, "src", "app.ts"), "export const value = 1;\n"); await writeFile(path.join(main, ".gitignore"), "dist/\n");
  await git(main, ["add", "--", ".gitignore", "src/app.ts"]); await git(main, ["commit", "-m", "synthetic base"]);
  await writeFile(path.join(main, "notes", "空 格.txt"), "synthetic\n"); await git(main, ["add", "--", "notes/空 格.txt"]); await git(main, ["commit", "-m", "synthetic unicode path"]);
  const runGit = options.audit ? async (directory: string, args: readonly string[]) => { options.audit?.push([...args]); return gitResult(directory, args); } : undefined;
  const manager = new GitWorktreeManager({ stateRoot: state, managedRoot: managed, runGit, checkpoint: options.checkpoint ? checkpoint => options.checkpoint?.(checkpoint) : undefined, cleanupCheckpoint: options.cleanupCheckpoint ? checkpoint => options.cleanupCheckpoint?.(checkpoint) : undefined });
  return { root, main, state, managed, manager };
}

async function binding(subject: Fixture, runId = "run-synthetic"): Promise<{ baseline: Awaited<ReturnType<GitWorktreeManager["captureMainWorkspace"]>>; binding: WorktreeBinding }> {
  const baseline = await subject.manager.captureMainWorkspace(subject.main);
  return { baseline, binding: subject.manager.createBinding(runId, stableHash({ plan: "synthetic" }), baseline) };
}

describe("S3 isolated Git worktree", () => {
  it("creates a clean detached worktree at the approved full commit", async () => {
    const subject = await fixture(); const captured = await binding(subject);
    const lease = await subject.manager.prepare(subject.main, captured.binding);
    expect(captured.baseline.main_workspace_dirty_evidence).toEqual([]);
    expect((await git(lease.checkout_directory, ["rev-parse", "HEAD"])).trim()).toBe(captured.baseline.base_commit);
    expect((await git(lease.checkout_directory, ["symbolic-ref", "-q", "HEAD"], true)).trim()).toBe("");
    expect(await status(lease.checkout_directory)).toBe("");
    expect((await subject.manager.readLifecycle(captured.binding.worktree_id)).state).toBe("READY");
  });

  it.each([
    ["modified", async (main: string) => writeFile(path.join(main, "src", "app.ts"), "export const value = 2;\n"), "modified", "src/app.ts"],
    ["untracked", async (main: string) => writeFile(path.join(main, "new file.txt"), "new\n"), "untracked", "new file.txt"],
    ["deleted", async (main: string) => rm(path.join(main, "src", "app.ts")), "deleted", "src/app.ts"],
    ["renamed", async (main: string) => { await git(main, ["mv", "notes/空 格.txt", "notes/renamed.txt"]); }, "renamed", "notes/renamed.txt"],
    ["staged added", async (main: string) => { await writeFile(path.join(main, "added.txt"), "added\n"); await git(main, ["add", "--", "added.txt"]); }, "added", "added.txt"],
  ])("captures %s evidence without overlaying it", async (_name, mutate, expectedStatus, expectedPath) => {
    const subject = await fixture(); await mutate(subject.main); const before = await status(subject.main);
    const captured = await binding(subject); const entry = captured.baseline.main_workspace_dirty_evidence.find(item => item.path === expectedPath);
    expect(entry?.status).toBe(expectedStatus); expect(entry?.content_hash === null || /^[a-f0-9]{64}$/.test(entry?.content_hash ?? "")).toBe(true);
    if (entry?.content_hash) expect(entry.content_hash).toBe(createHash("sha256").update(await readFile(path.join(subject.main, expectedPath))).digest("hex"));
    const lease = await subject.manager.prepare(subject.main, captured.binding);
    expect(await status(subject.main)).toBe(before);
    if (expectedStatus === "added" || expectedStatus === "untracked" || expectedStatus === "renamed") await expect(access(path.join(lease.checkout_directory, expectedPath))).rejects.toThrow();
    if (expectedStatus === "modified" || expectedStatus === "deleted") expect((await readFile(path.join(lease.checkout_directory, "src", "app.ts"), "utf8")).replace(/\r\n/g, "\n")).toBe("export const value = 1;\n");
    if (expectedStatus === "deleted") expect(entry?.content_hash).toBeNull();
    if (expectedStatus === "renamed") {
      expect(captured.baseline.dirty_details.find(item => item.path === expectedPath)?.original_path).toBe("notes/空 格.txt");
      expect((await readFile(path.join(lease.checkout_directory, "notes", "空 格.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("synthetic\n");
    }
  });

  it("keeps executor-like edits and build output out of the main workspace", async () => {
    const subject = await fixture(); await mkdir(path.join(subject.main, "dist")); await writeFile(path.join(subject.main, "dist", "sentinel.txt"), "user output\n");
    const captured = await binding(subject); const mainBefore = await readFile(path.join(subject.main, "src", "app.ts"));
    const lease = await subject.manager.prepare(subject.main, captured.binding);
    await writeFile(path.join(lease.checkout_directory, "src", "app.ts"), "export const value = 9;\n");
    await mkdir(path.join(lease.checkout_directory, "dist")); await writeFile(path.join(lease.checkout_directory, "dist", "build.js"), "synthetic output\n");
    expect(await readFile(path.join(subject.main, "src", "app.ts"))).toEqual(mainBefore);
    await expect(access(path.join(subject.main, "dist", "build.js"))).rejects.toThrow();
    expect(await readFile(path.join(subject.main, "dist", "sentinel.txt"), "utf8")).toBe("user output\n");
    await subject.manager.assertMainWorkspaceUnchanged(lease);
  });

  it("blocks apply preflight when initially dirty content overlaps worktree edits", async () => {
    const subject = await fixture(); await writeFile(path.join(subject.main, "src", "app.ts"), "user draft\n");
    const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding);
    await writeFile(path.join(lease.checkout_directory, "src", "app.ts"), "executor draft\n");
    await expect(subject.manager.assertApplyPreconditions(lease)).rejects.toBeInstanceOf(MainWorkspaceConflictError);
    expect(await readFile(path.join(subject.main, "src", "app.ts"), "utf8")).toBe("user draft\n");
  });

  it("blocks when the main workspace changes after capture", async () => {
    const subject = await fixture(); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding);
    await writeFile(path.join(subject.main, "src", "app.ts"), "concurrent user edit\n");
    await expect(subject.manager.assertMainWorkspaceUnchanged(lease)).rejects.toBeInstanceOf(MainWorkspaceConflictError);
  });

  it("blocks concurrent different edits to the same main and worktree file without applying either side", async () => {
    const subject = await fixture(); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding);
    await writeFile(path.join(subject.main, "src", "app.ts"), "user concurrent edit\n");
    await writeFile(path.join(lease.checkout_directory, "src", "app.ts"), "executor concurrent edit\n");
    await expect(subject.manager.assertApplyPreconditions(lease)).rejects.toBeInstanceOf(MainWorkspaceConflictError);
    expect(await readFile(path.join(subject.main, "src", "app.ts"), "utf8")).toBe("user concurrent edit\n");
    expect(await readFile(path.join(lease.checkout_directory, "src", "app.ts"), "utf8")).toBe("executor concurrent edit\n");
  });

  it("uses the captured commit after an unrelated branch moves and is deleted", async () => {
    const subject = await fixture(); const captured = await binding(subject); await git(subject.main, ["branch", "approved-ref", captured.baseline.base_commit]);
    await git(subject.main, ["branch", "-f", "approved-ref", "HEAD^"]); await git(subject.main, ["branch", "-D", "approved-ref"]);
    const lease = await subject.manager.prepare(subject.main, captured.binding);
    expect((await git(lease.checkout_directory, ["rev-parse", "HEAD"])).trim()).toBe(captured.baseline.base_commit);
  });

  it("fails before READY for an invalid or shortened base id", async () => {
    const subject = await fixture(); const captured = await binding(subject);
    const bad = rehashBinding({ ...captured.binding, base_commit: captured.binding.base_commit.slice(0, 12) });
    await expect(subject.manager.prepare(subject.main, bad)).rejects.toThrow(/full Git/);
    await expect(access(path.join(subject.managed, bad.worktree_id))).rejects.toThrow();
    const missing = rehashBinding({ ...captured.binding, base_commit: "0".repeat(40) });
    await expect(subject.manager.prepare(subject.main, missing)).rejects.toThrow();
  });

  for (const interruptedAt of ["PREPARING", "GIT_ADDED", "READY"] as WorktreeCheckpoint[]) {
    it(`recovers idempotently after a ${interruptedAt} checkpoint interruption`, async () => {
      let interrupted = false;
      const subject = await fixture({ checkpoint: checkpoint => { if (!interrupted && checkpoint === interruptedAt) { interrupted = true; throw new Error("synthetic crash"); } } });
      const captured = await binding(subject);
      await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/failed closed/);
      expect(interrupted).toBe(true);
      const lease = await subject.manager.prepare(subject.main, captured.binding);
      expect((await subject.manager.readLifecycle(captured.binding.worktree_id)).state).toBe("READY");
      expect((await git(lease.checkout_directory, ["rev-parse", "HEAD"])).trim()).toBe(captured.binding.base_commit);
      expect((await git(subject.main, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
    });
  }

  it.each(["dirty", "attached"])("blocks PREPARING recovery when the residual checkout is %s", async condition => {
    let interrupted = false;
    const subject = await fixture({ checkpoint: checkpoint => { if (!interrupted && checkpoint === "GIT_ADDED") { interrupted = true; throw new Error("synthetic crash"); } } });
    const captured = await binding(subject);
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/failed closed/);
    const checkout = path.join(subject.managed, captured.binding.worktree_id, "checkout");
    if (condition === "dirty") await writeFile(path.join(checkout, "residual.txt"), "stale process output\n");
    else await git(checkout, ["switch", "-c", "synthetic-residual-branch"]);
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow();
    expect((await subject.manager.readLifecycle(captured.binding.worktree_id)).state).toBe("BLOCKED");
    if (condition === "dirty") expect(await readFile(path.join(checkout, "residual.txt"), "utf8")).toBe("stale process output\n");
    else expect((await git(checkout, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("synthetic-residual-branch");
  });

  it.each(["tracked", "ignored"])("blocks READY recovery when the checkout gained %s residual output before workflow handoff", async kind => {
    let interrupted = false;
    const subject = await fixture({ checkpoint: checkpoint => { if (!interrupted && checkpoint === "READY") { interrupted = true; throw new Error("synthetic crash"); } } });
    const captured = await binding(subject);
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/failed closed/);
    const checkout = path.join(subject.managed, captured.binding.worktree_id, "checkout");
    if (kind === "tracked") await writeFile(path.join(checkout, "src", "app.ts"), "residual edit\n");
    else { await mkdir(path.join(checkout, "dist")); await writeFile(path.join(checkout, "dist", "residual.txt"), "ignored residual\n"); }
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/retained|ownership|failed closed/);
    expect((await subject.manager.readLifecycle(captured.binding.worktree_id)).state).toBe("BLOCKED");
  });

  it.each(["state", "managed"])("rejects a configured %s root inside the main repository without creating it", async kind => {
    const subject = await fixture(); const captured = await binding(subject);
    const inside = path.join(subject.main, kind === "state" ? ".router-state" : ".router-worktrees");
    const manager = new GitWorktreeManager({ stateRoot: kind === "state" ? inside : subject.state, managedRoot: kind === "managed" ? inside : subject.managed });
    await expect(manager.prepare(subject.main, captured.binding)).rejects.toThrow(/outside the target repository/);
    await expect(access(inside)).rejects.toThrow();
  });

  it("rejects a prospective managed root whose existing junction ancestor resolves inside main", async () => {
    const subject = await fixture(); const captured = await binding(subject);
    const alias = path.join(subject.root, "main-alias"); await symlink(subject.main, alias, "junction");
    const nested = path.join(alias, "not-created", "managed");
    const manager = new GitWorktreeManager({ stateRoot: subject.state, managedRoot: nested });
    await expect(manager.prepare(subject.main, captured.binding)).rejects.toThrow(/outside the target repository/);
    await expect(access(path.join(subject.main, "not-created"))).rejects.toThrow();
  });

  it("refuses to overwrite an unregistered partial checkout", async () => {
    let interrupted = false;
    const subject = await fixture({ checkpoint: checkpoint => { if (!interrupted && checkpoint === "PREPARING") { interrupted = true; throw new Error("synthetic crash"); } } });
    const captured = await binding(subject); await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow();
    const checkout = path.join(subject.managed, captured.binding.worktree_id, "checkout"); await mkdir(checkout, { recursive: true }); await writeFile(path.join(checkout, "sentinel.txt"), "foreign\n");
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow();
    expect(await readFile(path.join(checkout, "sentinel.txt"), "utf8")).toBe("foreign\n");
  });

  it("never claims a pre-existing managed parent without owner evidence", async () => {
    const subject = await fixture(); const captured = await binding(subject); const parent = path.join(subject.managed, captured.binding.worktree_id);
    await mkdir(parent, { recursive: true }); await writeFile(path.join(parent, "sentinel.txt"), "foreign\n");
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/ownership/);
    expect(await readFile(path.join(parent, "sentinel.txt"), "utf8")).toBe("foreign\n");
    await expect(access(path.join(parent, "owner.json"))).rejects.toThrow(); await expect(access(path.join(parent, "checkout"))).rejects.toThrow();
  });

  it("never writes through a pre-existing junction at the expected managed parent", async () => {
    const subject = await fixture(); const captured = await binding(subject); await mkdir(subject.managed, { recursive: true });
    const parent = path.join(subject.managed, captured.binding.worktree_id); const foreign = path.join(subject.managed, "foreign-target"); await mkdir(foreign); await writeFile(path.join(foreign, "sentinel.txt"), "foreign\n"); await symlink(foreign, parent, "junction");
    await expect(subject.manager.prepare(subject.main, captured.binding)).rejects.toThrow(/owned directory|failed closed/);
    expect(await readFile(path.join(foreign, "sentinel.txt"), "utf8")).toBe("foreign\n"); await expect(access(path.join(foreign, "owner.json"))).rejects.toThrow();
  });

  it("reuses one owned worktree for duplicate and concurrent prepare calls", async () => {
    const subject = await fixture(); const captured = await binding(subject);
    const [first, second] = await Promise.all([subject.manager.prepare(subject.main, captured.binding), subject.manager.prepare(subject.main, captured.binding)]);
    expect(first.checkout_directory).toBe(second.checkout_directory);
    expect((await git(subject.main, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
  });

  it("cleans only a verified clean owned checkout and is idempotent", async () => {
    const subject = await fixture(); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding);
    await subject.manager.retain(lease);
    expect(await subject.manager.cleanup(subject.main, captured.binding.worktree_id)).toBe("removed");
    expect(await subject.manager.cleanup(subject.main, captured.binding.worktree_id)).toBe("already_removed");
    expect(await readFile(path.join(subject.main, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  for (const interruptedAt of ["REMOVING", "GIT_REMOVED", "REMOVED"] as WorktreeCleanupCheckpoint[]) {
    it(`recovers cleanup idempotently after a ${interruptedAt} checkpoint interruption`, async () => {
      let interrupted = false;
      const subject = await fixture({ cleanupCheckpoint: checkpoint => { if (!interrupted && checkpoint === interruptedAt) { interrupted = true; throw new Error("synthetic cleanup crash"); } } });
      const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding); await subject.manager.retain(lease);
      await expect(subject.manager.cleanup(subject.main, captured.binding.worktree_id)).rejects.toThrow(/checkpoint interrupted/);
      expect(interrupted).toBe(true);
      expect(await subject.manager.cleanup(subject.main, captured.binding.worktree_id)).toMatch(/removed/);
      expect((await subject.manager.readLifecycle(captured.binding.worktree_id)).state).toBe("REMOVED");
      await expect(access(path.join(subject.managed, captured.binding.worktree_id))).rejects.toThrow();
      expect((await git(subject.main, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(1);
    });
  }

  it("retains dirty or tampered worktrees instead of force-removing them", async () => {
    const subject = await fixture(); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding); await subject.manager.retain(lease);
    await writeFile(path.join(lease.checkout_directory, "untracked.txt"), "diagnostic\n");
    await expect(subject.manager.cleanup(subject.main, captured.binding.worktree_id)).rejects.toThrow(/retained/);
    expect(await readFile(path.join(lease.checkout_directory, "untracked.txt"), "utf8")).toBe("diagnostic\n");
    await writeFile(path.join(subject.managed, captured.binding.worktree_id, "owner.json"), "{}\n");
    await expect(subject.manager.cleanup(subject.main, captured.binding.worktree_id)).rejects.toThrow();
  });

  it("refuses unknown cleanup without touching a non-Router sibling", async () => {
    const subject = await fixture(); const sibling = path.join(subject.root, "foreign-sibling"); await mkdir(sibling); await writeFile(path.join(sibling, "sentinel.txt"), "keep\n");
    await expect(subject.manager.cleanup(subject.main, "worktree-unknown")).rejects.toThrow();
    expect(await readFile(path.join(sibling, "sentinel.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects a managed parent replaced by a junction or symlink", async () => {
    const subject = await fixture(); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding); await subject.manager.retain(lease);
    const parent = path.join(subject.managed, captured.binding.worktree_id); const relocated = path.join(subject.managed, "relocated-owned"); const foreign = path.join(subject.root, "foreign-target");
    await rename(parent, relocated); await mkdir(foreign); await writeFile(path.join(foreign, "sentinel.txt"), "keep\n"); await symlink(foreign, parent, "junction");
    await expect(subject.manager.cleanup(subject.main, captured.binding.worktree_id)).rejects.toThrow(/link|ownership|unavailable/);
    expect(await readFile(path.join(foreign, "sentinel.txt"), "utf8")).toBe("keep\n");
  });

  it("never invokes destructive Git commands", async () => {
    const audit: string[][] = []; const subject = await fixture({ audit }); const captured = await binding(subject); const lease = await subject.manager.prepare(subject.main, captured.binding); await subject.manager.retain(lease); await subject.manager.cleanup(subject.main, captured.binding.worktree_id);
    const rendered = audit.map(args => args.join(" ")).join("\n");
    expect(rendered).not.toMatch(/reset|stash|prune|\bclean\b|checkout -f|worktree remove --force/);
  });

  it("wraps public Git runner failures without exposing a synthetic physical path", async () => {
    const subject = await fixture(); const manager = new GitWorktreeManager({ stateRoot: subject.state, managedRoot: subject.managed, runGit: async () => { throw new Error(`synthetic failure at ${subject.main}`); } });
    const error = await manager.captureMainWorkspace(subject.main).then(() => undefined, value => value as Error);
    expect(error).toBeInstanceOf(Error); if (!error) throw new Error("Expected capture to fail");
    expect(error.message).toBe("Main workspace capture failed closed"); expect(error.message).not.toContain(subject.main);
  });
});

function rehashBinding(binding: WorktreeBinding): WorktreeBinding { const { isolation_hash: _old, ...body } = binding; return { ...body, isolation_hash: stableHash(body) }; }
async function status(directory: string): Promise<string> { return git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]); }
async function git(directory: string, args: readonly string[], allowFailure = false): Promise<string> { const result = await gitResult(directory, args); if (!allowFailure && result.code !== 0) throw new Error(`Synthetic git command failed: ${args[0]}`); return result.stdout; }
async function gitResult(directory: string, args: readonly string[]): Promise<GitCommandResult> {
  const child = spawn("git", [...args], { cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null]; return { code: code ?? -1, stdout, stderr };
}
async function safeRemoveFixture(root: string): Promise<void> { const temp = await realpath(os.tmpdir()); const target = await realpath(root); if (path.dirname(target).toLowerCase() !== temp.toLowerCase() || !path.basename(target).startsWith("router-s3-")) throw new Error("Refusing to remove a non-fixture path"); await rm(target, { recursive: true, force: true }); }
