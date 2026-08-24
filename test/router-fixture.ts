import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createProjectPolicy, createUserPolicy } from "../src/policy.js";
import { PRICING_CATALOG_HASH, PRICING_CATALOG_VERSION } from "../src/cost.js";
import { LocalValidationAdapter } from "../src/providers/local.js";
import { DEFAULT_QUALITY_GATE_POLICY } from "../src/quality-gate.js";
import { DEEPSEEK_ADAPTER_ID, DEEPSEEK_ENDPOINT_ORIGIN, DEEPSEEK_ENDPOINT_PATH, DEEPSEEK_ENV_AUTH_ALIAS } from "../src/route-preflight.js";
import { RouterCoreService, type RouterRouteProfile } from "../src/router-core.js";
import { GitWorktreeManager } from "../src/worktree.js";
import type { ProviderAdapter, ProviderBudgetState, ProviderRequest, ProviderResponse, RequestBudget, TaskPackage } from "../src/types.js";

const usage = { inputTokens: 12, outputTokens: 7, reasoningTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 12 };

export class CanonicalMockDeepSeek implements ProviderAdapter {
  readonly provider = "deepseek" as const;
  readonly adapterId = DEEPSEEK_ADAPTER_ID;
  sends = 0;
  budgetStates: ProviderBudgetState[] = [];
  constructor(readonly repairBehavior: "success" | "invalid_scope" | "transport_failure" = "success") {}
  preflight(_request: ProviderRequest): void {}
  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    this.budgetStates.push({ ...request.budgetState! });
    this.sends++;
    if (request.stage === "REPAIR" && this.repairBehavior === "transport_failure") throw new Error("synthetic reviewer-requested repair transport unavailable");
    const target = path.join(request.workingDirectory!, "src", "parser.ts");
    const preimageHash = sha256(await readFile(target));
    const requestId = `synthetic-request-${this.sends}`;
    const binding = request.routeBinding!;
    const targetUrl = `${binding.endpoint_origin}${binding.endpoint_path}`;
    const hour = this.sends === 1 ? "07" : "05"; const startedAt = `2026-08-24T${hour}:00:00.000Z`; const completedAt = `2026-08-24T${hour}:00:00.010Z`;
    const roundUsage = { input_tokens: 12, output_tokens: 7, reasoning_tokens: 2, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 12 };
    const estimatedListCostUsd = this.sends === 1 ? 0.00001452 : 0.00000726;
    return {
      text: "synthetic execution complete", requestId, provider: "deepseek", model: binding.model_id, usage,
      providerReportedCostUsd: null, estimatedListCostUsd,
      transportRounds: [{ round_id: `round-synthetic-${this.sends}`, sequence: 0, stage: request.stage, request_id: requestId, started_at: startedAt, completed_at: completedAt, wall_clock_time_ms: 10, response_model: binding.model_id, response_origin: binding.endpoint_origin, response_path: binding.endpoint_path, http_status: 200, outcome: "SUCCEEDED", failure_class: null, usage: roundUsage, cache_status: "miss", provider_reported_cost_usd: null, estimated_list_cost_usd: estimatedListCostUsd, pricing_catalog_version: PRICING_CATALOG_VERSION, pricing_catalog_hash: PRICING_CATALOG_HASH, pricing_time_band: this.sends === 1 ? "peak" : "off_peak" }],
      structuredPatches: [{ path: request.stage === "REPAIR" && this.repairBehavior === "invalid_scope" ? "src/outside.ts" : "src/parser.ts", preimageHash, replacement: request.stage === "REPAIR" ? "export const parser = 3;\n" : "export const parser = 2;\n" }],
      routeEvidence: {
        routeBindingHash: binding.route_binding_hash, adapterId: binding.adapter_id,
        expectedProvider: binding.provider_id, expectedModel: binding.model_id, expectedOrigin: binding.endpoint_origin, expectedPath: binding.endpoint_path,
        actualOrigin: binding.endpoint_origin, actualPath: binding.endpoint_path, actualModel: binding.model_id,
        wireProtocol: binding.wire_protocol, authAlias: binding.auth_alias, requestId, requestIds: [requestId],
        bodyResponseIds: [requestId], headerRequestIds: [null], requestIdSource: "body",
        redirectPolicy: "manual_error", redirected: false, routeTupleVerified: true, evidenceComplete: true,
        unverifiedReasons: ["network_peer_not_observable", "proxy_not_observable"], verificationStatus: "route_tuple_verified_peer_unobserved",
        observations: [{ targetUrl, responseUrl: targetUrl, actualOrigin: binding.endpoint_origin, actualPath: binding.endpoint_path, actualModel: binding.model_id, requestId, requestIdSource: "body", bodyResponseId: requestId, headerRequestId: null, headerRequestIdName: null, status: 200, redirected: false, routeTupleVerified: true, failureReason: null }],
        peerVerification: "not_observable", proxyVerification: "not_observable",
      },
    };
  }
}

export async function canonicalFixture(options: { repairBehavior?: "success" | "invalid_scope" | "transport_failure" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-s7-"));
  const project = path.join(root, "project"); const state = path.join(root, "state"); const worktrees = path.join(root, "worktrees"); const sentinels = path.join(root, "sentinels");
  await mkdir(path.join(project, "src"), { recursive: true }); await mkdir(sentinels, { recursive: true });
  await writeFile(path.join(project, "src", "parser.ts"), "export const parser = 1;\n");
  await writeFile(path.join(sentinels, "provider.sentinel"), "gpt-provider-unchanged\n");
  await writeFile(path.join(sentinels, "config.sentinel"), "codex-config-unchanged\n");
  await writeFile(path.join(sentinels, "auth.sentinel"), "codex-auth-unchanged\n");
  await git(project, ["init"]); await git(project, ["config", "core.autocrlf", "false"]); await git(project, ["config", "user.email", "synthetic@example.invalid"]); await git(project, ["config", "user.name", "Synthetic Test"]); await git(project, ["add", "."]); await git(project, ["commit", "-m", "base"]);
  const contentHash = sha256(await readFile(path.join(project, "src", "parser.ts")));
  const budget = requestBudget();
  const repairPreimageHash = sha256("export const parser = 2;\n");
  const egress = { mode: "allow" as const, providers: ["deepseek" as const], paths: ["src/parser.ts"], content_hashes: [contentHash, repairPreimageHash], authorization_id: "synthetic-egress", authorized_by: "user" as const, authorized_at: "2026-08-24T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" };
  const userPolicy = createUserPolicy({ version: 1, policy_id: "synthetic-user", egress_policy: egress, read_scope: ["src/parser.ts"], write_scope: ["src/parser.ts"], budget_ceiling: budget });
  const projectPolicy = createProjectPolicy({ version: 1, policy_id: "synthetic-project", egress_policy: { mode: "allow", providers: ["deepseek"], paths: ["src/parser.ts"], content_hashes: [contentHash, repairPreimageHash] }, read_scope: ["src/parser.ts"], write_scope: ["src/parser.ts"], budget_ceiling: budget });
  const routeProfile: RouterRouteProfile = { version: 1, provider_id: "deepseek", adapter_id: DEEPSEEK_ADAPTER_ID, model_id: "deepseek-v4-flash", endpoint_origin: DEEPSEEK_ENDPOINT_ORIGIN, endpoint_path: DEEPSEEK_ENDPOINT_PATH, wire_protocol: "chat_completions", auth_alias: DEEPSEEK_ENV_AUTH_ALIAS, reasoning_mode: "enabled", reasoning_effort: "high", network_scope: [DEEPSEEK_ENDPOINT_ORIGIN], environment_scope: ["DEEPSEEK_API_KEY"], command_scope: [] };
  const task: Omit<TaskPackage, "task_package_hash"> = { version: 1, task_id: "synthetic-s7", goal: "Update the parser constant", background_summary: "A bounded synthetic source edit.", acceptance_criteria: ["parser exports 2"], non_goals: ["no API changes"], forbidden_actions: ["do not edit other files"], read_scope: ["src/parser.ts"], write_scope: ["src/parser.ts"], relevant_interfaces: ["parser"], context_manifest: [{ path: "src/parser.ts", kind: "file", selector: null, content_hash: contentHash, source: "synthetic_fixture", byte_length: Buffer.byteLength("export const parser = 1;\n"), summary: "Synthetic parser fixture" }], validation_requirements: ["local quality gate"], stop_conditions: ["stop on scope or evidence mismatch"], data_classification: "public", egress_policy: egress, request_budget: budget, created_at: "2026-08-24T00:00:00.000Z" };
  const model = new CanonicalMockDeepSeek(options.repairBehavior);
  const local = new LocalValidationAdapter({ policy: DEFAULT_QUALITY_GATE_POLICY, evidenceRoot: state });
  const core = new RouterCoreService({ project_directory: project, state_root: state, user_policy: userPolicy, project_policy: projectPolicy, route_profile: routeProfile }, { model_adapter: model, local_adapter: local, quality_policy: DEFAULT_QUALITY_GATE_POLICY, worktrees: new GitWorktreeManager({ stateRoot: state, managedRoot: worktrees }) });
  return { root, project, state, worktrees, sentinels, userPolicy, projectPolicy, routeProfile, task, model, core };
}

export async function directoryHash(directory: string): Promise<string> {
  const names = ["provider.sentinel", "config.sentinel", "auth.sentinel"];
  return sha256(Buffer.concat(await Promise.all(names.map(name => readFile(path.join(directory, name))))));
}

export function requestBudget(): RequestBudget { return { max_attempts: 2, max_provider_requests: 6, max_input_tokens: 4_000, max_output_tokens: 1_000, max_tool_calls: 2, max_request_wall_time_ms: 30_000, max_wall_time_ms: 300_000, max_estimated_cost_usd: 0.25, billing_mode: "prepaid" }; }
export function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

async function git(directory: string, args: string[]): Promise<void> {
  const child = spawn("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, "close") as [number];
  if (code !== 0) throw new Error(`synthetic git failed: ${stderr}`);
}
