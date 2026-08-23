import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableHash } from "../src/canonical.js";
import { LocalQualityGate, assertQualityGateReportForRequest, createQualityGatePolicy, hashQualityCommandCatalog, hashQualityGateRequest, readEvidenceArtifact, type QualityCommandExecution, type QualityCommandRunner, type QualityGitRunner } from "../src/quality-gate.js";
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
    expect(report.quality_gate_results.map(item => item.gate_id)).toEqual(["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", ...ALL_COMMANDS, "final_freeze", "evidence_artifact", "gate_budget"]);
    expect(report.tests_run).toHaveLength(6); expect(report.secret_scan_summary).toEqual({ outcome: "passed", findings: 0, baseline_findings: 0, new_findings: 0 });
    const artifact = await readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash);
    expect(artifact.toString("utf8")).toContain("parser = 2"); expect(artifact.toString("utf8")).not.toContain(fixture.root);
  });

  it("rejects model-shaped or reordered command IDs before invoking the runner", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint", "unit_tests"]); const runner = vi.fn(async () => success()); const gate = qualityGate(fixture, specs, runner);
    await expect(gate.preflight({ ...request(fixture, ["lint", "unit_tests"]), command_ids: ["unit_tests", "lint"] }, fixture.repo)).rejects.toThrow(/deterministic order|every approved command/);
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
    const review = (await readEvidenceArtifact(baseline.evidence, allowed.diff_reference, allowed.diff_hash)).toString("utf8");
    expect(review).not.toContain("synthetic-baseline-secret"); expect(review).toContain("parser = 2"); expect(review).not.toContain('"blocked":true');

    const added = await repoFixture(); await writeFile(path.join(added.repo, "src", "parser.ts"), "export const token = 'api_key=synthetic-new-secret';\n");
    const blocked = await qualityGate(added, [], vi.fn()).run(request(added, []), added.repo);
    expect(blocked.passed).toBe(false); expect(blocked.secret_scan_summary).toEqual({ outcome: "failed", findings: 1, baseline_findings: 0, new_findings: 1 });
    expect((await readEvidenceArtifact(added.evidence, blocked.diff_reference, blocked.diff_hash)).toString("utf8")).not.toContain("synthetic-new-secret");
  });

  it("counts a duplicated baseline secret occurrence as newly introduced", async () => {
    const value = "api_key=synthetic-duplicate-secret"; const fixture = await repoFixture(`export const a = '${value}';\n`);
    await writeFile(path.join(fixture.repo, "src", "parser.ts"), `export const a = '${value}';\nexport const b = '${value}';\n`);
    const report = await qualityGate(fixture, [], vi.fn()).run(request(fixture, []), fixture.repo);
    expect(report.passed).toBe(false); expect(report.secret_scan_summary).toMatchObject({ baseline_findings: 1, new_findings: 1 });
  });

  it("keeps baseline-secret comparison raw on the production Git runner", async () => {
    const fixture = await repoFixture("export const credential = 'api_key=synthetic-production-baseline';\nexport const parser = 1;\n");
    await writeFile(path.join(fixture.repo, "src", "parser.ts"), "export const credential = 'api_key=synthetic-production-baseline';\nexport const parser = 2;\n");
    const policy = createQualityGatePolicy({ version: 1, policy_id: "production-git", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 60_000 });
    const report = await new LocalQualityGate({ policy, evidenceRoot: fixture.evidence }).run(request(fixture, [], policy), fixture.repo);
    expect(report.passed).toBe(true); expect(report.secret_scan_summary).toEqual({ outcome: "passed", findings: 0, baseline_findings: 1, new_findings: 0 });
  });

  it("fails closed on a missing promisor blob without changing the shared object store", async () => {
    const fixture = await repoFixture(); const object = (await git(fixture.repo, ["rev-parse", "HEAD:src/parser.ts"])).trim(); const objectPath = path.join(fixture.repo, ".git", "objects", object.slice(0, 2), object.slice(2));
    await git(fixture.repo, ["config", "extensions.partialClone", "origin"]); await git(fixture.repo, ["config", "remote.origin.promisor", "true"]); await git(fixture.repo, ["config", "remote.origin.url", path.join(fixture.root, "missing-promisor")]); await rm(objectPath);
    const before = await objectFiles(path.join(fixture.repo, ".git", "objects")); const policy = createQualityGatePolicy({ version: 1, policy_id: "no-lazy-fetch", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 60_000 });
    await expect(new LocalQualityGate({ policy, evidenceRoot: fixture.evidence }).run(request(fixture, [], policy), fixture.repo)).rejects.toThrow();
    expect(await objectFiles(path.join(fixture.repo, ".git", "objects"))).toEqual(before);
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
    expect(report.tests_run[0].output_summary).toContain("[REDACTED_SECRET]");
    expect(report.quality_gate_results.find(item => item.gate_id === "unit_tests")?.outcome).toBe("not_run");
  });

  it.each(["timeout", "overflow"])("covers the production spawn path and terminates the process tree for %s", async kind => {
    const fixture = await repoFixture(); const helper = path.join(fixture.root, "quality-helper.mjs"); const grandchild = path.join(fixture.root, "quality-grandchild.mjs"); const heartbeat = path.join(fixture.root, "heartbeat.txt");
    await writeFile(grandchild, `import { appendFileSync } from "node:fs"; setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "x"), 20);\n`);
    await writeFile(helper, `import { spawn } from "node:child_process"; const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }); child.unref(); process.on("SIGTERM", () => {}); ${kind === "overflow" ? "setTimeout(() => process.stdout.write('api_key=synthetic-production-secret-' + 'x'.repeat(65536)), 150);" : ""} setInterval(() => {}, 1000);\n`);
    const spec: QualityCommandSpec = { command_id: "lint", executable: process.execPath, args: [helper], timeout_ms: kind === "timeout" ? 500 : 2_000 };
    const policy = createQualityGatePolicy({ version: 1, policy_id: `production-${kind}`, command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog([spec]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 1024, max_wall_time_ms: 60_000 });
    const report = await new LocalQualityGate({ policy, commandCatalog: [spec], evidenceRoot: fixture.evidence, runGit: gitRunner }).run(request(fixture, ["lint"], policy), fixture.repo);
    expect(report.passed).toBe(false); expect(report.tests_run).toHaveLength(1); expect(report.tests_run[0][kind === "timeout" ? "timed_out" : "output_overflowed"]).toBe(true);
    expect(JSON.stringify(report)).not.toContain("synthetic-production-secret");
    const before = await readFile(heartbeat); await new Promise(resolve => setTimeout(resolve, 300)); expect((await readFile(heartbeat)).length).toBe(before.length);
  }, 15_000);

  it("fails closed when the total quality-gate wall-time budget is exhausted", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint"]); let clock = 0;
    const runner = vi.fn(async (spec: QualityCommandSpec) => ({ exitCode: 124, stdout: "", stderr: "", timedOut: spec.timeout_ms < 1_000, overflowed: false }));
    const policy = createQualityGatePolicy({ version: 1, policy_id: "wall-budget", command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 10_000 });
    const gate = new LocalQualityGate({ policy, commandCatalog: specs, evidenceRoot: fixture.evidence, runCommand: runner, runGit: gitRunner, now: () => (clock += 9_500) });
    const report = await gate.run(request(fixture, ["lint"], policy), fixture.repo);
    expect(report.passed).toBe(false); expect(report.quality_gate_results.find(item => item.gate_id === "gate_budget")?.outcome).toBe("failed"); expect(report.quality_gate_results.find(item => item.gate_id === "lint")?.outcome).toBe("not_run"); expect(report.tests_run).toHaveLength(0);
  });

  it("keeps a wall-budget-clipped command timeout distinct from exhausted elapsed time", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint"]); let calls = 0;
    const runner = vi.fn(async (spec: QualityCommandSpec) => ({ exitCode: 124, stdout: "", stderr: "", timedOut: spec.timeout_ms === 500, overflowed: false }));
    const policy = createQualityGatePolicy({ version: 1, policy_id: "wall-budget-clipped-command", command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 10_000 });
    const gate = new LocalQualityGate({ policy, commandCatalog: specs, evidenceRoot: fixture.evidence, runCommand: runner, runGit: gitRunner, now: () => calls++ === 0 ? 0 : 8_000 });
    const report = await gate.run(request(fixture, ["lint"], policy), fixture.repo);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ timeout_ms: 500 }), fixture.repo, policy.max_output_bytes);
    expect(report.passed).toBe(false); expect(report.tests_run).toHaveLength(1); expect(report.tests_run[0].timed_out).toBe(true);
    expect(report.quality_gate_results.find(item => item.gate_id === "lint")?.outcome).toBe("failed"); expect(report.quality_gate_results.find(item => item.gate_id === "gate_budget")?.outcome).toBe("passed");
  });

  it("returns within the total wall-time deadline when Git evidence stalls", async () => {
    const fixture = await repoFixture(); const policy = createQualityGatePolicy({ version: 1, policy_id: "stalled-git-budget", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024, max_wall_time_ms: 100 });
    const stalled: QualityGitRunner = async () => new Promise(resolve => setTimeout(() => resolve(success()), 1_000)); const started = Date.now();
    await expect(new LocalQualityGate({ policy, evidenceRoot: fixture.evidence, runGit: stalled }).run(request(fixture, [], policy), fixture.repo)).rejects.toThrow(/wall-time budget/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns within the total wall-time deadline when an artifact checkpoint stalls", async () => {
    const fixture = await repoFixture(); let entered = false; const policy = createQualityGatePolicy({ version: 1, policy_id: "stalled-checkpoint-budget", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 6_000 });
    const started = Date.now(); const gate = new LocalQualityGate({ policy, evidenceRoot: fixture.evidence, runGit: gitRunner, checkpoint: phase => { if (phase === "before_artifact") { entered = true; return new Promise<void>(() => {}); } } });
    await expect(gate.run(request(fixture, [], policy), fixture.repo)).rejects.toThrow(/wall-time budget/); expect(entered).toBe(true); expect(Date.now() - started).toBeLessThan(7_500);
  }, 10_000);

  it("enforces the raw diff limit before redaction can shrink the review artifact", async () => {
    const fixture = await repoFixture(); await writeFile(path.join(fixture.repo, "src", "parser.ts"), `export const token = 'api_key=${"x".repeat(2_000)}';\n`);
    const gate = qualityGate(fixture, [], vi.fn(), { max_diff_bytes: 256, max_file_bytes: 4096 }); const report = await gate.run(request(fixture, [], gate.policy), fixture.repo);
    expect(report.passed).toBe(false); expect(report.quality_gate_results.find(item => item.gate_id === "diff_sanity")?.summary).toContain("raw_diff_size_limit_exceeded");
  });

  it("uses read-only Git metadata and rejects report replay or tampering", async () => {
    const fixture = await repoFixture(); const calls: string[][] = []; const runner: QualityGitRunner = async (cwd, args) => { calls.push([...args]); return gitRunner(cwd, args); };
    const policy = createQualityGatePolicy({ version: 1, policy_id: "readonly-git", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 60_000 });
    const approved = request(fixture, [], policy); const report = await new LocalQualityGate({ policy, evidenceRoot: fixture.evidence, runGit: runner }).run(approved, fixture.repo);
    expect(calls.some(args => args[0] === "write-tree")).toBe(false); expect(() => assertQualityGateReportForRequest(report, { ...approved, approval_hash: "9".repeat(64) })).toThrow(/approval_hash/);
    expect(() => assertQualityGateReportForRequest({ ...report, passed: !report.passed }, approved)).toThrow(/hash|contradicts/);
  });

  it("fails closed on assume-unchanged both before and during approved commands", async () => {
    const fixture = await repoFixture(); await git(fixture.repo, ["update-index", "--assume-unchanged", "src/parser.ts"]);
    await expect(qualityGate(fixture, [], vi.fn()).run(request(fixture, []), fixture.repo)).rejects.toThrow(/nonstandard Git index flags/);
    await git(fixture.repo, ["update-index", "--no-assume-unchanged", "src/parser.ts"]); const specs = commandSpecs(fixture.root, ["lint"]);
    const runner: QualityCommandRunner = async () => { await git(fixture.repo, ["update-index", "--assume-unchanged", "src/parser.ts"]); await writeFile(path.join(fixture.repo, "src", "parser.ts"), "export const parser = 99;\n"); return success(); };
    await expect(qualityGate(fixture, specs, runner).run(request(fixture, ["lint"]), fixture.repo)).rejects.toThrow(/nonstandard Git index flags/);
  });

  it("rejects semantically incomplete, contradictory, or differently scoped reports even when rehashed", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint"]); const runner = vi.fn(async () => success()); const gate = qualityGate(fixture, specs, runner); const approved = request(fixture, ["lint"], gate.policy); const report = await gate.run(approved, fixture.repo);
    const rehash = (patch: Record<string, unknown>) => { const { report_hash: _old, ...body } = { ...report, ...patch }; return { ...body, report_hash: stableHash(body) } as typeof report; };
    expect(() => assertQualityGateReportForRequest(report, { ...approved, write_scope: ["src/other.ts"] })).toThrow(/request hash/);
    const commandNotApplicable = report.quality_gate_results.map(item => item.gate_id === "lint" ? { ...item, outcome: "not_applicable" as const } : item);
    expect(() => assertQualityGateReportForRequest(rehash({ quality_gate_results: commandNotApplicable, tests_run: [] }), approved)).toThrow(/command evidence|not-run/);
    const safetyNotApplicable = report.quality_gate_results.map(item => item.gate_id === "base_identity" ? { ...item, outcome: "not_applicable" as const } : item);
    expect(() => assertQualityGateReportForRequest(rehash({ quality_gate_results: safetyNotApplicable }), approved)).toThrow(/safety gate/);
    expect(() => assertQualityGateReportForRequest(rehash({ passed: false, secret_scan_summary: { outcome: "failed", findings: 1, baseline_findings: 0, new_findings: 1 } }), approved)).toThrow(/secret gate/);
    const extra = { command_id: "arbitrary", exit_code: 0, output_hash: "f".repeat(64), output_summary: "synthetic", timed_out: false, output_overflowed: false, worktree_mutated: false };
    expect(() => assertQualityGateReportForRequest(rehash({ tests_run: [...report.tests_run, extra] }), approved)).toThrow(/unknown|extra/);
    expect(() => assertQualityGateReportForRequest(rehash({ files_changed: ["outside.ts"] }), approved)).toThrow(/write scope/);
    expect(() => assertQualityGateReportForRequest(rehash({ post_artifact_snapshot_hash: "f".repeat(64) }), approved)).toThrow(/artifact gate/);
    expect(() => assertQualityGateReportForRequest(rehash({ wall_clock_time_ms: approved.max_wall_time_ms }), approved)).toThrow(/gate_budget/);
    const sensitiveRequest = { ...approved, write_scope: [".env"] }; expect(() => assertQualityGateReportForRequest(rehash({ request_hash: hashQualityGateRequest(sensitiveRequest), files_changed: [".env"] }), sensitiveRequest)).toThrow(/forbidden-path/);
  });

  it("invalidates the policy when a trusted executable mapping changes", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["lint"]); const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: ["lint"], command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024, max_wall_time_ms: 60_000 });
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

  it("refreshes final forbidden evidence before persisting a command-created artifact", async () => {
    const fixture = await repoFixture(); const specs = commandSpecs(fixture.root, ["format_check"]); const forbiddenContent = "SYNTHETIC_FORBIDDEN_CONTENT_MUST_NOT_PERSIST";
    const runner: QualityCommandRunner = async () => { await writeFile(path.join(fixture.repo, "src", ".env"), forbiddenContent); return success(); };
    const gate = qualityGate(fixture, specs, runner); const approved = { ...request(fixture, ["format_check"], gate.policy), write_scope: ["src/**"] };
    const report = await gate.run(approved, fixture.repo); const artifact = (await readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash)).toString("utf8");
    expect(report.passed).toBe(false); expect(report.privacy_violations).toContain("forbidden_path:src/.env"); expect(report.quality_gate_results.find(item => item.gate_id === "forbidden_paths")?.outcome).toBe("failed");
    expect(artifact).toContain('"blocked":true'); expect(artifact).not.toContain(forbiddenContent);
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
    const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: [], command_registry_hash: hashQualityCommandCatalog([]), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024, max_wall_time_ms: 60_000 });
    const gate = new LocalQualityGate({ policy, evidenceRoot: alias, runCommand: vi.fn(), runGit: gitRunner });
    await expect(gate.preflight(request(fixture, [], policy), fixture.repo)).rejects.toThrow(/junction alias/);
  });

  it("fails closed if the managed evidence directory is swapped to a junction after preflight", async () => {
    const fixture = await repoFixture(); const outside = path.join(fixture.root, "evidence-swap-target"); await mkdir(outside); await mkdir(fixture.evidence);
    const gate = qualityGate(fixture, [], vi.fn(), {}, async phase => {
      if (phase !== "before_artifact") return;
      try { await symlink(outside, path.join(fixture.evidence, "evidence"), process.platform === "win32" ? "junction" : "dir"); }
      catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    });
    await expect(gate.run(request(fixture, []), fixture.repo)).rejects.toThrow(/owned physical directory/);
  });

  it("detects a tampered local artifact by hash", async () => {
    const fixture = await repoFixture(); const report = await qualityGate(fixture, [], vi.fn()).run(request(fixture, []), fixture.repo);
    await writeFile(path.join(fixture.evidence, report.diff_reference), "tampered\n");
    await expect(readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash)).rejects.toThrow(/hash mismatch/);
  });
  it("rejects an oversized pre-existing evidence artifact before reading it", async () => {
    const fixture = await repoFixture(); const report = await qualityGate(fixture, [], vi.fn()).run(request(fixture, []), fixture.repo); const handle = await open(path.join(fixture.evidence, report.diff_reference), "r+"); try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(readEvidenceArtifact(fixture.evidence, report.diff_reference, report.diff_hash)).rejects.toThrow(/size boundary/);
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
function qualityGate(fixture: Fixture, specs: QualityCommandSpec[], runner: QualityCommandRunner, limits: Partial<{ max_diff_bytes: number; max_file_bytes: number; max_output_bytes: number; max_wall_time_ms: number }> = {}, checkpoint?: (phase: "before_artifact" | "after_artifact") => void | Promise<void>): LocalQualityGate {
  const policy = createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids: specs.map(spec => spec.command_id), command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: limits.max_diff_bytes ?? 1024 * 1024, max_file_bytes: limits.max_file_bytes ?? 64 * 1024, max_output_bytes: limits.max_output_bytes ?? 4096, max_wall_time_ms: limits.max_wall_time_ms ?? 60_000 });
  return new LocalQualityGate({ policy, commandCatalog: specs, evidenceRoot: fixture.evidence, runCommand: runner, runGit: gitRunner, checkpoint });
}
function request(fixture: Fixture, command_ids: QualityCommandId[], approved?: QualityGatePolicy): QualityGateRequest {
  const specs = commandSpecs(fixture.root, command_ids); const policy = approved ?? createQualityGatePolicy({ version: 1, policy_id: "synthetic-quality-policy", command_ids, command_registry_hash: hashQualityCommandCatalog(specs), max_diff_bytes: 1024 * 1024, max_file_bytes: 64 * 1024, max_output_bytes: 4096, max_wall_time_ms: 60_000 });
  return { run_id: "synthetic-run", task_id: "synthetic-task", base_commit: fixture.base, plan_hash: "1".repeat(64), approval_hash: "2".repeat(64), isolation_hash: "3".repeat(64), worktree_id: "synthetic-worktree", write_scope: ["src/parser.ts"], command_ids, policy_hash: policy.policy_hash, effective_policy_hash: "4".repeat(64), max_wall_time_ms: policy.max_wall_time_ms };
}
function success(stdout = ""): QualityCommandExecution { return { exitCode: 0, stdout, stderr: "", timedOut: false, overflowed: false }; }
const gitRunner: QualityGitRunner = async (cwd, args) => { try { const stdout = await git(cwd, args, true); return { ...success(stdout), exitCode: ["diff"].includes(args[0]) && args.includes("--no-index") && stdout ? 1 : 0 }; } catch { return { ...success(), exitCode: 1 }; } };
async function git(cwd: string, args: readonly string[], allowOne = false): Promise<string> {
  const child = spawn("git", [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null]; if (code !== 0 && !(allowOne && code === 1)) throw new Error(stderr); return stdout;
}
async function objectFiles(root: string, relative = ""): Promise<string[]> { const entries = await readdir(path.join(root, relative), { withFileTypes: true }); const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? objectFiles(root, path.join(relative, entry.name)) : [path.join(relative, entry.name).replace(/\\/g, "/")])); return nested.flat().sort(); }
