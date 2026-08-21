import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { decideRoute } from "../src/policy.js";
import { DeepSeekChatAdapter } from "../src/providers/deepseek-chat.js";
import { buildLegacyRouteBinding, DEEPSEEK_ENDPOINT_ORIGIN, DEEPSEEK_ENDPOINT_PATH } from "../src/route-preflight.js";
import { buildExecutorCapabilityGrant } from "../src/safe-executor.js";
import type { ProviderRequest } from "../src/types.js";

const roots: string[] = [];
const targetUrl = `${DEEPSEEK_ENDPOINT_ORIGIN}${DEEPSEEK_ENDPOINT_PATH}`;
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("DeepSeek official Chat Completions adapter", () => {
  it("replays reasoning_content across tool-call turns in memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-tool-")); roots.push(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;", "utf8");
    const requests: any[] = []; let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      call++;
      const payload = call === 1
        ? { id: "r1", model: "deepseek-v4-pro", choices: [{ message: { content: "", reasoning_content: "inspect first", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8 } }
        : { id: "r1", model: "deepseek-v4-pro", choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 2 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = testAdapter({ apiKey: "test", fetchImpl });
    const route = decideRoute("EXECUTE", classifyTask("Cross-module architecture refactor"));
    const executorCapabilities = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal", workingDirectory: root, allowedFiles: ["a.ts"], executorCapabilities }));
    expect(response.text).toBe("done");
    expect(requests[0].reasoning_effort).toBe("high");
    expect(requests[0].thinking).toEqual({ type: "enabled" });
    expect(requests[1].messages[2].reasoning_content).toBe("inspect first");
    expect(requests[1].messages[3]).toMatchObject({ role: "tool", tool_call_id: "t1" });
    expect(response.usage.cacheHitTokens).toBe(12);
  });

  it("explicitly disables thinking for normal Flash execution", async () => {
    let body: any;
    const adapter = testAdapter({ apiKey: "test", fetchImpl: async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "done" } }], usage: {} }), { status: 200 }); } });
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note"));
    await adapter.invoke(bound({ stage: "TEXT_EXPAND", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal" }));
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("does not expose credential paths to DeepSeek tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-secret-")); roots.push(root);
    await writeFile(path.join(root, ".env"), "API_KEY=secret", "utf8");
    let call = 0;
    const adapter = testAdapter({ apiKey: "test", fetchImpl: async () => {
      call++;
      const payload = call === 1
        ? { id: "r", model: "deepseek-v4-pro", choices: [{ message: { content: "", reasoning_content: "", tool_calls: [{ id: "t", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: ".env" }) } }] } }], usage: {} }
        : { id: "r", model: "deepseek-v4-pro", choices: [{ message: { content: "done" } }], usage: {} };
      return new Response(JSON.stringify(payload), { status: 200 });
    } });
    const route = decideRoute("EXECUTE", classifyTask("Cross-module architecture refactor"));
    const bytes = Buffer.from("API_KEY=synthetic-secret", "utf8");
    const executorCapabilities = { readManifest: [{ path: ".env", contentHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, dataClassification: "public" as const }], writeScope: [".env"], maxFileBytes: 1_000_000 };
    await expect(adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, allowedFiles: [".env"], executorCapabilities }))).rejects.toThrow(/credential|environment|sensitive|denied/);
    expect(call).toBe(0);
  });

  it("exposes only manifest/read/propose tools and never puts auth in the model body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-surface-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    let body: any; const syntheticKey = "synthetic-auth-header-only";
    const adapter = testAdapter({ apiKey: syntheticKey, fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${syntheticKey}`);
      return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "done" } }], usage: {} }), { status: 200 });
    } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug")); const executorCapabilities = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal", workingDirectory: root, executorCapabilities }));
    const names = body.tools.map((entry: any) => entry.function.name);
    expect(names).toEqual(["list_manifest", "read_file", "propose_patch"]);
    expect(JSON.stringify(body)).not.toContain(syntheticKey);
    expect(JSON.stringify(body.tools)).not.toMatch(/list_files|write_file|shell|exec|command|fetch|github|browser|install/i);
  });

  it("collects a structured proposal without writing the worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-proposal-")); roots.push(root); const original = "export const a = 1;\n"; await writeFile(path.join(root, "a.ts"), original);
    const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public"); let call = 0;
    const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => {
      call++;
      const message = call === 1
        ? { content: "", tool_calls: [{ id: "p1", type: "function", function: { name: "propose_patch", arguments: JSON.stringify({ path: "a.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "export const a = 2;\n" }) } }] }
        : { content: "proposal complete" };
      return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message }], usage: {} }), { status: 200 });
    } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }));
    expect(response.structuredPatches).toEqual([{ path: "a.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "export const a = 2;\n" }]);
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(original);
  });

  it("rejects unknown shell or network tools without a second transport call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-unknown-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n"); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    let calls = 0; const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "", tool_calls: [{ id: "x", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "synthetic" }) } }] } }], usage: {} }), { status: 200 }); } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    await expect(adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }))).rejects.toThrow(/Unknown/);
    expect(calls).toBe(1);
  });

  it("does not apply an in-memory proposal when the final transport response is lost", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-reset-")); roots.push(root); const original = "export const a = 1;\n"; await writeFile(path.join(root, "a.ts"), original); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    let calls = 0; const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => {
      calls++; if (calls === 2) throw new Error("synthetic reset after proposal");
      return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: "propose_patch", arguments: JSON.stringify({ path: "a.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "export const a = 2;\n" }) } }] } }], usage: {} }), { status: 200 });
    } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    await expect(adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }))).rejects.toThrow(/reset/);
    expect(calls).toBe(2); expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(original);
  });

  it("enforces a total tool-call budget even within one assistant turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-budget-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n"); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    let calls = 0; const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "", tool_calls: Array.from({ length: 11 }, (_, index) => ({ id: `l${index}`, type: "function", function: { name: "list_manifest", arguments: "{}" } })) } }], usage: {} }), { status: 200 }); } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    await expect(adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }))).rejects.toThrow(/budget/);
    expect(calls).toBe(1);
  });

  it("rejects filesystem capabilities on non-code DeepSeek stages before transport", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-noncode-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n"); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    let calls = 0; const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => { calls++; return new Response("{}", { status: 200 }); } });
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note"));
    await expect(adapter.invoke(bound({ stage: "TEXT_EXPAND", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }))).rejects.toThrow(/Non-code/);
    expect(calls).toBe(0);
  });

  it("rejects a linked-worktree .git control file before transport or write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-git-control-")); roots.push(root); const control = "gitdir: C:/Synthetic/common/worktrees/run\n"; await writeFile(path.join(root, ".git"), control); const bytes = Buffer.from(control);
    const grant = { readManifest: [{ path: ".git", contentHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, dataClassification: "public" as const }], writeScope: [".git"], maxFileBytes: 1_000_000 };
    let calls = 0; const adapter = testAdapter({ apiKey: "synthetic", fetchImpl: async () => { calls++; return new Response("{}", { status: 200 }); } }); const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    await expect(adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }))).rejects.toThrow(/credential|environment|denied/);
    expect(calls).toBe(0); expect(await readFile(path.join(root, ".git"), "utf8")).toBe(control);
  });

  it.each([
    ["wrong URL", { url: "https://example.invalid/chat/completions", redirected: false, status: 200, model: "deepseek-v4-flash" }],
    ["missing URL", { url: "", redirected: false, status: 200, model: "deepseek-v4-flash" }],
    ["redirect flag", { url: targetUrl, redirected: true, status: 200, model: "deepseek-v4-flash" }],
    ["redirect status", { url: targetUrl, redirected: false, status: 302, model: "deepseek-v4-flash" }],
    ["wrong model", { url: targetUrl, redirected: false, status: 200, model: "deepseek-v4-pro" }],
  ])("returns incomplete evidence for %s before processing a tool", async (_name, item) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-identity-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug")); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public");
    const fetchImpl: typeof fetch = async () => responseAt({ id: "identity-1", model: item.model, choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: "propose_patch", arguments: JSON.stringify({ path: "a.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "changed" }) } }] } }], usage: {} }, item);
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl });
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }));
    expect(response.routeEvidence).toMatchObject({ routeTupleVerified: false, evidenceComplete: false }); expect(response.structuredPatches).toBeUndefined();
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("validates a later tool-loop response before exposing an earlier proposal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-late-identity-")); roots.push(root); const original = "export const a = 1;\n"; await writeFile(path.join(root, "a.ts"), original);
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug")); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public"); let calls = 0;
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl: async () => {
      calls++;
      if (calls === 1) return responseAt({ id: "turn-1", model: route.model, choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: "propose_patch", arguments: JSON.stringify({ path: "a.ts", preimageHash: grant.readManifest[0].contentHash, replacement: "export const a = 2;\n" }) } }] } }], usage: {} }, { url: targetUrl });
      return responseAt({ id: "turn-2", model: route.model, choices: [{ message: { content: "done" } }], usage: {} }, { url: "https://example.invalid/chat/completions" });
    } });
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }));
    expect(calls).toBe(2); expect(response.routeEvidence?.observations).toHaveLength(2); expect(response.routeEvidence?.routeTupleVerified).toBe(false); expect(response.structuredPatches).toBeUndefined();
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(original);
  });

  it.each(["wrong model", "missing request ID", "multiple request ID headers"])("fails a later tool turn with %s before another tool executes", async failure => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-late-evidence-")); roots.push(root); await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug")); const grant = await buildExecutorCapabilityGrant(root, ["a.ts"], ["a.ts"], "public"); let calls = 0;
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl: async () => {
      calls++;
      if (calls === 1) return responseAt({ id: "turn-1", model: route.model, choices: [{ message: { content: "", tool_calls: [{ id: "l", type: "function", function: { name: "list_manifest", arguments: "{}" } }] } }], usage: {} }, { url: targetUrl });
      const model = failure === "wrong model" ? "deepseek-v4-pro" : route.model; const id = failure === "missing request ID" ? undefined : "turn-2";
      const headers = failure === "multiple request ID headers" ? { "x-request-id": "one", "request-id": "two" } : undefined;
      return responseAt({ id, model, choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: "propose_patch", arguments: "{}" } }] } }], usage: {} }, { url: targetUrl, headers });
    } });
    const response = await adapter.invoke(bound({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, executorCapabilities: grant }));
    expect(calls).toBe(2); expect(response.routeEvidence?.observations.at(-1)?.routeTupleVerified).toBe(false); expect(response.structuredPatches).toBeUndefined();
  });

  it.each([301, 302, 303, 307, 308].flatMap(status => ["/other", targetUrl, "https://example.invalid/capture"].map(location => [status, location] as const)))("never follows redirect status %s to %s or sends authorization twice", async (status, location) => {
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note")); let calls = 0;
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl: async (input, init) => {
      calls++; expect(init?.redirect).toBe("manual");
      expect(String(input)).toBe(targetUrl); expect((init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic");
      return responseAt({}, { url: targetUrl, status, headers: { location } });
    } });
    const response = await adapter.invoke(bound({ stage: "TEXT_EXPAND", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }));
    expect(calls).toBe(1); expect(response.routeEvidence).toMatchObject({ routeTupleVerified: false, verificationStatus: "incomplete" }); expect(response.routeEvidence?.unverifiedReasons).toContain("redirect_rejected");
  });

  it.each([
    ["body", "body-1", undefined, "body"],
    ["header", undefined, "header-1", "header"],
    ["body and header", "same-1", "same-1", "body_and_header"],
    ["distinct body response and header request", "response-1", "request-1", "body_and_header"],
  ])("accepts a validated %s request ID", async (_name, bodyId, headerId, source) => {
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note"));
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl: async () => responseAt({ id: bodyId, model: route.model, choices: [{ message: { content: "done" } }], usage: {} }, { url: targetUrl, headers: headerId ? { "x-request-id": headerId } : undefined }) });
    const response = await adapter.invoke(bound({ stage: "TEXT_EXPAND", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }));
    expect(response.requestId).toBe(headerId ?? bodyId); expect(response.routeEvidence?.requestIdSource).toBe(source);
    expect(response.routeEvidence?.bodyResponseIds).toEqual([bodyId ?? null]); expect(response.routeEvidence?.headerRequestIds).toEqual([headerId ?? null]);
  });

  it.each([
    ["missing", undefined, undefined],
    ["control-bearing", "bad\nvalue", undefined],
    ["combined header", undefined, { "x-request-id": "one, two" }],
    ["multiple request headers", undefined, { "x-request-id": "one", "request-id": "two" }],
  ])("fails closed for %s request ID evidence", async (_name, bodyId, headers) => {
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note"));
    const adapter = new DeepSeekChatAdapter({ credentialResolver: () => "synthetic", fetchImpl: async () => responseAt({ id: bodyId, model: route.model, choices: [{ message: { content: "done" } }], usage: {} }, { url: targetUrl, headers }) });
    const response = await adapter.invoke(bound({ stage: "TEXT_EXPAND", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" }));
    expect(response.requestId).toBeNull(); expect(response.routeEvidence).toMatchObject({ routeTupleVerified: false, evidenceComplete: false });
  });

  it("rejects absent or mutated bindings before credential resolution and fetch", async () => {
    const route = decideRoute("TEXT_EXPAND", classifyTask("Expand a short public note")); const resolver = vi.fn(() => "synthetic"); const fetchImpl = vi.fn();
    const adapter = new DeepSeekChatAdapter({ credentialResolver: resolver, fetchImpl: fetchImpl as typeof fetch });
    const request = bound({ stage: "TEXT_EXPAND", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal" });
    await expect(adapter.invoke({ ...request, routeBinding: undefined })).rejects.toThrow(/RouteBinding/);
    await expect(adapter.invoke({ ...request, routeBinding: { ...request.routeBinding!, endpoint_path: "/v1/chat/completions" } })).rejects.toThrow(/hash|endpoint/);
    expect(resolver).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function testAdapter(options: { apiKey: string; fetchImpl: typeof fetch }): DeepSeekChatAdapter {
  return new DeepSeekChatAdapter({
    credentialResolver: () => options.apiKey,
    fetchImpl: async (input, init) => {
      const response = await options.fetchImpl(input, init);
      if (!response.url) Object.defineProperty(response, "url", { value: targetUrl });
      if (response.redirected === undefined) Object.defineProperty(response, "redirected", { value: false });
      return response;
    },
  });
}

function bound(request: Omit<ProviderRequest, "routeBinding">): ProviderRequest {
  const readScope = request.executorCapabilities?.readManifest.map(item => item.path) ?? ["synthetic.txt"];
  const writeScope = request.executorCapabilities?.writeScope ?? ["synthetic.txt"];
  return { ...request, routeBinding: buildLegacyRouteBinding(request.route, readScope, writeScope) };
}

function responseAt(payload: unknown, options: { url?: string; redirected?: boolean; status?: number; headers?: HeadersInit }): Response {
  const response = new Response(JSON.stringify(payload), { status: options.status ?? 200, headers: options.headers });
  Object.defineProperty(response, "url", { value: options.url ?? targetUrl });
  Object.defineProperty(response, "redirected", { value: options.redirected ?? false });
  return response;
}
