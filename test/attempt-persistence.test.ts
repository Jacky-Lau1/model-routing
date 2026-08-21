import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttemptPersistence, PersistenceError } from "../src/attempt-persistence.js";
import { stableHash } from "../src/canonical.js";
import type { AttemptRecord, WorkflowRecord } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function rootFixture(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "router-atomic-")); roots.push(root); return root; }
const now = "2026-08-21T00:00:00.000Z";

function workflow(): WorkflowRecord {
  return { version: 1, run_id: "run-1", task_id: "task-1", approval_hash: stableHash("approval"), state: "APPROVED", attempt_ids: [], active_attempt_id: null, blocked_reason: null, revision: 0, created_at: now, updated_at: now };
}

function prepared(): AttemptRecord {
  return { version: 1, attempt_id: "attempt-1", run_id: "run-1", stage: "EXECUTE", round: 0, request_fingerprint: stableHash("request"), status: "PREPARED", prepared_at: now, send_started_at: null, completed_at: null, failure_class: "none", provider_request_id: null, response_model: null, response_origin: null, usage: null, redacted_error: null };
}

describe("atomic and redacted attempt persistence", () => {
  it("keeps the previous complete JSON when a status write is interrupted", async () => {
    const root = await rootFixture(); const normal = new AttemptPersistence(root); const before = prepared();
    await normal.saveAttempt("task-1", before);
    let interrupted = false;
    const failing = new AttemptPersistence(root, { observeAtomicWrite: ({ kind, phase }) => { if (!interrupted && kind === "attempt" && phase === "after_temporary_sync") { interrupted = true; throw new Error("simulated power loss"); } } });
    await expect(failing.saveAttempt("task-1", { ...before, status: "SENDING", send_started_at: now })).rejects.toBeInstanceOf(PersistenceError);
    const target = normal.attemptPath("task-1", "attempt-1");
    expect(JSON.parse(await readFile(target, "utf8")).status).toBe("PREPARED");
    expect((await readdir(path.dirname(target))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not expose a half JSON file when the first workflow write is interrupted", async () => {
    const root = await rootFixture();
    const failing = new AttemptPersistence(root, { observeAtomicWrite: ({ kind, phase }) => { if (kind === "workflow" && phase === "after_temporary_sync") throw new Error("C:\\Users\\person\\secret-state"); } });
    await expect(failing.saveWorkflow(workflow())).rejects.toMatchObject({ message: "Persistence failed during workflow atomic write" });
    await expect(readFile(failing.workflowPath("task-1"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts persisted errors and persistence output paths", async () => {
    const root = await rootFixture(); const store = new AttemptPersistence(root); const value = prepared();
    const failed = await store.saveAttempt("task-1", { ...value, status: "FAILED_BEFORE_SEND", completed_at: now, failure_class: "local_preflight", redacted_error: "password=hunter22 at C:\\Users\\person\\project\\state.json" });
    expect(failed.redacted_error).not.toContain("hunter22");
    expect(failed.redacted_error).not.toContain("C:\\Users");
    expect(await readFile(store.attemptPath("task-1", "attempt-1"), "utf8")).not.toContain("hunter22");
    await expect(store.loadWorkflow("missing-task")).rejects.toMatchObject({ message: "Persistence failed during workflow read" });
  });
});
