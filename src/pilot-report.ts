import { hashesEqual, stableHash } from "./canonical.js";
import { containsSecretLikeText } from "./contracts.js";
import type { HumanInterventionType, PilotPairReport, PilotRecommendation, PilotRunRecord, PricingTimeBand, Stage } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STAGES: Stage[] = ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"];
const INTERVENTIONS: HumanInterventionType[] = ["manual_code_change", "scope_change", "provider_change", "model_change", "budget_change", "egress_change", "manual_resend", "gate_skip"];

export type PilotRunInput = Omit<PilotRunRecord, "automated_success" | "evidence_sufficient" | "recommendation" | "record_hash">;
export type PilotPairInput = Pick<PilotPairReport, "same_base_fixture" | "same_scope" | "same_hidden_gate" | "same_wall_budget" | "same_acceptance_criteria" | "created_at">;

export function createPilotRunRecord(input: PilotRunInput): PilotRunRecord {
  const automated_success = input.final_acceptance && input.human_interventions.length === 0;
  const evidence_sufficient = input.core_metrics_unavailable.length === 0 && derivedCoreMetricsUnavailable(input).length === 0;
  const recommendation = runRecommendation(input, automated_success, evidence_sufficient);
  const body = cloneRun({ ...input, automated_success, evidence_sufficient, recommendation });
  const record = Object.freeze({ ...body, record_hash: stableHash(body) });
  assertPilotRunRecord(record);
  return record;
}

export function assertPilotRunRecord(value: unknown): asserts value is PilotRunRecord {
  const record = exact(value, "PilotRunRecord", ["version", "task_id", "arm", "run_id", "base_fixture_hash", "task_package_hash", "route_binding_hash", "approval_hash", "execution_context_hash", "evidence_bundle_hash", "provider", "model", "endpoint_origin", "endpoint_path", "auth_alias", "first_pass_success", "final_acceptance", "visible_tests", "hidden_tests", "regression", "repair_count", "human_interventions", "automated_success", "violations", "ambiguity", "usage_by_stage_model", "provider_http_request_count", "wall_clock_ms", "costs", "pricing_catalog", "core_metrics_unavailable", "evidence_sufficient", "remaining_risks", "recommendation", "created_at", "record_hash"]);
  if (record.version !== 1) throw new Error("PilotRunRecord.version must equal 1"); id(record.task_id, "task_id"); id(record.run_id, "run_id"); oneOf(record.arm, ["gpt_only", "hybrid"], "arm");
  for (const field of ["base_fixture_hash", "task_package_hash", "route_binding_hash", "approval_hash", "execution_context_hash", "evidence_bundle_hash", "record_hash"] as const) hash(record[field], field);
  safe(record.provider, "provider"); for (const field of ["model", "endpoint_origin", "endpoint_path", "auth_alias"] as const) if (record[field] !== null) safe(record[field], field);
  for (const field of ["first_pass_success", "final_acceptance", "regression", "automated_success", "evidence_sufficient"] as const) bool(record[field], field);
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
