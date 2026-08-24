import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { rmrf } from "./fs-test-utils.js";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRouterCoreFromFiles, type RouterRuntimeFileOptions } from "../src/router-runtime.js";
import { canonicalFixture } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rmrf(root))));

describe("structured Router CLI", () => {
  it("serializes the same compact core status without provider or Codex configuration access", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const config = path.join(fixture.root, "runtime-inputs"); const cliState = path.join(fixture.root, "cli-state"); const evidence = path.join(fixture.root, "cli-evidence"); const worktrees = path.join(fixture.root, "cli-worktrees"); const visible = path.join(fixture.root, "cli-visible-fixture"); const hidden = path.join(fixture.root, "cli-private-hidden");
    await Promise.all([config, evidence, worktrees, visible, hidden].map(directory => mkdir(directory)));
    const files = { task: path.join(config, "task.json"), user: path.join(config, "user.json"), project: path.join(config, "project.json"), route: path.join(config, "route.json"), qualityPolicy: path.join(config, "quality-policy.json"), qualityCatalog: path.join(config, "quality-catalog.json") };
    await Promise.all([writeFile(files.task, JSON.stringify(fixture.task)), writeFile(files.user, JSON.stringify(fixture.userPolicy)), writeFile(files.project, JSON.stringify(fixture.projectPolicy)), writeFile(files.route, JSON.stringify(fixture.routeProfile))]);
    await Promise.all([copyFile(path.resolve("config/quality-gate-policy.pilot.example.json"), files.qualityPolicy), copyFile(path.resolve("config/trusted-quality-command-catalog.example.json"), files.qualityCatalog)]);
    const runtime: RouterRuntimeFileOptions = { project: fixture.project, stateRoot: cliState, evidenceRoot: evidence, worktreeRoot: worktrees, fixtureRoot: visible, hiddenRoot: hidden, qualityPolicy: files.qualityPolicy, qualityCatalog: files.qualityCatalog, mode: "pilot", userPolicy: files.user, projectPolicy: files.project, routeProfile: files.route };
    const result = await runCli(["router", "prepare", files.task, "--project", runtime.project, "--state-root", runtime.stateRoot, "--evidence-root", runtime.evidenceRoot!, "--worktree-root", runtime.worktreeRoot!, "--fixture-root", runtime.fixtureRoot!, "--hidden-root", runtime.hiddenRoot!, "--quality-policy", runtime.qualityPolicy!, "--quality-catalog", runtime.qualityCatalog!, "--user-policy", runtime.userPolicy, "--project-policy", runtime.projectPolicy, "--route-profile", runtime.routeProfile]);
    expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe("");
    const cliStatus = JSON.parse(result.stdout.trim());
    const core = await createRouterCoreFromFiles(runtime, { model_adapter: fixture.model });
    expect(cliStatus).toEqual(await core.status(fixture.task.task_id));
    expect(cliStatus).toMatchObject({ state: "AWAITING_APPROVAL", next: "execute" });
    expect(fixture.model.sends).toBe(0);
  });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/cli.ts"), ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: {} });
  let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, "close") as [number]; return { code, stdout, stderr };
}
