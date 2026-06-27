// Unit test for the trajectory_summaries row mapper used by the backfill script.
// Pure function — no DB, no Ollama.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { buildSummaryRow } from "../src/trajectory/backfill-row.js";

describe("buildSummaryRow", () => {
  test("maps chunk + summary + embedding into a trajectory_summaries row", () => {
    const row = buildSummaryRow(
      "claude-memory",
      { chunk_id: 42, content: "x".repeat(400) },
      { summary: "did a thing", summaryTokens: 3, model: "gemma3:e2b" },
      [0.1, 0.2, 0.3],
    );
    assert.equal(row.project_id, "claude-memory");
    assert.equal(row.source_chunk_id, 42);
    assert.equal(row.summary, "did a thing");
    assert.deepEqual(row.summary_embedding, [0.1, 0.2, 0.3]);
    assert.equal(row.source_tokens, 100); // ceil(400 / 4)
    assert.equal(row.summary_tokens, 3);
    assert.equal(row.strategy, "backfill");
    assert.equal(row.model, "gemma3:e2b");
  });

  test("source_tokens is clamped to >=1 (satisfies the NOT NULL >=0 check) and null embedding passes through", () => {
    const row = buildSummaryRow(
      "p",
      { chunk_id: 1, content: "" },
      { summary: "s", summaryTokens: 1, model: "m" },
      null,
    );
    assert.ok(row.source_tokens >= 1);
    assert.equal(row.summary_embedding, null);
  });
});
