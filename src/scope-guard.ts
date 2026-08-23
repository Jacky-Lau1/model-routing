import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export type ScopeSnapshot = Map<string, string>;

export async function snapshotWorkingTree(directory: string): Promise<ScopeSnapshot> {
  const requestedRoot = path.resolve(directory); const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Scope snapshot root must be a physical directory");
  const root = await realpath(requestedRoot);
  const indexFlags = nonstandardGitIndexPaths(await git(root, ["ls-files", "-v", "-z"]));
  if (indexFlags.length) throw new Error(`Scope snapshot refused nonstandard Git index flags: ${indexFlags.join(", ")}`);
  const tracked = await git(root, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", "-z", "HEAD"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  const ignoredPaths = ignored.split("\0").filter(Boolean).map(normalize);
  if (ignoredPaths.length) throw new Error(`Scope snapshot cannot freeze ignored paths without reading them: ${ignoredPaths.join(", ")}`);
  const files = new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean).map(normalize));
  const snapshot: ScopeSnapshot = new Map();
  for (const file of files) snapshot.set(file, await hashFile(root, file));
  return snapshot;
}

export function hashScopeSnapshot(snapshot: ScopeSnapshot): string {
  return createHash("sha256").update(JSON.stringify([...snapshot].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
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
  // Approval scopes are canonical, case-sensitive strings on every platform.
  // This fails closed for a not-yet-existing Windows leaf whose on-disk case
  // cannot otherwise be compared physically.
  return new RegExp(`^${escaped}$`).test(file);
}
function normalize(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, ""); }
const SENSITIVE_PATH = /(?:^|\/)(?:\.git|\.codex|\.ssh|\.aws|\.azure)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.envrc|credentials?(?:\..*)?|api[-_]?key(?:\..*)?|private[-_]?key(?:\..*)?|password(?:\..*)?|secret(?:\..*)?|token(?:\..*)?)(?:$|\/)/i;
export function isForbiddenQualityPath(relative: string): boolean { return SENSITIVE_PATH.test(relative); }
export function nonstandardGitIndexPaths(output: string): string[] { return output.split("\0").filter(Boolean).filter(entry => entry.length < 3 || entry[0] !== "H" || entry[1] !== " ").map(entry => normalize(entry.slice(2))).sort(); }
async function hashFile(root: string, relative: string): Promise<string> {
  return hashContainedFile(root, relative);
}
export async function hashContainedFile(root: string, relative: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  if (isForbiddenQualityPath(relative)) throw new Error(`Scope snapshot refused a sensitive path: ${relative}`);
  const opened = await openContained(root, relative);
  if (opened === null) return "<missing>";
  const { handle, identity } = opened;
  try {
    const bytes = identity.size > maxBytes ? undefined : await handle.readFile(); const after = await lstat(path.join(root, relative));
    if (after.isSymbolicLink() || after.dev !== identity.dev || after.ino !== identity.ino || after.size !== identity.size || after.mtimeMs !== identity.mtimeMs) throw new Error(`Scope snapshot path changed during read: ${relative}`);
    return createHash("sha256").update(bytes ?? JSON.stringify({ oversized: true, size: identity.size, mtime_ms: identity.mtimeMs })).digest("hex");
  } finally { await handle.close(); }
}
async function openContained(root: string, relative: string, requireFile = true): Promise<{ handle: Awaited<ReturnType<typeof open>>; identity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>> } | null> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment); let info;
    try { info = await lstat(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Scope snapshot refused a symlink or reparse path: ${relative}`);
    if (!isWithin(root, await realpath(current))) throw new Error(`Scope snapshot path escaped the worktree: ${relative}`);
  }
  const before = await lstat(current);
  if (requireFile && !before.isFile()) throw new Error(`Scope snapshot path is not a regular file: ${relative}`);
  const handle = await open(current, "r"); const identity = await handle.stat(); const openedPhysical = await realpath(current);
  if (!isWithin(root, openedPhysical) || (requireFile && !identity.isFile()) || identity.dev !== before.dev || identity.ino !== before.ino) { await handle.close(); throw new Error(`Scope snapshot path changed during open: ${relative}`); }
  return { handle, identity };
}
function isWithin(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
async function git(directory: string, args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd: directory, windowsHide: true, env: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let overflowed = false; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const append = (current: string, chunk: unknown) => { const next = current + String(chunk); if (Buffer.byteLength(next) > 16 * 1024 * 1024) { overflowed = true; try { child.kill("SIGKILL"); } catch {} return current; } return next; };
  child.stdout.on("data", chunk => { stdout = append(stdout, chunk); }); child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
  const [code] = await once(child, "close") as [number | null];
  clearTimeout(timer); if (code !== 0 || overflowed) throw new Error(`Target project must be a bounded readable Git worktree: ${stderr.trim()}`);
  return stdout;
}
