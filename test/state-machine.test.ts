import { describe, expect, it } from "vitest";
import { assertLegacyTransition, assertTransition, canLegacyTransition, canTransition } from "../src/state-machine.js";

describe("state machine", () => {
  it("requires approval between planning and execution", () => {
    expect(canLegacyTransition("PLANNING", "EXECUTING")).toBe(false);
    expect(canLegacyTransition("WAITING_APPROVAL", "EXECUTING")).toBe(true);
  });
  it("rejects invalid terminal transitions", () => expect(() => assertLegacyTransition("COMPLETED", "EXECUTING")).toThrow());
  it("keeps attempt lifecycle out of the workflow state machine", () => {
    expect(canTransition("APPROVED", "EXECUTING")).toBe(true);
    expect(canTransition("APPROVED", "WORKTREE_READY")).toBe(true);
    expect(canTransition("WORKTREE_READY", "EXECUTING")).toBe(true);
    expect(canTransition("EXECUTING", "BLOCKED")).toBe(true);
    expect(() => assertTransition("PASSED", "EXECUTING")).toThrow();
  });

  it("requires explicit APPLY_PENDING between foreground PASS and PASSED", () => {
    expect(canTransition("REVIEW_PENDING", "APPLY_PENDING")).toBe(true);
    expect(canTransition("REVIEW_PENDING", "PASSED")).toBe(false);
    expect(canTransition("APPLY_PENDING", "PASSED")).toBe(true);
  });
});
