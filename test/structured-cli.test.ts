import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalValidationAdapter } from "../src/providers/local.js";
import { DEFAULT_QUALITY_GATE_POLICY } from "../src/quality-gate.js";
import { createRouterCoreFromFiles, type RouterRuntimeFileOptions } from "../src/router-runtime.js";
import { canonicalFixture } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("structured Router CLI", () => {
  it("serializes the same compact core status without provider or Codex configuration access", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const config = path.join(fixture.root, "runtime-inputs"); const cliState = path.join(fixture.root, "cli-state");
    await mkdir(config);
    const files = { task: path.join(config, "task.json"), user: path.join(config, "user.json"), project: path.join(config, "project.json"), route: path.join(config, "route.json") };
    await Promise.all([writeFile(files.task, JSON.stringify(fixture.task)), writeFile(files.user, JSON.stringify(fixture.userPolicy)), writeFile(files.project, JSON.stringify(fixture.projectPolicy)), writeFile(files.route, JSON.stringify(fixture.routeProfile))]);
    const runtime: RouterRuntimeFileOptions = { project: fixture.project, stateRoot: cliState, userPolicy: files.user, projectPolicy: files.project, routeProfile: files.route };
    const result = await runCli(["router", "prepare", files.task, "--project", runtime.project, "--state-root", runtime.stateRoot, "--user-policy", runtime.userPolicy, "--project-policy", runtime.projectPolicy, "--route-profile", runtime.routeProfile]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const cliStatus = JSON.parse(result.stdout.trim());
    const core = await createRouterCoreFromFiles(runtime, { model_adapter: fixture.model, local_adapter: new LocalValidationAdapter({ policy: DEFAULT_QUALITY_GATE_POLICY, evidenceRoot: cliState }) });
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
