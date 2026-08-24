import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { atomicRenameWithLocalRetry } from "./attempt-persistence.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export class RouterCoreStore {
  readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  async save(taskId: string, value: unknown): Promise<void> {
    assertIdentifier(taskId);
    const target = this.recordPath(taskId);
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.router-core.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await mkdir(directory, { recursive: true });
      // Core records are already strict, secret-free contracts. Their exact absolute roots and
      // command boundaries must survive persistence unchanged or approval hashes become invalid.
      const data = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) throw new Error("Router core record exceeds the persistence limit");
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await atomicRenameWithLocalRetry(temporary, target);
      renamed = true;
    } finally {
      if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async load(taskId: string): Promise<unknown> {
    assertIdentifier(taskId);
    return JSON.parse(await readFile(this.recordPath(taskId), "utf8")) as unknown;
  }

  async tryLoad(taskId: string): Promise<unknown | undefined> {
    try { return await this.load(taskId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private recordPath(taskId: string): string { return path.join(this.root, "tasks", taskId, "router-core.json"); }
}

function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new Error("Invalid Router task id");
}
