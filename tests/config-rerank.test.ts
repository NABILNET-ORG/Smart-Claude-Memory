import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

describe("graph rerank config defaults", () => {
  it("ships off with spec-aligned defaults", () => {
    assert.equal(config.SCM_GRAPH_RERANK_ENABLED, false);
    assert.equal(config.SCM_GRAPH_RERANK_ALPHA, 0.7);
    assert.equal(config.SCM_GRAPH_RERANK_POOL, 40);
    assert.equal(config.SCM_GRAPH_RERANK_EXPAND, 10);
    assert.equal(config.SCM_GRAPH_RERANK_TIMEOUT_MS, 1500); // 50ms sat below real DB RTT (~167-213ms) → always timed out (SCM-S51)
  });
});

describe("LLM listwise rerank config defaults (SCM-S54)", () => {
  it("ships ON with the bake-off-winning model + non-demoting pin", () => {
    // SCM-S54 verdict: ENABLED ON by default — qwen3-coder:480b-cloud + the
    // non-demoting top-1 pin cleared the strict flip-rule.
    assert.equal(config.SCM_LLM_RERANK_ENABLED, true);
    assert.equal(config.SCM_RERANK_MODEL, "qwen3-coder:480b-cloud"); // bake-off winner
    assert.equal(config.SCM_LLM_RERANK_PIN_TOP1, true); // non-demoting anchor stays on
    assert.equal(config.SCM_LLM_RERANK_POOL, 12);
    assert.equal(config.SCM_LLM_RERANK_SNIPPET, 400);
    assert.equal(config.SCM_LLM_RERANK_TIMEOUT_MS, 8000);
  });
});
