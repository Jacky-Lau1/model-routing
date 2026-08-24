import path from "node:path";
import { readFile } from "node:fs/promises";
import { stableHash } from "./canonical.js";
import { assertQualityGatePolicy, hashQualityGateRequest } from "./quality-gate.js";
import type { QualityCommandId, QualityGatePolicy, QualityGateRequest } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const COMMAND_ORDER: QualityCommandId[] = ["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"];

export type QualityCommandVisibility = "visible" | "hidden";

export interface TrustedQualityCommand {
  command_id: QualityCommandId;
  executable: string;
  argv: string[];
  cwd_mode: "worktree";
  timeout_ms: number;
  max_output_bytes: number;
  visibility: QualityCommandVisibility;
}

export interface TrustedQualityCommandCatalog {
  version: 1;
  catalog_id: string;
  commands: TrustedQualityCommand[];
  catalog_hash: string;
}

export interface QualityGateApprovalBoundary {
  version: 1;
  run_id: string;
  task_id: string;
  worktree_id: string;
  request_hash: string;
  policy_hash: string;
  catalog_hash: string;
  fixture_hash: string;
  hidden_root_hash: string | null;
  base_commit: string;
  worktree_root: string;
  evidence_root: string;
  commands: Array<{
    command_id: QualityCommandId;
    executable: string;
    argv: string[];
    cwd: string;
    timeout_ms: number;
    max_output_bytes: number;
    visibility: QualityCommandVisibility;
  }>;
  max_wall_time_ms: number;
  approval_boundary_hash: string;
}

export interface CreateQualityGateApprovalBoundaryOptions {
  request: QualityGateRequest;
  policy: QualityGatePolicy;
  catalog: TrustedQualityCommandCatalog;
  fixtureHash: string;
  hiddenRootHash?: string | null;
  worktreeRoot: string;
  evidenceRoot: string;
  realPilot: boolean;
}

export function createTrustedQualityCommandCatalog(input: Omit<TrustedQualityCommandCatalog, "catalog_hash">): TrustedQualityCommandCatalog {
  const body = {
    version: input.version,
    catalog_id: input.catalog_id,
    commands: input.commands.map(command => ({ ...command, argv: [...command.argv] })),
  };
  assertTrustedQualityCommandCatalogBody(body);
  const catalog = { ...body, catalog_hash: stableHash(body) };
  assertTrustedQualityCommandCatalog(catalog);
  return deepFreezeCatalog(catalog);
}

export function assertTrustedQualityCommandCatalog(value: unknown): asserts value is TrustedQualityCommandCatalog {
  if (!isRecord(value)) throw new Error("Trusted quality command catalog must be an object");
  assertExactKeys(value, ["version", "catalog_id", "commands", "catalog_hash"], "Trusted quality command catalog");
  assertTrustedQualityCommandCatalogBody(value);
  if (typeof value.catalog_hash !== "string" || !HASH.test(value.catalog_hash)) throw new Error("Trusted quality command catalog hash is invalid");
  const { catalog_hash: _hash, ...body } = value;
  if (stableHash(body) !== value.catalog_hash) throw new Error("Trusted quality command catalog hash does not match canonical content");
}

export async function loadQualityGatePolicy(policyPath: string): Promise<QualityGatePolicy> {
  const value = await readStrictJson(policyPath, "QualityGatePolicy");
  assertQualityGatePolicy(value);
  return Object.freeze({ ...value, command_ids: Object.freeze([...value.command_ids]) as unknown as QualityCommandId[] });
}

export async function loadTrustedQualityCommandCatalog(catalogPath: string): Promise<TrustedQualityCommandCatalog> {
  const value = await readStrictJson(catalogPath, "trusted quality command catalog");
  assertTrustedQualityCommandCatalog(value);
  return deepFreezeCatalog(value);
}

export function assertPilotQualityGate(policy: QualityGatePolicy, catalog: TrustedQualityCommandCatalog): void {
  assertQualityGatePolicy(policy);
  assertTrustedQualityCommandCatalog(catalog);
  assertPolicyCatalogPair(policy, catalog);
  if (policy.command_ids.length === 0) throw new Error("A real Pilot cannot use an empty quality gate");
  const selected = catalog.commands.filter(command => policy.command_ids.includes(command.command_id));
  if (!selected.some(command => command.visibility === "visible")) throw new Error("A real Pilot requires at least one visible quality command");
  if (!selected.some(command => command.visibility === "hidden")) throw new Error("A real Pilot requires a hidden acceptance command");
}

export function createQualityGateApprovalBoundary(options: CreateQualityGateApprovalBoundaryOptions): QualityGateApprovalBoundary {
  assertQualityGatePolicy(options.policy);
  assertTrustedQualityCommandCatalog(options.catalog);
  assertPolicyCatalogPair(options.policy, options.catalog);
  if (options.realPilot) assertPilotQualityGate(options.policy, options.catalog);
  if (options.request.policy_hash !== options.policy.policy_hash || options.request.max_wall_time_ms !== options.policy.max_wall_time_ms) throw new Error("Quality request is not bound to the supplied policy");
  if (options.request.catalog_hash !== options.catalog.catalog_hash || options.request.fixture_hash !== options.fixtureHash || options.request.hidden_root_hash !== (options.hiddenRootHash ?? null)) throw new Error("Quality request is not bound to the supplied catalog, fixture, and hidden root");
  if (!sameArray(options.request.command_ids, options.policy.command_ids)) throw new Error("Quality request command IDs are not bound to the supplied policy");
  if (options.request.base_commit === "" || !GIT_OBJECT.test(options.request.base_commit)) throw new Error("Quality request base commit is invalid");
  if (!HASH.test(options.fixtureHash)) throw new Error("Quality fixture hash is invalid");
  const hidden = options.hiddenRootHash ?? null;
  if (hidden !== null && !HASH.test(hidden)) throw new Error("Hidden acceptance root hash is invalid");
  const selected = options.policy.command_ids.map(id => options.catalog.commands.find(command => command.command_id === id)!);
  if (selected.some(command => command.visibility === "hidden") !== (hidden !== null)) throw new Error("Hidden acceptance commands and hidden root hash must be supplied together");
  const worktreeRoot = exactAbsolutePath(options.worktreeRoot, "worktree root");
  const evidenceRoot = exactAbsolutePath(options.evidenceRoot, "evidence root");
  if (pathsOverlap(worktreeRoot, evidenceRoot)) throw new Error("Quality worktree and evidence roots must not overlap");
  const body: Omit<QualityGateApprovalBoundary, "approval_boundary_hash"> = {
    version: 1,
    run_id: options.request.run_id,
    task_id: options.request.task_id,
    worktree_id: options.request.worktree_id,
    request_hash: hashQualityGateRequest(options.request),
    policy_hash: options.policy.policy_hash,
    catalog_hash: options.catalog.catalog_hash,
    fixture_hash: options.fixtureHash,
    hidden_root_hash: hidden,
    base_commit: options.request.base_commit,
    worktree_root: worktreeRoot,
    evidence_root: evidenceRoot,
    commands: selected.map(command => ({
      command_id: command.command_id,
      executable: command.executable,
      argv: [...command.argv],
      cwd: worktreeRoot,
      timeout_ms: command.timeout_ms,
      max_output_bytes: command.max_output_bytes,
      visibility: command.visibility,
    })),
    max_wall_time_ms: options.policy.max_wall_time_ms,
  };
  const result = { ...body, approval_boundary_hash: stableHash(body) };
  assertQualityGateApprovalBoundary(result);
  return Object.freeze({ ...result, commands: Object.freeze(result.commands.map(command => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) as unknown as string[] }))) as unknown as QualityGateApprovalBoundary["commands"] });
}

export function assertQualityGateApprovalBoundary(value: unknown): asserts value is QualityGateApprovalBoundary {
  if (!isRecord(value)) throw new Error("Quality gate approval boundary must be an object");
  assertExactKeys(value, ["version", "run_id", "task_id", "worktree_id", "request_hash", "policy_hash", "catalog_hash", "fixture_hash", "hidden_root_hash", "base_commit", "worktree_root", "evidence_root", "commands", "max_wall_time_ms", "approval_boundary_hash"], "Quality gate approval boundary");
  if (value.version !== 1 || !ID.test(String(value.run_id)) || !ID.test(String(value.task_id)) || !ID.test(String(value.worktree_id)) || !HASH.test(String(value.request_hash)) || !HASH.test(String(value.policy_hash)) || !HASH.test(String(value.catalog_hash)) || !HASH.test(String(value.fixture_hash)) || (value.hidden_root_hash !== null && !HASH.test(String(value.hidden_root_hash))) || !GIT_OBJECT.test(String(value.base_commit)) || !HASH.test(String(value.approval_boundary_hash))) throw new Error("Quality gate approval boundary identity is invalid");
  exactAbsolutePath(value.worktree_root, "worktree root");
  exactAbsolutePath(value.evidence_root, "evidence root");
  if (pathsOverlap(value.worktree_root as string, value.evidence_root as string)) throw new Error("Quality worktree and evidence roots must not overlap");
  if (!Number.isInteger(value.max_wall_time_ms) || (value.max_wall_time_ms as number) < 1 || (value.max_wall_time_ms as number) > 30 * 60_000) throw new Error("Quality gate approval wall limit is invalid");
  if (!Array.isArray(value.commands)) throw new Error("Quality gate approval commands are invalid");
  let previous = -1;
  for (const command of value.commands) {
    if (!isRecord(command)) throw new Error("Quality gate approval command must be an object");
    assertExactKeys(command, ["command_id", "executable", "argv", "cwd", "timeout_ms", "max_output_bytes", "visibility"], "Quality gate approval command");
    assertTrustedCommand({ ...command, cwd_mode: "worktree" }, true);
    exactAbsolutePath(command.cwd, "quality command cwd");
    if (command.cwd !== value.worktree_root) throw new Error("Quality command cwd is not the approved worktree root");
    const order = COMMAND_ORDER.indexOf(command.command_id as QualityCommandId);
    if (order <= previous) throw new Error("Quality gate approval commands are reordered or duplicated");
    previous = order;
  }
  const { approval_boundary_hash: _hash, ...body } = value;
  if (stableHash(body) !== value.approval_boundary_hash) throw new Error("Quality gate approval boundary hash does not match canonical content");
}

export function assertQualityGateRuntimeBinding(boundary: QualityGateApprovalBoundary, options: CreateQualityGateApprovalBoundaryOptions): void {
  assertQualityGateApprovalBoundary(boundary);
  const current = createQualityGateApprovalBoundary(options);
  if (current.approval_boundary_hash !== boundary.approval_boundary_hash) throw new Error("Quality gate policy, catalog, command, fixture, base commit, roots, or limits changed after approval");
}

function assertTrustedQualityCommandCatalogBody(value: Record<string, unknown>): void {
  if (value.version !== 1 || typeof value.catalog_id !== "string" || !ID.test(value.catalog_id)) throw new Error("Trusted quality command catalog identity is invalid");
  if (!Array.isArray(value.commands)) throw new Error("Trusted quality command catalog commands are invalid");
  let previous = -1;
  for (const command of value.commands) {
    assertTrustedCommand(command, false);
    const order = COMMAND_ORDER.indexOf((command as TrustedQualityCommand).command_id);
    if (order <= previous) throw new Error("Trusted quality command catalog must use deterministic order without duplicates");
    previous = order;
  }
}

function assertTrustedCommand(value: unknown, approvalShape: boolean): asserts value is TrustedQualityCommand {
  if (!isRecord(value)) throw new Error("Trusted quality command must be an object");
  const keys = approvalShape
    ? ["command_id", "executable", "argv", "cwd", "timeout_ms", "max_output_bytes", "visibility", "cwd_mode"]
    : ["command_id", "executable", "argv", "cwd_mode", "timeout_ms", "max_output_bytes", "visibility"];
  assertExactKeys(value, keys, "Trusted quality command");
  if (!COMMAND_ORDER.includes(value.command_id as QualityCommandId)) throw new Error("Trusted quality command ID is invalid");
  exactAbsolutePath(value.executable, "trusted quality executable");
  if (!Array.isArray(value.argv) || value.argv.length > 64 || value.argv.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/.test(arg))) throw new Error("Trusted quality argv is invalid");
  if (value.cwd_mode !== "worktree") throw new Error("Trusted quality command cwd mode is invalid");
  if (!Number.isInteger(value.timeout_ms) || (value.timeout_ms as number) < 1 || (value.timeout_ms as number) > 30 * 60_000) throw new Error("Trusted quality command timeout is invalid");
  if (!Number.isInteger(value.max_output_bytes) || (value.max_output_bytes as number) < 1 || (value.max_output_bytes as number) > 1024 * 1024) throw new Error("Trusted quality command output limit is invalid");
  if (!(["visible", "hidden"] as unknown[]).includes(value.visibility)) throw new Error("Trusted quality command visibility is invalid");
  if (value.visibility === "hidden" && value.command_id !== "project_acceptance") throw new Error("Only project_acceptance may execute hidden acceptance data");
}

function assertPolicyCatalogPair(policy: QualityGatePolicy, catalog: TrustedQualityCommandCatalog): void {
  if (policy.command_registry_hash !== catalog.catalog_hash) throw new Error("Quality policy is not bound to the trusted command catalog hash");
  if (!sameArray(policy.command_ids, catalog.commands.map(command => command.command_id))) throw new Error("Quality policy command IDs must exactly match the trusted catalog");
  for (const command of catalog.commands) if (command.max_output_bytes > policy.max_output_bytes || command.timeout_ms > policy.max_wall_time_ms) throw new Error("Trusted command limit exceeds its approved quality policy ceiling");
}

async function readStrictJson(file: string, label: string): Promise<unknown> {
  const absolute = exactAbsolutePath(file, `${label} path`);
  const bytes = await readFile(absolute);
  if (bytes.length === 0 || bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error(`${label} file violates the JSON size boundary`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`${label} file is not UTF-8`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${label} file is not valid JSON`); }
}

function deepFreezeCatalog(catalog: TrustedQualityCommandCatalog): TrustedQualityCommandCatalog {
  return Object.freeze({ ...catalog, commands: Object.freeze(catalog.commands.map(command => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) as unknown as string[] }))) as unknown as TrustedQualityCommand[] });
}

function exactAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw new Error(`${label} must be an exact absolute path`);
  const resolved = path.resolve(value);
  if (resolved !== value) throw new Error(`${label} must be normalized`);
  return resolved;
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) || (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse));
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`${label} has unknown or missing fields`); }
