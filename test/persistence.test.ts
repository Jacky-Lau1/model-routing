import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { StateStore } from "../src/persistence.js";
import type { RunState } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(state: RunState["state"] = "WAITING_APPROVAL") {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-test-")); roots.push(root);
  const store = new StateStore(root); const now = new Date().toISOString();
  const value: RunState = { version: 1, taskId: "task-1", state, profile: classifyTask("fix code"), attempts: 0, repairAttempts: 0, createdAt: now, updatedAt: now };
  return { store, value };
}

describe("low-write state store", () => {
  it("defaults to an external system-temporary root instead of the current project", () => {
    const store = new StateStore();
    expect(store.root).toBe(path.resolve(os.tmpdir(), "codex-model-router-state"));
    const relative = path.relative(process.cwd(), store.root);
    expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))).toBe(false);
  });
  it("does not write non-checkpoint event states", async () => {
    const { store, value } = await fixture("EXECUTING"); await store.save(value);
    await expect(store.load(value.taskId)).rejects.toThrow();
  });
  it("atomically writes checkpoint states", async () => {
    const { store, value } = await fixture(); await store.save(value);
    expect(JSON.parse(await readFile(path.join(store.taskDir(value.taskId), "state.json"), "utf8")).state).toBe("WAITING_APPROVAL");
  });
  it("does not persist raw provider result or expose storage paths", async () => {
    const { store, value } = await fixture(); value.result = "Bearer mock-secret-value raw response";
    await store.save(value);
    const text = await readFile(path.join(store.taskDir(value.taskId), "state.json"), "utf8");
    expect(text).not.toContain("mock-secret-value"); expect(text).not.toContain("raw response");
    expect((await store.load(value.taskId)).result).toBeUndefined();
    await expect(store.load("missing-task")).rejects.toMatchObject({ message: "Persistence failed during legacy state read" });
  });
  it("dry-run cleanup does not remove data", async () => {
    const { store, value } = await fixture(); const old = new Date("2020-01-01"); value.updatedAt = old.toISOString(); await store.save(value);
    await utimes(store.taskDir(value.taskId), old, old);
    expect(await store.cleanup(7, true, Date.parse("2020-02-01"))).toHaveLength(1);
    expect((await store.load(value.taskId)).taskId).toBe(value.taskId);
  });
});
