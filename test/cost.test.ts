import { describe, expect, it } from "vitest";
import { estimateEquivalentUsd } from "../src/cost.js";

const base = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
describe("normalized public API cost", () => {
  it("prices OpenAI cached reads and writes separately", () => {
    expect(estimateEquivalentUsd("gpt-5.6-terra", { ...base, inputTokens: 3_000, cachedInputTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 })).toBe(0.0167);
  });
  it("prices DeepSeek cache hits and misses separately", () => {
    expect(estimateEquivalentUsd("deepseek-v4-flash", { ...base, inputTokens: 2_000, cacheHitTokens: 1_000, cacheMissTokens: 1_000, outputTokens: 1_000 })).toBe(0.0004228);
  });
  it("does not invent a price for unknown models", () => expect(estimateEquivalentUsd("unknown", base)).toBeUndefined());
});
