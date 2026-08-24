import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assertContractApproval } from "./approval.js";
import { hashesEqual, stableHash } from "./canonical.js";
import { assertApprovalRecord, assertAttemptRecord, assertEvidenceBundle, assertExecutionContext, assertRouteBinding, assertTaskPackage, containsSecretLikeText } from "./contracts.js";
import { assertEffectivePolicy } from "./policy.js";
import { assertQualityAcceptanceProjection, type QualityAcceptanceProjection } from "./hidden-acceptance.js";
import type { ApprovalRecord, AttemptRecord, EffectivePolicy, EvidenceBundle, ExecutionContext, HumanInterventionType, PilotArm, PilotPairReport, PilotRecommendation, PilotRunRecord, PricingTimeBand, RouteBinding, Stage, TaskPackage } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STAGES: Stage[] = ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"];
const INTERVENTIONS: HumanInterventionType[] = ["manual_code_change", "scope_change", "provider_change", "model_change", "budget_change", "egress_change", "manual_resend", "gate_skip"];

type PilotRunInput = Omit<PilotRunRecord, "hard_stop" | "automated_success" | "evidence_sufficient" | "recommendation" | "record_hash">;
export type PilotPairInput = Pick<PilotPairReport, "same_base_fixture" | "same_scope" | "same_hidden_gate" | "same_wall_budget" | "same_acceptance_criteria" | "created_at">;

export interface PilotPersistedStateProjection {
  task_package: TaskPackage;
  effective_policy: EffectivePolicy;
  route_binding: RouteBinding;
  execution_context: ExecutionContext;
  approval_record: ApprovalRecord;
  final_review: { decision: "PASS" | "REPAIR_REQUIRED" | "BLOCKED"; summary: string; reviewed_at: string; evidence_bundle_hash: string } | null;
  review_history: Array<{ decision: "PASS" | "REPAIR_REQUIRED" | "BLOCKED"; summary: string; reviewed_at: string; evidence_bundle_hash: string }>;
  repair_count: number;
  human_interventions: Array<{ type: HumanInterventionType; summary: string }>;
}

/** Inputs are durable records or fresh observations, never caller-authored result claims. */
export interface PilotRunDerivationInput {
  arm: PilotArm;
  persisted_state: PilotPersistedStateProjection;
  attempts: AttemptRecord[];
  evidence_bundle: EvidenceBundle;
  observed_main_workspace_snapshot: string;
  created_at: string;
}

export function createPilotRunRecordFromEvidence(source: PilotRunDerivationInput): PilotRunRecord {
  const { persisted_state: state, evidence_bundle: bundle } = source;
  assertDerivationSource(source);
  const acceptance = bundle.acceptance_results;
  const summaries = deriveTestSummaries(acceptance);
  const usage = deriveUsage(bundle, state.route_binding);
  const ambiguousAttempts = source.attempts.filter(item => item.status === "AMBIGUOUS").length;
  const ambiguousRequests = bundle.transport_rounds.filter(item => item.outcome === "AMBIGUOUS").length;
  const totalRequests = deriveProviderRequestCount(source.attempts, bundle, source.arm);
  const duplicateRequests = unexplainedDuplicateRequests(source.attempts);
  const routingViolations = deriveRoutingViolations(bundle, state.route_binding);
  const violations = {
    secret: bundle.secret_scan_summary.new_findings,
    scope: bundle.scope_violations.length,
    privacy: bundle.privacy_violations.length,
    routing: routingViolations,
    main_workspace_pollution: hashesEqual(source.observed_main_workspace_snapshot, state.execution_context.main_workspace_snapshot) ? 0 : 1,
    unexplained_duplicate_requests: duplicateRequests,
  };
  const ambiguity = {
    attempts: ambiguousAttempts, total_attempts: source.attempts.length, attempt_rate: fraction(ambiguousAttempts, source.attempts.length),
    requests: ambiguousRequests, total_requests: totalRequests ?? 0, request_rate: totalRequests === null ? 0 : fraction(ambiguousRequests, totalRequests),
  };
  const regression = summaries.regression;
  const acceptanceComplete = summaries.visible.passed > 0 && summaries.visible.failed === 0 && summaries.visible.not_run === 0 && summaries.hidden.passed > 0 && summaries.hidden.failed === 0 && summaries.hidden.not_run === 0 && acceptance.scope_passed && acceptance.secret_passed && acceptance.diff_passed && acceptance.freeze_passed;
  const clean = acceptanceComplete && !regression && Object.values(violations).every(value => value === 0) && ambiguousAttempts === 0 && ambiguousRequests === 0;
  const currentReviewPassed = state.final_review?.decision === "PASS" && hashesEqual(state.final_review.evidence_bundle_hash, bundle.bundle_hash);
  const finalAcceptance = Boolean(currentReviewPassed && bundle.quality_passed && clean);
  const firstPass = Boolean(finalAcceptance && state.repair_count === 0 && state.review_history.length === 1 && state.review_history[0]?.decision === "PASS");
  const unavailable = deriveUnavailableMetrics(source, usage, totalRequests);
  const input: PilotRunInput = {
    version: 1, task_id: state.task_package.task_id, arm: source.arm, run_id: state.execution_context.run_id,
    base_fixture_hash: bundle.fixture_hash, task_package_hash: state.task_package.task_package_hash,
    route_binding_hash: state.route_binding.route_binding_hash, approval_hash: state.approval_record.approval_hash,
    execution_context_hash: state.execution_context.execution_context_hash, evidence_bundle_hash: bundle.bundle_hash,
    provider: state.route_binding.provider_id, model: unavailable.includes("model") ? null : state.route_binding.model_id,
    endpoint_origin: state.route_binding.endpoint_origin, endpoint_path: state.route_binding.endpoint_path, auth_alias: state.route_binding.auth_alias,
    first_pass_success: firstPass, final_acceptance: finalAcceptance, visible_tests: summaries.visible, hidden_tests: summaries.hidden,
    regression, repair_count: state.repair_count, human_interventions: structuredClone(state.human_interventions), violations, ambiguity,
    usage_by_stage_model: usage, provider_http_request_count: totalRequests, wall_clock_ms: { ...bundle.stage_wall_clock_ms },
    costs: { ...bundle.cost_metrics },
    pricing_catalog: bundle.pricing_catalog === null ? null : { version: bundle.pricing_catalog.version, hash: bundle.pricing_catalog.hash, source_urls: [...bundle.pricing_catalog.source_urls], time_bands: [...bundle.pricing_catalog.time_bands] },
    core_metrics_unavailable: unavailable, remaining_risks: [...bundle.remaining_risks], created_at: source.created_at,
  };
  return assemblePilotRunRecord(input);
}

function assemblePilotRunRecord(input: PilotRunInput): PilotRunRecord {
  const hard_stop = hardStop(input);
  const automated_success = input.final_acceptance && input.human_interventions.length === 0;
  const evidence_sufficient = input.core_metrics_unavailable.length === 0 && derivedCoreMetricsUnavailable(input).length === 0;
  const recommendation = runRecommendation(input, automated_success, evidence_sufficient);
  const body = cloneRun({ ...input, hard_stop, automated_success, evidence_sufficient, recommendation });
  const record = Object.freeze({ ...body, record_hash: stableHash(body) });
  assertPilotRunRecord(record);
  return record;
}

export function assertPilotRunRecord(value: unknown): asserts value is PilotRunRecord {
  const record = exact(value, "PilotRunRecord", ["version", "task_id", "arm", "run_id", "base_fixture_hash", "task_package_hash", "route_binding_hash", "approval_hash", "execution_context_hash", "evidence_bundle_hash", "provider", "model", "endpoint_origin", "endpoint_path", "auth_alias", "first_pass_success", "final_acceptance", "visible_tests", "hidden_tests", "regression", "repair_count", "human_interventions", "hard_stop", "automated_success", "violations", "ambiguity", "usage_by_stage_model", "provider_http_request_count", "wall_clock_ms", "costs", "pricing_catalog", "core_metrics_unavailable", "evidence_sufficient", "remaining_risks", "recommendation", "created_at", "record_hash"]);
  if (record.version !== 1) throw new Error("PilotRunRecord.version must equal 1"); id(record.task_id, "task_id"); id(record.run_id, "run_id"); oneOf(record.arm, ["gpt_only", "hybrid"], "arm");
  for (const field of ["base_fixture_hash", "task_package_hash", "route_binding_hash", "approval_hash", "execution_context_hash", "evidence_bundle_hash", "record_hash"] as const) hash(record[field], field);
  safe(record.provider, "provider"); for (const field of ["model", "endpoint_origin", "endpoint_path", "auth_alias"] as const) if (record[field] !== null) safe(record[field], field);
  for (const field of ["first_pass_success", "final_acceptance", "regression", "hard_stop", "automated_success", "evidence_sufficient"] as const) bool(record[field], field);
  tests(record.visible_tests, "visible_tests"); tests(record.hidden_tests, "hidden_tests"); integer(record.repair_count, "repair_count");
  if (!Array.isArray(record.human_interventions)) throw new Error("human_interventions must be an array"); record.human_interventions.forEach((item, index) => { const intervention = exact(item, `human_interventions[${index}]`, ["type", "summary"]); oneOf(intervention.type, INTERVENTIONS, "intervention.type"); safe(intervention.summary, "intervention.summary"); });
  const violations = exact(record.violations, "violations", ["secret", "scope", "privacy", "routing", "main_workspace_pollution", "unexplained_duplicate_requests"]); Object.entries(violations).forEach(([field, number]) => integer(number, `violations.${field}`));
  const ambiguity = exact(record.ambiguity, "ambiguity", ["attempts", "total_attempts", "attempt_rate", "requests", "total_requests", "request_rate"]); for (const field of ["attempts", "total_attempts", "requests", "total_requests"] as const) integer(ambiguity[field], `ambiguity.${field}`); for (const field of ["attempt_rate", "request_rate"] as const) rate(ambiguity[field], `ambiguity.${field}`);
  if ((ambiguity.attempts as number) > (ambiguity.total_attempts as number) || (ambiguity.requests as number) > (ambiguity.total_requests as number) || ambiguity.attempt_rate !== fraction(ambiguity.attempts as number, ambiguity.total_attempts as number) || ambiguity.request_rate !== fraction(ambiguity.requests as number, ambiguity.total_requests as number)) throw new Error("ambiguity rates do not match counts");
  if (!Array.isArray(record.usage_by_stage_model)) throw new Error("usage_by_stage_model must be an array"); record.usage_by_stage_model.forEach((item, index) => usage(item, index));
  if (record.provider_http_request_count !== null) integer(record.provider_http_request_count, "provider_http_request_count"); wall(record.wall_clock_ms); costs(record.costs);
  if (record.pricing_catalog !== null) pricing(record.pricing_catalog);
  strings(record.core_metrics_unavailable, "core_metrics_unavailable"); strings(record.remaining_risks, "remaining_risks"); oneOf(record.recommendation, ["expand", "simplify", "stop"], "recommendation"); timestamp(record.created_at, "created_at");
  if (record.automated_success !== (record.final_acceptance && record.human_interventions.length === 0)) throw new Error("automated_success contradicts intervention taxonomy");
  if (record.hard_stop !== hardStop(record as unknown as PilotRunInput)) throw new Error("hard_stop contradicts deterministic violations, ambiguity, or regression evidence");
  if (record.evidence_sufficient !== (record.core_metrics_unavailable.length === 0 && derivedCoreMetricsUnavailable(record as unknown as PilotRunInput).length === 0)) throw new Error("evidence_sufficient contradicts unavailable core metrics");
  if (record.recommendation !== runRecommendation(record as unknown as PilotRunInput, record.automated_success as boolean, record.evidence_sufficient as boolean)) throw new Error("Pilot run recommendation contradicts fixed decision gates");
  const { record_hash: _hash, ...body } = record; if (!hashesEqual(record.record_hash as string, stableHash(body))) throw new Error("PilotRunRecord hash does not match canonical content");
}

export function createPilotPairReport(gptOnly: PilotRunRecord, hybrid: PilotRunRecord, input: PilotPairInput): PilotPairReport {
  assertPilotRunRecord(gptOnly); assertPilotRunRecord(hybrid);
  if (gptOnly.arm !== "gpt_only" || hybrid.arm !== "hybrid" || gptOnly.task_id !== hybrid.task_id) throw new Error("Pilot pair arms or task binding are invalid");
  if (input.same_base_fixture !== (gptOnly.base_fixture_hash === hybrid.base_fixture_hash)) throw new Error("Pilot pair base-fixture fairness claim contradicts the bound fixture hashes");
  const cost_reduction_percent = percentageReduction(gptOnly.costs.estimated_list_usd, hybrid.costs.estimated_list_usd);
  const hybrid_latency_increase_percent = percentageIncrease(gptOnly.wall_clock_ms.total, hybrid.wall_clock_ms.total);
  const expansion_blockers = pairBlockers(gptOnly, hybrid, input, cost_reduction_percent);
  const recommendation = pairRecommendation(gptOnly, hybrid, expansion_blockers, cost_reduction_percent, hybrid_latency_increase_percent);
  const body = { version: 1 as const, task_id: gptOnly.task_id, gpt_only_run_hash: gptOnly.record_hash, hybrid_run_hash: hybrid.record_hash, ...input, hybrid_acceptance_not_lower: !gptOnly.final_acceptance || hybrid.final_acceptance, cost_reduction_percent, hybrid_latency_increase_percent, expansion_blockers, recommendation };
  const report = Object.freeze({ ...body, report_hash: stableHash(body) }); assertPilotPairReportForRuns(report, gptOnly, hybrid); return report;
}

export function assertPilotPairReportForRuns(value: unknown, gptOnly: PilotRunRecord, hybrid: PilotRunRecord): asserts value is PilotPairReport {
  assertPilotRunRecord(gptOnly); assertPilotRunRecord(hybrid);
  const report = exact(value, "PilotPairReport", ["version", "task_id", "gpt_only_run_hash", "hybrid_run_hash", "same_base_fixture", "same_scope", "same_hidden_gate", "same_wall_budget", "same_acceptance_criteria", "hybrid_acceptance_not_lower", "cost_reduction_percent", "hybrid_latency_increase_percent", "expansion_blockers", "recommendation", "created_at", "report_hash"]);
  if (report.version !== 1) throw new Error("PilotPairReport.version must equal 1"); id(report.task_id, "task_id"); for (const field of ["gpt_only_run_hash", "hybrid_run_hash", "report_hash"] as const) hash(report[field], field);
  for (const field of ["same_base_fixture", "same_scope", "same_hidden_gate", "same_wall_budget", "same_acceptance_criteria", "hybrid_acceptance_not_lower"] as const) bool(report[field], field);
  for (const field of ["cost_reduction_percent", "hybrid_latency_increase_percent"] as const) if (report[field] !== null) finite(report[field], field);
  strings(report.expansion_blockers, "expansion_blockers"); oneOf(report.recommendation, ["expand", "simplify", "stop"], "recommendation"); timestamp(report.created_at, "created_at");
  if (report.task_id !== gptOnly.task_id || report.task_id !== hybrid.task_id || report.gpt_only_run_hash !== gptOnly.record_hash || report.hybrid_run_hash !== hybrid.record_hash) throw new Error("PilotPairReport replay or run binding mismatch");
  const { report_hash: _hash, ...body } = report; if (!hashesEqual(report.report_hash as string, stableHash(body))) throw new Error("PilotPairReport hash does not match canonical content");
  const expected = createPairProjection(gptOnly, hybrid, report as unknown as PilotPairReport); if (stableHash(body) !== stableHash(expected)) throw new Error("PilotPairReport decision fields contradict fixed gates");
}

function createPairProjection(gptOnly: PilotRunRecord, hybrid: PilotRunRecord, report: PilotPairReport): Omit<PilotPairReport, "report_hash"> {
  const input: PilotPairInput = { same_base_fixture: report.same_base_fixture, same_scope: report.same_scope, same_hidden_gate: report.same_hidden_gate, same_wall_budget: report.same_wall_budget, same_acceptance_criteria: report.same_acceptance_criteria, created_at: report.created_at };
  const cost = percentageReduction(gptOnly.costs.estimated_list_usd, hybrid.costs.estimated_list_usd); const latency = percentageIncrease(gptOnly.wall_clock_ms.total, hybrid.wall_clock_ms.total); const blockers = pairBlockers(gptOnly, hybrid, input, cost);
  return { version: 1, task_id: gptOnly.task_id, gpt_only_run_hash: gptOnly.record_hash, hybrid_run_hash: hybrid.record_hash, ...input, hybrid_acceptance_not_lower: !gptOnly.final_acceptance || hybrid.final_acceptance, cost_reduction_percent: cost, hybrid_latency_increase_percent: latency, expansion_blockers: blockers, recommendation: pairRecommendation(gptOnly, hybrid, blockers, cost, latency) };
}

function runRecommendation(input: PilotRunInput, automated: boolean, sufficient: boolean): PilotRecommendation { return hardStop(input) || !sufficient || !input.final_acceptance ? "stop" : automated ? "simplify" : "stop"; }
function hardStop(input: Pick<PilotRunRecord, "violations" | "ambiguity" | "regression">): boolean { return input.regression || Object.values(input.violations).some(value => value > 0) || input.ambiguity.attempts > 0 || input.ambiguity.requests > 0; }
function pairBlockers(gpt: PilotRunRecord, hybrid: PilotRunRecord, fairness: Omit<PilotPairInput, "created_at">, cost: number | null): string[] { const blockers: string[] = []; for (const [field, value] of Object.entries(fairness)) if (!value) blockers.push(`fairness:${field}`); if (hardStop(gpt) || hardStop(hybrid)) blockers.push("hard_stop_violation"); if (!gpt.evidence_sufficient || !hybrid.evidence_sufficient) blockers.push("core_evidence_unavailable"); if (!gpt.final_acceptance || !hybrid.final_acceptance) blockers.push("final_acceptance_failed"); if (gpt.final_acceptance && !hybrid.final_acceptance) blockers.push("hybrid_acceptance_lower"); if (hybrid.repair_count > gpt.repair_count) blockers.push("hybrid_repair_increase"); if (hybrid.human_interventions.length > gpt.human_interventions.length) blockers.push("hybrid_intervention_increase"); if (cost === null) blockers.push("cost_reduction_unavailable"); else if (cost < 30) blockers.push("cost_reduction_below_30_percent"); return blockers; }
function pairRecommendation(_gpt: PilotRunRecord, _hybrid: PilotRunRecord, blockers: string[], cost: number | null, _latency: number | null): PilotRecommendation { if (blockers.some(item => item === "hard_stop_violation" || item === "core_evidence_unavailable" || item === "final_acceptance_failed" || item === "hybrid_acceptance_lower" || item.startsWith("fairness:"))) return "stop"; if (cost === null || cost < 30 || blockers.includes("hybrid_repair_increase") || blockers.includes("hybrid_intervention_increase")) return "simplify"; return "expand"; }
function derivedCoreMetricsUnavailable(input: PilotRunInput): string[] { const missing: string[] = []; if (input.model === null) missing.push("model"); if (input.provider_http_request_count === null) missing.push("provider_http_request_count"); if (input.usage_by_stage_model.length === 0 || input.usage_by_stage_model.some(item => item.model === null || [item.input_tokens, item.output_tokens, item.reasoning_tokens, item.cache_hit_tokens, item.cache_miss_tokens].some(value => value === null))) missing.push("token_usage"); if (input.costs.estimated_list_usd === null) missing.push("estimated_list_cost"); if (input.pricing_catalog === null) missing.push("pricing_catalog"); return missing; }
function percentageReduction(base: number | null, candidate: number | null): number | null { return base === null || candidate === null || base <= 0 ? null : rounded(((base - candidate) / base) * 100); }
function percentageIncrease(base: number, candidate: number): number | null { return base <= 0 ? null : rounded(((candidate - base) / base) * 100); }
function rounded(value: number): number { return Math.round(value * 1e6) / 1e6; }
function fraction(part: number, total: number): number { return total === 0 ? 0 : rounded(part / total); }
function cloneRun<T extends Omit<PilotRunRecord, "record_hash">>(value: T): T { return structuredClone(value); }

function assertDerivationSource(source: PilotRunDerivationInput): void {
  const state = source.persisted_state; const bundle = source.evidence_bundle;
  oneOf(source.arm, ["gpt_only", "hybrid"], "arm"); hash(source.observed_main_workspace_snapshot, "observed_main_workspace_snapshot"); timestamp(source.created_at, "created_at");
  assertTaskPackage(state.task_package); assertEffectivePolicy(state.effective_policy); assertRouteBinding(state.route_binding); assertExecutionContext(state.execution_context); assertApprovalRecord(state.approval_record); assertEvidenceBundle(bundle);
  assertContractApproval({ taskPackage: state.task_package, routeBinding: state.route_binding, executionContext: state.execution_context, effectivePolicy: state.effective_policy }, state.approval_record, new Date(state.approval_record.approved_at));
  if (state.approval_record.expires_at !== null && source.attempts.some(item => item.send_started_at !== null && Date.parse(item.send_started_at) >= Date.parse(state.approval_record.expires_at!))) throw new Error("Pilot attempt crossed the approved provider side-effect expiry boundary");
  if (state.execution_context.task_id !== state.task_package.task_id || state.execution_context.task_package_hash !== state.task_package.task_package_hash || state.execution_context.route_binding_hash !== state.route_binding.route_binding_hash || state.execution_context.policy_hash !== state.effective_policy.policy_hash) throw new Error("Pilot persisted state contract bindings are inconsistent");
  if (bundle.task_id !== state.task_package.task_id || bundle.run_id !== state.execution_context.run_id || bundle.task_package_hash !== state.task_package.task_package_hash || bundle.route_binding_hash !== state.route_binding.route_binding_hash || bundle.policy_hash !== state.effective_policy.policy_hash || bundle.approval_hash !== state.approval_record.approval_hash || bundle.execution_context_hash !== state.execution_context.execution_context_hash || bundle.base_commit !== state.execution_context.base_commit || bundle.worktree_id !== state.execution_context.worktree_id) throw new Error("Pilot EvidenceBundle replay or contract binding mismatch");
  assertQualityAcceptanceProjection(bundle.acceptance_results);
  if (bundle.acceptance_results.quality_report_hash !== bundle.quality_report_hash || bundle.acceptance_results.fixture_hash !== bundle.fixture_hash || bundle.acceptance_results.base_commit !== bundle.base_commit) throw new Error("Pilot acceptance evidence is not bound to the current EvidenceBundle, fixture, and base commit");
  if (bundle.acceptance_results.scope_passed !== (bundle.scope_violations.length === 0) || bundle.acceptance_results.secret_passed !== (bundle.secret_scan_summary.outcome === "passed" && bundle.secret_scan_summary.new_findings === 0) || bundle.acceptance_results.freeze_passed !== (bundle.content_snapshot_hash === bundle.post_artifact_snapshot_hash)) throw new Error("Pilot acceptance projection contradicts the EvidenceBundle");
  if (!Number.isInteger(state.repair_count) || state.repair_count < 0 || state.repair_count !== bundle.repair_count) throw new Error("Pilot repair count does not match the EvidenceBundle");
  if (!Array.isArray(state.human_interventions)) throw new Error("Pilot human interventions must come from persisted state");
  state.human_interventions.forEach((item, index) => { const value = exact(item, `human_interventions[${index}]`, ["type", "summary"]); oneOf(value.type, INTERVENTIONS, "intervention.type"); safe(value.summary, "intervention.summary"); });
  if (!Array.isArray(state.review_history)) throw new Error("Pilot review history must be persisted");
  state.review_history.forEach((item, index) => assertReview(item, `review_history[${index}]`));
  if (state.final_review !== null) {
    assertReview(state.final_review, "final_review");
    const latest = state.review_history.at(-1);
    if (!latest || stableHash(latest) !== stableHash(state.final_review) || state.final_review.evidence_bundle_hash !== bundle.bundle_hash) throw new Error("Pilot final review is not bound to the current EvidenceBundle");
  }
  if (!Array.isArray(source.attempts)) throw new Error("Pilot attempts must be persisted records");
  source.attempts.forEach(attempt => { assertAttemptRecord(attempt); if (attempt.run_id !== bundle.run_id) throw new Error("Pilot AttemptRecord replay or run binding mismatch"); });
  const attemptIds = source.attempts.map(item => item.attempt_id); if (new Set(attemptIds).size !== attemptIds.length) throw new Error("Pilot AttemptRecords contain duplicate ids");
  if ([...attemptIds].sort().join("\0") !== [...bundle.attempt_ids].sort().join("\0")) throw new Error("Pilot AttemptRecords do not match the current EvidenceBundle");
  for (const summary of bundle.attempt_summaries) {
    const attempt = source.attempts.find(item => item.attempt_id === summary.attempt_id);
    if (!attempt || attempt.stage !== summary.stage || attempt.status !== summary.status || attempt.failure_class !== summary.failure_class) throw new Error("Pilot AttemptRecord summary mismatch");
  }
  const attemptRounds = source.attempts.flatMap(item => item.transport_rounds);
  if (stableHash(attemptRounds) !== stableHash(bundle.transport_rounds)) throw new Error("Pilot AttemptRecord transport evidence does not match the EvidenceBundle");
}

function assertReview(value: unknown, name: string): void {
  const item = exact(value, name, ["decision", "summary", "reviewed_at", "evidence_bundle_hash"]);
  oneOf(item.decision, ["PASS", "REPAIR_REQUIRED", "BLOCKED"], `${name}.decision`); safe(item.summary, `${name}.summary`); timestamp(item.reviewed_at, `${name}.reviewed_at`); hash(item.evidence_bundle_hash, `${name}.evidence_bundle_hash`);
}

function deriveTestSummaries(projection: QualityAcceptanceProjection): { visible: PilotRunRecord["visible_tests"]; hidden: PilotRunRecord["hidden_tests"]; regression: boolean } { return { visible: { ...projection.visible_tests }, hidden: { ...projection.hidden_tests }, regression: projection.regression }; }

function deriveUsage(bundle: EvidenceBundle, binding: RouteBinding): PilotRunRecord["usage_by_stage_model"] {
  const groups = new Map<string, PilotRunRecord["usage_by_stage_model"][number]>();
  for (const round of bundle.transport_rounds.filter(item => item.outcome === "SUCCEEDED")) {
    const model = round.response_model;
    const key = `${round.stage}\0${binding.provider_id}\0${model ?? ""}`;
    const current = groups.get(key) ?? { stage: round.stage, provider: binding.provider_id, model, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    for (const field of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_hit_tokens", "cache_miss_tokens"] as const) current[field] = current[field] === null || round.usage === null ? null : current[field]! + round.usage[field];
    groups.set(key, current);
  }
  if (groups.size === 0 && bundle.attempt_summaries.some(item => item.stage === "EXECUTE" || item.stage === "REPAIR")) return [{ stage: "EXECUTE", provider: binding.provider_id, model: null, input_tokens: null, output_tokens: null, reasoning_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null }];
  return [...groups.values()].sort((left, right) => STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage) || (left.model ?? "").localeCompare(right.model ?? ""));
}

function deriveProviderRequestCount(attempts: AttemptRecord[], bundle: EvidenceBundle, arm: PilotArm): number | null {
  const sent = attempts.filter(item => item.send_started_at !== null || ["SENDING", "SUCCEEDED", "AMBIGUOUS"].includes(item.status));
  if (arm === "gpt_only" && bundle.transport_rounds.length === 0) return null;
  if (sent.some(item => item.transport_rounds.length === 0)) return null;
  return bundle.transport_rounds.length;
}

function unexplainedDuplicateRequests(attempts: AttemptRecord[]): number {
  const counts = new Map<string, number>();
  for (const attempt of attempts.filter(item => item.send_started_at !== null)) counts.set(attempt.request_fingerprint, (counts.get(attempt.request_fingerprint) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function deriveRoutingViolations(bundle: EvidenceBundle, binding: RouteBinding): number {
  let violations = bundle.route_evidence_summaries.filter(item => item.verification_status === "incomplete" || !item.request_id_present || item.provider !== binding.provider_id || item.model !== binding.model_id).length;
  violations += bundle.transport_rounds.filter(round => round.response_model !== null && round.response_model !== binding.model_id || round.response_origin !== null && round.response_origin !== binding.endpoint_origin || round.response_path !== null && round.response_path !== binding.endpoint_path).length;
  return violations;
}

function deriveUnavailableMetrics(source: PilotRunDerivationInput, usage: PilotRunRecord["usage_by_stage_model"], requestCount: number | null): string[] {
  const missing: string[] = [];
  if (source.arm === "gpt_only" && source.evidence_bundle.route_evidence_summaries.length === 0) missing.push("model");
  if (requestCount === null) missing.push("provider_http_request_count");
  if (usage.length === 0 || usage.some(item => item.model === null || [item.input_tokens, item.output_tokens, item.reasoning_tokens, item.cache_hit_tokens, item.cache_miss_tokens].some(value => value === null))) missing.push("token_usage");
  if (source.evidence_bundle.cost_metrics.estimated_list_usd === null) missing.push("estimated_list_cost");
  if (source.evidence_bundle.pricing_catalog === null) missing.push("pricing_catalog");
  return missing;
}

export async function persistPilotRunRecord(stateRoot: string, record: PilotRunRecord): Promise<string> {
  assertPilotRunRecord(record); const root = path.resolve(stateRoot); const directory = path.join(root, "tasks", record.task_id, "pilot-runs"); const target = path.join(directory, `${record.run_id}.json`); const temporary = path.join(directory, `.pilot-run.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    const existing = await readPilotRunRecordFile(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (existing !== null) { if (existing.record_hash !== record.record_hash || existing.evidence_bundle_hash !== record.evidence_bundle_hash) throw new Error("PilotRunRecord replay or immutable record collision"); return target; }
    const handle = await open(temporary, "wx"); try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readPilotRunRecordFile(target); if (raced.record_hash !== record.record_hash || raced.evidence_bundle_hash !== record.evidence_bundle_hash) throw new Error("PilotRunRecord replay or immutable record collision");
    }
    return target;
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readPilotRunRecord(stateRoot: string, taskId: string, runId: string, evidenceBundleHash: string): Promise<PilotRunRecord> {
  id(taskId, "task_id"); id(runId, "run_id"); hash(evidenceBundleHash, "evidence_bundle_hash");
  const record = await readPilotRunRecordFile(path.join(path.resolve(stateRoot), "tasks", taskId, "pilot-runs", `${runId}.json`));
  if (record.task_id !== taskId || record.run_id !== runId || !hashesEqual(record.evidence_bundle_hash, evidenceBundleHash)) throw new Error("PilotRunRecord replay or EvidenceBundle binding mismatch");
  return record;
}

async function readPilotRunRecordFile(file: string): Promise<PilotRunRecord> { const value = JSON.parse(await readFile(file, "utf8")) as unknown; assertPilotRunRecord(value); return value; }
function exact(value: unknown, name: string, keys: string[]): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); const object = value as Record<string, any>; const actual = Object.keys(object); const unknown = actual.filter(key => !keys.includes(key)); const missing = keys.filter(key => !(key in object)); if (unknown.length || missing.length) throw new Error(`${name} has unknown or missing fields`); return object; }
function tests(value: unknown, name: string): void { const item = exact(value, name, ["passed", "failed", "not_run"]); Object.entries(item).forEach(([field, count]) => integer(count, `${name}.${field}`)); }
function usage(value: unknown, index: number): void { const item = exact(value, `usage[${index}]`, ["stage", "provider", "model", "input_tokens", "output_tokens", "reasoning_tokens", "cache_hit_tokens", "cache_miss_tokens"]); oneOf(item.stage, STAGES, "usage.stage"); safe(item.provider, "usage.provider"); if (item.model !== null) safe(item.model, "usage.model"); for (const field of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_hit_tokens", "cache_miss_tokens"]) if (item[field] !== null) integer(item[field], `usage.${field}`); }
function wall(value: unknown): void { const item = exact(value, "wall_clock_ms", ["plan", "execute", "gate", "review", "repair", "total"]); for (const field of ["plan", "execute", "gate", "review", "repair"]) if (item[field] !== null) integer(item[field], `wall.${field}`); integer(item.total, "wall.total"); if ([item.plan, item.execute, item.gate, item.review, item.repair].reduce((sum, number) => sum + (number ?? 0), 0) !== item.total) throw new Error("wall_clock_ms total is inconsistent"); }
function costs(value: unknown): void { const item = exact(value, "costs", ["provider_reported_usd", "estimated_list_usd", "invoice_usd", "chatgpt_quota"]); Object.entries(item).forEach(([field, number]) => { if (number !== null) nonnegative(number, `costs.${field}`); }); }
function pricing(value: unknown): void { const item = exact(value, "pricing_catalog", ["version", "hash", "source_urls", "time_bands"]); safe(item.version, "pricing.version"); hash(item.hash, "pricing.hash"); strings(item.source_urls, "pricing.source_urls"); if (!Array.isArray(item.time_bands) || item.time_bands.length === 0) throw new Error("pricing time bands are required"); item.time_bands.forEach((band: unknown) => oneOf(band, ["peak", "off_peak", "standard"] satisfies PricingTimeBand[], "pricing.time_band")); }
function strings(value: unknown, name: string): void { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); value.forEach((item, index) => safe(item, `${name}[${index}]`)); if (new Set(value).size !== value.length) throw new Error(`${name} must be unique`); }
function safe(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || /[\r\0]/.test(value) || containsSecretLikeText(value)) throw new Error(`${name} must be safe text`); }
function id(value: unknown, name: string): void { if (typeof value !== "string" || !ID.test(value)) throw new Error(`${name} must be a safe identifier`); }
function hash(value: unknown, name: string): void { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${name} must be a SHA-256 hash`); }
function oneOf(value: unknown, choices: readonly string[], name: string): void { if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${name} is invalid`); }
function bool(value: unknown, name: string): void { if (typeof value !== "boolean") throw new Error(`${name} must be boolean`); }
function integer(value: unknown, name: string): void { if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`); }
function finite(value: unknown, name: string): void { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`); }
function nonnegative(value: unknown, name: string): void { finite(value, name); if ((value as number) < 0) throw new Error(`${name} must be non-negative`); }
function rate(value: unknown, name: string): void { finite(value, name); if ((value as number) < 0 || (value as number) > 1) throw new Error(`${name} must be between zero and one`); }
function timestamp(value: unknown, name: string): void { if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a UTC timestamp`); }
