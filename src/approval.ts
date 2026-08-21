import { createHash, timingSafeEqual } from "node:crypto";
import type { ApprovalRecord, PlanPacket, RouteDecision } from "./types.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function fingerprintRoute(route: RouteDecision): string {
  return createHash("sha256").update(canonical({ provider: route.provider, model: route.model, effort: route.effort, maxOutputTokens: route.maxOutputTokens, maxToolTurns: route.maxToolTurns, timeoutMs: route.timeoutMs })).digest("hex");
}

export function hashPlan(plan: PlanPacket): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

export function approvePlan(plan: PlanPacket, now = new Date()): ApprovalRecord {
  return { taskId: plan.taskId, planHash: hashPlan(plan), routeFingerprint: fingerprintRoute(plan.route), approvedAt: now.toISOString() };
}

export function assertApproval(plan: PlanPacket, approval?: ApprovalRecord): void {
  if (!approval || approval.taskId !== plan.taskId) throw new Error("Execution requires approval for this task");
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (!equal(approval.planHash, hashPlan(plan)) || !equal(approval.routeFingerprint, fingerprintRoute(plan.route))) throw new Error("Approval invalidated by plan or route change");
}
