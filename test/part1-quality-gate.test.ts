import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableHash } from "../src/canonical.js";
import { createQualityAcceptanceProjection, hashHiddenAcceptanceRoot, runHiddenAcceptance } from "../src/hidden-acceptance.js";
import { LocalQualityGate, createQualityGatePolicy, type QualityCommandExecution, type QualityCommandRunner, type QualityGitRunner } from "../src/quality-gate.js";
import { assertPilotQualityGate, assertQualityGateRuntimeBinding, assertTrustedQualityCommandCatalog, createQualityGateApprovalBoundary, createTrustedQualityCommandCatalog, loadQualityGatePolicy, loadTrustedQualityCommandCatalog, type CreateQualityGateApprovalBoundaryOptions, type TrustedQualityCommandCatalog } from "../src/quality-gate-config.js";
import type { QualityCommandId, QualityGatePolicy, QualityGateRequest } from "../src/types.js";

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map(root => rmrf(root))));

describe("Part 1 canonical quality gate", () => {
  it("strictly loads self-hashed policy/catalog artifacts and rejects unknown or tampered fields", async () => {
    const projectRoot = process.cwd();
    const policy = await loadQualityGatePolicy(path.join(projectRoot, "config", "quality-gate-policy.pilot.example.json"));
    const catalog = await loadTrustedQualityCommandCatalog(path.join(projectRoot, "config", "trusted-quality-command-catalog.example.json"));
    expect(policy.command_registry_hash).toBe(catalog.catalog_hash);
    expect(() => assertPilotQualityGate(policy, catalog)).not.toThrow();
    expect(() => assertTrustedQualityCommandCatalog({ ...catalog, extra: true })).toThrow(/unknown or missing/);
    expect(() => assertTrustedQualityCommandCatalog({ ...catalog, commands: catalog.commands.map((command, index) => index === 0 ? { ...command, argv: [...command.argv, "--tampered"] } : command) })).toThrow(/hash/);
    const root = await tempRoot("router-part1-loader-");
    await writeFile(path.join(root, "bad-policy.json"), JSON.stringify({ ...policy, extra: true }));
    await expect(loadQualityGatePolicy(path.join(root, "bad-policy.json"))).rejects.toThrow(/unknown or missing/);
  });

  it("forbids the default empty gate and requires both visible and hidden acceptance for a real Pilot", () => {
    const emptyCatalog = createTrustedQualityCommandCatalog({ version: 1, catalog_id: "empty-synthetic", commands: [] });
    const emptyPolicy = policyFor(emptyCatalog, []);
    expect(() => assertPilotQualityGate(emptyPolicy, emptyCatalog)).toThrow(/cannot use an empty/);
    const visibleCatalog = createTrustedQualityCommandCatalog({ version: 1, catalog_id: "visible-only", commands: [trusted("unit_tests", path.resolve("C:/router/unit.exe"), "visible")] });
    expect(() => assertPilotQualityGate(policyFor(visibleCatalog, ["unit_tests"]), visibleCatalog)).toThrow(/hidden acceptance/);
  });

  it("binds executable, argv, cwd, timeout, output/wall limits, catalog, fixture, roots and base commit", async () => {
    const fixture = await repositoryFixture();
    const catalog = catalogFor(fixture);
    const policy = policyFor(catalog, catalog.commands.map(command => command.command_id));
    const hiddenRootHash = await hashHiddenAcceptanceRoot(fixture.hidden);
    const request = qualityRequest(fixture, policy, stableHash("fixture-v1"), hiddenRootHash);
    const options: CreateQualityGateApprovalBoundaryOptions = { request, policy, catalog, fixtureHash: stableHash("fixture-v1"), hiddenRootHash, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, realPilot: true };
    const approved = createQualityGateApprovalBoundary(options);
    expect(approved.commands.map(command => ({ id: command.command_id, cwd: command.cwd, timeout: command.timeout_ms, output: command.max_output_bytes }))).toEqual(catalog.commands.map(command => ({ id: command.command_id, cwd: fixture.repo, timeout: command.timeout_ms, output: command.max_output_bytes })));
    const changedCases: Array<[string, CreateQualityGateApprovalBoundaryOptions]> = [
      ["fixture", { ...options, fixtureHash: stableHash("fixture-v2") }],
      ["base", { ...options, request: { ...request, base_commit: "a".repeat(40) } }],
      ["cwd", { ...options, worktreeRoot: fixture.hidden, hiddenRootHash: null, realPilot: false }],
      ["wall", changedPolicyOptions(options, { max_wall_time_ms: policy.max_wall_time_ms - 1 })],
      ["executable", changedCatalogOptions(options, command => command.command_id === "unit_tests" ? { ...command, executable: path.join(fixture.root, "trusted", "other.exe") } : command)],
      ["argv", changedCatalogOptions(options, command => command.command_id === "unit_tests" ? { ...command, argv: ["--changed"] } : command)],
      ["timeout", changedCatalogOptions(options, command => command.command_id === "unit_tests" ? { ...command, timeout_ms: command.timeout_ms - 1 } : command)],
      ["output", changedCatalogOptions(options, command => command.command_id === "unit_tests" ? { ...command, max_output_bytes: command.max_output_bytes - 1 } : command)],
    ];
    for (const [name, current] of changedCases) expect(() => assertQualityGateRuntimeBinding(approved, current), name).toThrow();
    expect(() => assertQualityGateRuntimeBinding({ ...approved, approval_boundary_hash: "0".repeat(64) }, options)).toThrow(/hash/);
  });

  it("returns only bounded opaque hidden counts and never leaks stdout, stderr, root paths or reference answers", async () => {
    const fixture = await repositoryFixture();
    const { catalog, boundary } = await approvedFixture(fixture);
    const secretReference = "REFERENCE_ANSWER_SYNTHETIC_DO_NOT_EXPORT";
    await writeFile(path.join(fixture.hidden, "reference-answer.txt"), secretReference);
    const changedHiddenHash = await hashHiddenAcceptanceRoot(fixture.hidden);
    const reboundOptions = boundaryOptions(fixture, catalog); const rebound = createQualityGateApprovalBoundary({ ...reboundOptions, request: qualityRequest(fixture, reboundOptions.policy, stableHash("fixture-v1"), changedHiddenHash), hiddenRootHash: changedHiddenHash });
    const rawRunner = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ version: 1, passed: 7, failed: 0, not_run: 0 }), stderr: `internal ${secretReference} ${fixture.hidden}`, timedOut: false, overflowed: false }));
    const result = await runHiddenAcceptance({ hiddenRoot: fixture.hidden, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, egressPaths: ["src/parser.ts"], catalog, boundary: rebound, runCommand: rawRunner });
    expect(result.passed).toBe(true);
    expect(result.counts).toEqual({ passed: 7, failed: 0, not_run: 0 });
    const exported = JSON.stringify(result);
    expect(Buffer.byteLength(result.output_summary)).toBeLessThanOrEqual(256);
    expect(exported).not.toContain(secretReference);
    expect(exported).not.toContain(fixture.hidden);
    expect(exported).not.toContain("internal");
  });

  it.each([
    ["hidden fail", { exitCode: 1, stdout: JSON.stringify({ version: 1, passed: 5, failed: 2, not_run: 0 }), stderr: "reference=SECRET", timedOut: false, overflowed: false }],
    ["timeout", { exitCode: 124, stdout: "", stderr: "SECRET", timedOut: true, overflowed: false }],
    ["overflow", { exitCode: 125, stdout: "x".repeat(5000), stderr: "SECRET", timedOut: false, overflowed: true }],
    ["protocol leak", { exitCode: 0, stdout: JSON.stringify({ version: 1, passed: 1, failed: 0, not_run: 0, reference_answer: "SECRET" }), stderr: "", timedOut: false, overflowed: false }],
  ])("fails closed for %s without exporting diagnostics", async (_name, execution) => {
    const fixture = await repositoryFixture(); const { catalog, boundary } = await approvedFixture(fixture);
    const result = await runHiddenAcceptance({ hiddenRoot: fixture.hidden, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, egressPaths: [], catalog, boundary, runCommand: async () => execution });
    expect(result.passed).toBe(false); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(result.output_summary).toMatch(/local-only/);
  });

  it("fails closed when hidden acceptance mutates its own protected root", async () => {
    const fixture = await repositoryFixture(); const { catalog, boundary } = await approvedFixture(fixture);
    const result = await runHiddenAcceptance({ hiddenRoot: fixture.hidden, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, egressPaths: [], catalog, boundary, runCommand: async () => { await writeFile(path.join(fixture.hidden, "mutated.txt"), "mutation"); return success(JSON.stringify({ version: 1, passed: 1, failed: 0, not_run: 0 })); } });
    expect(result.passed).toBe(false); expect(result.hidden_root_unchanged).toBe(false);
  });

  it("projects visible/hidden, scope, secret, diff and freeze into one self-hashed acceptance result", async () => {
    const fixture = await repositoryFixture(); const { catalog, policy, request, boundary } = await approvedFixture(fixture);
    const hidden = await runHiddenAcceptance({ hiddenRoot: fixture.hidden, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, egressPaths: ["src/parser.ts"], catalog, boundary, runCommand: async () => success(JSON.stringify({ version: 1, passed: 9, failed: 0, not_run: 0 })) });
    const specs = catalog.commands.map(command => ({ command_id: command.command_id, executable: command.executable, args: [...command.argv], timeout_ms: command.timeout_ms }));
    const runCommand: QualityCommandRunner = async spec => spec.command_id === "project_acceptance" ? success(JSON.stringify(hidden.counts)) : success("visible pass");
    const report = await new LocalQualityGate({ policy, commandCatalog: specs, trustedCatalog: catalog, evidenceRoot: fixture.evidence, runCommand, runHiddenAcceptance: async () => hidden, runGit: gitRunner }).run(request, fixture.repo, boundary.approval_boundary_hash);
    const projection = createQualityAcceptanceProjection(report, catalog, boundary, hidden);
    expect(report.passed).toBe(true);
    expect(projection).toMatchObject({ visible_tests: { passed: 2, failed: 0, not_run: 0 }, hidden_tests: { passed: 9, failed: 0, not_run: 0 }, regression: false, scope_passed: true, secret_passed: true, diff_passed: true, freeze_passed: true });
    const body = { ...projection } as Record<string, unknown>; delete body.result_hash; expect(projection.result_hash).toBe(stableHash(body));
    expect(() => createQualityAcceptanceProjection({ ...report, report_hash: "0".repeat(64) }, catalog, boundary, hidden)).toThrow();
  });
});

interface Fixture { root: string; repo: string; evidence: string; hidden: string; base: string }

async function tempRoot(prefix: string): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); temporaryRoots.push(root); return root; }

// Windows fs.rm({ recursive: true }) can hang indefinitely on freshly copied
// trees (antivirus/OneDrive handle contention). A manual readdir+unlink+rmdir
// walk completes reliably, so all temporary-root cleanup uses it instead.
async function rmrf(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await rmrf(target);
    else await rm(target, { force: true }).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}

async function repositoryFixture(): Promise<Fixture> {
  const root = await tempRoot("router-part1-quality-"); const repo = path.join(root, "repo"); const evidence = path.join(root, "evidence"); const hidden = path.join(root, "hidden");
  await mkdir(path.join(repo, "src"), { recursive: true }); await mkdir(hidden); await mkdir(path.join(root, "trusted"));
  await writeFile(path.join(hidden, "acceptance.exe"), "synthetic hidden runner"); await writeFile(path.join(hidden, "suite.json"), JSON.stringify({ synthetic: true }));
  await writeFile(path.join(root, "trusted", "runner.exe"), "synthetic trusted runner");
  await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.name", "Synthetic Test"]); await git(repo, ["config", "user.email", "synthetic@example.invalid"]); await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "src", "parser.ts"), "export const parser = 1;\n"); await git(repo, ["add", "--", "src/parser.ts"]); await git(repo, ["commit", "-m", "synthetic base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim(); await writeFile(path.join(repo, "src", "parser.ts"), "export const parser = 2;\n");
  return { root, repo, evidence, hidden, base };
}

function catalogFor(fixture: Fixture): TrustedQualityCommandCatalog {
  return createTrustedQualityCommandCatalog({ version: 1, catalog_id: "part1-synthetic", commands: [
    trusted("unit_tests", path.join(fixture.root, "trusted", "runner.exe"), "visible"),
    trusted("build", path.join(fixture.root, "trusted", "runner.exe"), "visible"),
    trusted("project_acceptance", path.join(fixture.hidden, "acceptance.exe"), "hidden", 4096),
  ] });
}

function trusted(command_id: QualityCommandId, executable: string, visibility: "visible" | "hidden", max_output_bytes = 8192) { return { command_id, executable, argv: ["--check", command_id], cwd_mode: "worktree" as const, timeout_ms: 10_000, max_output_bytes, visibility }; }

function policyFor(catalog: TrustedQualityCommandCatalog, command_ids: QualityCommandId[]): QualityGatePolicy { return createQualityGatePolicy({ version: 1, policy_id: catalog.catalog_id, command_ids, command_registry_hash: catalog.catalog_hash, max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 8192, max_wall_time_ms: 60_000 }); }

function qualityRequest(fixture: Fixture, policy: QualityGatePolicy, fixtureHash = stableHash("fixture-v1"), hiddenRootHash: string | null = null): QualityGateRequest { return { run_id: "part1-run", task_id: "part1-task", base_commit: fixture.base, plan_hash: "1".repeat(64), approval_hash: "2".repeat(64), isolation_hash: "3".repeat(64), worktree_id: "part1-worktree", write_scope: ["src/parser.ts"], command_ids: [...policy.command_ids], policy_hash: policy.policy_hash, catalog_hash: policy.command_registry_hash, fixture_hash: fixtureHash, hidden_root_hash: hiddenRootHash, effective_policy_hash: "4".repeat(64), max_wall_time_ms: policy.max_wall_time_ms }; }

function boundaryOptions(fixture: Fixture, catalog: TrustedQualityCommandCatalog): CreateQualityGateApprovalBoundaryOptions { const policy = policyFor(catalog, catalog.commands.map(command => command.command_id)); return { request: qualityRequest(fixture, policy), policy, catalog, fixtureHash: stableHash("fixture-v1"), hiddenRootHash: null, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, realPilot: true }; }

async function approvedFixture(fixture: Fixture) { const catalog = catalogFor(fixture); const policy = policyFor(catalog, catalog.commands.map(command => command.command_id)); const hiddenRootHash = await hashHiddenAcceptanceRoot(fixture.hidden); const request = qualityRequest(fixture, policy, stableHash("fixture-v1"), hiddenRootHash); const boundary = createQualityGateApprovalBoundary({ request, policy, catalog, fixtureHash: stableHash("fixture-v1"), hiddenRootHash, worktreeRoot: fixture.repo, evidenceRoot: fixture.evidence, realPilot: true }); return { catalog, policy, request, boundary }; }

function changedCatalogOptions(options: CreateQualityGateApprovalBoundaryOptions, mutate: (command: TrustedQualityCommandCatalog["commands"][number]) => TrustedQualityCommandCatalog["commands"][number]): CreateQualityGateApprovalBoundaryOptions { const catalog = createTrustedQualityCommandCatalog({ version: 1, catalog_id: options.catalog.catalog_id, commands: options.catalog.commands.map(mutate) }); const { policy_hash: _hash, ...body } = options.policy; const policy = createQualityGatePolicy({ ...body, command_registry_hash: catalog.catalog_hash }); const request = { ...options.request, policy_hash: policy.policy_hash, catalog_hash: catalog.catalog_hash }; return { ...options, catalog, policy, request }; }

function changedPolicyOptions(options: CreateQualityGateApprovalBoundaryOptions, change: Partial<Omit<QualityGatePolicy, "policy_hash">>): CreateQualityGateApprovalBoundaryOptions { const { policy_hash: _hash, ...body } = options.policy; const policy = createQualityGatePolicy({ ...body, ...change }); return { ...options, policy, request: { ...options.request, policy_hash: policy.policy_hash, max_wall_time_ms: policy.max_wall_time_ms } }; }

function success(stdout = ""): QualityCommandExecution { return { exitCode: 0, stdout, stderr: "", timedOut: false, overflowed: false }; }
const gitRunner: QualityGitRunner = async (cwd, args) => { try { const stdout = await git(cwd, args, true); return { ...success(stdout), exitCode: args[0] === "diff" && args.includes("--no-index") && stdout ? 1 : 0 }; } catch { return { ...success(), exitCode: 1 }; } };
async function git(cwd: string, args: readonly string[], allowOne = false): Promise<string> { const child = spawn("git", [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); const [code] = await once(child, "close") as [number | null]; if (code !== 0 && !(allowOne && code === 1)) throw new Error(stderr); return stdout; }
