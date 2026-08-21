import { SafeExecutor } from "../safe-executor.js";
import { assertExecutorGrantMatchesBinding, DEEPSEEK_ADAPTER_ID, preflightRouteBinding } from "../route-preflight.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, ProviderRouteEvidence, RequestIdSource, RouteTransportObservation, UsageMetrics } from "../types.js";

interface DeepSeekOptions {
  fetchImpl?: typeof fetch;
  credentialResolver?: (authAlias: string) => string | undefined | Promise<string | undefined>;
}
type Message = Record<string, unknown>;
interface TransportResponse {
  payload: any | null;
  requestId: string | null;
  requestIdSource: RequestIdSource;
  observation: RouteTransportObservation;
  valid: boolean;
}

export class DeepSeekChatAdapter implements ProviderAdapter {
  readonly provider = "deepseek" as const;
  readonly adapterId = DEEPSEEK_ADAPTER_ID;
  private readonly credentialCache = new WeakMap<ProviderRequest, string>();
  constructor(private readonly options: DeepSeekOptions = {}) {}

  async preflight(request: ProviderRequest): Promise<void> {
    if (request.route.provider !== "deepseek") throw new Error("DeepSeek adapter received a non-DeepSeek route");
    if (!request.routeBinding) throw new Error("DeepSeek invocation requires an immutable RouteBinding");
    preflightRouteBinding(request.routeBinding, request.route, DEEPSEEK_ADAPTER_ID);
    if (request.sensitivity !== "normal") throw new Error("Sensitive task cannot be sent to DeepSeek");
    const codeExecution = request.stage === "EXECUTE" || request.stage === "REPAIR";
    if (!codeExecution && request.executorCapabilities) throw new Error("Non-code DeepSeek stages cannot receive filesystem capabilities");
    if (codeExecution && (!request.workingDirectory || !request.executorCapabilities)) throw new Error("DeepSeek code execution requires an approved capability grant");
    if (request.executorCapabilities) {
      assertExecutorGrantMatchesBinding(request.executorCapabilities, request.routeBinding);
      await new SafeExecutor(request.workingDirectory!, request.executorCapabilities).preflight();
    }
    if (!this.credentialCache.has(request)) {
      const apiKey = normalizeApiKey(await this.options.credentialResolver?.(request.routeBinding.auth_alias!));
      if (!apiKey) throw new Error("DeepSeek authentication is unavailable");
      this.credentialCache.set(request, apiKey);
    }
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    await this.preflight(request);
    const binding = request.routeBinding!;
    const targetUrl = preflightRouteBinding(binding, request.route, DEEPSEEK_ADAPTER_ID).targetUrl;
    const codeExecution = request.stage === "EXECUTE" || request.stage === "REPAIR";
    const executor = codeExecution && request.workingDirectory && request.executorCapabilities
      ? new SafeExecutor(request.workingDirectory, request.executorCapabilities)
      : undefined;
    const apiKey = this.credentialCache.get(request)!;
    const messages: Message[] = [
      { role: "system", content: request.stablePrefix },
      { role: "user", content: `${request.projectSummary}\n\n${request.dynamicInput}` },
    ];
    const usage = emptyUsage(); const requestIds: string[] = []; const requestIdSources = new Set<RequestIdSource>(); const observations: RouteTransportObservation[] = []; let toolCallsUsed = 0;
    const tools = executor ? TOOL_DEFINITIONS : undefined;
    for (let turn = 0; turn <= request.route.maxToolTurns; turn++) {
      const body: Record<string, unknown> = {
        model: request.route.model, messages, stream: false, max_tokens: request.route.maxOutputTokens,
        thinking: { type: request.route.effort === "none" ? "disabled" : "enabled" },
      };
      if (request.route.effort !== "none") body.reasoning_effort = "high";
      if (tools) body.tools = tools;
      const transport = await this.call(body, apiKey, request.route.timeoutMs, targetUrl, binding.model_id);
      observations.push(transport.observation);
      if (!transport.valid) return invalidProviderResponse(request, transport, usage, observations);
      requestIds.push(transport.requestId!);
      requestIdSources.add(transport.requestIdSource);
      const response = transport.payload;
      accumulateUsage(usage, response.usage ?? {});
      const assistant = response.choices?.[0]?.message;
      if (!assistant) throw new Error("DeepSeek returned no assistant message");
      const toolCalls = assistant.tool_calls as Array<any> | undefined;
      if (!toolCalls?.length) {
        const text = typeof assistant.content === "string" ? assistant.content : "";
        if (!text) throw new Error("DeepSeek returned no final content");
        const requestId = requestIds[0] ?? null;
        return {
          text, requestId, provider: "deepseek", model: binding.model_id, usage,
          routeEvidence: routeEvidence(request, requestIds, requestIdSource(requestIdSources), observations),
          structuredPatches: executor?.proposals(),
        };
      }
      if (turn >= request.route.maxToolTurns) throw new Error(`Tool-turn budget exceeded: ${request.route.maxToolTurns}`);
      // DeepSeek requires reasoning_content to be replayed for every assistant tool-call turn.
      messages.push({ role: "assistant", content: assistant.content ?? "", reasoning_content: assistant.reasoning_content ?? "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        toolCallsUsed++;
        if (toolCallsUsed > request.route.maxToolTurns) throw new Error(`Tool-call budget exceeded: ${request.route.maxToolTurns}`);
        if (!executor) throw new Error("DeepSeek returned a tool call without an approved capability grant");
        const result = await executeTool(call.function?.name, parseArguments(call.function?.arguments), executor);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("DeepSeek tool loop ended without a final response");
  }

  private async call(body: Record<string, unknown>, apiKey: string, timeoutMs: number, targetUrl: string, expectedModel: string): Promise<TransportResponse> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(targetUrl, {
        method: "POST", redirect: "manual", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      const responseUrl = response.url || null;
      const parsed = parseObservedUrl(responseUrl);
      const base: RouteTransportObservation = {
        targetUrl, responseUrl, actualOrigin: parsed?.origin ?? null, actualPath: parsed?.pathname ?? null,
        actualModel: null, requestId: null, requestIdSource: "not_available", status: response.status,
        bodyResponseId: null, headerRequestId: null, headerRequestIdName: null,
        redirected: response.redirected, routeTupleVerified: false, failureReason: null,
      };
      if (response.redirected || (response.status >= 300 && response.status < 400)) return invalidTransport(base, "redirect_rejected");
      if (!responseUrl || responseUrl !== targetUrl) return invalidTransport(base, "response_url_mismatch");
      const text = await response.text();
      if (!response.ok) return invalidTransport(base, "http_status_rejected");
      let payload: any;
      try { payload = JSON.parse(text); } catch { return invalidTransport(base, "response_json_invalid"); }
      const actualModel = payload && typeof payload === "object" && typeof payload.model === "string" ? payload.model : null;
      const withModel = { ...base, actualModel };
      if (actualModel !== expectedModel) return invalidTransport(withModel, "response_model_mismatch");
      try {
        const bodyId = cleanRequestId(payload.id);
        const headerCandidates = (["x-request-id", "x-ds-request-id", "request-id"] as const)
          .map(name => ({ name, value: cleanRequestId(response.headers.get(name)) }))
          .filter((entry): entry is { name: "x-request-id" | "x-ds-request-id" | "request-id"; value: string } => entry.value !== null);
        if (headerCandidates.length > 1) return invalidTransport({ ...withModel, bodyResponseId: bodyId }, "multiple_request_id_headers");
        const header = headerCandidates[0]; const headerId = header?.value ?? null;
        const requestId = headerId ?? bodyId;
        const requestIdSource: RequestIdSource = bodyId && headerId ? "body_and_header" : bodyId ? "body" : headerId ? "header" : "not_available";
        const withIds = { ...withModel, requestId, requestIdSource, bodyResponseId: bodyId, headerRequestId: headerId, headerRequestIdName: header?.name ?? null };
        if (!requestId) return invalidTransport(withIds, "provider_request_id_unavailable");
        const observation = { ...withIds, routeTupleVerified: true };
        return { payload, requestId, requestIdSource, observation, valid: true };
      } catch { return invalidTransport(withModel, "request_id_invalid"); }
    } finally { clearTimeout(timer); }
  }
}

function routeEvidence(request: ProviderRequest, requestIds: string[], source: RequestIdSource, observations: RouteTransportObservation[]): ProviderRouteEvidence {
  const binding = request.routeBinding!;
  const final = observations.at(-1)!;
  return {
    routeBindingHash: binding.route_binding_hash, adapterId: DEEPSEEK_ADAPTER_ID,
    expectedProvider: "deepseek", expectedModel: binding.model_id,
    expectedOrigin: binding.endpoint_origin, expectedPath: binding.endpoint_path,
    actualOrigin: final.actualOrigin, actualPath: final.actualPath, actualModel: final.actualModel,
    wireProtocol: binding.wire_protocol, authAlias: binding.auth_alias,
    requestId: requestIds[0] ?? null, requestIds: [...requestIds], requestIdSource: source,
    bodyResponseIds: observations.map(item => item.bodyResponseId), headerRequestIds: observations.map(item => item.headerRequestId),
    redirectPolicy: "manual_error", redirected: false, routeTupleVerified: true,
    evidenceComplete: observations.length > 0 && observations.every(item => item.routeTupleVerified && item.requestId !== null),
    unverifiedReasons: ["network_peer_not_observable", "proxy_not_observable"], verificationStatus: "route_tuple_verified_peer_unobserved",
    observations: observations.map(item => ({ ...item })),
    peerVerification: "not_observable", proxyVerification: "not_observable",
  };
}

function invalidProviderResponse(request: ProviderRequest, transport: TransportResponse, usage: UsageMetrics, observations: RouteTransportObservation[]): ProviderResponse {
  return {
    text: "Provider response rejected before local tool processing", requestId: transport.requestId,
    provider: "deepseek", model: transport.observation.actualModel ?? "", usage,
    routeEvidence: {
      ...routeEvidenceBase(request), actualOrigin: transport.observation.actualOrigin, actualPath: transport.observation.actualPath,
      actualModel: transport.observation.actualModel, requestId: transport.requestId,
      requestIds: observations.flatMap(item => item.requestId ? [item.requestId] : []),
      bodyResponseIds: observations.map(item => item.bodyResponseId), headerRequestIds: observations.map(item => item.headerRequestId), requestIdSource: transport.requestIdSource,
      redirectPolicy: "manual_error", redirected: transport.observation.redirected, routeTupleVerified: false, evidenceComplete: false,
      unverifiedReasons: [transport.observation.failureReason ?? "route_evidence_incomplete", "network_peer_not_observable", "proxy_not_observable"], verificationStatus: "incomplete",
      observations: observations.map(item => ({ ...item })),
      peerVerification: "not_observable", proxyVerification: "not_observable",
    },
  };
}

function routeEvidenceBase(request: ProviderRequest) {
  const binding = request.routeBinding!;
  return {
    routeBindingHash: binding.route_binding_hash, adapterId: DEEPSEEK_ADAPTER_ID,
    expectedProvider: "deepseek" as const, expectedModel: binding.model_id,
    expectedOrigin: binding.endpoint_origin, expectedPath: binding.endpoint_path,
    wireProtocol: binding.wire_protocol, authAlias: binding.auth_alias,
  };
}

function invalidTransport(observation: RouteTransportObservation, failureReason: string): TransportResponse {
  return { payload: null, requestId: observation.requestId, requestIdSource: observation.requestIdSource, observation: { ...observation, routeTupleVerified: false, failureReason }, valid: false };
}

function parseObservedUrl(value: string | null): URL | null { if (!value) return null; try { return new URL(value); } catch { return null; } }

function cleanRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256 || /[\u0000-\u001f\u007f,]/.test(trimmed)) throw new Error("DeepSeek request ID was invalid");
  return trimmed;
}

function requestIdSource(sources: Set<RequestIdSource>): RequestIdSource {
  if (sources.has("body_and_header")) return "body_and_header";
  if (sources.has("body") && sources.has("header")) return "body_and_header";
  if (sources.has("body")) return "body";
  if (sources.has("header")) return "header";
  return "not_available";
}

const TOOL_DEFINITIONS = [
  tool("list_manifest", "List only the explicitly approved read manifest without reading file contents", { type: "object", properties: {}, additionalProperties: false }),
  tool("read_file", "Read one approved manifest file after path, classification, size, encoding, and hash checks", { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false }),
  tool("propose_patch", "Propose a complete UTF-8 replacement for local approval and preimage-checked application; this tool does not write", {
    type: "object", required: ["path", "preimageHash", "replacement"], additionalProperties: false,
    properties: { path: { type: "string" }, preimageHash: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, replacement: { type: "string" } },
  }),
];
function tool(name: string, description: string, parameters: Record<string, unknown>) { return { type: "function", function: { name, description, parameters } }; }

async function executeTool(name: string, args: any, executor: SafeExecutor): Promise<unknown> {
  if (name === "list_manifest") { assertExactArguments(args, []); return executor.listManifest(); }
  if (name === "read_file") { assertExactArguments(args, ["path"]); if (typeof args.path !== "string") throw new Error("read_file path must be a string"); return executor.readFile(args.path); }
  if (name === "propose_patch") { assertExactArguments(args, ["path", "preimageHash", "replacement"]); return executor.proposePatch(args); }
  throw new Error(`Unknown DeepSeek tool: ${name}`);
}
function assertExactArguments(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DeepSeek tool arguments must be an object");
  const actual = Object.keys(value as Record<string, unknown>);
  if (actual.length !== keys.length || !keys.every(key => actual.includes(key))) throw new Error("DeepSeek tool arguments had unknown or missing fields");
}
function parseArguments(value: unknown): any { try { return JSON.parse(typeof value === "string" ? value : "{}"); } catch { throw new Error("DeepSeek tool arguments were not valid JSON"); } }
function normalizeApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("DeepSeek authentication value is invalid");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 512) throw new Error("DeepSeek authentication value is invalid");
  return trimmed;
}
function emptyUsage(): UsageMetrics { return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; }
function accumulateUsage(target: UsageMetrics, source: any): void { target.inputTokens += source.prompt_tokens ?? 0; target.outputTokens += source.completion_tokens ?? 0; target.reasoningTokens += source.completion_tokens_details?.reasoning_tokens ?? 0; target.cacheHitTokens += source.prompt_cache_hit_tokens ?? 0; target.cacheMissTokens += source.prompt_cache_miss_tokens ?? 0; }
