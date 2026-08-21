import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stableHash } from "./canonical.js";
import { assertSafeRelativePath } from "./contracts.js";
import { atomicRenameWithLocalRetry } from "./attempt-persistence.js";
import type { WorkspaceDirtyEvidence } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const WORKTREE_LOCKS = new Map<string, Promise<void>>();

export type WorktreeLifecycleState = "PREPARING" | "READY" | "RETAINED" | "REMOVING" | "BLOCKED" | "REMOVED";
export type WorktreeCheckpoint = "PREPARING" | "GIT_ADDED" | "READY";
export type WorktreeCleanupCheckpoint = "REMOVING" | "GIT_REMOVED" | "REMOVED";

export interface DirtyPathDetail extends WorkspaceDirtyEvidence {
  original_path: string | null;
}

export interface WorkspaceBaseline {
  repository_id: string;
  base_commit: string;
  head_ref: string;
  index_hash: string;
  dirty_details: DirtyPathDetail[];
  main_workspace_dirty_evidence: WorkspaceDirtyEvidence[];
  main_workspace_snapshot: string;
}

export interface WorktreeBinding {
  run_id: string;
  worktree_id: string;
  repository_id: string;
  base_commit: string;
  main_workspace_snapshot: string;
  main_workspace_dirty_evidence: WorkspaceDirtyEvidence[];
  plan_hash: string;
  isolation_hash: string;
}

export interface WorktreeRecord extends WorktreeBinding {
  version: 1;
  state: WorktreeLifecycleState;
  created_at: string;
  updated_at: string;
  blocked_reason: string | null;
}

export interface WorktreeLease {
  binding: WorktreeBinding;
  record: WorktreeRecord;
  main_directory: string;
  checkout_directory: string;
}

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (directory: string, args: readonly string[]) => Promise<GitCommandResult>;

export interface GitWorktreeManagerOptions {
  stateRoot: string;
  managedRoot?: string;
  runGit?: GitCommandRunner;
  checkpoint?: (checkpoint: WorktreeCheckpoint, record: WorktreeRecord) => void | Promise<void>;
  cleanupCheckpoint?: (checkpoint: WorktreeCleanupCheckpoint, record: WorktreeRecord) => void | Promise<void>;
  now?: () => Date;
}

export class WorktreeIsolationError extends Error {
  constructor(message: string) { super(message); this.name = "WorktreeIsolationError"; }
}

export class MainWorkspaceConflictError extends WorktreeIsolationError {
  constructor() { super("Main workspace changed after the approved isolation baseline"); this.name = "MainWorkspaceConflictError"; }
}

class WorktreeCheckpointInterruption extends Error {
  constructor(readonly original: unknown) { super("Worktree checkpoint interrupted"); }
}

export class GitWorktreeManager {
  readonly stateRoot: string;
  readonly managedRoot: string;
  private readonly git: GitCommandRunner;

  constructor(private readonly options: GitWorktreeManagerOptions) {
    this.stateRoot = path.resolve(options.stateRoot);
    this.managedRoot = path.resolve(options.managedRoot ?? path.join(os.tmpdir(), "codex-model-router-worktrees"));
    this.git = options.runGit ?? defaultGitRunner;
  }

  async captureMainWorkspace(directory: string): Promise<WorkspaceBaseline> {
    try { return await this.captureMainWorkspaceInternal(directory); }
    catch (error) { throw publicIsolationError(error, "Main workspace capture failed closed"); }
  }

  private async captureMainWorkspaceInternal(directory: string): Promise<WorkspaceBaseline> {
    const repository = await this.repository(directory);
    const baseCommit = await this.fullCommit(repository.root, "HEAD");
    const headRefResult = await this.git(repository.root, ["symbolic-ref", "-q", "HEAD"]);
    const headRef = headRefResult.code === 0 ? headRefResult.stdout.trim() : "DETACHED";
    if (headRefResult.code !== 0 && headRefResult.code !== 1) throw new WorktreeIsolationError("Unable to capture the main workspace reference");
    const index = await this.requiredGit(repository.root, ["ls-files", "--stage", "-z"]);
    const status = await this.requiredGit(repository.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirtyDetails = await this.parseDirtyStatus(repository.root, status.stdout);
    const evidence = dirtyDetails.map(({ original_path: _original, ...entry }) => entry);
    const indexHash = sha256(index.stdout);
    const mainWorkspaceSnapshot = stableHash({
      repository_id: repository.id,
      base_commit: baseCommit,
      head_ref: headRef,
      index_hash: indexHash,
      dirty_details: dirtyDetails,
    });
    return {
      repository_id: repository.id,
      base_commit: baseCommit,
      head_ref: headRef,
      index_hash: indexHash,
      dirty_details: dirtyDetails,
      main_workspace_dirty_evidence: evidence,
      main_workspace_snapshot: mainWorkspaceSnapshot,
    };
  }

  createBinding(runId: string, planHash: string, baseline: WorkspaceBaseline): WorktreeBinding {
    assertIdentifier(runId, "run id");
    assertHash(planHash, "plan hash");
    const worktreeId = `worktree-${stableHash({ run_id: runId, repository_id: baseline.repository_id, base_commit: baseline.base_commit, main_workspace_snapshot: baseline.main_workspace_snapshot, plan_hash: planHash }).slice(0, 32)}`;
    const body = {
      run_id: runId,
      worktree_id: worktreeId,
      repository_id: baseline.repository_id,
      base_commit: baseline.base_commit,
      main_workspace_snapshot: baseline.main_workspace_snapshot,
      main_workspace_dirty_evidence: baseline.main_workspace_dirty_evidence,
      plan_hash: planHash,
    };
    return { ...body, isolation_hash: stableHash(body) };
  }

  async assertIsolationRoots(mainDirectory: string): Promise<void> {
    try {
      const repository = await this.repository(mainDirectory);
      await this.assertExternalRoots(repository);
    } catch (error) { throw publicIsolationError(error, "Router isolation root preflight failed closed"); }
  }

  async prepare(mainDirectory: string, binding: WorktreeBinding): Promise<WorktreeLease> {
    assertBinding(binding);
    return this.withWorktreeLock(binding.worktree_id, async () => {
      try { return await this.prepareLocked(mainDirectory, binding); }
      catch (error) { throw publicIsolationError(error, "Worktree preparation failed closed"); }
    });
  }

  private async prepareLocked(mainDirectory: string, binding: WorktreeBinding): Promise<WorktreeLease> {
    assertBinding(binding);
    const repository = await this.repository(mainDirectory);
    await this.assertExternalRoots(repository);
    if (repository.id !== binding.repository_id) throw new WorktreeIsolationError("Isolation binding belongs to a different repository");
    await this.fullCommit(repository.root, binding.base_commit);
    const current = await this.captureMainWorkspace(repository.root);
    if (current.main_workspace_snapshot !== binding.main_workspace_snapshot) throw new MainWorkspaceConflictError();
    const paths = await this.paths(binding.worktree_id);
    const existing = await this.tryReadRecord(binding.worktree_id);
    if (existing) {
      assertRecordMatches(existing, binding);
      if (["READY", "RETAINED"].includes(existing.state)) {
        try { await this.verifyOwnedCheckout(repository, paths, binding, existing.state === "READY"); }
        catch (error) {
          if (existing.state === "READY") await this.saveRecord({ ...existing, state: "BLOCKED", updated_at: this.timestamp(), blocked_reason: safeReason(error) }).catch(() => undefined);
          throw error;
        }
        return { binding, record: existing, main_directory: repository.root, checkout_directory: paths.checkout };
      }
      if (existing.state === "REMOVED") throw new WorktreeIsolationError("A removed worktree id cannot be reused");
      if (existing.state === "REMOVING") throw new WorktreeIsolationError("A removing worktree cannot be prepared");
      if (existing.state === "BLOCKED") throw new WorktreeIsolationError("Worktree lifecycle is blocked and retained for diagnosis");
    }

    const now = this.timestamp();
    let record: WorktreeRecord = existing ?? {
      version: 1,
      ...binding,
      state: "PREPARING",
      created_at: now,
      updated_at: now,
      blocked_reason: null,
    };
    record = await this.saveRecord({ ...record, state: "PREPARING", updated_at: now, blocked_reason: null });
    try {
      await this.observeCheckpoint("PREPARING", record);
      const recovered = await this.tryVerifyOwnedCheckout(repository, paths, binding, true);
      if (!recovered && await pathExists(paths.checkout)) {
        throw new WorktreeIsolationError("Residual worktree failed clean detached recovery checks");
      }
      if (!recovered) {
        await this.ensureOwner(paths, binding);
        const added = await this.git(repository.root, ["worktree", "add", "--detach", paths.checkout, binding.base_commit]);
        if (added.code !== 0) throw new WorktreeIsolationError("Git could not create the isolated worktree");
      }
      await this.observeCheckpoint("GIT_ADDED", record);
      await this.verifyOwnedCheckout(repository, paths, binding, true);
      const after = await this.captureMainWorkspace(repository.root);
      if (after.main_workspace_snapshot !== binding.main_workspace_snapshot) throw new MainWorkspaceConflictError();
      record = await this.saveRecord({ ...record, state: "READY", updated_at: this.timestamp(), blocked_reason: null });
      await this.observeCheckpoint("READY", record);
      return { binding, record, main_directory: repository.root, checkout_directory: paths.checkout };
    } catch (error) {
      if (error instanceof WorktreeCheckpointInterruption) throw error;
      await this.saveRecord({ ...record, state: "BLOCKED", updated_at: this.timestamp(), blocked_reason: safeReason(error) }).catch(() => undefined);
      throw error instanceof WorktreeIsolationError ? error : new WorktreeIsolationError("Worktree preparation failed closed");
    }
  }

  async assertMainWorkspaceUnchanged(lease: WorktreeLease): Promise<void> {
    const current = await this.captureMainWorkspace(lease.main_directory);
    if (current.repository_id !== lease.binding.repository_id || current.main_workspace_snapshot !== lease.binding.main_workspace_snapshot) throw new MainWorkspaceConflictError();
  }

  async assertApplyPreconditions(lease: WorktreeLease): Promise<void> {
    const main = await this.captureMainWorkspace(lease.main_directory);
    if (main.repository_id !== lease.binding.repository_id || main.main_workspace_snapshot !== lease.binding.main_workspace_snapshot) throw new MainWorkspaceConflictError();
    const worktree = await this.captureMainWorkspace(lease.checkout_directory);
    const changed = new Set(worktree.dirty_details.flatMap(entry => [entry.path, entry.original_path].filter((item): item is string => item !== null)));
    const initiallyDirty = new Set(main.dirty_details.flatMap(entry => [entry.path, entry.original_path].filter((item): item is string => item !== null)));
    const overlaps = [...initiallyDirty].some(entry => changed.has(entry));
    if (overlaps) throw new MainWorkspaceConflictError();
  }

  async retain(lease: WorktreeLease): Promise<WorktreeRecord> {
    await this.verifyLease(lease);
    const record = await this.readRecord(lease.binding.worktree_id);
    if (record.state === "REMOVED") throw new WorktreeIsolationError("Removed worktree cannot be retained");
    return this.saveRecord({ ...record, state: "RETAINED", updated_at: this.timestamp(), blocked_reason: record.blocked_reason });
  }

  async cleanup(mainDirectory: string, worktreeId: string): Promise<"removed" | "already_removed"> {
    try { return await this.cleanupInternal(mainDirectory, worktreeId); }
    catch (error) {
      if (error instanceof WorktreeCheckpointInterruption) throw new WorktreeIsolationError("Worktree cleanup checkpoint interrupted");
      if (error instanceof WorktreeIsolationError) throw error;
      throw new WorktreeIsolationError("Worktree cleanup failed closed");
    }
  }

  async readLifecycle(worktreeId: string): Promise<WorktreeRecord> { return this.readRecord(worktreeId); }

  private async cleanupInternal(mainDirectory: string, worktreeId: string): Promise<"removed" | "already_removed"> {
    assertIdentifier(worktreeId, "worktree id");
    let record = await this.readRecord(worktreeId);
    const binding = bindingFromRecord(record);
    const repository = await this.repository(mainDirectory);
    await this.assertExternalRoots(repository);
    if (repository.id !== binding.repository_id) throw new WorktreeIsolationError("Cleanup repository does not match the owned worktree");
    const paths = await this.paths(worktreeId);
    if (record.state === "REMOVED") {
      await this.cleanupRemovedSidecar(paths, binding);
      return "already_removed";
    }
    if (!["READY", "RETAINED", "REMOVING"].includes(record.state)) throw new WorktreeIsolationError("Only a verified ready or retained worktree can be cleaned up");

    if (record.state !== "REMOVING") {
      await this.verifyOwnedCheckout(repository, paths, binding, true);
      record = await this.saveRecord({ ...record, state: "REMOVING", updated_at: this.timestamp(), blocked_reason: null });
      await this.observeCleanupCheckpoint("REMOVING", record);
    } else {
      await this.verifyOwnerDirectory(paths, binding);
    }

    if (await pathExists(paths.checkout)) {
      await this.verifyOwnedCheckout(repository, paths, binding, true);
      const removed = await this.git(repository.root, ["worktree", "remove", paths.checkout]);
      if (removed.code !== 0) throw new WorktreeIsolationError("Git refused to remove the owned worktree");
    } else {
      await this.verifyOwnerDirectory(paths, binding);
    }
    await this.observeCleanupCheckpoint("GIT_REMOVED", record);
    record = await this.saveRecord({ ...record, state: "REMOVED", updated_at: this.timestamp(), blocked_reason: null });
    await this.observeCleanupCheckpoint("REMOVED", record);
    await this.cleanupRemovedSidecar(paths, binding);
    return "removed";
  }

  private async withWorktreeLock<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${normalizePhysical(this.stateRoot)}\0${worktreeId}`;
    const previous = WORKTREE_LOCKS.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    WORKTREE_LOCKS.set(key, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (WORKTREE_LOCKS.get(key) === tail) WORKTREE_LOCKS.delete(key); }
  }

  private async repository(directory: string): Promise<{ root: string; common: string; id: string }> {
    const requested = path.resolve(directory);
    const bare = await this.requiredGit(requested, ["rev-parse", "--is-bare-repository"]);
    if (bare.stdout.trim() !== "false") throw new WorktreeIsolationError("Target must be a non-bare Git worktree");
    const top = await this.requiredGit(requested, ["rev-parse", "--show-toplevel"]);
    const root = path.resolve(top.stdout.trim());
    const commonResult = await this.requiredGit(root, ["rev-parse", "--git-common-dir"]);
    const common = path.resolve(root, commonResult.stdout.trim());
    const canonicalCommon = normalizePhysical(await realpath(common));
    return { root, common: canonicalCommon, id: stableHash({ common_git_directory: canonicalCommon }) };
  }

  private async assertExternalRoots(repository: { root: string; common: string }): Promise<void> {
    const protectedRoots = [normalizePhysical(await realpath(repository.root)), normalizePhysical(repository.common)];
    const configuredRoots = [normalizePhysical(await prospectivePhysicalPath(this.stateRoot)), normalizePhysical(await prospectivePhysicalPath(this.managedRoot))];
    for (const configured of configuredRoots) for (const protectedRoot of protectedRoots) {
      if (pathsOverlap(configured, protectedRoot)) throw new WorktreeIsolationError("Router state and managed worktree roots must be outside the target repository");
    }
    if (pathsOverlap(configuredRoots[0], configuredRoots[1])) throw new WorktreeIsolationError("Router state and managed worktree roots must be independent");
    try {
      await mkdir(this.stateRoot, { recursive: true });
      await mkdir(this.managedRoot, { recursive: true });
      const physicalRoots = [normalizePhysical(await realpath(this.stateRoot)), normalizePhysical(await realpath(this.managedRoot))];
      for (const configured of physicalRoots) for (const protectedRoot of protectedRoots) {
        if (pathsOverlap(configured, protectedRoot)) throw new WorktreeIsolationError("Router state and managed worktree roots must be outside the target repository");
      }
      if (pathsOverlap(physicalRoots[0], physicalRoots[1])) throw new WorktreeIsolationError("Router state and managed worktree roots must be independent");
    } catch (error) {
      if (error instanceof WorktreeIsolationError) throw error;
      throw new WorktreeIsolationError("Router isolation roots are unavailable");
    }
  }

  private async fullCommit(directory: string, candidate: string): Promise<string> {
    if (candidate !== "HEAD" && !OBJECT_ID.test(candidate)) throw new WorktreeIsolationError("Approved base must be a full Git commit id");
    const result = await this.requiredGit(directory, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    const value = result.stdout.trim().toLowerCase();
    if (!OBJECT_ID.test(value)) throw new WorktreeIsolationError("Git did not resolve a full commit id");
    if (candidate !== "HEAD" && value !== candidate.toLowerCase()) throw new WorktreeIsolationError("Approved base did not resolve to the exact commit");
    const kind = await this.requiredGit(directory, ["cat-file", "-t", value]);
    if (kind.stdout.trim() !== "commit") throw new WorktreeIsolationError("Approved base is not a commit");
    return value;
  }

  private async parseDirtyStatus(root: string, output: string): Promise<DirtyPathDetail[]> {
    const tokens = output.split("\0");
    const details: DirtyPathDetail[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token) continue;
      if (token.length < 4 || token[2] !== " ") throw new WorktreeIsolationError("Git returned an unsupported workspace status record");
      const code = token.slice(0, 2);
      const file = normalizedRelativePath(token.slice(3));
      let original: string | null = null;
      if (/[RC]/.test(code)) {
        const source = tokens[++index];
        if (!source) throw new WorktreeIsolationError("Git returned an incomplete rename record");
        original = normalizedRelativePath(source);
      }
      const status: WorkspaceDirtyEvidence["status"] = code === "??" ? "untracked"
        : /R|C/.test(code) ? "renamed"
          : code.includes("D") ? "deleted"
            : code.includes("A") ? "added" : "modified";
      const contentHash = status === "deleted" ? null : await hashWorkspaceFile(path.join(root, file));
      details.push({ path: file, status, content_hash: contentHash, original_path: original });
    }
    return details.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : (left.original_path ?? "").localeCompare(right.original_path ?? ""));
  }

  private async paths(worktreeId: string): Promise<{ root: string; parent: string; checkout: string; owner: string }> {
    assertIdentifier(worktreeId, "worktree id");
    try {
      await mkdir(this.managedRoot, { recursive: true });
      const root = await realpath(this.managedRoot);
      const parent = path.join(root, worktreeId);
      assertDirectChild(root, parent);
      return { root, parent, checkout: path.join(parent, "checkout"), owner: path.join(parent, "owner.json") };
    } catch (error) {
      if (error instanceof WorktreeIsolationError) throw error;
      throw new WorktreeIsolationError("Managed worktree root is unavailable");
    }
  }

  private async ensureOwner(paths: { root: string; parent: string; owner: string }, binding: WorktreeBinding): Promise<void> {
    const owner = ownerFor(binding);
    let created = false;
    try {
      await mkdir(paths.parent, { recursive: false }); created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(paths.parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeIsolationError("Existing managed path is not an owned directory");
      const actual = await realpath(paths.parent); assertDirectChild(paths.root, actual);
      const names = await readdir(paths.parent);
      if (!names.includes("owner.json")) {
        if (names.length > 0) throw new WorktreeIsolationError("Existing managed directory has no ownership evidence");
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 5));
          try { await accessOwner(paths.owner, owner); return; } catch { /* concurrent creator may not have written yet */ }
        }
        throw new WorktreeIsolationError("Existing managed directory has no ownership evidence");
      }
    }
    if (created) {
      const handle = await open(paths.owner, "wx");
      try { await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      return;
    }
    await accessOwner(paths.owner, owner);
  }

  private async verifyOwnerDirectory(paths: { root: string; parent: string; owner: string }, binding: WorktreeBinding): Promise<void> {
    try {
      const parentInfo = await lstat(paths.parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new WorktreeIsolationError("Owned worktree parent was replaced by a link or non-directory");
      assertDirectChild(paths.root, await realpath(paths.parent));
      await accessOwner(paths.owner, ownerFor(binding));
    } catch (error) {
      if (error instanceof WorktreeIsolationError) throw error;
      throw new WorktreeIsolationError("Worktree ownership evidence is unavailable");
    }
  }

  private async cleanupRemovedSidecar(paths: { root: string; parent: string; checkout: string; owner: string }, binding: WorktreeBinding): Promise<void> {
    if (!(await pathExists(paths.parent))) return;
    await this.verifyOwnerDirectory(paths, binding);
    if (await pathExists(paths.checkout)) throw new WorktreeIsolationError("Removed worktree record conflicts with an existing checkout");
    try {
      await unlink(paths.owner);
      await rmdir(paths.parent);
    } catch {
      throw new WorktreeIsolationError("Removed worktree sidecar cleanup is incomplete");
    }
  }

  private async verifyLease(lease: WorktreeLease): Promise<void> {
    const repository = await this.repository(lease.main_directory);
    const paths = await this.paths(lease.binding.worktree_id);
    if (normalizePhysical(paths.checkout) !== normalizePhysical(lease.checkout_directory)) throw new WorktreeIsolationError("Worktree lease path was changed");
    await this.verifyOwnedCheckout(repository, paths, lease.binding, false);
  }

  private async verifyOwnedCheckout(repository: { root: string; common: string; id: string }, paths: { root: string; parent: string; checkout: string; owner: string }, binding: WorktreeBinding, requireClean: boolean): Promise<void> {
    try { await this.verifyOwnedCheckoutUnchecked(repository, paths, binding, requireClean); }
    catch (error) {
      if (error instanceof WorktreeIsolationError) throw error;
      throw new WorktreeIsolationError("Worktree ownership evidence is unavailable");
    }
  }

  private async verifyOwnedCheckoutUnchecked(repository: { root: string; common: string; id: string }, paths: { root: string; parent: string; checkout: string; owner: string }, binding: WorktreeBinding, requireClean: boolean): Promise<void> {
    if (repository.id !== binding.repository_id) throw new WorktreeIsolationError("Repository ownership does not match the worktree binding");
    const parentInfo = await lstat(paths.parent);
    const checkoutInfo = await lstat(paths.checkout);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !checkoutInfo.isDirectory() || checkoutInfo.isSymbolicLink()) throw new WorktreeIsolationError("Owned worktree path was replaced by a link or non-directory");
    const parent = await realpath(paths.parent);
    assertDirectChild(paths.root, parent);
    const owner: unknown = JSON.parse(await readFile(paths.owner, "utf8"));
    const expectedOwner = ownerFor(binding);
    if (stableHash(owner) !== stableHash(expectedOwner)) throw new WorktreeIsolationError("Worktree ownership evidence is incomplete");
    const gitMarker = await lstat(path.join(paths.checkout, ".git"));
    if (!gitMarker.isFile()) throw new WorktreeIsolationError("Owned checkout is not a linked Git worktree");
    const checkoutRepository = await this.repository(paths.checkout);
    if (checkoutRepository.id !== repository.id || checkoutRepository.common !== repository.common) throw new WorktreeIsolationError("Checkout is linked to a different Git repository");
    if (normalizePhysical(await realpath(paths.checkout)) !== normalizePhysical(checkoutRepository.root)) throw new WorktreeIsolationError("Checkout root does not match its owned path");
    const head = await this.fullCommit(paths.checkout, "HEAD");
    if (head !== binding.base_commit) throw new WorktreeIsolationError("Checkout HEAD does not match the approved base commit");
    const symbolic = await this.git(paths.checkout, ["symbolic-ref", "-q", "HEAD"]);
    if (symbolic.code === 0 || symbolic.code !== 1) throw new WorktreeIsolationError("Owned checkout must remain on a detached HEAD");
    if (requireClean) {
      const status = await this.requiredGit(paths.checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
      if (status.stdout.length > 0) throw new WorktreeIsolationError("Dirty diagnostic worktree is retained instead of force-cleaned");
    }
  }

  private async tryVerifyOwnedCheckout(repository: { root: string; common: string; id: string }, paths: { root: string; parent: string; checkout: string; owner: string }, binding: WorktreeBinding, requireClean: boolean): Promise<boolean> {
    try { await this.verifyOwnedCheckout(repository, paths, binding, requireClean); return true; } catch { return false; }
  }

  private recordPath(worktreeId: string): string { assertIdentifier(worktreeId, "worktree id"); return path.join(this.stateRoot, "worktrees", `${worktreeId}.json`); }

  private async saveRecord(record: WorktreeRecord): Promise<WorktreeRecord> {
    assertRecord(record);
    const target = this.recordPath(record.worktree_id);
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${record.worktree_id}.${randomUUID()}.tmp`);
    let moved = false;
    try {
      await mkdir(directory, { recursive: true });
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await atomicRenameWithLocalRetry(temporary, target); moved = true;
      return record;
    } catch { throw new WorktreeIsolationError("Worktree lifecycle persistence failed"); }
    finally { if (!moved) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async readRecord(worktreeId: string): Promise<WorktreeRecord> {
    try { const value: unknown = JSON.parse(await readFile(this.recordPath(worktreeId), "utf8")); assertRecord(value); return value; }
    catch (error) { if (error instanceof WorktreeIsolationError) throw error; throw new WorktreeIsolationError("Worktree lifecycle record is unavailable"); }
  }

  private async tryReadRecord(worktreeId: string): Promise<WorktreeRecord | undefined> {
    try { return await this.readRecord(worktreeId); }
    catch (error) {
      try { await lstat(this.recordPath(worktreeId)); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined; }
      throw error;
    }
  }

  private async requiredGit(directory: string, args: readonly string[]): Promise<GitCommandResult> {
    const result = await this.git(directory, args);
    if (result.code !== 0) throw new WorktreeIsolationError("A required local Git inspection failed");
    return result;
  }

  private async observeCheckpoint(checkpoint: WorktreeCheckpoint, record: WorktreeRecord): Promise<void> {
    try { await this.options.checkpoint?.(checkpoint, record); }
    catch (error) { throw new WorktreeCheckpointInterruption(error); }
  }

  private async observeCleanupCheckpoint(checkpoint: WorktreeCleanupCheckpoint, record: WorktreeRecord): Promise<void> {
    try { await this.options.cleanupCheckpoint?.(checkpoint, record); }
    catch (error) { throw new WorktreeCheckpointInterruption(error); }
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

async function defaultGitRunner(directory: string, args: readonly string[]): Promise<GitCommandResult> {
  try {
    return await new Promise(resolve => {
      const child = spawn("git", [...args], { cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let settled = false;
      const finish = (code: number) => { if (!settled) { settled = true; resolve({ code, stdout, stderr }); } };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", () => finish(-1));
      child.on("close", code => finish(code ?? -1));
    });
  } catch { return { code: -1, stdout: "", stderr: "" }; }
}

function bindingFromRecord(record: WorktreeRecord): WorktreeBinding {
  const { version: _version, state: _state, created_at: _created, updated_at: _updated, blocked_reason: _blocked, ...binding } = record;
  return binding;
}

function assertBinding(binding: WorktreeBinding): void {
  assertIdentifier(binding.run_id, "run id"); assertIdentifier(binding.worktree_id, "worktree id");
  assertHash(binding.repository_id, "repository id"); assertObjectId(binding.base_commit); assertHash(binding.main_workspace_snapshot, "workspace snapshot"); assertHash(binding.plan_hash, "plan hash"); assertHash(binding.isolation_hash, "isolation hash");
  if (!Array.isArray(binding.main_workspace_dirty_evidence)) throw new WorktreeIsolationError("Dirty evidence must be an array");
  const { isolation_hash: _hash, ...body } = binding;
  if (stableHash(body) !== binding.isolation_hash) throw new WorktreeIsolationError("Isolation binding hash does not match its content");
}

function assertRecord(value: unknown): asserts value is WorktreeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorktreeIsolationError("Invalid worktree lifecycle record");
  const record = value as WorktreeRecord;
  const keys = ["version", "run_id", "worktree_id", "repository_id", "base_commit", "main_workspace_snapshot", "main_workspace_dirty_evidence", "plan_hash", "isolation_hash", "state", "created_at", "updated_at", "blocked_reason"];
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record))) throw new WorktreeIsolationError("Invalid worktree lifecycle fields");
  if (record.version !== 1 || !["PREPARING", "READY", "RETAINED", "REMOVING", "BLOCKED", "REMOVED"].includes(record.state)) throw new WorktreeIsolationError("Invalid worktree lifecycle state");
  assertBinding(bindingFromRecord(record));
  if (Number.isNaN(Date.parse(record.created_at)) || Number.isNaN(Date.parse(record.updated_at)) || (record.blocked_reason !== null && typeof record.blocked_reason !== "string")) throw new WorktreeIsolationError("Invalid worktree lifecycle metadata");
}

function assertRecordMatches(record: WorktreeRecord, binding: WorktreeBinding): void {
  assertRecord(record);
  if (record.isolation_hash !== binding.isolation_hash || stableHash(bindingFromRecord(record)) !== stableHash(binding)) throw new WorktreeIsolationError("Existing worktree record conflicts with the approved binding");
}

function assertIdentifier(value: string, name: string): void { if (!IDENTIFIER.test(value)) throw new WorktreeIsolationError(`Invalid ${name}`); }
function assertHash(value: string, name: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new WorktreeIsolationError(`Invalid ${name}`); }
function assertObjectId(value: string): void { if (!OBJECT_ID.test(value)) throw new WorktreeIsolationError("Invalid full Git object id"); }
function normalizedRelativePath(value: string): string { const normalized = value.replace(/\\/g, "/"); assertSafeRelativePath(normalized, "Git status path"); return normalized; }
function normalizePhysical(value: string): string { const normalized = path.resolve(value); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
function assertDirectChild(root: string, target: string): void { if (path.dirname(normalizePhysical(target)) !== normalizePhysical(root)) throw new WorktreeIsolationError("Managed worktree path escaped its owned root"); }
function pathsOverlap(left: string, right: string): boolean { return isWithin(left, right) || isWithin(right, left); }
function isWithin(parent: string, target: string): boolean { const relative = path.relative(normalizePhysical(parent), normalizePhysical(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function hashWorkspaceFile(file: string): Promise<string> { const info = await lstat(file); if (!info.isFile()) throw new WorktreeIsolationError("Dirty evidence only supports regular files in S3"); return sha256(await readFile(file)); }
async function pathExists(target: string): Promise<boolean> { try { await lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function prospectivePhysicalPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(current);
      return path.resolve(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorktreeIsolationError("Router isolation root ancestry is unavailable");
      const parent = path.dirname(current);
      if (parent === current) throw new WorktreeIsolationError("Router isolation root ancestry is unavailable");
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
function ownerFor(binding: WorktreeBinding): object { return { version: 1, run_id: binding.run_id, worktree_id: binding.worktree_id, repository_id: binding.repository_id, base_commit: binding.base_commit, isolation_hash: binding.isolation_hash }; }
async function accessOwner(ownerPath: string, expected: unknown): Promise<void> { const existing: unknown = JSON.parse(await readFile(ownerPath, "utf8")); if (stableHash(existing) !== stableHash(expected)) throw new WorktreeIsolationError("Worktree owner record does not match the approved binding"); }
function publicIsolationError(error: unknown, fallback: string): WorktreeIsolationError { return error instanceof WorktreeIsolationError ? error : new WorktreeIsolationError(fallback); }
function safeReason(error: unknown): string { return error instanceof MainWorkspaceConflictError ? error.message : "Worktree preparation failed closed"; }
