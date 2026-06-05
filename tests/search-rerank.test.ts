import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Concept-bridge re-rank, end-to-end through searchMemory, with the I/O mocked.
// `config` caches env at import, so we mock it directly (deterministic across the
// shared node:test process). searchChunks returns VECTOR order (88 before 20) so
// the test genuinely fails until the re-rank lifts the concept-sharing chunk.
describe("searchMemory concept-bridge re-rank integration", () => {
  it("lifts a concept-sharing chunk above a higher-vector unconnected one", async () => {
    mock.module("../src/config.js", {
      namedExports: {
        config: {
          SCM_GRAPH_RERANK_ENABLED: true,
          SCM_GRAPH_RERANK_ALPHA: 0.3,
          SCM_GRAPH_RERANK_POOL: 40,
          SCM_GRAPH_RERANK_EXPAND: 10,
          SCM_GRAPH_RERANK_TIMEOUT_MS: 50,
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
    assert.equal(res.results[0].id, 20, "concept-sharing chunk 20 lifted above higher-vector 88");
  });
});
