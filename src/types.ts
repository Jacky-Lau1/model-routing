export const WORKFLOW_VERSION = "1";

export type TaskKind = "code" | "text" | "visual";
export type Complexity = "normal" | "complex";
export type Risk = "normal" | "high";
export type SensitivityClass = "normal" | "private" | "restricted";
export type Provider = "openai-codex" | "deepseek" | "local";
export type OpenAIReasoning = "none" | "low" | "medium";
export type DeepSeekReasoning = "none" | "high";
export type ReasoningEffort = OpenAIReasoning | DeepSeekReasoning;

/** S1 canonical wire-contract primitives. */
export type DataClassification = "public" | "private" | "secret_restricted";
export type ContractProvider = "openai-codex" | "deepseek" | "local";
export type BillingMode = "prepaid" | "postpaid" | "subscription" | "unknown";
export type AttemptState = "PREPARED" | "SENDING" | "SUCCEEDED" | "FAILED_BEFORE_SEND" | "AMBIGUOUS" | "CANCELLED";
/** S1 wire-name compatibility. WorkflowState and AttemptState are independent state machines. */
export type AttemptStatus = AttemptState;
export type FailureClass = "none" | "local_preflight" | "provider_rejected" | "transport_unknown" | "response_invalid" | "cancelled";

export interface RequestBudget {
  max_attempts: number;
  max_provider_requests: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_tool_calls: number;
  max_request_wall_time_ms: number;
  max_wall_time_ms: number;
  max_estimated_cost_usd: number | null;
  billing_mode: BillingMode;
}

export interface EgressDenyPolicy {
  mode: "deny";
}

export interface EgressAllowPolicy {
  mode: "allow";
  providers: ContractProvider[];
  paths: string[];
  content_hashes: string[];
  authorization_id: string;
  authorized_by: "user";
  authorized_at: string;
  expires_at: string | null;
}

export type EgressPolicy = EgressDenyPolicy | EgressAllowPolicy;

export interface ProjectEgressAllowPolicy {
  mode: "allow";
  providers: ContractProvider[];
  paths: string[];
  content_hashes: string[];
}

export type ProjectEgressPolicy = EgressDenyPolicy | ProjectEgressAllowPolicy;

export interface ContextManifestEntry {
  path: string;
  kind: "file" | "snippet" | "symbol";
  selector: string | null;
  content_hash: string;
  source: "workspace" | "synthetic_fixture" | "user_provided";
  byte_length: number;
  summary: string;
}

export interface TaskPackage {
  version: 1;
  task_id: string;
  goal: string;
  background_summary: string;
  acceptance_criteria: string[];
  non_goals: string[];
  forbidden_actions: string[];
  read_scope: string[];
  write_scope: string[];
  relevant_interfaces: string[];
  context_manifest: ContextManifestEntry[];
  validation_requirements: string[];
  stop_conditions: string[];
  data_classification: DataClassification;
  egress_policy: EgressPolicy;
  request_budget: RequestBudget;
  created_at: string;
  task_package_hash: string;
}

export interface RouteBinding {
  version: 1;
  provider_id: ContractProvider;
  adapter_id: string;
  model_id: string;
  endpoint_origin: string;
  endpoint_path: string;
  wire_protocol: "chat_completions" | "responses" | "local";
  auth_alias: string | null;
  reasoning_mode: "disabled" | "enabled" | "local";
  reasoning_effort: ReasoningEffort;
  pricing_catalog_version: string | null;
  pricing_catalog_hash: string | null;
  request_budget: RequestBudget;
  read_scope: string[];
  write_scope: string[];
  network_scope: string[];
  environment_scope: string[];
  command_scope: string[];
  route_binding_hash: string;
}

export interface WorkspaceDirtyEvidence {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  content_hash: string | null;
}

export interface ExecutionContext {
  version: 1;
  run_id: string;
  task_id: string;
  base_commit: string;
  main_workspace_snapshot: string;
  main_workspace_dirty_evidence: WorkspaceDirtyEvidence[];
  worktree_id: string;
  worktree_base: string;
  policy_hash: string;
  task_package_hash: string;
  route_binding_hash: string;
  created_at: string;
  execution_context_hash: string;
}

export interface ApprovalRecord {
  version: 1;
  approval_id: string;
  task_id: string;
  task_package_hash: string;
  route_binding_hash: string;
  execution_context_hash: string;
  policy_hash: string;
  approved_scope_summary: string;
  approved_at: string;
  expires_at: string | null;
  approval_hash: string;
}

export interface AttemptUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
}

export type PricingTimeBand = "peak" | "off_peak" | "standard";
export type TransportRoundOutcome = "SUCCEEDED" | "REJECTED" | "AMBIGUOUS";

export interface ProviderTransportRound {
  round_id: string;
  sequence: number;
  stage: Stage;
  request_id: string | null;
  started_at: string;
  completed_at: string | null;
  wall_clock_time_ms: number | null;
  response_model: string | null;
  response_origin: string | null;
  response_path: string | null;
  http_status: number | null;
  outcome: TransportRoundOutcome;
  failure_class: string | null;
  usage: AttemptUsage | null;
  cache_status: "hit" | "miss" | "mixed" | "none" | "unknown";
  provider_reported_cost_usd: number | null;
  estimated_list_cost_usd: number | null;
  pricing_catalog_version: string | null;
  pricing_catalog_hash: string | null;
  pricing_time_band: PricingTimeBand | null;
}

export interface AttemptRecord {
  version: 1;
  attempt_id: string;
  run_id: string;
  stage: Stage;
  round: number;
  request_fingerprint: string;
  status: AttemptStatus;
  prepared_at: string;
  send_started_at: string | null;
  completed_at: string | null;
  failure_class: FailureClass;
  provider_request_id: string | null;
  response_model: string | null;
  response_origin: string | null;
  usage: AttemptUsage | null;
  transport_rounds: ProviderTransportRound[];
  provider_reported_cost_usd: number | null;
  estimated_list_cost_usd: number | null;
  redacted_error: string | null;
}

export interface EvidenceBundle {
  version: 4;
  bundle_id: string;
  run_id: string;
  task_id: string;
  contract_provenance: "canonical" | "legacy_bridge";
  task_package_hash: string;
  route_binding_hash: string;
  policy_hash: string;
  quality_policy_hash: string;
  quality_approval_boundary_hash: string;
  quality_catalog_hash: string;
  fixture_hash: string;
  hidden_root_hash: string | null;
  acceptance_results: QualityAcceptanceProjection;
  hidden_acceptance_result: HiddenAcceptanceResult | null;
  quality_policy: QualityGatePolicy;
  approval_hash: string;
  execution_context_hash: string;
  isolation_hash: string;
  worktree_id: string;
  base_commit: string;
  worktree_head: string;
  quality_request_hash: string;
  quality_report_hash: string;
  quality_passed: boolean;
  quality_write_scope: string[];
  quality_command_ids: QualityCommandId[];
  post_artifact_snapshot_hash: string;
  worktree_snapshot_hash: string;
  attempt_ids: string[];
  route_evidence_ids: string[];
  attempt_summaries: Array<{ attempt_id: string; stage: Stage; status: AttemptStatus; failure_class: FailureClass }>;
  route_evidence_summaries: Array<{ evidence_id: string; provider: string; model: string; verification_status: ProviderRouteEvidence["verificationStatus"]; request_id_present: boolean }>;
  transport_rounds: ProviderTransportRound[];
  files_changed: string[];
  content_snapshot_hash: string;
  diff_hash: string;
  diff_reference: string;
  quality_gate_results: Array<{ gate_id: string; outcome: "passed" | "failed" | "not_applicable" | "not_run"; evidence_hash: string; summary: string }>;
  tests_run: Array<{ command_id: string; exit_code: number; output_hash: string; output_summary: string; timed_out: boolean; output_overflowed: boolean; worktree_mutated: boolean }>;
  scope_violations: string[];
  privacy_violations: string[];
  secret_scan_summary: { outcome: "passed" | "failed" | "not_run"; findings: number; baseline_findings: number; new_findings: number };
  usage_metrics: { input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; cached_input_tokens: number | null; cache_write_tokens: number | null; cache_hit_tokens: number | null; cache_miss_tokens: number | null };
  cost_metrics: { provider_reported_usd: number | null; estimated_list_usd: number | null; invoice_usd: number | null; chatgpt_quota: number | null };
  pricing_catalog: { version: string; hash: string; currency: "USD"; source_urls: string[]; retrieved_at: string; effective_at: string; time_bands: PricingTimeBand[] } | null;
  wall_clock_time_ms: number;
  stage_wall_clock_ms: { plan: number | null; execute: number | null; gate: number | null; review: number | null; repair: number | null; total: number };
  repair_count: number;
  remaining_risks: string[];
  redaction_notes: string[];
  bundle_hash: string;
}

export type QualityCommandId = "format_check" | "lint" | "typecheck" | "unit_tests" | "build" | "project_acceptance";

export interface QualityGatePolicy {
  version: 1;
  policy_id: string;
  command_ids: QualityCommandId[];
  command_registry_hash: string;
  max_diff_bytes: number;
  max_file_bytes: number;
  max_output_bytes: number;
  max_wall_time_ms: number;
  policy_hash: string;
}

export interface QualityCommandSpec {
  command_id: QualityCommandId;
  executable: string;
  args: string[];
  timeout_ms: number;
}

export interface QualityGateRequest {
  run_id: string;
  task_id: string;
  base_commit: string;
  plan_hash: string;
  approval_hash: string;
  isolation_hash: string;
  worktree_id: string;
  write_scope: string[];
  command_ids: QualityCommandId[];
  policy_hash: string;
  catalog_hash: string;
  fixture_hash: string;
  hidden_root_hash: string | null;
  effective_policy_hash: string;
  max_wall_time_ms: number;
}

export interface QualityGateReport {
  version: 1;
  run_id: string;
  task_id: string;
  base_commit: string;
  plan_hash: string;
  approval_hash: string;
  isolation_hash: string;
  worktree_id: string;
  policy_hash: string;
  approval_boundary_hash: string;
  catalog_hash: string;
  fixture_hash: string;
  hidden_root_hash: string | null;
  effective_policy_hash: string;
  max_wall_time_ms: number;
  request_hash: string;
  passed: boolean;
  worktree_head: string;
  files_changed: string[];
  content_snapshot_hash: string;
  post_artifact_snapshot_hash: string;
  worktree_snapshot_hash: string;
  diff_hash: string;
  diff_reference: string;
  quality_gate_results: EvidenceBundle["quality_gate_results"];
  tests_run: EvidenceBundle["tests_run"];
  scope_violations: string[];
  privacy_violations: string[];
  secret_scan_summary: EvidenceBundle["secret_scan_summary"];
  wall_clock_time_ms: number;
  redaction_notes: string[];
  hidden_acceptance_result: HiddenAcceptanceResult | null;
  report_hash: string;
}

export interface AcceptanceCounts { passed: number; failed: number; not_run: number }

export interface HiddenAcceptanceResult {
  version: 1;
  command_id: "project_acceptance";
  approval_boundary_hash: string;
  fixture_hash: string;
  base_commit: string;
  counts: AcceptanceCounts;
  passed: boolean;
  exit_code: number;
  timed_out: boolean;
  output_overflowed: boolean;
  hidden_root_unchanged: boolean;
  diagnostic_hash: string;
  output_summary: string;
  redaction_notes: string[];
  result_hash: string;
}

export interface QualityAcceptanceProjection {
  version: 1;
  approval_boundary_hash: string;
  quality_report_hash: string;
  fixture_hash: string;
  base_commit: string;
  visible_tests: AcceptanceCounts;
  hidden_tests: AcceptanceCounts;
  regression: boolean;
  scope_passed: boolean;
  secret_passed: boolean;
  diff_passed: boolean;
  freeze_passed: boolean;
  result_hash: string;
}

export interface UserPolicy {
  version: 1;
  policy_id: string;
  egress_policy: EgressPolicy;
  read_scope: string[];
  write_scope: string[];
  budget_ceiling: RequestBudget;
  policy_hash: string;
}

export interface ProjectPolicy {
  version: 1;
  policy_id: string;
  egress_policy: ProjectEgressPolicy;
  read_scope: string[];
  write_scope: string[];
  budget_ceiling: RequestBudget;
  policy_hash: string;
}

export interface EffectivePolicy {
  version: 1;
  user_policy_hash: string;
  project_policy_hash: string;
  egress_policy: EgressPolicy;
  read_scope: string[];
  write_scope: string[];
  budget_ceiling: RequestBudget;
  policy_hash: string;
}

export type Stage =
  | "CLASSIFY" | "PLAN" | "TEXT_FRAME" | "TEXT_EXPAND" | "EXECUTE"
  | "VALIDATE" | "REVIEW" | "VISUAL_REVIEW" | "REPAIR" | "SOL_DIAGNOSIS";

/** Orchestrator-first workflow state. Provider-call lifecycle belongs to AttemptState. */
export type WorkflowState =
  | "CREATED" | "PLANNING" | "AWAITING_APPROVAL" | "APPROVED"
  | "WORKTREE_READY" | "EXECUTING" | "VALIDATING" | "REVIEW_PENDING"
  | "REPAIR_REQUIRED" | "APPLY_PENDING" | "PASSED" | "BLOCKED" | "ABORTED";

/** @deprecated Phase 0 workflow retained until the S7 core/CLI migration. */
export type LegacyWorkflowState =
  | "INTAKE" | "PROFILED" | "PLANNING" | "WAITING_APPROVAL"
  | "EXECUTING" | "VALIDATING" | "REVIEWING" | "REPAIRING"
  | "SOL_DIAGNOSIS" | "WAITING_REAPPROVAL" | "COMPLETED" | "BLOCKED" | "ABORTED";

export interface WorkflowRecord {
  version: 1;
  run_id: string;
  task_id: string;
  approval_hash: string;
  state: WorkflowState;
  attempt_ids: string[];
  active_attempt_id: string | null;
  blocked_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface TaskProfile {
  kind: TaskKind;
  complexity: Complexity;
  risk: Risk;
  sensitivity: SensitivityClass;
  hasVisualInput: boolean;
  signals: string[];
}

export interface ReasoningProfile {
  model: string;
  provider: Provider;
  effort: ReasoningEffort;
  maxOutputTokens: number;
  maxToolTurns: number;
  timeoutMs: number;
  maxRepairs: number;
  mayEscalate: boolean;
}

export interface RouteDecision extends ReasoningProfile {
  stage: Stage;
  reason: string;
  requiresApproval: boolean;
  promptCacheKey?: string;
}

export interface PersistenceProfile {
  ephemeral: boolean;
  retentionDays: number;
  checkpointStates: LegacyWorkflowState[];
  maxMetadataBytes: number;
  persistEventStream: false;
}

export interface PlanPacket {
  version: 1;
  taskId: string;
  objective: string;
  nonGoals: string[];
  steps: string[];
  readFiles: string[];
  writeFiles: string[];
  dataClassification: DataClassification;
  /** @deprecated S4 derives this compatibility field from writeFiles. */
  allowedFiles: string[];
  constraints: string[];
  acceptance: string[];
  validationCommands: QualityCommandId[];
  qualityPolicyHash: string;
  route: RouteDecision;
  routeBinding: RouteBinding;
}

/** @deprecated Phase 0 compatibility record. New code uses ApprovalRecord. */
export interface LegacyApprovalRecord {
  taskId: string;
  planHash: string;
  approvedAt: string;
  routeFingerprint: string;
  isolationHash: string;
}

/**
 * Legacy S4 capability grant used by the Direct DeepSeek adapter until the S7
 * core migration passes TaskPackage/RouteBinding objects end to end. These
 * fields deliberately mirror the frozen S1 read/write boundaries without
 * changing any S1 wire contract.
 */
export interface ExecutorManifestEntry {
  path: string;
  contentHash: string;
  byteLength: number;
  dataClassification: DataClassification;
}

export interface ExecutorCapabilityGrant {
  readManifest: ExecutorManifestEntry[];
  writeScope: string[];
  maxFileBytes: number;
}

export interface StructuredPatchProposal {
  path: string;
  preimageHash: string | null;
  replacement: string;
}

export interface CacheMetrics {
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface UsageMetrics extends CacheMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface UsageAvailability {
  inputTokens: boolean;
  outputTokens: boolean;
  reasoningTokens: boolean;
  cacheHitTokens: boolean;
  cacheMissTokens: boolean;
}

export interface ProviderBudgetState {
  attempts_used: number;
  provider_requests_used: number;
  input_tokens_used: number;
  output_tokens_used: number;
  wall_clock_time_ms_used: number;
  estimated_list_cost_usd: number;
}

export type PilotArm = "gpt_only" | "hybrid";
export type HumanInterventionType = "manual_code_change" | "scope_change" | "provider_change" | "model_change" | "budget_change" | "egress_change" | "manual_resend" | "gate_skip";
export type PilotRecommendation = "expand" | "simplify" | "stop";

export interface PilotRunRecord {
  version: 1;
  task_id: string;
  arm: PilotArm;
  run_id: string;
  base_fixture_hash: string;
  task_package_hash: string;
  route_binding_hash: string;
  approval_hash: string;
  execution_context_hash: string;
  evidence_bundle_hash: string;
  provider: string;
  model: string | null;
  endpoint_origin: string | null;
  endpoint_path: string | null;
  auth_alias: string | null;
  first_pass_success: boolean;
  final_acceptance: boolean;
  visible_tests: { passed: number; failed: number; not_run: number };
  hidden_tests: { passed: number; failed: number; not_run: number };
  regression: boolean;
  hard_stop: boolean;
  repair_count: number;
  human_interventions: Array<{ type: HumanInterventionType; summary: string }>;
  automated_success: boolean;
  violations: { secret: number; scope: number; privacy: number; routing: number; main_workspace_pollution: number; unexplained_duplicate_requests: number };
  ambiguity: { attempts: number; total_attempts: number; attempt_rate: number; requests: number; total_requests: number; request_rate: number };
  usage_by_stage_model: Array<{ stage: Stage; provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; cache_hit_tokens: number | null; cache_miss_tokens: number | null }>;
  provider_http_request_count: number | null;
  wall_clock_ms: { plan: number | null; execute: number | null; gate: number | null; review: number | null; repair: number | null; total: number };
  costs: { provider_reported_usd: number | null; estimated_list_usd: number | null; invoice_usd: number | null; chatgpt_quota: number | null };
  pricing_catalog: { version: string; hash: string; source_urls: string[]; time_bands: PricingTimeBand[] } | null;
  core_metrics_unavailable: string[];
  evidence_sufficient: boolean;
  remaining_risks: string[];
  recommendation: PilotRecommendation;
  created_at: string;
  record_hash: string;
}

export interface PilotPairReport {
  version: 1;
  task_id: string;
  gpt_only_run_hash: string;
  hybrid_run_hash: string;
  same_base_fixture: boolean;
  same_scope: boolean;
  same_hidden_gate: boolean;
  same_wall_budget: boolean;
  same_acceptance_criteria: boolean;
  hybrid_acceptance_not_lower: boolean;
  cost_reduction_percent: number | null;
  hybrid_latency_increase_percent: number | null;
  expansion_blockers: string[];
  recommendation: PilotRecommendation;
  created_at: string;
  report_hash: string;
}

export type RequestIdSource = "body" | "header" | "body_and_header" | "cli_event" | "local" | "not_available";

export interface RouteTransportObservation {
  targetUrl: string;
  responseUrl: string | null;
  actualOrigin: string | null;
  actualPath: string | null;
  actualModel: string | null;
  requestId: string | null;
  requestIdSource: RequestIdSource;
  bodyResponseId: string | null;
  headerRequestId: string | null;
  headerRequestIdName: "x-request-id" | "x-ds-request-id" | "request-id" | null;
  status: number | null;
  redirected: boolean | null;
  routeTupleVerified: boolean;
  failureReason: string | null;
}

export interface ProviderRouteEvidence {
  routeBindingHash: string | null;
  adapterId: string;
  expectedProvider: Provider;
  expectedModel: string;
  expectedOrigin: string | null;
  expectedPath: string | null;
  actualOrigin: string | null;
  actualPath: string | null;
  actualModel: string | null;
  wireProtocol: RouteBinding["wire_protocol"] | null;
  authAlias: string | null;
  requestId: string | null;
  requestIds: string[];
  bodyResponseIds: Array<string | null>;
  headerRequestIds: Array<string | null>;
  requestIdSource: RequestIdSource;
  redirectPolicy: "manual_error" | "not_observable" | "local";
  redirected: boolean | null;
  routeTupleVerified: boolean;
  evidenceComplete: boolean;
  unverifiedReasons: string[];
  verificationStatus: "route_tuple_verified_peer_unobserved" | "incomplete" | "local";
  observations: RouteTransportObservation[];
  peerVerification: "not_observable" | "local";
  proxyVerification: "not_observable" | "local";
}

export interface RouteEvidence extends ProviderRouteEvidence {
  expectedProvider: Provider;
  actualProvider: string;
  verified: boolean;
  usage: UsageMetrics;
  normalizedEquivalentUsd?: number;
  pricingCatalogVersion?: string;
}

export interface RunState {
  version: 1;
  taskId: string;
  state: LegacyWorkflowState;
  profile: TaskProfile;
  plan?: PlanPacket;
  approval?: LegacyApprovalRecord;
  attempts: number;
  repairAttempts: number;
  updatedAt: string;
  createdAt: string;
  lastError?: string;
  result?: string;
  routeEvidence?: RouteEvidence[];
  usage?: UsageMetrics;
  normalizedEquivalentUsd?: number;
  usageAvailability?: UsageAvailability;
  evidenceBundleHash?: string;
  evidenceBundleReference?: string;
}

export interface ProviderRequest {
  stage: Stage;
  contractProvenance?: "canonical" | "legacy_bridge";
  route: RouteDecision;
  stablePrefix: string;
  projectSummary: string;
  dynamicInput: string;
  sensitivity: SensitivityClass;
  workingDirectory?: string;
  allowedFiles?: string[];
  executorCapabilities?: ExecutorCapabilityGrant;
  routeBinding?: RouteBinding;
  qualityGate?: QualityGateRequest;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  budgetState?: ProviderBudgetState;
}

export interface ProviderResponse {
  text: string;
  requestId: string | null;
  provider: string;
  model: string;
  usage: UsageMetrics;
  usageAvailability?: UsageAvailability;
  providerReportedCostUsd?: number | null;
  estimatedListCostUsd?: number | null;
  transportRounds?: ProviderTransportRound[];
  routeEvidence?: ProviderRouteEvidence;
  structuredPatches?: StructuredPatchProposal[];
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  readonly adapterId: string;
  preflight?(request: ProviderRequest): void | Promise<void>;
  invoke(request: ProviderRequest): Promise<ProviderResponse>;
}
