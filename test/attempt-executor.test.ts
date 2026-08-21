import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAttemptExecutor, AttemptBlockedError, type AttemptExecutionRequest, type AttemptOperation } from "../src/attempt-executor.js";
import { AttemptPersistence } from "../src/attempt-persistence.js";
import { stableHash } from "../src/canonical.js";
import type { Stage } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-attempt-"));
  roots.push(root);
  const persistence = new AttemptPersistence(root);
  return { root, persistence, executor: new DurableAttemptExecutor(persistence) };
}

function request(taskId: string, overrides: Partial<AttemptExecutionRequest> = {}): AttemptExecutionRequest {
  return {
    task_id: taskId,
    run_id: `run-${taskId}`,
    approval_hash: stableHash({ approval: taskId }),
    stage: "EXECUTE",
    round: 0,
    request_fingerprint: stableHash({ request: taskId }),
    initial_workflow_state: "APPROVED",
    start_workflow_state: "EXECUTING",
    success_workflow_state: "VALIDATING",
    ...overrides,
  };
}

function operation(onSend: () => void = () => undefined): AttemptOperation<{ body: string }> {
  return {
    send: async () => { onSend(); return { body: "complete mock response" }; },
    validate: response => {
      if (response.body !== "complete mock response") throw new Error("response lost");
      return {
        complete: true,
        provider_request_id: "mock-request-1",
        response_model: "mock-model",
        response_origin: "mock://provider",
        usage: { input_tokens: 2, output_tokens: 1, reasoning_tokens: 0 },
      };
    },
  };
}

class SimulatedCrash extends Error {}

describe("durable attempt checkpoints", () => {
  it("persists PREPARED before any mock send and reuses it after a crash", async () => {
    const { persistence } = await fixture(); let sends = 0;
    const crashing = new DurableAttemptExecutor(persistence, { checkpoint: checkpoint => { if (checkpoint === "PREPARED") throw new SimulatedCrash(); } });
    const input = request("crash-prepared");
    await expect(crashing.execute(input, operation(() => sends++))).rejects.toBeInstanceOf(SimulatedCrash);
    const saved = (await crashing.status(input.task_id)).attempts[0];
    expect(saved.status).toBe("PREPARED"); expect(sends).toBe(0);
    const replay = await new DurableAttemptExecutor(persistence).execute(input, operation(() => sends++));
    expect(replay).toMatchObject({ reused: true, attempt: { status: "PREPARED" } });
    expect(sends).toBe(0);
  });

  it("recovers a SENDING crash as AMBIGUOUS/BLOCKED without sending", async () => {
    const { persistence } = await fixture(); let sends = 0;
    const crashing = new DurableAttemptExecutor(persistence, { checkpoint: checkpoint => { if (checkpoint === "SENDING") throw new SimulatedCrash(); } });
    const input = request("crash-sending");
    await expect(crashing.execute(input, operation(() => sends++))).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await crashing.status(input.task_id)).attempts[0].status).toBe("SENDING");
    const restarted = new DurableAttemptExecutor(persistence);
    const recovered = await restarted.recover(input.task_id);
    expect(recovered.attempts[0].status).toBe("AMBIGUOUS");
    expect(recovered.workflow?.state).toBe("BLOCKED");
    const replay = await restarted.execute(input, operation(() => sends++));
    expect(replay).toMatchObject({ reused: true, attempt: { status: "AMBIGUOUS" } });
    expect(sends).toBe(0);
  });

  it("keeps SUCCEEDED durable when the process crashes after the checkpoint", async () => {
    const { persistence } = await fixture(); let sends = 0;
    const crashing = new DurableAttemptExecutor(persistence, { checkpoint: checkpoint => { if (checkpoint === "SUCCEEDED") throw new SimulatedCrash(); } });
    const input = request("crash-succeeded");
    await expect(crashing.execute(input, operation(() => sends++))).rejects.toBeInstanceOf(SimulatedCrash);
    const restarted = new DurableAttemptExecutor(persistence);
    const replay = await restarted.execute(input, operation(() => sends++));
    expect(replay).toMatchObject({ reused: true, attempt: { status: "SUCCEEDED" } });
    expect((await restarted.status(input.task_id)).workflow?.state).toBe("VALIDATING");
    expect(sends).toBe(1);
  });
});

describe("idempotency and failure classification", () => {
  it("allows only one mock call for two concurrent approve/execute requests", async () => {
    const { executor } = await fixture(); const input = request("concurrent"); let sends = 0;
    let releaseSend!: () => void;
    const gate = new Promise<void>(resolve => { releaseSend = resolve; });
    const slow = operation(() => sends++); slow.send = async () => { sends++; await gate; return { body: "complete mock response" }; };
    const first = executor.approveAndExecute(input, slow);
    while ((await executor.status(input.task_id)).attempts[0]?.status !== "SENDING") await new Promise(resolve => setTimeout(resolve, 1));
    const duplicate = await executor.execute(input, operation(() => sends++));
    releaseSend(); const completed = await first;
    expect(duplicate.reused).toBe(true);
    expect(duplicate.attempt.attempt_id).toBe(completed.attempt.attempt_id);
    expect(completed.attempt.status).toBe("SUCCEEDED");
    expect(sends).toBe(1);
  });

  it("uses FAILED_BEFORE_SEND only for a proven local preparation failure", async () => {
    const { executor } = await fixture(); const input = request("local-failure"); let sends = 0;
    const result = await executor.execute(input, { ...operation(() => sends++), prepare: () => { throw new Error("local schema check failed"); } });
    expect(result.attempt).toMatchObject({ status: "FAILED_BEFORE_SEND", failure_class: "local_preflight", send_started_at: null });
    expect(sends).toBe(0);
  });

  it("marks timeout/reset/response-lost outcomes AMBIGUOUS and never auto-resends", async () => {
    const { persistence, executor } = await fixture(); const input = request("ambiguous-restart"); let sends = 0;
    await expect(executor.execute(input, { send: async () => { sends++; throw new Error("ECONNRESET Bearer mock-secret-value"); }, validate: () => { throw new Error("unreachable"); } })).rejects.toBeInstanceOf(AttemptBlockedError);
    const status = await executor.status(input.task_id);
    expect(status.attempts[0]).toMatchObject({ status: "AMBIGUOUS", failure_class: "transport_unknown" });
    expect(status.workflow?.state).toBe("BLOCKED");
    expect(JSON.stringify(status)).not.toContain("mock-secret-value");
    const replay = await new DurableAttemptExecutor(persistence).execute(input, operation(() => sends++));
    expect(replay.reused).toBe(true); expect(sends).toBe(1);
  });

  it("does not mark an incomplete or unverified response SUCCEEDED", async () => {
    const { executor } = await fixture(); const input = request("response-lost");
    await expect(executor.execute(input, { send: () => ({ partial: true }), validate: () => { throw new Error("stream interruption"); } })).rejects.toBeInstanceOf(AttemptBlockedError);
    const status = await executor.status(input.task_id);
    expect(status.attempts[0]).toMatchObject({ status: "AMBIGUOUS", failure_class: "response_invalid" });
    expect(status.workflow?.state).toBe("BLOCKED");
  });

  it("creates a new repair attempt without overwriting history", async () => {
    const { executor } = await fixture(); const initial = request("repair-history");
    const first = await executor.execute(initial, operation());
    const repairInput = request("repair-history", { stage: "REPAIR", round: 1, request_fingerprint: stableHash({ request: "repair-history", round: 1 }), success_workflow_state: "VALIDATING" });
    const repaired = await executor.repair(repairInput, operation());
    const status = await executor.status(initial.task_id);
    expect(first.attempt.attempt_id).not.toBe(repaired.attempt.attempt_id);
    expect(status.attempts.map(item => item.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(status.workflow?.attempt_ids).toEqual([first.attempt.attempt_id, repaired.attempt.attempt_id]);
  });
});

describe("provider-stage exception matrix", () => {
  const stages: Stage[] = ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"];
  for (const stage of stages) {
    it(`${stage} send exception is durably readable`, async () => {
      const { executor } = await fixture(); const taskId = `stage-${stage.toLowerCase().replace(/_/g, "-")}`;
      const input = request(taskId, { stage });
      await expect(executor.execute(input, { send: () => { throw new Error(`${stage} mock reset`); }, validate: () => { throw new Error("unreachable"); } })).rejects.toBeInstanceOf(AttemptBlockedError);
      const status = await executor.status(taskId);
      expect(status.attempts).toHaveLength(1);
      expect(status.attempts[0]).toMatchObject({ stage, status: "AMBIGUOUS", failure_class: "transport_unknown" });
      expect(status.workflow?.state).toBe("BLOCKED");
    });
  }
});
