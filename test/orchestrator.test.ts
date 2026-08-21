import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterOrchestrator } from "../src/orchestrator.js";
import { AttemptPersistence } from "../src/attempt-persistence.js";
import { StateStore } from "../src/persistence.js";
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
    const root = await mkdtemp(path.join(os.tmpdir(), "router-flow-")); roots.push(root);
    const router = new RouterOrchestrator(new MockModel(), new MockLocal(), new StateStore(root));
    const planned = await router.auto("Fix a bounded parser bug");
    expect(planned.state).toBe("WAITING_APPROVAL");
    expect(planned.approval).toBeUndefined();
    const completed = await router.approve(planned.taskId);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.routeEvidence?.map(item => item.expectedModel)).toEqual(["gpt-5.6-terra", "deepseek-v4-flash", "local-quality-gates", "gpt-5.6-terra"]);
    expect(completed.usage?.cachedInputTokens).toBe(8);
    expect(completed.result).toBe("accepted");
  });

  it("makes concurrent RouterOrchestrator approve calls idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "router-flow-")); roots.push(root);
    const model = new GateModel(); const store = new StateStore(root);
    const router = new RouterOrchestrator(model, new MockLocal(), store);
    const planned = await router.auto("Fix a bounded parser bug");
    const first = router.approve(planned.taskId, process.cwd());
    const attempts = new AttemptPersistence(root);
    while ((await attempts.listAttempts(planned.taskId)).find(item => item.stage === "EXECUTE")?.status !== "SENDING") await new Promise(resolve => setTimeout(resolve, 1));
    const duplicate = await router.approve(planned.taskId, process.cwd());
    expect(duplicate.state).toBe("EXECUTING");
    model.release?.(); const completed = await first;
    expect(completed.state).toBe("COMPLETED"); expect(model.executeCalls).toBe(1);
    expect((await attempts.listAttempts(planned.taskId)).filter(item => item.stage === "EXECUTE")).toHaveLength(1);
  });

  it("returns BLOCKED with a redacted durable AMBIGUOUS attempt on reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "router-flow-")); roots.push(root);
    const model = new GateModel(true); const store = new StateStore(root);
    const router = new RouterOrchestrator(model, new MockLocal(), store);
    const planned = await router.auto("Fix a bounded parser bug");
    const blocked = await router.approve(planned.taskId, process.cwd());
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.lastError).not.toContain("mock-secret-value"); expect(blocked.lastError).not.toContain("C:\\Users");
    const persistence = new AttemptPersistence(root);
    const attempt = (await persistence.listAttempts(planned.taskId)).find(item => item.stage === "EXECUTE");
    expect(attempt).toMatchObject({ status: "AMBIGUOUS", failure_class: "transport_unknown" });
    expect((await persistence.loadWorkflow(planned.taskId)).state).toBe("BLOCKED");
    const duplicate = await router.approve(planned.taskId, process.cwd());
    expect(duplicate.state).toBe("BLOCKED"); expect(model.executeCalls).toBe(1);
  });
});
