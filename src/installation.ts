import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { McpRegistrationPreview } from "./mcp-registration.js";

const BEGIN_PREFIX = "# BEGIN CODEX MODEL ROUTER";
const END_MARKER = "# END CODEX MODEL ROUTER";

export interface InstallPreviewInput {
  config_path: string;
  current_config: string;
  registration: McpRegistrationPreview;
}

export interface InstallPreview {
  operation: "install";
  dry_run: true;
  target: string;
  server_name: string;
  exact_mcp_block: string;
  exact_mcp_block_sha256: string;
  managed_block: string;
  managed_block_sha256: string;
  before_sha256: string;
  after_sha256: string;
  config_after: string;
  config_diff_preview: string;
  backup: { exact_target: string; source_sha256: string; would_create: true };
  rollback: { remove_exact_managed_block_sha256: string; refuse_on_drift: true; restore_backup: string };
}

export interface UninstallPreviewInput {
  config_path: string;
  current_config: string;
  server_name: string;
  expected_managed_block: string;
  expected_managed_block_sha256: string;
}

export interface UninstallPreview {
  operation: "uninstall";
  dry_run: true;
  target: string;
  server_name: string;
  exact_removed_block: string;
  exact_removed_block_sha256: string;
  before_sha256: string;
  after_sha256: string;
  config_after: string;
  config_diff_preview: string;
  backup: { exact_target: string; source_sha256: string; would_create: true };
  rollback: { restore_backup: string };
}

export function buildInstallPreview(input: InstallPreviewInput): InstallPreview {
  absolute(input.config_path, "config_path"); text(input.current_config, "current_config", true);
  assertNoMalformedManagedMarkers(input.current_config);
  const header = `[mcp_servers.${input.registration.server_name}]`;
  if (input.current_config.includes(header)) throw new Error("Refusing installation because the target MCP server block already exists");
  const exactHash = sha256(input.registration.toml_block);
  if (exactHash !== input.registration.block_sha256) throw new Error("Registration block hash mismatch");
  const managed = `${BEGIN_PREFIX} ${input.registration.server_name} sha256=${exactHash}\n${input.registration.toml_block}${END_MARKER} ${input.registration.server_name}\n`;
  const separator = input.current_config.length === 0 || input.current_config.endsWith("\n") ? "" : "\n";
  const configAfter = `${input.current_config}${separator}${managed}`;
  const before = sha256(input.current_config); const after = sha256(configAfter);
  const backup = backupPath(input.config_path, before);
  return Object.freeze({
    operation: "install" as const, dry_run: true as const, target: path.resolve(input.config_path), server_name: input.registration.server_name,
    exact_mcp_block: input.registration.toml_block, exact_mcp_block_sha256: exactHash, managed_block: managed, managed_block_sha256: sha256(managed),
    before_sha256: before, after_sha256: after, config_after: configAfter,
    config_diff_preview: managed.split("\n").filter((_, index, lines) => index < lines.length - 1).map(line => `+${line}`).join("\n") + "\n",
    backup: Object.freeze({ exact_target: backup, source_sha256: before, would_create: true as const }),
    rollback: Object.freeze({ remove_exact_managed_block_sha256: sha256(managed), refuse_on_drift: true as const, restore_backup: backup }),
  });
}

export function buildUninstallPreview(input: UninstallPreviewInput): UninstallPreview {
  absolute(input.config_path, "config_path"); identifier(input.server_name); text(input.current_config, "current_config", true); text(input.expected_managed_block, "expected_managed_block");
  assertNoMalformedManagedMarkers(input.current_config);
  if (!digest(input.expected_managed_block_sha256) || sha256(input.expected_managed_block) !== input.expected_managed_block_sha256) throw new Error("Expected managed MCP block hash mismatch");
  const occurrences = countOccurrences(input.current_config, input.expected_managed_block);
  if (occurrences !== 1) {
    const serverEvidence = input.current_config.includes(`[mcp_servers.${input.server_name}]`) || input.current_config.includes(`${BEGIN_PREFIX} ${input.server_name}`);
    throw new Error(serverEvidence ? "Refusing uninstall because the managed MCP block drifted" : "Exact managed MCP block is not installed");
  }
  const configAfter = input.current_config.replace(input.expected_managed_block, "");
  const before = sha256(input.current_config); const after = sha256(configAfter); const backup = backupPath(input.config_path, before);
  return Object.freeze({
    operation: "uninstall" as const, dry_run: true as const, target: path.resolve(input.config_path), server_name: input.server_name,
    exact_removed_block: input.expected_managed_block, exact_removed_block_sha256: input.expected_managed_block_sha256,
    before_sha256: before, after_sha256: after, config_after: configAfter,
    config_diff_preview: input.expected_managed_block.split("\n").filter((_, index, lines) => index < lines.length - 1).map(line => `-${line}`).join("\n") + "\n",
    backup: Object.freeze({ exact_target: backup, source_sha256: before, would_create: true as const }), rollback: Object.freeze({ restore_backup: backup }),
  });
}

/** Applies a previously reviewed plan to its explicit target. Callers must never substitute a discovered home/config path. */
export async function applyExplicitInstallationPlan(plan: InstallPreview | UninstallPreview): Promise<void> {
  const target = path.resolve(plan.target); const current = await readFile(target, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && plan.before_sha256 === sha256("")) return "";
    throw error;
  });
  if (sha256(current) !== plan.before_sha256) throw new Error("Configuration changed after preview; refusing to overwrite");
  if (sha256(plan.config_after) !== plan.after_sha256) throw new Error("Installation plan content hash mismatch");
  await mkdir(path.dirname(target), { recursive: true });
  await copyFileIfPresent(target, plan.backup.exact_target);
  const temporary = path.join(path.dirname(target), `.router-config.${randomUUID()}.tmp`);
  let moved = false;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(plan.config_after, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target); moved = true;
  } finally { if (!moved) await rm(temporary, { force: true }).catch(() => undefined); }
}

function assertNoMalformedManagedMarkers(config: string): void {
  const begins = countOccurrences(config, BEGIN_PREFIX); const ends = countOccurrences(config, END_MARKER);
  if (begins !== ends) throw new Error("Codex config contains malformed Router management markers");
}
async function copyFileIfPresent(source: string, target: string): Promise<void> {
  try { await copyFile(source, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function backupPath(target: string, hash: string): string { return `${path.resolve(target)}.router-backup-${hash.slice(0, 16)}`; }
function countOccurrences(value: string, needle: string): number { if (!needle) return 0; let count = 0; let offset = 0; while ((offset = value.indexOf(needle, offset)) >= 0) { count++; offset += needle.length; } return count; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function digest(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function absolute(value: string, name: string): void { if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${name} must be an absolute path`); }
function identifier(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("server_name is invalid"); }
function text(value: string, name: string, empty = false): void { if (typeof value !== "string" || (!empty && !value) || /\0/.test(value)) throw new Error(`${name} is invalid`); }
