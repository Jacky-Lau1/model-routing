import { SafeExecutor } from "../safe-executor.js";
import { assertExecutorGrantMatchesBinding, DEEPSEEK_ADAPTER_ID, preflightRouteBinding } from "../route-preflight.js";
import { PRICING_CATALOG, priceUsageUsd, worstCaseRoundUsd } from "../cost.js";
import { stableHash } from "../canonical.js";
import type { AttemptUsage, ProviderAdapter, ProviderBudgetState, ProviderRequest, ProviderResponse, ProviderRouteEvidence, ProviderTransportRound, RequestIdSource, RouteTransportObservation, UsageAvailability, UsageMetrics } from "../types.js";

interface DeepSeekOptions {
  fetchImpl?: typeof fetch;
  credentialResolver?: (authAlias: string) => string | undefined | Promise<string | undefined>;
  now?: () => Date;
}
type Message = Record<string, unknown>;
interface TransportResponse {
  payload: any | null;
  requestId: string | null;
  requestIdSource: RequestIdSource;
  observation: RouteTransportObservation;
  valid: boolean;
  round: ProviderTransportRound;
}

export class DeepSeekTransportError extends Error {
  readonly transportRounds: ProviderTransportRound[];
  constructor(error: unknown, rounds: ProviderTransportRound[]) {
    super(error instanceof Error ? error.message : String(error)); this.name = "DeepSeekTransportError";
    this.transportRounds = [...rounds];
  }
}

export class DeepSeekChatAdapter implements ProviderAdapter {
  readonly provider = "deepseek" as const;
  readonly adapterId = DEEPSEEK_ADAPTER_ID;
  private readonly credentialCache = new WeakMap<ProviderRequest, string>();
  constructor(private readonly options: DeepSeekOptions = {}) {}

  async preflight(request: ProviderRequest): Promise<void> {
    if (request.route.provider !== "deepseek") throw new Error("DeepSeek adapter received a non-DeepSeek route");
    if (!request.routeBinding) throw new Error("DeepSeek invocation requires an immutable RouteBinding");
    preflightRouteBinding(request.routeBinding, request.route, DEEPSEEK_ADAPTER_ID, request.contractProvenance ?? "legacy_bridge");
    if (request.sensitivity !== "normal") throw new Error("Sensitive task cannot be sent to DeepSeek");
    const codeExecution = request.stage === "EXECUTE" || request.stage === "REPAIR";
    if (!codeExecution && request.executorCapabilities) throw new Error("Non-code DeepSeek stages cannot receive filesystem capabilities");
    if (codeExecution && (!request.workingDirectory || !request.executorCapabilities)) throw new Error("DeepSeek code execution requires an approved capability grant");
    if (request.executorCapabilities) {
      assertExecutorGrantMatchesBinding(request.executorCapabilities, request.routeBinding);
      await new SafeExecutor(request.workingDirectory!, request.executorCapabilities).preflight();
    }
    if ((request.contractProvenance ?? "legacy_bridge") === "canonical") {
      const messages: Message[] = [{ role: "system", content: request.stablePrefix }, { role: "user", content: `${request.projectSummary}\n\n${request.dynamicInput}` }];
      const remainingOutput = Math.min(request.route.maxOutputTokens, request.routeBinding.request_budget.max_output_tokens - (request.budgetState?.output_tokens_used ?? 0));
      assertPreSendBudget(request, buildBody(request, messages, request.executorCapabilities ? TOOL_DEFINITIONS : undefined, remainingOutput), [], this.now());
    }
    if (!this.credentialCache.has(request)) {
      const apiKey = normalizeApiKey(await this.options.credentialResolver?.(request.routeBinding.auth_alias!));
      if (!apiKey) throw new Error("DeepSeek authentication is unavailable");
      this.credentialCache.set(request, apiKey);
    }
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    await this.preflight(request);
    const binding = request.routeBinding!;
    const targetUrl = preflightRouteBinding(binding, request.route, DEEPSEEK_ADAPTER_ID, request.contractProvenance ?? "legacy_bridge").targetUrl;
    const codeExecution = request.stage === "EXECUTE" || request.stage === "REPAIR";
    const executor = codeExecution && request.workingDirectory && request.executorCapabilities
      ? new SafeExecutor(request.workingDirectory, request.executorCapabilities)
      : undefined;
    const apiKey = this.credentialCache.get(request)!;
    const messages: Message[] = [
      { role: "system", content: request.stablePrefix },
      { role: "user", content: `${request.projectSummary}\n\n${request.dynamicInput}` },
    ];
    const usage = emptyUsage(); const usageAvailability: UsageAvailability = { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true }; const requestIds: string[] = []; const requestIdSources = new Set<RequestIdSource>(); const observations: RouteTransportObservation[] = []; const rounds: ProviderTransportRound[] = []; let toolCallsUsed = 0; let finalContentNudges = 0;
    const tools = executor ? TOOL_DEFINITIONS : undefined;
    for (let turn = 0; turn <= request.route.maxToolTurns; turn++) {
      const prior = budgetProgress(request.budgetState, rounds);
      const remainingOutput = Math.min(request.route.maxOutputTokens, binding.request_budget.max_output_tokens - prior.output_tokens_used);
      if (remainingOutput < 1) throw new DeepSeekTransportError(new Error("No approved output-token budget remains for another provider request"), rounds);
      const body = buildBody(request, messages, tools, remainingOutput);
      try { assertPreSendBudget(request, body, rounds, this.now()); }
      catch (error) { throw new DeepSeekTransportError(error, rounds); }
      let transport: TransportResponse;
      try { transport = await this.call(body, apiKey, binding.request_budget.max_request_wall_time_ms, targetUrl, binding.model_id, request.stage, turn); }
      catch (error) {
        if (error instanceof DeepSeekTransportError) throw new DeepSeekTransportError(error, [...rounds, ...error.transportRounds]);
        throw error;
      }
      observations.push(transport.observation);
      rounds.push(transport.round);
      if (!transport.valid) return invalidProviderResponse(request, transport, usage, unavailableUsage(), observations, rounds);
      requestIds.push(transport.requestId!);
      requestIdSources.add(transport.requestIdSource);
      const response = transport.payload;
      const canonical = (request.contractProvenance ?? "legacy_bridge") === "canonical";
      const roundUsage = parseCompleteUsage(response.usage);
      if (!roundUsage) {
        if (!canonical) {
          const partial = parseLenientUsage(response.usage); accumulateAttemptUsage(usage, partial);
          for (const key of Object.keys(usageAvailability) as Array<keyof UsageAvailability>) usageAvailability[key] = false;
          rounds[rounds.length - 1] = { ...transport.round, usage: null, cache_status: "unknown" };
        } else {
        rounds[rounds.length - 1] = { ...transport.round, outcome: "REJECTED", failure_class: "usage_unavailable", usage: null, cache_status: "unknown" };
        throw new DeepSeekTransportError(new Error("DeepSeek usage or cache categories were unavailable"), rounds);
        }
      } else {
        const pricing = priceUsageUsd("deepseek", binding.model_id, roundUsage, new Date(transport.round.started_at));
        rounds[rounds.length - 1] = { ...transport.round, usage: roundUsage, cache_status: cacheStatus(roundUsage), estimated_list_cost_usd: pricing.usd, pricing_catalog_version: PRICING_CATALOG.version, pricing_catalog_hash: PRICING_CATALOG.catalog_hash, pricing_time_band: pricing.time_band };
        accumulateAttemptUsage(usage, roundUsage);
        if (canonical) assertPostResponseBudget(request, rounds);
      }
      const choice = response.choices?.[0];
      const assistant = choice?.message;
      if (!assistant) throw new DeepSeekTransportError(new Error("DeepSeek returned no assistant message"), rounds);
      const toolCalls = assistant.tool_calls as Array<any> | undefined;
      if (!toolCalls?.length) {
        const text = typeof assistant.content === "string" ? assistant.content : "";
        if (!text) {
          const finishReason = choice?.finish_reason;
          if (finishReason === "length") throw new DeepSeekTransportError(new Error("DeepSeek output was truncated by the token limit before producing a final answer"), rounds);
          if (finishReason === "tool_calls") throw new DeepSeekTransportError(new Error("DeepSeek signalled tool calls but returned none"), rounds);
          // Genuine empty final message: give the model one bounded nudge to emit the final answer,
          // reusing the normal pre-send budget gate so a request-count/cost ceiling still applies.
          if (finalContentNudges >= MAX_FINAL_CONTENT_NUDGES) throw new DeepSeekTransportError(new Error(`DeepSeek returned no final content after ${MAX_FINAL_CONTENT_NUDGES} retry`), rounds);
          finalContentNudges++;
          messages.push({ role: "assistant", content: "", reasoning_content: assistant.reasoning_content ?? "" });
          messages.push({ role: "user", content: "Continue and provide the final answer now." });
          continue;
        }
        const requestId = requestIds[0] ?? null;
        return {
          text, requestId, provider: "deepseek", model: binding.model_id, usage, usageAvailability,
          routeEvidence: routeEvidence(request, requestIds, requestIdSource(requestIdSources), observations),
          structuredPatches: executor?.proposals(), providerReportedCostUsd: completeProviderReportedCost(rounds),
          estimatedListCostUsd: rounds.every(item => item.estimated_list_cost_usd !== null) ? sumEstimatedCost(rounds) : null, transportRounds: rounds.map(item => ({ ...item, usage: item.usage ? { ...item.usage } : null })),
        };
      }
      if (turn >= request.route.maxToolTurns) throw new DeepSeekTransportError(new Error(`Tool-turn budget exceeded: ${request.route.maxToolTurns}`), rounds);
      // DeepSeek requires reasoning_content to be replayed for every assistant tool-call turn.
      messages.push({ role: "assistant", content: assistant.content ?? "", reasoning_content: assistant.reasoning_content ?? "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        toolCallsUsed++;
        if (toolCallsUsed > request.route.maxToolTurns) throw new DeepSeekTransportError(new Error(`Tool-call budget exceeded: ${request.route.maxToolTurns}`), rounds);
        if (!executor) throw new DeepSeekTransportError(new Error("DeepSeek returned a tool call without an approved capability grant"), rounds);
        const result = await executeTool(call.function?.name, parseArguments(call.function?.arguments), executor);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new DeepSeekTransportError(new Error("DeepSeek tool loop ended without a final response"), rounds);
  }

  private async call(body: Record<string, unknown>, apiKey: string, timeoutMs: number, targetUrl: string, expectedModel: string, stage: ProviderRequest["stage"], sequence: number): Promise<TransportResponse> {
    const started = this.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(targetUrl, {
          method: "POST", redirect: "manual", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
        });
      } catch (error) {
        const completed = this.now();
        const round = transportRound(stage, sequence, started, completed, { requestId: null, model: null, origin: null, path: null, status: null, outcome: "AMBIGUOUS", failure: classifyTransportFailure(error) });
        throw new DeepSeekTransportError(error, [round]);
      }
      const responseUrl = response.url || null;
      const parsed = parseObservedUrl(responseUrl);
      const base: RouteTransportObservation = {
        targetUrl, responseUrl, actualOrigin: parsed?.origin ?? null, actualPath: parsed?.pathname ?? null,
        actualModel: null, requestId: null, requestIdSource: "not_available", status: response.status,
        bodyResponseId: null, headerRequestId: null, headerRequestIdName: null,
        redirected: response.redirected, routeTupleVerified: false, failureReason: null,
      };
      const rejected = (failure: string, observation = base) => invalidTransport(observation, failure, transportRound(stage, sequence, started, this.now(), { requestId: observation.requestId, model: observation.actualModel, origin: observation.actualOrigin, path: observation.actualPath, status: observation.status, outcome: "REJECTED", failure }));
      if (response.redirected || (response.status >= 300 && response.status < 400)) return rejected("redirect_rejected");
      if (!responseUrl || responseUrl !== targetUrl) return rejected("response_url_mismatch");
      const text = await response.text();
      if (!response.ok) return rejected("http_status_rejected");
      let payload: any;
      try { payload = JSON.parse(text); } catch { return rejected("response_json_invalid"); }
      const actualModel = payload && typeof payload === "object" && typeof payload.model === "string" ? payload.model : null;
      const withModel = { ...base, actualModel };
      if (actualModel !== expectedModel) return rejected("response_model_mismatch", withModel);
      try {
        const bodyId = cleanRequestId(payload.id);
        const headerCandidates = (["x-request-id", "x-ds-request-id", "request-id"] as const)
          .map(name => ({ name, value: cleanRequestId(response.headers.get(name)) }))
          .filter((entry): entry is { name: "x-request-id" | "x-ds-request-id" | "request-id"; value: string } => entry.value !== null);
        if (headerCandidates.length > 1) return rejected("multiple_request_id_headers", { ...withModel, bodyResponseId: bodyId });
        const header = headerCandidates[0]; const headerId = header?.value ?? null;
        const requestId = headerId ?? bodyId;
        const requestIdSource: RequestIdSource = bodyId && headerId ? "body_and_header" : bodyId ? "body" : headerId ? "header" : "not_available";
        const withIds = { ...withModel, requestId, requestIdSource, bodyResponseId: bodyId, headerRequestId: headerId, headerRequestIdName: header?.name ?? null };
        if (!requestId) return rejected("provider_request_id_unavailable", withIds);
        const observation = { ...withIds, routeTupleVerified: true };
        const round = transportRound(stage, sequence, started, this.now(), { requestId, model: actualModel, origin: parsed?.origin ?? null, path: parsed?.pathname ?? null, status: response.status, outcome: "SUCCEEDED", failure: null });
        return { payload, requestId, requestIdSource, observation, valid: true, round };
      } catch { return rejected("request_id_invalid", withModel); }
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

function invalidProviderResponse(request: ProviderRequest, transport: TransportResponse, usage: UsageMetrics, usageAvailability: UsageAvailability, observations: RouteTransportObservation[], rounds: ProviderTransportRound[]): ProviderResponse {
  return {
    text: "Provider response rejected before local tool processing", requestId: transport.requestId,
    provider: "deepseek", model: transport.observation.actualModel ?? "", usage, usageAvailability,
    transportRounds: rounds.map(item => ({ ...item, usage: item.usage ? { ...item.usage } : null })), providerReportedCostUsd: null, estimatedListCostUsd: rounds.every(item => item.estimated_list_cost_usd !== null) ? sumEstimatedCost(rounds) : null,
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

function invalidTransport(observation: RouteTransportObservation, failureReason: string, round: ProviderTransportRound): TransportResponse {
  return { payload: null, requestId: observation.requestId, requestIdSource: observation.requestIdSource, observation: { ...observation, routeTupleVerified: false, failureReason }, valid: false, round };
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

const MAX_FINAL_CONTENT_NUDGES = 1;
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
function unavailableUsage(): UsageAvailability { return { inputTokens: false, outputTokens: false, reasoningTokens: false, cacheHitTokens: false, cacheMissTokens: false }; }
function buildBody(request: ProviderRequest, messages: Message[], tools: unknown, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.route.model, messages, stream: false, max_tokens: maxTokens, thinking: { type: request.route.effort === "none" ? "disabled" : "enabled" } };
  if (request.route.effort !== "none") body.reasoning_effort = "high";
  if (tools) body.tools = tools;
  return body;
}
function zeroBudget(): ProviderBudgetState { return { attempts_used: 0, provider_requests_used: 0, input_tokens_used: 0, output_tokens_used: 0, wall_clock_time_ms_used: 0, estimated_list_cost_usd: 0 }; }
function budgetProgress(prior: ProviderBudgetState | undefined, rounds: ProviderTransportRound[]): ProviderBudgetState {
  const base = prior ?? zeroBudget();
  return rounds.reduce((total, item) => ({
    ...total,
    provider_requests_used: total.provider_requests_used + 1,
    input_tokens_used: total.input_tokens_used + (item.usage?.input_tokens ?? 0),
    output_tokens_used: total.output_tokens_used + (item.usage?.output_tokens ?? 0),
    wall_clock_time_ms_used: total.wall_clock_time_ms_used + (item.wall_clock_time_ms ?? 0),
    estimated_list_cost_usd: roundUsd(total.estimated_list_cost_usd + (item.estimated_list_cost_usd ?? 0)),
  }), { ...base });
}
function assertPreSendBudget(request: ProviderRequest, body: Record<string, unknown>, rounds: ProviderTransportRound[], at: Date): void {
  if ((request.contractProvenance ?? "legacy_bridge") !== "canonical") return;
  const binding = request.routeBinding!; const budget = binding.request_budget; const progress = budgetProgress(request.budgetState, rounds);
  if (progress.attempts_used >= budget.max_attempts) throw new Error("No approved provider-attempt budget remains");
  if (progress.provider_requests_used + 1 > budget.max_provider_requests) throw new Error("Next provider request would exceed the approved request-count budget");
  // Estimate the next request's input-token upper bound from the serialized body. A UTF-8 byte
  // count over-estimates tokens ~3-4x for ASCII code and cannot be compared against a token budget;
  // divide by 3 to convert bytes to a conservative token ceiling (accurate for CJK, ~33% headroom
  // for ASCII) and keep a fixed 512-token margin.
  const serialized = JSON.stringify(body); const inputUpper = Math.ceil(Buffer.byteLength(serialized, "utf8") / 3) + 512;
  const outputUpper = Number(body.max_tokens);
  if (!Number.isInteger(outputUpper) || outputUpper < 1 || progress.input_tokens_used + inputUpper > budget.max_input_tokens || progress.output_tokens_used + outputUpper > budget.max_output_tokens) throw new Error("Next provider request cannot be proven within the approved token budget");
  if (progress.wall_clock_time_ms_used + budget.max_request_wall_time_ms > budget.max_wall_time_ms) throw new Error("Next provider request cannot be proven within the approved total wall budget");
  if (budget.max_estimated_cost_usd === null) throw new Error("Canonical external execution requires a non-null estimated list-price ceiling");
  const worst = worstCaseRoundUsd(binding.provider_id, binding.model_id, inputUpper, outputUpper, at);
  if (roundUsd(progress.estimated_list_cost_usd + worst) > budget.max_estimated_cost_usd) throw new Error("Next provider request worst-case list price exceeds the remaining approved cost budget");
}
function assertPostResponseBudget(request: ProviderRequest, rounds: ProviderTransportRound[]): void {
  const budget = request.routeBinding!.request_budget; const progress = budgetProgress(request.budgetState, rounds);
  if (progress.provider_requests_used > budget.max_provider_requests || progress.input_tokens_used > budget.max_input_tokens || progress.output_tokens_used > budget.max_output_tokens || progress.wall_clock_time_ms_used > budget.max_wall_time_ms) throw new DeepSeekTransportError(new Error("Actual provider usage exceeded the unchanged approved cumulative budget"), rounds);
  if (budget.max_estimated_cost_usd === null || progress.estimated_list_cost_usd > budget.max_estimated_cost_usd) throw new DeepSeekTransportError(new Error("Actual provider list-price estimate exceeded the unchanged approved cost budget"), rounds);
}
function parseCompleteUsage(source: any): AttemptUsage | null {
  if (!source || !integer(source.prompt_tokens) || !integer(source.completion_tokens) || !integer(source.prompt_cache_hit_tokens) || !integer(source.prompt_cache_miss_tokens)) return null;
  const reasoning = source.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && !integer(reasoning)) return null;
  return { input_tokens: source.prompt_tokens, output_tokens: source.completion_tokens, reasoning_tokens: reasoning ?? 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: source.prompt_cache_hit_tokens, cache_miss_tokens: source.prompt_cache_miss_tokens };
}
function parseLenientUsage(source: any): AttemptUsage {
  return { input_tokens: integer(source?.prompt_tokens) ? source.prompt_tokens : 0, output_tokens: integer(source?.completion_tokens) ? source.completion_tokens : 0, reasoning_tokens: integer(source?.completion_tokens_details?.reasoning_tokens) ? source.completion_tokens_details.reasoning_tokens : 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: integer(source?.prompt_cache_hit_tokens) ? source.prompt_cache_hit_tokens : 0, cache_miss_tokens: integer(source?.prompt_cache_miss_tokens) ? source.prompt_cache_miss_tokens : 0 };
}
function accumulateAttemptUsage(target: UsageMetrics, source: AttemptUsage): void { target.inputTokens += source.input_tokens; target.outputTokens += source.output_tokens; target.reasoningTokens += source.reasoning_tokens; target.cachedInputTokens += source.cached_input_tokens; target.cacheWriteTokens += source.cache_write_tokens; target.cacheHitTokens += source.cache_hit_tokens; target.cacheMissTokens += source.cache_miss_tokens; }
function cacheStatus(usage: AttemptUsage): ProviderTransportRound["cache_status"] { if (usage.input_tokens === 0) return "none"; if (usage.cache_hit_tokens > 0 && usage.cache_miss_tokens > 0) return "mixed"; if (usage.cache_hit_tokens > 0) return "hit"; if (usage.cache_miss_tokens > 0) return "miss"; return "unknown"; }
function transportRound(stage: ProviderRequest["stage"], sequence: number, started: Date, completed: Date, item: { requestId: string | null; model: string | null; origin: string | null; path: string | null; status: number | null; outcome: ProviderTransportRound["outcome"]; failure: string | null }): ProviderTransportRound {
  return { round_id: `round-${stableHash({ stage, sequence, started_at: started.toISOString() }).slice(0, 24)}`, sequence, stage, request_id: item.requestId, started_at: started.toISOString(), completed_at: completed.toISOString(), wall_clock_time_ms: Math.max(0, completed.getTime() - started.getTime()), response_model: item.model, response_origin: item.origin, response_path: item.path, http_status: item.status, outcome: item.outcome, failure_class: item.failure, usage: null, cache_status: "unknown", provider_reported_cost_usd: null, estimated_list_cost_usd: null, pricing_catalog_version: null, pricing_catalog_hash: null, pricing_time_band: null };
}
function classifyTransportFailure(error: unknown): string { const name = error instanceof Error ? error.name : "Error"; const code = (error as NodeJS.ErrnoException)?.code; return name === "AbortError" ? "timeout" : code === "ECONNRESET" ? "connection_reset" : "response_lost_or_transport_unknown"; }
function completeProviderReportedCost(rounds: ProviderTransportRound[]): number | null { return rounds.length > 0 && rounds.every(item => item.provider_reported_cost_usd !== null) ? roundUsd(rounds.reduce((sum, item) => sum + item.provider_reported_cost_usd!, 0)) : null; }
function sumEstimatedCost(rounds: ProviderTransportRound[]): number { return roundUsd(rounds.reduce((sum, item) => sum + (item.estimated_list_cost_usd ?? 0), 0)); }
function integer(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }
function roundUsd(value: number): number { return Math.round(value * 1e12) / 1e12; }
