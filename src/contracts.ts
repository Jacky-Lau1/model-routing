import { canonicalSerialize, hashesEqual, stableHash } from "./canonical.js";
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
  const result = { ...input, route_binding_hash: stableHash(input) };
  assertRouteBinding(result);
  return result;
}

export function hashRouteBinding(value: RouteBinding): string {
  const { route_binding_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertRouteBinding(value: unknown): asserts value is RouteBinding {
  const object = exactObject(value, "RouteBinding", [
    "version", "provider_id", "adapter_id", "model_id", "endpoint_origin", "endpoint_path", "wire_protocol", "auth_alias",
    "reasoning_mode", "reasoning_effort", "request_budget", "read_scope", "write_scope", "network_scope", "environment_scope",
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
    "completed_at", "failure_class", "provider_request_id", "response_model", "response_origin", "usage", "redacted_error",
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
    const usage = exactObject(object.usage, "AttemptRecord.usage", ["input_tokens", "output_tokens", "reasoning_tokens"]);
    integer(usage.input_tokens, "AttemptRecord.usage.input_tokens", 0);
    integer(usage.output_tokens, "AttemptRecord.usage.output_tokens", 0);
    integer(usage.reasoning_tokens, "AttemptRecord.usage.reasoning_tokens", 0);
  }
}

export function createEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const result = { ...input, bundle_hash: stableHash(input) };
  assertEvidenceBundle(result);
  return result;
}

export function hashEvidenceBundle(value: EvidenceBundle): string {
  const { bundle_hash: _hash, ...body } = value;
  return stableHash(body);
}

export function assertEvidenceBundle(value: unknown): asserts value is EvidenceBundle {
  const object = exactObject(value, "EvidenceBundle", [
    "version", "bundle_id", "run_id", "task_id", "task_package_hash", "route_binding_hash", "policy_hash", "base_commit", "worktree_head",
    "attempt_ids", "route_evidence_ids", "files_changed", "diff_hash", "diff_reference", "quality_gate_results", "tests_run",
    "scope_violations", "privacy_violations", "secret_scan_summary", "usage_metrics", "cost_metrics", "wall_clock_time_ms", "repair_count",
    "remaining_risks", "redaction_notes", "bundle_hash",
  ]);
  literal(object.version, 1, "EvidenceBundle.version");
  identifier(object.bundle_id, "EvidenceBundle.bundle_id"); identifier(object.run_id, "EvidenceBundle.run_id"); identifier(object.task_id, "EvidenceBundle.task_id");
  hash(object.task_package_hash, "EvidenceBundle.task_package_hash"); hash(object.route_binding_hash, "EvidenceBundle.route_binding_hash"); hash(object.policy_hash, "EvidenceBundle.policy_hash");
  commit(object.base_commit, "EvidenceBundle.base_commit"); commit(object.worktree_head, "EvidenceBundle.worktree_head");
  stringArray(object.attempt_ids, "EvidenceBundle.attempt_ids", false, false); stringArray(object.route_evidence_ids, "EvidenceBundle.route_evidence_ids", false, false);
  (object.attempt_ids as unknown[]).forEach((entry, index) => identifier(entry, `EvidenceBundle.attempt_ids[${index}]`));
  (object.route_evidence_ids as unknown[]).forEach((entry, index) => identifier(entry, `EvidenceBundle.route_evidence_ids[${index}]`));
  if (!Array.isArray(object.files_changed)) throw new Error("EvidenceBundle.files_changed must be an array");
  object.files_changed.forEach((path, index) => assertSafeRelativePath(path, `EvidenceBundle.files_changed[${index}]`));
  hash(object.diff_hash, "EvidenceBundle.diff_hash"); assertSafeRelativePath(object.diff_reference, "EvidenceBundle.diff_reference");
  if (!Array.isArray(object.quality_gate_results) || !Array.isArray(object.tests_run)) throw new Error("EvidenceBundle gate/test results must be arrays");
  object.quality_gate_results.forEach((entry, index) => {
    const gate = exactObject(entry, `EvidenceBundle.quality_gate_results[${index}]`, ["gate_id", "outcome", "evidence_hash"]);
    identifier(gate.gate_id, `${index}.gate_id`); oneOf(gate.outcome, ["passed", "failed", "not_applicable"], `${index}.outcome`); hash(gate.evidence_hash, `${index}.evidence_hash`);
  });
  object.tests_run.forEach((entry, index) => {
    const test = exactObject(entry, `EvidenceBundle.tests_run[${index}]`, ["command_id", "exit_code", "output_hash"]);
    identifier(test.command_id, `${index}.command_id`); if (!Number.isInteger(test.exit_code)) throw new Error(`${index}.exit_code must be an integer`); hash(test.output_hash, `${index}.output_hash`);
  });
  stringArray(object.scope_violations, "EvidenceBundle.scope_violations", false, true); stringArray(object.privacy_violations, "EvidenceBundle.privacy_violations", false, true);
  stringArray(object.remaining_risks, "EvidenceBundle.remaining_risks", false, true); stringArray(object.redaction_notes, "EvidenceBundle.redaction_notes", false, true);
  const secret = exactObject(object.secret_scan_summary, "EvidenceBundle.secret_scan_summary", ["outcome", "findings"]);
  oneOf(secret.outcome, ["passed", "failed", "not_run"], "EvidenceBundle.secret_scan_summary.outcome"); integer(secret.findings, "EvidenceBundle.secret_scan_summary.findings", 0);
  const usage = exactObject(object.usage_metrics, "EvidenceBundle.usage_metrics", ["input_tokens", "output_tokens", "reasoning_tokens"]);
  integer(usage.input_tokens, "EvidenceBundle.usage_metrics.input_tokens", 0); integer(usage.output_tokens, "EvidenceBundle.usage_metrics.output_tokens", 0); integer(usage.reasoning_tokens, "EvidenceBundle.usage_metrics.reasoning_tokens", 0);
  const cost = exactObject(object.cost_metrics, "EvidenceBundle.cost_metrics", ["provider_reported_usd", "estimated_list_usd", "invoice_usd", "chatgpt_quota"]);
  for (const field of ["provider_reported_usd", "estimated_list_usd", "invoice_usd", "chatgpt_quota"] as const) if (cost[field] !== null) finiteNumber(cost[field], `EvidenceBundle.cost_metrics.${field}`, 0);
  integer(object.wall_clock_time_ms, "EvidenceBundle.wall_clock_time_ms", 0); integer(object.repair_count, "EvidenceBundle.repair_count", 0);
  hash(object.bundle_hash, "EvidenceBundle.bundle_hash");
  if (!hashesEqual(object.bundle_hash as string, hashEvidenceBundle(object as unknown as EvidenceBundle))) throw new Error("EvidenceBundle hash does not match canonical content");
}

export function assertRequestBudget(value: unknown, name = "RequestBudget"): asserts value is RequestBudget {
  const object = exactObject(value, name, ["max_input_tokens", "max_output_tokens", "max_tool_calls", "max_wall_time_ms", "max_estimated_cost_usd", "billing_mode"]);
  integer(object.max_input_tokens, `${name}.max_input_tokens`, 1);
  integer(object.max_output_tokens, `${name}.max_output_tokens`, 1);
  integer(object.max_tool_calls, `${name}.max_tool_calls`, 0);
  integer(object.max_wall_time_ms, `${name}.max_wall_time_ms`, 1);
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
