import assert from "node:assert/strict";
import test from "node:test";
import { sumPositive } from "../src/sum.mjs";

test("sums ordinary positive numbers", () => {
  assert.equal(sumPositive([1, 2, 3]), 6);
});

test("ignores ordinary negative numbers", () => {
  assert.equal(sumPositive([-2, 5, -1]), 5);
});
