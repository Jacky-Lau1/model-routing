import { createHash } from "node:crypto";
import path from "node:path";

export const ROUTER_MCP_TOOL_NAMES = ["router.prepare", "router.execute", "router.status", "router.abort", "router.review_evidence", "router.finalize", "router.repair", "router.apply", "router.pilot_report"] as const;
export const ROUTER_MCP_ENVIRONMENT_ALLOWLIST = ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "LOCALAPPDATA"] as const;

export interface McpRegistrationInput {
  server_name: string;
  node_executable: string;
  /** Root of the installed production distribution. `repository_root` is a deprecated alias. */
  distribution_root?: string;
  repository_root?: string;
  state_root: string;
  project_directory: string;
  user_policy_file: string;
  project_policy_file: string;
  route_profile_file: string;
  runtime_mode?: "synthetic" | "pilot";
  evidence_root?: string;
  worktree_root?: string;
  fixture_root?: string;
  hidden_root?: string;
  quality_policy_file?: string;
  quality_catalog_file?: string;
}

export interface McpRegistrationPreview {
  server_name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  enabled_tools: readonly string[];
  forwarded_environment_variables: readonly string[];
  toml_block: string;
  config_diff_preview: string;
  block_sha256: string;
  entrypoint_sha256?: string;
  rollback: { remove_exact_block_sha256_required: true; restart_required: true };
}

export function buildMcpRegistrationPreview(input: McpRegistrationInput, entrypointSha256?: string): McpRegistrationPreview {
  identifier(input.server_name, "server_name");
  const distributionInput = input.distribution_root ?? input.repository_root;
  if (!distributionInput) throw new Error("distribution_root is required");
  for (const [field, value] of Object.entries(input).filter(([field, value]) => !["server_name", "runtime_mode"].includes(field) && value !== undefined)) absolute(value, field);
  if (input.distribution_root && input.repository_root && path.resolve(input.distribution_root) !== path.resolve(input.repository_root)) throw new Error("distribution_root conflicts with deprecated repository_root");
  if (entrypointSha256 !== undefined && !/^[a-f0-9]{64}$/.test(entrypointSha256)) throw new Error("entrypoint_sha256 must be a SHA-256 digest");
  const distribution = path.resolve(distributionInput); const state = path.resolve(input.state_root);
  const mode = input.runtime_mode ?? "synthetic";
  if (mode === "pilot" && (!input.evidence_root || !input.worktree_root || !input.fixture_root || !input.hidden_root || !input.quality_policy_file || !input.quality_catalog_file)) throw new Error("Pilot MCP registration requires explicit evidence, worktree, fixture, hidden, quality-policy, and catalog paths");
  if (within(state, distribution) || within(distribution, state)) throw new Error("Router state_root must be outside the distribution");
  const entry = path.join(distribution, "dist", "src", "mcp.js");
  const args = [entry, "--mode", mode, "--project", path.resolve(input.project_directory), "--state-root", state,
    ...(input.evidence_root ? ["--evidence-root", path.resolve(input.evidence_root)] : []), ...(input.worktree_root ? ["--worktree-root", path.resolve(input.worktree_root)] : []),
    ...(input.fixture_root ? ["--fixture-root", path.resolve(input.fixture_root)] : []), ...(input.hidden_root ? ["--hidden-root", path.resolve(input.hidden_root)] : []),
    ...(input.quality_policy_file ? ["--quality-policy", path.resolve(input.quality_policy_file)] : []), ...(input.quality_catalog_file ? ["--quality-catalog", path.resolve(input.quality_catalog_file)] : []),
    "--user-policy", path.resolve(input.user_policy_file), "--project-policy", path.resolve(input.project_policy_file), "--route-profile", path.resolve(input.route_profile_file)];
  const lines = [
    `[mcp_servers.${input.server_name}]`,
    `command = ${toml(input.node_executable)}`,
    `args = [${args.map(toml).join(", ")}]`,
    `cwd = ${toml(distribution)}`,
    `enabled_tools = [${ROUTER_MCP_TOOL_NAMES.map(toml).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 300",
  ];
  const toml_block = `${lines.join("\n")}\n`;
  const block_sha256 = createHash("sha256").update(toml_block, "utf8").digest("hex");
  return Object.freeze({
    server_name: input.server_name, command: path.resolve(input.node_executable), args: Object.freeze(args), cwd: distribution,
    enabled_tools: ROUTER_MCP_TOOL_NAMES, forwarded_environment_variables: Object.freeze([]), toml_block,
    config_diff_preview: `+${lines.join("\n+")}\n`, block_sha256, entrypoint_sha256: entrypointSha256,
    rollback: Object.freeze({ remove_exact_block_sha256_required: true as const, restart_required: true as const }),
  });
}

export function restrictMcpProcessEnvironment(environment: NodeJS.ProcessEnv): void {
  const allowed = new Set<string>(ROUTER_MCP_ENVIRONMENT_ALLOWLIST.map(key => key.toUpperCase()));
  for (const key of Object.keys(environment)) if (!allowed.has(key.toUpperCase())) delete environment[key];
}

function toml(value: string): string { return JSON.stringify(value); }
function absolute(value: string, name: string): void { if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${name} must be an absolute path`); }
function identifier(value: string, name: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error(`${name} must be a safe TOML identifier`); }
function within(candidate: string, parent: string): boolean { const relative = path.relative(parent, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
