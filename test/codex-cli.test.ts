import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/classifier.js";
import { decideRoute } from "../src/policy.js";
import { parseCodexJsonLines } from "../src/providers/codex-cli.js";
import type { ProviderRequest } from "../src/types.js";

const route = decideRoute("PLAN", classifyTask("Fix a bounded parser bug"));
const request: ProviderRequest = { stage: "PLAN", route, stablePrefix: "stable", projectSummary: "synthetic", dynamicInput: "task", sensitivity: "normal" };

describe("Codex CLI observable evidence boundary", () => {
  it("does not promote a generic event or item ID to provider request evidence", () => {
    const output = [
      JSON.stringify({ type: "thread.started", id: "generic-thread-id" }),
      JSON.stringify({ type: "item.completed", id: "generic-item-id", item: { type: "agent_message", text: "done" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join("\n");
    expect(parseCodexJsonLines(output, request)).toMatchObject({ requestId: null, model: "", text: "done" });
  });

  it("records only explicit request/response ID and model fields without approved-value fallback", () => {
    const output = [
      JSON.stringify({ type: "response.created", response_id: "synthetic-response-id", model: "gpt-5.6-terra" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n");
    expect(parseCodexJsonLines(output, request)).toMatchObject({ requestId: "synthetic-response-id", model: "gpt-5.6-terra", text: "done" });
  });

  it("drops oversized or control-bearing identifiers", () => {
    const output = [
      JSON.stringify({ type: "response.created", response_id: "x".repeat(257), model: "bad\nmodel" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n");
    expect(parseCodexJsonLines(output, request)).toMatchObject({ requestId: null, model: "" });
  });
});
