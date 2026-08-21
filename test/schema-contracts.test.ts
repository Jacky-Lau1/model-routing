import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertApprovalRecord, assertAttemptRecord, assertEvidenceBundle, assertExecutionContext, assertRouteBinding, assertTaskPackage } from "../src/contracts.js";

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

  it("keeps every synthetic JSON example strict and hash-valid", async () => {
    const cases: Array<[string, (value: unknown) => void]> = [
      ["task-package.example.json", assertTaskPackage], ["task-packet.example.json", assertTaskPackage],
      ["route-binding.example.json", assertRouteBinding], ["execution-context.example.json", assertExecutionContext],
      ["approval-record.example.json", assertApprovalRecord], ["attempt-record.example.json", assertAttemptRecord],
      ["evidence-bundle.example.json", assertEvidenceBundle], ["run-report.example.json", assertEvidenceBundle],
    ];
    for (const [file, validate] of cases) {
      const example = JSON.parse(await readFile(path.join(root, "examples", file), "utf8"));
      expect(() => validate(example), file).not.toThrow();
    }
  });
});
