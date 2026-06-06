import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Concept-bridge re-rank, end-to-end through searchMemory, with the I/O mocked.
// `config` caches env at import, so we mock it directly (deterministic across the
// shared node:test process). SCM-S53: searchChunks returns VECTOR order
// (88, 50, 20) with a TIGHT top-1/top-2 margin (0.005 < SCM_GRAPH_MARGIN_THRESHOLD
// 0.02) so the confidence gate ENGAGES the graph. The bridged chunk 20 is then
// lifted above the unconnected rank-2 chunk 50, while the non-demoting pin keeps
// the vector top-1 (88) at rank 1.
describe("searchMemory concept-bridge re-rank integration", () => {
  it("lifts a concept-sharing chunk above a lower unconnected one without demoting the pinned top-1 (SCM-S53)", async () => {
    mock.module("../src/config.js", {
      namedExports: {
        config: {
          SCM_GRAPH_RERANK_ENABLED: true,
          SCM_GRAPH_RERANK_ALPHA: 0.3,
          SCM_GRAPH_RERANK_POOL: 40,
          SCM_GRAPH_RERANK_EXPAND: 10,
          SCM_GRAPH_RERANK_TIMEOUT_MS: 50,
          SCM_GRAPH_MARGIN_THRESHOLD: 0.02,
        },
        memoryRoots: [],
      },
    });
    mock.module("../src/ollama.js", {
      namedExports: { embed: async () => [new Array(768).fill(0.01)] },
    });
    mock.module("../src/supabase.js", {
      namedExports: {
        supabase: {},
        listBacklog: async () => [],
        listArchive: async () => [],
        searchChunks: async () => [
          { id: 88, content: "y", file_origin: "f", chunk_index: 0, metadata: {}, similarity: 0.55 },
          { id: 50, content: "z", file_origin: "f", chunk_index: 0, metadata: {}, similarity: 0.545 },
          { id: 20, content: "x", file_origin: "f", chunk_index: 0, metadata: {}, similarity: 0.5 },
        ],
        fetchConceptChunks: async () => [{ concept_id: 100, chunk_id: 20, w_ck: 1 }],
        fetchChunksByIds: async () => [],
      },
    });
    mock.module("../src/tools/kg.js", {
      namedExports: {
        kgHybridSearch: async () => ({
          ok: true,
          seeds: [{ id: 1, type: "NOTE", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.95 }],
          neighbors: [
            { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
          ],
        }),
      },
    });

    const { searchMemory } = await import("../src/tools/search.js");
    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.equal(res.results[0].id, 88, "vector top-1 (88) is PINNED — non-demoting, never sacrificed");
    assert.equal(res.results[1].id, 20, "concept chunk 20 lifted above the unconnected rank-2 chunk 50 (bounded by the pin)");
  });
});
