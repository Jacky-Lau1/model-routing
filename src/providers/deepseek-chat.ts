import { loadDeepSeekApiKey } from "../credentials.js";
import { SafeExecutor } from "../safe-executor.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, UsageMetrics } from "../types.js";

interface DeepSeekOptions { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch }
type Message = Record<string, unknown>;

export class DeepSeekChatAdapter implements ProviderAdapter {
  readonly provider = "deepseek" as const;
  constructor(private readonly options: DeepSeekOptions = {}) {}

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.route.provider !== "deepseek") throw new Error("DeepSeek adapter received a non-DeepSeek route");
    if (request.sensitivity !== "normal") throw new Error("Sensitive task cannot be sent to DeepSeek");
    const codeExecution = request.stage === "EXECUTE" || request.stage === "REPAIR";
    if (!codeExecution && request.executorCapabilities) throw new Error("Non-code DeepSeek stages cannot receive filesystem capabilities");
    if (codeExecution && (!request.workingDirectory || !request.executorCapabilities)) throw new Error("DeepSeek code execution requires an approved capability grant");
    const executor = codeExecution && request.workingDirectory && request.executorCapabilities
      ? new SafeExecutor(request.workingDirectory, request.executorCapabilities)
      : undefined;
    await executor?.preflight();
    const apiKey = normalizeApiKey(this.options.apiKey ?? loadDeepSeekApiKey());
    if (!apiKey) throw new Error("DeepSeek authentication is unavailable");
    const messages: Message[] = [
      { role: "system", content: request.stablePrefix },
      { role: "user", content: `${request.projectSummary}\n\n${request.dynamicInput}` },
    ];
    const usage = emptyUsage(); let requestId = ""; let actualModel = request.route.model; let toolCallsUsed = 0;
    const tools = executor ? TOOL_DEFINITIONS : undefined;
    for (let turn = 0; turn <= request.route.maxToolTurns; turn++) {
      const body: Record<string, unknown> = {
        model: request.route.model, messages, stream: false, max_tokens: request.route.maxOutputTokens,
        thinking: { type: request.route.effort === "none" ? "disabled" : "enabled" },
      };
      if (request.route.effort !== "none") body.reasoning_effort = "high";
      if (tools) body.tools = tools;
      const response = await this.call(body, apiKey, request.route.timeoutMs);
      requestId ||= response.id ?? "unreported"; actualModel = response.model ?? actualModel;
      accumulateUsage(usage, response.usage ?? {});
      const assistant = response.choices?.[0]?.message;
      if (!assistant) throw new Error("DeepSeek returned no assistant message");
      const toolCalls = assistant.tool_calls as Array<any> | undefined;
      if (!toolCalls?.length) {
        const text = typeof assistant.content === "string" ? assistant.content : "";
        if (!text) throw new Error("DeepSeek returned no final content");
        return { text, requestId, provider: "deepseek", model: actualModel, usage, structuredPatches: executor?.proposals() };
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

  private async call(body: Record<string, unknown>, apiKey: string, timeoutMs: number): Promise<any> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${(this.options.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${redact(text)}`);
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
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
function redact(value: string): string { return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]").slice(0, 4_000); }
