import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalQualityGate, createQualityGatePolicy, hashQualityCommandCatalog, readEvidenceArtifact, type QualityCommandExecution, type QualityCommandRunner, type QualityGitRunner } from "../src/quality-gate.js";
import type { QualityCommandId, QualityCommandSpec, QualityGatePolicy, QualityGateRequest } from "../src/types.js";

const roots: string[] = [];
const ALL_COMMANDS: QualityCommandId[] = ["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("S6 local quality gate", () => {
  it("runs a trusted fixed argv registry in deterministic order and freezes a local review diff", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ALL_COMMANDS);
    const calls: Array<{ id: string; cwd: string; args: string[] }> = [];
    const runner: QualityCommandRunner = async (spec, cwd) => { calls.push({ id: spec.command_id, cwd, args: [...spec.args] }); return success("synthetic output"); };
    const gate = qualityGate(fixture, specs, runner); const report = await gate.run(request(fixture, ALL_COMMANDS), fixture.repo);
    expect(report.passed).toBe(true); expect(calls.map(call => call.id)).toEqual(ALL_COMMANDS); expect(calls.every(call => call.cwd === fixture.repo)).toBe(true);
    expect(calls.map(call => call.args)).toEqual(specs.map(spec => spec.args));
    expect(report.quality_gate_results.map(item => item.gate_id)).toEqual(["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", ...ALL_COMMANDS, "final_freeze", "evidence_artifact"]);
    expect(report.tests_run).toHaveLength(6); expect(report.secret_scan_summary).toEqual({ outcome: "passed", findings: 0, baseline_findings: 0, new_findings: 0 });
    const artifact = await readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash);
    expect(artifact.toString("utf8")).toContain("parser = 2"); expect(artifact.toString("utf8")).not.toContain(fixture.root);
  });

  it("rejects model-shaped or reordered command IDs before invoking the runner", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint", "unit_tests"]); const runner = vi.fn(async () => success()); const gate = qualityGate(fixture, specs, runner);
    await expect(gate.preflight({ ...request(fixture, ["lint", "unit_tests"]), command_ids: ["unit_tests", "lint"] }, fixture.repo)).rejects.toThrow(/every approved command/);
    await expect(gate.preflight({ ...request(fixture, ["lint", "unit_tests"]), command_ids: ["npm test" as QualityCommandId] }, fixture.repo)).rejects.toThrow(/command IDs|every approved/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed on an out-of-scope file without reading it or running later gates", async () => {
    const fixture = await repoFixture(); await writeFile(path.join(fixture.repo, "outside.txt"), "synthetic outside\n");
    const runner = vi.fn(async () => success()); const gate = qualityGate(fixture, commandSpecs(fixture.root, ["unit_tests"]), runner);
    const report = await gate.run(request(fixture, ["unit_tests"]), fixture.repo);
    expect(report.passed).toBe(false); expect(report.scope_violations).toEqual(["outside_write_scope:outside.txt"]); expect(report.secret_scan_summary.outcome).toBe("not_run");
    expect(report.quality_gate_results.find(item => item.gate_id === "unit_tests")?.outcome).toBe("not_run"); expect(runner).not.toHaveBeenCalled();
    expect((await readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash)).toString("utf8")).toContain('"blocked":true');
  });

  it("distinguishes an unchanged baseline secret from a newly introduced secret without persisting either value", async () => {
    const baseline = await repoFixture("export const credential = 'api_key=synthetic-baseline-secret';\nexport const parser = 1;\n");
    await writeFile(path.join(baseline.repo, "src", "parser.ts"), "export const credential = 'api_key=synthetic-baseline-secret';\nexport const parser = 2;\n");
    const allowed = await qualityGate(baseline, [], vi.fn()).run(request(baseline, []), baseline.repo);
    expect(allowed.passed).toBe(true); expect(allowed.secret_scan_summary).toEqual({ outcome: "passed", findings: 0, baseline_findings: 1, new_findings: 0 });
    expect((await readEvidenceArtifact(baseline.evidence, allowed.diff_reference, allowed.diff_hash)).toString("utf8")).not.toContain("synthetic-baseline-secret");

    const added = await repoFixture(); await writeFile(path.join(added.repo, "src", "parser.ts"), "export const token = 'api_key=synthetic-new-secret';\n");
    const blocked = await qualityGate(added, [], vi.fn()).run(request(added, []), added.repo);
    expect(blocked.passed).toBe(false); expect(blocked.secret_scan_summary).toEqual({ outcome: "failed", findings: 1, baseline_findings: 0, new_findings: 1 });
    expect((await readEvidenceArtifact(added.evidence, blocked.diff_reference, blocked.diff_hash)).toString("utf8")).not.toContain("synthetic-new-secret");
  });

  it.each([
    ["delete", async (fixture: Fixture) => rm(path.join(fixture.repo, "src", "parser.ts"))],
    ["rename", async (fixture: Fixture) => { await mkdir(path.join(fixture.repo, "lib")); await git(fixture.repo, ["mv", "src/parser.ts", "lib/parser.ts"]); }],
    ["binary", async (fixture: Fixture) => writeFile(path.join(fixture.repo, "src", "parser.ts"), Buffer.from([0, 1, 2]))],
    ["large", async (fixture: Fixture) => writeFile(path.join(fixture.repo, "src", "parser.ts"), "x".repeat(1025))],
  ])("blocks a %s final diff before any approved command", async (_kind, mutate) => {
    const fixture = await repoFixture(); await mutate(fixture); const specs = commandSpecs(fixture.root, ["unit_tests"]); const runner = vi.fn(async () => success());
    const gate = qualityGate(fixture, specs, runner, { max_file_bytes: 1024 }); const report = await gate.run({ ...request(fixture, ["unit_tests"], gate.policy), write_scope: ["src/parser.ts", "lib/parser.ts"] }, fixture.repo);
    expect(report.passed).toBe(false); expect(report.quality_gate_results.find(item => item.gate_id === "diff_sanity")?.outcome).toBe("failed"); expect(runner).not.toHaveBeenCalled();
  });

  it("fails fast and distinguishes not-run from not-applicable", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint", "unit_tests"]); const runner = vi.fn(async (spec: QualityCommandSpec) => spec.command_id === "lint" ? { ...success(), exitCode: 2 } : success());
    const report = await qualityGate(fixture, specs, runner).run(request(fixture, ["lint", "unit_tests"]), fixture.repo);
    expect(runner).toHaveBeenCalledTimes(1); expect(report.quality_gate_results.find(item => item.gate_id === "lint")?.outcome).toBe("failed");
    expect(report.quality_gate_results.find(item => item.gate_id === "unit_tests")?.outcome).toBe("not_run"); expect(report.quality_gate_results.find(item => item.gate_id === "build")?.outcome).toBe("not_applicable");
  });

  it.each(["timeout", "overflow"])("fails a %s command with bounded redacted evidence and no continuation", async kind => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint", "unit_tests"]); const runner = vi.fn(async () => ({ exitCode: kind === "timeout" ? 124 : 125, stdout: "api_key=synthetic-output-secret", stderr: "", timedOut: kind === "timeout", overflowed: kind === "overflow" }));
    const report = await qualityGate(fixture, specs, runner).run(request(fixture, ["lint", "unit_tests"]), fixture.repo);
    expect(runner).toHaveBeenCalledTimes(1); expect(report.tests_run).toHaveLength(1); expect(JSON.stringify(report)).not.toContain("synthetic-output-secret");
    expect(report.quality_gate_results.find(item => item.gate_id === "unit_tests")?.outcome).toBe("not_run");
  });

  it("invalidates the policy when a trusted executable mapping changes", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint"]); const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024 });
    expect(() => new LocalQualityGate({ policy, commandCatalog: [{ ...specs[0], args: ["--different"] }], evidenceRoot: fixture.evidence, runCommand: vi.fn(), runGit: gitRunner })).toThrow(/registry/);
  });

  it("detects a worktree mutation after the artifact checkpoint", async () => {
    const fixture = await repoFixture(); const gate = qualityGate(fixture, [], vi.fn(), {}, async phase => { if (phase === "after_artifact") await writeFile(path.join(fixture.repo, "src", "parser.ts"), "export const parser = 9;\n"); });
    const report = await gate.run(request(fixture, []), fixture.repo); expect(report.passed).toBe(false); expect(report.quality_gate_results.find(item => item.gate_id === "evidence_artifact")?.outcome).toBe("failed");
  });

  it("blocks a check-only command that mutates tracked or ignored content despite exit zero", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["format_check"]);
    const runner: QualityCommandRunner = async () => { await writeFile(path.join(fixture.repo, "src", "parser.ts"), "export const parser = 3;\n"); await mkdir(path.join(fixture.repo, "dist")); await writeFile(path.join(fixture.repo, "dist", "generated.txt"), "generated\n"); return success(); };
    const report = await qualityGate(fixture, specs, runner).run(request(fixture, ["format_check"]), fixture.repo);
    expect(report.passed).toBe(false); expect(report.quality_gate_results.find(item => item.gate_id === "format_check")?.outcome).toBe("failed");
  });

  it("rejects reparse paths and evidence reference traversal without invoking commands", async () => {
    const fixture = await repoFixture(); const outside = path.join(fixture.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel.txt"), "do-not-read\n");
    await expect(readEvidenceArtifact(fixture.evidence, "../outside/sentinel.txt")).rejects.toThrow();
    const link = path.join(fixture.repo, "src", "linked.txt");
    try { await symlink(path.join(outside, "sentinel.txt"), link, "file"); } catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const runner = vi.fn(async () => success()); const gate = qualityGate(fixture, commandSpecs(fixture.root, ["unit_tests"]), runner);
    const report = await gate.run(request(fixture, ["unit_tests"]), fixture.repo); expect(report.passed).toBe(false); expect(report.privacy_violations.some(item => item.startsWith("reparse_path:"))).toBe(true); expect(runner).not.toHaveBeenCalled();
  });

  it("rejects an evidence-root junction alias before creating any artifact", async () => {
    const fixture = await repoFixture(); const target = path.join(fixture.root, "evidence-target"); const alias = path.join(fixture.root, "evidence-alias"); await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024 });
    const gate = new LocalQualityGate({ policy, evidenceRoot: alias, runCommand: vi.fn(), runGit: gitRunner });
    await expect(gate.preflight(request(fixture, [], policy), fixture.repo)).rejects.toThrow(/junction alias/);
  });

  it("detects a tampered local artifact by hash", async () => {
    const fixture = await repoFixture(); const report = await qualityGate(fixture, [], vi.fn()).run(request(fixture, []), fixture.repo);
    await writeFile(path.join(fixture.evidence, report.diff_reference), "tampered\n");
    await expect(readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash)).rejects.toThrow(/hash mismatch/);
  });
});

interface Fixture { root: string; repo: string; evidence: string; base: string }
async function repoFixture(initial = "export const parser = 1;\n"): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-s6-")); roots.push(root); const repo = path.join(root, "repo"); const evidence = path.join(root, "evidence-root");
  await mkdir(path.join(repo, "src"), { recursive: true }); await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.name", "Synthetic Test"]); await git(repo, ["config", "user.email", "synthetic@example.invalid"]); await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "src", "parser.ts"), initial); await writeFile(path.join(repo, ".gitignore"), "dist/\n"); await git(repo, ["add", "--", ".gitignore", "src/parser.ts"]); await git(repo, ["commit", "-m", "synthetic base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim(); await writeFile(path.join(repo, "src", "parser.ts"), initial.replace("parser = 1", "parser = 2")); return { root, repo, evidence, base };
}

function commandSpecs(root: string, ids: QualityCommandId[]): QualityCommandSpec[] { return ids.map(id => ({ command_id: id, executable: path.join(root, "trusted", "synthetic-runner.exe"), args: ["--check", id], timeout_ms: 1_000 })); }
function qualityGate(fixture: Fixture, specs: QualityCommandSpec[], runner: QualityCommandRunner, limits: Partial<{ max_diff_bytes: number; max_file_bytes: number; max_output_bytes: number }> = {}, checkpoint?: (phase: "before_artifact" | "after_artifact") => void | Promise<void>): LocalQualityGate {
  const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: specs.map(spec => spec.command_id), command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: limits.max_diff_bytes ?? 1024 * 1024, max_file_bytes: limits.max_file_bytes ?? 64 * 1024, max_output_bytes: limits.max_output_bytes ?? 4096 });
  return new LocalQualityGate({ policy, commandCatalog: specs, evidenceRoot: fixture.evidence, runCommand: runner, runGit: gitRunner, checkpoint });
}
function request(fixture: Fixture, command_ids: QualityCommandId[], approved?: QualityGatePolicy): QualityGateRequest {
  const specs = commandSpecs(fixture.root, command_ids); const policy = approved ?? createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids, command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096 });
  return { run_id: "synthetic-run", task_id: "synthetic-task", base_commit: fixture.base, plan_hash: "1".repeat(64), approval_hash: "2".repeat(64), isolation_hash: "3".repeat(64), worktree_id: "synthetic-worktree", write_scope: ["src/parser.ts"], command_ids, policy_hash: policy.policy_hash, effective_policy_hash: "4".repeat(64) };
}
function success(stdout = ""): QualityCommandExecution { return { exitCode: 0, stdout, stderr: "", timedOut: false, overflowed: false }; }
const gitRunner: QualityGitRunner = async (cwd, args) => { try { const stdout = await git(cwd, args, true); return { ...success(stdout), exitCode: ["diff"].includes(args[0]) && args.includes("--no-index") && stdout ? 1 : 0 }; } catch { return { ...success(), exitCode: 1 }; } };
async function git(cwd: string, args: readonly string[], allowOne = false): Promise<string> {
  const child = spawn("git", [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null]; if (code !== 0 && !(allowOne && code === 1)) throw new Error(stderr); return stdout;
}
