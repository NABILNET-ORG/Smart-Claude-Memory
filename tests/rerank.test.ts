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

  it("alpha=0.3 lifts a concept-sharing chunk over a lower unconnected one, never past the pinned top-1 (SCM-S53)", () => {
    // chunk 88 is the vector top-1 (unconnected) → PINNED. chunk 20 shares hot
    // concept 100 (g_raw=1.5); chunk 50 is unconnected with a higher vector than
    // 20. At alpha=0.3 the bridge lifts 20 over 50 (to rank 2), but the non-
    // demoting pin keeps 88 at rank 1 — graph may reorder ranks 2+, never the anchor.
    const out = rerank({
      candidates: [row(88, 0.55), row(50, 0.52), row(20, 0.5)],
      expansion: [],
      conceptWeights: W,
      bridge,
      params: { alpha: 0.3 },
    });
    assert.deepEqual(out.map((r) => r.id), [88, 20, 50]);
  });

  it("merges an expansion chunk into the ranking, bounded by the top-1 pin (SCM-S53)", () => {
    // chunk 99 is bridged (g_raw=1.5) but only arrives via expansion; at alpha=0.3
    // its fused score beats the lone low-vector candidate. Under the SCM-S53 non-
    // demoting pin the vector top-1 (chunk 7) stays at rank 1; the recovered
    // expansion chunk still merges in — promoted to rank 2 (the S16-D1 cure,
    // bounded so it can never sacrifice the strongest semantic anchor).
    const out = rerank({
      candidates: [row(7, 0.4)],
      expansion: [row(99, 0.3)],
      conceptWeights: W,
      bridge,
      params: { alpha: 0.3 },
    });
    assert.deepEqual(out.map((r) => r.id), [7, 99]);
  });
});
