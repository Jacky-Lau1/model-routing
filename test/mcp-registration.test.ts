import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmrf } from "./fs-test-utils.js";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpRegistrationPreview, restrictMcpProcessEnvironment, ROUTER_MCP_TOOL_NAMES } from "../src/mcp-registration.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rmrf(root))));

describe("temporary auditable Codex MCP registration", () => {
  it("previews an exact reversible block with no provider, model, auth, or inherited environment configuration", async () => {
    const fixture = await registrationFixture();
    expect(fixture.preview.forwarded_environment_variables).toEqual([]);
    expect(fixture.preview.enabled_tools).toEqual(ROUTER_MCP_TOOL_NAMES);
    expect(fixture.preview.toml_block).not.toMatch(/\benv(?:_vars)?\s*=|auth\.json|model_provider\s*=|\[model_providers\./i);
    expect(fixture.preview.config_diff_preview.split("\n").filter(Boolean).every(line => line.startsWith("+"))).toBe(true);
    expect(fixture.preview.rollback).toEqual({ remove_exact_block_sha256_required: true, restart_required: true });
  });

  it("discovers exactly nine router tools through a temporary Codex-home/config without touching auth.json", async () => {
    const fixture = await registrationFixture(); const config = path.join(fixture.codexHome, "config.toml"); const auth = path.join(fixture.codexHome, "auth.json");
    await writeFile(config, fixture.preview.toml_block, "utf8"); await writeFile(auth, "synthetic-auth-sentinel\n", "utf8");
    const beforeConfig = await digest(config); const beforeAuth = await digest(auth);
    const responses = await stdioDiscovery(fixture.preview.command, fixture.preview.args, fixture.preview.cwd, fixture.root);
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "codex-model-router" } } });
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(ROUTER_MCP_TOOL_NAMES);
    expect(await digest(config)).toBe(beforeConfig); expect(await digest(auth)).toBe(beforeAuth);
    expect(await readFile(auth, "utf8")).toBe("synthetic-auth-sentinel\n");
  });

  it("rejects a Router state root inside the repository", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    expect(() => buildMcpRegistrationPreview({ server_name: "codex_router", node_executable: process.execPath, repository_root: root, state_root: path.join(root, ".state"), project_directory: root, user_policy_file: path.join(root, "config/user-policy.example.json"), project_policy_file: path.join(root, "config/project-policy.example.json"), route_profile_file: path.join(root, "config/router-route-profile.example.json") })).toThrow(/outside/);
  });

  it("drops credential-bearing inherited variables while preserving the fixed runtime allowlist", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "synthetic-path", SystemRoot: "C:\\Windows", DEEPSEEK_API_KEY: "synthetic-never-read", CODEX_HOME: "synthetic-codex-home", UNRELATED: "synthetic" };
    restrictMcpProcessEnvironment(environment);
    expect(environment).toEqual({ PATH: "synthetic-path", SystemRoot: "C:\\Windows" });
  });
});

async function registrationFixture() {
  const repository = path.resolve(import.meta.dirname, ".."); const root = await mkdtemp(path.join(os.tmpdir(), "router-mcp-registration-")); roots.push(root);
  const codexHome = path.join(root, "codex-home"); const project = path.join(root, "fixture-project"); const state = path.join(root, "router-state"); const runtime = path.join(root, "runtime");
  await Promise.all([mkdir(codexHome), mkdir(project), mkdir(state), mkdir(runtime)]);
  for (const file of ["user-policy.example.json", "project-policy.example.json", "router-route-profile.example.json"]) await copyFile(path.join(repository, "config", file), path.join(runtime, file));
  const preview = buildMcpRegistrationPreview({ server_name: "codex_router", node_executable: process.execPath, repository_root: repository, state_root: state, project_directory: project, user_policy_file: path.join(runtime, "user-policy.example.json"), project_policy_file: path.join(runtime, "project-policy.example.json"), route_profile_file: path.join(runtime, "router-route-profile.example.json") });
  return { root, codexHome, preview };
}

async function stdioDiscovery(command: string, args: readonly string[], cwd: string, temp: string): Promise<any[]> {
  const safeEnvironment: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: temp, TMP: temp };
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: safeEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.on("error", reject);
    child.on("close", code => { if (code !== 0) reject(new Error(`Synthetic MCP discovery exited ${code}: ${stderr}`)); else resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

async function digest(file: string): Promise<string> { return createHash("sha256").update(await readFile(file)).digest("hex"); }
