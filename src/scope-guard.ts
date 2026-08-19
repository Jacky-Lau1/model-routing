import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export type ScopeSnapshot = Map<string, string>;

export async function snapshotWorkingTree(directory: string): Promise<ScopeSnapshot> {
  const tracked = await git(directory, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean).map(normalize));
  const snapshot: ScopeSnapshot = new Map();
  for (const file of files) snapshot.set(file, await hashFile(path.join(directory, file)));
  return snapshot;
}

export function changedSince(before: ScopeSnapshot, after: ScopeSnapshot): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter(file => before.get(file) !== after.get(file)).sort();
}

export function assertAllowedChanges(before: ScopeSnapshot, after: ScopeSnapshot, allowed: string[]): void {
  const changed = changedSince(before, after);
  const violations = changed.filter(file => !isAllowedPath(file, allowed));
  if (violations.length) throw new Error(`Executor changed files outside approved scope: ${violations.join(", ")}`);
}

export function isAllowedPath(file: string, allowed: string[]): boolean { return allowed.some(pattern => matches(file, pattern)); }

function matches(file: string, pattern: string): boolean {
  const normalized = normalize(pattern);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(file);
}
function normalize(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, ""); }
async function hashFile(file: string): Promise<string> { try { return createHash("sha256").update(await readFile(file)).digest("hex"); } catch { return "<missing>"; } }
async function git(directory: string, args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null];
  if (code !== 0) throw new Error(`Target project must be a readable Git worktree: ${stderr.trim()}`);
  return stdout;
}
