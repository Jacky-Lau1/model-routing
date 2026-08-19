export const WORKFLOW_VERSION = "1";

export type TaskKind = "code" | "text" | "visual";
export type Complexity = "normal" | "complex";
export type Risk = "normal" | "high";
export type SensitivityClass = "normal" | "private" | "restricted";
export type Provider = "openai-codex" | "deepseek" | "local";
export type OpenAIReasoning = "none" | "low" | "medium";
export type DeepSeekReasoning = "none" | "high";
export type ReasoningEffort = OpenAIReasoning | DeepSeekReasoning;

export type Stage =
  | "CLASSIFY" | "PLAN" | "TEXT_FRAME" | "TEXT_EXPAND" | "EXECUTE"
  | "VALIDATE" | "REVIEW" | "VISUAL_REVIEW" | "REPAIR" | "SOL_DIAGNOSIS";

export type WorkflowState =
  | "INTAKE" | "PROFILED" | "PLANNING" | "WAITING_APPROVAL"
  | "EXECUTING" | "VALIDATING" | "REVIEWING" | "REPAIRING"
  | "SOL_DIAGNOSIS" | "WAITING_REAPPROVAL" | "COMPLETED" | "BLOCKED" | "ABORTED";

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
  checkpointStates: WorkflowState[];
  maxMetadataBytes: number;
  persistEventStream: false;
}

export interface PlanPacket {
  version: 1;
  taskId: string;
  objective: string;
  nonGoals: string[];
  steps: string[];
  allowedFiles: string[];
  constraints: string[];
  acceptance: string[];
  validationCommands: string[];
  route: RouteDecision;
}

export interface ApprovalRecord {
  taskId: string;
  planHash: string;
  approvedAt: string;
  routeFingerprint: string;
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
  state: WorkflowState;
  profile: TaskProfile;
  plan?: PlanPacket;
  approval?: ApprovalRecord;
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
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface ProviderResponse {
  text: string;
  requestId: string;
  provider: string;
  model: string;
  usage: UsageMetrics;
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  invoke(request: ProviderRequest): Promise<ProviderResponse>;
}
