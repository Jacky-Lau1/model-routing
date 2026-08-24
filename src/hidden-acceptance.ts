import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./canonical.js";
import { assertQualityGateReport, executeApprovedQualityCommand, type QualityCommandExecution, type QualityCommandRunner } from "./quality-gate.js";
import { assertQualityGateApprovalBoundary, assertTrustedQualityCommandCatalog, type QualityGateApprovalBoundary, type TrustedQualityCommand, type TrustedQualityCommandCatalog } from "./quality-gate-config.js";
import type { AcceptanceCounts as HiddenAcceptanceCounts, HiddenAcceptanceResult, QualityAcceptanceProjection, QualityGateReport } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const MAX_HIDDEN_FILES = 4096;
const MAX_HIDDEN_BYTES = 64 * 1024 * 1024;

export type { AcceptanceCounts as HiddenAcceptanceCounts, HiddenAcceptanceResult, QualityAcceptanceProjection } from "./types.js";

export interface RunHiddenAcceptanceOptions {
  hiddenRoot: string;
  worktreeRoot: string;
  evidenceRoot: string;
  egressPaths: readonly string[];
  catalog: TrustedQualityCommandCatalog;
  boundary: QualityGateApprovalBoundary;
  runCommand?: QualityCommandRunner;
}

export async function hashHiddenAcceptanceRoot(hiddenRoot: string): Promise<string> {
  return hashBoundedPhysicalRoot(hiddenRoot, "hidden acceptance root");
}

export async function hashQualityFixtureRoot(fixtureRoot: string): Promise<string> {
  return hashBoundedPhysicalRoot(fixtureRoot, "quality fixture root");
}

async function hashBoundedPhysicalRoot(inputRoot: string, label: string): Promise<string> {
  const root = await assertPhysicalDirectory(inputRoot, label);
  const files: Array<{ path: string; bytes: number; hash: string }> = [];
  let totalBytes = 0;
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift()!;
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name).replace(/\\/g, "/");
      const target = path.join(root, ...relative.split("/"));
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Hidden acceptance root must not contain symlinks or reparse aliases");
      if (entry.isDirectory() && info.isDirectory()) { pending.push(relative); continue; }
      if (!entry.isFile() || !info.isFile() || info.nlink !== 1) throw new Error("Hidden acceptance root contains an unsupported file identity");
      totalBytes += info.size;
      if (files.length >= MAX_HIDDEN_FILES || totalBytes > MAX_HIDDEN_BYTES) throw new Error("Hidden acceptance root exceeds its local-only size boundary");
      const bytes = await readFile(target);
      const after = await lstat(target);
      if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("Hidden acceptance file changed while it was hashed");
      files.push({ path: relative, bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return stableHash({ version: 1, files, total_bytes: totalBytes });
}

export async function assertHiddenAcceptanceIsolation(hiddenRoot: string, worktreeRoot: string, evidenceRoot: string, egressPaths: readonly string[]): Promise<{ hidden: string; worktree: string; evidence: string }> {
  const hidden = await assertPhysicalDirectory(hiddenRoot, "hidden acceptance root");
  const worktree = await assertPhysicalDirectory(worktreeRoot, "quality worktree root");
  const evidence = await resolvePhysicalOrFutureDirectory(evidenceRoot, "quality evidence root");
  if (overlap(hidden, worktree) || overlap(hidden, evidence) || overlap(worktree, evidence)) throw new Error("Hidden, worktree, and evidence roots must be pairwise external");
  for (const candidate of egressPaths) {
    if (typeof candidate !== "string" || candidate.includes("\0")) throw new Error("Egress path is invalid");
    if (path.isAbsolute(candidate) && overlap(hidden, path.resolve(candidate))) throw new Error("Hidden acceptance data must be excluded from every egress path");
  }
  return { hidden, worktree, evidence };
}

export async function runHiddenAcceptance(options: RunHiddenAcceptanceOptions): Promise<HiddenAcceptanceResult> {
  assertTrustedQualityCommandCatalog(options.catalog);
  assertQualityGateApprovalBoundary(options.boundary);
  const roots = await assertHiddenAcceptanceIsolation(options.hiddenRoot, options.worktreeRoot, options.evidenceRoot, options.egressPaths);
  const command = options.catalog.commands.find(entry => entry.command_id === "project_acceptance" && entry.visibility === "hidden");
  if (!command) throw new Error("Trusted catalog has no hidden project_acceptance command");
  const approved = options.boundary.commands.find(entry => entry.command_id === command.command_id);
  if (!approved || approved.visibility !== "hidden" || approved.executable !== command.executable || approved.argv.join("\0") !== command.argv.join("\0") || approved.cwd !== roots.worktree || approved.timeout_ms !== command.timeout_ms || approved.max_output_bytes !== command.max_output_bytes) throw new Error("Hidden acceptance command is not exactly bound by the approved quality boundary");
  const executable = await realpath(command.executable);
  if (!contained(roots.hidden, executable)) throw new Error("Hidden acceptance executable must be owned by the model-inaccessible hidden root");
  const beforeHash = await hashHiddenAcceptanceRoot(roots.hidden);
  if (beforeHash !== options.boundary.hidden_root_hash) throw new Error("Hidden acceptance fixture changed after approval");
  const raw = await (options.runCommand ?? defaultRunner)(toLegacySpec(command), roots.worktree, command.max_output_bytes);
  const afterHash = await hashHiddenAcceptanceRoot(roots.hidden);
  const hiddenRootUnchanged = afterHash === beforeHash;
  const parsed = parseHiddenProtocol(raw);
  const passed = raw.exitCode === 0 && !raw.timedOut && !raw.overflowed && hiddenRootUnchanged && parsed.valid && parsed.counts.failed === 0 && parsed.counts.not_run === 0 && parsed.counts.passed > 0;
  const counts = parsed.valid ? parsed.counts : { passed: 0, failed: 1, not_run: 0 };
  const diagnostic = {
    exit_code: raw.exitCode,
    timed_out: raw.timedOut,
    output_overflowed: raw.overflowed,
    hidden_root_unchanged: hiddenRootUnchanged,
    protocol_valid: parsed.valid,
    stdout_bytes: Buffer.byteLength(raw.stdout),
    stderr_bytes: Buffer.byteLength(raw.stderr),
  };
  const body: Omit<HiddenAcceptanceResult, "result_hash"> = {
    version: 1,
    command_id: "project_acceptance",
    approval_boundary_hash: options.boundary.approval_boundary_hash,
    fixture_hash: options.boundary.fixture_hash,
    base_commit: options.boundary.base_commit,
    counts,
    passed,
    exit_code: raw.exitCode,
    timed_out: raw.timedOut,
    output_overflowed: raw.overflowed,
    hidden_root_unchanged: hiddenRootUnchanged,
    diagnostic_hash: stableHash(diagnostic),
    output_summary: passed ? "Hidden acceptance passed; detailed output remains local-only." : "Hidden acceptance failed; detailed output remains local-only.",
    redaction_notes: ["hidden_stdout_not_exported", "hidden_stderr_not_exported", "hidden_paths_not_exported", "reference_answer_not_exported"],
  };
  const result = { ...body, result_hash: stableHash(body) };
  assertHiddenAcceptanceResult(result);
  return Object.freeze({ ...result, counts: Object.freeze({ ...result.counts }), redaction_notes: Object.freeze([...result.redaction_notes]) as unknown as string[] });
}

export function assertHiddenAcceptanceResult(value: unknown): asserts value is HiddenAcceptanceResult {
  if (!isRecord(value)) throw new Error("Hidden acceptance result must be an object");
  exactKeys(value, ["version", "command_id", "approval_boundary_hash", "fixture_hash", "base_commit", "counts", "passed", "exit_code", "timed_out", "output_overflowed", "hidden_root_unchanged", "diagnostic_hash", "output_summary", "redaction_notes", "result_hash"], "Hidden acceptance result");
  if (value.version !== 1 || value.command_id !== "project_acceptance" || !HASH.test(String(value.approval_boundary_hash)) || !HASH.test(String(value.fixture_hash)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(value.base_commit)) || typeof value.passed !== "boolean" || !Number.isInteger(value.exit_code) || typeof value.timed_out !== "boolean" || typeof value.output_overflowed !== "boolean" || typeof value.hidden_root_unchanged !== "boolean" || !HASH.test(String(value.diagnostic_hash)) || !HASH.test(String(value.result_hash))) throw new Error("Hidden acceptance result identity is invalid");
  assertCounts(value.counts);
  if (typeof value.output_summary !== "string" || Buffer.byteLength(value.output_summary) > 256 || !/^Hidden acceptance (?:passed|failed); detailed output remains local-only\.$/.test(value.output_summary)) throw new Error("Hidden acceptance summary is not bounded and opaque");
  if (!Array.isArray(value.redaction_notes) || value.redaction_notes.join("\0") !== "hidden_stdout_not_exported\0hidden_stderr_not_exported\0hidden_paths_not_exported\0reference_answer_not_exported") throw new Error("Hidden acceptance redaction evidence is invalid");
  if (value.passed !== ((value.counts as HiddenAcceptanceCounts).passed > 0 && (value.counts as HiddenAcceptanceCounts).failed === 0 && (value.counts as HiddenAcceptanceCounts).not_run === 0 && value.exit_code === 0 && value.timed_out === false && value.output_overflowed === false && value.hidden_root_unchanged === true)) throw new Error("Hidden acceptance passed flag contradicts deterministic evidence");
  const { result_hash: _hash, ...body } = value;
  if (stableHash(body) !== value.result_hash) throw new Error("Hidden acceptance result hash does not match canonical content");
}

export function createQualityAcceptanceProjection(report: QualityGateReport, catalog: TrustedQualityCommandCatalog, boundary: QualityGateApprovalBoundary, hidden: HiddenAcceptanceResult): QualityAcceptanceProjection {
  assertQualityGateReport(report);
  assertTrustedQualityCommandCatalog(catalog);
  assertQualityGateApprovalBoundary(boundary);
  assertHiddenAcceptanceResult(hidden);
  if (report.report_hash === "" || report.base_commit !== boundary.base_commit || report.request_hash !== boundary.request_hash || hidden.approval_boundary_hash !== boundary.approval_boundary_hash || hidden.fixture_hash !== boundary.fixture_hash || hidden.base_commit !== boundary.base_commit) throw new Error("Acceptance evidence is not bound to the same report, fixture, base, and approval boundary");
  const gates = new Map(report.quality_gate_results.map(gate => [gate.gate_id, gate.outcome]));
  const visible = catalog.commands.filter(command => command.visibility === "visible");
  const visibleTests = visible.reduce<HiddenAcceptanceCounts>((counts, command) => {
    const outcome = gates.get(command.command_id);
    if (outcome === "passed") counts.passed += 1;
    else if (outcome === "failed") counts.failed += 1;
    else counts.not_run += 1;
    return counts;
  }, { passed: 0, failed: 0, not_run: 0 });
  const scopePassed = gates.get("preapply_scope") === "passed" && gates.get("changed_files_scope") === "passed";
  const secretPassed = gates.get("secret_scan") === "passed";
  const diffPassed = gates.get("diff_sanity") === "passed" && gates.get("evidence_artifact") === "passed";
  const freezePassed = gates.get("final_freeze") === "passed" && report.content_snapshot_hash === report.post_artifact_snapshot_hash;
  const regression = !report.passed || visibleTests.failed > 0 || visibleTests.not_run > 0 || hidden.counts.failed > 0 || hidden.counts.not_run > 0 || !hidden.passed;
  const body: Omit<QualityAcceptanceProjection, "result_hash"> = {
    version: 1,
    approval_boundary_hash: boundary.approval_boundary_hash,
    quality_report_hash: report.report_hash,
    fixture_hash: boundary.fixture_hash,
    base_commit: boundary.base_commit,
    visible_tests: visibleTests,
    hidden_tests: { ...hidden.counts },
    regression,
    scope_passed: scopePassed,
    secret_passed: secretPassed,
    diff_passed: diffPassed,
    freeze_passed: freezePassed,
  };
  const projection = { ...body, result_hash: stableHash(body) };
  assertQualityAcceptanceProjection(projection);
  return Object.freeze({ ...projection, visible_tests: Object.freeze({ ...projection.visible_tests }), hidden_tests: Object.freeze({ ...projection.hidden_tests }) });
}

export function assertQualityAcceptanceProjection(value: unknown): asserts value is QualityAcceptanceProjection {
  if (!isRecord(value)) throw new Error("Quality acceptance projection must be an object");
  exactKeys(value, ["version", "approval_boundary_hash", "quality_report_hash", "fixture_hash", "base_commit", "visible_tests", "hidden_tests", "regression", "scope_passed", "secret_passed", "diff_passed", "freeze_passed", "result_hash"], "Quality acceptance projection");
  if (value.version !== 1 || !HASH.test(String(value.approval_boundary_hash)) || !HASH.test(String(value.quality_report_hash)) || !HASH.test(String(value.fixture_hash)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(value.base_commit)) || typeof value.regression !== "boolean" || typeof value.scope_passed !== "boolean" || typeof value.secret_passed !== "boolean" || typeof value.diff_passed !== "boolean" || typeof value.freeze_passed !== "boolean" || !HASH.test(String(value.result_hash))) throw new Error("Quality acceptance projection identity is invalid");
  assertCounts(value.visible_tests); assertCounts(value.hidden_tests);
  const visible = value.visible_tests as HiddenAcceptanceCounts; const hidden = value.hidden_tests as HiddenAcceptanceCounts;
  const deterministicFailure = visible.failed > 0 || visible.not_run > 0 || hidden.failed > 0 || hidden.not_run > 0 || !value.scope_passed || !value.secret_passed || !value.diff_passed || !value.freeze_passed;
  if (deterministicFailure && value.regression !== true) throw new Error("Quality acceptance regression flag contradicts deterministic gate evidence");
  const { result_hash: _hash, ...body } = value;
  if (stableHash(body) !== value.result_hash) throw new Error("Quality acceptance projection hash does not match canonical content");
}

function parseHiddenProtocol(execution: QualityCommandExecution): { valid: boolean; counts: HiddenAcceptanceCounts } {
  if (execution.overflowed || Buffer.byteLength(execution.stdout) > 4096 || Buffer.byteLength(execution.stderr) > 4096) return { valid: false, counts: { passed: 0, failed: 1, not_run: 0 } };
  try {
    const value = JSON.parse(execution.stdout) as unknown;
    if (!isRecord(value)) throw new Error();
    exactKeys(value, ["version", "passed", "failed", "not_run"], "Hidden acceptance protocol");
    if (value.version !== 1) throw new Error();
    const counts = { passed: value.passed, failed: value.failed, not_run: value.not_run };
    assertCounts(counts);
    return { valid: true, counts };
  } catch { return { valid: false, counts: { passed: 0, failed: 1, not_run: 0 } }; }
}

function toLegacySpec(command: TrustedQualityCommand) { return { command_id: command.command_id, executable: command.executable, args: [...command.argv], timeout_ms: command.timeout_ms }; }
const defaultRunner: QualityCommandRunner = (spec, cwd, maxOutputBytes) => executeApprovedQualityCommand(spec, cwd, maxOutputBytes);

async function assertPhysicalDirectory(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error(`${label} must be an exact absolute path`);
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
  const physical = await realpath(value);
  if (physical !== value) throw new Error(`${label} must not use a junction or alias`);
  return physical;
}

async function resolvePhysicalOrFutureDirectory(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error(`${label} must be an exact absolute path`);
  try { return await assertPhysicalDirectory(value, label); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(value));
    if (path.join(parent, path.basename(value)) !== value) throw new Error(`${label} must not use an aliased parent`);
    return value;
  }
}

function contained(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function overlap(left: string, right: string): boolean { return left === right || contained(left, right) || contained(right, left); }
function assertCounts(value: unknown): asserts value is HiddenAcceptanceCounts { if (!isRecord(value)) throw new Error("Acceptance counts are invalid"); exactKeys(value, ["passed", "failed", "not_run"], "Acceptance counts"); for (const key of ["passed", "failed", "not_run"] as const) if (!Number.isInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 1_000_000) throw new Error("Acceptance counts exceed their boundary"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`${label} has unknown or missing fields`); }
