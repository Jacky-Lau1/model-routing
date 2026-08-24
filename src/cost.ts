import { hashesEqual, stableHash } from "./canonical.js";
import type { AttemptUsage, PricingTimeBand, UsageMetrics } from "./types.js";

export interface PriceRates {
  input_cache_hit_usd_per_million: number;
  input_cache_miss_usd_per_million: number;
  output_usd_per_million: number;
}

export interface PricingCatalogEntry {
  provider: "openai-codex" | "deepseek";
  model: string;
  effective_at: string;
  source_url: string;
  time_bands: Array<{
    name: PricingTimeBand;
    utc_rule: "always" | "weekday_0100_0400_or_0600_1000" | "otherwise";
    rates: PriceRates;
  }>;
}

export interface PricingCatalog {
  version: string;
  currency: "USD";
  retrieved_at: string;
  valid_until: string;
  entries: PricingCatalogEntry[];
  catalog_hash: string;
}

export type PricingFailureCode = "catalog_stale" | "unknown_model" | "time_band_ambiguous" | "usage_unavailable" | "usage_inconsistent";

export class PricingUnavailableError extends Error {
  constructor(readonly code: PricingFailureCode, message: string) { super(message); this.name = "PricingUnavailableError"; }
}

const RETRIEVED_AT = "2026-08-24T03:30:00.000Z";
const VALID_UNTIL = "2026-09-23T03:30:00.000Z";

const CATALOG_BODY: Omit<PricingCatalog, "catalog_hash"> = {
  version: "2026-08-24.1",
  currency: "USD",
  retrieved_at: RETRIEVED_AT,
  valid_until: VALID_UNTIL,
  entries: [
    {
      provider: "openai-codex", model: "gpt-5.6-terra", effective_at: RETRIEVED_AT,
      source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
      time_bands: [{ name: "standard", utc_rule: "always", rates: { input_cache_hit_usd_per_million: 0.20, input_cache_miss_usd_per_million: 2.00, output_usd_per_million: 12.00 } }],
    },
    {
      provider: "deepseek", model: "deepseek-v4-flash", effective_at: "2026-08-16T16:00:00.000Z",
      source_url: "https://api-docs.deepseek.com/quick_start/pricing/",
      time_bands: [
        { name: "peak", utc_rule: "weekday_0100_0400_or_0600_1000", rates: { input_cache_hit_usd_per_million: 0.014, input_cache_miss_usd_per_million: 0.44, output_usd_per_million: 1.32 } },
        { name: "off_peak", utc_rule: "otherwise", rates: { input_cache_hit_usd_per_million: 0.007, input_cache_miss_usd_per_million: 0.22, output_usd_per_million: 0.66 } },
      ],
    },
    {
      provider: "deepseek", model: "deepseek-v4-pro", effective_at: "2026-08-16T16:00:00.000Z",
      source_url: "https://api-docs.deepseek.com/quick_start/pricing/",
      time_bands: [
        { name: "peak", utc_rule: "weekday_0100_0400_or_0600_1000", rates: { input_cache_hit_usd_per_million: 0.044, input_cache_miss_usd_per_million: 1.32, output_usd_per_million: 3.96 } },
        { name: "off_peak", utc_rule: "otherwise", rates: { input_cache_hit_usd_per_million: 0.022, input_cache_miss_usd_per_million: 0.66, output_usd_per_million: 1.98 } },
      ],
    },
  ],
};

export const PRICING_CATALOG: PricingCatalog = deepFreeze({ ...CATALOG_BODY, catalog_hash: stableHash(CATALOG_BODY) });
export const PRICING_CATALOG_VERSION = PRICING_CATALOG.version;
export const PRICING_CATALOG_HASH = PRICING_CATALOG.catalog_hash;

export function assertPricingCatalog(catalog: PricingCatalog, at: Date): void {
  if (!catalog || catalog.currency !== "USD" || !catalog.version || !Array.isArray(catalog.entries) || !/^[a-f0-9]{64}$/.test(catalog.catalog_hash)) throw new PricingUnavailableError("catalog_stale", "Pricing catalog is invalid");
  const { catalog_hash: _hash, ...body } = catalog;
  if (!hashesEqual(catalog.catalog_hash, stableHash(body))) throw new PricingUnavailableError("catalog_stale", "Pricing catalog hash does not match its canonical content");
  if (!validDate(at) || Date.parse(catalog.retrieved_at) > at.getTime() || at.getTime() >= Date.parse(catalog.valid_until)) throw new PricingUnavailableError("catalog_stale", "Pricing catalog is stale or not yet valid");
}

export function priceTimeBand(provider: string, model: string, at: Date, catalog: PricingCatalog = PRICING_CATALOG): { entry: PricingCatalogEntry; band: PricingCatalogEntry["time_bands"][number] } {
  assertPricingCatalog(catalog, at);
  const entry = catalog.entries.find(item => item.provider === provider && item.model === model);
  if (!entry || at.getTime() < Date.parse(entry.effective_at)) throw new PricingUnavailableError("unknown_model", `No effective list price is available for ${provider}/${model}`);
  if (entry.time_bands.length === 1 && entry.time_bands[0].utc_rule === "always") return { entry, band: entry.time_bands[0] };
  const day = at.getUTCDay(); const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  const peak = weekday && ((minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600));
  const band = entry.time_bands.find(item => item.name === (peak ? "peak" : "off_peak"));
  if (!band) throw new PricingUnavailableError("time_band_ambiguous", "Pricing time band could not be determined");
  return { entry, band };
}

export function priceUsageUsd(provider: string, model: string, usage: AttemptUsage, at: Date, catalog: PricingCatalog = PRICING_CATALOG): { usd: number; time_band: PricingTimeBand } {
  assertAttemptUsage(usage);
  const { band } = priceTimeBand(provider, model, at, catalog);
  if (provider === "deepseek" && usage.cache_hit_tokens + usage.cache_miss_tokens !== usage.input_tokens) throw new PricingUnavailableError("usage_inconsistent", "DeepSeek cache hit/miss tokens do not account for all billed input tokens");
  if (provider !== "deepseek" && usage.cached_input_tokens + usage.cache_write_tokens > usage.input_tokens) throw new PricingUnavailableError("usage_inconsistent", "Cached input categories exceed total input tokens");
  const hit = provider === "deepseek" ? usage.cache_hit_tokens : usage.cached_input_tokens;
  const miss = provider === "deepseek" ? usage.cache_miss_tokens : usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens;
  const cacheWrite = provider === "deepseek" ? 0 : usage.cache_write_tokens;
  const input = hit * band.rates.input_cache_hit_usd_per_million + (miss + cacheWrite) * band.rates.input_cache_miss_usd_per_million;
  return { usd: roundUsd((input + usage.output_tokens * band.rates.output_usd_per_million) / 1_000_000), time_band: band.name };
}

export function worstCaseRoundUsd(provider: string, model: string, inputTokenUpperBound: number, outputTokenUpperBound: number, at: Date, catalog: PricingCatalog = PRICING_CATALOG): number {
  for (const [value, name] of [[inputTokenUpperBound, "input"], [outputTokenUpperBound, "output"]] as const) if (!Number.isInteger(value) || value < 0) throw new PricingUnavailableError("usage_unavailable", `${name} token upper bound is unavailable`);
  const { entry } = priceTimeBand(provider, model, at, catalog);
  const miss = Math.max(...entry.time_bands.map(item => item.rates.input_cache_miss_usd_per_million));
  const output = Math.max(...entry.time_bands.map(item => item.rates.output_usd_per_million));
  return roundUsd((inputTokenUpperBound * miss + outputTokenUpperBound * output) / 1_000_000);
}

/** Compatibility helper for legacy reports. Canonical execution uses priceUsageUsd and fails closed. */
export function estimateEquivalentUsd(model: string, usage: UsageMetrics, at = new Date(RETRIEVED_AT)): number | undefined {
  const provider = model.startsWith("deepseek-") ? "deepseek" : model.startsWith("gpt-") ? "openai-codex" : undefined;
  if (!provider) return model === "local-quality-gates" ? 0 : undefined;
  try { return priceUsageUsd(provider, model, usageToAttempt(usage), at).usd; } catch { return undefined; }
}

export function usageToAttempt(usage: UsageMetrics): AttemptUsage {
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, reasoning_tokens: usage.reasoningTokens, cached_input_tokens: usage.cachedInputTokens, cache_write_tokens: usage.cacheWriteTokens, cache_hit_tokens: usage.cacheHitTokens, cache_miss_tokens: usage.cacheMissTokens };
}

export function pricingCatalogEvidence(roundBands: PricingTimeBand[], catalog: PricingCatalog = PRICING_CATALOG) {
  const entries = catalog.entries.filter(item => item.provider === "deepseek");
  return { version: catalog.version, hash: catalog.catalog_hash, currency: catalog.currency, source_urls: [...new Set(entries.map(item => item.source_url))], retrieved_at: catalog.retrieved_at, effective_at: entries.map(item => item.effective_at).sort().at(-1)!, time_bands: [...new Set(roundBands)] };
}

function assertAttemptUsage(usage: AttemptUsage): void {
  if (!usage || Object.values(usage).some(value => !Number.isInteger(value) || value < 0)) throw new PricingUnavailableError("usage_unavailable", "Complete non-negative integer usage is required for list-price estimation");
}
function validDate(value: Date): boolean { return value instanceof Date && !Number.isNaN(value.getTime()); }
function roundUsd(value: number): number { return Math.round(value * 1e12) / 1e12; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
