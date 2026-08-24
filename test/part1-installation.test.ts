import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRICING_CATALOG } from "../src/cost.js";
import { credentialStatus, runDoctor, validateRoots, verifyPricing } from "../src/doctor.js";
import { createDistributionManifest, verifyDistributionManifest } from "../src/distribution.js";
import { applyExplicitInstallationPlan, buildInstallPreview, buildUninstallPreview } from "../src/installation.js";
import { buildMcpRegistrationPreview } from "../src/mcp-registration.js";

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map(root => rmrf(root))));

describe("Part 1 offline distribution and reversible installation", () => {
  it("previews a compiled MCP entrypoint without tsx, repository cwd, or inherited credentials", async () => {
    const fixture = await createFixture();
    expect(fixture.registration.args[0]).toBe(path.join(fixture.distribution, "dist", "src", "mcp.js"));
    expect(fixture.registration.args).not.toContain("tsx");
    expect(fixture.registration.cwd).toBe(fixture.distribution);
    expect(fixture.registration.toml_block).not.toMatch(/--import|tsx|auth\.json|model_provider/i);
    expect(await readFile(path.resolve(import.meta.dirname, "../src/mcp-registration.ts"), "utf8")).not.toMatch(/[A-Z]:\\Users\\|OneDrive|codex-primary-runtime/i);
    expect(fixture.registration.forwarded_environment_variables).toEqual([]);
  });

  it("discovers tools from an external production distribution with only production dependencies", async () => {
    const fixture = await createFixture(); const repository = path.resolve(import.meta.dirname, "..");
    await rm(path.join(fixture.distribution, "dist"), { recursive: true, force: true });
    await cp(path.join(repository, "dist", "src"), path.join(fixture.distribution, "dist", "src"), { recursive: true });
    const commander = await realpath(path.join(repository, "node_modules", "commander"));
    await cp(commander, path.join(fixture.distribution, "node_modules", "commander"), { recursive: true });
    await writeFile(path.join(fixture.distribution, "package.json"), '{"type":"module","dependencies":{"commander":"^14.0.0"}}\n', "utf8");
    const responses = await discover(fixture.registration.command, fixture.registration.args, fixture.registration.cwd, fixture.root);
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "codex-model-router" } } });
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(fixture.registration.enabled_tools);
    expect(fixture.registration.cwd.startsWith(repository)).toBe(false);
  });

  it("completes install, discovery evidence, doctor, and exact rollback in an explicit temporary Codex home", async () => {
    const fixture = await createFixture();
    const install = buildInstallPreview({ config_path: fixture.config, current_config: "", registration: fixture.registration });
    expect(install.dry_run).toBe(true); expect(install.target).toBe(fixture.config);
    expect(install.rollback.remove_exact_managed_block_sha256).toBe(install.managed_block_sha256);
    await applyExplicitInstallationPlan(install);
    const installed = await readFile(fixture.config, "utf8");
    expect(installed).toContain("[mcp_servers.codex_router]");

    const snapshot = sha256("synthetic-main-snapshot");
    const report = await runDoctor({
      roots: fixture.roots, distribution_manifest: fixture.manifest,
      bound_json_files: await doctorBindings(fixture),
      pricing_catalog: PRICING_CATALOG, now: new Date("2026-08-24T08:00:00.000Z"),
      credential_status: { required_aliases: ["synthetic-alias"], available_aliases: ["synthetic-alias"] },
      registration: fixture.registration, install_preview: install, current_config: installed,
      approved_main_workspace_snapshot: snapshot, observed_main_workspace_snapshot: snapshot,
    });
    expect(report).toMatchObject({ passed: true, offline_only: true, credential_values_read: false, provider_requests: 0 });
    expect(report.checks.every(check => check.passed)).toBe(true);

    const uninstall = buildUninstallPreview({ config_path: fixture.config, current_config: installed, server_name: "codex_router", expected_managed_block: install.managed_block, expected_managed_block_sha256: install.managed_block_sha256 });
    await applyExplicitInstallationPlan(uninstall);
    expect(await readFile(fixture.config, "utf8")).toBe("");
  });

  it("refuses uninstall when the exact hash-matched managed block has drifted", async () => {
    const fixture = await createFixture();
    const install = buildInstallPreview({ config_path: fixture.config, current_config: "", registration: fixture.registration });
    const drifted = install.config_after.replace("tool_timeout_sec = 300", "tool_timeout_sec = 301");
    expect(() => buildUninstallPreview({ config_path: fixture.config, current_config: drifted, server_name: "codex_router", expected_managed_block: install.managed_block, expected_managed_block_sha256: install.managed_block_sha256 })).toThrow(/drifted/);
  });

  it("preserves auth, provider, model, profile, and unrelated MCP configuration byte-for-byte", async () => {
    const fixture = await createFixture();
    const existing = '[model_providers.existing]\nname = "untouched"\nmodel = "untouched"\nauth = "untouched"\nprofile = "untouched"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const install = buildInstallPreview({ config_path: fixture.config, current_config: existing, registration: fixture.registration });
    expect(install.config_after.startsWith(existing)).toBe(true);
    const uninstall = buildUninstallPreview({ config_path: fixture.config, current_config: install.config_after, server_name: "codex_router", expected_managed_block: install.managed_block, expected_managed_block_sha256: install.managed_block_sha256 });
    expect(uninstall.config_after).toBe(existing);
  });

  it("fails closed for overlapping roots, corrupted JSON, stale pricing, build tamper, and snapshot mismatch", async () => {
    const fixture = await createFixture(); const install = buildInstallPreview({ config_path: fixture.config, current_config: "", registration: fixture.registration });
    expect(validateRoots({ ...fixture.roots, evidence_root: path.join(fixture.roots.state_root, "evidence") })).toContain("overlap:state_root:evidence_root");
    expect(verifyPricing(PRICING_CATALOG, new Date("2026-09-24T00:00:00.000Z")).passed).toBe(false);
    await writeFile(path.join(fixture.distribution, "dist", "src", "mcp.js"), "tampered\n", "utf8");
    expect((await verifyDistributionManifest(fixture.distribution, fixture.manifest)).passed).toBe(false);
    await writeFile(fixture.schema, "{broken", "utf8");
    const installed = install.config_after; const snapshot = sha256("approved");
    const report = await runDoctor({
      roots: fixture.roots, distribution_manifest: fixture.manifest,
      bound_json_files: [{ path: fixture.schema, expected_sha256: sha256("{broken"), kind: "schema" }, ...(await doctorBindings(fixture)).filter(file => file.kind !== "schema")],
      pricing_catalog: PRICING_CATALOG, now: new Date("2026-08-24T08:00:00.000Z"), credential_status: { required_aliases: ["missing-alias"], available_aliases: [] },
      registration: fixture.registration, install_preview: install, current_config: installed,
      approved_main_workspace_snapshot: snapshot, observed_main_workspace_snapshot: sha256("changed"), state_writable: () => false,
    });
    expect(report.passed).toBe(false);
    expect(report.checks.filter(check => !check.passed).map(check => check.id)).toEqual(expect.arrayContaining(["build_hash", "schema_policy_catalog", "credential_aliases", "state_writable", "main_workspace_snapshot"]));
  });

  it("reports alias names only and never accepts or returns credential values", () => {
    expect(credentialStatus({ required_aliases: ["deepseek-env", "codex-cli-managed"], available_aliases: ["codex-cli-managed"] })).toEqual([
      { alias: "deepseek-env", available: false, source: "caller_attested_alias_presence", secret_read: false },
      { alias: "codex-cli-managed", available: true, source: "caller_attested_alias_presence", secret_read: false },
    ]);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-part1-install-")); temporaryRoots.push(root);
  const distribution = path.join(root, "distribution"); const project = path.join(root, "project"); const state = path.join(root, "state");
  const worktree = path.join(root, "worktree"); const evidence = path.join(root, "evidence"); const visibleFixture = path.join(root, "visible-fixture"); const hidden = path.join(root, "private-hidden"); const codexHome = path.join(root, "codex-home");
  await Promise.all([distribution, project, state, worktree, evidence, visibleFixture, hidden, codexHome, path.join(distribution, "dist", "src"), path.join(distribution, "runtime")].map(directory => mkdir(directory, { recursive: true })));
  const entrypoint = path.join(distribution, "dist", "src", "mcp.js"); const schema = path.join(distribution, "runtime", "schema.json");
  await writeFile(entrypoint, "#!/usr/bin/env node\n", "utf8"); await writeFile(schema, '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}\n', "utf8");
  const runtimeFiles = ["user-policy.json", "project-policy.json", "route-profile.json", "pricing-catalog.json", "quality-policy.json", "quality-catalog.json"];
  const sourceFiles = ["user-policy.example.json", "project-policy.example.json", "router-route-profile.example.json", "pricing-catalog.example.json", "quality-gate-policy.pilot.example.json", "trusted-quality-command-catalog.example.json"];
  const repository = path.resolve(import.meta.dirname, "..");
  await Promise.all(runtimeFiles.map((file, index) => copyFile(path.join(repository, "config", sourceFiles[index]), path.join(distribution, "runtime", file))));
  const manifest = await createDistributionManifest(distribution, ["dist/src/mcp.js", "runtime/schema.json"]);
  const registration = buildMcpRegistrationPreview({ server_name: "codex_router", node_executable: process.execPath, distribution_root: distribution, runtime_mode: "pilot", state_root: state, evidence_root: evidence, worktree_root: worktree, fixture_root: visibleFixture, hidden_root: hidden, quality_policy_file: path.join(distribution, "runtime", runtimeFiles[4]), quality_catalog_file: path.join(distribution, "runtime", runtimeFiles[5]), project_directory: project, user_policy_file: path.join(distribution, "runtime", runtimeFiles[0]), project_policy_file: path.join(distribution, "runtime", runtimeFiles[1]), route_profile_file: path.join(distribution, "runtime", runtimeFiles[2]) }, manifest.files[0].sha256);
  return { root, distribution, config: path.join(codexHome, "config.toml"), schema, policies: runtimeFiles.slice(0, 2).map(file => path.join(distribution, "runtime", file)), catalog: path.join(distribution, "runtime", runtimeFiles[3]), manifest, registration, roots: { distribution_root: distribution, project_root: project, state_root: state, worktree_root: worktree, evidence_root: evidence } };
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

// Windows fs.rm({ recursive: true }) can hang indefinitely on freshly copied
// trees (antivirus/OneDrive handle contention). A manual readdir+unlink+rmdir
// walk completes reliably, so all temporary-root cleanup uses it instead.
async function rmrf(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await rmrf(target);
    else await rm(target, { force: true }).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}
async function fileHash(file: string): Promise<string> { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function doctorBindings(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return [
    { path: fixture.schema, expected_sha256: await fileHash(fixture.schema), kind: "schema" as const },
    ...(await Promise.all(fixture.policies.map(async policy => ({ path: policy, expected_sha256: await fileHash(policy), kind: "policy" as const })))),
    { path: fixture.catalog, expected_sha256: await fileHash(fixture.catalog), kind: "catalog" as const },
  ];
}

async function discover(command: string, args: readonly string[], cwd: string, temp: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: temp, TMP: temp }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const settle = () => { settled = true; clearTimeout(timer); };
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill(); reject(new Error(`External MCP discovery timed out after 25s: ${stderr}`)); }, 25_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { if (settled) return; settle(); reject(error); });
    child.on("close", code => { if (settled) return; settle(); if (code === 0) resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); else reject(new Error(`External MCP discovery exited ${code}: ${stderr}`)); });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}
