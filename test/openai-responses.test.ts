import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmrf } from "./fs-test-utils.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { createRouteBinding } from "../src/contracts.js";
import { decideRoute } from "../src/policy.js";
import { OpenAiResponsesAdapter } from "../src/providers/openai-responses.js";
import { buildLegacyRouteBinding, OPENAI_ENDPOINT_ORIGIN, OPENAI_ENDPOINT_PATH, OPENAI_ENV_AUTH_ALIAS, OPENAI_RESPONSES_ADAPTER_ID } from "../src/route-preflight.js";
import { buildExecutorCapabilityGrant } from "../src/safe-executor.js";
import type { ProviderBudgetState, ProviderRequest, RequestBudget, RouteDecision } from "../src/types.js";

const roots: string[] = [];
const targetUrl = `${OPENAI_ENDPOINT_ORIGIN}${OPENAI_ENDPOINT_PATH}`;
afterEach(async () => Promise.all(roots.splice(0).map(root => rmrf(root))));

describe("Direct OpenAI Responses adapter (isolated GPT-only arm)", () => {
  it("parses authoritative usage and computes cache-aware list cost in a single turn", async () => {
    let body: any;
    const adapter = testAdapter(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return responseAt({ id: "resp_1", model: "gpt-5.6-terra", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 2 } } });
    });
    const route = decideRoute("PLAN", classifyTask("Fix a bounded parser bug"));
    const response = await adapter.invoke(bound({ stage: "PLAN", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal" }));
    expect(response.text).toBe("done");
    expect(response.provider).toBe("openai-codex");
    expect(response.model).toBe("gpt-5.6-terra");
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.instructions).toBe("stable");
    expect(body.input[0].role).toBe("user");
    expect(body.max_output_tokens).toBeGreaterThan(0);
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, reasoningTokens: 2, cachedInputTokens: 40 });
    // cached 40 hit + 60 miss at Terra rates (0.20 / 2.00 / 12.00 per M)
    expect(response.estimatedListCostUsd).toBe((40 * 0.2 + 60 * 2 + 10 * 12) / 1_000_000);
    expect(response.transportRounds?.[0]).toMatchObject({ cache_status: "mixed", pricing_time_band: "standard" });
  });

  it("replays a function_call loop and returns the final output text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openai-tool-")); roots.push(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    const requests: any[] = []; let call = 0;
    const adapter = testAdapter(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      call++;
      const payload = call === 1
        ? { id: "resp_1", model: "gpt-5.6-terra", output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }], usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } }
        : { id: "resp_2", model: "gpt-5.6-terra", output: [{ type: "message", content: [{ type: "output_text", text: "finished" }] }], usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } };
      return responseAt(payload);
    });
    const route = openAiExecuteRoute();
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }));
    expect(response.text).toBe("finished");
    expect(requests).toHaveLength(2);
    expect(requests[1].input.some((item: any) => item.type === "function_call" && item.call_id === "call_1")).toBe(true);
    expect(requests[1].input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_1")).toBe(true);
  });

  it("rejects a mismatched response model before exposing any tool proposal", async () => {
    const adapter = testAdapter(async () => responseAt({ id: "resp_1", model: "gpt-5.6-sol", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const route = decideRoute("PLAN", classifyTask("Fix a bounded parser bug"));
    const response = await adapter.invoke(bound({ stage: "PLAN", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }));
    expect(response.routeEvidence).toMatchObject({ routeTupleVerified: false, evidenceComplete: false });
    expect(response.routeEvidence?.unverifiedReasons).toContain("response_model_mismatch");
  });

  it("rejects an unapproved auth alias before credential resolution", async () => {
    const resolver = vi.fn(() => "synthetic");
    const adapter = new OpenAiResponsesAdapter({ credentialResolver: resolver, fetchImpl: vi.fn() as typeof fetch });
    const route = decideRoute("PLAN", classifyTask("Fix a bounded parser bug"));
    const legacy = buildLegacyRouteBinding(route, ["a.ts"], ["a.ts"]); // codex-cli-managed alias
    await expect(adapter.invoke({ stage: "PLAN", route, routeBinding: legacy, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" })).rejects.toThrow(/auth alias/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects absent bindings before credential resolution and fetch", async () => {
    const resolver = vi.fn(() => "synthetic"); const fetchImpl = vi.fn();
    const adapter = new OpenAiResponsesAdapter({ credentialResolver: resolver, fetchImpl: fetchImpl as typeof fetch });
    const route = decideRoute("PLAN", classifyTask("Fix a bounded parser bug"));
    const request = bound({ stage: "PLAN", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" });
    await expect(adapter.invoke({ ...request, routeBinding: undefined })).rejects.toThrow(/RouteBinding/);
    await expect(adapter.invoke({ ...request, routeBinding: { ...request.routeBinding!, endpoint_path: "/v1/chat/completions" } })).rejects.toThrow(/endpoint|hash/);
    expect(resolver).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records every canonical HTTP round and aggregates exact cache-aware list cost", async () => {
    const route = canonicalRoute(); const adapter = canonicalAdapter(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      const toolCall = body.input.some((item: any) => item.type === "function_call_output");
      return responseAt({ id: `resp-${toolCall ? 2 : 1}`, model: route.model, output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: toolCall ? 200 : 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } } });
    });
    const response = await adapter.invoke(canonicalBound({ stage: "PLAN", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }));
    expect(response.transportRounds).toHaveLength(1);
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, reasoningTokens: 2, cachedInputTokens: 10 });
    expect(response.estimatedListCostUsd).toBe((10 * 0.2 + 90 * 2 + 20 * 12) / 1_000_000);
    expect(response.providerReportedCostUsd).toBeNull();
  });

  it("fails before credential resolution when the canonical cost ceiling is exceeded", async () => {
    const resolver = vi.fn(() => "synthetic"); const fetchImpl = vi.fn(); const route = canonicalRoute();
    const adapter = new OpenAiResponsesAdapter({ credentialResolver: resolver, fetchImpl: fetchImpl as typeof fetch, now: () => new Date("2026-08-24T07:00:00.000Z") });
    await expect(adapter.invoke(canonicalBound({ stage: "PLAN", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }, { max_estimated_cost_usd: 0.0000001 }))).rejects.toThrow(/cost budget|list price/);
    expect(resolver).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function testAdapter(fetchImpl: typeof fetch): OpenAiResponsesAdapter {
  return new OpenAiResponsesAdapter({ credentialResolver: () => "synthetic", fetchImpl: async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.url) Object.defineProperty(response, "url", { value: targetUrl });
    if (response.redirected === undefined) Object.defineProperty(response, "redirected", { value: false });
    return response;
  } });
}
function canonicalAdapter(fetchImpl: typeof fetch): OpenAiResponsesAdapter {
  return new OpenAiResponsesAdapter({ credentialResolver: () => "synthetic", fetchImpl: async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.url) Object.defineProperty(response, "url", { value: targetUrl });
    if (response.redirected === undefined) Object.defineProperty(response, "redirected", { value: false });
    return response;
  }, now: () => new Date("2026-08-24T07:00:00.000Z") });
}
function bound(request: Omit<ProviderRequest, "routeBinding">): ProviderRequest {
  const readScope = request.executorCapabilities?.readManifest.map(item => item.path) ?? ["synthetic.txt"];
  const writeScope = request.executorCapabilities?.writeScope ?? ["synthetic.txt"];
  const legacy = buildLegacyRouteBinding(request.route, readScope, writeScope);
  const { route_binding_hash: _hash, ...body } = legacy;
  return { ...request, routeBinding: createRouteBinding({ ...body, adapter_id: OPENAI_RESPONSES_ADAPTER_ID, auth_alias: OPENAI_ENV_AUTH_ALIAS, environment_scope: ["OPENAI_API_KEY"], command_scope: [] }) };
}
function canonicalBound(request: Omit<ProviderRequest, "routeBinding">, budgetPatch: Partial<RequestBudget> = {}, budgetState: ProviderBudgetState = zeroState()): ProviderRequest {
  const readScope = request.executorCapabilities?.readManifest.map(item => item.path) ?? ["synthetic.txt"];
  const writeScope = request.executorCapabilities?.writeScope ?? ["synthetic.txt"];
  const legacy = buildLegacyRouteBinding(request.route, readScope, writeScope);
  const { route_binding_hash: _hash, ...body } = legacy;
  const requestBudget: RequestBudget = { ...body.request_budget, max_attempts: 2, max_provider_requests: 6, max_input_tokens: 20_000, max_output_tokens: request.route.maxOutputTokens, max_tool_calls: request.route.maxToolTurns, max_request_wall_time_ms: request.route.timeoutMs, max_wall_time_ms: 300_000, max_estimated_cost_usd: 0.05, billing_mode: "prepaid", ...budgetPatch };
  return { ...request, contractProvenance: "canonical", budgetState, routeBinding: createRouteBinding({ ...body, adapter_id: OPENAI_RESPONSES_ADAPTER_ID, auth_alias: OPENAI_ENV_AUTH_ALIAS, environment_scope: ["OPENAI_API_KEY"], command_scope: [], request_budget: requestBudget }) };
}
function canonicalRoute(): RouteDecision { return { ...decideRoute("PLAN", classifyTask("Fix a bounded parser bug")), maxOutputTokens: 1_000, maxToolTurns: 2, timeoutMs: 30_000 }; }
function openAiExecuteRoute(): RouteDecision { return { ...decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug")), provider: "openai-codex", model: "gpt-5.6-terra", maxToolTurns: 2, timeoutMs: 30_000 }; }
function responseAt(payload: unknown, options: { url?: string; redirected?: boolean; status?: number; headers?: HeadersInit } = {}): Response {
  const response = new Response(JSON.stringify(payload), { status: options.status ?? 200, headers: options.headers });
  Object.defineProperty(response, "url", { value: options.url ?? targetUrl });
  Object.defineProperty(response, "redirected", { value: options.redirected ?? false });
  return response;
}
function zeroState(): ProviderBudgetState { return { attempts_used: 0, provider_requests_used: 0, input_tokens_used: 0, output_tokens_used: 0, wall_clock_time_ms_used: 0, estimated_list_cost_usd: 0 }; }
