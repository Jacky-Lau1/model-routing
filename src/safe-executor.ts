import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, stat, unlink, link } from "node:fs/promises";
import path from "node:path";
import { assertPathScope, assertSafeRelativePath, containsSecretLikeText } from "./contracts.js";
import type {
  DataClassification,
  ExecutorCapabilityGrant,
  ExecutorManifestEntry,
  StructuredPatchProposal,
} from "./types.js";

export const DEFAULT_EXECUTOR_FILE_LIMIT = 1_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const WILDCARD = /[*?]/;

export class SafeExecutorError extends Error {
  constructor(message: string) { super(message); this.name = "SafeExecutorError"; }
}

/**
 * Build a content-hash manifest from exact, explicitly approved read paths.
 * Wildcard enumeration is deliberately unsupported: file names outside this
 * list are never discovered for the model.
 */
export async function buildExecutorCapabilityGrant(
  rootDirectory: string,
  readScope: string[],
  writeScope: string[],
  dataClassification: DataClassification,
  maxFileBytes = DEFAULT_EXECUTOR_FILE_LIMIT,
): Promise<ExecutorCapabilityGrant> {
  assertPathScope(readScope, "executor read scope");
  assertPathScope(writeScope, "executor write scope");
  assertFileLimit(maxFileBytes);
  if (dataClassification !== "public") throw new SafeExecutorError("legacy Direct DeepSeek capabilities require an explicitly approved public classification");
  const root = await verifiedRoot(rootDirectory);
  const readManifest: ExecutorManifestEntry[] = [];
  for (const requested of readScope) {
    const relative = exactRelativePath(requested, "executor read path");
    assertNonSensitivePath(relative);
    const inspected = await inspectReadable(root, relative, maxFileBytes);
    readManifest.push({
      path: relative,
      contentHash: inspected.hash,
      byteLength: inspected.bytes.length,
      dataClassification,
    });
  }
  readManifest.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assertUniqueCaseFolded(readManifest.map(entry => entry.path), "read manifest");
  const grant = { readManifest, writeScope: [...writeScope], maxFileBytes };
  assertGrant(grant);
  return grant;
}

export class SafeExecutor {
  private readonly rootPromise: Promise<string>;
  private readonly manifest = new Map<string, ExecutorManifestEntry>();
  private readonly pending: StructuredPatchProposal[] = [];
  private readBytes = 0;
  private patchBytes = 0;

  constructor(rootDirectory: string, readonly grant: ExecutorCapabilityGrant) {
    assertGrant(grant);
    this.rootPromise = verifiedRoot(rootDirectory);
    for (const entry of grant.readManifest) this.manifest.set(caseFold(entry.path), { ...entry });
  }

  listManifest(): ExecutorManifestEntry[] {
    return [...this.manifest.values()].map(entry => ({ ...entry }));
  }

  async preflight(): Promise<void> {
    const root = await this.rootPromise;
    for (const entry of this.manifest.values()) {
      const inspected = await inspectReadable(root, entry.path, this.grant.maxFileBytes);
      if (inspected.hash !== entry.contentHash || inspected.bytes.length !== entry.byteLength) throw new SafeExecutorError("executor manifest changed before invocation");
    }
  }

  async readFile(requestedPath: string): Promise<{ path: string; content: string; contentHash: string; byteLength: number }> {
    const relative = exactRelativePath(requestedPath, "read_file path");
    assertNonSensitivePath(relative);
    const entry = this.manifest.get(caseFold(relative));
    if (!entry) throw new SafeExecutorError("read_file denied outside the approved manifest");
    if (entry.path !== relative) throw new SafeExecutorError("read_file path case does not match the approved manifest");
    if (entry.dataClassification === "secret_restricted") throw new SafeExecutorError("read_file denied for restricted content");
    const inspected = await inspectReadable(await this.rootPromise, relative, this.grant.maxFileBytes);
    if (inspected.hash !== entry.contentHash || inspected.bytes.length !== entry.byteLength) throw new SafeExecutorError("read_file manifest hash is stale");
    this.readBytes += inspected.bytes.length;
    if (this.readBytes > this.grant.maxFileBytes) throw new SafeExecutorError("cumulative read_file byte budget exceeded");
    return { path: relative, content: inspected.content, contentHash: inspected.hash, byteLength: inspected.bytes.length };
  }

  async proposePatch(value: unknown): Promise<{ accepted: string; bytes: number }> {
    const proposal = normalizeProposal(value, this.grant);
    if (this.pending.length) throw new SafeExecutorError(this.pending.some(item => caseFold(item.path) === caseFold(proposal.path)) ? "duplicate patch path is not allowed" : "S4 MVP accepts one patch target per attempt");
    await preflightProposal(await this.rootPromise, this.grant, this.manifest, proposal);
    this.patchBytes += Buffer.byteLength(proposal.replacement, "utf8");
    if (this.patchBytes > this.grant.maxFileBytes) throw new SafeExecutorError("cumulative patch byte budget exceeded");
    this.pending.push(proposal);
    return { accepted: proposal.path, bytes: Buffer.byteLength(proposal.replacement, "utf8") };
  }

  proposals(): StructuredPatchProposal[] {
    return this.pending.map(proposal => ({ ...proposal }));
  }

  async apply(): Promise<void> {
    const root = await this.rootPromise;
    const prepared: Array<{
      proposal: StructuredPatchProposal;
      target: string;
      parent: string;
      bytes: Buffer;
      existing: boolean;
      mode: number;
      temporary?: string;
    }> = [];

    // Validate the entire batch before creating any temporary file or changing
    // the worktree. This prevents a later invalid proposal from causing a
    // partial apply.
    for (const proposal of this.pending) {
      const result = await preflightProposal(root, this.grant, this.manifest, proposal);
      prepared.push({ proposal, target: result.target, parent: path.dirname(result.target), bytes: Buffer.from(proposal.replacement, "utf8"), existing: result.existing, mode: result.mode });
    }

    try {
      for (const item of prepared) {
        item.temporary = path.join(item.parent, `.router-patch-${randomUUID()}.tmp`);
        const handle = await open(item.temporary, "wx", item.mode & 0o777);
        try { await handle.writeFile(item.bytes); await handle.sync(); } finally { await handle.close(); }
      }

      // Recheck every preimage after staging and immediately before the first
      // replacement. A race after this point is retained as an ambiguous local
      // failure; the executor has no command/process capability to create one.
      for (const item of prepared) await preflightProposal(root, this.grant, this.manifest, item.proposal);

      for (const item of prepared) {
        if (!item.temporary) throw new SafeExecutorError("patch staging was incomplete");
        if (item.existing) await rename(item.temporary, item.target);
        else { await link(item.temporary, item.target); await unlink(item.temporary); }
        item.temporary = undefined;
      }
    } finally {
      await Promise.all(prepared.map(item => item.temporary ? unlink(item.temporary).catch(() => undefined) : Promise.resolve()));
    }
  }
}

export async function applyStructuredPatches(rootDirectory: string, grant: ExecutorCapabilityGrant, proposals: StructuredPatchProposal[]): Promise<void> {
  if (!Array.isArray(proposals)) throw new SafeExecutorError("structured patch response must be an array");
  if (proposals.length > 1) throw new SafeExecutorError("S4 MVP accepts at most one atomic file patch per attempt");
  const executor = new SafeExecutor(rootDirectory, grant);
  for (const proposal of proposals) await executor.proposePatch(proposal);
  await executor.apply();
}

function assertGrant(grant: ExecutorCapabilityGrant): void {
  if (!grant || typeof grant !== "object" || !Array.isArray(grant.readManifest)) throw new SafeExecutorError("executor capability grant is invalid");
  const grantKeys = Object.keys(grant as unknown as Record<string, unknown>);
  if (grantKeys.length !== 3 || !["readManifest", "writeScope", "maxFileBytes"].every(key => grantKeys.includes(key))) throw new SafeExecutorError("executor capability grant has unknown or missing fields");
  assertPathScope(grant.writeScope, "executor write scope");
  if (grant.writeScope.some(entry => entry.includes("?"))) throw new SafeExecutorError("question-mark write globs are not supported in the S4 MVP");
  assertFileLimit(grant.maxFileBytes);
  assertUniqueCaseFolded(grant.readManifest.map(entry => entry.path), "read manifest");
  if (grant.readManifest.length > 256) throw new SafeExecutorError("read manifest exceeds the approved entry budget");
  for (const entry of grant.readManifest) {
    const entryKeys = Object.keys(entry as unknown as Record<string, unknown>);
    if (entryKeys.length !== 4 || !["path", "contentHash", "byteLength", "dataClassification"].every(key => entryKeys.includes(key))) throw new SafeExecutorError("manifest entry has unknown or missing fields");
    exactRelativePath(entry.path, "manifest path");
    assertNonSensitivePath(entry.path);
    if (!SHA256.test(entry.contentHash) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > grant.maxFileBytes) throw new SafeExecutorError("manifest metadata is invalid");
    if (entry.dataClassification !== "public") throw new SafeExecutorError("Direct DeepSeek manifest entries must be explicitly classified public");
  }
  if (grant.readManifest.reduce((total, entry) => total + entry.byteLength, 0) > grant.maxFileBytes) throw new SafeExecutorError("read manifest exceeds the approved byte budget");
}

function normalizeProposal(value: unknown, grant: ExecutorCapabilityGrant): StructuredPatchProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeExecutorError("patch proposal must be an object");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 3 || !["path", "preimageHash", "replacement"].every(key => keys.includes(key))) throw new SafeExecutorError("patch proposal has unknown or missing fields");
  const relative = exactRelativePath(object.path, "patch path");
  assertNonSensitivePath(relative);
  if (!grant.writeScope.some(pattern => matchesWriteScope(relative, pattern))) throw new SafeExecutorError("patch denied outside the approved write scope");
  if (object.preimageHash !== null && (typeof object.preimageHash !== "string" || !SHA256.test(object.preimageHash))) throw new SafeExecutorError("patch preimageHash must be a SHA-256 digest or null");
  if (typeof object.replacement !== "string") throw new SafeExecutorError("patch replacement must be UTF-8 text");
  const encoded = Buffer.from(object.replacement, "utf8");
  if (encoded.toString("utf8") !== object.replacement || object.replacement.includes("\0")) throw new SafeExecutorError("patch replacement is not valid UTF-8 text");
  if (/\r/.test(object.replacement)) throw new SafeExecutorError("CRLF and carriage-return patches are not supported in the S4 MVP");
  if (encoded.length > grant.maxFileBytes) throw new SafeExecutorError("patch replacement exceeds the approved file-size limit");
  return { path: relative, preimageHash: object.preimageHash as string | null, replacement: object.replacement };
}

async function preflightProposal(
  root: string,
  grant: ExecutorCapabilityGrant,
  manifest: Map<string, ExecutorManifestEntry>,
  proposal: StructuredPatchProposal,
): Promise<{ target: string; existing: boolean; mode: number }> {
  const resolved = await resolvePath(root, proposal.path, true);
  if (!resolved.exists) {
    if (proposal.preimageHash !== null) throw new SafeExecutorError("patch preimage does not exist");
    return { target: resolved.target, existing: false, mode: 0o600 };
  }
  if (proposal.preimageHash === null) throw new SafeExecutorError("patch expected a new file but the target exists");
  const manifestEntry = manifest.get(caseFold(proposal.path));
  if (!manifestEntry || manifestEntry.path !== proposal.path) throw new SafeExecutorError("existing files may only be patched from the approved read manifest");
  const inspected = await inspectReadable(root, proposal.path, grant.maxFileBytes);
  if (inspected.hash !== manifestEntry.contentHash || inspected.hash !== proposal.preimageHash) throw new SafeExecutorError("patch preimage hash does not match current content");
  return { target: resolved.target, existing: true, mode: inspected.mode };
}

async function inspectReadable(root: string, relative: string, maxFileBytes: number): Promise<{ bytes: Buffer; content: string; hash: string; mode: number }> {
  const resolved = await resolvePath(root, exactRelativePath(relative, "manifest path"), false);
  const metadata = await stat(resolved.target);
  if (!metadata.isFile()) throw new SafeExecutorError("manifest entry is not a regular file");
  if (metadata.size > maxFileBytes) throw new SafeExecutorError("file exceeds the approved file-size limit");
  const bytes = await readFile(resolved.target);
  if (bytes.length > maxFileBytes || bytes.includes(0)) throw new SafeExecutorError("file is too large or binary");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SafeExecutorError("file is not valid UTF-8"); }
  if (/\r/.test(content)) throw new SafeExecutorError("CRLF and carriage-return files are not supported in the S4 MVP");
  if (containsSecretLikeText(content)) throw new SafeExecutorError("file content contains a high-confidence restricted secret pattern");
  return { bytes, content, hash: createHash("sha256").update(bytes).digest("hex"), mode: metadata.mode };
}

async function resolvePath(root: string, relative: string, allowMissingFinal: boolean): Promise<{ target: string; exists: boolean }> {
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const entries = await readdir(current);
    const exact = entries.find(entry => entry === segment);
    const folded = entries.filter(entry => caseFold(entry) === caseFold(segment));
    if (!exact) {
      if (folded.length) throw new SafeExecutorError("path case does not match the filesystem entry");
      if (allowMissingFinal && index === segments.length - 1) return { target: path.join(current, segment), exists: false };
      throw new SafeExecutorError("approved path does not exist");
    }
    if (folded.length !== 1) throw new SafeExecutorError("case-ambiguous filesystem path is not supported");
    current = path.join(current, exact);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new SafeExecutorError("symlink, junction, or reparse-backed paths are denied");
    const physical = await realpath(current);
    assertInside(root, physical);
    if (physical !== current && caseFold(physical) !== caseFold(current)) throw new SafeExecutorError("symlink, junction, or reparse-backed paths are denied");
    if (index < segments.length - 1 && !metadata.isDirectory()) throw new SafeExecutorError("path parent is not a directory");
  }
  return { target: current, exists: true };
}

async function verifiedRoot(rootDirectory: string): Promise<string> {
  const requested = path.resolve(rootDirectory);
  const requestedMetadata = await lstat(requested);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) throw new SafeExecutorError("executor root must be a physical directory");
  const resolved = await realpath(requested);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new SafeExecutorError("executor root must be a physical directory");
  return resolved;
}

function exactRelativePath(value: unknown, name: string): string {
  try { assertSafeRelativePath(value, name); } catch { throw new SafeExecutorError(`${name} must be a normalized relative path`); }
  const relative = value as string;
  if (WILDCARD.test(relative) || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^\\\\[.?]\\/.test(relative)) throw new SafeExecutorError(`${name} must identify one exact relative file`);
  for (const segment of relative.split("/")) {
    const base = segment.split(".", 1)[0].toUpperCase();
    if (/[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) throw new SafeExecutorError(`${name} contains a Windows-ambiguous segment`);
  }
  return relative;
}

function assertNonSensitivePath(value: string): void {
  if (isSensitivePath(value)) throw new SafeExecutorError("file access denied for a credential, key, environment, or production-dump path");
}

export function isSensitivePath(value: string): boolean {
  const normalized = `/${value.replace(/\\/g, "/").toLowerCase()}`;
  return /\/(?:\.git(?:\/|$)|\.env(?:\.|$)|\.envrc$|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|secrets?(?:\/|$)|credentials?(?:\/|$)|private[-_.]?keys?(?:\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/.test(normalized)
    || /\/(?:\.ssh|\.codex|\.aws|\.azure)(?:\/|$)/.test(normalized)
    || /\/(?:auth|token|credentials?)(?:[-_.][^/]*)?\.(?:json|ya?ml|toml|ini|cfg|conf)$/.test(normalized)
    || /\/(?:api[-_.]?keys?|private[-_.]?keys?|tokens?|credentials?|passwords?|secrets?)(?:[-_.][^/]*)?\.(?:txt|data|json|ya?ml|toml|ini|cfg|conf)$/.test(normalized)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(normalized)
    || /\/(?:prod|production)[^/]*\.(?:sql|dump|bak|backup)$/.test(normalized);
}

function assertFileLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_000_000) throw new SafeExecutorError("executor file-size limit is invalid");
}

function assertUniqueCaseFolded(values: string[], name: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const folded = caseFold(value);
    if (seen.has(folded)) throw new SafeExecutorError(`${name} contains a case-ambiguous duplicate`);
    seen.add(folded);
  }
}

function caseFold(value: string): string { return value.toLocaleLowerCase("en-US"); }

function matchesWriteScope(file: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new SafeExecutorError("path escapes the executor root");
}
