import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PERSISTENCE } from "./policy.js";
import type { RunState, WorkflowState } from "./types.js";

export class StateStore {
  readonly root: string;
  constructor(root = path.resolve(".router-state")) { this.root = root; }

  taskDir(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id");
    return path.join(this.root, "tasks", taskId);
  }

  async save(state: RunState, force = false): Promise<void> {
    if (!force && !DEFAULT_PERSISTENCE.checkpointStates.includes(state.state)) return;
    const dir = this.taskDir(state.taskId);
    await mkdir(dir, { recursive: true });
    const data = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(data) > DEFAULT_PERSISTENCE.maxMetadataBytes) throw new Error("Router metadata exceeds 10 MB task limit");
    const target = path.join(dir, "state.json");
    const temporary = path.join(dir, `.state.${randomUUID()}.tmp`);
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }

  async load(taskId: string): Promise<RunState> {
    return JSON.parse(await readFile(path.join(this.taskDir(taskId), "state.json"), "utf8")) as RunState;
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

export function transitionState(state: RunState, next: WorkflowState): RunState {
  return { ...state, state: next, updatedAt: new Date().toISOString() };
}
