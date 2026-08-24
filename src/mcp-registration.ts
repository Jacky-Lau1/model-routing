import path from "node:path";

export const ROUTER_MCP_TOOL_NAMES = ["router.prepare", "router.execute", "router.status", "router.abort", "router.review_evidence", "router.finalize", "router.repair", "router.apply"] as const;
export const ROUTER_MCP_ENVIRONMENT_ALLOWLIST = ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "LOCALAPPDATA"] as const;

export interface McpRegistrationInput {
  server_name: string;
  node_executable: string;
  repository_root: string;
  state_root: string;
  project_directory: string;
  user_policy_file: string;
  project_policy_file: string;
  route_profile_file: string;
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
  rollback: { remove_exact_block_sha256_required: true; restart_required: true };
}

export function buildMcpRegistrationPreview(input: McpRegistrationInput): McpRegistrationPreview {
  identifier(input.server_name, "server_name");
  for (const [field, value] of Object.entries(input).filter(([field]) => field !== "server_name")) absolute(value, field);
  const repository = path.resolve(input.repository_root); const state = path.resolve(input.state_root);
  if (within(state, repository) || within(repository, state)) throw new Error("Router state_root must be outside the repository");
  const entry = path.join(repository, "src", "mcp.ts");
  const args = ["--import", "tsx", entry, "--project", path.resolve(input.project_directory), "--state-root", state, "--user-policy", path.resolve(input.user_policy_file), "--project-policy", path.resolve(input.project_policy_file), "--route-profile", path.resolve(input.route_profile_file)];
  const lines = [
    `[mcp_servers.${input.server_name}]`,
    `command = ${toml(input.node_executable)}`,
    `args = [${args.map(toml).join(", ")}]`,
    `cwd = ${toml(repository)}`,
    `enabled_tools = [${ROUTER_MCP_TOOL_NAMES.map(toml).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 300",
  ];
  const toml_block = `${lines.join("\n")}\n`;
  return Object.freeze({
    server_name: input.server_name, command: path.resolve(input.node_executable), args: Object.freeze(args), cwd: repository,
    enabled_tools: ROUTER_MCP_TOOL_NAMES, forwarded_environment_variables: Object.freeze([]), toml_block,
    config_diff_preview: `+${lines.join("\n+")}\n`, rollback: Object.freeze({ remove_exact_block_sha256_required: true as const, restart_required: true as const }),
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
