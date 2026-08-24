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
  it("refuses an untracked symlink/junction before reading its out-of-worktree target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "router-scope-"));
    try {
      const repo = path.join(root, "repo"); await mkdir(repo); await writeFile(path.join(repo, "base.txt"), "base\n");
      const outside = path.join(root, "outside-dir"); await mkdir(outside); await writeFile(path.join(outside, "data.txt"), "api_key=synthetic-outside-secret\n");
      await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.name", "Synthetic Test"]); await git(repo, ["config", "user.email", "synthetic@example.invalid"]); await git(repo, ["add", "--", "base.txt"]); await git(repo, ["commit", "-m", "base"]);
      // A file symlink needs the "Create Symbolic Links" privilege on Windows
      // and silently degrades to an empty file without it. A directory junction
      // needs no privilege and is still a reparse point, so it exercises the
      // same out-of-worktree guard without elevation.
      const link = path.join(repo, "linked");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      if (process.platform === "win32" && !(await lstat(link)).isSymbolicLink()) return;
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
