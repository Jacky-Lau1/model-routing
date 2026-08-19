import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "../src/state-machine.js";

describe("state machine", () => {
  it("requires approval between planning and execution", () => {
    expect(canTransition("PLANNING", "EXECUTING")).toBe(false);
    expect(canTransition("WAITING_APPROVAL", "EXECUTING")).toBe(true);
  });
  it("rejects invalid terminal transitions", () => expect(() => assertTransition("COMPLETED", "EXECUTING")).toThrow());
});
