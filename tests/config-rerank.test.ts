import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

describe("graph rerank config defaults", () => {
  it("ships off with spec-aligned defaults", () => {
    assert.equal(config.SCM_GRAPH_RERANK_ENABLED, false);
    assert.equal(config.SCM_GRAPH_RERANK_ALPHA, 0.7);
    assert.equal(config.SCM_GRAPH_RERANK_POOL, 40);
    assert.equal(config.SCM_GRAPH_RERANK_EXPAND, 10);
    assert.equal(config.SCM_GRAPH_RERANK_TIMEOUT_MS, 50);
  });
});
