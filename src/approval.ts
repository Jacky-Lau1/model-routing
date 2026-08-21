import { randomUUID } from "node:crypto";
import { hashesEqual, stableHash } from "./canonical.js";
import { assertApprovalRecord, assertExecutionContext, assertRouteBinding, assertTaskPackage, createApprovalRecord } from "./contracts.js";
import { assertEffectivePolicy } from "./policy.js";
import type { ApprovalRecord, EffectivePolicy, ExecutionContext, LegacyApprovalRecord, PlanPacket, RouteBinding, RouteDecision, TaskPackage } from "./types.js";

export function fingerprintRoute(route: RouteDecision): string {
  return stableHash({ provider: route.provider, model: route.model, effort: route.effort, maxOutputTokens: route.maxOutputTokens, maxToolTurns: route.maxToolTurns, timeoutMs: route.timeoutMs });
}

export function hashPlan(plan: PlanPacket): string {
  return stableHash(plan);
}

const LEGACY_NO_ISOLATION = stableHash({ isolation: "not-bound" });

export function approvePlan(plan: PlanPacket, isolationHash = LEGACY_NO_ISOLATION, now = new Date()): LegacyApprovalRecord {
  return { taskId: plan.taskId, planHash: hashPlan(plan), routeFingerprint: fingerprintRoute(plan.route), isolationHash, approvedAt: now.toISOString() };
}

export function assertApproval(plan: PlanPacket, approval?: LegacyApprovalRecord, isolationHash = LEGACY_NO_ISOLATION): void {
  if (!approval || approval.taskId !== plan.taskId) throw new Error("Execution requires approval for this task");
  if (!hashesEqual(approval.planHash, hashPlan(plan)) || !hashesEqual(approval.routeFingerprint, fingerprintRoute(plan.route)) || !hashesEqual(approval.isolationHash, isolationHash)) throw new Error("Approval invalidated by plan, route, or isolation change");
}

export interface ContractApprovalSubject {
  taskPackage: TaskPackage;
  routeBinding: RouteBinding;
  executionContext: ExecutionContext;
  effectivePolicy: EffectivePolicy;
}

export function approveContracts(subject: ContractApprovalSubject, options: { approvalId?: string; approvedAt?: Date; expiresAt?: Date | null; scopeSummary?: string } = {}): ApprovalRecord {
  validateSubject(subject);
  const approvedAt = options.approvedAt ?? new Date();
  const record = createApprovalRecord({
    version: 1,
    approval_id: options.approvalId ?? `approval-${randomUUID()}`,
    task_id: subject.taskPackage.task_id,
    task_package_hash: subject.taskPackage.task_package_hash,
    route_binding_hash: subject.routeBinding.route_binding_hash,
    execution_context_hash: subject.executionContext.execution_context_hash,
    policy_hash: subject.effectivePolicy.policy_hash,
    approved_scope_summary: options.scopeSummary ?? `${subject.routeBinding.provider_id}: read ${subject.routeBinding.read_scope.length}, write ${subject.routeBinding.write_scope.length}`,
    approved_at: approvedAt.toISOString(),
    expires_at: options.expiresAt === undefined ? null : options.expiresAt?.toISOString() ?? null,
  });
  return record;
}

export function assertContractApproval(subject: ContractApprovalSubject, approval?: ApprovalRecord, now = new Date()): void {
  if (!approval) throw new Error("Execution requires a contract ApprovalRecord");
  validateSubject(subject); assertApprovalRecord(approval);
  const expected = [
    [approval.task_package_hash, subject.taskPackage.task_package_hash],
    [approval.route_binding_hash, subject.routeBinding.route_binding_hash],
    [approval.execution_context_hash, subject.executionContext.execution_context_hash],
    [approval.policy_hash, subject.effectivePolicy.policy_hash],
  ];
  if (approval.task_id !== subject.taskPackage.task_id || expected.some(([left, right]) => !hashesEqual(left, right))) throw new Error("Approval invalidated by task, route, scope, policy, budget, or execution context change");
  if (approval.expires_at && Date.parse(approval.expires_at) <= now.getTime()) throw new Error("Approval has expired");
}

function validateSubject(subject: ContractApprovalSubject): void {
  assertTaskPackage(subject.taskPackage); assertRouteBinding(subject.routeBinding); assertExecutionContext(subject.executionContext); assertEffectivePolicy(subject.effectivePolicy);
  if (subject.executionContext.task_id !== subject.taskPackage.task_id
    || !hashesEqual(subject.executionContext.task_package_hash, subject.taskPackage.task_package_hash)
    || !hashesEqual(subject.executionContext.route_binding_hash, subject.routeBinding.route_binding_hash)
    || !hashesEqual(subject.executionContext.policy_hash, subject.effectivePolicy.policy_hash)) throw new Error("ExecutionContext does not bind the supplied contract objects");
}
