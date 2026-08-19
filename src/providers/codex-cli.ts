import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, UsageMetrics } from "../types.js";

export interface CodexCliOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly provider = "openai-codex" as const;
  constructor(private readonly options: CodexCliOptions = {}) {}

  async supportsEphemeral(): Promise<boolean> {
    const result = await run(this.options.executable ?? "codex", ["exec", "--help"], "", this.options.environment, 15_000);
    return result.code === 0 && /--ephemeral\b/.test(`${result.stdout}\n${result.stderr}`);
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.route.provider !== "openai-codex") throw new Error(`Codex CLI cannot serve ${request.route.provider}`);
    if (!await this.supportsEphemeral()) throw new Error("Installed Codex CLI does not support --ephemeral; refusing persistent fallback");

    const args = ["exec", "--ephemeral", "--json", "--ignore-user-config", "--model", request.route.model,
      "--config", `model_reasoning_effort=\"${request.route.effort}\"`,
      "--config", "history.persistence=\"none\"",
      "--config", "memories.generate_memories=false",
      "--config", "memories.use_memories=false",
      "--config", "tool_output_token_limit=8000",
    ];
    if (request.workingDirectory) args.push("--cd", request.workingDirectory);
    const env = { ...(this.options.environment ?? process.env) };
    const isolatedHome = env.CODEX_ROUTER_HOME ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "CodexRouter", "codex-home") : undefined);
    if (isolatedHome && existsSync(path.join(isolatedHome, "auth.json"))) env.CODEX_HOME = isolatedHome;
    const prompt = [request.stablePrefix, `PROJECT_SUMMARY\n${request.projectSummary}`, `TASK_INPUT\n${request.dynamicInput}`].join("\n\n");
    const result = await run(this.options.executable ?? "codex", args, prompt, env, request.route.timeoutMs, { maxOutputTokens: request.route.maxOutputTokens, maxToolTurns: request.route.maxToolTurns });
    if (result.code !== 0) throw new Error(`Codex CLI failed (${result.code}): ${redact(result.stderr)}`);
    return parseJsonLines(result.stdout, request);
  }
}

interface ProcessResult { code: number; stdout: string; stderr: string }
interface RunLimits { maxOutputTokens: number; maxToolTurns: number }

async function run(executable: string, args: string[], input: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number, limits?: RunLimits): Promise<ProcessResult> {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let timedOut = false; let budgetError = ""; let pending = ""; let toolTurns = 0; let visibleCharacters = 0; let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk; pending += chunk;
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) {
      let event: any; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "item.started" && ["command_execution", "mcp_tool_call", "web_search", "function_call"].includes(event.item?.type)) toolTurns++;
      if (event.type === "item.completed" && event.item?.type === "agent_message") visibleCharacters += String(event.item.text ?? "").length;
      if (limits && toolTurns > limits.maxToolTurns) budgetError = `Tool-turn budget exceeded: ${toolTurns} > ${limits.maxToolTurns}`;
      if (limits && visibleCharacters > limits.maxOutputTokens * 4) budgetError = `Output budget exceeded: approximately ${Math.ceil(visibleCharacters / 4)} tokens`;
      if (budgetError) child.kill();
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdin.end(input);
  const [code] = await once(child, "close") as [number | null];
  clearTimeout(timer);
  if (spawnError) throw new Error(`Unable to start Codex CLI at ${executable}: ${spawnError.message}`);
  if (timedOut) throw new Error(`Provider timed out after ${timeoutMs}ms`);
  if (budgetError) throw new Error(budgetError);
  return { code: code ?? 1, stdout, stderr };
}

function parseJsonLines(output: string, request: ProviderRequest): ProviderResponse {
  let text = ""; let requestId = ""; let actualModel = request.route.model;
  const usage: UsageMetrics = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    requestId ||= event.response_id ?? event.request_id ?? event.id ?? "";
    actualModel = event.model ?? actualModel;
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? text;
    if (event.type === "response.completed" || event.type === "turn.completed") {
      const source = event.response?.usage ?? event.usage ?? {};
      usage.inputTokens = source.input_tokens ?? usage.inputTokens;
      usage.outputTokens = source.output_tokens ?? usage.outputTokens;
      usage.reasoningTokens = source.output_tokens_details?.reasoning_tokens ?? source.reasoning_tokens ?? usage.reasoningTokens;
      usage.cachedInputTokens = source.input_tokens_details?.cached_tokens ?? usage.cachedInputTokens;
      usage.cacheWriteTokens = source.input_tokens_details?.cache_write_tokens ?? usage.cacheWriteTokens;
      usage.cacheHitTokens = source.prompt_cache_hit_tokens ?? usage.cacheHitTokens;
      usage.cacheMissTokens = source.prompt_cache_miss_tokens ?? usage.cacheMissTokens;
    }
  }
  if (!text) throw new Error("Provider returned no final agent message");
  return { text, requestId: requestId || "unreported", provider: request.route.provider, model: actualModel, usage };
}

function redact(value: string): string { return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]").slice(-4_000); }
