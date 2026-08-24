import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { rmrf } from "./fs-test-utils.js";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertAllowedChanges, changedSince, snapshotWorkingTree, type ScopeSnapshot } from "../src/scope-guard.js";

describe("scope guard", () => {
  it("detects content changes including pre-existing dirty files", () => {
    const before: ScopeSnapshot = new Map([["src/a.ts", "old"]]);
    const after: ScopeSnapshot = new Map([["src/a.ts", "new"]]);
    expect(changedSince(before, after)).toEqual(["src/a.ts"]);
    expect(() => assertAllowedChanges(before, after, ["src/a.ts"])).not.toThrow();
    expect(() => assertAllowedChanges(before, after, ["src/b.ts"])).toThrow(/outside approved scope/);
  });
  it("supports bounded glob patterns", () => {
    expect(() => assertAllowedChanges(new Map(), new Map([["src/lib/a.ts", "x"]]), ["src/**/*.ts"])).not.toThrow();
  });
  it("refuses an untracked symlink before reading its out-of-worktree target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "router-scope-"));
    try {
      const repo = path.join(root, "repo"); const outside = path.join(root, "outside.txt"); await mkdir(repo); await writeFile(path.join(repo, "base.txt"), "base\n"); await writeFile(outside, "api_key=synthetic-outside-secret\n");
      await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.name", "Synthetic Test"]); await git(repo, ["config", "user.email", "synthetic@example.invalid"]); await git(repo, ["add", "--", "base.txt"]); await git(repo, ["commit", "-m", "base"]);
      try { await symlink(outside, path.join(repo, "linked.txt"), "file"); } catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
      // Windows can silently materialize an empty file instead of a real
      // reparse point when the process lacks the "Create Symbolic Links"
      // privilege, so only assert when a genuine symlink was produced.
      if (process.platform === "win32" && !(await lstat(path.join(repo, "linked.txt"))).isSymbolicLink()) return;
      await expect(snapshotWorkingTree(repo)).rejects.toThrow(/symlink|reparse/);
    } finally { await rmrf(root); }
  });
  it("refuses assume-unchanged tracked files before snapshotting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "router-scope-index-"));
    try { await writeFile(path.join(root, "tracked.txt"), "base\n"); await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Synthetic Test"]); await git(root, ["config", "user.email", "synthetic@example.invalid"]); await git(root, ["add", "--", "tracked.txt"]); await git(root, ["commit", "-m", "base"]); await git(root, ["update-index", "--assume-unchanged", "tracked.txt"]); await writeFile(path.join(root, "tracked.txt"), "hidden change\n"); await expect(snapshotWorkingTree(root)).rejects.toThrow(/nonstandard Git index flags/); }
    finally { await rmrf(root); }
  });
});

async function git(cwd: string, args: string[]): Promise<void> { const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; }); const [code] = await once(child, "close") as [number | null]; if (code !== 0) throw new Error(stderr); }
