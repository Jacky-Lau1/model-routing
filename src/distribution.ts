import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./canonical.js";

export interface DistributionFileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DistributionManifest {
  version: 1;
  files: DistributionFileEvidence[];
  distribution_hash: string;
}

export interface DistributionVerification {
  passed: boolean;
  expected_hash: string;
  observed_hash: string | null;
  errors: string[];
}

export async function createDistributionManifest(distributionRoot: string, relativeFiles: readonly string[]): Promise<DistributionManifest> {
  absolute(distributionRoot, "distribution root");
  if (!relativeFiles.length || new Set(relativeFiles).size !== relativeFiles.length) throw new Error("Distribution manifest requires unique files");
  const files: DistributionFileEvidence[] = [];
  for (const relative of [...relativeFiles].sort()) {
    safeRelative(relative);
    const target = path.resolve(distributionRoot, relative);
    assertWithin(distributionRoot, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Distribution artifact is not a regular file: ${relative}`);
    files.push({ path: portable(relative), bytes: info.size, sha256: await sha256File(target) });
  }
  const body = { version: 1 as const, files };
  return Object.freeze({ ...body, files: Object.freeze(files.map(file => Object.freeze(file))) as unknown as DistributionFileEvidence[], distribution_hash: stableHash(body) });
}

export async function verifyDistributionManifest(distributionRoot: string, expected: DistributionManifest): Promise<DistributionVerification> {
  try {
    assertDistributionManifest(expected);
    const observed = await createDistributionManifest(distributionRoot, expected.files.map(file => file.path));
    const errors: string[] = [];
    for (const file of expected.files) {
      const actual = observed.files.find(candidate => candidate.path === file.path);
      if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) errors.push(`artifact_mismatch:${file.path}`);
    }
    if (observed.distribution_hash !== expected.distribution_hash) errors.push("distribution_hash_mismatch");
    return { passed: errors.length === 0, expected_hash: expected.distribution_hash, observed_hash: observed.distribution_hash, errors };
  } catch (error) {
    return { passed: false, expected_hash: expected?.distribution_hash ?? "invalid", observed_hash: null, errors: [`distribution_unavailable:${publicError(error)}`] };
  }
}

export function assertDistributionManifest(value: DistributionManifest): void {
  if (!value || value.version !== 1 || !Array.isArray(value.files) || value.files.length === 0) throw new Error("Distribution manifest is invalid");
  const body = { version: value.version, files: value.files };
  if (!digest(value.distribution_hash) || stableHash(body) !== value.distribution_hash) throw new Error("Distribution manifest hash mismatch");
  const seen = new Set<string>();
  for (const file of value.files) {
    safeRelative(file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digest(file.sha256)) throw new Error("Distribution file evidence is invalid");
    seen.add(file.path);
  }
}

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function safeRelative(value: string): void {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error("Distribution artifact path must be safe and relative");
  const normalized = portable(path.normalize(value));
  if (normalized === ".." || normalized.startsWith("../") || normalized !== portable(value)) throw new Error("Distribution artifact path escapes its root");
}
function portable(value: string): string { return value.replace(/\\/g, "/"); }
function absolute(value: string, name: string): void { if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${name} must be an absolute path`); }
function assertWithin(root: string, target: string): void { const relative = path.relative(path.resolve(root), path.resolve(target)); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Distribution artifact escaped its root"); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function publicError(error: unknown): string { return error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 200) : "unknown"; }
