import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { decideRoute } from "../src/policy.js";
import { DeepSeekChatAdapter } from "../src/providers/deepseek-chat.js";

const roots: string[] = [];
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
    const adapter = new DeepSeekChatAdapter({ apiKey: "test", fetchImpl });
    const route = decideRoute("EXECUTE", classifyTask("Cross-module architecture refactor"));
    const response = await adapter.invoke({ stage: "EXECUTE", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal", workingDirectory: root, allowedFiles: ["a.ts"] });
    expect(response.text).toBe("done");
    expect(requests[0].reasoning_effort).toBe("high");
    expect(requests[0].thinking).toEqual({ type: "enabled" });
    expect(requests[1].messages[2].reasoning_content).toBe("inspect first");
    expect(requests[1].messages[3]).toMatchObject({ role: "tool", tool_call_id: "t1" });
    expect(response.usage.cacheHitTokens).toBe(12);
  });

  it("explicitly disables thinking for normal Flash execution", async () => {
    let body: any;
    const adapter = new DeepSeekChatAdapter({ apiKey: "test", fetchImpl: async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ id: "r", model: "deepseek-v4-flash", choices: [{ message: { content: "done" } }], usage: {} }), { status: 200 }); } });
    const route = decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"));
    await adapter.invoke({ stage: "EXECUTE", route, stablePrefix: "stable", projectSummary: "project", dynamicInput: "task", sensitivity: "normal" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("does not expose credential paths to DeepSeek tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-secret-")); roots.push(root);
    await writeFile(path.join(root, ".env"), "API_KEY=secret", "utf8");
    let call = 0;
    const adapter = new DeepSeekChatAdapter({ apiKey: "test", fetchImpl: async () => {
      call++;
      const payload = call === 1
        ? { id: "r", model: "deepseek-v4-pro", choices: [{ message: { content: "", reasoning_content: "", tool_calls: [{ id: "t", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: ".env" }) } }] } }], usage: {} }
        : { id: "r", model: "deepseek-v4-pro", choices: [{ message: { content: "done" } }], usage: {} };
      return new Response(JSON.stringify(payload), { status: 200 });
    } });
    const route = decideRoute("EXECUTE", classifyTask("Cross-module architecture refactor"));
    await expect(adapter.invoke({ stage: "EXECUTE", route, stablePrefix: "s", projectSummary: "p", dynamicInput: "t", sensitivity: "normal", workingDirectory: root, allowedFiles: ["**/*"] })).rejects.toThrow(/sensitive path/);
  });
});
