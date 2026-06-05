import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rerank } from "../src/tools/rerank.js";

const row = (id: number, similarity: number) => ({
  id,
  content: `c${id}`,
  file_origin: "f",
  chunk_index: 0,
  metadata: {},
  similarity,
});
const W = new Map<number, number>([[100, 1.5]]); // concept 100 is hot
const bridge = [
  { concept_id: 100, chunk_id: 20, w_ck: 1 },
  { concept_id: 100, chunk_id: 99, w_ck: 1 },
];

describe("rerank (concept-bridge)", () => {
  it("alpha=1 preserves pure-vector order (non-regression)", () => {
    const out = rerank({
      candidates: [row(10, 0.5), row(20, 0.8)],
      expansion: [],
      conceptWeights: W,
      bridge,
      params: { alpha: 1 },
    });
    assert.deepEqual(out.map((r) => r.id), [20, 10]);
  });

  it("alpha=0.3 lifts a concept-sharing chunk over a higher-vector unconnected one", () => {
    // chunk 20 shares hot concept 100 (g_raw=1.5); chunk 88 shares nothing but higher vector.
    const out = rerank({
      candidates: [row(20, 0.5), row(88, 0.55)],
      expansion: [],
      conceptWeights: W,
      bridge,
      params: { alpha: 0.3 },
    });
    assert.equal(out[0].id, 20);
  });

  it("merges an expansion chunk into the ranking (the S16-D1 cure)", () => {
    // chunk 99 is bridged (g_raw=1.5) but only arrives via expansion; at alpha=0.3 it tops a low-vector candidate.
    const out = rerank({
      candidates: [row(7, 0.4)],
      expansion: [row(99, 0.3)],
      conceptWeights: W,
      bridge,
      params: { alpha: 0.3 },
    });
    assert.equal(out[0].id, 99);
  });
});
