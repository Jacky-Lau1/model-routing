import { describe, expect, it, vi } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { createRouteBinding } from "../src/contracts.js";
import { decideRoute } from "../src/policy.js";
import { RoutingProviderAdapter } from "../src/providers/routing.js";
import {
  buildLegacyRouteBinding, DEEPSEEK_ADAPTER_ID, DEEPSEEK_ENDPOINT_ORIGIN, DEEPSEEK_ENDPOINT_PATH,
  DEEPSEEK_ENV_AUTH_ALIAS, freezeRouteBinding, preflightRouteBinding,
} from "../src/route-preflight.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, RouteBinding } from "../src/types.js";

const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
const base = buildLegacyRouteBinding(route, ["src/a.ts"], ["src/a.ts"]);
const request: ProviderRequest = { stage: "EXECUTE", route, routeBinding: base, stablePrefix: "stable", projectSummary: "synthetic", dynamicInput: "task", sensitivity: "normal" };
const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

describe("S5 immutable route preflight", () => {
  it("builds one exact, deeply frozen DeepSeek tuple", () => {
    expect(preflightRouteBinding(base, route, DEEPSEEK_ADAPTER_ID).targetUrl).toBe(`${DEEPSEEK_ENDPOINT_ORIGIN}${DEEPSEEK_ENDPOINT_PATH}`);
    expect(base).toMatchObject({ provider_id: "deepseek", adapter_id: DEEPSEEK_ADAPTER_ID, endpoint_origin: DEEPSEEK_ENDPOINT_ORIGIN, endpoint_path: DEEPSEEK_ENDPOINT_PATH, auth_alias: DEEPSEEK_ENV_AUTH_ALIAS, wire_protocol: "chat_completions" });
    expect(Object.isFrozen(base)).toBe(true); expect(Object.isFrozen(base.request_budget)).toBe(true); expect(Object.isFrozen(base.network_scope)).toBe(true); expect(Object.isFrozen(base.read_scope)).toBe(true);
    expect(() => { base.request_budget.max_output_tokens = 1; }).toThrow();
    expect(() => { base.network_scope.push("https://example.invalid"); }).toThrow();
  });

  it("canonical-clones and freezes a persisted mutable binding", () => {
    const persisted = JSON.parse(JSON.stringify(base)) as RouteBinding; const frozen = freezeRouteBinding(persisted);
    persisted.read_scope[0] = "src/other.ts";
    expect(frozen.read_scope).toEqual(["src/a.ts"]); expect(() => { frozen.write_scope[0] = "src/other.ts"; }).toThrow();
  });

  it.each([
    ["adapter", { adapter_id: "other-adapter" }],
    ["model family", { model_id: "deepseek-v4-other" }],
    ["origin", { endpoint_origin: "https://api.deepseek.com:444" }],
    ["path", { endpoint_path: "/v1/chat/completions" }],
    ["protocol", { wire_protocol: "responses" }],
    ["auth alias", { auth_alias: "deepseek-other" }],
    ["network scope", { network_scope: ["https://example.invalid"] }],
    ["environment scope", { environment_scope: ["UNAPPROVED"] }],
    ["command scope", { command_scope: ["unapproved-command"] }],
    ["input budget", { request_budget: { ...base.request_budget, max_input_tokens: 1 } }],
    ["cost budget", { request_budget: { ...base.request_budget, max_estimated_cost_usd: 1 } }],
  ])("rejects a hash-valid but unapproved %s tuple", (_name, patch) => {
    const changed = rebuild(base, patch as Partial<RouteBinding>);
    expect(() => preflightRouteBinding(changed, route, DEEPSEEK_ADAPTER_ID)).toThrow(/binding|budget|model|scope|alias|protocol|endpoint|adapter/i);
  });

  it.each([
    "http://api.deepseek.com", "https://api.deepseek.com.evil.invalid", "https://api.deepseek.com:444",
    "https://api.deepseek.com:443", "https://user@api.deepseek.com", "https://user:pass@api.deepseek.com",
    "https://api.deepseek.com.", "https://API.DEEPSEEK.COM", "https://127.0.0.1", "https://localhost",
    "https://xn--deepseek-9za.invalid", "https://api.openai.com", "https://api.deepseek.com/path", "https://api.deepseek.com?query=1",
  ])("rejects endpoint confusion %s", origin => {
    expect(() => preflightRouteBinding(rebuild(base, { endpoint_origin: origin }), route, DEEPSEEK_ADAPTER_ID)).toThrow();
  });

  it.each([
    "/v1/chat/completions", "/Chat/Completions", "/chat/completions/", "/chat/completions?query=1",
    "/chat/completions#fragment", "//example.invalid/chat/completions", "/chat/%2e%2e/completions", "/chat%2fcompletions", "\\chat\\completions",
  ])("rejects endpoint path confusion %s", endpointPath => {
    expect(() => preflightRouteBinding(rebuild(base, { endpoint_path: endpointPath }), route, DEEPSEEK_ADAPTER_ID)).toThrow();
  });

  it("rejects cross-provider model, endpoint and auth tuples", () => {
    expect(() => preflightRouteBinding(rebuild(base, { endpoint_origin: "https://api.openai.com" }), route, DEEPSEEK_ADAPTER_ID)).toThrow();
    const openaiRoute = decideRoute("PLAN", classifyTask("Fix a bounded parser bug")); const openai = buildLegacyRouteBinding(openaiRoute, ["src/a.ts"], ["src/a.ts"]);
    expect(() => preflightRouteBinding(rebuild(openai, { auth_alias: DEEPSEEK_ENV_AUTH_ALIAS }), openaiRoute)).toThrow();
  });

  it("copies the adapter registry and refuses adapter/provider mismatches", async () => {
    const deepInvoke = vi.fn(async (): Promise<ProviderResponse> => ({ text: "ok", requestId: "r", provider: "deepseek", model: route.model, usage }));
    const deepPreflight = vi.fn();
    const deep: ProviderAdapter = { provider: "deepseek", adapterId: DEEPSEEK_ADAPTER_ID, preflight: deepPreflight, invoke: deepInvoke };
    const registry = new Map<string, ProviderAdapter>([["deepseek", deep]]); const routing = new RoutingProviderAdapter(registry);
    registry.set("deepseek", { provider: "openai-codex", adapterId: "codex-cli", invoke: deepInvoke });
    await routing.preflight(request); await routing.invoke(request);
    expect(deepPreflight).toHaveBeenCalledTimes(2); expect(deepInvoke).toHaveBeenCalledOnce();

    const mismatched = new RoutingProviderAdapter(new Map([["deepseek", { provider: "openai-codex", adapterId: DEEPSEEK_ADAPTER_ID, invoke: deepInvoke }]]));
    expect(() => mismatched.preflight(request)).toThrow(/identity/);
  });

  it("requires a preflight implementation for every bound adapter", async () => {
    const routing = new RoutingProviderAdapter(new Map([["deepseek", { provider: "deepseek", adapterId: DEEPSEEK_ADAPTER_ID, invoke: vi.fn() }]]));
    expect(() => routing.preflight(request)).toThrow(/preflight/);
  });

  it("rejects a provider-correct adapter whose stable adapter ID is not approved", () => {
    const routing = new RoutingProviderAdapter(new Map([["deepseek", { provider: "deepseek", adapterId: "deepseek-compatible-but-unapproved", preflight: vi.fn(), invoke: vi.fn() }]]));
    expect(() => routing.preflight(request)).toThrow(/adapter ID/);
  });
});

function rebuild(binding: RouteBinding, patch: Partial<RouteBinding>): RouteBinding {
  const { route_binding_hash: _hash, ...body } = binding;
  return createRouteBinding({ ...body, ...patch });
}
