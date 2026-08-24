#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { redactError } from "./redaction.js";
import { restrictMcpProcessEnvironment } from "./mcp-registration.js";
import type { RouterCoreService } from "./router-core.js";
import { createRouterCoreFromFiles, type RouterRuntimeFileOptions } from "./router-runtime.js";

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown }

const SERVER_INSTRUCTIONS = "Use router.prepare with only a minimal TaskPackage; never send full chat history or hidden reasoning. Show the returned approval summary to the user before router.execute. Poll router.status, inspect router.review_evidence, then call router.finalize with exactly PASS, REPAIR_REQUIRED, or BLOCKED. PASS enters APPLY_PENDING and never writes the main workspace. REPAIR_REQUIRED permits at most one router.repair under the unchanged approval. Call router.apply only as an explicit action; it never commits, merges, or pushes. Never widen scope, provider, model, budget, data egress, or retry AMBIGUOUS work.";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export class RouterMcpServer {
  constructor(private readonly core: RouterCoreService) {}

  async handle(message: unknown): Promise<unknown | undefined> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request");
    const request = message as JsonRpcRequest;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(request.id ?? null, -32600, "Invalid Request");
    const notification = request.id === undefined;
    try {
      if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return undefined;
      if (request.method === "initialize") {
        objectArgs(request.params, []);
        return notification ? undefined : rpcResult(request.id!, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-model-router", version: "0.1.0" }, instructions: SERVER_INSTRUCTIONS });
      }
      if (request.method === "ping") return notification ? undefined : rpcResult(request.id!, {});
      if (request.method === "tools/list") return notification ? undefined : rpcResult(request.id!, { tools: TOOLS });
      if (request.method === "tools/call") {
        const params = objectArgs(request.params, ["name", "arguments"]);
        if (typeof params.name !== "string") throw new Error("Tool name is required");
        const result = await this.callTool(params.name, params.arguments);
        return notification ? undefined : rpcResult(request.id!, toolResult(result));
      }
      return notification ? undefined : rpcError(request.id ?? null, -32601, "Method not found");
    } catch (error) {
      if (request.method === "tools/call" && !notification) return rpcResult(request.id!, toolError(error));
      return notification ? undefined : rpcError(request.id ?? null, -32602, redactError(error));
    }
  }

  private async callTool(name: string, value: unknown): Promise<unknown> {
    if (name === "router.prepare") {
      const args = objectArgs(value, ["task_package"]);
      return this.core.prepare(args.task_package as never);
    }
    if (name === "router.execute") {
      const args = objectArgs(value, ["task_id", "approval_summary_hash"]);
      return this.core.execute(textArg(args.task_id, "task_id"), textArg(args.approval_summary_hash, "approval_summary_hash"));
    }
    if (name === "router.status") {
      const args = objectArgs(value, ["task_id"]);
      return this.core.status(textArg(args.task_id, "task_id"));
    }
    if (name === "router.abort") {
      const args = objectArgs(value, ["task_id"]);
      return this.core.abort(textArg(args.task_id, "task_id"));
    }
    if (name === "router.review_evidence") {
      const args = objectArgs(value, ["task_id"]);
      return this.core.reviewEvidence(textArg(args.task_id, "task_id"));
    }
    if (name === "router.finalize") {
      const args = objectArgs(value, ["task_id", "evidence_bundle_hash", "decision", "summary"]);
      const decision = textArg(args.decision, "decision");
      if (decision !== "PASS" && decision !== "REPAIR_REQUIRED" && decision !== "BLOCKED") throw new Error("decision must be PASS, REPAIR_REQUIRED, or BLOCKED");
      return this.core.finalize(textArg(args.task_id, "task_id"), textArg(args.evidence_bundle_hash, "evidence_bundle_hash"), decision, textArg(args.summary, "summary"));
    }
    if (name === "router.repair") {
      const args = objectArgs(value, ["task_id", "evidence_bundle_hash", "approval_summary_hash"]);
      return this.core.repair(textArg(args.task_id, "task_id"), textArg(args.evidence_bundle_hash, "evidence_bundle_hash"), textArg(args.approval_summary_hash, "approval_summary_hash"));
    }
    if (name === "router.apply") {
      const args = objectArgs(value, ["task_id", "evidence_bundle_hash"]);
      return this.core.apply(textArg(args.task_id, "task_id"), textArg(args.evidence_bundle_hash, "evidence_bundle_hash"));
    }
    if (name === "router.pilot_report") { const args = objectArgs(value, ["task_id"]); return this.core.pilotReport(textArg(args.task_id, "task_id")); }
    throw new Error("Unknown Router tool");
  }
}

export async function runStdioMcpServer(core: RouterCoreService, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const server = new RouterMcpServer(core);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { output.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`); continue; }
    const response = await server.handle(message);
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}

const idSchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const hashSchema = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const stringArray = { type: "array", items: { type: "string" } } as const;
const egressPolicySchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "deny" } } },
    {
      type: "object", additionalProperties: false,
      required: ["mode", "providers", "paths", "content_hashes", "authorization_id", "authorized_by", "authorized_at", "expires_at"],
      properties: {
        mode: { const: "allow" }, providers: { type: "array", items: { enum: ["openai-codex", "deepseek", "local"] } },
        paths: stringArray, content_hashes: { type: "array", items: hashSchema }, authorization_id: idSchema,
        authorized_by: { const: "user" }, authorized_at: { type: "string", format: "date-time" }, expires_at: { type: ["string", "null"], format: "date-time" },
      },
    },
  ],
} as const;
const taskPackageSchema = {
  type: "object", additionalProperties: false,
  required: ["version", "task_id", "goal", "background_summary", "acceptance_criteria", "non_goals", "forbidden_actions", "read_scope", "write_scope", "relevant_interfaces", "context_manifest", "validation_requirements", "stop_conditions", "data_classification", "egress_policy", "request_budget", "created_at"],
  properties: {
    version: { const: 1 }, task_id: idSchema, goal: { type: "string" }, background_summary: { type: "string" },
    acceptance_criteria: stringArray, non_goals: stringArray, forbidden_actions: stringArray,
    read_scope: stringArray, write_scope: stringArray, relevant_interfaces: stringArray,
    context_manifest: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "kind", "selector", "content_hash", "source", "byte_length", "summary"], properties: { path: { type: "string" }, kind: { enum: ["file", "snippet", "symbol"] }, selector: { type: ["string", "null"] }, content_hash: hashSchema, source: { enum: ["workspace", "synthetic_fixture", "user_provided"] }, byte_length: { type: "integer", minimum: 0 }, summary: { type: "string" } } } },
    validation_requirements: stringArray, stop_conditions: stringArray,
    data_classification: { enum: ["public", "private", "secret_restricted"] },
    egress_policy: egressPolicySchema,
    request_budget: { type: "object", additionalProperties: false, required: ["max_attempts", "max_provider_requests", "max_input_tokens", "max_output_tokens", "max_tool_calls", "max_request_wall_time_ms", "max_wall_time_ms", "max_estimated_cost_usd", "billing_mode"], properties: { max_attempts: { type: "integer", minimum: 1 }, max_provider_requests: { type: "integer", minimum: 1 }, max_input_tokens: { type: "integer", minimum: 1 }, max_output_tokens: { type: "integer", minimum: 1 }, max_tool_calls: { type: "integer", minimum: 0 }, max_request_wall_time_ms: { type: "integer", minimum: 1 }, max_wall_time_ms: { type: "integer", minimum: 1 }, max_estimated_cost_usd: { type: ["number", "null"], minimum: 0 }, billing_mode: { enum: ["prepaid", "postpaid", "subscription", "unknown"] } } },
    created_at: { type: "string", format: "date-time" }, task_package_hash: hashSchema,
  },
} as const;

const TOOLS = [
  tool("router.prepare", "Validate one minimal TaskPackage and return the exact compact approval summary. No provider call.", { task_package: taskPackageSchema }, ["task_package"], false, true),
  tool("router.execute", "Execute only the exact approval summary hash returned by prepare, then run local quality gates.", { task_id: idSchema, approval_summary_hash: hashSchema }, ["task_id", "approval_summary_hash"], false, false, true),
  tool("router.status", "Read compact workflow, attempt, and evidence-reference status.", { task_id: idSchema }, ["task_id"], true, true),
  tool("router.abort", "Abort a workflow only when no provider execution lock is active.", { task_id: idSchema }, ["task_id"], false, true),
  tool("router.review_evidence", "Read the verified compact EvidenceBundle view and diff reference.", { task_id: idSchema }, ["task_id"], true, true),
  tool("router.finalize", "Record foreground GPT PASS, REPAIR_REQUIRED, or BLOCKED review bound to one EvidenceBundle. PASS only enters APPLY_PENDING.", { task_id: idSchema, evidence_bundle_hash: hashSchema, decision: { enum: ["PASS", "REPAIR_REQUIRED", "BLOCKED"] }, summary: { type: "string", minLength: 1, maxLength: 2000 } }, ["task_id", "evidence_bundle_hash", "decision", "summary"], false, true),
  tool("router.repair", "Run at most one provider repair attempt under the exact unchanged TaskPackage, RouteBinding, approval, scope, budget, and egress authorization.", { task_id: idSchema, evidence_bundle_hash: hashSchema, approval_summary_hash: hashSchema }, ["task_id", "evidence_bundle_hash", "approval_summary_hash"], false, false, true),
  tool("router.apply", "Explicitly apply PASS-reviewed bytes after main snapshot and target-preimage checks. Never commit, merge, or push.", { task_id: idSchema, evidence_bundle_hash: hashSchema }, ["task_id", "evidence_bundle_hash"], false, true),
  tool("router.pilot_report", "Read the immutable self-hashed PilotRunRecord derived only from persisted state, attempts, EvidenceBundle, quality acceptance, and Final Review.", { task_id: idSchema }, ["task_id"], true, true),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly: boolean, idempotent: boolean, openWorld = false) {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, required }, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld } };
}
function objectArgs(value: unknown, exact: string[]): Record<string, unknown> {
  if (value === undefined && exact.length === 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object");
  const result = value as Record<string, unknown>;
  if (exact.length && (Object.keys(result).length !== exact.length || exact.some(key => !(key in result)))) throw new Error("Arguments have unknown or missing fields");
  return result;
}
function textArg(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`); return value; }
function toolResult(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }
function toolError(error: unknown) { const message = redactError(error); return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }], structuredContent: { error: message } }; }
function rpcResult(id: JsonRpcId, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: JsonRpcId, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function main(): Promise<void> {
  restrictMcpProcessEnvironment(process.env);
  const program = new Command();
  program.name("router-mcp").description("Thin STDIO MCP transport over RouterCoreService")
    .requiredOption("--project <path>").requiredOption("--state-root <path>")
    .option("--mode <mode>", "pilot or synthetic", "pilot").option("--evidence-root <path>").option("--worktree-root <path>").option("--fixture-root <path>").option("--hidden-root <path>")
    .option("--quality-policy <path>").option("--quality-catalog <path>")
    .requiredOption("--user-policy <path>").requiredOption("--project-policy <path>").requiredOption("--route-profile <path>");
  program.parse();
  const options = program.opts<Record<string, string>>();
  if (options.mode !== "pilot" && options.mode !== "synthetic") throw new Error("mode must be pilot or synthetic");
  const core = await createRouterCoreFromFiles({ project: options.project, stateRoot: options.stateRoot, evidenceRoot: options.evidenceRoot, worktreeRoot: options.worktreeRoot, fixtureRoot: options.fixtureRoot, hiddenRoot: options.hiddenRoot, qualityPolicy: options.qualityPolicy, qualityCatalog: options.qualityCatalog, mode: options.mode, userPolicy: options.userPolicy, projectPolicy: options.projectPolicy, routeProfile: options.routeProfile } satisfies RouterRuntimeFileOptions);
  await runStdioMcpServer(core);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${JSON.stringify({ error: redactError(error) })}\n`); process.exitCode = 1; });
