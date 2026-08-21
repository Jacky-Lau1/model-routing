#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { runRoutingBenchmark } from "./benchmark.js";
import { RouterOrchestrator } from "./orchestrator.js";
import { StateStore } from "./persistence.js";
import { CodexCliAdapter } from "./providers/codex-cli.js";
import { DeepSeekChatAdapter } from "./providers/deepseek-chat.js";
import { LocalValidationAdapter } from "./providers/local.js";
import { RoutingProviderAdapter } from "./providers/routing.js";
import { runLiveBenchmark } from "./live-benchmark.js";
import type { Complexity, ProviderAdapter, Risk, SensitivityClass, TaskKind } from "./types.js";

const program = new Command();
program.name("route").description("Orchestrator-first, fail-closed model router").version("0.1.0");

function services(stateRoot?: string) {
  const store = new StateStore(stateRoot ? path.resolve(stateRoot) : undefined);
  const openai = new CodexCliAdapter({ executable: process.env.CODEX_CLI_PATH });
  const deepseek = new DeepSeekChatAdapter({ baseUrl: process.env.DEEPSEEK_BASE_URL });
  const providers = new RoutingProviderAdapter(new Map<string, ProviderAdapter>([["openai-codex", openai], ["deepseek", deepseek]]));
  return { store, router: new RouterOrchestrator(providers, new LocalValidationAdapter(), store) };
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

program.command("benchmark").option("--iterations <count>", "runs per routing case", "10")
  .action(options => { const result = runRoutingBenchmark(Number.parseInt(options.iterations, 10)); print(result); if (!result.passed) process.exitCode = 1; });

program.command("live-benchmark").description("Explicit real-API benchmark; never part of install or default checks")
  .option("--keep-workspace", "retain the temporary fixture for debugging")
  .option("--output-directory <path>", "report directory")
  .action(async options => { const result = await runLiveBenchmark({ keepWorkspace: Boolean(options.keepWorkspace), outputDirectory: options.outputDirectory }); print(result); if (!result.acceptancePassed) process.exitCode = 1; });

program.command("cleanup").option("--dry-run").option("--older-than <duration>", "for example 7d", "7d").option("--state-root <path>")
  .action(async options => { const days = parseDays(options.olderThan); const removed = await services(options.stateRoot).store.cleanup(days, Boolean(options.dryRun)); print({ dryRun: Boolean(options.dryRun), olderThanDays: days, removed }); });

program.parseAsync().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });

function compact<T extends object>(value: T): Partial<T> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function parseDays(value: string): number { const match = /^(\d+)d$/.exec(value); if (!match) throw new Error("Duration must use Nd format, for example 7d"); return Number.parseInt(match[1], 10); }
function nextAction(state: string, taskId: string): string { if (state === "WAITING_APPROVAL") return `route approve ${taskId}`; if (state === "WAITING_REAPPROVAL") return `route revise ${taskId} <instruction>`; if (["COMPLETED", "ABORTED"].includes(state)) return "none"; return `route status ${taskId}`; }
