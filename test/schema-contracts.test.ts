import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertApprovalRecord, assertAttemptRecord, assertEvidenceBundle, assertExecutionContext, assertRouteBinding, assertTaskPackage } from "../src/contracts.js";
import { assertQualityGatePolicy } from "../src/quality-gate.js";
import { resolveEffectivePolicy } from "../src/policy.js";

const root = process.cwd();

describe("S1 JSON Schema artifacts", () => {
  it("exposes strict schemas for all separated records", async () => {
    const schema = JSON.parse(await readFile(path.join(root, "config/data-contracts.schema.json"), "utf8")) as any;
    for (const name of ["TaskPackage", "RouteBinding", "ExecutionContext", "ApprovalRecord", "AttemptRecord", "EvidenceBundle", "UserPolicy", "ProjectPolicy", "EffectivePolicy"]) {
      expect(schema.$defs[name], name).toBeDefined();
      expect(schema.$defs[name].additionalProperties, name).toBe(false);
    }
    expect(schema.$defs.PathScope.minItems).toBe(1);
    expect(schema.$defs.RequestBudget.additionalProperties).toBe(false);
  });

  it("encodes dangerous-path and secret-like context rejection", async () => {
    const schema = JSON.parse(await readFile(path.join(root, "config/data-contracts.schema.json"), "utf8")) as any;
    const pathPattern = new RegExp(schema.$defs.SafeRelativePath.pattern);
    expect(pathPattern.test("src/synthetic.ts")).toBe(true);
    expect(pathPattern.test("C:/Users/example/private.ts")).toBe(false);
    expect(pathPattern.test("/etc/passwd")).toBe(false);
    expect(pathPattern.test("../outside.ts")).toBe(false);
    const secretPattern = new RegExp(schema.$defs.SafeText.not.pattern, "i");
    expect(secretPattern.test("Synthetic fixture summary")).toBe(false);
    expect(secretPattern.test("api_key=synthetic-secret-value")).toBe(true);
  });

  it("keeps individual schema entrypoints and compatibility aliases", async () => {
    const expected: Record<string, string> = {
      "task-package.schema.json": "TaskPackage", "route-binding.schema.json": "RouteBinding", "execution-context.schema.json": "ExecutionContext",
      "approval-record.schema.json": "ApprovalRecord", "attempt-record.schema.json": "AttemptRecord", "evidence-bundle.schema.json": "EvidenceBundle",
      "task-packet.schema.json": "TaskPackage", "run-report.schema.json": "EvidenceBundle",
    };
    for (const [file, definition] of Object.entries(expected)) {
      const schema = JSON.parse(await readFile(path.join(root, "config", file), "utf8")) as { $ref: string };
      expect(schema.$ref).toContain(`#/$defs/${definition}`);
    }
  });

  it("keeps the S6 quality policy schema and default-deny example strict and hash-valid", async () => {
    const schema = JSON.parse(await readFile(path.join(root, "config/quality-gate-policy.schema.json"), "utf8")) as any;
    expect(schema.additionalProperties).toBe(false); expect(schema.required).toContain("command_registry_hash");
    expect(schema.properties.max_diff_bytes.maximum).toBe(16 * 1024 * 1024); expect(schema.properties.max_file_bytes.maximum).toBe(4 * 1024 * 1024); expect(schema.properties.max_output_bytes.maximum).toBe(1024 * 1024); expect(schema.properties.max_wall_time_ms.maximum).toBe(30 * 60_000);
    const example = JSON.parse(await readFile(path.join(root, "config/quality-gate-policy.example.json"), "utf8"));
    expect(() => assertQualityGatePolicy(example)).not.toThrow(); expect(example.command_ids).toEqual([]);
    const legacyPlan = JSON.parse(await readFile(path.join(root, "config/plan-packet.schema.json"), "utf8")) as any;
    expect(legacyPlan.required).toContain("qualityPolicyHash"); expect(legacyPlan.properties.validationCommands.items.enum).not.toContain("npm test");
  });

  it("keeps every synthetic JSON example strict and hash-valid", async () => {
    const cases: Array<[string, (value: unknown) => void]> = [
      ["task-package.example.json", assertTaskPackage], ["task-packet.example.json", assertTaskPackage],
      ["s10a-task-package.template.json", assertTaskPackage],
      ["route-binding.example.json", assertRouteBinding], ["execution-context.example.json", assertExecutionContext],
      ["s10a-route-binding.template.json", assertRouteBinding],
      ["approval-record.example.json", assertApprovalRecord], ["attempt-record.example.json", assertAttemptRecord],
      ["evidence-bundle.example.json", assertEvidenceBundle], ["run-report.example.json", assertEvidenceBundle],
    ];
    for (const [file, validate] of cases) {
      const example = JSON.parse(await readFile(path.join(root, "examples", file), "utf8"));
      expect(() => validate(example), file).not.toThrow();
    }
  });

  it("keeps the versioned Pilot report JSON Schema strict", async () => {
    const schema = JSON.parse(await readFile(path.join(root, "config/pilot-report.schema.json"), "utf8")) as any;
    expect(schema.oneOf).toHaveLength(2); expect(schema.$defs.PilotRunRecord.additionalProperties).toBe(false); expect(schema.$defs.PilotPairReport.additionalProperties).toBe(false);
    expect(schema.$defs.PilotRunRecord.required).toContain("provider_http_request_count"); expect(schema.$defs.PilotRunRecord.required).toContain("core_metrics_unavailable");
  });

  it("keeps the pending S10a policy pair hash-valid and narrowly intersected", async () => {
    const user = JSON.parse(await readFile(path.join(root, "config/s10a-user-policy.template.json"), "utf8")); const project = JSON.parse(await readFile(path.join(root, "config/s10a-project-policy.template.json"), "utf8"));
    const effective = resolveEffectivePolicy(user, project);
    expect(effective.write_scope).toEqual(["benchmark/fixtures/simple-sum/src/sum.mjs"]); expect(effective.budget_ceiling).toMatchObject({ max_attempts: 2, max_provider_requests: 6, max_estimated_cost_usd: 0.00308 });
  });
});
