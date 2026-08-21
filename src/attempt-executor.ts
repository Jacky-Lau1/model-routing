import { setTimeout as delay } from "node:timers/promises";
import { stableHash } from "./canonical.js";
import { AttemptPersistence, PersistenceError, persistenceErrorForStatus } from "./attempt-persistence.js";
import { redactError, redactText } from "./redaction.js";
import { assertTransition } from "./state-machine.js";
import type { AttemptRecord, AttemptUsage, FailureClass, Stage, WorkflowRecord, WorkflowState } from "./types.js";

export type AttemptCheckpoint = "PREPARED" | "SENDING" | "SUCCEEDED";

export interface AttemptExecutionRequest {
  task_id: string;
  run_id: string;
  approval_hash: string;
  stage: Stage;
  round: number;
  request_fingerprint: string;
  initial_workflow_state: WorkflowState;
  start_workflow_state: WorkflowState;
  success_workflow_state: WorkflowState;
}

export interface VerifiedResponseMetadata {
  complete: true;
  provider_request_id: string;
  response_model: string;
  response_origin: string;
  usage: AttemptUsage;
}

export interface AttemptOperation<T> {
  prepare?: () => void | Promise<void>;
  send: () => T | Promise<T>;
  validate: (response: T) => VerifiedResponseMetadata | Promise<VerifiedResponseMetadata>;
}

export interface AttemptExecutionResult<T> {
  attempt: AttemptRecord;
  response?: T;
  reused: boolean;
}

export interface AttemptExecutorOptions {
  checkpoint?: (checkpoint: AttemptCheckpoint, attempt: AttemptRecord) => void | Promise<void>;
  lockWaitMs?: number;
  now?: () => Date;
}

export class AttemptBlockedError extends Error {
  readonly attempt: AttemptRecord;
  constructor(attempt: AttemptRecord) {
    super(`Attempt ${attempt.attempt_id} is ${attempt.status}`);
    this.name = "AttemptBlockedError";
    this.attempt = attempt;
  }
}

export class ExecutionConflictError extends Error {
  constructor(message: string) { super(redactText(message)); this.name = "ExecutionConflictError"; }
}

export class ExecutionBusyError extends Error {
  constructor() { super("An execution for this task and approval is already being prepared"); this.name = "ExecutionBusyError"; }
}

export class DurableAttemptExecutor {
  constructor(readonly persistence: AttemptPersistence, private readonly options: AttemptExecutorOptions = {}) {}

  /** Idempotent approved execution entrypoint. */
  async execute<T>(request: AttemptExecutionRequest, operation: AttemptOperation<T>): Promise<AttemptExecutionResult<T>> {
    validateRequest(request);
    const attemptId = attemptIdFor(request);
    const existing = await this.persistence.tryLoadAttempt(request.task_id, attemptId);
    if (existing) return this.reuse(request, existing);

    const release = await this.persistence.tryAcquireExecutionLock(request.task_id, request.approval_hash);
    if (!release) return this.waitForExisting(request, attemptId);
    try {
      const raced = await this.persistence.tryLoadAttempt(request.task_id, attemptId);
      if (raced) return this.reuse(request, raced);

      let workflow = await this.ensureWorkflow(request);
      const preparedAt = this.timestamp();
      let attempt: AttemptRecord = {
        version: 1,
        attempt_id: attemptId,
        run_id: request.run_id,
        stage: request.stage,
        round: request.round,
        request_fingerprint: request.request_fingerprint,
        status: "PREPARED",
        prepared_at: preparedAt,
        send_started_at: null,
        completed_at: null,
        failure_class: "none",
        provider_request_id: null,
        response_model: null,
        response_origin: null,
        usage: null,
        redacted_error: null,
      };
      attempt = await this.persistence.saveAttempt(request.task_id, attempt);
      workflow = await this.attachAttempt(workflow, attempt.attempt_id, request.start_workflow_state);
      await this.options.checkpoint?.("PREPARED", attempt);

      try {
        await operation.prepare?.();
      } catch (error) {
        attempt = await this.completeFailure(request.task_id, attempt, "FAILED_BEFORE_SEND", "local_preflight", error);
        return { attempt, reused: false };
      }

      attempt = await this.persistence.saveAttempt(request.task_id, {
        ...attempt,
        status: "SENDING",
        send_started_at: this.timestamp(),
      });
      await this.options.checkpoint?.("SENDING", attempt);

      let response: T;
      try {
        response = await operation.send();
      } catch (error) {
        attempt = await this.completeFailure(request.task_id, attempt, "AMBIGUOUS", "transport_unknown", error);
        await this.blockWorkflow(workflow, attempt, error);
        throw new AttemptBlockedError(attempt);
      }

      let verified: VerifiedResponseMetadata;
      try {
        verified = await operation.validate(response);
        assertVerifiedResponse(verified);
      } catch (error) {
        attempt = await this.completeFailure(request.task_id, attempt, "AMBIGUOUS", "response_invalid", error);
        await this.blockWorkflow(workflow, attempt, error);
        throw new AttemptBlockedError(attempt);
      }

      attempt = await this.persistence.saveAttempt(request.task_id, {
        ...attempt,
        status: "SUCCEEDED",
        completed_at: this.timestamp(),
        provider_request_id: verified.provider_request_id,
        response_model: verified.response_model,
        response_origin: verified.response_origin,
        usage: verified.usage,
      });
      await this.transitionWorkflow(workflow, request.success_workflow_state, attempt.attempt_id, null);
      await this.options.checkpoint?.("SUCCEEDED", attempt);
      return { attempt, response, reused: false };
    } finally {
      await release();
    }
  }

  /** Alias for callers whose approval action immediately starts execution. */
  approveAndExecute<T>(request: AttemptExecutionRequest, operation: AttemptOperation<T>): Promise<AttemptExecutionResult<T>> {
    return this.execute(request, operation);
  }

  /** Repair is a new logical round and therefore can never overwrite the initial attempt. */
  async repair<T>(request: AttemptExecutionRequest, operation: AttemptOperation<T>): Promise<AttemptExecutionResult<T>> {
    if (request.round < 1) throw new ExecutionConflictError("Repair requires round >= 1");
    const workflow = await this.persistence.tryLoadWorkflow(request.task_id);
    if (workflow && workflow.state !== "REPAIR_REQUIRED") await this.transitionWorkflow(workflow, "REPAIR_REQUIRED", workflow.active_attempt_id, null);
    return this.execute({ ...request, initial_workflow_state: "REPAIR_REQUIRED", start_workflow_state: "EXECUTING" }, operation);
  }

  async status(taskId: string): Promise<{ workflow?: WorkflowRecord; attempts: AttemptRecord[] }> {
    return {
      workflow: await this.persistence.tryLoadWorkflow(taskId),
      attempts: await this.persistence.listAttempts(taskId),
    };
  }

  async bindApproval(taskId: string, runId: string, previousApprovalHash: string, approvalHash: string): Promise<WorkflowRecord> {
    const workflow = await this.persistence.loadWorkflow(taskId);
    if (workflow.run_id !== runId) throw new ExecutionConflictError("Workflow is bound to a different run");
    if (workflow.approval_hash === approvalHash) return workflow;
    if (workflow.approval_hash !== previousApprovalHash) throw new ExecutionConflictError("Workflow approval changed concurrently");
    if (workflow.state !== "AWAITING_APPROVAL") throw new ExecutionConflictError("Workflow is not awaiting approval");
    assertTransition(workflow.state, "APPROVED");
    return this.persistence.saveWorkflow({ ...workflow, approval_hash: approvalHash, state: "APPROVED", revision: workflow.revision + 1, updated_at: this.timestamp() });
  }

  tryAcquireWorktreeHandoffLock(taskId: string, approvalHash: string): Promise<(() => Promise<void>) | undefined> {
    return this.persistence.tryAcquireWorktreeHandoffLock(taskId, approvalHash);
  }

  async markWorktreeReady(taskId: string, runId: string, approvalHash: string): Promise<WorkflowRecord> {
    const workflow = await this.persistence.loadWorkflow(taskId);
    this.assertWorkflowBinding(workflow, runId, approvalHash);
    if (["WORKTREE_READY", "EXECUTING", "VALIDATING", "REVIEW_PENDING", "REPAIR_REQUIRED", "APPLY_PENDING", "PASSED"].includes(workflow.state)) return workflow;
    if (workflow.state !== "APPROVED") throw new ExecutionConflictError("Workflow is not approved for worktree preparation");
    return this.transitionWorkflow(workflow, "WORKTREE_READY", workflow.active_attempt_id, null);
  }

  async blockLocalFailure(taskId: string, runId: string, approvalHash: string, reason: unknown): Promise<WorkflowRecord> {
    const workflow = await this.persistence.loadWorkflow(taskId);
    this.assertWorkflowBinding(workflow, runId, approvalHash);
    if (workflow.state === "BLOCKED") return workflow;
    return this.transitionWorkflow(workflow, "BLOCKED", workflow.active_attempt_id, redactError(reason));
  }

  /** Startup recovery never sends. Any durable SENDING attempt becomes AMBIGUOUS/BLOCKED. */
  async recover(taskId: string): Promise<{ workflow?: WorkflowRecord; attempts: AttemptRecord[] }> {
    let workflow = await this.persistence.tryLoadWorkflow(taskId);
    const attempts = await this.persistence.listAttempts(taskId);
    const recovered: AttemptRecord[] = [];
    for (const current of attempts) {
      if (current.status !== "SENDING") { recovered.push(current); continue; }
      const attempt = await this.persistence.saveAttempt(taskId, {
        ...current,
        status: "AMBIGUOUS",
        completed_at: this.timestamp(),
        failure_class: "transport_unknown",
        redacted_error: "Process ended while provider outcome was unknown",
      });
      recovered.push(attempt);
    }
    const ambiguous = recovered.find(attempt => attempt.status === "AMBIGUOUS");
    if (ambiguous && workflow) workflow = await this.blockWorkflow(workflow, ambiguous, ambiguous.redacted_error ?? "Unknown provider outcome");
    return { workflow, attempts: recovered };
  }

  private async ensureWorkflow(request: AttemptExecutionRequest): Promise<WorkflowRecord> {
    const existing = await this.persistence.tryLoadWorkflow(request.task_id);
    if (existing) {
      if (existing.run_id !== request.run_id || existing.approval_hash !== request.approval_hash) throw new ExecutionConflictError("Task is bound to a different run or approval");
      return existing;
    }
    const now = this.timestamp();
    return this.persistence.saveWorkflow({
      version: 1,
      run_id: request.run_id,
      task_id: request.task_id,
      approval_hash: request.approval_hash,
      state: request.initial_workflow_state,
      attempt_ids: [],
      active_attempt_id: null,
      blocked_reason: null,
      revision: 0,
      created_at: now,
      updated_at: now,
    });
  }

  private assertWorkflowBinding(workflow: WorkflowRecord, runId: string, approvalHash: string): void {
    if (workflow.run_id !== runId || workflow.approval_hash !== approvalHash) throw new ExecutionConflictError("Workflow is bound to a different run or approval");
  }

  private async attachAttempt(workflow: WorkflowRecord, attemptId: string, start: WorkflowState): Promise<WorkflowRecord> {
    const attemptIds = workflow.attempt_ids.includes(attemptId) ? workflow.attempt_ids : [...workflow.attempt_ids, attemptId];
    return this.transitionWorkflow({ ...workflow, attempt_ids: attemptIds }, start, attemptId, null);
  }

  private async transitionWorkflow(workflow: WorkflowRecord, next: WorkflowState, activeAttemptId: string | null, blockedReason: string | null): Promise<WorkflowRecord> {
    if (workflow.state !== next) assertTransition(workflow.state, next);
    const updated: WorkflowRecord = {
      ...workflow,
      state: next,
      active_attempt_id: activeAttemptId,
      blocked_reason: blockedReason === null ? null : redactText(blockedReason),
      revision: workflow.revision + 1,
      updated_at: this.timestamp(),
    };
    return this.persistence.saveWorkflow(updated);
  }

  private blockWorkflow(workflow: WorkflowRecord, attempt: AttemptRecord, error: unknown): Promise<WorkflowRecord> {
    return this.transitionWorkflow(workflow, "BLOCKED", attempt.attempt_id, redactError(error));
  }

  private async completeFailure(taskId: string, attempt: AttemptRecord, status: "FAILED_BEFORE_SEND" | "AMBIGUOUS", failureClass: FailureClass, error: unknown): Promise<AttemptRecord> {
    return this.persistence.saveAttempt(taskId, {
      ...attempt,
      status,
      completed_at: this.timestamp(),
      failure_class: failureClass,
      redacted_error: persistenceErrorForStatus(error),
    });
  }

  private reuse<T>(request: AttemptExecutionRequest, attempt: AttemptRecord): AttemptExecutionResult<T> {
    if (attempt.request_fingerprint !== request.request_fingerprint || attempt.run_id !== request.run_id || attempt.stage !== request.stage || attempt.round !== request.round) throw new ExecutionConflictError("Idempotency key was reused with different execution data");
    return { attempt, reused: true };
  }

  private async waitForExisting<T>(request: AttemptExecutionRequest, attemptId: string): Promise<AttemptExecutionResult<T>> {
    const deadline = Date.now() + (this.options.lockWaitMs ?? 5_000);
    while (Date.now() < deadline) {
      const attempt = await this.persistence.tryLoadAttempt(request.task_id, attemptId);
      if (attempt) return this.reuse(request, attempt);
      await delay(5);
    }
    throw new ExecutionBusyError();
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

export function attemptIdFor(request: Pick<AttemptExecutionRequest, "task_id" | "approval_hash" | "stage" | "round">): string {
  return `attempt-${stableHash({ task_id: request.task_id, approval_hash: request.approval_hash, stage: request.stage, round: request.round }).slice(0, 32)}`;
}

function validateRequest(request: AttemptExecutionRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.task_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.run_id)) throw new ExecutionConflictError("Invalid task or run id");
  if (!/^[a-f0-9]{64}$/.test(request.approval_hash) || !/^[a-f0-9]{64}$/.test(request.request_fingerprint)) throw new ExecutionConflictError("Invalid approval or request fingerprint");
  if (!Number.isInteger(request.round) || request.round < 0) throw new ExecutionConflictError("Invalid attempt round");
}

function assertVerifiedResponse(value: VerifiedResponseMetadata): void {
  if (value.complete !== true) throw new Error("Provider response was incomplete");
  for (const field of [value.provider_request_id, value.response_model, value.response_origin]) if (typeof field !== "string" || field.length === 0) throw new Error("Provider response evidence was incomplete");
  for (const count of [value.usage.input_tokens, value.usage.output_tokens, value.usage.reasoning_tokens]) if (!Number.isInteger(count) || count < 0) throw new Error("Provider usage was invalid");
}
