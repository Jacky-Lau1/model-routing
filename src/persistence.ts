import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicRenameWithLocalRetry, PersistenceError } from "./attempt-persistence.js";
import { DEFAULT_PERSISTENCE } from "./policy.js";
import { sanitizeForPersistence } from "./redaction.js";
import type { LegacyWorkflowState, RunState } from "./types.js";

export class StateStore {
  readonly root: string;
  constructor(root = path.resolve(".router-state")) { this.root = root; }

  taskDir(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id");
    return path.join(this.root, "tasks", taskId);
  }

  async save(state: RunState, force = false): Promise<void> {
    if (!force && !DEFAULT_PERSISTENCE.checkpointStates.includes(state.state)) return;
    const persistent = { ...state };
    delete persistent.result;
    const safe = sanitizeForPersistence(persistent);
    const dir = this.taskDir(safe.taskId);
    const temporary = path.join(dir, `.state.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await mkdir(dir, { recursive: true });
      const data = `${JSON.stringify(safe, null, 2)}\n`;
      if (Buffer.byteLength(data) > DEFAULT_PERSISTENCE.maxMetadataBytes) throw new Error("metadata limit");
      const target = path.join(dir, "state.json");
      await writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
      await atomicRenameWithLocalRetry(temporary, target); renamed = true;
    } catch { throw new PersistenceError("legacy state atomic write"); }
    finally { if (!renamed) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async load(taskId: string): Promise<RunState> {
    try { return sanitizeForPersistence(JSON.parse(await readFile(path.join(this.taskDir(taskId), "state.json"), "utf8")) as RunState); }
    catch { throw new PersistenceError("legacy state read"); }
  }

  async list(): Promise<RunState[]> {
    const dir = path.join(this.root, "tasks");
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const states = await Promise.all(names.map(async name => { try { return await this.load(name); } catch { return undefined; } }));
    return states.filter((state): state is RunState => Boolean(state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async cleanup(olderThanDays = DEFAULT_PERSISTENCE.retentionDays, dryRun = false, now = Date.now()): Promise<string[]> {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) throw new Error("Retention must be at least one day");
    const cutoff = now - olderThanDays * 86_400_000;
    const removed: string[] = [];
    for (const state of await this.list()) {
      const dir = this.taskDir(state.taskId);
      const info = await stat(dir);
      if (Math.max(info.mtimeMs, Date.parse(state.updatedAt)) >= cutoff) continue;
      removed.push(dir);
      if (!dryRun) await rm(dir, { recursive: true, force: false });
    }
    return removed;
  }
}

export function transitionState(state: RunState, next: LegacyWorkflowState): RunState {
  return { ...state, state: next, updatedAt: new Date().toISOString() };
}
