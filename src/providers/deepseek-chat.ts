import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAllowedPath } from "../scope-guard.js";
import { loadDeepSeekApiKey } from "../credentials.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, UsageMetrics } from "../types.js";

interface DeepSeekOptions { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch }
type Message = Record<string, unknown>;

export class DeepSeekChatAdapter implements ProviderAdapter {
  readonly provider = "deepseek" as const;
  constructor(private readonly options: DeepSeekOptions = {}) {}

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.route.provider !== "deepseek") throw new Error("DeepSeek adapter received a non-DeepSeek route");
    if (request.sensitivity !== "normal") throw new Error("Sensitive task cannot be sent to DeepSeek");
    const apiKey = this.options.apiKey ?? loadDeepSeekApiKey();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek execution");
    const messages: Message[] = [
      { role: "system", content: request.stablePrefix },
      { role: "user", content: `${request.projectSummary}\n\n${request.dynamicInput}` },
    ];
    const usage = emptyUsage(); let requestId = ""; let actualModel = request.route.model;
    const tools = request.workingDirectory && request.allowedFiles?.length ? TOOL_DEFINITIONS : undefined;
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
        return { text, requestId, provider: "deepseek", model: actualModel, usage };
      }
      if (turn >= request.route.maxToolTurns) throw new Error(`Tool-turn budget exceeded: ${request.route.maxToolTurns}`);
      // DeepSeek requires reasoning_content to be replayed for every assistant tool-call turn.
      messages.push({ role: "assistant", content: assistant.content ?? "", reasoning_content: assistant.reasoning_content ?? "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        const result = await executeTool(call.function?.name, parseArguments(call.function?.arguments), request);
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
  tool("list_files", "List project files without reading their contents", { type: "object", properties: { directory: { type: "string" } }, additionalProperties: false }),
  tool("read_file", "Read a UTF-8 project file", { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false }),
  tool("write_file", "Write a complete UTF-8 file. Only approved paths are accepted", { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } }, additionalProperties: false }),
];
function tool(name: string, description: string, parameters: Record<string, unknown>) { return { type: "function", function: { name, description, parameters } }; }

async function executeTool(name: string, args: any, request: ProviderRequest): Promise<unknown> {
  const root = path.resolve(request.workingDirectory!);
  if (name === "list_files") {
    const directory = resolveInside(root, args.directory ?? ".");
    return listProjectFiles(root, directory);
  }
  if (name === "read_file") { const relative = normalize(args.path); assertNonSensitivePath(relative); const target = resolveInside(root, relative); if ((await stat(target)).size > 1_000_000) throw new Error("read_file limit is 1 MB"); return readFile(target, "utf8"); }
  if (name === "write_file") {
    const relative = normalize(args.path); assertNonSensitivePath(relative); if (!isAllowedPath(relative, request.allowedFiles ?? [])) throw new Error(`write_file denied outside approved scope: ${relative}`);
    const content = String(args.content); if (Buffer.byteLength(content) > 1_000_000) throw new Error("write_file limit is 1 MB");
    const target = resolveInside(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, "utf8"); return { written: relative, bytes: Buffer.byteLength(content) };
  }
  throw new Error(`Unknown DeepSeek tool: ${name}`);
}
async function listProjectFiles(root: string, start: string): Promise<string[]> {
  const output: string[] = []; const queue = [start]; const skipped = new Set([".git", "node_modules", "dist", ".router-state"]);
  while (queue.length && output.length < 2_000) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) queue.push(path.join(directory, entry.name)); }
      else if (entry.isFile()) { const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, "/"); if (!isSensitivePath(relative)) output.push(relative); }
      if (output.length >= 2_000) break;
    }
  }
  return output;
}
function assertNonSensitivePath(value: string): void { if (isSensitivePath(value)) throw new Error(`DeepSeek file access denied for sensitive path: ${value}`); }
function isSensitivePath(value: string): boolean { const normalized = `/${normalize(value).toLowerCase()}`; return /\/(?:\.env(?:\.|$)|secrets?(?:\/|$)|credentials?(?:\/|$))/.test(normalized) || /\.(?:pem|key|p12|pfx)$/.test(normalized); }
function resolveInside(root: string, value: string): string { const target = path.resolve(root, value); const relative = path.relative(root, target); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes project root"); return target; }
function normalize(value: string): string { return String(value).replace(/\\/g, "/").replace(/^\.\//, ""); }
function parseArguments(value: unknown): any { try { return JSON.parse(typeof value === "string" ? value : "{}"); } catch { throw new Error("DeepSeek tool arguments were not valid JSON"); } }
function emptyUsage(): UsageMetrics { return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; }
function accumulateUsage(target: UsageMetrics, source: any): void { target.inputTokens += source.prompt_tokens ?? 0; target.outputTokens += source.completion_tokens ?? 0; target.reasoningTokens += source.completion_tokens_details?.reasoning_tokens ?? 0; target.cacheHitTokens += source.prompt_cache_hit_tokens ?? 0; target.cacheMissTokens += source.prompt_cache_miss_tokens ?? 0; }
function redact(value: string): string { return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]").slice(0, 4_000); }
