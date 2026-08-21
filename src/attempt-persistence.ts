import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rmdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertAttemptRecord } from "./contracts.js";
import { redactError, sanitizeForPersistence } from "./redaction.js";
import type { AttemptRecord, WorkflowRecord, WorkflowState } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

export type AtomicWritePhase = "after_temporary_sync" | "after_rename";
export type RecordKind = "workflow" | "attempt";
export type AtomicWriteObserver = (event: { kind: RecordKind; phase: AtomicWritePhase }) => void | Promise<void>;

export interface AttemptPersistenceOptions {
  observeAtomicWrite?: AtomicWriteObserver;
}

export class PersistenceError extends Error {
  constructor(operation: string) {
    super(`Persistence failed during ${operation}`);
    this.name = "PersistenceError";
  }
}

export class AttemptPersistence {
  readonly root: string;

  constructor(root: string, private readonly options: AttemptPersistenceOptions = {}) {
    this.root = path.resolve(root);
  }

  taskDir(taskId: string): string {
    assertIdentifier(taskId, "task id");
    return path.join(this.root, "tasks", taskId);
  }

  workflowPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "workflow.json");
  }

  attemptPath(taskId: string, attemptId: string): string {
    assertIdentifier(attemptId, "attempt id");
    return path.join(this.taskDir(taskId), "attempts", `${attemptId}.json`);
  }

  async saveWorkflow(workflow: WorkflowRecord): Promise<WorkflowRecord> {
    const safe = sanitizeForPersistence(workflow);
    assertWorkflowRecord(safe);
    await this.writeAtomic(this.workflowPath(safe.task_id), safe, "workflow");
    return safe;
  }

  async loadWorkflow(taskId: string): Promise<WorkflowRecord> {
    return this.readRecord(this.workflowPath(taskId), assertWorkflowRecord, "workflow read");
  }

  async tryLoadWorkflow(taskId: string): Promise<WorkflowRecord | undefined> {
    return this.tryReadRecord(this.workflowPath(taskId), assertWorkflowRecord, "workflow read");
  }

  async saveAttempt(taskId: string, attempt: AttemptRecord): Promise<AttemptRecord> {
    const safe = sanitizeForPersistence(attempt);
    assertAttemptRecord(safe);
    assertAttemptStateInvariant(safe);
    await this.writeAtomic(this.attemptPath(taskId, safe.attempt_id), safe, "attempt");
    return safe;
  }

  async loadAttempt(taskId: string, attemptId: string): Promise<AttemptRecord> {
    return this.readRecord(this.attemptPath(taskId, attemptId), assertDurableAttempt, "attempt read");
  }

  async tryLoadAttempt(taskId: string, attemptId: string): Promise<AttemptRecord | undefined> {
    return this.tryReadRecord(this.attemptPath(taskId, attemptId), assertDurableAttempt, "attempt read");
  }

  async listAttempts(taskId: string): Promise<AttemptRecord[]> {
    const directory = path.join(this.taskDir(taskId), "attempts");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw new PersistenceError("attempt list");
    }
    const attempts = await Promise.all(names.filter(name => name.endsWith(".json")).map(name => this.loadAttempt(taskId, name.slice(0, -5))));
    return attempts.sort((left, right) => left.prepared_at.localeCompare(right.prepared_at) || left.attempt_id.localeCompare(right.attempt_id));
  }

  async tryAcquireExecutionLock(taskId: string, approvalHash: string): Promise<(() => Promise<void>) | undefined> {
    assertHash(approvalHash, "approval hash");
    const directory = path.join(this.taskDir(taskId), ".locks", approvalHash);
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (isMissing(error)) {
        await mkdir(path.dirname(directory), { recursive: true });
        try { await mkdir(directory); } catch (nested) { if (isAlreadyExists(nested)) return undefined; throw new PersistenceError("execution lock acquisition"); }
      } else if (isAlreadyExists(error)) return undefined;
      else throw new PersistenceError("execution lock acquisition");
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await rmdir(directory); } catch { throw new PersistenceError("execution lock release"); }
    };
  }

  private async writeAtomic(target: string, value: unknown, kind: RecordKind): Promise<void> {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await mkdir(directory, { recursive: true });
      const data = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error("record too large");
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await this.options.observeAtomicWrite?.({ kind, phase: "after_temporary_sync" });
      await atomicRenameWithLocalRetry(temporary, target);
      renamed = true;
      await this.options.observeAtomicWrite?.({ kind, phase: "after_rename" });
    } catch {
      throw new PersistenceError(`${kind} atomic write`);
    } finally {
      if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readRecord<T>(target: string, validate: (value: unknown) => asserts value is T, operation: string): Promise<T> {
    try {
      const value: unknown = JSON.parse(await readFile(target, "utf8"));
      validate(value);
      return sanitizeForPersistence(value);
    } catch {
      throw new PersistenceError(operation);
    }
  }

  private async tryReadRecord<T>(target: string, validate: (value: unknown) => asserts value is T, operation: string): Promise<T | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(target, "utf8"));
      validate(value);
      return sanitizeForPersistence(value);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new PersistenceError(operation);
    }
  }
}

export function assertWorkflowRecord(value: unknown): asserts value is WorkflowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow record");
  const record = value as Record<string, unknown>;
  const expected = ["version", "run_id", "task_id", "approval_hash", "state", "attempt_ids", "active_attempt_id", "blocked_reason", "revision", "created_at", "updated_at"];
  if (Object.keys(record).length !== expected.length || expected.some(key => !(key in record))) throw new Error("Invalid workflow fields");
  if (record.version !== 1) throw new Error("Invalid workflow version");
  assertIdentifier(record.run_id, "run id"); assertIdentifier(record.task_id, "task id"); assertHash(record.approval_hash, "approval hash");
  const states: WorkflowState[] = ["CREATED", "PLANNING", "AWAITING_APPROVAL", "APPROVED", "WORKTREE_READY", "EXECUTING", "VALIDATING", "REVIEW_PENDING", "REPAIR_REQUIRED", "APPLY_PENDING", "PASSED", "BLOCKED", "ABORTED"];
  if (!states.includes(record.state as WorkflowState)) throw new Error("Invalid workflow state");
  if (!Array.isArray(record.attempt_ids) || record.attempt_ids.some(item => { try { assertIdentifier(item, "attempt id"); return false; } catch { return true; } })) throw new Error("Invalid workflow attempts");
  if (record.active_attempt_id !== null) assertIdentifier(record.active_attempt_id, "active attempt id");
  if (record.blocked_reason !== null && typeof record.blocked_reason !== "string") throw new Error("Invalid blocked reason");
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) throw new Error("Invalid workflow revision");
  assertTimestamp(record.created_at, "created at"); assertTimestamp(record.updated_at, "updated at");
}

export function assertAttemptStateInvariant(attempt: AttemptRecord): void {
  const hasSend = attempt.send_started_at !== null;
  const hasCompletion = attempt.completed_at !== null;
  if (attempt.status === "PREPARED" && (hasSend || hasCompletion || attempt.failure_class !== "none")) throw new Error("PREPARED attempt fields are inconsistent");
  if (attempt.status === "SENDING" && (!hasSend || hasCompletion || attempt.failure_class !== "none")) throw new Error("SENDING attempt fields are inconsistent");
  if (attempt.status === "SUCCEEDED" && (!hasSend || !hasCompletion || attempt.failure_class !== "none" || !attempt.provider_request_id || !attempt.response_model || !attempt.response_origin || !attempt.usage || attempt.redacted_error !== null)) throw new Error("SUCCEEDED attempt fields are inconsistent");
  if (attempt.status === "FAILED_BEFORE_SEND" && (hasSend || !hasCompletion || attempt.failure_class !== "local_preflight" || !attempt.redacted_error)) throw new Error("FAILED_BEFORE_SEND attempt fields are inconsistent");
  if (attempt.status === "AMBIGUOUS" && (!hasSend || !hasCompletion || !["transport_unknown", "response_invalid", "provider_rejected"].includes(attempt.failure_class) || !attempt.redacted_error)) throw new Error("AMBIGUOUS attempt fields are inconsistent");
  if (attempt.status === "CANCELLED" && (!hasCompletion || attempt.failure_class !== "cancelled")) throw new Error("CANCELLED attempt fields are inconsistent");
}

function assertDurableAttempt(value: unknown): asserts value is AttemptRecord { assertAttemptRecord(value); assertAttemptStateInvariant(value); }
function assertIdentifier(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`Invalid ${name}`); }
function assertHash(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`Invalid ${name}`); }
function assertTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${name}`); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "EEXIST"; }
function isTransientRenameConflict(error: unknown): boolean { return ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? ""); }

export async function atomicRenameWithLocalRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      if (!isTransientRenameConflict(error) || attempt >= 20) throw error;
      await delay(5);
    }
  }
}

export function persistenceErrorForStatus(error: unknown): string { return redactError(error); }
