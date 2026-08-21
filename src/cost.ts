import type { UsageMetrics } from "./types.js";

export const PRICING_CATALOG_VERSION = "2026-08-18";
interface Rate { input: number; cachedInput?: number; output: number; cacheWriteMultiplier?: number; cacheHit?: number; cacheMiss?: number; source: string }

export const PRICING_CATALOG: Record<string, Rate> = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30, cacheWriteMultiplier: 1.25, source: "https://developers.openai.com/api/docs/models/compare" },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12, cacheWriteMultiplier: 1.25, source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra" },
  "deepseek-v4-flash": { input: 0.14, cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28, source: "https://api-docs.deepseek.com/quick_start/pricing/" },
  "deepseek-v4-pro": { input: 0.435, cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87, source: "https://api-docs.deepseek.com/quick_start/pricing/" },
};

export function estimateEquivalentUsd(model: string, usage: UsageMetrics): number | undefined {
  const rate = PRICING_CATALOG[model]; if (!rate) return model === "local-quality-gates" ? 0 : undefined;
  let inputCost: number;
  if (rate.cacheHit !== undefined && rate.cacheMiss !== undefined) {
    const accounted = usage.cacheHitTokens + usage.cacheMissTokens;
    inputCost = usage.cacheHitTokens * rate.cacheHit + usage.cacheMissTokens * rate.cacheMiss + Math.max(0, usage.inputTokens - accounted) * rate.input;
  } else {
    const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
    inputCost = uncached * rate.input + usage.cachedInputTokens * (rate.cachedInput ?? rate.input) + usage.cacheWriteTokens * rate.input * (rate.cacheWriteMultiplier ?? 1);
  }
  return roundUsd((inputCost + usage.outputTokens * rate.output) / 1_000_000);
}
function roundUsd(value: number): number { return Math.round(value * 1e9) / 1e9; }
