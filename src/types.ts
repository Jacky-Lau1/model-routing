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
  max_input_tokens: number;
  max_output_tokens: number;
  max_tool_calls: number;
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
  redacted_error: string | null;
}

export interface EvidenceBundle {
  version: 1;
  bundle_id: string;
  run_id: string;
  task_id: string;
  task_package_hash: string;
  route_binding_hash: string;
  policy_hash: string;
  base_commit: string;
  worktree_head: string;
  attempt_ids: string[];
  route_evidence_ids: string[];
  files_changed: string[];
  diff_hash: string;
  diff_reference: string;
  quality_gate_results: Array<{ gate_id: string; outcome: "passed" | "failed" | "not_applicable"; evidence_hash: string }>;
  tests_run: Array<{ command_id: string; exit_code: number; output_hash: string }>;
  scope_violations: string[];
  privacy_violations: string[];
  secret_scan_summary: { outcome: "passed" | "failed" | "not_run"; findings: number };
  usage_metrics: { input_tokens: number; output_tokens: number; reasoning_tokens: number };
  cost_metrics: { provider_reported_usd: number | null; estimated_list_usd: number | null; invoice_usd: number | null; chatgpt_quota: number | null };
  wall_clock_time_ms: number;
  repair_count: number;
  remaining_risks: string[];
  redaction_notes: string[];
  bundle_hash: string;
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
  validationCommands: string[];
  route: RouteDecision;
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

export interface RouteEvidence {
  expectedProvider: Provider;
  actualProvider: string;
  expectedModel: string;
  actualModel: string;
  requestId: string;
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
}

export interface ProviderRequest {
  stage: Stage;
  route: RouteDecision;
  stablePrefix: string;
  projectSummary: string;
  dynamicInput: string;
  sensitivity: SensitivityClass;
  workingDirectory?: string;
  allowedFiles?: string[];
  executorCapabilities?: ExecutorCapabilityGrant;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface ProviderResponse {
  text: string;
  requestId: string;
  provider: string;
  model: string;
  usage: UsageMetrics;
  structuredPatches?: StructuredPatchProposal[];
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  invoke(request: ProviderRequest): Promise<ProviderResponse>;
}
