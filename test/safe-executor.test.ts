import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SafeExecutor,
  applyStructuredPatches,
  buildExecutorCapabilityGrant,
  DEFAULT_EXECUTOR_FILE_LIMIT,
} from "../src/safe-executor.js";

const roots: string[] = [];
afterEach(async () => {
  const temporary = caseFold(await realpath(os.tmpdir()));
  for (const root of roots.splice(0)) {
    const resolved = caseFold(path.resolve(root));
    if (!resolved.startsWith(`${temporary}${path.sep}`) || !path.basename(root).startsWith("router-s4-")) throw new Error("Refusing to remove a non-S4 fixture");
    await rm(root, { recursive: true, force: true });
  }
});

describe("S4 SafeExecutor capability boundary", () => {
  it("lists and reads only exact approved manifest entries", async () => {
    const root = await fixture();
    const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/new.ts"], "public");
    const executor = new SafeExecutor(root, grant); await executor.preflight();
    expect(executor.listManifest().map(entry => entry.path)).toEqual(["src/allowed.ts"]);
    expect((await executor.readFile("src/allowed.ts")).content).toBe("export const allowed = 1;\n");
    await expect(executor.readFile("src/outside.ts")).rejects.toThrow(/manifest/);
    await expect(executor.proposePatch({ path: "src/allowed.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "export const allowed = 2;\n" })).rejects.toThrow(/write scope/);
  });

  it.each([
    "../outside.ts", "src/../../outside.ts", "..\\outside.ts", "/etc/passwd", "C:\\Windows\\win.ini",
    "C:/Windows/win.ini", "C:relative.txt", "\\\\server\\share\\a.ts", "//server/share/a.ts",
    "\\\\?\\C:\\a.ts", "src/allowed.ts:secret", "src/allowed.ts::$DATA", "src/a.ts.", "CON", "src/NUL.txt",
  ])("rejects dangerous or Windows-ambiguous path %s", async candidate => {
    const root = await fixture(); const executor = new SafeExecutor(root, await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/*.ts"], "public"));
    await expect(executor.readFile(candidate)).rejects.toThrow();
    await expect(executor.proposePatch({ path: candidate, preimageHash: null, replacement: "synthetic\n" })).rejects.toThrow();
    expect(await readFile(path.join(root, "src", "outside.ts"), "utf8")).toBe("outside but non-sensitive\n");
  });

  it("rejects case aliases rather than relying on platform-specific case folding", async () => {
    const root = await fixture(); const executor = new SafeExecutor(root, await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/*.ts"], "public"));
    await expect(executor.readFile("SRC/ALLOWED.ts")).rejects.toThrow(/case/);
    await expect(executor.proposePatch({ path: "SRC/new.ts", preimageHash: null, replacement: "synthetic\n" })).rejects.toThrow(/case|write scope/);
    const exactLeaf = new SafeExecutor(root, await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/New.ts"], "public"));
    await expect(exactLeaf.proposePatch({ path: "src/new.ts", preimageHash: null, replacement: "synthetic\n" })).rejects.toThrow(/write scope/);
    await expect(buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/a?.ts"], "public")).rejects.toThrow(/question-mark/);
  });

  it.each([".git", ".env", ".env.local", ".envrc", ".ssh/id_ed25519", ".codex/auth.json", "credentials.json", "api-key.txt", "private-key.txt", "token.txt", "password.txt", "secret.txt", "keys/private.pem", "production.dump"])("rejects forbidden path %s before it enters a manifest", async relative => {
    const root = await fixture(); const target = path.join(root, ...relative.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "synthetic placeholder\n");
    await expect(buildExecutorCapabilityGrant(root, [relative], [relative], "public")).rejects.toThrow(/credential|environment|production|denied/);
  });

  it("rejects private classification and high-confidence secret-like content", async () => {
    const root = await fixture();
    await expect(buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/allowed.ts"], "private")).rejects.toThrow(/public classification/);
    await writeFile(path.join(root, "src", "secretish.ts"), "api_key=synthetic-secret-value\n");
    await expect(buildExecutorCapabilityGrant(root, ["src/secretish.ts"], ["src/secretish.ts"], "public")).rejects.toThrow(/secret pattern/);
  });

  it("rejects symlink and junction leaves, parents, and executor roots", async () => {
    const root = await fixture(); const foreign = await mkdtemp(path.join(os.tmpdir(), "router-s4-foreign-")); roots.push(foreign);
    await writeFile(path.join(foreign, "sentinel.ts"), "foreign\n");
    await symlink(foreign, path.join(root, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    if (process.platform !== "win32") {
      await symlink(path.join(foreign, "sentinel.ts"), path.join(root, "src", "linked.ts"), "file");
      await expect(buildExecutorCapabilityGrant(root, ["src/linked.ts"], ["src/linked.ts"], "public")).rejects.toThrow(/symlink|junction|reparse/);
    }
    await expect(buildExecutorCapabilityGrant(root, ["linked-dir/sentinel.ts"], ["linked-dir/new.ts"], "public")).rejects.toThrow(/symlink|junction|reparse/);
    const alias = `${root}-alias`; await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/new.ts"], "public");
    try { await expect(new SafeExecutor(alias, grant).preflight()).rejects.toThrow(/physical directory/); }
    finally { await unlink(alias); }
    expect(await readFile(path.join(foreign, "sentinel.ts"), "utf8")).toBe("foreign\n");
  });

  it("detects a stale manifest before returning changed content", async () => {
    const root = await fixture(); const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/allowed.ts"], "public"); const executor = new SafeExecutor(root, grant);
    await writeFile(path.join(root, "src", "allowed.ts"), "changed after approval\n");
    await expect(executor.preflight()).rejects.toThrow(/changed/);
    await expect(executor.readFile("src/allowed.ts")).rejects.toThrow(/stale/);
  });

  it("rejects oversized, binary, invalid UTF-8, and CRLF files", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "large.ts"), Buffer.alloc(17, 0x61));
    await writeFile(path.join(root, "src", "binary.ts"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(root, "src", "invalid.ts"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, "src", "crlf.ts"), "a\r\nb\r\n");
    await expect(buildExecutorCapabilityGrant(root, ["src/large.ts"], ["src/large.ts"], "public", 16)).rejects.toThrow(/size/);
    await expect(buildExecutorCapabilityGrant(root, ["src/binary.ts"], ["src/binary.ts"], "public")).rejects.toThrow(/binary/);
    await expect(buildExecutorCapabilityGrant(root, ["src/invalid.ts"], ["src/invalid.ts"], "public")).rejects.toThrow(/UTF-8/);
    await expect(buildExecutorCapabilityGrant(root, ["src/crlf.ts"], ["src/crlf.ts"], "public")).rejects.toThrow(/CRLF/);
  });

  it("keeps a proposal in memory until one atomic preimage-checked apply", async () => {
    const root = await fixture(); const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/allowed.ts"], "public"); const executor = new SafeExecutor(root, grant);
    const replacement = "export const allowed = 2;\n";
    await executor.proposePatch({ path: "src/allowed.ts", preimageHash: grant.readManifest[0].contentHash, replacement });
    expect(await readFile(path.join(root, "src", "allowed.ts"), "utf8")).toBe("export const allowed = 1;\n");
    await executor.apply();
    expect(await readFile(path.join(root, "src", "allowed.ts"), "utf8")).toBe(replacement);
    await expect(executor.apply()).rejects.toThrow(/preimage/);
  });

  it("creates a new file only in an existing approved physical parent", async () => {
    const root = await fixture(); const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/new.ts"], "public");
    await applyStructuredPatches(root, grant, [{ path: "src/new.ts", preimageHash: null, replacement: "export const created = true;\n" }]);
    expect(await readFile(path.join(root, "src", "new.ts"), "utf8")).toBe("export const created = true;\n");
    await expect(applyStructuredPatches(root, grant, [{ path: "missing/new.ts", preimageHash: null, replacement: "x\n" }])).rejects.toThrow(/write scope|does not exist/);
  });

  it("rejects wrong preimages, unknown fields, duplicate targets, and multi-file batches before any write", async () => {
    const root = await fixture(); const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts", "src/outside.ts"], ["src/*.ts"], "public"); const before = await readFile(path.join(root, "src", "allowed.ts"));
    await expect(applyStructuredPatches(root, grant, [{ path: "src/allowed.ts", preimageHash: "0".repeat(64), replacement: "bad\n" }])).rejects.toThrow(/preimage/);
    const executor = new SafeExecutor(root, grant);
    await expect(executor.proposePatch({ path: "src/new.ts", preimageHash: null, replacement: "x\n", extra: true })).rejects.toThrow(/unknown/);
    await executor.proposePatch({ path: "src/new.ts", preimageHash: null, replacement: "x\n" });
    await expect(executor.proposePatch({ path: "src/new.ts", preimageHash: null, replacement: "y\n" })).rejects.toThrow(/duplicate/);
    await expect(applyStructuredPatches(root, grant, [
      { path: "src/allowed.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "first\n" },
      { path: "src/outside.ts", preimageHash: grant.readManifest[1].contentHash, replacement: "second\n" },
    ])).rejects.toThrow(/at most one/);
    expect(await readFile(path.join(root, "src", "allowed.ts"))).toEqual(before);
  });

  it("enforces cumulative manifest and replacement byte budgets", async () => {
    const root = await fixture(); const grant = await buildExecutorCapabilityGrant(root, ["src/allowed.ts"], ["src/new.ts"], "public", 64);
    const executor = new SafeExecutor(root, grant); await executor.readFile("src/allowed.ts");
    await expect(executor.proposePatch({ path: "src/new.ts", preimageHash: null, replacement: "x".repeat(65) })).rejects.toThrow(/size/);
    expect(DEFAULT_EXECUTOR_FILE_LIMIT).toBe(1_000_000);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-s4-")); roots.push(root); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "allowed.ts"), "export const allowed = 1;\n");
  await writeFile(path.join(root, "src", "outside.ts"), "outside but non-sensitive\n");
  return root;
}

function caseFold(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
