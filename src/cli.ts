#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { runRoutingBenchmark } from "./benchmark.js";
import { loadDeepSeekApiKey } from "./credentials.js";
import { RouterOrchestrator } from "./orchestrator.js";
import { StateStore } from "./persistence.js";
import { CodexCliAdapter } from "./providers/codex-cli.js";
import { DeepSeekChatAdapter } from "./providers/deepseek-chat.js";
import { LocalValidationAdapter } from "./providers/local.js";
import { DEFAULT_QUALITY_GATE_POLICY } from "./quality-gate.js";
import { RoutingProviderAdapter } from "./providers/routing.js";
import { runLiveBenchmark } from "./live-benchmark.js";
import { createRouterCoreFromFiles, readRouterJsonFile, type RouterRuntimeFileOptions } from "./router-runtime.js";
import { redactError } from "./redaction.js";
import type { Complexity, ProviderAdapter, Risk, SensitivityClass, TaskKind } from "./types.js";

const program = new Command();
program.name("route").description("Orchestrator-first, fail-closed model router").version("0.1.0");

function services(stateRoot?: string) {
  const store = new StateStore(stateRoot ? path.resolve(stateRoot) : undefined);
  const openai = new CodexCliAdapter({ executable: process.env.CODEX_CLI_PATH });
  const deepseek = new DeepSeekChatAdapter({ credentialResolver: authAlias => loadDeepSeekApiKey(authAlias) });
  const providers = new RoutingProviderAdapter(new Map<string, ProviderAdapter>([["openai-codex", openai], ["deepseek", deepseek]]));
  const local = new LocalValidationAdapter({ policy: DEFAULT_QUALITY_GATE_POLICY, evidenceRoot: store.root });
  return { store, router: new RouterOrchestrator(providers, local, store, undefined, undefined, DEFAULT_QUALITY_GATE_POLICY) };
}

program.command("auto")
  .description("Classify and plan a task; stops for approval")
  .argument("<objective>")
  .option("--project <path>", "target project", process.cwd())
  .option("--state-root <path>")
  .option("--kind <kind>", "code, text, or visual")
  .option("--complexity <level>", "normal or complex")
  .option("--risk <level>", "normal or high")
  .option("--sensitivity <class>", "normal, private, or restricted")
  .action(async (objective, options) => {
    const { router } = services(options.stateRoot);
    const state = await router.auto(objective, { projectDirectory: path.resolve(options.project), profile: compact({ kind: options.kind as TaskKind, complexity: options.complexity as Complexity, risk: options.risk as Risk, sensitivity: options.sensitivity as SensitivityClass }) });
    print({ taskId: state.taskId, state: state.state, profile: state.profile, plan: state.plan, next: `route approve ${state.taskId} --project ${JSON.stringify(path.resolve(options.project))}` });
  });

program.command("approve")
  .description("Approve the frozen plan and run execution, validation, and review")
  .argument("<task-id>")
  .option("--project <path>", "target project", process.cwd())
  .option("--state-root <path>")
  .action(async (taskId, options) => print(await services(options.stateRoot).router.approve(taskId, path.resolve(options.project))));

program.command("revise")
  .description("Invalidate the old approval and regenerate a plan")
  .argument("<task-id>").argument("<instruction>")
  .option("--project <path>", "target project", process.cwd()).option("--state-root <path>")
  .action(async (taskId, instruction, options) => print(await services(options.stateRoot).router.revise(taskId, instruction, path.resolve(options.project))));

program.command("status").argument("[task-id]").option("--state-root <path>")
  .action(async (taskId, options) => { const store = services(options.stateRoot).store; print(taskId ? await store.load(taskId) : await store.list()); });

program.command("resume").argument("<task-id>").option("--state-root <path>")
  .action(async (taskId, options) => { const state = await services(options.stateRoot).store.load(taskId); print({ ...state, next: nextAction(state.state, taskId) }); });

program.command("abort").argument("<task-id>").option("--state-root <path>")
  .action(async (taskId, options) => print(await services(options.stateRoot).router.abort(taskId)));

const router = program.command("router").description("Canonical structured Router core commands used by the foreground GPT workflow");

addRouterRuntimeOptions(router.command("prepare").description("Validate a minimal TaskPackage and return a compact approval summary")
  .argument("<task-package>", "JSON file containing a canonical TaskPackage; task_package_hash may be omitted"))
  .action(async (taskPackage, options) => printStructured(await (await structuredServices(options)).prepare(await readRouterJsonFile(taskPackage) as never)));

addRouterRuntimeOptions(router.command("execute").description("Approve the exact prepared summary, execute once, and run local quality gates")
  .argument("<task-id>").requiredOption("--approval-summary-hash <sha256>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).execute(taskId, options.approvalSummaryHash)));

addRouterRuntimeOptions(router.command("status").description("Return compact canonical workflow and attempt status").argument("<task-id>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).status(taskId)));

addRouterRuntimeOptions(router.command("abort").description("Abort only when no provider execution lock is active").argument("<task-id>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).abort(taskId)));

addRouterRuntimeOptions(router.command("review-evidence").description("Return a compact, verified EvidenceBundle view").argument("<task-id>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).reviewEvidence(taskId)));

addRouterRuntimeOptions(router.command("finalize").description("Record the foreground GPT PASS, REPAIR_REQUIRED, or BLOCKED review; PASS only enters APPLY_PENDING")
  .argument("<task-id>").requiredOption("--evidence-bundle-hash <sha256>").requiredOption("--decision <decision>", "PASS, REPAIR_REQUIRED, or BLOCKED").requiredOption("--summary <text>"))
  .action(async (taskId, options) => {
    if (!["PASS", "REPAIR_REQUIRED", "BLOCKED"].includes(options.decision)) throw new Error("decision must be PASS, REPAIR_REQUIRED, or BLOCKED");
    printStructured(await (await structuredServices(options)).finalize(taskId, options.evidenceBundleHash, options.decision, options.summary));
  });

addRouterRuntimeOptions(router.command("repair").description("Run the single controlled repair under the unchanged approval and current REPAIR_REQUIRED review")
  .argument("<task-id>").requiredOption("--evidence-bundle-hash <sha256>").requiredOption("--approval-summary-hash <sha256>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).repair(taskId, options.evidenceBundleHash, options.approvalSummaryHash)));

addRouterRuntimeOptions(router.command("apply").description("Explicitly apply the PASS-reviewed bytes after snapshot and target-preimage checks; never commit, merge, or push")
  .argument("<task-id>").requiredOption("--evidence-bundle-hash <sha256>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).apply(taskId, options.evidenceBundleHash)));

program.command("benchmark").option("--iterations <count>", "runs per routing case", "10")
  .action(options => { const result = runRoutingBenchmark(Number.parseInt(options.iterations, 10)); print(result); if (!result.passed) process.exitCode = 1; });

program.command("live-benchmark").description("Explicit real-API benchmark; never part of install or default checks")
  .option("--keep-workspace", "retain the temporary fixture for debugging")
  .option("--output-directory <path>", "report directory")
  .action(async options => { const result = await runLiveBenchmark({ keepWorkspace: Boolean(options.keepWorkspace), outputDirectory: options.outputDirectory }); print(result); if (!result.acceptancePassed) process.exitCode = 1; });

program.command("cleanup").option("--dry-run").option("--older-than <duration>", "for example 7d", "7d").option("--state-root <path>")
  .action(async options => { const days = parseDays(options.olderThan); const removed = await services(options.stateRoot).store.cleanup(days, Boolean(options.dryRun)); print({ dryRun: Boolean(options.dryRun), olderThanDays: days, removed }); });

program.parseAsync().catch(error => { console.error(JSON.stringify({ error: redactError(error) })); process.exitCode = 1; });

function compact<T extends object>(value: T): Partial<T> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function printStructured(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function addRouterRuntimeOptions(command: Command): Command {
  return command.requiredOption("--project <path>", "target Git project")
    .requiredOption("--state-root <path>", "external Router state root")
    .requiredOption("--user-policy <path>", "external hashed UserPolicy JSON")
    .requiredOption("--project-policy <path>", "hashed ProjectPolicy JSON")
    .requiredOption("--route-profile <path>", "bound Direct DeepSeek route profile JSON");
}
function structuredServices(options: Record<string, string>) {
  return createRouterCoreFromFiles({ project: options.project, stateRoot: options.stateRoot, userPolicy: options.userPolicy, projectPolicy: options.projectPolicy, routeProfile: options.routeProfile } satisfies RouterRuntimeFileOptions);
}
function parseDays(value: string): number { const match = /^(\d+)d$/.exec(value); if (!match) throw new Error("Duration must use Nd format, for example 7d"); return Number.parseInt(match[1], 10); }
function nextAction(state: string, taskId: string): string { if (state === "WAITING_APPROVAL") return `route approve ${taskId}`; if (state === "WAITING_REAPPROVAL") return `route revise ${taskId} <instruction>`; if (["COMPLETED", "ABORTED"].includes(state)) return "none"; return `route status ${taskId}`; }
