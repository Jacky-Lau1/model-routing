import { describe, expect, it } from "vitest";
import { assertAllowedChanges, changedSince, type ScopeSnapshot } from "../src/scope-guard.js";

describe("scope guard", () => {
  it("detects content changes including pre-existing dirty files", () => {
    const before: ScopeSnapshot = new Map([["src/a.ts", "old"]]);
    const after: ScopeSnapshot = new Map([["src/a.ts", "new"]]);
    expect(changedSince(before, after)).toEqual(["src/a.ts"]);
    expect(() => assertAllowedChanges(before, after, ["src/a.ts"])).not.toThrow();
    expect(() => assertAllowedChanges(before, after, ["src/b.ts"])).toThrow(/outside approved scope/);
  });
  it("supports bounded glob patterns", () => {
    expect(() => assertAllowedChanges(new Map(), new Map([["src/lib/a.ts", "x"]]), ["src/**/*.ts"])).not.toThrow();
  });
});
