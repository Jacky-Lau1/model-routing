import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./canonical.js";
import { assertEvidenceBundle, assertPathScope, assertSafeRelativePath } from "./contracts.js";
import { redactText } from "./redaction.js";
import { isAllowedPath } from "./scope-guard.js";
import type { EvidenceBundle, QualityCommandId, QualityCommandSpec, QualityGatePolicy, QualityGateReport, QualityGateRequest } from "./types.js";

const COMMAND_ORDER: QualityCommandId[] = ["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FORBIDDEN_PATH = /(?:^|\/)(?:\.git|\.codex|\.ssh|\.aws|\.azure)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.envrc|credentials?(?:\..*)?|api[-_]?key(?:\..*)?|private[-_]?key(?:\..*)?|password(?:\..*)?|secret(?:\..*)?|token(?:\..*)?)(?:$|\/)/i;
const SECRET_RULES = [
  ["private_key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g],
  ["assignment", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;"']{6,}/gi],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["provider_key", /\b(?:sk|ds|pk)-(?:live-|test-)?[A-Za-z0-9_-]{16,}\b/gi],
] as const;

export interface QualityCommandExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
}

export type QualityCommandRunner = (spec: QualityCommandSpec, cwd: string, maxOutputBytes: number) => Promise<QualityCommandExecution>;
export type QualityGitRunner = (cwd: string, args: readonly string[]) => Promise<QualityCommandExecution>;

export interface QualityGateOptions {
  policy: QualityGatePolicy;
  commandCatalog?: readonly QualityCommandSpec[];
  evidenceRoot: string;
  runCommand?: QualityCommandRunner;
  runGit?: QualityGitRunner;
  now?: () => number;
  checkpoint?: (phase: "before_artifact" | "after_artifact") => void | Promise<void>;
}

interface ChangeEntry { status: "modified" | "added" | "deleted" | "renamed" | "untracked"; path: string; originalPath: string | null }
interface DiffSnapshot { head: string; entries: ChangeEntry[]; files: string[]; unsafePaths: string[]; reviewBytes: Buffer; reviewHash: string; snapshotHash: string }
type GateOutcome = EvidenceBundle["quality_gate_results"][number]["outcome"];

export function createQualityGatePolicy(input: Omit<QualityGatePolicy, "policy_hash">): QualityGatePolicy {
  const body = {
    ...input,
    command_ids: [...input.command_ids],
  };
  const policy = Object.freeze({ ...body, command_ids: Object.freeze(body.command_ids) as unknown as QualityCommandId[], policy_hash: stableHash(body) });
  assertQualityGatePolicy(policy);
  return policy;
}

export function hashQualityCommandCatalog(specs: readonly QualityCommandSpec[]): string {
  const canonical = specs.map(spec => ({ command_id: spec.command_id, executable: path.resolve(spec.executable), args: [...spec.args], timeout_ms: spec.timeout_ms })).sort((a, b) => COMMAND_ORDER.indexOf(a.command_id) - COMMAND_ORDER.indexOf(b.command_id));
  canonical.forEach(assertCommandSpec);
  return stableHash(canonical);
}

export const DEFAULT_QUALITY_GATE_POLICY = createQualityGatePolicy({
  version: 1,
  policy_id: "local-quality-default-deny",
  command_ids: [],
  command_registry_hash: stableHash([]),
  max_diff_bytes: 2 * 1024 * 1024,
  max_file_bytes: 512 * 1024,
  max_output_bytes: 64 * 1024,
});

export function assertQualityGatePolicy(value: unknown): asserts value is QualityGatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QualityGatePolicy must be an object");
  const policy = value as Record<string, unknown>;
  const keys = ["version", "policy_id", "command_ids", "command_registry_hash", "max_diff_bytes", "max_file_bytes", "max_output_bytes", "policy_hash"];
  if (Object.keys(policy).length !== keys.length || keys.some(key => !(key in policy))) throw new Error("QualityGatePolicy has unknown or missing fields");
  if (policy.version !== 1 || typeof policy.policy_id !== "string" || !ID.test(policy.policy_id)) throw new Error("QualityGatePolicy identity is invalid");
  if (!Array.isArray(policy.command_ids) || policy.command_ids.some(item => !COMMAND_ORDER.includes(item as QualityCommandId)) || new Set(policy.command_ids).size !== policy.command_ids.length) throw new Error("QualityGatePolicy command IDs are invalid");
  if (typeof policy.command_registry_hash !== "string" || !HASH.test(policy.command_registry_hash)) throw new Error("QualityGatePolicy command registry hash is invalid");
  const commandIds = policy.command_ids as QualityCommandId[];
  const sorted = [...commandIds].sort((a, b) => COMMAND_ORDER.indexOf(a) - COMMAND_ORDER.indexOf(b));
  if (sorted.some((item, index) => item !== commandIds[index])) throw new Error("QualityGatePolicy command IDs must use deterministic gate order");
  const limitCeilings = { max_diff_bytes: 16 * 1024 * 1024, max_file_bytes: 4 * 1024 * 1024, max_output_bytes: 1024 * 1024 };
  for (const key of ["max_diff_bytes", "max_file_bytes", "max_output_bytes"] as const) if (!Number.isInteger(policy[key]) || (policy[key] as number) < 1 || (policy[key] as number) > limitCeilings[key]) throw new Error(`QualityGatePolicy ${key} is invalid`);
  if (typeof policy.policy_hash !== "string" || !HASH.test(policy.policy_hash)) throw new Error("QualityGatePolicy hash is invalid");
  const { policy_hash: _hash, ...body } = policy;
  if (stableHash(body) !== policy.policy_hash) throw new Error("QualityGatePolicy hash does not match canonical content");
}

export class LocalQualityGate {
  readonly policy: QualityGatePolicy;
  private readonly catalog = new Map<QualityCommandId, QualityCommandSpec>();
  private readonly evidenceRoot: string;
  private readonly runCommand: QualityCommandRunner;
  private readonly runGit: QualityGitRunner;
  private readonly now: () => number;
  private readonly checkpoint?: QualityGateOptions["checkpoint"];

  constructor(options: QualityGateOptions) {
    assertQualityGatePolicy(options.policy);
    this.policy = options.policy;
    this.evidenceRoot = path.resolve(options.evidenceRoot);
    this.runCommand = options.runCommand ?? runApprovedCommand;
    this.runGit = options.runGit ?? runGitCommand;
    this.now = options.now ?? Date.now;
    this.checkpoint = options.checkpoint;
    for (const spec of options.commandCatalog ?? []) {
      assertCommandSpec(spec);
      if (this.catalog.has(spec.command_id)) throw new Error("Quality command catalog contains duplicate IDs");
      this.catalog.set(spec.command_id, Object.freeze({ ...spec, args: Object.freeze([...spec.args]) as unknown as string[] }));
    }
    for (const id of this.policy.command_ids) if (!this.catalog.has(id)) throw new Error(`Approved quality command ${id} has no trusted executable mapping`);
    if (hashQualityCommandCatalog([...this.catalog.values()]) !== this.policy.command_registry_hash) throw new Error("Trusted quality command registry does not match the approved policy hash");
  }

  async preflight(request: QualityGateRequest, workingDirectory: string): Promise<void> {
    assertQualityGateRequest(request);
    if (request.policy_hash !== this.policy.policy_hash) throw new Error("Quality gate request is bound to a different policy");
    if (request.command_ids.length !== this.policy.command_ids.length || request.command_ids.some((id, index) => id !== this.policy.command_ids[index])) throw new Error("Quality gate request must use every approved command in deterministic order");
    const suppliedRoot = await lstat(path.resolve(workingDirectory));
    if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink()) throw new Error("Quality gate worktree root must be a physical directory");
    await assertNoNearestLink(this.evidenceRoot);
    await assertExternalEvidenceRoot(this.evidenceRoot, workingDirectory);
    const workspace = await realpath(workingDirectory);
    for (const spec of this.catalog.values()) if (isWithin(workspace, path.resolve(spec.executable))) throw new Error("Trusted quality executables must be outside the target worktree");
  }

  async run(request: QualityGateRequest, workingDirectory: string): Promise<QualityGateReport> {
    const started = this.now();
    await this.preflight(request, workingDirectory);
    const root = await realpath(workingDirectory);
    const initial = await this.capture(root, request.base_commit, request.write_scope);
    const gates: EvidenceBundle["quality_gate_results"] = [];
    const tests: EvidenceBundle["tests_run"] = [];
    const scopeViolations: string[] = [];
    const privacyViolations: string[] = [];
    const redactionNotes = ["command_output_redacted_and_hashed", "full_diff_retained_only_in_local_evidence_root"];

    gate(gates, "base_identity", initial.head === request.base_commit ? "passed" : "failed", { expected: request.base_commit, actual: initial.head });
    const outside = initial.entries.flatMap(entry => [entry.path, entry.originalPath].filter((item): item is string => item !== null)).filter(item => !isAllowedPath(item, request.write_scope));
    scopeViolations.push(...[...new Set(outside)].sort().map(item => `outside_write_scope:${item}`));
    gate(gates, "preapply_scope", scopeViolations.length === 0 ? "passed" : "failed", { plan_hash: request.plan_hash, violations: scopeViolations });
    gate(gates, "changed_files_scope", scopeViolations.length === 0 ? "passed" : "failed", { files: initial.files, violations: scopeViolations });

    const forbidden = initial.files.filter(item => FORBIDDEN_PATH.test(item));
    const reparse = initial.unsafePaths.filter(item => !forbidden.includes(item));
    privacyViolations.push(...forbidden.map(item => `forbidden_path:${item}`), ...reparse.map(item => `reparse_path:${item}`));
    gate(gates, "forbidden_paths", privacyViolations.length === 0 ? "passed" : "failed", { violations: privacyViolations });

    let secret = { baselineFindings: 0, newFindings: 0, outcome: "not_run" as "passed" | "failed" | "not_run" };
    let sanity: string[] = [];
    if (gates.some(item => item.outcome === "failed")) {
      gate(gates, "secret_scan", "not_run", { reason: "scope_or_physical_path_gate_failed" });
      gate(gates, "diff_sanity", "not_run", { reason: "scope_or_physical_path_gate_failed" });
    } else {
      const scanned = await scanSecrets(root, initial.entries, this.policy.max_file_bytes, this.runGit);
      secret = { ...scanned, outcome: scanned.newFindings === 0 ? "passed" : "failed" };
      if (secret.baselineFindings > 0) redactionNotes.push(`baseline_secret_findings_present:${secret.baselineFindings}`);
      if (secret.newFindings > 0) privacyViolations.push(`new_high_confidence_secret_findings:${secret.newFindings}`);
      gate(gates, "secret_scan", secret.outcome, { baseline: secret.baselineFindings, added: secret.newFindings });
      sanity = await diffSanity(root, initial, this.policy.max_diff_bytes, this.policy.max_file_bytes);
      gate(gates, "diff_sanity", sanity.length === 0 ? "passed" : "failed", { violations: sanity });
    }

    let stopped = gates.some(item => item.outcome === "failed");
    for (const id of COMMAND_ORDER) {
      if (!request.command_ids.includes(id)) {
        gate(gates, id, "not_applicable", { reason: "not_required_by_approved_plan" });
        continue;
      }
      if (stopped) {
        gate(gates, id, "not_run", { reason: "prior_gate_failed" });
        continue;
      }
      const spec = this.catalog.get(id);
      if (!spec) {
        gate(gates, id, "failed", { reason: "trusted_command_mapping_unavailable" });
        stopped = true;
        continue;
      }
      const execution = await safeRun(this.runCommand, spec, root, this.policy.max_output_bytes);
      const bounded = redactAndBound(`${execution.stdout}${execution.stderr}`, this.policy.max_output_bytes);
      tests.push({ command_id: id, exit_code: execution.exitCode, output_hash: sha256(bounded) });
      const afterCommand = await this.capture(root, request.base_commit, request.write_scope);
      const mutated = afterCommand.snapshotHash !== initial.snapshotHash;
      const passed = execution.exitCode === 0 && !execution.timedOut && !execution.overflowed && !mutated;
      gate(gates, id, passed ? "passed" : "failed", { exit_code: execution.exitCode, timed_out: execution.timedOut, output_overflowed: execution.overflowed, output_hash: sha256(bounded), diff_mutated: mutated });
      if (!passed) stopped = true;
    }

    const final = await this.capture(root, request.base_commit, request.write_scope);
    const frozen = final.snapshotHash === initial.snapshotHash && final.head === initial.head;
    gate(gates, "final_freeze", frozen ? "passed" : "failed", { initial: initial.snapshotHash, final: final.snapshotHash, head: final.head });
    const unsafeArtifact = privacyViolations.length > 0 || sanity.length > 0 || scopeViolations.length > 0 || secret.baselineFindings > 0 || secret.newFindings > 0;
    const artifactBytes = unsafeArtifact ? Buffer.from(`${JSON.stringify({ blocked: true, content_snapshot_hash: final.snapshotHash })}\n`, "utf8") : final.reviewBytes;
    const artifactHash = sha256(artifactBytes);
    await this.checkpoint?.("before_artifact");
    const diffReference = await this.persistDiff(request, artifactBytes, artifactHash);
    await this.checkpoint?.("after_artifact");
    const postArtifact = await this.capture(root, request.base_commit, request.write_scope);
    const artifactFrozen = postArtifact.snapshotHash === final.snapshotHash;
    gate(gates, "evidence_artifact", artifactFrozen ? "passed" : "failed", { reference: diffReference, diff_hash: artifactHash, content_snapshot_hash: final.snapshotHash, post_write_frozen: artifactFrozen });
    const passed = gates.every(item => item.outcome === "passed" || item.outcome === "not_applicable");
    const report: QualityGateReport = {
      version: 1,
      passed,
      worktree_head: final.head,
      files_changed: final.files,
      content_snapshot_hash: final.snapshotHash,
      diff_hash: artifactHash,
      diff_reference: diffReference,
      quality_gate_results: gates,
      tests_run: tests,
      scope_violations: scopeViolations,
      privacy_violations: privacyViolations,
      secret_scan_summary: { outcome: secret.outcome, findings: secret.newFindings, baseline_findings: secret.baselineFindings, new_findings: secret.newFindings },
      wall_clock_time_ms: Math.max(0, this.now() - started),
      redaction_notes: redactionNotes,
    };
    assertQualityGateReport(report);
    return report;
  }

  private async capture(root: string, expectedBase: string, writeScope: string[]): Promise<DiffSnapshot> {
    const headResult = await this.runGit(root, ["rev-parse", "HEAD"]);
    if (headResult.exitCode !== 0) throw new Error("Quality gate could not verify worktree HEAD");
    const head = headResult.stdout.trim();
    if (!GIT_OBJECT.test(head) || head !== expectedBase) throw new Error("Quality gate worktree HEAD does not match the approved base");
    const entries = await collectChanges(root, this.runGit);
    const files = [...new Set(entries.flatMap(entry => [entry.originalPath, entry.path]).filter((item): item is string => item !== null))].sort();
    const forbidden = files.filter(item => FORBIDDEN_PATH.test(item));
    const outside = files.filter(item => !isAllowedPath(item, writeScope));
    const reparse = await findReparsePaths(root, files);
    const unsafePaths = [...new Set([...forbidden, ...outside, ...reparse])].sort();
    if (unsafePaths.length > 0) {
      const snapshotHash = stableHash({ head, entries, unsafe_paths: unsafePaths });
      const reviewBytes = Buffer.from(`${JSON.stringify({ blocked: true, content_snapshot_hash: snapshotHash })}\n`, "utf8");
      return { head, entries, files, unsafePaths, reviewBytes, reviewHash: sha256(reviewBytes), snapshotHash };
    }
    const tracked = await this.runGit(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
    if (tracked.exitCode !== 0) throw new Error("Quality gate could not capture the tracked diff");
    const parts = [Buffer.from(tracked.stdout, "utf8")];
    for (const entry of entries.filter(item => item.status === "untracked")) {
      const addition = await this.runGit(root, ["diff", "--no-index", "--binary", "--", "/dev/null", entry.path]);
      if (![0, 1].includes(addition.exitCode)) throw new Error("Quality gate could not capture an untracked file diff");
      parts.push(Buffer.from(addition.stdout, "utf8"));
    }
    const bytes = Buffer.concat(parts);
    const content = [] as Array<{ path: string; original_path: string | null; status: string; content_hash: string | null }>;
    for (const entry of entries) content.push({ path: entry.path, original_path: entry.originalPath, status: entry.status, content_hash: entry.status === "deleted" ? null : sha256(await readFile(path.join(root, entry.path))) });
    const reviewBytes = Buffer.from(redactText(bytes.toString("utf8"), Math.max(bytes.length * 2, 2_000)), "utf8");
    const index = await this.runGit(root, ["write-tree"]); const raw = await this.runGit(root, ["diff", "--raw", "--no-abbrev", "-z", "HEAD", "--"]);
    if (index.exitCode !== 0 || raw.exitCode !== 0) throw new Error("Quality gate could not freeze index metadata");
    return { head, entries, files, unsafePaths, reviewBytes, reviewHash: sha256(reviewBytes), snapshotHash: stableHash({ head, index_tree: index.stdout.trim(), raw_hash: sha256(raw.stdout), content }) };
  }

  private async persistDiff(request: QualityGateRequest, bytes: Buffer, hash: string): Promise<string> {
    const relative = `evidence/${request.run_id}/${hash}.diff`;
    const directory = await ensureOwnedRunDirectory(this.evidenceRoot, request);
    const target = path.join(directory, `${hash}.diff`);
    await writeOnce(target, bytes, hash);
    return relative;
  }
}

export async function persistEvidenceBundle(evidenceRoot: string, bundle: EvidenceBundle): Promise<string> {
  assertEvidenceBundle(bundle);
  const root = path.resolve(evidenceRoot);
  const request: QualityGateRequest = { run_id: bundle.run_id, task_id: bundle.task_id, base_commit: bundle.base_commit, plan_hash: bundle.task_package_hash, approval_hash: bundle.approval_hash, isolation_hash: bundle.isolation_hash, worktree_id: bundle.worktree_id, write_scope: ["evidence-only"], command_ids: [], policy_hash: bundle.quality_policy_hash, effective_policy_hash: bundle.policy_hash };
  const directory = await ensureOwnedRunDirectory(root, request, true);
  const relative = `evidence/${bundle.run_id}/${bundle.bundle_hash}.json`;
  await writeOnce(path.join(directory, `${bundle.bundle_hash}.json`), Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8"), sha256(Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8")));
  return relative;
}

export async function readEvidenceArtifact(evidenceRoot: string, reference: string, expectedHash?: string): Promise<Buffer> {
  assertSafeRelativePath(reference, "evidence reference");
  if (!reference.startsWith("evidence/")) throw new Error("Evidence reference is outside the managed namespace");
  const root = await realpath(path.resolve(evidenceRoot));
  const target = path.resolve(root, reference);
  if (!isWithin(root, target)) throw new Error("Evidence reference escaped the managed root");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Evidence reference is not a regular owned file");
  const physical = await realpath(target);
  if (!isWithin(root, physical)) throw new Error("Evidence reference physical path escaped the managed root");
  const bytes = await readFile(physical);
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error("Evidence artifact hash mismatch");
  return bytes;
}

export function assertQualityGateReport(value: unknown): asserts value is QualityGateReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QualityGateReport must be an object");
  const report = value as Record<string, unknown>;
  const keys = ["version", "passed", "worktree_head", "files_changed", "content_snapshot_hash", "diff_hash", "diff_reference", "quality_gate_results", "tests_run", "scope_violations", "privacy_violations", "secret_scan_summary", "wall_clock_time_ms", "redaction_notes"];
  if (Object.keys(report).length !== keys.length || keys.some(key => !(key in report))) throw new Error("QualityGateReport has unknown or missing fields");
  if (report.version !== 1 || typeof report.passed !== "boolean" || typeof report.worktree_head !== "string" || !GIT_OBJECT.test(report.worktree_head) || typeof report.content_snapshot_hash !== "string" || !HASH.test(report.content_snapshot_hash) || typeof report.diff_hash !== "string" || !HASH.test(report.diff_hash)) throw new Error("QualityGateReport identity is invalid");
  assertSafeRelativePath(report.diff_reference, "QualityGateReport.diff_reference");
  assertStringArray(report.files_changed, true); (report.files_changed as string[]).forEach(item => assertSafeRelativePath(item, "QualityGateReport.files_changed"));
  assertStringArray(report.scope_violations, false); assertStringArray(report.privacy_violations, false); assertStringArray(report.redaction_notes, false);
  if (!Array.isArray(report.quality_gate_results) || report.quality_gate_results.some(item => !validGate(item))) throw new Error("QualityGateReport gate results are invalid");
  if (!Array.isArray(report.tests_run) || report.tests_run.some(item => !validTest(item))) throw new Error("QualityGateReport test results are invalid");
  const secret = report.secret_scan_summary as Record<string, unknown>;
  if (!secret || Object.keys(secret).length !== 4 || !["passed", "failed", "not_run"].includes(String(secret.outcome)) || !Number.isInteger(secret.findings) || (secret.findings as number) < 0 || !Number.isInteger(secret.baseline_findings) || (secret.baseline_findings as number) < 0 || !Number.isInteger(secret.new_findings) || (secret.new_findings as number) < 0) throw new Error("QualityGateReport secret summary is invalid");
  if (!Number.isInteger(report.wall_clock_time_ms) || (report.wall_clock_time_ms as number) < 0) throw new Error("QualityGateReport wall time is invalid");
}

function assertQualityGateRequest(request: QualityGateRequest): void {
  if (!request || !ID.test(request.run_id) || !ID.test(request.task_id) || !GIT_OBJECT.test(request.base_commit) || !HASH.test(request.plan_hash) || !HASH.test(request.approval_hash) || !HASH.test(request.isolation_hash) || !ID.test(request.worktree_id) || !HASH.test(request.policy_hash) || !HASH.test(request.effective_policy_hash)) throw new Error("Quality gate request identity is invalid");
  assertPathScope(request.write_scope, "QualityGateRequest.write_scope");
  if (!Array.isArray(request.command_ids) || request.command_ids.some(id => !COMMAND_ORDER.includes(id)) || new Set(request.command_ids).size !== request.command_ids.length) throw new Error("Quality gate command IDs are invalid");
}

function assertCommandSpec(spec: QualityCommandSpec): void {
  if (!COMMAND_ORDER.includes(spec.command_id) || !path.isAbsolute(spec.executable) || /[\0\r\n]/.test(spec.executable) || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== "string" || /[\0\r\n]/.test(arg)) || !Number.isInteger(spec.timeout_ms) || spec.timeout_ms < 1) throw new Error("Trusted quality command mapping is invalid");
  if (spec.command_id === "format_check" && (spec.args.some(arg => /^(?:--write|--fix)$/i.test(arg)) || !spec.args.some(arg => /^(?:--check|--check-only)$/i.test(arg)))) throw new Error("Formatter command must be check-only");
}

async function collectChanges(root: string, runGit: QualityGitRunner): Promise<ChangeEntry[]> {
  const tracked = await runGit(root, ["diff", "--name-status", "-z", "--find-renames", "HEAD", "--"]);
  const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0 || ignored.exitCode !== 0) throw new Error("Quality gate could not enumerate changed files");
  const tokens = tracked.stdout.split("\0").filter(Boolean); const entries: ChangeEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++];
    if (code.startsWith("R") || code.startsWith("C")) {
      const originalPath = safeGitPath(tokens[index++]); const target = safeGitPath(tokens[index++]);
      entries.push({ status: "renamed", path: target, originalPath });
    } else {
      const target = safeGitPath(tokens[index++]);
      entries.push({ status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified", path: target, originalPath: null });
    }
  }
  for (const item of untracked.stdout.split("\0").filter(Boolean)) entries.push({ status: "untracked", path: safeGitPath(item), originalPath: null });
  for (const item of ignored.stdout.split("\0").filter(Boolean)) entries.push({ status: "untracked", path: safeGitPath(item), originalPath: null });
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function scanSecrets(root: string, entries: ChangeEntry[], maxBytes: number, runGit: QualityGitRunner): Promise<{ baselineFindings: number; newFindings: number }> {
  let baselineFindings = 0; let newFindings = 0;
  for (const entry of entries) {
    const baseline = entry.status === "untracked" ? "" : await gitFileText(root, `HEAD:${entry.originalPath ?? entry.path}`, maxBytes, runGit);
    const current = entry.status === "deleted" ? "" : await fileText(path.join(root, entry.path), maxBytes);
    const before = secretFingerprints(baseline); const after = secretFingerprints(current);
    baselineFindings += before.size;
    for (const finding of after) if (!before.has(finding)) newFindings++;
  }
  return { baselineFindings, newFindings };
}

async function diffSanity(root: string, snapshot: DiffSnapshot, maxDiffBytes: number, maxFileBytes: number): Promise<string[]> {
  const violations: string[] = [];
  if (snapshot.reviewBytes.length > maxDiffBytes) violations.push("diff_size_limit_exceeded");
  if (/^(?:old mode|new mode|Subproject commit)/m.test(snapshot.reviewBytes.toString("utf8"))) violations.push("file_mode_or_gitlink_change");
  for (const entry of snapshot.entries) {
    if (entry.status === "renamed" || entry.status === "deleted") violations.push(`${entry.status}_not_approved:${entry.path}`);
    if (entry.status !== "deleted") {
      const file = path.join(root, entry.path); const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) { violations.push(`non_regular_file:${entry.path}`); continue; }
      if (info.size > maxFileBytes) violations.push(`file_size_limit_exceeded:${entry.path}`);
      const bytes = await readFile(file); if (bytes.includes(0)) violations.push(`binary_file:${entry.path}`);
      else { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { violations.push(`invalid_utf8:${entry.path}`); } }
    }
  }
  return violations;
}

async function findReparsePaths(root: string, files: string[]): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    let current = root;
    for (const segment of file.split("/")) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => undefined);
      if (info?.isSymbolicLink()) { violations.push(file); break; }
    }
  }
  return [...new Set(violations)].sort();
}

async function assertExternalEvidenceRoot(evidenceRoot: string, workspace: string): Promise<void> {
  const workspacePhysical = await realpath(workspace);
  const rootPhysical = await prospectivePhysical(evidenceRoot);
  if (isWithin(workspacePhysical, rootPhysical) || isWithin(rootPhysical, workspacePhysical)) throw new Error("Evidence root must be outside the isolated worktree");
}

async function ensureOwnedRunDirectory(root: string, request: QualityGateRequest, _bundleOnly = false): Promise<string> {
  await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  const evidence = path.join(physicalRoot, "evidence"); const run = path.join(evidence, request.run_id);
  await mkdir(evidence).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await rejectLink(evidence);
  let created = false;
  try { await mkdir(run); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await rejectLink(run);
  const ownerPath = path.join(run, "owner.json");
  const owner = { version: 1, run_id: request.run_id, task_id: request.task_id, base_commit: request.base_commit, plan_hash: request.plan_hash, approval_hash: request.approval_hash, isolation_hash: request.isolation_hash, worktree_id: request.worktree_id, effective_policy_hash: request.effective_policy_hash, quality_policy_hash: request.policy_hash };
  if (created) {
    const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"); await writeOnce(ownerPath, ownerBytes, sha256(ownerBytes));
  } else {
    const actual: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (stableHash(actual) !== stableHash(owner)) throw new Error("Evidence run directory ownership mismatch");
  }
  return run;
}

async function writeOnce(target: string, bytes: Buffer, expectedContentHash: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx"); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (sha256(existing) !== expectedContentHash) throw new Error("Existing evidence artifact did not match the frozen content");
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

async function prospectivePhysical(target: string): Promise<string> {
  const suffix: string[] = []; let current = path.resolve(target);
  while (true) {
    try { const existing = await realpath(current); return path.join(existing, ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

async function assertNoNearestLink(target: string): Promise<void> { let current = path.resolve(target); while (true) { try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error("Evidence root cannot use a symlink or junction alias"); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = path.dirname(current); if (parent === current) throw error; current = parent; } } }

async function rejectLink(target: string): Promise<void> { const info = await lstat(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Evidence path is not an owned physical directory"); }
function isWithin(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function safeGitPath(value: string): string { assertSafeRelativePath(value, "Git changed path"); return value; }
function gate(results: EvidenceBundle["quality_gate_results"], gateId: string, outcome: GateOutcome, evidence: unknown): void { const summary = redactText(JSON.stringify(evidence), 1_000); results.push({ gate_id: gateId, outcome, evidence_hash: stableHash(evidence), summary }); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function secretFingerprints(text: string): Set<string> { const result = new Set<string>(); for (const [rule, regex] of SECRET_RULES) { regex.lastIndex = 0; for (const match of text.matchAll(regex)) result.add(stableHash({ rule, value: match[0] })); } return result; }
async function fileText(file: string, maxBytes: number): Promise<string> { const bytes = await readFile(file); if (bytes.length > maxBytes || bytes.includes(0)) return ""; try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return ""; } }
async function gitFileText(root: string, object: string, maxBytes: number, runGit: QualityGitRunner): Promise<string> { const result = await runGit(root, ["show", object]); if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > maxBytes || result.stdout.includes("\0")) return ""; return result.stdout; }
function redactAndBound(value: string, maxBytes: number): string { const redacted = redactText(value, maxBytes); return Buffer.byteLength(redacted) <= maxBytes ? redacted : Buffer.from(redacted).subarray(0, maxBytes).toString("utf8"); }
function assertStringArray(value: unknown, paths: boolean): asserts value is string[] { if (!Array.isArray(value) || value.some(item => typeof item !== "string" || (paths && item.length === 0))) throw new Error("QualityGateReport string array is invalid"); }
function validGate(value: unknown): boolean { const item = value as Record<string, unknown>; return Boolean(item && ID.test(String(item.gate_id)) && ["passed", "failed", "not_applicable", "not_run"].includes(String(item.outcome)) && HASH.test(String(item.evidence_hash)) && typeof item.summary === "string" && Object.keys(item).length === 4); }
function validTest(value: unknown): boolean { const item = value as Record<string, unknown>; return Boolean(item && ID.test(String(item.command_id)) && Number.isInteger(item.exit_code) && HASH.test(String(item.output_hash)) && Object.keys(item).length === 3); }

async function safeRun(runner: QualityCommandRunner, spec: QualityCommandSpec, cwd: string, maxOutputBytes: number): Promise<QualityCommandExecution> {
  try { return await runner(spec, cwd, maxOutputBytes); }
  catch (error) { return { exitCode: 127, stdout: "", stderr: redactText(error instanceof Error ? error.message : String(error)), timedOut: false, overflowed: false }; }
}

async function runApprovedCommand(spec: QualityCommandSpec, cwd: string, maxOutputBytes: number): Promise<QualityCommandExecution> {
  return runProcess(spec.executable, spec.args, cwd, spec.timeout_ms, maxOutputBytes, {});
}

async function runGitCommand(cwd: string, args: readonly string[]): Promise<QualityCommandExecution> {
  return runProcess("git", args, cwd, 60_000, 16 * 1024 * 1024, {});
}

async function runProcess(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maxOutputBytes: number, environment: NodeJS.ProcessEnv): Promise<QualityCommandExecution> {
  const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let timedOut = false; let overflowed = false; let outputBytes = 0;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const append = (stream: "stdout" | "stderr", chunk: unknown) => { const text = String(chunk); outputBytes += Buffer.byteLength(text); if (outputBytes > maxOutputBytes) { overflowed = true; child.kill(); return; } if (stream === "stdout") stdout += text; else stderr += text; };
  child.stdout.on("data", chunk => append("stdout", chunk)); child.stderr.on("data", chunk => append("stderr", chunk));
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const [code] = await once(child, "close") as [number | null]; clearTimeout(timer);
  return { exitCode: overflowed ? 125 : timedOut ? 124 : (code ?? 1), stdout: redactAndBound(stdout, maxOutputBytes), stderr: redactAndBound(stderr, maxOutputBytes), timedOut, overflowed };
}
