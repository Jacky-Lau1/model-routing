import type { LegacyWorkflowState, WorkflowState } from "./types.js";

const LEGACY_TRANSITIONS: Record<LegacyWorkflowState, LegacyWorkflowState[]> = {
  INTAKE: ["PROFILED", "ABORTED", "BLOCKED"],
  PROFILED: ["PLANNING", "ABORTED", "BLOCKED"],
  PLANNING: ["WAITING_APPROVAL", "BLOCKED", "ABORTED"],
  WAITING_APPROVAL: ["EXECUTING", "PLANNING", "ABORTED", "BLOCKED"],
  EXECUTING: ["VALIDATING", "BLOCKED", "ABORTED"],
  VALIDATING: ["REVIEWING", "REPAIRING", "SOL_DIAGNOSIS", "BLOCKED", "ABORTED"],
  REVIEWING: ["COMPLETED", "REPAIRING", "SOL_DIAGNOSIS", "BLOCKED", "ABORTED"],
  REPAIRING: ["VALIDATING", "SOL_DIAGNOSIS", "BLOCKED", "ABORTED"],
  SOL_DIAGNOSIS: ["WAITING_REAPPROVAL", "BLOCKED", "ABORTED"],
  WAITING_REAPPROVAL: ["EXECUTING", "PLANNING", "ABORTED", "BLOCKED"],
  COMPLETED: [], BLOCKED: ["PLANNING", "ABORTED"], ABORTED: [],
};

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!WORKFLOW_TRANSITIONS[from].includes(to)) throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function assertLegacyTransition(from: LegacyWorkflowState, to: LegacyWorkflowState): void {
  if (!LEGACY_TRANSITIONS[from].includes(to)) throw new Error(`Invalid state transition: ${from} -> ${to}`);
}

export function canLegacyTransition(from: LegacyWorkflowState, to: LegacyWorkflowState): boolean {
  return LEGACY_TRANSITIONS[from].includes(to);
}

const WORKFLOW_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  CREATED: ["PLANNING", "AWAITING_APPROVAL", "BLOCKED", "ABORTED"],
  PLANNING: ["AWAITING_APPROVAL", "BLOCKED", "ABORTED"],
  AWAITING_APPROVAL: ["APPROVED", "PLANNING", "BLOCKED", "ABORTED"],
  APPROVED: ["WORKTREE_READY", "EXECUTING", "BLOCKED", "ABORTED"],
  WORKTREE_READY: ["EXECUTING", "BLOCKED", "ABORTED"],
  EXECUTING: ["VALIDATING", "REVIEW_PENDING", "BLOCKED", "ABORTED"],
  VALIDATING: ["REVIEW_PENDING", "REPAIR_REQUIRED", "BLOCKED", "ABORTED"],
  REVIEW_PENDING: ["REPAIR_REQUIRED", "APPLY_PENDING", "PASSED", "BLOCKED", "ABORTED"],
  REPAIR_REQUIRED: ["EXECUTING", "VALIDATING", "BLOCKED", "ABORTED"],
  APPLY_PENDING: ["PASSED", "BLOCKED", "ABORTED"],
  PASSED: [],
  BLOCKED: ["PLANNING", "AWAITING_APPROVAL", "ABORTED"],
  ABORTED: [],
};
