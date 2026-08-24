import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./canonical.js";
import { assertPricingCatalog, type PricingCatalog } from "./cost.js";
import { verifyDistributionManifest, type DistributionManifest } from "./distribution.js";
import type { InstallPreview } from "./installation.js";
import { ROUTER_MCP_TOOL_NAMES, type McpRegistrationPreview } from "./mcp-registration.js";

const MAX_DIAGNOSTIC_JSON_BYTES = 2 * 1024 * 1024;

export interface CredentialAliasStatus {
  alias: string;
  available: boolean;
  source: "caller_attested_alias_presence";
  secret_read: false;
}

export interface CredentialStatusInput {
  required_aliases: readonly string[];
  available_aliases: readonly string[];
}

export interface PricingVerification {
  passed: boolean;
  version: string | null;
  catalog_hash: string | null;
  valid_until: string | null;
  checked_at: string;
  error: string | null;
}

export interface DoctorBoundFile {
  path: string;
  expected_sha256: string;
  kind: "schema" | "policy" | "catalog" | "state";
}

export interface DoctorRoots {
  distribution_root: string;
  project_root: string;
  state_root: string;
  worktree_root: string;
  evidence_root: string;
}

export interface DoctorInput {
  roots: DoctorRoots;
  distribution_manifest: DistributionManifest;
  bound_json_files: readonly DoctorBoundFile[];
  pricing_catalog: PricingCatalog;
  now: Date;
  credential_status: CredentialStatusInput;
  registration: McpRegistrationPreview;
  install_preview: InstallPreview;
  current_config: string;
  approved_main_workspace_snapshot: string;
  observed_main_workspace_snapshot: string;
  state_writable?: (stateRoot: string) => boolean | Promise<boolean>;
}

export interface DoctorCheck {
  id: "build_hash" | "roots" | "schema_policy_catalog" | "pricing" | "credential_aliases" | "mcp_block" | "enabled_tools" | "state_writable" | "main_workspace_snapshot";
  passed: boolean;
  detail: string;
}

export interface DoctorReport {
  version: 1;
  passed: boolean;
  offline_only: true;
  credential_values_read: false;
  provider_requests: 0;
  checks: DoctorCheck[];
  report_hash: string;
}

export function credentialStatus(input: CredentialStatusInput): CredentialAliasStatus[] {
  const required = uniqueAliases(input.required_aliases, "required_aliases");
  const available = new Set(uniqueAliases(input.available_aliases, "available_aliases"));
  return required.map(alias => Object.freeze({ alias, available: available.has(alias), source: "caller_attested_alias_presence" as const, secret_read: false as const }));
}

export function verifyPricing(catalog: PricingCatalog, now: Date): PricingVerification {
  try {
    assertPricingCatalog(catalog, now);
    return Object.freeze({ passed: true, version: catalog.version, catalog_hash: catalog.catalog_hash, valid_until: catalog.valid_until, checked_at: now.toISOString(), error: null });
  } catch (error) {
    return Object.freeze({ passed: false, version: typeof catalog?.version === "string" ? catalog.version : null, catalog_hash: typeof catalog?.catalog_hash === "string" ? catalog.catalog_hash : null, valid_until: typeof catalog?.valid_until === "string" ? catalog.valid_until : null, checked_at: validDate(now) ? now.toISOString() : "invalid", error: publicError(error) });
  }
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const build = await verifyDistributionManifest(input.roots.distribution_root, input.distribution_manifest);
  const entryEvidence = input.distribution_manifest.files.find(file => file.path === "dist/src/mcp.js");
  const entryBound = Boolean(entryEvidence && input.registration.entrypoint_sha256 === entryEvidence.sha256
    && input.registration.args[0] === path.join(path.resolve(input.roots.distribution_root), "dist", "src", "mcp.js"));
  checks.push(check("build_hash", build.passed && entryBound, build.passed && entryBound ? `verified:${build.observed_hash}` : [...build.errors, ...(entryBound ? [] : ["entrypoint_binding_mismatch"])].join(",")));
  const rootErrors = validateRoots(input.roots);
  checks.push(check("roots", rootErrors.length === 0, rootErrors.length ? rootErrors.join(",") : "absolute_non_overlapping_roots"));
  const fileErrors = await verifyBoundJsonFiles(input.bound_json_files);
  checks.push(check("schema_policy_catalog", fileErrors.length === 0, fileErrors.length ? fileErrors.join(",") : `${input.bound_json_files.length}_hash_bound_json_files`));
  const pricing = verifyPricing(input.pricing_catalog, input.now);
  checks.push(check("pricing", pricing.passed, pricing.passed ? `valid_until:${pricing.valid_until}` : `invalid:${pricing.error}`));
  const aliases = credentialStatus(input.credential_status); const missingAliases = aliases.filter(item => !item.available).map(item => item.alias);
  checks.push(check("credential_aliases", missingAliases.length === 0, missingAliases.length ? `missing:${missingAliases.join(",")}` : `available:${aliases.map(item => item.alias).join(",") || "none"}`));
  const blockPresent = countOccurrences(input.current_config, input.install_preview.managed_block) === 1
    && input.install_preview.managed_block_sha256 === sha256(input.install_preview.managed_block)
    && input.install_preview.exact_mcp_block_sha256 === input.registration.block_sha256;
  checks.push(check("mcp_block", blockPresent, blockPresent ? `exact_hash:${input.install_preview.managed_block_sha256}` : "missing_or_drifted"));
  const expectedTools = [...ROUTER_MCP_TOOL_NAMES];
  const enabledTools = parseEnabledTools(input.registration.toml_block);
  const toolsMatch = input.registration.enabled_tools.length === expectedTools.length
    && input.registration.enabled_tools.every((tool, index) => tool === expectedTools[index])
    && enabledTools.length === expectedTools.length && enabledTools.every((tool, index) => tool === expectedTools[index]);
  checks.push(check("enabled_tools", toolsMatch, toolsMatch ? `${enabledTools.length}_exact_tools` : "enabled_tools_mismatch"));
  const writable = await (input.state_writable ? input.state_writable(input.roots.state_root) : canWriteDirectory(input.roots.state_root));
  checks.push(check("state_writable", writable, writable ? "write_access_confirmed" : "state_root_not_writable"));
  const snapshotOk = digest(input.approved_main_workspace_snapshot) && input.approved_main_workspace_snapshot === input.observed_main_workspace_snapshot;
  checks.push(check("main_workspace_snapshot", snapshotOk, snapshotOk ? `verified:${input.observed_main_workspace_snapshot}` : "snapshot_mismatch"));
  const body = { version: 1 as const, passed: checks.every(item => item.passed), offline_only: true as const, credential_values_read: false as const, provider_requests: 0 as const, checks };
  return Object.freeze({ ...body, checks: Object.freeze(checks.map(item => Object.freeze(item))) as unknown as DoctorCheck[], report_hash: stableHash(body) });
}

export function validateRoots(roots: DoctorRoots): string[] {
  const entries = Object.entries(roots);
  const errors: string[] = [];
  for (const [name, value] of entries) if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) errors.push(`invalid:${name}`);
  if (errors.length) return errors;
  for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) {
    if (overlap(entries[left][1], entries[right][1])) errors.push(`overlap:${entries[left][0]}:${entries[right][0]}`);
  }
  return errors;
}

async function verifyBoundJsonFiles(files: readonly DoctorBoundFile[]): Promise<string[]> {
  const errors: string[] = []; const paths = new Set<string>();
  for (const requiredKind of ["schema", "policy", "catalog"] as const) if (!files.some(file => file.kind === requiredKind)) errors.push(`missing_binding:${requiredKind}`);
  for (const binding of files) {
    if (!path.isAbsolute(binding.path) || !digest(binding.expected_sha256) || paths.has(normalize(binding.path))) { errors.push(`invalid_binding:${binding.kind}`); continue; }
    paths.add(normalize(binding.path));
    try {
      const info = await lstat(binding.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DIAGNOSTIC_JSON_BYTES) { errors.push(`unsafe_file:${binding.kind}`); continue; }
      const bytes = await readFile(binding.path);
      if (sha256(bytes) !== binding.expected_sha256) { errors.push(`hash_mismatch:${binding.kind}`); continue; }
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) errors.push(`invalid_json_object:${binding.kind}`);
      else if (binding.kind === "schema" && !("$schema" in parsed || "$ref" in parsed)) errors.push("invalid_schema");
    } catch { errors.push(`unavailable:${binding.kind}`); }
  }
  return errors;
}

async function canWriteDirectory(directory: string): Promise<boolean> { try { await access(directory, fsConstants.W_OK); return true; } catch { return false; } }
function parseEnabledTools(block: string): string[] {
  const match = /^enabled_tools\s*=\s*\[(.*)\]\s*$/m.exec(block);
  if (!match) return [];
  try { const parsed: unknown = JSON.parse(`[${match[1]}]`); return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : []; } catch { return []; }
}
function uniqueAliases(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  const result = values.map(alias => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias)) throw new Error(`${name} contains an invalid alias`); return alias; });
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicate aliases`);
  return result;
}
function check(id: DoctorCheck["id"], passed: boolean, detail: string): DoctorCheck { return { id, passed, detail }; }
function overlap(left: string, right: string): boolean { const l = normalize(left); const r = normalize(right); return within(l, r) || within(r, l); }
function within(parent: string, target: string): boolean { const relative = path.relative(parent, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function normalize(value: string): string { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
function countOccurrences(value: string, needle: string): number { if (!needle) return 0; let count = 0; let offset = 0; while ((offset = value.indexOf(needle, offset)) >= 0) { count++; offset += needle.length; } return count; }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validDate(value: Date): boolean { return value instanceof Date && !Number.isNaN(value.getTime()); }
function publicError(error: unknown): string { return error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 200) : "unknown"; }
