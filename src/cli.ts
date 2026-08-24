#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRICING_CATALOG, type PricingCatalog } from "./cost.js";
import { credentialStatus, runDoctor, verifyPricing, type DoctorInput } from "./doctor.js";
import { sha256File } from "./distribution.js";
import { buildInstallPreview, buildUninstallPreview } from "./installation.js";
import { buildMcpRegistrationPreview, type McpRegistrationInput } from "./mcp-registration.js";
import { createRouterCoreFromFiles, readRouterJsonFile, type RouterRuntimeFileOptions } from "./router-runtime.js";
import { redactError } from "./redaction.js";

const program = new Command();
program.name("route").description("Canonical fail-closed Router and offline installation diagnostics").version("0.1.0");

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

addRouterRuntimeOptions(router.command("pilot-report").description("Read the immutable PilotRunRecord derived from current durable evidence").argument("<task-id>"))
  .action(async (taskId, options) => printStructured(await (await structuredServices(options)).pilotReport(taskId)));

program.command("config-preview").description("Show an exact hash-bound MCP configuration preview without writing").argument("<request-json>")
  .action(async file => print(await installPreview(file)));
program.command("install").description("Offline install preview only; never writes Codex config").requiredOption("--dry-run").argument("<request-json>")
  .action(async file => print(await installPreview(file)));
program.command("uninstall").description("Offline exact-block uninstall preview only; refuses drift").requiredOption("--dry-run").argument("<request-json>")
  .action(async file => { const request = await objectFile(file); const configPath = stringField(request.config_path, "config_path"); print(buildUninstallPreview({ config_path: configPath, current_config: await readOptionalText(configPath), server_name: stringField(request.server_name, "server_name"), expected_managed_block: stringField(request.expected_managed_block, "expected_managed_block"), expected_managed_block_sha256: stringField(request.expected_managed_block_sha256, "expected_managed_block_sha256") })); });
program.command("doctor").description("Run the fully offline installation and workspace doctor").argument("<request-json>")
  .action(async file => { const request = await objectFile(file); print(await runDoctor({ ...request, now: new Date(stringField(request.now, "now")) } as unknown as DoctorInput)); });
program.command("pricing-verify").description("Verify pricing hash and validity window").option("--catalog <json>").requiredOption("--at <iso>")
  .action(async options => print(verifyPricing(options.catalog ? await readRouterJsonFile(options.catalog) as PricingCatalog : PRICING_CATALOG, new Date(options.at))));
program.command("credential-status").description("Report credential alias names only; never reads values").requiredOption("--required <aliases>").option("--available <aliases>", "comma-separated locally attested aliases", "")
  .action(options => print(credentialStatus({ required_aliases: csv(options.required), available_aliases: csv(options.available) })));

program.parseAsync().catch(error => { console.error(JSON.stringify({ error: redactError(error) })); process.exitCode = 1; });

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function printStructured(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function addRouterRuntimeOptions(command: Command): Command {
  return command.requiredOption("--project <path>", "target Git project")
    .requiredOption("--state-root <path>", "external Router state root")
    .requiredOption("--evidence-root <path>", "external EvidenceBundle root")
    .requiredOption("--worktree-root <path>", "external managed worktree root")
    .requiredOption("--fixture-root <path>", "hash-bound visible fixture root")
    .requiredOption("--hidden-root <path>", "model-inaccessible hidden acceptance root")
    .requiredOption("--quality-policy <path>", "strict self-hashed QualityGatePolicy JSON")
    .requiredOption("--quality-catalog <path>", "strict self-hashed trusted command catalog JSON")
    .requiredOption("--user-policy <path>", "external hashed UserPolicy JSON")
    .requiredOption("--project-policy <path>", "hashed ProjectPolicy JSON")
    .requiredOption("--route-profile <path>", "bound Direct DeepSeek route profile JSON");
}
function structuredServices(options: Record<string, string>) {
  return createRouterCoreFromFiles({ project: options.project, stateRoot: options.stateRoot, evidenceRoot: options.evidenceRoot, worktreeRoot: options.worktreeRoot, fixtureRoot: options.fixtureRoot, hiddenRoot: options.hiddenRoot, qualityPolicy: options.qualityPolicy, qualityCatalog: options.qualityCatalog, mode: "pilot", userPolicy: options.userPolicy, projectPolicy: options.projectPolicy, routeProfile: options.routeProfile } satisfies RouterRuntimeFileOptions);
}
async function installPreview(file: string) { const request = await objectFile(file); const registrationInput = request.registration as McpRegistrationInput; if (!registrationInput || registrationInput.runtime_mode !== "pilot") throw new Error("Install candidate registration must use pilot mode"); const distribution = path.resolve(stringField(registrationInput.distribution_root, "distribution_root")); const registration = buildMcpRegistrationPreview(registrationInput, await sha256File(path.join(distribution, "dist", "src", "mcp.js"))); const configPath = stringField(request.config_path, "config_path"); return buildInstallPreview({ config_path: configPath, current_config: await readOptionalText(configPath), registration }); }
async function objectFile(file: string): Promise<Record<string, unknown>> { const value = await readRouterJsonFile(file); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request JSON must be an object"); return value as Record<string, unknown>; }
async function readOptionalText(file: string): Promise<string> { return readFile(path.resolve(file), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }); }
function stringField(value: unknown, name: string): string { if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a safe non-empty string`); return value; }
function csv(value: string): string[] { return value === "" ? [] : value.split(",").map(item => item.trim()).filter(Boolean); }
