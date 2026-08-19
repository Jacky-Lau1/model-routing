import type { WorkflowState } from "./types.js";

const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
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
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Invalid state transition: ${from} -> ${to}`);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}
