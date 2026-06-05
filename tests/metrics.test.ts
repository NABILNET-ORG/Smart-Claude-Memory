import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, mrr } from "../src/tools/metrics.js";

describe("recallAtK", () => {
  it("is 1 only when the gold id is within the top-k", () => {
    assert.equal(recallAtK([5, 7, 9], 7, 3), 1);
    assert.equal(recallAtK([5, 1, 9], 7, 3), 0);
    assert.equal(recallAtK([1, 2, 3, 7], 7, 3), 0); // gold at rank 4 — outside top-3
  });
});

describe("mrr", () => {
  it("is the reciprocal of the gold rank (0 if absent)", () => {
    assert.equal(mrr([7, 1, 9], 7), 1);
    assert.equal(mrr([5, 7, 9], 7), 1 / 2);
    assert.equal(mrr([5, 1, 9], 7), 0);
  });
});
