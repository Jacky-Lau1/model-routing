import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertPricingCatalog, priceTimeBand, priceUsageUsd, PRICING_CATALOG, PRICING_CATALOG_HASH, worstCaseRoundUsd } from "../src/cost.js";
import type { AttemptUsage } from "../src/types.js";

const usage: AttemptUsage = {
  input_tokens: 1_000, output_tokens: 500, reasoning_tokens: 100,
  cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 200, cache_miss_tokens: 800,
};

describe("versioned list-price accounting", () => {
  it("selects DeepSeek peak and off-peak bands from UTC and prices exact cache categories", () => {
    const peak = new Date("2026-08-24T07:00:00.000Z");
    const offPeak = new Date("2026-08-24T05:00:00.000Z");
    expect(priceTimeBand("deepseek", "deepseek-v4-flash", peak).band.name).toBe("peak");
    expect(priceTimeBand("deepseek", "deepseek-v4-flash", offPeak).band.name).toBe("off_peak");
    expect(priceUsageUsd("deepseek", "deepseek-v4-flash", usage, peak)).toEqual({ usd: 0.0010148, time_band: "peak" });
    expect(priceUsageUsd("deepseek", "deepseek-v4-flash", usage, offPeak)).toEqual({ usd: 0.0005074, time_band: "off_peak" });
    for (const [timestamp, band] of [["2026-08-25T00:59:59.999Z", "off_peak"], ["2026-08-25T01:00:00.000Z", "peak"], ["2026-08-25T03:59:59.999Z", "peak"], ["2026-08-25T04:00:00.000Z", "off_peak"], ["2026-08-25T06:00:00.000Z", "peak"], ["2026-08-25T10:00:00.000Z", "off_peak"]] as const) expect(priceTimeBand("deepseek", "deepseek-v4-flash", new Date(timestamp)).band.name).toBe(band);
  });

  it("uses the highest applicable time band for a pre-send ceiling", () => {
    expect(worstCaseRoundUsd("deepseek", "deepseek-v4-flash", 4_000, 1_000, new Date("2026-08-24T05:00:00.000Z"))).toBe(0.00308);
  });

  it("binds the catalog hash and fails closed when the catalog is stale or tampered", () => {
    expect(PRICING_CATALOG.catalog_hash).toBe(PRICING_CATALOG_HASH);
    expect(() => assertPricingCatalog(PRICING_CATALOG, new Date(PRICING_CATALOG.valid_until))).toThrow(/stale/);
    expect(() => assertPricingCatalog({ ...PRICING_CATALOG, version: "tampered" }, new Date("2026-08-24T02:00:00.000Z"))).toThrow(/hash/);
    expect(() => priceTimeBand("deepseek", "deepseek-unknown", new Date("2026-08-24T07:00:00.000Z"))).toThrow(/No effective list price/);
  });

  it("keeps the auditable JSON catalog byte-independent but canonically identical to runtime", async () => {
    const disk = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config/pricing-catalog.example.json"), "utf8"));
    expect(disk).toEqual(PRICING_CATALOG); expect(() => assertPricingCatalog(disk, new Date("2026-08-24T07:00:00.000Z"))).not.toThrow();
  });

  it("rejects incomplete or inconsistent cache accounting instead of inferring a pseudo-cost", () => {
    expect(() => priceUsageUsd("deepseek", "deepseek-v4-flash", { ...usage, cache_miss_tokens: 799 }, new Date("2026-08-24T07:00:00.000Z"))).toThrow(/account/);
  });
});
