import { canonicalSerialize, hashesEqual, stableHash } from "./canonical.js";
import { PRICING_CATALOG_HASH, PRICING_CATALOG_VERSION } from "./cost.js";
import { isForbiddenQualityPath } from "./scope-guard.js";
import type {
  ApprovalRecord,
  AttemptRecord,
  ContextManifestEntry,
  DataClassification,
  EgressPolicy,
  EvidenceBundle,
  ExecutionContext,
  RequestBudget,
  RouteBinding,
  TaskPackage,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;
const SECRET_LIKE = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]{6,}|\bBearer\s+[A-Za-z0-9._~-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:live-|test-)?[A-Za-z0-9_-]{16,}/i;

export type TaskPackageInput = Omit<TaskPackage, "task_package_hash">;
export type RouteBindingInput = Omit<RouteBinding, "route_binding_hash">;
export type ExecutionContextInput = Omit<ExecutionContext, "execution_context_hash">;
export type ApprovalRecordInput = Omit<ApprovalRecord, "approval_hash">;
export type EvidenceBundleInput = Omit<EvidenceBundle, "bundle_hash">;

export function normalizePrivacyInput(input: DataClassification | "PRIVATE_THIRD_PARTY_ALLOWED" | undefined, explicitEgress: EgressPolicy = { mode: "deny" }): { data_classification: DataClassification | null; egress_policy: EgressPolicy } {
  if (input === undefined) return { data_classification: null, egress_policy: { mode: "deny" } };
  if (input === "PRIVATE_THIRD_PARTY_ALLOWED") {
    if (explicitEgress.mode !== "allow") throw new Error("PRIVATE_THIRD_PARTY_ALLOWED requires an explicit provider/path/content-hash user authorization");
    assertEgressPolicy(explicitEgress);
    return { data_classification: "private", egress_policy: explicitEgress };
  }
  return { data_classification: input, egress_policy: explicitEgress };
}

export function createTaskPackage(input: TaskPackageInput): TaskPackage {
  const result = { ...input, task_package_hash: stableHash(input) };
  assertTaskPackage(result);
  return result;
}

export function hashTaskPackage(value: TaskPackage): string {
  const { task_package_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertTaskPackage(value: unknown): asserts value is TaskPackage {
  const object = exactObject(value, "TaskPackage", [
    "version", "task_id", "goal", "background_summary", "acceptance_criteria", "non_goals", "forbidden_actions",
    "read_scope", "write_scope", "relevant_interfaces", "context_manifest", "validation_requirements", "stop_conditions",
    "data_classification", "egress_policy", "request_budget", "created_at", "task_package_hash",
  ]);
  literal(object.version, 1, "TaskPackage.version");
  identifier(object.task_id, "TaskPackage.task_id");
  nonEmptySafeText(object.goal, "TaskPackage.goal");
  safeText(object.background_summary, "TaskPackage.background_summary");
  stringArray(object.acceptance_criteria, "TaskPackage.acceptance_criteria", true, true);
  stringArray(object.non_goals, "TaskPackage.non_goals", false, true);
  stringArray(object.forbidden_actions, "TaskPackage.forbidden_actions", false, true);
  assertPathScope(object.read_scope, "TaskPackage.read_scope");
  assertPathScope(object.write_scope, "TaskPackage.write_scope");
  stringArray(object.relevant_interfaces, "TaskPackage.relevant_interfaces", false, true);
  if (!Array.isArray(object.context_manifest)) throw new Error("TaskPackage.context_manifest must be an array");
  object.context_manifest.forEach((entry, index) => assertContextManifestEntry(entry, `TaskPackage.context_manifest[${index}]`));
  stringArray(object.validation_requirements, "TaskPackage.validation_requirements", false, true);
  stringArray(object.stop_conditions, "TaskPackage.stop_conditions", true, true);
  oneOf(object.data_classification, ["public", "private", "secret_restricted"], "TaskPackage.data_classification");
  assertEgressPolicy(object.egress_policy, "TaskPackage.egress_policy");
  assertRequestBudget(object.request_budget, "TaskPackage.request_budget");
  timestamp(object.created_at, "TaskPackage.created_at");
  hash(object.task_package_hash, "TaskPackage.task_package_hash");
  if (!hashesEqual(object.task_package_hash as string, hashTaskPackage(object as unknown as TaskPackage))) throw new Error("TaskPackage hash does not match canonical content");
}

export function createRouteBinding(input: RouteBindingInput): RouteBinding {
  const cloned: RouteBindingInput = {
    ...input,
    request_budget: Object.freeze({ ...input.request_budget }),
    read_scope: Object.freeze([...input.read_scope]) as unknown as string[],
    write_scope: Object.freeze([...input.write_scope]) as unknown as string[],
    network_scope: Object.freeze([...input.network_scope]) as unknown as string[],
    environment_scope: Object.freeze([...input.environment_scope]) as unknown as string[],
    command_scope: Object.freeze([...input.command_scope]) as unknown as string[],
  };
  const result = { ...cloned, route_binding_hash: stableHash(cloned) };
  assertRouteBinding(result);
  return Object.freeze(result);
}

export function hashRouteBinding(value: RouteBinding): string {
  const { route_binding_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertRouteBinding(value: unknown): asserts value is RouteBinding {
  const object = exactObject(value, "RouteBinding", [
    "version", "provider_id", "adapter_id", "model_id", "endpoint_origin", "endpoint_path", "wire_protocol", "auth_alias",
    "reasoning_mode", "reasoning_effort", "pricing_catalog_version", "pricing_catalog_hash", "request_budget", "read_scope", "write_scope", "network_scope", "environment_scope",
    "command_scope", "route_binding_hash",
  ]);
  literal(object.version, 1, "RouteBinding.version");
  oneOf(object.provider_id, ["openai-codex", "deepseek", "local"], "RouteBinding.provider_id");
  identifier(object.adapter_id, "RouteBinding.adapter_id");
  identifier(object.model_id, "RouteBinding.model_id");
  endpointOrigin(object.endpoint_origin, object.provider_id as string, "RouteBinding.endpoint_origin");
  endpointPath(object.endpoint_path, "RouteBinding.endpoint_path");
  oneOf(object.wire_protocol, ["chat_completions", "responses", "local"], "RouteBinding.wire_protocol");
  nullableIdentifier(object.auth_alias, "RouteBinding.auth_alias");
  oneOf(object.reasoning_mode, ["disabled", "enabled", "local"], "RouteBinding.reasoning_mode");
  oneOf(object.reasoning_effort, ["none", "low", "medium", "high"], "RouteBinding.reasoning_effort");
  if (object.provider_id === "local") {
    if (object.pricing_catalog_version !== null || object.pricing_catalog_hash !== null) throw new Error("Local RouteBinding cannot claim an external pricing catalog");
  } else {
    if (object.pricing_catalog_version !== PRICING_CATALOG_VERSION || object.pricing_catalog_hash !== PRICING_CATALOG_HASH) throw new Error("RouteBinding pricing catalog changed and requires a new route approval");
  }
  assertRequestBudget(object.request_budget, "RouteBinding.request_budget");
  assertPathScope(object.read_scope, "RouteBinding.read_scope");
  assertPathScope(object.write_scope, "RouteBinding.write_scope");
  stringArray(object.network_scope, "RouteBinding.network_scope", false, false);
  (object.network_scope as string[]).forEach((origin, index) => endpointOrigin(origin, "deepseek", `RouteBinding.network_scope[${index}]`));
  stringArray(object.environment_scope, "RouteBinding.environment_scope", false, false);
  stringArray(object.command_scope, "RouteBinding.command_scope", false, false);
  (object.environment_scope as unknown[]).forEach((entry, index) => identifier(entry, `RouteBinding.environment_scope[${index}]`));
  (object.command_scope as unknown[]).forEach((entry, index) => identifier(entry, `RouteBinding.command_scope[${index}]`));
  hash(object.route_binding_hash, "RouteBinding.route_binding_hash");
  if (!hashesEqual(object.route_binding_hash as string, hashRouteBinding(object as unknown as RouteBinding))) throw new Error("RouteBinding hash does not match canonical content");
}

export function createExecutionContext(input: ExecutionContextInput): ExecutionContext {
  const result = { ...input, execution_context_hash: stableHash(input) };
  assertExecutionContext(result);
  return result;
}

export function hashExecutionContext(value: ExecutionContext): string {
  const { execution_context_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertExecutionContext(value: unknown): asserts value is ExecutionContext {
  const object = exactObject(value, "ExecutionContext", [
    "version", "run_id", "task_id", "base_commit", "main_workspace_snapshot", "main_workspace_dirty_evidence", "worktree_id",
    "worktree_base", "policy_hash", "task_package_hash", "route_binding_hash", "created_at", "execution_context_hash",
  ]);
  literal(object.version, 1, "ExecutionContext.version");
  identifier(object.run_id, "ExecutionContext.run_id");
  identifier(object.task_id, "ExecutionContext.task_id");
  commit(object.base_commit, "ExecutionContext.base_commit");
  hash(object.main_workspace_snapshot, "ExecutionContext.main_workspace_snapshot");
  if (!Array.isArray(object.main_workspace_dirty_evidence)) throw new Error("ExecutionContext.main_workspace_dirty_evidence must be an array");
  object.main_workspace_dirty_evidence.forEach((entry, index) => {
    const dirty = exactObject(entry, `ExecutionContext.main_workspace_dirty_evidence[${index}]`, ["path", "status", "content_hash"]);
    assertSafeRelativePath(dirty.path, `${index}.path`);
    oneOf(dirty.status, ["modified", "added", "deleted", "renamed", "untracked"], `${index}.status`);
    if (dirty.content_hash !== null) hash(dirty.content_hash, `${index}.content_hash`);
  });
  identifier(object.worktree_id, "ExecutionContext.worktree_id");
  commit(object.worktree_base, "ExecutionContext.worktree_base");
  hash(object.policy_hash, "ExecutionContext.policy_hash");
  hash(object.task_package_hash, "ExecutionContext.task_package_hash");
  hash(object.route_binding_hash, "ExecutionContext.route_binding_hash");
  timestamp(object.created_at, "ExecutionContext.created_at");
  hash(object.execution_context_hash, "ExecutionContext.execution_context_hash");
  if (!hashesEqual(object.execution_context_hash as string, hashExecutionContext(object as unknown as ExecutionContext))) throw new Error("ExecutionContext hash does not match canonical content");
}

export function createApprovalRecord(input: ApprovalRecordInput): ApprovalRecord {
  const result = { ...input, approval_hash: stableHash(input) };
  assertApprovalRecord(result);
  return result;
}

export function hashApprovalRecord(value: ApprovalRecord): string {
  const { approval_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertApprovalRecord(value: unknown): asserts value is ApprovalRecord {
  const object = exactObject(value, "ApprovalRecord", [
    "version", "approval_id", "task_id", "task_package_hash", "route_binding_hash", "execution_context_hash", "policy_hash",
    "approved_scope_summary", "approved_at", "expires_at", "approval_hash",
  ]);
  literal(object.version, 1, "ApprovalRecord.version");
  identifier(object.approval_id, "ApprovalRecord.approval_id");
  identifier(object.task_id, "ApprovalRecord.task_id");
  hash(object.task_package_hash, "ApprovalRecord.task_package_hash");
  hash(object.route_binding_hash, "ApprovalRecord.route_binding_hash");
  hash(object.execution_context_hash, "ApprovalRecord.execution_context_hash");
  hash(object.policy_hash, "ApprovalRecord.policy_hash");
  nonEmptySafeText(object.approved_scope_summary, "ApprovalRecord.approved_scope_summary");
  timestamp(object.approved_at, "ApprovalRecord.approved_at");
  if (object.expires_at !== null) timestamp(object.expires_at, "ApprovalRecord.expires_at");
  hash(object.approval_hash, "ApprovalRecord.approval_hash");
  if (!hashesEqual(object.approval_hash as string, hashApprovalRecord(object as unknown as ApprovalRecord))) throw new Error("ApprovalRecord hash does not match canonical content");
}

export function assertAttemptRecord(value: unknown): asserts value is AttemptRecord {
  const object = exactObject(value, "AttemptRecord", [
    "version", "attempt_id", "run_id", "stage", "round", "request_fingerprint", "status", "prepared_at", "send_started_at",
    "completed_at", "failure_class", "provider_request_id", "response_model", "response_origin", "usage", "transport_rounds", "provider_reported_cost_usd", "estimated_list_cost_usd", "redacted_error",
  ]);
  literal(object.version, 1, "AttemptRecord.version");
  identifier(object.attempt_id, "AttemptRecord.attempt_id");
  identifier(object.run_id, "AttemptRecord.run_id");
  oneOf(object.stage, ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"], "AttemptRecord.stage");
  integer(object.round, "AttemptRecord.round", 0);
  hash(object.request_fingerprint, "AttemptRecord.request_fingerprint");
  oneOf(object.status, ["PREPARED", "SENDING", "SUCCEEDED", "FAILED_BEFORE_SEND", "AMBIGUOUS", "CANCELLED"], "AttemptRecord.status");
  timestamp(object.prepared_at, "AttemptRecord.prepared_at");
  for (const field of ["send_started_at", "completed_at"] as const) if (object[field] !== null) timestamp(object[field], `AttemptRecord.${field}`);
  oneOf(object.failure_class, ["none", "local_preflight", "provider_rejected", "transport_unknown", "response_invalid", "cancelled"], "AttemptRecord.failure_class");
  for (const field of ["provider_request_id", "response_model", "response_origin", "redacted_error"] as const) if (object[field] !== null) safeText(object[field], `AttemptRecord.${field}`);
  if (object.usage !== null) {
    const usage = exactObject(object.usage, "AttemptRecord.usage", ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"]);
    for (const field of ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"] as const) integer(usage[field], `AttemptRecord.usage.${field}`, 0);
  }
  if (!Array.isArray(object.transport_rounds)) throw new Error("AttemptRecord.transport_rounds must be an array");
  object.transport_rounds.forEach((round, index) => assertProviderTransportRound(round, `AttemptRecord.transport_rounds[${index}]`));
  for (const field of ["provider_reported_cost_usd", "estimated_list_cost_usd"] as const) if (object[field] !== null) finiteNumber(object[field], `AttemptRecord.${field}`, 0);
}

export function createEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const qualityPolicyCommandIds = [...input.quality_policy.command_ids]; Object.freeze(qualityPolicyCommandIds);
  const body: EvidenceBundleInput = {
    ...input,
    quality_policy: Object.freeze({ ...input.quality_policy, command_ids: qualityPolicyCommandIds }),
    attempt_ids: [...input.attempt_ids], route_evidence_ids: [...input.route_evidence_ids], attempt_summaries: input.attempt_summaries.map(item => Object.freeze({ ...item })), route_evidence_summaries: input.route_evidence_summaries.map(item => Object.freeze({ ...item })), transport_rounds: input.transport_rounds.map(item => Object.freeze({ ...item, usage: item.usage ? Object.freeze({ ...item.usage }) : null })), files_changed: [...input.files_changed],
    quality_gate_results: input.quality_gate_results.map(item => Object.freeze({ ...item })),
    tests_run: input.tests_run.map(item => Object.freeze({ ...item })),
    scope_violations: [...input.scope_violations], privacy_violations: [...input.privacy_violations],
    secret_scan_summary: Object.freeze({ ...input.secret_scan_summary }), usage_metrics: Object.freeze({ ...input.usage_metrics }),
    cost_metrics: Object.freeze({ ...input.cost_metrics }), pricing_catalog: input.pricing_catalog ? Object.freeze({ ...input.pricing_catalog, source_urls: Object.freeze([...input.pricing_catalog.source_urls]) as unknown as string[], time_bands: Object.freeze([...input.pricing_catalog.time_bands]) as unknown as typeof input.pricing_catalog.time_bands }) : null, stage_wall_clock_ms: Object.freeze({ ...input.stage_wall_clock_ms }), remaining_risks: [...input.remaining_risks], redaction_notes: [...input.redaction_notes],
  };
  const result = { ...body, bundle_hash: stableHash(body) };
  assertEvidenceBundle(result);
  for (const key of ["attempt_ids", "route_evidence_ids", "attempt_summaries", "route_evidence_summaries", "transport_rounds", "files_changed", "quality_gate_results", "tests_run", "scope_violations", "privacy_violations", "remaining_risks", "redaction_notes"] as const) Object.freeze(result[key]);
  return Object.freeze(result);
}

export function hashEvidenceBundle(value: EvidenceBundle): string {
  const { bundle_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertEvidenceBundle(value: unknown): asserts value is EvidenceBundle {
  const object = exactObject(value, "EvidenceBundle", [
    "version", "bundle_id", "run_id", "task_id", "contract_provenance", "task_package_hash", "route_binding_hash", "policy_hash", "quality_policy_hash", "quality_policy", "approval_hash", "execution_context_hash", "isolation_hash", "worktree_id", "base_commit", "worktree_head", "quality_request_hash", "quality_report_hash", "quality_passed", "quality_write_scope", "quality_command_ids", "post_artifact_snapshot_hash", "worktree_snapshot_hash",
    "attempt_ids", "route_evidence_ids", "attempt_summaries", "route_evidence_summaries", "transport_rounds", "files_changed", "diff_hash", "diff_reference", "quality_gate_results", "tests_run",
    "content_snapshot_hash", "scope_violations", "privacy_violations", "secret_scan_summary", "usage_metrics", "cost_metrics", "pricing_catalog", "wall_clock_time_ms", "stage_wall_clock_ms", "repair_count",
    "remaining_risks", "redaction_notes", "bundle_hash",
  ]);
  literal(object.version, 3, "EvidenceBundle.version");
  identifier(object.bundle_id, "EvidenceBundle.bundle_id"); identifier(object.run_id, "EvidenceBundle.run_id"); identifier(object.task_id, "EvidenceBundle.task_id");
  oneOf(object.contract_provenance, ["canonical", "legacy_bridge"], "EvidenceBundle.contract_provenance");
  hash(object.task_package_hash, "EvidenceBundle.task_package_hash"); hash(object.route_binding_hash, "EvidenceBundle.route_binding_hash"); hash(object.policy_hash, "EvidenceBundle.policy_hash"); hash(object.quality_policy_hash, "EvidenceBundle.quality_policy_hash"); hash(object.approval_hash, "EvidenceBundle.approval_hash"); hash(object.execution_context_hash, "EvidenceBundle.execution_context_hash"); hash(object.isolation_hash, "EvidenceBundle.isolation_hash"); identifier(object.worktree_id, "EvidenceBundle.worktree_id");
  const qualityPolicy = exactObject(object.quality_policy, "EvidenceBundle.quality_policy", ["version", "policy_id", "command_ids", "command_registry_hash", "max_diff_bytes", "max_file_bytes", "max_output_bytes", "max_wall_time_ms", "policy_hash"]);
  literal(qualityPolicy.version, 1, "EvidenceBundle.quality_policy.version"); identifier(qualityPolicy.policy_id, "EvidenceBundle.quality_policy.policy_id"); stringArray(qualityPolicy.command_ids, "EvidenceBundle.quality_policy.command_ids", false, false); hash(qualityPolicy.command_registry_hash, "EvidenceBundle.quality_policy.command_registry_hash"); hash(qualityPolicy.policy_hash, "EvidenceBundle.quality_policy.policy_hash");
  for (const [field, ceiling] of [["max_diff_bytes", 16 * 1024 * 1024], ["max_file_bytes", 4 * 1024 * 1024], ["max_output_bytes", 1024 * 1024], ["max_wall_time_ms", 30 * 60_000]] as const) { integer(qualityPolicy[field], `EvidenceBundle.quality_policy.${field}`, 1); if ((qualityPolicy[field] as number) > ceiling) throw new Error(`EvidenceBundle.quality_policy.${field} exceeds runtime ceiling`); }
  const { policy_hash: _qualityPolicyHash, ...qualityPolicyBody } = qualityPolicy;
  if (!hashesEqual(object.quality_policy_hash as string, qualityPolicy.policy_hash as string) || !hashesEqual(qualityPolicy.policy_hash as string, stableHash(qualityPolicyBody))) throw new Error("EvidenceBundle quality policy hash does not match its policy projection");
  commit(object.base_commit, "EvidenceBundle.base_commit"); commit(object.worktree_head, "EvidenceBundle.worktree_head");
  hash(object.quality_request_hash, "EvidenceBundle.quality_request_hash"); hash(object.quality_report_hash, "EvidenceBundle.quality_report_hash");
  if (typeof object.quality_passed !== "boolean") throw new Error("EvidenceBundle.quality_passed must be boolean");
  assertPathScope(object.quality_write_scope as string[], "EvidenceBundle.quality_write_scope");
  stringArray(object.quality_command_ids, "EvidenceBundle.quality_command_ids", false, false);
  const commandOrder = ["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"];
  if ((object.quality_command_ids as string[]).some(id => !commandOrder.includes(id)) || new Set(object.quality_command_ids as string[]).size !== (object.quality_command_ids as string[]).length || [...(object.quality_command_ids as string[])].sort((a, b) => commandOrder.indexOf(a) - commandOrder.indexOf(b)).join("\0") !== (object.quality_command_ids as string[]).join("\0")) throw new Error("EvidenceBundle.quality_command_ids are invalid");
  if ((qualityPolicy.command_ids as string[]).join("\0") !== (object.quality_command_ids as string[]).join("\0")) throw new Error("EvidenceBundle quality policy commands do not match quality command IDs");
  hash(object.post_artifact_snapshot_hash, "EvidenceBundle.post_artifact_snapshot_hash"); hash(object.worktree_snapshot_hash, "EvidenceBundle.worktree_snapshot_hash");
  stringArray(object.attempt_ids, "EvidenceBundle.attempt_ids", false, false); stringArray(object.route_evidence_ids, "EvidenceBundle.route_evidence_ids", false, false);
  (object.attempt_ids as unknown[]).forEach((entry, index) => identifier(entry, `EvidenceBundle.attempt_ids[${index}]`));
  (object.route_evidence_ids as unknown[]).forEach((entry, index) => identifier(entry, `EvidenceBundle.route_evidence_ids[${index}]`));
  if (!Array.isArray(object.attempt_summaries) || !Array.isArray(object.route_evidence_summaries)) throw new Error("EvidenceBundle evidence summaries must be arrays");
  object.attempt_summaries.forEach((entry, index) => { const item = exactObject(entry, `${index}.attempt_summary`, ["attempt_id", "stage", "status", "failure_class"]); identifier(item.attempt_id, `${index}.attempt_id`); oneOf(item.stage, ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"], `${index}.stage`); oneOf(item.status, ["PREPARED", "SENDING", "SUCCEEDED", "FAILED_BEFORE_SEND", "AMBIGUOUS", "CANCELLED"], `${index}.status`); oneOf(item.failure_class, ["none", "local_preflight", "provider_rejected", "transport_unknown", "response_invalid", "cancelled"], `${index}.failure_class`); });
  object.route_evidence_summaries.forEach((entry, index) => { const item = exactObject(entry, `${index}.route_summary`, ["evidence_id", "provider", "model", "verification_status", "request_id_present"]); identifier(item.evidence_id, `${index}.evidence_id`); safeText(item.provider, `${index}.provider`); safeText(item.model, `${index}.model`); oneOf(item.verification_status, ["route_tuple_verified_peer_unobserved", "incomplete", "local"], `${index}.verification_status`); if (typeof item.request_id_present !== "boolean") throw new Error(`${index}.request_id_present must be boolean`); });
  if (!Array.isArray(object.transport_rounds)) throw new Error("EvidenceBundle.transport_rounds must be an array");
  object.transport_rounds.forEach((entry, index) => assertProviderTransportRound(entry, `EvidenceBundle.transport_rounds[${index}]`));
  if (!Array.isArray(object.files_changed)) throw new Error("EvidenceBundle.files_changed must be an array");
  object.files_changed.forEach((path, index) => assertSafeRelativePath(path, `EvidenceBundle.files_changed[${index}]`));
  hash(object.content_snapshot_hash, "EvidenceBundle.content_snapshot_hash"); hash(object.diff_hash, "EvidenceBundle.diff_hash"); assertSafeRelativePath(object.diff_reference, "EvidenceBundle.diff_reference");
  if (!Array.isArray(object.quality_gate_results) || !Array.isArray(object.tests_run)) throw new Error("EvidenceBundle gate/test results must be arrays");
  object.quality_gate_results.forEach((entry, index) => {
    const gate = exactObject(entry, `EvidenceBundle.quality_gate_results[${index}]`, ["gate_id", "outcome", "evidence_hash", "summary"]);
    identifier(gate.gate_id, `${index}.gate_id`); oneOf(gate.outcome, ["passed", "failed", "not_applicable", "not_run"], `${index}.outcome`); hash(gate.evidence_hash, `${index}.evidence_hash`); safeText(gate.summary, `${index}.summary`);
  });
  object.tests_run.forEach((entry, index) => {
    const test = exactObject(entry, `EvidenceBundle.tests_run[${index}]`, ["command_id", "exit_code", "output_hash", "output_summary", "timed_out", "output_overflowed", "worktree_mutated"]);
    identifier(test.command_id, `${index}.command_id`); if (!Number.isInteger(test.exit_code)) throw new Error(`${index}.exit_code must be an integer`); hash(test.output_hash, `${index}.output_hash`); safeText(test.output_summary, `${index}.output_summary`);
    if (typeof test.timed_out !== "boolean" || typeof test.output_overflowed !== "boolean" || typeof test.worktree_mutated !== "boolean") throw new Error(`${index}.command diagnostics must use booleans`);
  });
  stringArray(object.scope_violations, "EvidenceBundle.scope_violations", false, true); stringArray(object.privacy_violations, "EvidenceBundle.privacy_violations", false, true);
  stringArray(object.remaining_risks, "EvidenceBundle.remaining_risks", false, true); stringArray(object.redaction_notes, "EvidenceBundle.redaction_notes", false, true);
  const secret = exactObject(object.secret_scan_summary, "EvidenceBundle.secret_scan_summary", ["outcome", "findings", "baseline_findings", "new_findings"]);
  oneOf(secret.outcome, ["passed", "failed", "not_run"], "EvidenceBundle.secret_scan_summary.outcome"); integer(secret.findings, "EvidenceBundle.secret_scan_summary.findings", 0); integer(secret.baseline_findings, "EvidenceBundle.secret_scan_summary.baseline_findings", 0); integer(secret.new_findings, "EvidenceBundle.secret_scan_summary.new_findings", 0);
  const usage = exactObject(object.usage_metrics, "EvidenceBundle.usage_metrics", ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"]);
  for (const field of ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"] as const) if (usage[field] !== null) integer(usage[field], `EvidenceBundle.usage_metrics.${field}`, 0);
  const cost = exactObject(object.cost_metrics, "EvidenceBundle.cost_metrics", ["provider_reported_usd", "estimated_list_usd", "invoice_usd", "chatgpt_quota"]);
  for (const field of ["provider_reported_usd", "estimated_list_usd", "invoice_usd", "chatgpt_quota"] as const) if (cost[field] !== null) finiteNumber(cost[field], `EvidenceBundle.cost_metrics.${field}`, 0);
  if (object.pricing_catalog !== null) { const pricing = exactObject(object.pricing_catalog, "EvidenceBundle.pricing_catalog", ["version", "hash", "currency", "source_urls", "retrieved_at", "effective_at", "time_bands"]); nonEmptyString(pricing.version, "pricing.version"); hash(pricing.hash, "pricing.hash"); literal(pricing.currency, "USD", "pricing.currency"); stringArray(pricing.source_urls, "pricing.source_urls", true, false); timestamp(pricing.retrieved_at, "pricing.retrieved_at"); timestamp(pricing.effective_at, "pricing.effective_at"); stringArray(pricing.time_bands, "pricing.time_bands", true, false); (pricing.time_bands as unknown[]).forEach((band, index) => oneOf(band, ["peak", "off_peak", "standard"], `pricing.time_bands[${index}]`)); }
  integer(object.wall_clock_time_ms, "EvidenceBundle.wall_clock_time_ms", 0);
  const stageWall = exactObject(object.stage_wall_clock_ms, "EvidenceBundle.stage_wall_clock_ms", ["plan", "execute", "gate", "review", "repair", "total"]); for (const field of ["plan", "execute", "gate", "review", "repair"] as const) if (stageWall[field] !== null) integer(stageWall[field], `stage_wall_clock_ms.${field}`, 0); integer(stageWall.total, "stage_wall_clock_ms.total", 0);
  integer(object.repair_count, "EvidenceBundle.repair_count", 0);
  uniqueStrings(object.attempt_ids as string[], "EvidenceBundle.attempt_ids"); uniqueStrings(object.route_evidence_ids as string[], "EvidenceBundle.route_evidence_ids");
  if ((object.attempt_summaries as Array<{ attempt_id: string }>).map(item => item.attempt_id).join("\0") !== (object.attempt_ids as string[]).join("\0")) throw new Error("EvidenceBundle attempt summaries do not match attempt IDs");
  if ((object.route_evidence_summaries as Array<{ evidence_id: string }>).map(item => item.evidence_id).join("\0") !== (object.route_evidence_ids as string[]).join("\0")) throw new Error("EvidenceBundle route summaries do not match route evidence IDs");
  uniqueStrings((object.transport_rounds as Array<{ round_id: string }>).map(item => item.round_id), "EvidenceBundle.transport_rounds");
  uniqueStrings(object.files_changed as string[], "EvidenceBundle.files_changed"); uniqueStrings((object.quality_gate_results as Array<{ gate_id: string }>).map(item => item.gate_id), "EvidenceBundle.quality_gate_results");
  if ([...(object.files_changed as string[])].sort().some((item, index) => item !== (object.files_changed as string[])[index])) throw new Error("EvidenceBundle.files_changed must be sorted");
  assertBundleTransportAndAccounting(object as unknown as EvidenceBundle);
  assertBundleQualitySemantics(object as unknown as EvidenceBundle, commandOrder);
  assertBundleQualityBindings(object as unknown as EvidenceBundle);
  hash(object.bundle_hash, "EvidenceBundle.bundle_hash");
  if (!hashesEqual(object.bundle_hash as string, hashEvidenceBundle(object as unknown as EvidenceBundle))) throw new Error("EvidenceBundle hash does not match canonical content");
}

function assertBundleTransportAndAccounting(bundle: EvidenceBundle): void {
  const modelStages = new Set(["EXECUTE", "REPAIR"]);
  const modelRounds = bundle.transport_rounds.filter(round => modelStages.has(round.stage));
  const succeededRounds = modelRounds.filter(round => round.outcome === "SUCCEEDED");
  const completeSucceededRounds = succeededRounds.filter(round => round.usage !== null && round.estimated_list_cost_usd !== null && round.pricing_catalog_version !== null && round.pricing_catalog_hash !== null && round.pricing_time_band !== null);
  for (const round of modelRounds) {
    if (round.outcome === "SUCCEEDED") {
      if (bundle.contract_provenance === "canonical" && !completeSucceededRounds.includes(round)) throw new Error("EvidenceBundle succeeded model round lacks complete usage or pricing evidence");
      if (round.response_model?.startsWith("deepseek-") && round.usage && round.usage.cache_hit_tokens + round.usage.cache_miss_tokens !== round.usage.input_tokens) throw new Error("EvidenceBundle DeepSeek cache usage is inconsistent");
    } else if (round.usage !== null || round.provider_reported_cost_usd !== null || round.estimated_list_cost_usd !== null) throw new Error("EvidenceBundle non-successful round cannot claim usage or cost");
  }
  if (bundle.contract_provenance === "canonical") {
    for (const summary of bundle.attempt_summaries.filter(item => modelStages.has(item.stage) && item.status === "SUCCEEDED")) if (!succeededRounds.some(round => round.stage === summary.stage)) throw new Error("EvidenceBundle canonical model attempt lacks transport-round evidence");
  }
  if (succeededRounds.length && completeSucceededRounds.length === succeededRounds.length) {
    const fields = ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"] as const;
    for (const field of fields) {
      const expected = succeededRounds.reduce((total, round) => total + round.usage![field], 0);
      if (bundle.usage_metrics[field] !== expected) throw new Error(`EvidenceBundle usage_metrics.${field} does not equal successful transport rounds`);
    }
    const estimated = roundUsd(succeededRounds.reduce((total, round) => total + round.estimated_list_cost_usd!, 0));
    if (bundle.cost_metrics.estimated_list_usd !== estimated) throw new Error("EvidenceBundle estimated list cost does not equal successful transport rounds");
    const providerReported = succeededRounds.every(round => round.provider_reported_cost_usd !== null) ? roundUsd(succeededRounds.reduce((total, round) => total + round.provider_reported_cost_usd!, 0)) : null;
    if (bundle.cost_metrics.provider_reported_usd !== providerReported) throw new Error("EvidenceBundle provider-reported cost does not preserve unavailable values");
    if (!bundle.pricing_catalog) throw new Error("EvidenceBundle priced rounds require pricing catalog evidence");
    for (const round of succeededRounds) if (round.pricing_catalog_version !== bundle.pricing_catalog.version || round.pricing_catalog_hash !== bundle.pricing_catalog.hash || !bundle.pricing_catalog.time_bands.includes(round.pricing_time_band!)) throw new Error("EvidenceBundle pricing catalog does not bind every successful round");
  } else if (bundle.contract_provenance === "canonical" && (bundle.cost_metrics.estimated_list_usd !== null || bundle.cost_metrics.provider_reported_usd !== null || bundle.pricing_catalog !== null)) throw new Error("EvidenceBundle cost evidence cannot exist without successful transport rounds");
  else if (succeededRounds.length && (bundle.cost_metrics.estimated_list_usd !== null || bundle.cost_metrics.provider_reported_usd !== null || bundle.pricing_catalog !== null)) throw new Error("EvidenceBundle incomplete legacy rounds must preserve unavailable cost as null");
  if (bundle.cost_metrics.invoice_usd !== null || bundle.cost_metrics.chatgpt_quota !== null) throw new Error("EvidenceBundle invoice and ChatGPT quota remain unavailable without separate authoritative provenance");
  for (const stage of ["EXECUTE", "REPAIR"] as const) {
    const sequence = modelRounds.filter(round => round.stage === stage).map(round => round.sequence);
    if (sequence.some((value, index) => value !== index)) throw new Error(`EvidenceBundle ${stage} transport sequence must be contiguous from zero`);
  }
  const stageTotal = [bundle.stage_wall_clock_ms.plan, bundle.stage_wall_clock_ms.execute, bundle.stage_wall_clock_ms.gate, bundle.stage_wall_clock_ms.review, bundle.stage_wall_clock_ms.repair].reduce<number>((total, value) => total + (value ?? 0), 0);
  if (bundle.stage_wall_clock_ms.total !== stageTotal || bundle.stage_wall_clock_ms.gate !== bundle.wall_clock_time_ms) throw new Error("EvidenceBundle stage wall-clock accounting is inconsistent");
}

function roundUsd(value: number): number { return Math.round(value * 1e12) / 1e12; }

function assertBundleQualityBindings(bundle: EvidenceBundle): void {
  const request = { run_id: bundle.run_id, task_id: bundle.task_id, base_commit: bundle.base_commit, plan_hash: bundle.task_package_hash, approval_hash: bundle.approval_hash, isolation_hash: bundle.isolation_hash, worktree_id: bundle.worktree_id, write_scope: [...bundle.quality_write_scope], command_ids: [...bundle.quality_command_ids], policy_hash: bundle.quality_policy_hash, effective_policy_hash: bundle.policy_hash, max_wall_time_ms: bundle.quality_policy.max_wall_time_ms };
  if (!hashesEqual(bundle.quality_request_hash, stableHash(request))) throw new Error("EvidenceBundle quality request hash does not match its request projection");
  const report = { version: 1, run_id: bundle.run_id, task_id: bundle.task_id, base_commit: bundle.base_commit, plan_hash: bundle.task_package_hash, approval_hash: bundle.approval_hash, isolation_hash: bundle.isolation_hash, worktree_id: bundle.worktree_id, policy_hash: bundle.quality_policy_hash, effective_policy_hash: bundle.policy_hash, max_wall_time_ms: bundle.quality_policy.max_wall_time_ms, request_hash: bundle.quality_request_hash, passed: bundle.quality_passed, worktree_head: bundle.worktree_head, files_changed: bundle.files_changed, content_snapshot_hash: bundle.content_snapshot_hash, post_artifact_snapshot_hash: bundle.post_artifact_snapshot_hash, worktree_snapshot_hash: bundle.worktree_snapshot_hash, diff_hash: bundle.diff_hash, diff_reference: bundle.diff_reference, quality_gate_results: bundle.quality_gate_results, tests_run: bundle.tests_run, scope_violations: bundle.scope_violations, privacy_violations: bundle.privacy_violations, secret_scan_summary: bundle.secret_scan_summary, wall_clock_time_ms: bundle.wall_clock_time_ms, redaction_notes: bundle.redaction_notes };
  if (!hashesEqual(bundle.quality_report_hash, stableHash(report))) throw new Error("EvidenceBundle quality report hash does not match its report projection");
  if (bundle.worktree_head !== bundle.base_commit || !bundle.diff_reference.startsWith(`evidence/${bundle.run_id}/`)) throw new Error("EvidenceBundle worktree or artifact reference is not bound to the approved run");
}

function assertBundleQualitySemantics(bundle: EvidenceBundle, commandOrder: string[]): void {
  const expected = ["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", ...commandOrder, "final_freeze", "evidence_artifact", "gate_budget"];
  if (bundle.quality_gate_results.map(item => item.gate_id).join("\0") !== expected.join("\0")) throw new Error("EvidenceBundle quality gate sequence is incomplete or reordered");
  const outcomes = new Map(bundle.quality_gate_results.map(item => [item.gate_id, item.outcome]));
  for (const id of ["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "final_freeze", "evidence_artifact", "gate_budget"]) if (!["passed", "failed"].includes(outcomes.get(id)!)) throw new Error(`EvidenceBundle safety gate ${id} is invalid`);
  const commandMutation = bundle.tests_run.some(item => item.worktree_mutated);
  const earlyFailed = ["base_identity", "preapply_scope"].some(id => outcomes.get(id) === "failed") || (outcomes.get("forbidden_paths") === "failed" && !commandMutation);
  for (const id of ["secret_scan", "diff_sanity"]) if (earlyFailed ? outcomes.get(id) !== "not_run" : !["passed", "failed"].includes(outcomes.get(id)!)) throw new Error(`EvidenceBundle ${id} state is invalid`);
  if (outcomes.get("secret_scan") !== bundle.secret_scan_summary.outcome) throw new Error("EvidenceBundle secret gate contradicts the secret summary");
  const expectedScopeViolations = bundle.files_changed.filter(item => !scopeAllows(item, bundle.quality_write_scope)).map(item => `outside_write_scope:${item}`);
  const scopeGatesValid = expectedScopeViolations.length === 0 ? outcomes.get("preapply_scope") === "passed" && outcomes.get("changed_files_scope") === "passed" : outcomes.get("changed_files_scope") === "failed" && ["passed", "failed"].includes(outcomes.get("preapply_scope")!);
  if (bundle.scope_violations.join("\0") !== expectedScopeViolations.join("\0") || !scopeGatesValid) throw new Error("EvidenceBundle scope gates contradict the approved write scope");
  const expectedForbidden = bundle.files_changed.filter(isForbiddenQualityPath).map(item => `forbidden_path:${item}`); const reportedForbidden = bundle.privacy_violations.filter(item => item.startsWith("forbidden_path:"));
  if (reportedForbidden.join("\0") !== expectedForbidden.join("\0")) throw new Error("EvidenceBundle forbidden-path evidence contradicts changed files");
  const nonSecretPrivacy = bundle.privacy_violations.filter(item => !item.startsWith("new_high_confidence_secret_findings:"));
  if ((nonSecretPrivacy.length === 0) !== (outcomes.get("forbidden_paths") === "passed")) throw new Error("EvidenceBundle forbidden-path gate contradicts privacy violations");
  let priorFailure = earlyFailed || outcomes.get("secret_scan") === "failed" || outcomes.get("diff_sanity") === "failed";
  let budgetStoppedCommand = false; let budgetScanFailed = priorFailure;
  for (const id of commandOrder) {
    if (!bundle.quality_command_ids.includes(id as EvidenceBundle["quality_command_ids"][number]) || budgetScanFailed) continue;
    const outcome = outcomes.get(id)!;
    if (outcome === "not_run") { budgetStoppedCommand = true; budgetScanFailed = true; }
    else if (outcome === "failed") budgetScanFailed = true;
  }
  const observed = new Set(bundle.tests_run.map(item => item.command_id));
  for (const id of commandOrder) {
    const outcome = outcomes.get(id)!; const test = bundle.tests_run.find(item => item.command_id === id);
    if (!bundle.quality_command_ids.includes(id as EvidenceBundle["quality_command_ids"][number])) { if (outcome !== "not_applicable" || test) throw new Error(`EvidenceBundle contains unapproved command evidence for ${id}`); }
    else if (priorFailure || (budgetStoppedCommand && outcome === "not_run")) { if (outcome !== "not_run" || test) throw new Error(`EvidenceBundle command ${id} should be not-run`); priorFailure = true; }
    else {
      if (!["passed", "failed"].includes(outcome) || !test) throw new Error(`EvidenceBundle command evidence is incomplete for ${id}`);
      if ((outcome === "passed") !== (test.exit_code === 0 && !test.timed_out && !test.output_overflowed && !test.worktree_mutated)) throw new Error(`EvidenceBundle command diagnostics contradict ${id}`);
      if (outcome === "failed") priorFailure = true;
    }
    observed.delete(id);
  }
  if (observed.size) throw new Error("EvidenceBundle contains unknown command evidence");
  const expectedBudgetOutcome = bundle.wall_clock_time_ms >= bundle.quality_policy.max_wall_time_ms || budgetStoppedCommand ? "failed" : "passed";
  if (outcomes.get("gate_budget") !== expectedBudgetOutcome) throw new Error("EvidenceBundle gate_budget contradicts the approved wall-time limit");
  if (outcomes.get("evidence_artifact") === "passed" && bundle.content_snapshot_hash !== bundle.post_artifact_snapshot_hash) throw new Error("EvidenceBundle artifact gate contradicts the post-artifact snapshot");
  const derived = bundle.quality_gate_results.every(item => item.outcome === "passed" || item.outcome === "not_applicable") && bundle.scope_violations.length === 0 && bundle.privacy_violations.length === 0 && bundle.secret_scan_summary.outcome === "passed" && bundle.secret_scan_summary.new_findings === 0;
  if (bundle.quality_passed !== derived) throw new Error("EvidenceBundle quality_passed contradicts quality evidence");
}

function uniqueStrings(values: string[], name: string): void { if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`); }
function scopeAllows(file: string, patterns: string[]): boolean { return patterns.some(pattern => { const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, ""); const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*"); return new RegExp(`^${escaped}$`).test(file); }); }

export function assertRequestBudget(value: unknown, name = "RequestBudget"): asserts value is RequestBudget {
  const object = exactObject(value, name, ["max_attempts", "max_provider_requests", "max_input_tokens", "max_output_tokens", "max_tool_calls", "max_request_wall_time_ms", "max_wall_time_ms", "max_estimated_cost_usd", "billing_mode"]);
  integer(object.max_attempts, `${name}.max_attempts`, 1);
  integer(object.max_provider_requests, `${name}.max_provider_requests`, 1);
  integer(object.max_input_tokens, `${name}.max_input_tokens`, 1);
  integer(object.max_output_tokens, `${name}.max_output_tokens`, 1);
  integer(object.max_tool_calls, `${name}.max_tool_calls`, 0);
  integer(object.max_request_wall_time_ms, `${name}.max_request_wall_time_ms`, 1);
  integer(object.max_wall_time_ms, `${name}.max_wall_time_ms`, 1);
  if ((object.max_request_wall_time_ms as number) > (object.max_wall_time_ms as number)) throw new Error(`${name}.max_request_wall_time_ms exceeds the total wall budget`);
  if (object.max_estimated_cost_usd !== null) finiteNumber(object.max_estimated_cost_usd, `${name}.max_estimated_cost_usd`, 0);
  oneOf(object.billing_mode, ["prepaid", "postpaid", "subscription", "unknown"], `${name}.billing_mode`);
}

export function assertEgressPolicy(value: unknown, name = "EgressPolicy"): asserts value is EgressPolicy {
  const preliminary = objectValue(value, name);
  if (preliminary.mode === "deny") {
    exactObject(value, name, ["mode"]);
    return;
  }
  const object = exactObject(value, name, ["mode", "providers", "paths", "content_hashes", "authorization_id", "authorized_by", "authorized_at", "expires_at"]);
  literal(object.mode, "allow", `${name}.mode`);
  stringArray(object.providers, `${name}.providers`, true, false);
  (object.providers as unknown[]).forEach((provider, index) => oneOf(provider, ["openai-codex", "deepseek", "local"], `${name}.providers[${index}]`));
  assertPathScope(object.paths, `${name}.paths`);
  stringArray(object.content_hashes, `${name}.content_hashes`, true, false); (object.content_hashes as unknown[]).forEach((item, index) => hash(item, `${name}.content_hashes[${index}]`));
  identifier(object.authorization_id, `${name}.authorization_id`); literal(object.authorized_by, "user", `${name}.authorized_by`);
  timestamp(object.authorized_at, `${name}.authorized_at`); if (object.expires_at !== null) timestamp(object.expires_at, `${name}.expires_at`);
}

export function assertPathScope(value: unknown, name = "scope"): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty scope`);
  const unique = new Set<string>();
  value.forEach((entry, index) => { assertSafeRelativePath(entry, `${name}[${index}]`); if (unique.has(entry as string)) throw new Error(`${name} contains duplicate path: ${entry}`); unique.add(entry as string); });
}

export function assertSafeRelativePath(value: unknown, name = "path"): asserts value is string {
  nonEmptyString(value, name);
  if (value !== value.trim() || value.includes("\\") || value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value) || value.startsWith("//") || value.includes(":")) throw new Error(`${name} must be a normalized relative path`);
  if (value.includes("//") || value.endsWith("/") || /(^|\/)\.\.?($|\/)/.test(value) || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} contains a dangerous path segment`);
}

export function containsSecretLikeText(value: string): boolean { return SECRET_LIKE.test(value); }
export { canonicalSerialize, stableHash };

function assertProviderTransportRound(value: unknown, name: string): void {
  const round = exactObject(value, name, ["round_id", "sequence", "stage", "request_id", "started_at", "completed_at", "wall_clock_time_ms", "response_model", "response_origin", "response_path", "http_status", "outcome", "failure_class", "usage", "cache_status", "provider_reported_cost_usd", "estimated_list_cost_usd", "pricing_catalog_version", "pricing_catalog_hash", "pricing_time_band"]);
  identifier(round.round_id, `${name}.round_id`); integer(round.sequence, `${name}.sequence`, 0);
  oneOf(round.stage, ["CLASSIFY", "PLAN", "TEXT_FRAME", "TEXT_EXPAND", "EXECUTE", "VALIDATE", "REVIEW", "VISUAL_REVIEW", "REPAIR", "SOL_DIAGNOSIS"], `${name}.stage`);
  for (const field of ["request_id", "response_model", "response_origin", "response_path", "failure_class", "pricing_catalog_version"] as const) if (round[field] !== null) safeText(round[field], `${name}.${field}`);
  timestamp(round.started_at, `${name}.started_at`); if (round.completed_at !== null) timestamp(round.completed_at, `${name}.completed_at`);
  if (round.wall_clock_time_ms !== null) integer(round.wall_clock_time_ms, `${name}.wall_clock_time_ms`, 0);
  if (round.http_status !== null) integer(round.http_status, `${name}.http_status`, 100);
  oneOf(round.outcome, ["SUCCEEDED", "REJECTED", "AMBIGUOUS"], `${name}.outcome`); oneOf(round.cache_status, ["hit", "miss", "mixed", "none", "unknown"], `${name}.cache_status`);
  if (round.usage !== null) { const usage = exactObject(round.usage, `${name}.usage`, ["input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens", "cache_write_tokens", "cache_hit_tokens", "cache_miss_tokens"]); for (const field of Object.keys(usage)) integer(usage[field], `${name}.usage.${field}`, 0); }
  for (const field of ["provider_reported_cost_usd", "estimated_list_cost_usd"] as const) if (round[field] !== null) finiteNumber(round[field], `${name}.${field}`, 0);
  if (round.pricing_catalog_hash !== null) hash(round.pricing_catalog_hash, `${name}.pricing_catalog_hash`);
  if (round.pricing_time_band !== null) oneOf(round.pricing_time_band, ["peak", "off_peak", "standard"], `${name}.pricing_time_band`);
  if (round.outcome === "AMBIGUOUS" && round.completed_at === null) throw new Error(`${name} ambiguous round must record local completion time`);
  if (round.outcome === "SUCCEEDED" && (!round.request_id || round.completed_at === null || round.wall_clock_time_ms === null)) throw new Error(`${name} succeeded round evidence is incomplete`);
}

function assertContextManifestEntry(value: unknown, name: string): asserts value is ContextManifestEntry {
  const object = exactObject(value, name, ["path", "kind", "selector", "content_hash", "source", "byte_length", "summary"]);
  assertSafeRelativePath(object.path, `${name}.path`); oneOf(object.kind, ["file", "snippet", "symbol"], `${name}.kind`);
  if (object.selector !== null) nonEmptySafeText(object.selector, `${name}.selector`);
  hash(object.content_hash, `${name}.content_hash`); oneOf(object.source, ["workspace", "synthetic_fixture", "user_provided"], `${name}.source`);
  integer(object.byte_length, `${name}.byte_length`, 0); safeText(object.summary, `${name}.summary`);
}

function exactObject(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  const object = objectValue(value, name); const allowed = new Set(keys); const actual = Object.keys(object);
  const unknown = actual.filter(key => !allowed.has(key)); const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(object, key));
  if (unknown.length) throw new Error(`${name} contains unknown field(s): ${unknown.join(", ")}`);
  if (missing.length) throw new Error(`${name} is missing field(s): ${missing.join(", ")}`);
  return object;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${name} must be a plain object`);
  return value as Record<string, unknown>;
}
function literal(value: unknown, expected: string | number, name: string): void { if (value !== expected) throw new Error(`${name} must equal ${expected}`); }
function oneOf(value: unknown, allowed: readonly string[], name: string): void { if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`); }
function nonEmptyString(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`); }
function safeText(value: unknown, name: string): asserts value is string { if (typeof value !== "string") throw new Error(`${name} must be a string`); if (SECRET_LIKE.test(value)) throw new Error(`${name} contains secret-like context`); }
function nonEmptySafeText(value: unknown, name: string): asserts value is string { nonEmptyString(value, name); safeText(value, name); }
function identifier(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${name} must be a safe identifier`); }
function nullableIdentifier(value: unknown, name: string): void { if (value !== null) identifier(value, name); }
function hash(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`); }
function commit(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${name} must be a Git object id`); }
function integer(value: unknown, name: string, minimum: number): void { if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`); }
function finiteNumber(value: unknown, name: string, minimum: number): void { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a finite number >= ${minimum}`); }
function timestamp(value: unknown, name: string): void { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an RFC 3339 UTC timestamp`); }
function stringArray(value: unknown, name: string, nonEmpty: boolean, secretSafe: boolean): asserts value is string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw new Error(`${name} must be ${nonEmpty ? "a non-empty" : "an"} array`);
  value.forEach((item, index) => secretSafe ? safeText(item, `${name}[${index}]`) : nonEmptyString(item, `${name}[${index}]`));
}
function endpointOrigin(value: unknown, provider: string, name: string): void {
  nonEmptyString(value, name);
  if (provider === "local") { if (!value.startsWith("local://")) throw new Error(`${name} must use local:// for a local binding`); return; }
  let parsed: URL; try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL origin`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin !== value || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${name} must be an exact HTTPS origin without credentials, path, query, or fragment`);
}
function endpointPath(value: unknown, name: string): void { nonEmptyString(value, name); if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#") || /\.\./.test(value)) throw new Error(`${name} must be an absolute API path without traversal, query, or fragment`); }
