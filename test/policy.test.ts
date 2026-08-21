import { describe, expect, it } from "vitest";
import { approvePlan, assertApproval } from "../src/approval.js";
import { classifyTask } from "../src/classifier.js";
import { createRouteBinding } from "../src/contracts.js";
import { decideRoute } from "../src/policy.js";
import { buildLegacyRouteBinding } from "../src/route-preflight.js";
import type { PlanPacket } from "../src/types.js";

describe("deterministic routing", () => {
  it("uses Terra low for normal planning", () => {
    const route = decideRoute("PLAN", classifyTask("Fix a parser bug"));
    expect(route).toMatchObject({ model: "gpt-5.6-terra", effort: "low" });
  });
  it("uses Terra medium for complex planning", () => {
    expect(decideRoute("PLAN", classifyTask("Cross-module architecture work"))).toMatchObject({ model: "gpt-5.6-terra", effort: "medium" });
  });
  it("uses Sol medium for high-risk planning", () => {
    expect(decideRoute("PLAN", classifyTask("Production authentication migration"))).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });
  });
  it("uses Flash none for ordinary text expansion", () => {
    expect(decideRoute("TEXT_EXPAND", classifyTask("Write a proposal document"))).toMatchObject({ model: "deepseek-v4-flash", effort: "none" });
  });
  it("disables thinking for ordinary Flash code because DeepSeek low maps to high", () => {
    expect(decideRoute("EXECUTE", classifyTask("Fix a bounded parser bug"))).toMatchObject({ model: "deepseek-v4-flash", effort: "none" });
  });
  it("uses Pro high for complex execution", () => {
    expect(decideRoute("EXECUTE", classifyTask("Cross-module architecture refactor"))).toMatchObject({ model: "deepseek-v4-pro", effort: "high" });
  });
  it("never sends private work to DeepSeek", () => {
    expect(decideRoute("EXECUTE", classifyTask("Fix private proprietary source"))).toMatchObject({ provider: "openai-codex", model: "gpt-5.6-terra", promptCacheKey: undefined });
  });
});

describe("approval binding", () => {
  const route = decideRoute("EXECUTE", classifyTask("Fix a parser bug"));
  const plan: PlanPacket = { version: 1, taskId: "t1", objective: "fix", nonGoals: [], steps: ["edit"], readFiles: ["src/a.ts"], writeFiles: ["src/a.ts"], dataClassification: "public", allowedFiles: ["src/a.ts"], constraints: [], acceptance: ["tests pass"], validationCommands: ["npm test"], route, routeBinding: buildLegacyRouteBinding(route, ["src/a.ts"], ["src/a.ts"]) };
  it("accepts an unchanged plan and route", () => expect(() => assertApproval(plan, approvePlan(plan))).not.toThrow());
  it("invalidates approval after plan change", () => {
    const approval = approvePlan(plan);
    expect(() => assertApproval({ ...plan, allowedFiles: ["src/b.ts"] }, approval)).toThrow(/invalidated/);
    expect(() => assertApproval({ ...plan, readFiles: ["src/b.ts"] }, approval)).toThrow(/invalidated/);
    expect(() => assertApproval({ ...plan, writeFiles: ["src/b.ts"] }, approval)).toThrow(/invalidated/);
    expect(() => assertApproval({ ...plan, dataClassification: "private" }, approval)).toThrow(/invalidated/);
  });
  it("invalidates approval after budget change", () => {
    const approval = approvePlan(plan);
    expect(() => assertApproval({ ...plan, route: { ...plan.route, maxOutputTokens: 99 } }, approval)).toThrow(/invalidated/);
  });
  it("invalidates approval after any route binding tuple change", () => {
    const approval = approvePlan(plan);
    const changedRoute = { ...plan.route, maxOutputTokens: plan.route.maxOutputTokens + 1 };
    const changed = { ...plan, route: changedRoute, routeBinding: buildLegacyRouteBinding(changedRoute, plan.readFiles, plan.writeFiles) };
    expect(() => assertApproval(changed, approval)).toThrow(/invalidated/);
  });
  it.each([
    ["provider", { provider_id: "openai-codex" }], ["adapter", { adapter_id: "other-adapter" }],
    ["model", { model_id: "deepseek-v4-pro" }], ["origin", { endpoint_origin: "https://api.openai.com" }],
    ["path", { endpoint_path: "/v1/responses" }], ["protocol", { wire_protocol: "responses" }],
    ["auth alias", { auth_alias: "other-auth" }], ["reasoning mode", { reasoning_mode: "enabled" }],
    ["reasoning effort", { reasoning_effort: "high" }],
    ["budget", { request_budget: { ...plan.routeBinding.request_budget, max_output_tokens: plan.routeBinding.request_budget.max_output_tokens + 1 } }],
    ["read scope", { read_scope: ["src/b.ts"] }], ["write scope", { write_scope: ["src/b.ts"] }],
    ["network scope", { network_scope: ["https://api.openai.com"] }], ["environment scope", { environment_scope: ["OTHER_ENV"] }],
    ["command scope", { command_scope: ["other-command"] }],
  ])("invalidates legacy approval after %s binding changes", (_name, patch) => {
    const approval = approvePlan(plan); const { route_binding_hash: _hash, ...body } = plan.routeBinding;
    const routeBinding = createRouteBinding({ ...body, ...patch } as Parameters<typeof createRouteBinding>[0]);
    expect(() => assertApproval({ ...plan, routeBinding }, approval)).toThrow(/invalidated/);
  });
  it("invalidates approval after isolation binding change", () => {
    const approval = approvePlan(plan, "a".repeat(64));
    expect(() => assertApproval(plan, approval, "b".repeat(64))).toThrow(/isolation/);
  });
});
