import { describe, expect, it } from "vitest";
import { approvePlan, assertApproval } from "../src/approval.js";
import { classifyTask } from "../src/classifier.js";
import { decideRoute } from "../src/policy.js";
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
  const plan: PlanPacket = { version: 1, taskId: "t1", objective: "fix", nonGoals: [], steps: ["edit"], allowedFiles: ["src/a.ts"], constraints: [], acceptance: ["tests pass"], validationCommands: ["npm test"], route };
  it("accepts an unchanged plan and route", () => expect(() => assertApproval(plan, approvePlan(plan))).not.toThrow());
  it("invalidates approval after plan change", () => {
    const approval = approvePlan(plan);
    expect(() => assertApproval({ ...plan, allowedFiles: ["src/b.ts"] }, approval)).toThrow(/invalidated/);
  });
  it("invalidates approval after budget change", () => {
    const approval = approvePlan(plan);
    expect(() => assertApproval({ ...plan, route: { ...plan.route, maxOutputTokens: 99 } }, approval)).toThrow(/invalidated/);
  });
  it("invalidates approval after isolation binding change", () => {
    const approval = approvePlan(plan, "a".repeat(64));
    expect(() => assertApproval(plan, approval, "b".repeat(64))).toThrow(/isolation/);
  });
});
