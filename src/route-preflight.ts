import { assertRouteBinding, createRouteBinding } from "./contracts.js";
import type { ExecutorCapabilityGrant, Provider, RouteBinding, RouteDecision } from "./types.js";

export const DEEPSEEK_ADAPTER_ID = "deepseek-chat-direct";
export const CODEX_ADAPTER_ID = "codex-cli";
export const LOCAL_ADAPTER_ID = "local-validation";
export const DEEPSEEK_ENDPOINT_ORIGIN = "https://api.deepseek.com";
export const DEEPSEEK_ENDPOINT_PATH = "/chat/completions";
export const OPENAI_ENDPOINT_ORIGIN = "https://api.openai.com";
export const OPENAI_ENDPOINT_PATH = "/v1/responses";
export const DEEPSEEK_ENV_AUTH_ALIAS = "deepseek-env";
export const DEEPSEEK_DPAPI_AUTH_ALIAS = "deepseek-dpapi";
export const CODEX_AUTH_ALIAS = "codex-cli-managed";

export interface RoutePreflightResult { binding: RouteBinding; targetUrl: string }

/** S5 legacy bridge. S7 replaces this with the full contract core. */
export function buildLegacyRouteBinding(
  route: RouteDecision,
  readScope: string[],
  writeScope: string[],
  deepSeekAuthAlias: typeof DEEPSEEK_ENV_AUTH_ALIAS | typeof DEEPSEEK_DPAPI_AUTH_ALIAS = DEEPSEEK_ENV_AUTH_ALIAS,
): RouteBinding {
  const common = {
    version: 1 as const,
    provider_id: route.provider,
    model_id: route.model,
    reasoning_mode: route.provider === "local" ? "local" as const : route.effort === "none" ? "disabled" as const : "enabled" as const,
    reasoning_effort: route.effort,
    request_budget: {
      max_input_tokens: 64_000,
      max_output_tokens: Math.max(1, route.maxOutputTokens),
      max_tool_calls: route.maxToolTurns,
      max_wall_time_ms: route.timeoutMs,
      max_estimated_cost_usd: null,
      billing_mode: "unknown" as const,
    },
    read_scope: [...readScope], write_scope: [...writeScope],
  };
  if (route.provider === "deepseek") return freezeRouteBinding(createRouteBinding({
    ...common, adapter_id: DEEPSEEK_ADAPTER_ID,
    endpoint_origin: DEEPSEEK_ENDPOINT_ORIGIN, endpoint_path: DEEPSEEK_ENDPOINT_PATH,
    wire_protocol: "chat_completions", auth_alias: deepSeekAuthAlias,
    network_scope: [DEEPSEEK_ENDPOINT_ORIGIN],
    environment_scope: deepSeekAuthAlias === DEEPSEEK_ENV_AUTH_ALIAS
      ? ["DEEPSEEK_API_KEY"] : ["CODEX_ROUTER_SECRET_PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    command_scope: deepSeekAuthAlias === DEEPSEEK_DPAPI_AUTH_ALIAS ? ["powershell-dpapi-decrypt"] : [],
  }));
  if (route.provider === "openai-codex") return freezeRouteBinding(createRouteBinding({
    ...common, adapter_id: CODEX_ADAPTER_ID,
    endpoint_origin: OPENAI_ENDPOINT_ORIGIN, endpoint_path: OPENAI_ENDPOINT_PATH,
    wire_protocol: "responses", auth_alias: CODEX_AUTH_ALIAS,
    network_scope: [OPENAI_ENDPOINT_ORIGIN], environment_scope: ["CODEX_HOME"], command_scope: ["codex-cli"],
  }));
  return freezeRouteBinding(createRouteBinding({
    ...common, adapter_id: LOCAL_ADAPTER_ID,
    endpoint_origin: "local://quality-gate", endpoint_path: "/validate",
    wire_protocol: "local", auth_alias: null,
    network_scope: [], environment_scope: [], command_scope: [],
  }));
}

export function freezeRouteBinding(binding: RouteBinding): RouteBinding {
  assertRouteBinding(binding);
  const { route_binding_hash: _hash, ...body } = binding;
  return createRouteBinding(body);
}

export function preflightRouteBinding(binding: RouteBinding, route: RouteDecision, adapterId = adapterIdFor(route.provider)): RoutePreflightResult {
  assertRouteBinding(binding);
  if (binding.provider_id !== route.provider || binding.model_id !== route.model) throw new Error("RouteBinding provider/model does not match the approved route");
  if (binding.adapter_id !== adapterId) throw new Error("RouteBinding adapter does not match the selected adapter");
  if (binding.reasoning_effort !== route.effort || binding.reasoning_mode !== expectedReasoningMode(route)) throw new Error("RouteBinding reasoning mode does not match the approved route");
  if (binding.request_budget.max_output_tokens !== Math.max(1, route.maxOutputTokens)
    || binding.request_budget.max_input_tokens !== 64_000
    || binding.request_budget.max_tool_calls !== route.maxToolTurns
    || binding.request_budget.max_wall_time_ms !== route.timeoutMs
    || binding.request_budget.max_estimated_cost_usd !== null
    || binding.request_budget.billing_mode !== "unknown") throw new Error("RouteBinding request budget does not match the approved route");
  if (route.provider === "deepseek") {
    if (!/^deepseek-v4-(?:flash|pro)$/.test(binding.model_id)) throw new Error("DeepSeek RouteBinding model family is invalid");
    exact(binding.endpoint_origin, DEEPSEEK_ENDPOINT_ORIGIN, "DeepSeek endpoint origin");
    exact(binding.endpoint_path, DEEPSEEK_ENDPOINT_PATH, "DeepSeek endpoint path");
    exact(binding.wire_protocol, "chat_completions", "DeepSeek wire protocol");
    if (![DEEPSEEK_ENV_AUTH_ALIAS, DEEPSEEK_DPAPI_AUTH_ALIAS].includes(binding.auth_alias ?? "")) throw new Error("DeepSeek auth alias is not approved");
    exactArray(binding.network_scope, [DEEPSEEK_ENDPOINT_ORIGIN], "DeepSeek network scope");
    const expectedEnvironment = binding.auth_alias === DEEPSEEK_ENV_AUTH_ALIAS
      ? ["DEEPSEEK_API_KEY"] : ["CODEX_ROUTER_SECRET_PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"];
    exactArray(binding.environment_scope, expectedEnvironment, "DeepSeek environment scope");
    exactArray(binding.command_scope, binding.auth_alias === DEEPSEEK_DPAPI_AUTH_ALIAS ? ["powershell-dpapi-decrypt"] : [], "DeepSeek command scope");
  } else if (route.provider === "openai-codex") {
    if (!/^gpt-5\.6-(?:terra|sol)$/.test(binding.model_id)) throw new Error("OpenAI RouteBinding model family is invalid");
    exact(binding.endpoint_origin, OPENAI_ENDPOINT_ORIGIN, "OpenAI endpoint origin");
    exact(binding.endpoint_path, OPENAI_ENDPOINT_PATH, "OpenAI endpoint path");
    exact(binding.wire_protocol, "responses", "OpenAI wire protocol");
    exact(binding.auth_alias, CODEX_AUTH_ALIAS, "OpenAI auth alias");
    exactArray(binding.network_scope, [OPENAI_ENDPOINT_ORIGIN], "OpenAI network scope");
    exactArray(binding.environment_scope, ["CODEX_HOME"], "OpenAI environment scope");
    exactArray(binding.command_scope, ["codex-cli"], "OpenAI command scope");
  } else {
    exact(binding.endpoint_origin, "local://quality-gate", "Local endpoint origin");
    exact(binding.endpoint_path, "/validate", "Local endpoint path");
    exact(binding.wire_protocol, "local", "Local wire protocol");
    if (binding.auth_alias !== null || binding.network_scope.length || binding.environment_scope.length || binding.command_scope.length) throw new Error("Local RouteBinding cannot carry external capabilities");
  }
  const targetUrl = route.provider === "local" ? `${binding.endpoint_origin}${binding.endpoint_path}` : new URL(binding.endpoint_path, `${binding.endpoint_origin}/`).href;
  return { binding, targetUrl };
}

export function assertExecutorGrantMatchesBinding(grant: ExecutorCapabilityGrant, binding: RouteBinding): void {
  exactArray(grant.readManifest.map(entry => entry.path).sort(), [...binding.read_scope].sort(), "executor read manifest");
  exactArray(grant.writeScope, binding.write_scope, "executor write scope");
}

export function adapterIdFor(provider: Provider): string {
  if (provider === "deepseek") return DEEPSEEK_ADAPTER_ID;
  if (provider === "openai-codex") return CODEX_ADAPTER_ID;
  return LOCAL_ADAPTER_ID;
}

function expectedReasoningMode(route: RouteDecision): RouteBinding["reasoning_mode"] {
  if (route.provider === "local") return "local";
  return route.effort === "none" ? "disabled" : "enabled";
}
function exact(actual: unknown, expected: unknown, name: string): void { if (actual !== expected) throw new Error(`${name} does not match the approved binding`); }
function exactArray(actual: readonly string[], expected: readonly string[], name: string): void {
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) throw new Error(`${name} does not match the approved binding`);
}
