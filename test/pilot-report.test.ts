import { describe, expect, it } from "vitest";
import { assertPilotPairReportForRuns, assertPilotRunRecord, createPilotPairReport, createPilotRunRecord, type PilotRunInput } from "../src/pilot-report.js";

const HASH = "a".repeat(64);
const created = "2026-08-24T08:00:00.000Z";

function input(arm: "gpt_only" | "hybrid", overrides: Partial<PilotRunInput> = {}): PilotRunInput {
  const provider = arm === "gpt_only" ? "foreground-gpt-unverified" : "deepseek";
  return {
    version: 1, task_id: "PILOT-SUM-001", arm, run_id: `${arm}-run-1`, base_fixture_hash: HASH, task_package_hash: "b".repeat(64), route_binding_hash: "c".repeat(64), approval_hash: "d".repeat(64), execution_context_hash: "e".repeat(64), evidence_bundle_hash: "f".repeat(64),
    provider, model: arm === "gpt_only" ? null : "deepseek-v4-flash", endpoint_origin: arm === "gpt_only" ? null : "https://api.deepseek.com", endpoint_path: arm === "gpt_only" ? null : "/chat/completions", auth_alias: arm === "gpt_only" ? null : "deepseek-dpapi",
    first_pass_success: true, final_acceptance: true, visible_tests: { passed: 3, failed: 0, not_run: 0 }, hidden_tests: { passed: 4, failed: 0, not_run: 0 }, regression: false, repair_count: 0, human_interventions: [],
    violations: { secret: 0, scope: 0, privacy: 0, routing: 0, main_workspace_pollution: 0, unexplained_duplicate_requests: 0 }, ambiguity: { attempts: 0, total_attempts: 1, attempt_rate: 0, requests: 0, total_requests: arm === "gpt_only" ? 0 : 2, request_rate: 0 },
    usage_by_stage_model: [{ stage: "EXECUTE", provider, model: arm === "gpt_only" ? null : "deepseek-v4-flash", input_tokens: arm === "gpt_only" ? null : 200, output_tokens: arm === "gpt_only" ? null : 20, reasoning_tokens: arm === "gpt_only" ? null : 4, cache_hit_tokens: arm === "gpt_only" ? null : 40, cache_miss_tokens: arm === "gpt_only" ? null : 160 }],
    provider_http_request_count: arm === "gpt_only" ? null : 2, wall_clock_ms: { plan: 10, execute: 20, gate: 30, review: 10, repair: 0, total: 70 },
    costs: { provider_reported_usd: null, estimated_list_usd: arm === "gpt_only" ? null : 0.005, invoice_usd: null, chatgpt_quota: null }, pricing_catalog: arm === "gpt_only" ? null : { version: "synthetic", hash: HASH, source_urls: ["https://example.invalid/pricing"], time_bands: ["peak"] },
    core_metrics_unavailable: arm === "gpt_only" ? ["foreground_model", "provider_http_request_count", "token_usage", "estimated_list_cost", "chatgpt_quota"] : [], remaining_risks: ["synthetic record"], created_at: created, ...overrides,
  };
}

describe("versioned Pilot records and fixed decision gates", () => {
  it("preserves unavailable foreground metrics as null and blocks expansion", () => {
    const record = createPilotRunRecord(input("gpt_only"));
    expect(record.costs.estimated_list_usd).toBeNull(); expect(record.provider_http_request_count).toBeNull(); expect(record.evidence_sufficient).toBe(false); expect(record.recommendation).toBe("stop");
    expect(() => assertPilotRunRecord(record)).not.toThrow();
  });

  it("distinguishes a measured zero from unavailable without mixing cost layers", () => {
    const record = createPilotRunRecord(input("hybrid", { costs: { provider_reported_usd: null, estimated_list_usd: 0, invoice_usd: null, chatgpt_quota: null } }));
    expect(record.costs.estimated_list_usd).toBe(0); expect(record.costs.provider_reported_usd).toBeNull(); expect(record.costs.invoice_usd).toBeNull();
  });

  it("does not count exact-hash user approval, but any enumerated manual intervention prevents automatic success", () => {
    expect(createPilotRunRecord(input("hybrid")).automated_success).toBe(true);
    const intervened = createPilotRunRecord(input("hybrid", { human_interventions: [{ type: "manual_code_change", summary: "Synthetic operator edit" }] }));
    expect(intervened.automated_success).toBe(false); expect(intervened.recommendation).toBe("stop");
  });

  it("stops a pair when core GPT evidence is unavailable", () => {
    const gpt = createPilotRunRecord(input("gpt_only")); const hybrid = createPilotRunRecord(input("hybrid"));
    const pair = createPilotPairReport(gpt, hybrid, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created });
    expect(pair.cost_reduction_percent).toBeNull(); expect(pair.expansion_blockers).toContain("core_evidence_unavailable"); expect(pair.recommendation).toBe("stop");
  });

  it("derives core evidence failure from null metrics even when the caller omits the unavailable list", () => {
    const record = createPilotRunRecord(input("gpt_only", { core_metrics_unavailable: [] }));
    expect(record.evidence_sufficient).toBe(false); expect(record.recommendation).toBe("stop");
  });

  it("rejects a same-fixture claim when the two bound fixture hashes differ", () => {
    const gpt = createPilotRunRecord(input("gpt_only")); const hybrid = createPilotRunRecord(input("hybrid", { base_fixture_hash: "9".repeat(64) }));
    expect(() => createPilotPairReport(gpt, hybrid, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created })).toThrow(/fixture/i);
  });

  it("never expands when final acceptance fails or the hybrid arm adds repair and intervention", () => {
    const gpt = createPilotRunRecord(input("gpt_only", { model: "synthetic-gpt", provider_http_request_count: 1, ambiguity: { attempts: 0, total_attempts: 1, attempt_rate: 0, requests: 0, total_requests: 1, request_rate: 0 }, usage_by_stage_model: [{ stage: "EXECUTE", provider: "openai-codex", model: "synthetic-gpt", input_tokens: 100, output_tokens: 10, reasoning_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 100 }], costs: { provider_reported_usd: null, estimated_list_usd: 0.01, invoice_usd: null, chatgpt_quota: null }, pricing_catalog: { version: "synthetic", hash: HASH, source_urls: ["https://example.invalid/gpt-pricing"], time_bands: ["standard"] }, core_metrics_unavailable: [] }));
    const failed = createPilotRunRecord(input("hybrid", { first_pass_success: false, final_acceptance: false }));
    expect(createPilotPairReport(gpt, failed, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created }).recommendation).toBe("stop");
    const repaired = createPilotRunRecord(input("hybrid", { repair_count: 1, human_interventions: [{ type: "manual_code_change", summary: "Synthetic operator edit" }] }));
    expect(createPilotPairReport(gpt, repaired, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created }).recommendation).toBe("simplify");
  });

  it("expands only when fairness, acceptance, evidence, safety and the 30 percent cost gate all pass", () => {
    const gpt = createPilotRunRecord(input("gpt_only", { model: "synthetic-gpt", provider_http_request_count: 1, ambiguity: { attempts: 0, total_attempts: 1, attempt_rate: 0, requests: 0, total_requests: 1, request_rate: 0 }, usage_by_stage_model: [{ stage: "EXECUTE", provider: "openai-codex", model: "synthetic-gpt", input_tokens: 100, output_tokens: 10, reasoning_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 100 }], costs: { provider_reported_usd: null, estimated_list_usd: 0.01, invoice_usd: null, chatgpt_quota: null }, pricing_catalog: { version: "synthetic", hash: HASH, source_urls: ["https://example.invalid/gpt-pricing"], time_bands: ["standard"] }, core_metrics_unavailable: [] }));
    const hybrid = createPilotRunRecord(input("hybrid"));
    const pair = createPilotPairReport(gpt, hybrid, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created });
    expect(pair.cost_reduction_percent).toBe(50); expect(pair.expansion_blockers).toEqual([]); expect(pair.recommendation).toBe("expand");
  });

  it("rejects tampering and replay against a different run", () => {
    const gpt = createPilotRunRecord(input("gpt_only")); const hybrid = createPilotRunRecord(input("hybrid")); const pair = createPilotPairReport(gpt, hybrid, { same_base_fixture: true, same_scope: true, same_hidden_gate: true, same_wall_budget: true, same_acceptance_criteria: true, created_at: created });
    expect(() => assertPilotRunRecord({ ...hybrid, final_acceptance: false })).toThrow(/hash|recommendation|automated_success/);
    expect(() => assertPilotPairReportForRuns({ ...pair, recommendation: "expand" }, gpt, hybrid)).toThrow(/hash|decision/);
    const otherHybrid = createPilotRunRecord(input("hybrid", { run_id: "hybrid-run-2" }));
    expect(() => assertPilotPairReportForRuns(pair, gpt, otherHybrid)).toThrow(/replay|binding/);
  });
});
