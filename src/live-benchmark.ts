import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyTask } from "./classifier.js";
import { estimateEquivalentUsd, PRICING_CATALOG_VERSION } from "./cost.js";
import { decideRoute } from "./policy.js";
import { DeepSeekChatAdapter } from "./providers/deepseek-chat.js";
import { assertAllowedChanges, snapshotWorkingTree } from "./scope-guard.js";

export interface LiveBenchmarkOptions { keepWorkspace?: boolean; outputDirectory?: string }

export async function runLiveBenchmark(options: LiveBenchmarkOptions = {}): Promise<Record<string, unknown> & { acceptancePassed: boolean; reportPath: string; workspace?: string }> {
  const started = Date.now();
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fixture = path.join(repositoryRoot, "benchmark", "fixtures", "simple-sum");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "model-router-live-"));
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(repositoryRoot, "logs", "runs"));
  let report: Record<string, unknown>;
  try {
    await cp(fixture, workspace, { recursive: true });
    await git(workspace, ["init", "--quiet"]); await git(workspace, ["config", "user.email", "router-benchmark@local"]); await git(workspace, ["config", "user.name", "Router Benchmark"]);
    await git(workspace, ["add", "."]); await git(workspace, ["commit", "--quiet", "-m", "fixture baseline"]);
    const profile = classifyTask("Fix the bounded sumPositive JavaScript bug");
    const route = decideRoute("EXECUTE", profile);
    const before = await snapshotWorkingTree(workspace);
    const adapter = new DeepSeekChatAdapter();
    const response = await adapter.invoke({
      stage: "EXECUTE", route, sensitivity: "normal", workingDirectory: workspace, allowedFiles: ["src/sum.mjs"],
      stablePrefix: "You are the bounded code executor. Use the provided file tools to inspect and fix the task. Modify only approved files. Finish with a concise summary.",
      projectSummary: "Small dependency-free JavaScript project. Read README.md for the contract.",
      dynamicInput: "Fix sumPositive exactly as specified in README.md. You must inspect the current implementation and write the corrected src/sum.mjs.",
    });
    const after = await snapshotWorkingTree(workspace);
    let scopePassed = true; let scopeError: string | undefined;
    try { assertAllowedChanges(before, after, ["src/sum.mjs"]); } catch (error) { scopePassed = false; scopeError = error instanceof Error ? error.message : String(error); }
    const visible = await command(process.execPath, ["--test"], workspace);
    const hidden = await scoreHiddenCases(workspace);
    const qualityScore = Math.max(0, Math.min(100, hidden.passed * 10 + (visible.code === 0 ? 15 : 0) + (scopePassed ? 15 : 0)));
    const estimatedApiCostUsd = estimateEquivalentUsd(route.model, response.usage);
    report = {
      benchmarkVersion: 1, timestamp: new Date().toISOString(), provider: response.provider, model: response.model,
      reasoningEffort: route.effort, requestId: response.requestId, durationMs: Date.now() - started,
      usage: response.usage, pricingCatalogVersion: PRICING_CATALOG_VERSION, estimatedApiCostUsd,
      quality: { score: qualityScore, maximum: 100, hiddenCasesPassed: hidden.passed, hiddenCasesTotal: hidden.total, visibleTestsPassed: visible.code === 0, scopePassed, scopeError },
      acceptancePassed: qualityScore === 100, modelSummary: response.text,
      note: "estimatedApiCostUsd uses public list prices and may differ from the provider invoice due to credits, promotions, or rounding.",
    };
    await mkdir(outputDirectory, { recursive: true });
    const filename = `live-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const reportPath = path.join(outputDirectory, filename); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, acceptancePassed: report.acceptancePassed === true, reportPath, workspace: options.keepWorkspace ? workspace : undefined };
  } finally {
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

async function scoreHiddenCases(workspace: string): Promise<{ passed: number; total: number }> {
  const moduleUrl = `${pathToFileURL(path.join(workspace, "src", "sum.mjs")).href}?run=${Date.now()}`;
  const loaded = await import(moduleUrl); const sumPositive = loaded.sumPositive as (values: number[]) => number;
  const cases: Array<[number[], number]> = [[], [0], [-2, -1], [1, 2.5], [Number.NaN, 2], [Number.POSITIVE_INFINITY, 3], [-5, 0, 1, 4]] .map((entry, index) => [entry as number[], [0, 0, 0, 3.5, 2, 3, 5][index]]);
  let passed = 0;
  for (const [input, expected] of cases) { const copy = [...input]; try { if (Object.is(sumPositive(input), expected) && input.every((value, index) => Object.is(value, copy[index]))) passed++; } catch { /* failed case */ } }
  return { passed, total: cases.length };
}
async function git(directory: string, args: string[]) { const result = await command("git", args, directory); if (result.code !== 0) throw new Error(result.stderr); }
async function command(executable: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = execFile(executable, args, { cwd, windowsHide: true }); let stdout = ""; let stderr = "";
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8"); child.stdout?.on("data", chunk => { stdout += chunk; }); child.stderr?.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null]; return { code: code ?? 1, stdout, stderr };
}
