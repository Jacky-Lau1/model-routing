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
    expect(canTransition("EXECUTING", "BLOCKED")).toBe(true);
    expect(() => assertTransition("PASSED", "EXECUTING")).toThrow();
  });
});
