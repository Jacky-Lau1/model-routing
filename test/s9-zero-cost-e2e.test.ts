import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAttemptExecutor, type AttemptCheckpoint } from "../src/attempt-executor.js";
import { AttemptPersistence } from "../src/attempt-persistence.js";
import { RouterMcpServer, runStdioMcpServer } from "../src/mcp.js";
import { createProjectPolicy, createUserPolicy } from "../src/policy.js";
import { DeepSeekChatAdapter } from "../src/providers/deepseek-chat.js";
import { LocalValidationAdapter } from "../src/providers/local.js";
import { createQualityGatePolicy, hashQualityCommandCatalog } from "../src/quality-gate.js";
import { RouterCoreService, type RouterRouteProfile } from "../src/router-core.js";
import { createRouterCoreFromFiles, type RouterRuntimeFileOptions } from "../src/router-runtime.js";
import { GitWorktreeManager } from "../src/worktree.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, QualityCommandSpec, TaskPackage } from "../src/types.js";
import { CanonicalMockDeepSeek, canonicalFixture, requestBudget } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

class ScenarioAdapter extends CanonicalMockDeepSeek {
  constructor(private readonly scenario: "success" | "scope" | "secret" | "usage" | "response_lost" | "preflight_failure" | "timeout" | "reset" | "failure" | "redaction" = "success") { super(); }

  override preflight(_request: ProviderRequest): void {
    if (this.scenario === "preflight_failure") throw new Error("synthetic local provider preflight failed before send");
  }

  override async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (["timeout", "reset", "failure", "redaction"].includes(this.scenario)) {
      this.sends++;
      if (this.scenario === "redaction") throw new Error("password=hunter22 at C:\\Users\\Synthetic\\private\\source.ts");
      const error = new Error(this.scenario === "timeout" ? "synthetic provider timeout" : this.scenario === "reset" ? "synthetic ECONNRESET" : "synthetic provider failure after send");
      if (this.scenario === "timeout") error.name = "AbortError";
      if (this.scenario === "reset") (error as NodeJS.ErrnoException).code = "ECONNRESET";
      throw error;
    }
    const response = await super.invoke(request);
    if (this.scenario === "scope") response.structuredPatches = [{ path: "src/outside.ts", preimageHash: null, replacement: "export const outside = true;\n" }];
    if (this.scenario === "secret") response.structuredPatches = [{ ...response.structuredPatches![0], replacement: "export const apiKey = 'sk-live-1234567890abcdef';\n" }];
    if (this.scenario === "usage") response.usage = { ...response.usage, inputTokens: request.routeBinding!.request_budget.max_input_tokens + 1 };
    if (this.scenario === "response_lost") response.requestId = null;
    return response;
  }
}

function coreFor(fixture: Awaited<ReturnType<typeof canonicalFixture>>, options: {
  model?: ProviderAdapter;
  routeProfile?: RouterRouteProfile;
  userPolicy?: typeof fixture.userPolicy;
  projectPolicy?: typeof fixture.projectPolicy;
  local?: ProviderAdapter;
  qualityPolicy?: ReturnType<typeof createQualityGatePolicy>;
  attempts?: DurableAttemptExecutor;
} = {}) {
  return new RouterCoreService({
    project_directory: fixture.project,
    state_root: fixture.state,
    user_policy: options.userPolicy ?? fixture.userPolicy,
    project_policy: options.projectPolicy ?? fixture.projectPolicy,
    route_profile: options.routeProfile ?? fixture.routeProfile,
  }, {
    model_adapter: options.model ?? fixture.model,
    local_adapter: options.local ?? new LocalValidationAdapter({ policy: options.qualityPolicy, evidenceRoot: fixture.state }),
    quality_policy: options.qualityPolicy,
    attempts: options.attempts,
    worktrees: new GitWorktreeManager({ stateRoot: fixture.state, managedRoot: fixture.worktrees }),
  });
}

async function trackedFixture(options: Parameters<typeof canonicalFixture>[0] = {}) {
  const fixture = await canonicalFixture(options); roots.push(fixture.root); return fixture;
}

async function execute(core: RouterCoreService, task: Omit<TaskPackage, "task_package_hash">) {
  const prepared = await core.prepare(task);
  const status = await core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
  return { prepared, status };
}

describe("S9 zero-cost Orchestrator-first end-to-end certification", () => {
  it("runs the public allow path through an actual Direct adapter with only mock fetch and mock auth resolution", async () => {
    const fixture = await trackedFixture(); let resolverCalls = 0; let fetchCalls = 0;
    const adapter = new DeepSeekChatAdapter({
      credentialResolver: alias => { resolverCalls++; expect(alias).toBe(fixture.routeProfile.auth_alias); return "synthetic-auth-only"; },
      fetchImpl: async (_input, init) => {
        fetchCalls++; const body = JSON.parse(String(init?.body));
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic-auth-only");
        const message = fetchCalls === 1
          ? { content: "", tool_calls: [{ id: "patch-1", type: "function", function: { name: "propose_patch", arguments: JSON.stringify({ path: "src/parser.ts", preimageHash: fixture.task.context_manifest[0].content_hash, replacement: "export const parser = 2;\n" }) } }] }
          : { content: "synthetic execution complete" };
        const response = new Response(JSON.stringify({ id: `mock-response-${fetchCalls}`, model: body.model, choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 }, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 } }), { status: 200 });
        Object.defineProperty(response, "url", { value: `${fixture.routeProfile.endpoint_origin}${fixture.routeProfile.endpoint_path}` });
        Object.defineProperty(response, "redirected", { value: false });
        return response;
      },
    });
    const result = await execute(coreFor(fixture, { model: adapter }), fixture.task);
    expect(result.status).toMatchObject({ state: "REVIEW_PENDING", evidence_bundle: { quality_passed: true } });
    expect(resolverCalls).toBe(1); expect(fetchCalls).toBe(2);
    expect(await readFile(path.join(fixture.project, "src/parser.ts"), "utf8")).toBe("export const parser = 1;\n");
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"])("certifies the %s binding with mock route evidence", async modelId => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter();
    const routeProfile = { ...fixture.routeProfile, model_id: modelId } as RouterRouteProfile;
    const result = await execute(coreFor(fixture, { model, routeProfile }), fixture.task);
    expect(result.status).toMatchObject({ state: "REVIEW_PENDING", evidence_bundle: { quality_passed: true } });
    expect(result.prepared.approval_summary.model).toBe(modelId); expect(model.sends).toBe(1);
  });

  it.each([
    ["endpoint", { endpoint_origin: "https://example.invalid" }],
    ["auth", { auth_alias: "synthetic-wrong-auth" }],
    ["model", { model_id: "deepseek-v4-other" }],
    ["protocol", { wire_protocol: "responses" }],
  ] as const)("blocks a wrong %s binding before auth, worktree, or provider send", async (_name, changed) => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter();
    const core = coreFor(fixture, { model, routeProfile: { ...fixture.routeProfile, ...changed } as RouterRouteProfile });
    await expect(core.prepare(fixture.task)).rejects.toThrow(); expect(model.sends).toBe(0);
  });

  it("covers public/private/secret classification and allow/deny egress without forwarding denied content", async () => {
    const publicFixture = await trackedFixture(); const publicModel = new ScenarioAdapter();
    expect((await execute(coreFor(publicFixture, { model: publicModel }), publicFixture.task)).status.state).toBe("REVIEW_PENDING");
    expect(publicModel.sends).toBe(1);

    const privateFixture = await trackedFixture(); const privateModel = new ScenarioAdapter();
    const privateResult = await execute(coreFor(privateFixture, { model: privateModel }), { ...privateFixture.task, task_id: "synthetic-private-s9", data_classification: "private" });
    expect(privateResult.status.state).toBe("BLOCKED"); expect(privateModel.sends).toBe(0);

    const secretFixture = await trackedFixture(); const secretModel = new ScenarioAdapter();
    await expect(coreFor(secretFixture, { model: secretModel }).prepare({ ...secretFixture.task, task_id: "synthetic-secret-s9", data_classification: "secret_restricted" })).rejects.toThrow(/secret|restricted/i);
    expect(secretModel.sends).toBe(0);

    const denyFixture = await trackedFixture(); const denyModel = new ScenarioAdapter(); const budget = requestBudget();
    const userPolicy = createUserPolicy({ version: 1, policy_id: "synthetic-user-deny", egress_policy: { mode: "deny" }, read_scope: ["src/parser.ts"], write_scope: ["src/parser.ts"], budget_ceiling: budget });
    const projectPolicy = createProjectPolicy({ version: 1, policy_id: "synthetic-project-deny", egress_policy: { mode: "deny" }, read_scope: ["src/parser.ts"], write_scope: ["src/parser.ts"], budget_ceiling: budget });
    await expect(coreFor(denyFixture, { model: denyModel, userPolicy, projectPolicy }).prepare({ ...denyFixture.task, task_id: "synthetic-deny-s9", egress_policy: { mode: "deny" } })).rejects.toThrow(/egress|allow/i);
    expect(denyModel.sends).toBe(0);
  });

  it("persists a proven pre-send failure as FAILED_BEFORE_SEND and never calls invoke", async () => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter("preflight_failure");
    const result = await execute(coreFor(fixture, { model }), fixture.task);
    expect(result.status).toMatchObject({ state: "BLOCKED", attempts: [{ stage: "EXECUTE", status: "FAILED_BEFORE_SEND", failure_class: "local_preflight" }] });
    expect(model.sends).toBe(0);
  });

  it.each(["timeout", "reset", "failure", "response_lost"] as const)("persists %s as AMBIGUOUS/BLOCKED and never resends", async scenario => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter(scenario);
    const { prepared, status } = await execute(coreFor(fixture, { model }), fixture.task);
    expect(status.state).toBe("BLOCKED");
    expect(status.attempts[0]).toMatchObject({ stage: "EXECUTE", status: "AMBIGUOUS", failure_class: scenario === "response_lost" ? "response_invalid" : "transport_unknown" });
    await coreFor(fixture, { model }).execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(model.sends).toBe(1);
  });

  it.each(["PREPARED", "SENDING", "SUCCEEDED"] as AttemptCheckpoint[])("fails closed around the %s provider checkpoint with durable recovery evidence", async checkpoint => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter();
    const attempts = new DurableAttemptExecutor(new AttemptPersistence(fixture.state), { checkpoint: (current, attempt) => { if (attempt.stage === "EXECUTE" && current === checkpoint) throw new Error(`synthetic crash at ${checkpoint}`); } });
    const { status } = await execute(coreFor(fixture, { model, attempts }), fixture.task);
    expect(status.state).toBe("BLOCKED"); expect(await readFile(path.join(fixture.project, "src/parser.ts"), "utf8")).toBe("export const parser = 1;\n");
    const recovered = await attempts.recover(fixture.task.task_id); const item = recovered.attempts[0];
    expect(item.status).toBe(checkpoint === "SENDING" ? "AMBIGUOUS" : checkpoint);
    expect(model.sends).toBe(checkpoint === "SUCCEEDED" ? 1 : 0);
  });

  it("allows duplicate and concurrent execute calls to converge on one provider side effect", async () => {
    const fixture = await trackedFixture();
    class DelayedAdapter extends ScenarioAdapter { override async invoke(request: ProviderRequest) { await new Promise(resolve => setTimeout(resolve, 30)); return super.invoke(request); } }
    const model = new DelayedAdapter(); const core = coreFor(fixture, { model }); const prepared = await core.prepare(fixture.task);
    await Promise.all([core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash), core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash)]);
    expect((await core.status(prepared.task_id)).state).toBe("REVIEW_PENDING");
    await core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash); expect(model.sends).toBe(1);
  });

  it.each(["scope", "usage"] as const)("blocks %s violations after one mock response and before any main-workspace write", async scenario => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter(scenario);
    const { status } = await execute(coreFor(fixture, { model }), fixture.task);
    expect(status.state).toBe("BLOCKED"); expect(status.attempts[0]).toMatchObject({ status: "AMBIGUOUS", failure_class: "response_invalid" });
    expect(await readFile(path.join(fixture.project, "src/parser.ts"), "utf8")).toBe("export const parser = 1;\n"); expect(model.sends).toBe(1);
  });

  it("records a new secret as a failed quality/privacy gate and preserves main", async () => {
    const fixture = await trackedFixture(); const model = new ScenarioAdapter("secret"); const core = coreFor(fixture, { model });
    const { status } = await execute(core, fixture.task); expect(status.state).toBe("BLOCKED");
    const evidence = await core.reviewEvidence(fixture.task.task_id);
    expect(evidence.quality_passed).toBe(false); expect(evidence.privacy_violations).toContain("new_high_confidence_secret_findings:1");
    expect(await readFile(path.join(fixture.project, "src/parser.ts"), "utf8")).toBe("export const parser = 1;\n");
  });

  it("distinguishes an approved local quality command failure from provider success", async () => {
    const fixture = await trackedFixture(); const spec: QualityCommandSpec = { command_id: "lint", executable: process.execPath, args: ["--synthetic-never-spawned"], timeout_ms: 5_000 };
    const qualityPolicy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-s9-quality-fail", command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog([spec]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 30_000 });
    const local = new LocalValidationAdapter({ policy: qualityPolicy, evidenceRoot: fixture.state, commandCatalog: [spec], runCommand: async () => ({ exitCode: 1, stdout: "synthetic lint failure", stderr: "", timedOut: false, overflowed: false }) });
    const model = new ScenarioAdapter(); const core = coreFor(fixture, { model, local, qualityPolicy });
    const { status } = await execute(core, fixture.task); expect(status).toMatchObject({ state: "BLOCKED", evidence_bundle: { quality_passed: false } });
    expect(status.attempts.map(item => [item.stage, item.status])).toEqual([["EXECUTE", "SUCCEEDED"], ["VALIDATE", "SUCCEEDED"]]);
    expect((await core.reviewEvidence(fixture.task.task_id)).quality_gate_results.find(item => item.gate_id === "lint")?.outcome).toBe("failed");
  });

  it.each(["success", "invalid_scope"] as const)("permits exactly one controlled repair and handles %s deterministically", async repairBehavior => {
    const fixture = await trackedFixture({ repairBehavior }); const core = fixture.core; const { prepared } = await execute(core, fixture.task); const firstEvidence = await core.reviewEvidence(fixture.task.task_id);
    await core.finalize(fixture.task.task_id, firstEvidence.evidence_bundle_hash, "REPAIR_REQUIRED", "Make one bounded synthetic correction.");
    const repaired = await core.repair(fixture.task.task_id, firstEvidence.evidence_bundle_hash, prepared.approval_summary.approval_summary_hash);
    expect(repaired.repair_count).toBe(1); expect(repaired.state).toBe(repairBehavior === "success" ? "REVIEW_PENDING" : "BLOCKED");
    expect(repaired.attempts.filter(item => item.stage === "REPAIR")).toHaveLength(1);
  });

  it("blocks an apply conflict, while a pre-existing unrelated dirty file survives a successful explicit apply", async () => {
    const conflict = await trackedFixture(); const first = await execute(conflict.core, conflict.task); const firstEvidence = await conflict.core.reviewEvidence(conflict.task.task_id);
    await conflict.core.finalize(conflict.task.task_id, firstEvidence.evidence_bundle_hash, "PASS", "Synthetic evidence passes.");
    await writeFile(path.join(conflict.project, "src/parser.ts"), "export const parser = 99; // user edit\n");
    expect((await conflict.core.apply(first.prepared.task_id, firstEvidence.evidence_bundle_hash)).state).toBe("BLOCKED");
    expect(await readFile(path.join(conflict.project, "src/parser.ts"), "utf8")).toContain("user edit");

    const dirty = await trackedFixture(); await writeFile(path.join(dirty.project, "notes.txt"), "unrelated user draft\n");
    const second = await execute(dirty.core, dirty.task); const secondEvidence = await dirty.core.reviewEvidence(dirty.task.task_id);
    await dirty.core.finalize(dirty.task.task_id, secondEvidence.evidence_bundle_hash, "PASS", "Synthetic dirty-repo evidence passes.");
    expect((await dirty.core.apply(second.prepared.task_id, secondEvidence.evidence_bundle_hash)).state).toBe("PASSED");
    expect(await readFile(path.join(dirty.project, "notes.txt"), "utf8")).toBe("unrelated user draft\n");
  });

  it("redacts provider errors from durable state and refuses cleanup of the retained dirty owned worktree", async () => {
    const redacted = await trackedFixture(); const redactionModel = new ScenarioAdapter("redaction");
    const redaction = (await execute(coreFor(redacted, { model: redactionModel }), redacted.task)).status;
    expect(JSON.stringify(redaction)).not.toMatch(/hunter22|Synthetic\\\\private/i); expect(redaction.blocked_reason).toMatch(/redacted/i);

    const cleanup = await trackedFixture(); await execute(cleanup.core, cleanup.task);
    const record = await cleanup.core.store.load(cleanup.task.task_id) as any;
    const manager = new GitWorktreeManager({ stateRoot: cleanup.state, managedRoot: cleanup.worktrees });
    await expect(manager.cleanup(cleanup.project, record.worktree_binding.worktree_id)).rejects.toThrow(/dirty|refused|failed closed/i);
    expect((await manager.readLifecycle(record.worktree_binding.worktree_id)).state).toBe("RETAINED");
  });

  it("makes CLI and temporary STDIO MCP observe the same external core state", async () => {
    const fixture = await trackedFixture(); const config = path.join(fixture.root, "s9-runtime"); const state = path.join(fixture.root, "s9-shared-state"); await mkdir(config);
    const files = { task: path.join(config, "task.json"), user: path.join(config, "user.json"), project: path.join(config, "project.json"), route: path.join(config, "route.json") };
    await Promise.all([writeFile(files.task, JSON.stringify(fixture.task)), writeFile(files.user, JSON.stringify(fixture.userPolicy)), writeFile(files.project, JSON.stringify(fixture.projectPolicy)), writeFile(files.route, JSON.stringify(fixture.routeProfile))]);
    const runtime: RouterRuntimeFileOptions = { project: fixture.project, stateRoot: state, userPolicy: files.user, projectPolicy: files.project, routeProfile: files.route };
    const cli = await runCli(["router", "prepare", files.task, "--project", runtime.project, "--state-root", runtime.stateRoot, "--user-policy", runtime.userPolicy, "--project-policy", runtime.projectPolicy, "--route-profile", runtime.routeProfile]);
    expect(cli.code).toBe(0); const cliStatus = JSON.parse(cli.stdout.trim());
    const core = await createRouterCoreFromFiles(runtime, { model_adapter: fixture.model, local_adapter: new LocalValidationAdapter({ evidenceRoot: state }) });
    const directMcp = await new RouterMcpServer(core).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "router.status", arguments: { task_id: fixture.task.task_id } } }) as any;
    expect(directMcp.result.structuredContent).toEqual(cliStatus);

    const input = new PassThrough(); const output = new PassThrough(); const running = runStdioMcpServer(core, input, output); const response = once(output, "data");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "router.status", arguments: { task_id: fixture.task.task_id } } })}\n`);
    const [chunk] = await response; expect(JSON.parse(chunk.toString()).result.structuredContent).toEqual(cliStatus); input.end(); await running;
    expect(fixture.model.sends).toBe(0);
  });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/cli.ts"), ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: {} });
  let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, "close") as [number]; return { code, stdout, stderr };
}
