import { WORKFLOW_VERSION, type PersistenceProfile, type RouteDecision, type SensitivityClass, type Stage, type TaskProfile } from "./types.js";

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
