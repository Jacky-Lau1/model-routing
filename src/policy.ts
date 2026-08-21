import { createRouteBinding, assertEgressPolicy, assertPathScope, assertRequestBudget, assertTaskPackage, stableHash } from "./contracts.js";
import { hashesEqual } from "./canonical.js";
import { isAllowedPath } from "./scope-guard.js";
import { WORKFLOW_VERSION, type EffectivePolicy, type PersistenceProfile, type ProjectPolicy, type RequestBudget, type RouteBinding, type RouteDecision, type SensitivityClass, type Stage, type TaskPackage, type TaskProfile, type UserPolicy } from "./types.js";

const OPENAI = { provider: "openai-codex" as const, maxRepairs: 0 };
const DEEPSEEK = { provider: "deepseek" as const, maxRepairs: 1 };

export const DEFAULT_PERSISTENCE: PersistenceProfile = {
  ephemeral: true,
  retentionDays: 7,
  checkpointStates: ["WAITING_APPROVAL", "VALIDATING", "REVIEWING", "COMPLETED", "BLOCKED", "ABORTED"],
  maxMetadataBytes: 10 * 1024 * 1024,
  persistEventStream: false,
};

function cacheKey(stage: Stage, sensitivity: SensitivityClass): string | undefined {
  return sensitivity === "normal" ? `router-v${WORKFLOW_VERSION}:${stage}:normal` : undefined;
}

export function decideRoute(stage: Stage, profile: TaskProfile): RouteDecision {
  const approval = stage === "EXECUTE" || stage === "TEXT_EXPAND" || stage === "REPAIR";
  const common = { stage, requiresApproval: approval, promptCacheKey: cacheKey(stage, profile.sensitivity) };
  if (stage === "CLASSIFY") return { ...common, ...OPENAI, model: "gpt-5.6-terra", effort: "low", maxOutputTokens: 2_000, maxToolTurns: 0, timeoutMs: 45_000, mayEscalate: false, reason: "bounded structured classification" };
  if (stage === "SOL_DIAGNOSIS" || (stage === "PLAN" && profile.risk === "high")) return { ...common, ...OPENAI, model: "gpt-5.6-sol", effort: "medium", maxOutputTokens: 12_000, maxToolTurns: 4, timeoutMs: 180_000, mayEscalate: false, reason: stage === "SOL_DIAGNOSIS" ? "second failure diagnosis" : "high-risk planning" };
  if (stage === "PLAN") return { ...common, ...OPENAI, model: "gpt-5.6-terra", effort: profile.complexity === "complex" ? "medium" : "low", maxOutputTokens: profile.complexity === "complex" ? 10_000 : 7_000, maxToolTurns: 4, timeoutMs: 120_000, mayEscalate: true, reason: profile.complexity === "complex" ? "complex project planning" : "normal project planning" };
  if (stage === "TEXT_FRAME") return { ...common, ...OPENAI, model: "gpt-5.6-terra", effort: profile.complexity === "complex" ? "medium" : "low", maxOutputTokens: 6_000, maxToolTurns: 1, timeoutMs: 90_000, mayEscalate: false, reason: "text structure and acceptance framing" };
  if (stage === "TEXT_EXPAND" && profile.sensitivity !== "normal") return sensitiveOpenAI(common, profile, "sensitive text expansion");
  if (stage === "TEXT_EXPAND") return deepSeek(common, profile, "deepseek-v4-flash", "none", "approved text expansion without reasoning");
  if (stage === "EXECUTE" || stage === "REPAIR") {
    if (profile.sensitivity !== "normal") return sensitiveOpenAI(common, profile, stage === "REPAIR" ? "sensitive repair" : "sensitive code execution");
    const complex = profile.complexity === "complex";
    return deepSeek(common, profile, complex ? "deepseek-v4-pro" : "deepseek-v4-flash", complex ? "high" : "none", stage === "REPAIR" ? "single approved repair" : "bounded code execution");
  }
  if (stage === "VALIDATE") return { ...common, provider: "local", model: "local-quality-gates", effort: "none", maxOutputTokens: 0, maxToolTurns: 0, timeoutMs: 600_000, maxRepairs: 0, mayEscalate: false, reason: "deterministic local validation" };
  const visual = stage === "VISUAL_REVIEW" || profile.kind === "visual" || profile.hasVisualInput;
  return { ...common, ...OPENAI, model: "gpt-5.6-terra", effort: visual || profile.complexity === "complex" ? "medium" : "low", maxOutputTokens: 7_000, maxToolTurns: 2, timeoutMs: 120_000, mayEscalate: false, reason: visual ? "visual evidence review" : "final acceptance review" };
}

function sensitiveOpenAI(common: Pick<RouteDecision, "stage" | "requiresApproval" | "promptCacheKey">, profile: TaskProfile, reason: string): RouteDecision {
  return { ...common, ...OPENAI, promptCacheKey: undefined, model: "gpt-5.6-terra", effort: profile.complexity === "complex" ? "medium" : "low", maxOutputTokens: 12_000, maxToolTurns: 12, timeoutMs: 420_000, mayEscalate: false, reason };
}

function deepSeek(common: Pick<RouteDecision, "stage" | "requiresApproval" | "promptCacheKey">, profile: TaskProfile, model: string, effort: "none" | "high", reason: string): RouteDecision {
  if (profile.sensitivity !== "normal") throw new Error(`DeepSeek route denied for ${profile.sensitivity} task`);
  return { ...common, ...DEEPSEEK, model, effort, maxOutputTokens: model.endsWith("pro") ? 16_000 : 10_000, maxToolTurns: model.endsWith("pro") ? 16 : 10, timeoutMs: model.endsWith("pro") ? 600_000 : 360_000, mayEscalate: model.endsWith("flash"), reason };
}

export type UserPolicyInput = Omit<UserPolicy, "policy_hash">;
export type ProjectPolicyInput = Omit<ProjectPolicy, "policy_hash">;

export function createUserPolicy(input: UserPolicyInput): UserPolicy {
  validatePolicyCore(input, "UserPolicy", true);
  return { ...input, policy_hash: stableHash(input) };
}

export function createProjectPolicy(input: ProjectPolicyInput): ProjectPolicy {
  validatePolicyCore(input, "ProjectPolicy", false);
  return { ...input, policy_hash: stableHash(input) };
}

export function resolveEffectivePolicy(user: UserPolicy, project: ProjectPolicy): EffectivePolicy {
  validatePolicyHash(user, "UserPolicy"); validatePolicyHash(project, "ProjectPolicy");
  const read_scope = narrowedScope(user.read_scope, project.read_scope, "read_scope");
  const write_scope = narrowedScope(user.write_scope, project.write_scope, "write_scope");
  const budget_ceiling = narrowerBudget(user.budget_ceiling, project.budget_ceiling);
  const egress_policy = narrowEgress(user, project);
  const body: Omit<EffectivePolicy, "policy_hash"> = {
    version: 1,
    user_policy_hash: user.policy_hash,
    project_policy_hash: project.policy_hash,
    egress_policy,
    read_scope,
    write_scope,
    budget_ceiling,
  };
  return { ...body, policy_hash: stableHash(body) };
}

export function assertEffectivePolicy(policy: EffectivePolicy): void {
  const keys = ["version", "user_policy_hash", "project_policy_hash", "egress_policy", "read_scope", "write_scope", "budget_ceiling", "policy_hash"];
  if (Object.keys(policy).some(key => !keys.includes(key)) || keys.some(key => !(key in policy))) throw new Error("EffectivePolicy has unknown or missing fields");
  if (policy.version !== 1 || !/^[a-f0-9]{64}$/.test(policy.user_policy_hash) || !/^[a-f0-9]{64}$/.test(policy.project_policy_hash)) throw new Error("EffectivePolicy has invalid version or source hashes");
  const { policy_hash, ...body } = policy;
  if (!hashesEqual(policy_hash, stableHash(body))) throw new Error("EffectivePolicy hash does not match canonical content");
  assertEgressPolicy(policy.egress_policy, "EffectivePolicy.egress_policy");
  assertPathScope(policy.read_scope, "EffectivePolicy.read_scope");
  assertPathScope(policy.write_scope, "EffectivePolicy.write_scope");
  assertRequestBudget(policy.budget_ceiling, "EffectivePolicy.budget_ceiling");
}

/**
 * S1 only builds and approves immutable data. It deliberately does not invoke
 * an adapter, resolve credentials, or perform endpoint preflight (S5).
 */
export function buildRouteBinding(input: Omit<RouteBinding, "route_binding_hash">, task: TaskPackage, policy: EffectivePolicy, now = new Date()): RouteBinding {
  assertTaskPackage(task); assertEffectivePolicy(policy);
  requireScopeSubset(input.read_scope, task.read_scope, "RouteBinding.read_scope exceeds TaskPackage.read_scope");
  requireScopeSubset(input.write_scope, task.write_scope, "RouteBinding.write_scope exceeds TaskPackage.write_scope");
  requireScopeSubset(input.read_scope, policy.read_scope, "RouteBinding.read_scope exceeds effective policy");
  requireScopeSubset(input.write_scope, policy.write_scope, "RouteBinding.write_scope exceeds effective policy");
  requireBudgetWithin(input.request_budget, task.request_budget, "TaskPackage request budget");
  requireBudgetWithin(input.request_budget, policy.budget_ceiling, "effective policy budget");
  if (input.provider_id === "deepseek") assertThirdPartyEgress(task, policy, input.read_scope, now);
  return createRouteBinding(input);
}

function validatePolicyCore(input: UserPolicyInput | ProjectPolicyInput, name: string, user: boolean): void {
  const policyKeys = ["version", "policy_id", "egress_policy", "read_scope", "write_scope", "budget_ceiling"];
  const unknownPolicyKeys = Object.keys(input).filter(key => !policyKeys.includes(key)); const missingPolicyKeys = policyKeys.filter(key => !(key in input));
  if (unknownPolicyKeys.length || missingPolicyKeys.length) throw new Error(`${name} has unknown or missing fields`);
  if (input.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.policy_id)) throw new Error(`${name} has an invalid version or policy_id`);
  assertPathScope(input.read_scope, `${name}.read_scope`); assertPathScope(input.write_scope, `${name}.write_scope`); assertRequestBudget(input.budget_ceiling, `${name}.budget_ceiling`);
  const egress = input.egress_policy as unknown as Record<string, unknown>;
  if (!egress || typeof egress !== "object" || !["allow", "deny"].includes(String(egress.mode))) throw new Error(`${name}.egress_policy is invalid`);
  if (egress.mode === "deny") {
    if (Object.keys(egress).length !== 1) throw new Error(`${name}.egress_policy deny cannot contain extra fields`);
    return;
  }
  if (user) assertEgressPolicy(input.egress_policy, `${name}.egress_policy`);
  const required = user
    ? ["mode", "providers", "paths", "content_hashes", "authorization_id", "authorized_by", "authorized_at", "expires_at"]
    : ["mode", "providers", "paths", "content_hashes"];
  const unknown = Object.keys(egress).filter(key => !required.includes(key)); const missing = required.filter(key => !(key in egress));
  if (unknown.length || missing.length) throw new Error(`${name}.egress_policy has unknown or missing fields`);
  if (!Array.isArray(egress.providers) || egress.providers.length === 0 || !egress.providers.every(provider => ["openai-codex", "deepseek", "local"].includes(String(provider)))) throw new Error(`${name}.egress_policy.providers must be non-empty`);
  assertPathScope(egress.paths, `${name}.egress_policy.paths`);
  if (!Array.isArray(egress.content_hashes) || egress.content_hashes.length === 0 || !egress.content_hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new Error(`${name}.egress_policy.content_hashes must be non-empty SHA-256 hashes`);
  if (user && (egress.authorized_by !== "user" || typeof egress.authorization_id !== "string" || !egress.authorization_id)) throw new Error("Only an explicit user authorization can permit third-party egress");
}

function validatePolicyHash(policy: UserPolicy | ProjectPolicy, name: string): void {
  const { policy_hash, ...body } = policy;
  validatePolicyCore(body, name, name === "UserPolicy");
  if (!hashesEqual(policy_hash, stableHash(body))) throw new Error(`${name} hash does not match canonical content`);
}

function narrowedScope(user: string[], project: string[], name: string): string[] {
  requireScopeSubset(project, user, `Project policy ${name} cannot widen user policy`);
  return [...project];
}

function requireScopeSubset(candidate: string[], ceiling: string[], message: string): void {
  assertPathScope(candidate, "candidate scope"); assertPathScope(ceiling, "ceiling scope");
  if (candidate.some(path => !scopeEntryWithin(path, ceiling))) throw new Error(message);
}

function scopeEntryWithin(candidate: string, ceiling: string[]): boolean {
  return /[*?]/.test(candidate) ? ceiling.includes(candidate) : isAllowedPath(candidate, ceiling);
}

function narrowerBudget(user: RequestBudget, project: RequestBudget): RequestBudget {
  requireBudgetWithin(project, user, "Project policy cannot widen user budget");
  return { ...project };
}

function requireBudgetWithin(candidate: RequestBudget, ceiling: RequestBudget, name: string): void {
  const numeric: Array<keyof Pick<RequestBudget, "max_input_tokens" | "max_output_tokens" | "max_tool_calls" | "max_wall_time_ms">> = ["max_input_tokens", "max_output_tokens", "max_tool_calls", "max_wall_time_ms"];
  if (numeric.some(key => candidate[key] > ceiling[key])) throw new Error(`${name} exceeded`);
  const candidateCost = candidate.max_estimated_cost_usd ?? Number.POSITIVE_INFINITY;
  const ceilingCost = ceiling.max_estimated_cost_usd ?? Number.POSITIVE_INFINITY;
  if (candidateCost > ceilingCost) throw new Error(`${name} exceeded`);
  if (candidate.billing_mode !== ceiling.billing_mode) throw new Error(`${name} billing_mode changed`);
}

function narrowEgress(user: UserPolicy, project: ProjectPolicy): EffectivePolicy["egress_policy"] {
  if (user.egress_policy.mode === "deny" || project.egress_policy.mode === "deny") return { mode: "deny" };
  const userEgress = user.egress_policy; const projectEgress = project.egress_policy;
  const providers = projectEgress.providers.filter(provider => userEgress.providers.includes(provider));
  const paths = projectEgress.paths.filter(path => scopeEntryWithin(path, userEgress.paths));
  const content_hashes = projectEgress.content_hashes.filter(hash => userEgress.content_hashes.includes(hash));
  if (!providers.length || !paths.length || !content_hashes.length) return { mode: "deny" };
  return { ...userEgress, providers, paths, content_hashes };
}

function assertThirdPartyEgress(task: TaskPackage, policy: EffectivePolicy, readScope: string[], now: Date): void {
  if (!task.data_classification) throw new Error("Unclassified data cannot create a DeepSeek RouteBinding");
  if (task.data_classification === "secret_restricted") throw new Error("secret_restricted data cannot create a DeepSeek RouteBinding");
  if (task.egress_policy.mode !== "allow" || policy.egress_policy.mode !== "allow") throw new Error("Explicit user egress authorization is required for DeepSeek");
  for (const egress of [task.egress_policy, policy.egress_policy]) {
    if (!egress.providers.includes("deepseek")) throw new Error("DeepSeek is not included in the approved egress providers");
    if (egress.expires_at && Date.parse(egress.expires_at) <= now.getTime()) throw new Error("DeepSeek egress authorization has expired");
    if (readScope.some(path => !scopeEntryWithin(path, egress.paths))) throw new Error("DeepSeek read scope exceeds approved egress paths");
  }
  const disclosed = task.context_manifest.filter(entry => isAllowedPath(entry.path, readScope));
  for (const entry of disclosed) {
    if (!task.egress_policy.content_hashes.includes(entry.content_hash) || !policy.egress_policy.content_hashes.includes(entry.content_hash)) throw new Error("DeepSeek context hash is not explicitly approved for egress");
  }
}
