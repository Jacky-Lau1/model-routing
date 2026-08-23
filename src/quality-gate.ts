import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./canonical.js";
import { assertEvidenceBundle, assertPathScope, assertSafeRelativePath } from "./contracts.js";
import { redactText } from "./redaction.js";
import { hashContainedFile, hashScopeSnapshot, isAllowedPath, isForbiddenQualityPath, nonstandardGitIndexPaths, snapshotWorkingTree } from "./scope-guard.js";
import type { EvidenceBundle, QualityCommandId, QualityCommandSpec, QualityGatePolicy, QualityGateReport, QualityGateRequest } from "./types.js";

const COMMAND_ORDER: QualityCommandId[] = ["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
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
export type QualityGitRunner = (cwd: string, args: readonly string[], timeoutMs?: number) => Promise<QualityCommandExecution>;

export interface QualityGateOptions {
  policy: QualityGatePolicy;
  commandCatalog?: readonly QualityCommandSpec[];
  evidenceRoot: string;
  runCommand?: QualityCommandRunner;
  runGit?: QualityGitRunner;
  now?: () => number;
  checkpoint?: (phase: "before_artifact" | "after_artifact") => void | Promise<void>;
}

interface ChangeEntry { status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored"; path: string; originalPath: string | null }
interface DiffSnapshot { head: string; entries: ChangeEntry[]; files: string[]; unsafePaths: string[]; reviewBytes: Buffer; rawDiffBytes: number; snapshotHash: string }
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
  max_wall_time_ms: 5 * 60_000,
});

export function assertQualityGatePolicy(value: unknown): asserts value is QualityGatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QualityGatePolicy must be an object");
  const policy = value as Record<string, unknown>;
  const keys = ["version", "policy_id", "command_ids", "command_registry_hash", "max_diff_bytes", "max_file_bytes", "max_output_bytes", "max_wall_time_ms", "policy_hash"];
  if (Object.keys(policy).length !== keys.length || keys.some(key => !(key in policy))) throw new Error("QualityGatePolicy has unknown or missing fields");
  if (policy.version !== 1 || typeof policy.policy_id !== "string" || !ID.test(policy.policy_id)) throw new Error("QualityGatePolicy identity is invalid");
  if (!Array.isArray(policy.command_ids) || policy.command_ids.some(item => !COMMAND_ORDER.includes(item as QualityCommandId)) || new Set(policy.command_ids).size !== policy.command_ids.length) throw new Error("QualityGatePolicy command IDs are invalid");
  if (typeof policy.command_registry_hash !== "string" || !HASH.test(policy.command_registry_hash)) throw new Error("QualityGatePolicy command registry hash is invalid");
  const commandIds = policy.command_ids as QualityCommandId[];
  const sorted = [...commandIds].sort((a, b) => COMMAND_ORDER.indexOf(a) - COMMAND_ORDER.indexOf(b));
  if (sorted.some((item, index) => item !== commandIds[index])) throw new Error("QualityGatePolicy command IDs must use deterministic gate order");
  const limitCeilings = { max_diff_bytes: 16 * 1024 * 1024, max_file_bytes: 4 * 1024 * 1024, max_output_bytes: 1024 * 1024, max_wall_time_ms: 30 * 60_000 };
  for (const key of ["max_diff_bytes", "max_file_bytes", "max_output_bytes", "max_wall_time_ms"] as const) if (!Number.isInteger(policy[key]) || (policy[key] as number) < 1 || (policy[key] as number) > limitCeilings[key]) throw new Error(`QualityGatePolicy ${key} is invalid`);
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
    if (request.policy_hash !== this.policy.policy_hash || request.max_wall_time_ms !== this.policy.max_wall_time_ms) throw new Error("Quality gate request is bound to a different policy");
    if (request.command_ids.length !== this.policy.command_ids.length || request.command_ids.some((id, index) => id !== this.policy.command_ids[index])) throw new Error("Quality gate request must use every approved command in deterministic order");
    const suppliedRoot = await lstat(path.resolve(workingDirectory));
    if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink()) throw new Error("Quality gate worktree root must be a physical directory");
    await assertNoNearestLink(this.evidenceRoot);
    await assertExternalEvidenceRoot(this.evidenceRoot, workingDirectory);
    const workspace = await realpath(workingDirectory);
    for (const spec of this.catalog.values()) if (isWithin(workspace, path.resolve(spec.executable))) throw new Error("Trusted quality executables must be outside the target worktree");
  }

  async run(request: QualityGateRequest, workingDirectory: string): Promise<QualityGateReport> {
    const started = this.now(); const realStarted = Date.now(); const hardDeadline = realStarted + this.policy.max_wall_time_ms;
    await withinDeadline(this.preflight(request, workingDirectory), hardDeadline, "preflight");
    const root = await withinDeadline(realpath(workingDirectory), hardDeadline, "worktree root resolution");
    const initial = await withinDeadline(this.capture(root, request.base_commit, request.write_scope, hardDeadline), hardDeadline, "initial capture");
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

    const forbidden = initial.files.filter(isForbiddenQualityPath);
    const reparse = initial.unsafePaths.filter(item => !forbidden.includes(item));
    const ignored = initial.entries.filter(item => item.status === "ignored").map(item => item.path);
    privacyViolations.push(...forbidden.map(item => `forbidden_path:${item}`), ...reparse.filter(item => !ignored.includes(item)).map(item => `reparse_path:${item}`), ...ignored.map(item => `unfreezable_ignored_path:${item}`));
    gate(gates, "forbidden_paths", privacyViolations.length === 0 ? "passed" : "failed", { violations: privacyViolations });

    let secret = { baselineFindings: 0, newFindings: 0, outcome: "not_run" as "passed" | "failed" | "not_run" };
    let sanity: string[] = [];
    if (gates.some(item => item.outcome === "failed")) {
      gate(gates, "secret_scan", "not_run", { reason: "scope_or_physical_path_gate_failed" });
      gate(gates, "diff_sanity", "not_run", { reason: "scope_or_physical_path_gate_failed" });
    } else {
      const scanned = await withinDeadline(scanSecrets(root, initial.entries, this.policy.max_file_bytes, (cwd, args) => this.runGitWithinDeadline(cwd, args, hardDeadline)), hardDeadline, "secret scan");
      secret = { ...scanned, outcome: scanned.newFindings === 0 ? "passed" : "failed" };
      if (secret.baselineFindings > 0) redactionNotes.push(`baseline_secret_findings_present:${secret.baselineFindings}`);
      if (secret.newFindings > 0) privacyViolations.push(`new_high_confidence_secret_findings:${secret.newFindings}`);
      gate(gates, "secret_scan", secret.outcome, { baseline: secret.baselineFindings, added: secret.newFindings });
      sanity = await withinDeadline(diffSanity(root, initial, this.policy.max_diff_bytes, this.policy.max_file_bytes), hardDeadline, "diff sanity");
      gate(gates, "diff_sanity", sanity.length === 0 ? "passed" : "failed", { violations: sanity });
    }

    let stopped = gates.some(item => item.outcome === "failed");
    let budgetExceeded = false;
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
      const remaining = Math.min(this.policy.max_wall_time_ms - Math.max(0, this.now() - started), hardDeadline - Date.now());
      if (remaining <= 1_500) {
        gate(gates, id, "not_run", { reason: "quality_gate_wall_time_budget_exceeded" });
        budgetExceeded = true; stopped = true;
        continue;
      }
      const effectiveSpec = { ...spec, timeout_ms: Math.min(spec.timeout_ms, remaining - 1_500) };
      const execution = await withinDeadline(safeRun(this.runCommand, effectiveSpec, root, this.policy.max_output_bytes), hardDeadline, `command ${id}`);
      const bounded = redactAndBound(`${execution.stdout}${execution.stderr}`, this.policy.max_output_bytes);
      const outputSummary = redactText(bounded || "No command output was produced.", 1_000);
      const afterCommand = await withinDeadline(this.capture(root, request.base_commit, request.write_scope, hardDeadline), hardDeadline, `post-command capture ${id}`);
      const mutated = afterCommand.snapshotHash !== initial.snapshotHash;
      tests.push({ command_id: id, exit_code: execution.exitCode, output_hash: sha256(bounded), output_summary: outputSummary, timed_out: execution.timedOut, output_overflowed: execution.overflowed, worktree_mutated: mutated });
      const passed = execution.exitCode === 0 && !execution.timedOut && !execution.overflowed && !mutated;
      gate(gates, id, passed ? "passed" : "failed", { exit_code: execution.exitCode, timed_out: execution.timedOut, output_overflowed: execution.overflowed, output_hash: sha256(bounded), diff_mutated: mutated });
      if (!passed) stopped = true;
    }

    const final = await withinDeadline(this.capture(root, request.base_commit, request.write_scope, hardDeadline), hardDeadline, "final capture");
    const finalOutside = final.files.filter(item => !isAllowedPath(item, request.write_scope));
    for (const item of finalOutside) if (!scopeViolations.includes(`outside_write_scope:${item}`)) scopeViolations.push(`outside_write_scope:${item}`);
    if (finalOutside.length) replaceGate(gates, "changed_files_scope", "failed", { files: final.files, violations: scopeViolations });
    const finalForbidden = final.files.filter(isForbiddenQualityPath);
    const finalIgnored = final.entries.filter(item => item.status === "ignored").map(item => item.path);
    const finalReparse = final.unsafePaths.filter(item => !finalForbidden.includes(item) && !finalIgnored.includes(item) && !finalOutside.includes(item));
    const finalPrivacy = [...finalForbidden.map(item => `forbidden_path:${item}`), ...finalReparse.map(item => `reparse_path:${item}`), ...finalIgnored.map(item => `unfreezable_ignored_path:${item}`)];
    for (const violation of finalPrivacy) if (!privacyViolations.includes(violation)) privacyViolations.push(violation);
    if (finalPrivacy.length) replaceGate(gates, "forbidden_paths", "failed", { violations: privacyViolations });
    const frozen = final.snapshotHash === initial.snapshotHash && final.head === initial.head;
    gate(gates, "final_freeze", frozen ? "passed" : "failed", { initial: initial.snapshotHash, final: final.snapshotHash, head: final.head });
    const unsafeArtifact = privacyViolations.length > 0 || sanity.length > 0 || scopeViolations.length > 0 || secret.newFindings > 0;
    const artifactBytes = unsafeArtifact ? Buffer.from(`${JSON.stringify({ blocked: true, content_snapshot_hash: final.snapshotHash })}\n`, "utf8") : final.reviewBytes;
    const artifactHash = sha256(artifactBytes);
    if (this.checkpoint) await withinDeadline(Promise.resolve(this.checkpoint("before_artifact")), hardDeadline, "before-artifact checkpoint");
    const diffReference = await withinDeadline(this.persistDiff(request, artifactBytes, artifactHash), hardDeadline, "artifact persistence");
    if (this.checkpoint) await withinDeadline(Promise.resolve(this.checkpoint("after_artifact")), hardDeadline, "after-artifact checkpoint");
    const postArtifact = await withinDeadline(this.capture(root, request.base_commit, request.write_scope, hardDeadline), hardDeadline, "post-artifact capture");
    const artifactFrozen = postArtifact.snapshotHash === final.snapshotHash;
    let artifactVerified = false;
    try { await withinDeadline(readEvidenceArtifact(this.evidenceRoot, diffReference, artifactHash), hardDeadline, "artifact verification"); artifactVerified = true; } catch { artifactVerified = false; }
    gate(gates, "evidence_artifact", artifactFrozen && artifactVerified ? "passed" : "failed", { reference: diffReference, diff_hash: artifactHash, content_snapshot_hash: final.snapshotHash, post_artifact_snapshot_hash: postArtifact.snapshotHash, post_write_frozen: artifactFrozen, artifact_hash_verified: artifactVerified });
    const preBudgetPassed = gates.every(item => item.outcome === "passed" || item.outcome === "not_applicable");
    const worktreeSnapshotHash = preBudgetPassed
      ? hashScopeSnapshot(await withinDeadline(snapshotWorkingTree(root), hardDeadline, "worktree snapshot"))
      : final.snapshotHash;
    const wallClockTimeMs = Math.max(0, this.now() - started, Date.now() - realStarted);
    if (wallClockTimeMs >= this.policy.max_wall_time_ms || Date.now() >= hardDeadline) budgetExceeded = true;
    gate(gates, "gate_budget", budgetExceeded ? "failed" : "passed", { elapsed_ms: wallClockTimeMs, max_wall_time_ms: this.policy.max_wall_time_ms });
    const passed = gates.every(item => item.outcome === "passed" || item.outcome === "not_applicable");
    const body: Omit<QualityGateReport, "report_hash"> = {
      version: 1,
      run_id: request.run_id, task_id: request.task_id, base_commit: request.base_commit, plan_hash: request.plan_hash, approval_hash: request.approval_hash,
      isolation_hash: request.isolation_hash, worktree_id: request.worktree_id, policy_hash: request.policy_hash, effective_policy_hash: request.effective_policy_hash, max_wall_time_ms: request.max_wall_time_ms,
      request_hash: hashQualityGateRequest(request),
      passed,
      worktree_head: final.head,
      files_changed: final.files,
      content_snapshot_hash: final.snapshotHash,
      post_artifact_snapshot_hash: postArtifact.snapshotHash,
      worktree_snapshot_hash: worktreeSnapshotHash,
      diff_hash: artifactHash,
      diff_reference: diffReference,
      quality_gate_results: gates,
      tests_run: tests,
      scope_violations: scopeViolations,
      privacy_violations: privacyViolations,
      secret_scan_summary: { outcome: secret.outcome, findings: secret.newFindings, baseline_findings: secret.baselineFindings, new_findings: secret.newFindings },
      wall_clock_time_ms: wallClockTimeMs,
      redaction_notes: redactionNotes,
    };
    const report: QualityGateReport = Object.freeze({ ...body, report_hash: stableHash(body) });
    assertQualityGateReportForRequest(report, request);
    return report;
  }

  private async capture(root: string, expectedBase: string, writeScope: string[], hardDeadline: number): Promise<DiffSnapshot> {
    const runGit = (args: readonly string[]) => this.runGitWithinDeadline(root, args, hardDeadline);
    const headResult = await runGit(["rev-parse", "HEAD"]);
    if (headResult.exitCode !== 0) throw new Error("Quality gate could not verify worktree HEAD");
    const head = headResult.stdout.trim();
    if (!GIT_OBJECT.test(head) || head !== expectedBase) throw new Error("Quality gate worktree HEAD does not match the approved base");
    const indexFlags = nonstandardGitIndexPaths((await runGit(["ls-files", "-v", "-z"])).stdout);
    if (indexFlags.length) throw new Error(`Quality gate refused nonstandard Git index flags: ${indexFlags.join(", ")}`);
    const entries = await collectChanges(root, (cwd, args) => this.runGitWithinDeadline(cwd, args, hardDeadline));
    const files = [...new Set(entries.flatMap(entry => [entry.originalPath, entry.path]).filter((item): item is string => item !== null))].sort();
    const forbidden = files.filter(isForbiddenQualityPath);
    const outside = files.filter(item => !isAllowedPath(item, writeScope));
    const reparse = await findReparsePaths(root, files);
    const ignored = entries.filter(item => item.status === "ignored").map(item => item.path);
    const unsafePaths = [...new Set([...forbidden, ...outside, ...reparse, ...ignored])].sort();
    if (unsafePaths.length > 0) {
      const snapshotHash = stableHash({ head, entries, unsafe_paths: unsafePaths });
      const reviewBytes = Buffer.from(`${JSON.stringify({ blocked: true, content_snapshot_hash: snapshotHash })}\n`, "utf8");
      return { head, entries, files, unsafePaths, reviewBytes, rawDiffBytes: 0, snapshotHash };
    }
    const tracked = await runGit(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    if (tracked.exitCode !== 0 && !tracked.overflowed) throw new Error("Quality gate could not capture the tracked diff");
    const parts: Buffer[] = []; let rawDiffBytes = Buffer.byteLength(tracked.stdout); let rawLimitExceeded = tracked.overflowed || rawDiffBytes > this.policy.max_diff_bytes;
    if (!rawLimitExceeded) parts.push(Buffer.from(tracked.stdout, "utf8")); else rawDiffBytes = this.policy.max_diff_bytes + 1;
    for (const entry of entries.filter(item => item.status === "untracked")) {
      if (rawLimitExceeded) break;
      const addition = await runGit(["diff", "--no-index", "--binary", "--no-textconv", "--", "/dev/null", entry.path]);
      if (![0, 1].includes(addition.exitCode) && !addition.overflowed) throw new Error("Quality gate could not capture an untracked file diff");
      const additionBytes = Buffer.byteLength(addition.stdout); rawDiffBytes += additionBytes; rawLimitExceeded = addition.overflowed || rawDiffBytes > this.policy.max_diff_bytes;
      if (!rawLimitExceeded) parts.push(Buffer.from(addition.stdout, "utf8")); else rawDiffBytes = this.policy.max_diff_bytes + 1;
    }
    const bytes = Buffer.concat(parts);
    const content = [] as Array<{ path: string; original_path: string | null; status: string; content_hash: string | null }>;
    for (const entry of entries) content.push({ path: entry.path, original_path: entry.originalPath, status: entry.status, content_hash: entry.status === "deleted" ? null : await hashContainedFile(root, entry.path, this.policy.max_file_bytes) });
    const reviewBytes = rawLimitExceeded
      ? Buffer.from(`${JSON.stringify({ blocked: true, reason: "raw_diff_size_limit_exceeded", raw_diff_bytes: rawDiffBytes })}\n`, "utf8")
      : Buffer.from(redactText(bytes.toString("utf8"), Math.max(bytes.length * 2, 2_000)), "utf8");
    const index = await runGit(["ls-files", "--stage", "-z"]); const raw = await runGit(["diff", "--raw", "--no-abbrev", "--no-textconv", "-z", "HEAD", "--"]);
    if (index.exitCode !== 0 || raw.exitCode !== 0) throw new Error("Quality gate could not freeze index metadata");
    return { head, entries, files, unsafePaths, reviewBytes, rawDiffBytes, snapshotHash: stableHash({ head, index_hash: sha256(index.stdout), raw_hash: sha256(raw.stdout), content }) };
  }

  private async runGitWithinDeadline(root: string, args: readonly string[], hardDeadline: number): Promise<QualityCommandExecution> { const remaining = hardDeadline - Date.now(); if (remaining <= 0) throw new Error("Quality gate wall-time budget exhausted before Git evidence completed"); return withinDeadline(this.runGit(root, args, remaining), hardDeadline, `git ${args[0] ?? "command"}`); }

  private async persistDiff(request: QualityGateRequest, bytes: Buffer, hash: string): Promise<string> {
    const relative = `evidence/${request.run_id}/${hash}.diff`;
    const directory = await ensureOwnedRunDirectory(this.evidenceRoot, request);
    const target = path.join(directory.path, `${hash}.diff`);
    await writeOnce(directory, target, bytes, hash);
    return relative;
  }
}

export async function persistEvidenceBundle(evidenceRoot: string, bundle: EvidenceBundle): Promise<string> {
  assertEvidenceBundle(bundle);
  const root = path.resolve(evidenceRoot);
  const request: QualityGateRequest = { run_id: bundle.run_id, task_id: bundle.task_id, base_commit: bundle.base_commit, plan_hash: bundle.task_package_hash, approval_hash: bundle.approval_hash, isolation_hash: bundle.isolation_hash, worktree_id: bundle.worktree_id, write_scope: ["evidence-only"], command_ids: [], policy_hash: bundle.quality_policy_hash, effective_policy_hash: bundle.policy_hash, max_wall_time_ms: bundle.quality_policy.max_wall_time_ms };
  const directory = await ensureOwnedRunDirectory(root, request, true);
  const relative = `evidence/${bundle.run_id}/${bundle.bundle_hash}.json`;
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeOnce(directory, path.join(directory.path, `${bundle.bundle_hash}.json`), bytes, sha256(bytes));
  return relative;
}

export async function readEvidenceArtifact(evidenceRoot: string, reference: string, expectedHash?: string): Promise<Buffer> {
  assertSafeRelativePath(reference, "evidence reference");
  if (!reference.startsWith("evidence/")) throw new Error("Evidence reference is outside the managed namespace");
  const root = await realpath(path.resolve(evidenceRoot));
  const target = path.resolve(root, reference);
  if (!isWithin(root, target)) throw new Error("Evidence reference escaped the managed root");
  const bytes = await readOwnedFile(root, target, 16 * 1024 * 1024);
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error("Evidence artifact hash mismatch");
  return bytes;
}

export function assertQualityGateReport(value: unknown): asserts value is QualityGateReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QualityGateReport must be an object");
  const report = value as Record<string, unknown>;
  const keys = ["version", "run_id", "task_id", "base_commit", "plan_hash", "approval_hash", "isolation_hash", "worktree_id", "policy_hash", "effective_policy_hash", "max_wall_time_ms", "request_hash", "passed", "worktree_head", "files_changed", "content_snapshot_hash", "post_artifact_snapshot_hash", "worktree_snapshot_hash", "diff_hash", "diff_reference", "quality_gate_results", "tests_run", "scope_violations", "privacy_violations", "secret_scan_summary", "wall_clock_time_ms", "redaction_notes", "report_hash"];
  if (Object.keys(report).length !== keys.length || keys.some(key => !(key in report))) throw new Error("QualityGateReport has unknown or missing fields");
  if (report.version !== 1 || !ID.test(String(report.run_id)) || !ID.test(String(report.task_id)) || !GIT_OBJECT.test(String(report.base_commit)) || !HASH.test(String(report.plan_hash)) || !HASH.test(String(report.approval_hash)) || !HASH.test(String(report.isolation_hash)) || !ID.test(String(report.worktree_id)) || !HASH.test(String(report.policy_hash)) || !HASH.test(String(report.effective_policy_hash)) || !HASH.test(String(report.request_hash)) || typeof report.passed !== "boolean" || typeof report.worktree_head !== "string" || !GIT_OBJECT.test(report.worktree_head) || typeof report.content_snapshot_hash !== "string" || !HASH.test(report.content_snapshot_hash) || !HASH.test(String(report.post_artifact_snapshot_hash)) || !HASH.test(String(report.worktree_snapshot_hash)) || typeof report.diff_hash !== "string" || !HASH.test(report.diff_hash) || !HASH.test(String(report.report_hash))) throw new Error("QualityGateReport identity is invalid");
  assertSafeRelativePath(report.diff_reference, "QualityGateReport.diff_reference");
  assertStringArray(report.files_changed, true); (report.files_changed as string[]).forEach(item => assertSafeRelativePath(item, "QualityGateReport.files_changed")); uniqueStrings(report.files_changed as string[], "QualityGateReport.files_changed");
  if ([...(report.files_changed as string[])].sort().join("\0") !== (report.files_changed as string[]).join("\0")) throw new Error("QualityGateReport files must be sorted");
  assertStringArray(report.scope_violations, false); assertStringArray(report.privacy_violations, false); assertStringArray(report.redaction_notes, false);
  if (!Array.isArray(report.quality_gate_results) || report.quality_gate_results.some(item => !validGate(item))) throw new Error("QualityGateReport gate results are invalid");
  if (!Array.isArray(report.tests_run) || report.tests_run.some(item => !validTest(item))) throw new Error("QualityGateReport test results are invalid");
  uniqueStrings((report.quality_gate_results as Array<{ gate_id: string }>).map(item => item.gate_id), "QualityGateReport gates"); uniqueStrings((report.tests_run as Array<{ command_id: string }>).map(item => item.command_id), "QualityGateReport tests");
  const secret = report.secret_scan_summary as Record<string, unknown>;
  if (!secret || Object.keys(secret).length !== 4 || !["passed", "failed", "not_run"].includes(String(secret.outcome)) || !Number.isInteger(secret.findings) || (secret.findings as number) < 0 || !Number.isInteger(secret.baseline_findings) || (secret.baseline_findings as number) < 0 || !Number.isInteger(secret.new_findings) || (secret.new_findings as number) < 0) throw new Error("QualityGateReport secret summary is invalid");
  if (secret.findings !== secret.new_findings || (secret.outcome === "passed" && secret.new_findings !== 0) || (secret.outcome === "failed" && secret.new_findings === 0)) throw new Error("QualityGateReport secret summary is inconsistent");
  if (!Number.isInteger(report.wall_clock_time_ms) || (report.wall_clock_time_ms as number) < 0 || !Number.isInteger(report.max_wall_time_ms) || (report.max_wall_time_ms as number) < 1) throw new Error("QualityGateReport wall time is invalid");
  const { report_hash: _hash, ...body } = report;
  if (stableHash(body) !== report.report_hash) throw new Error("QualityGateReport hash does not match canonical content");
}

export function assertQualityGateReportForRequest(report: QualityGateReport, request: QualityGateRequest): void {
  assertQualityGateRequest(request); assertQualityGateReport(report);
  for (const field of ["run_id", "task_id", "base_commit", "plan_hash", "approval_hash", "isolation_hash", "worktree_id", "policy_hash", "effective_policy_hash", "max_wall_time_ms"] as const) if (report[field] !== request[field]) throw new Error(`QualityGateReport ${field} does not match the approved request`);
  if (report.request_hash !== hashQualityGateRequest(request)) throw new Error("QualityGateReport request hash does not match the approved write scope and command set");
  if (report.worktree_head !== request.base_commit || !report.diff_reference.startsWith(`evidence/${request.run_id}/`)) throw new Error("QualityGateReport worktree or artifact reference is not bound to the approved run");
  const expected = ["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", ...COMMAND_ORDER, "final_freeze", "evidence_artifact", "gate_budget"];
  const actual = report.quality_gate_results.map(item => item.gate_id);
  if (actual.join("\0") !== expected.join("\0")) throw new Error("QualityGateReport gate sequence is incomplete or reordered");
  const byId = new Map(report.quality_gate_results.map(item => [item.gate_id, item.outcome]));
  for (const id of ["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "final_freeze", "evidence_artifact", "gate_budget"]) if (!["passed", "failed"].includes(byId.get(id)!)) throw new Error(`QualityGateReport safety gate ${id} cannot be not-run or not-applicable`);
  const commandMutation = report.tests_run.some(item => item.worktree_mutated);
  const earlyFailed = ["base_identity", "preapply_scope"].some(id => byId.get(id) === "failed") || (byId.get("forbidden_paths") === "failed" && !commandMutation);
  for (const id of ["secret_scan", "diff_sanity"]) {
    const outcome = byId.get(id)!;
    if (earlyFailed ? outcome !== "not_run" : !["passed", "failed"].includes(outcome)) throw new Error(`QualityGateReport ${id} outcome contradicts earlier safety gates`);
  }
  const secret = report.secret_scan_summary;
  if (byId.get("secret_scan") !== secret.outcome) throw new Error("QualityGateReport secret gate contradicts the secret summary");
  const expectedScopeViolations = report.files_changed.filter(item => !isAllowedPath(item, request.write_scope)).map(item => `outside_write_scope:${item}`);
  const scopeGatesValid = expectedScopeViolations.length === 0 ? byId.get("preapply_scope") === "passed" && byId.get("changed_files_scope") === "passed" : byId.get("changed_files_scope") === "failed" && ["passed", "failed"].includes(byId.get("preapply_scope")!);
  if (report.scope_violations.join("\0") !== expectedScopeViolations.join("\0") || !scopeGatesValid) throw new Error("QualityGateReport scope gates contradict the approved write scope");
  const expectedForbidden = report.files_changed.filter(isForbiddenQualityPath).map(item => `forbidden_path:${item}`); const reportedForbidden = report.privacy_violations.filter(item => item.startsWith("forbidden_path:"));
  if (reportedForbidden.join("\0") !== expectedForbidden.join("\0")) throw new Error("QualityGateReport forbidden-path evidence contradicts changed files");
  const nonSecretPrivacy = report.privacy_violations.filter(item => !item.startsWith("new_high_confidence_secret_findings:"));
  if ((nonSecretPrivacy.length === 0) !== (byId.get("forbidden_paths") === "passed")) throw new Error("QualityGateReport forbidden-path gate contradicts privacy violations");
  let priorFailure = earlyFailed || byId.get("secret_scan") === "failed" || byId.get("diff_sanity") === "failed";
  let budgetStoppedCommand = false; let budgetScanFailed = priorFailure;
  for (const id of COMMAND_ORDER) {
    if (!request.command_ids.includes(id) || budgetScanFailed) continue;
    const outcome = byId.get(id)!;
    if (outcome === "not_run") { budgetStoppedCommand = true; budgetScanFailed = true; }
    else if (outcome === "failed") budgetScanFailed = true;
  }
  const observedTests = new Set(report.tests_run.map(item => item.command_id));
  for (const id of COMMAND_ORDER) {
    const outcome = byId.get(id)!; const test = report.tests_run.find(item => item.command_id === id);
    if (!request.command_ids.includes(id)) { if (outcome !== "not_applicable" || test) throw new Error(`QualityGateReport contains unapproved command evidence for ${id}`); }
    else if (priorFailure || (budgetStoppedCommand && outcome === "not_run")) { if (outcome !== "not_run" || test) throw new Error(`QualityGateReport command ${id} should be not-run after a failed gate or exhausted budget`); priorFailure = true; }
    else {
      if (!["passed", "failed"].includes(outcome) || !test) throw new Error(`QualityGateReport command evidence is incomplete for ${id}`);
      if ((outcome === "passed") !== (test.exit_code === 0 && !test.timed_out && !test.output_overflowed && !test.worktree_mutated)) throw new Error(`QualityGateReport command outcome contradicts diagnostics for ${id}`);
      if (outcome === "failed") priorFailure = true;
    }
    observedTests.delete(id);
  }
  if (observedTests.size) throw new Error("QualityGateReport contains unknown or extra command evidence");
  const expectedBudgetOutcome = report.wall_clock_time_ms >= request.max_wall_time_ms || budgetStoppedCommand ? "failed" : "passed";
  if (byId.get("gate_budget") !== expectedBudgetOutcome) throw new Error("QualityGateReport gate_budget contradicts the approved wall-time limit");
  if (byId.get("evidence_artifact") === "passed" && report.content_snapshot_hash !== report.post_artifact_snapshot_hash) throw new Error("QualityGateReport artifact gate contradicts the post-artifact snapshot");
  const derivedPassed = report.quality_gate_results.every(item => item.outcome === "passed" || item.outcome === "not_applicable") && report.scope_violations.length === 0 && report.privacy_violations.length === 0 && secret.outcome === "passed" && secret.new_findings === 0;
  if (report.passed !== derivedPassed) throw new Error("QualityGateReport passed flag contradicts gate outcomes");
}

export function hashQualityGateRequest(request: QualityGateRequest): string {
  assertQualityGateRequest(request);
  return stableHash({ ...request, write_scope: [...request.write_scope], command_ids: [...request.command_ids] });
}

function assertQualityGateRequest(request: QualityGateRequest): void {
  if (!request || !ID.test(request.run_id) || !ID.test(request.task_id) || !GIT_OBJECT.test(request.base_commit) || !HASH.test(request.plan_hash) || !HASH.test(request.approval_hash) || !HASH.test(request.isolation_hash) || !ID.test(request.worktree_id) || !HASH.test(request.policy_hash) || !HASH.test(request.effective_policy_hash) || !Number.isInteger(request.max_wall_time_ms) || request.max_wall_time_ms < 1) throw new Error("Quality gate request identity is invalid");
  assertPathScope(request.write_scope, "QualityGateRequest.write_scope");
  if (!Array.isArray(request.command_ids) || request.command_ids.some(id => !COMMAND_ORDER.includes(id)) || new Set(request.command_ids).size !== request.command_ids.length) throw new Error("Quality gate command IDs are invalid");
  if ([...request.command_ids].sort((a, b) => COMMAND_ORDER.indexOf(a) - COMMAND_ORDER.indexOf(b)).join("\0") !== request.command_ids.join("\0")) throw new Error("Quality gate command IDs must use deterministic order");
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
  for (const item of ignored.stdout.split("\0").filter(Boolean)) entries.push({ status: "ignored", path: safeGitPath(item), originalPath: null });
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function scanSecrets(root: string, entries: ChangeEntry[], maxBytes: number, runGit: QualityGitRunner): Promise<{ baselineFindings: number; newFindings: number }> {
  let baselineFindings = 0; let newFindings = 0;
  for (const entry of entries) {
    const baseline = entry.status === "untracked" ? "" : await gitFileText(root, `HEAD:${entry.originalPath ?? entry.path}`, maxBytes, runGit);
    const current = entry.status === "deleted" ? "" : await fileText(path.join(root, entry.path), maxBytes);
    const before = secretFingerprints(baseline); const after = secretFingerprints(current);
    baselineFindings += [...before.values()].reduce((sum, count) => sum + count, 0);
    for (const [finding, count] of after) newFindings += Math.max(0, count - (before.get(finding) ?? 0));
  }
  return { baselineFindings, newFindings };
}

async function diffSanity(root: string, snapshot: DiffSnapshot, maxDiffBytes: number, maxFileBytes: number): Promise<string[]> {
  const violations: string[] = [];
  if (snapshot.rawDiffBytes > maxDiffBytes) violations.push("raw_diff_size_limit_exceeded");
  if (/^(?:old mode|new mode|Subproject commit)/m.test(snapshot.reviewBytes.toString("utf8"))) violations.push("file_mode_or_gitlink_change");
  for (const entry of snapshot.entries) {
    if (entry.status === "renamed" || entry.status === "deleted") violations.push(`${entry.status}_not_approved:${entry.path}`);
    if (entry.status !== "deleted") {
      const file = path.join(root, entry.path); const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) { violations.push(`non_regular_file:${entry.path}`); continue; }
      if (info.size > maxFileBytes) { violations.push(`file_size_limit_exceeded:${entry.path}`); continue; }
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

interface OwnedDirectory { path: string; parent: string; dev: number; ino: number }

async function ensureOwnedRunDirectory(root: string, request: QualityGateRequest, _bundleOnly = false): Promise<OwnedDirectory> {
  await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  const evidence = path.join(physicalRoot, "evidence"); const run = path.join(evidence, request.run_id);
  await mkdir(evidence).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await rejectLink(evidence);
  let created = false;
  try { await mkdir(run); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const ownedRun = await captureOwnedDirectory(run, evidence);
  const ownerPath = path.join(run, "owner.json");
  const owner = { version: 1, run_id: request.run_id, task_id: request.task_id, base_commit: request.base_commit, plan_hash: request.plan_hash, approval_hash: request.approval_hash, isolation_hash: request.isolation_hash, worktree_id: request.worktree_id, effective_policy_hash: request.effective_policy_hash, quality_policy_hash: request.policy_hash };
  if (created) {
    const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"); await writeOnce(ownedRun, ownerPath, ownerBytes, sha256(ownerBytes));
  } else {
    await assertOwnedDirectory(ownedRun);
    const actual: unknown = JSON.parse((await readOwnedFile(ownedRun.path, ownerPath, 16 * 1024)).toString("utf8"));
    if (stableHash(actual) !== stableHash(owner)) throw new Error("Evidence run directory ownership mismatch");
  }
  await assertOwnedDirectory(ownedRun);
  return ownedRun;
}

async function writeOnce(owner: OwnedDirectory, target: string, bytes: Buffer, expectedContentHash: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    await assertOwnedDirectory(owner);
    const handle = await open(temporary, "wx"); temporaryCreated = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertOwnedDirectory(owner);
    const temporaryInfo = await lstat(temporary); const temporaryPhysical = await realpath(temporary);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || !isWithin(owner.path, temporaryPhysical)) throw new Error("Evidence temporary artifact escaped its owned directory");
    try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertOwnedDirectory(owner);
    const existing = await readOwnedFile(owner.path, target, bytes.length); if (sha256(existing) !== expectedContentHash) throw new Error("Existing evidence artifact did not match the frozen content");
  }
  finally {
    if (temporaryCreated) {
      await assertOwnedDirectory(owner);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function captureOwnedDirectory(directory: string, expectedParent: string): Promise<OwnedDirectory> {
  const parent = await realpath(expectedParent); const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Evidence path is not an owned physical directory");
  const physical = await realpath(directory); const after = await lstat(directory);
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || path.relative(parent, path.dirname(physical)) !== "") throw new Error("Evidence directory identity changed or escaped its owned parent");
  return { path: physical, parent, dev: after.dev, ino: after.ino };
}

async function assertOwnedDirectory(owner: OwnedDirectory): Promise<void> {
  const current = await captureOwnedDirectory(owner.path, owner.parent);
  if (current.path !== owner.path || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Evidence directory identity changed during artifact access");
}

async function readOwnedFile(ownedRoot: string, target: string, maxBytes: number): Promise<Buffer> {
  const root = await realpath(ownedRoot); const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Evidence reference is not a regular owned file");
  const physical = await realpath(target); if (!isWithin(root, physical)) throw new Error("Evidence reference physical path escaped the managed root");
  const handle = await open(target, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error("Evidence artifact changed during open or exceeded its size boundary");
    const bytes = await handle.readFile(); const after = await lstat(target);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Evidence artifact changed during read");
    return bytes;
  } finally { await handle.close(); }
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
function replaceGate(results: EvidenceBundle["quality_gate_results"], gateId: string, outcome: GateOutcome, evidence: unknown): void { const index = results.findIndex(item => item.gate_id === gateId); if (index < 0) throw new Error(`Quality gate ${gateId} was not initialized`); const summary = redactText(JSON.stringify(evidence), 1_000); results[index] = { gate_id: gateId, outcome, evidence_hash: stableHash(evidence), summary }; }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function secretFingerprints(text: string): Map<string, number> { const result = new Map<string, number>(); for (const [rule, regex] of SECRET_RULES) { regex.lastIndex = 0; for (const match of text.matchAll(regex)) { const key = stableHash({ rule, value: match[0] }); result.set(key, (result.get(key) ?? 0) + 1); } } return result; }
async function fileText(file: string, maxBytes: number): Promise<string> { const info = await stat(file); if (!info.isFile() || info.size > maxBytes) return ""; const bytes = await readFile(file); if (bytes.includes(0)) return ""; try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return ""; } }
async function gitFileText(root: string, object: string, maxBytes: number, runGit: QualityGitRunner): Promise<string> { const result = await runGit(root, ["show", "--no-textconv", object]); if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > maxBytes || result.stdout.includes("\0")) return ""; return result.stdout; }
function redactAndBound(value: string, maxBytes: number): string { const redacted = redactText(value, maxBytes); return Buffer.byteLength(redacted) <= maxBytes ? redacted : Buffer.from(redacted).subarray(0, maxBytes).toString("utf8"); }
function assertStringArray(value: unknown, paths: boolean): asserts value is string[] { if (!Array.isArray(value) || value.some(item => typeof item !== "string" || (paths && item.length === 0))) throw new Error("QualityGateReport string array is invalid"); }
function uniqueStrings(values: string[], name: string): void { if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`); }
function validGate(value: unknown): boolean { const item = value as Record<string, unknown>; return Boolean(item && ID.test(String(item.gate_id)) && ["passed", "failed", "not_applicable", "not_run"].includes(String(item.outcome)) && HASH.test(String(item.evidence_hash)) && typeof item.summary === "string" && Object.keys(item).length === 4); }
function validTest(value: unknown): boolean { const item = value as Record<string, unknown>; return Boolean(item && ID.test(String(item.command_id)) && Number.isInteger(item.exit_code) && HASH.test(String(item.output_hash)) && typeof item.output_summary === "string" && typeof item.timed_out === "boolean" && typeof item.output_overflowed === "boolean" && typeof item.worktree_mutated === "boolean" && Object.keys(item).length === 7); }

async function safeRun(runner: QualityCommandRunner, spec: QualityCommandSpec, cwd: string, maxOutputBytes: number): Promise<QualityCommandExecution> {
  try { return await runner(spec, cwd, maxOutputBytes); }
  catch (error) { return { exitCode: 127, stdout: "", stderr: redactText(error instanceof Error ? error.message : String(error)), timedOut: false, overflowed: false }; }
}

async function runApprovedCommand(spec: QualityCommandSpec, cwd: string, maxOutputBytes: number): Promise<QualityCommandExecution> {
  return runProcess(spec.executable, spec.args, cwd, spec.timeout_ms, maxOutputBytes, {}, true);
}

async function runGitCommand(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<QualityCommandExecution> {
  return runProcess("git", args, cwd, Math.min(60_000, Math.max(1, timeoutMs)), 16 * 1024 * 1024, { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" }, false);
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error(`Quality gate wall-time budget exhausted before ${label}`); let timer: NodeJS.Timeout | undefined; try { return await Promise.race([operation, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Quality gate wall-time budget exhausted during ${label}`)), remaining); })]); } finally { if (timer) clearTimeout(timer); } }

async function runProcess(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maxOutputBytes: number, environment: NodeJS.ProcessEnv, redactOutput: boolean): Promise<QualityCommandExecution> {
  const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let timedOut = false; let overflowed = false; let outputBytes = 0;
  let terminationStarted = false; let treeTermination: Promise<boolean> | undefined;
  const terminate = () => { if (terminationStarted) return; terminationStarted = true; treeTermination = terminateProcessTree(child.pid); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const append = (stream: "stdout" | "stderr", chunk: unknown) => { const text = String(chunk); outputBytes += Buffer.byteLength(text); if (outputBytes > maxOutputBytes) { overflowed = true; terminate(); return; } if (stream === "stdout") stdout += text; else stderr += text; };
  child.stdout.on("data", chunk => append("stdout", chunk)); child.stderr.on("data", chunk => append("stderr", chunk));
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  let hardExpired = false; let hardTimer: NodeJS.Timeout | undefined;
  const hardStop = new Promise<[number | null]>(resolve => { hardTimer = setTimeout(() => { hardExpired = true; child.stdout.destroy(); child.stderr.destroy(); child.kill("SIGKILL"); resolve([null]); }, timeoutMs + 1_500); });
  const [code] = await Promise.race([once(child, "close") as Promise<[number | null]>, hardStop]);
  clearTimeout(timer); if (hardTimer) clearTimeout(hardTimer);
  const treeTerminated = treeTermination ? await treeTerminationWithin(treeTermination, 1_400) : true;
  if ((terminationStarted && !treeTerminated) || hardExpired) throw new Error("Quality command process tree could not be terminated within the hard deadline");
  return { exitCode: overflowed ? 125 : timedOut ? 124 : (code ?? 1), stdout: redactOutput ? redactAndBound(stdout, maxOutputBytes) : stdout, stderr: redactOutput ? redactAndBound(stderr, maxOutputBytes) : stderr, timedOut, overflowed };
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function terminateProcessTree(pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  if (process.platform !== "win32") {
    const snapshot = await listPosixDescendants(pid);
    const termGroup = killProcessGroup(pid, "SIGTERM"); const termChildren = snapshot.pids.slice().reverse().map(childPid => killPid(childPid, "SIGTERM")).every(Boolean);
    await new Promise(resolve => setTimeout(resolve, 250));
    const killGroup = killProcessGroup(pid, "SIGKILL"); const killChildren = snapshot.pids.slice().reverse().map(childPid => killPid(childPid, "SIGKILL")).every(Boolean);
    return snapshot.observed && termGroup && termChildren && killGroup && killChildren;
  }
  const systemDrive = path.parse(process.execPath).root;
  const taskkill = path.join(systemDrive, "Windows", "System32", "taskkill.exe");
  return new Promise<boolean>(resolve => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, env: {}, stdio: "ignore" });
    let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    killer.once("error", () => { try { process.kill(pid, "SIGKILL"); } catch {} finish(false); });
    killer.once("exit", code => finish(code === 0));
    const timer = setTimeout(() => { try { killer.kill("SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} finish(false); }, 1_000);
  });
}

async function treeTerminationWithin(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([operation, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }

function killPid(pid: number, signal: NodeJS.Signals): boolean { try { process.kill(pid, signal); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }

async function listPosixDescendants(rootPid: number): Promise<{ observed: boolean; pids: number[] }> {
  const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  return new Promise(resolve => {
    const child = spawn(ps, ["-eo", "pid=,ppid="], { shell: false, windowsHide: true, env: {}, stdio: ["ignore", "pipe", "ignore"] }); let stdout = ""; let settled = false;
    const finish = (value: { observed: boolean; pids: number[] }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += String(chunk); }); child.once("error", () => finish({ observed: false, pids: [] }));
    child.once("close", code => {
      if (code !== 0) return finish({ observed: false, pids: [] });
      const children = new Map<number, number[]>();
      for (const line of stdout.split(/\r?\n/)) { const [pidText, parentText] = line.trim().split(/\s+/); const pid = Number(pidText); const parent = Number(parentText); if (Number.isInteger(pid) && Number.isInteger(parent)) children.set(parent, [...(children.get(parent) ?? []), pid]); }
      const result: number[] = []; const pending = [...(children.get(rootPid) ?? [])]; while (pending.length) { const pid = pending.shift()!; result.push(pid); pending.push(...(children.get(pid) ?? [])); }
      finish({ observed: true, pids: result });
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ observed: false, pids: [] }); }, 1_000);
  });
}
