// M8.1 Phase 1 — Graph-RAG splice tests for src/tools/search.ts.
// Mocks ../src/ollama.js (embed), ../src/supabase.js (searchChunks +
// listBacklog + listArchive), and ../src/tools/kg.js (kgHybridSearch) so
// the test exercises ONLY the Promise.allSettled splice in the semantic
// branch + the env-disable + the non-semantic short-circuit.
// Runtime: node:test + node:assert/strict.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mock state ────────────────────────────────────────────────────────────
let embedCalls = 0;
let searchChunksCalls = 0;
let kgHybridSearchCalls = 0;
let kgBehavior: () => Promise<unknown> = async () => ({
  ok: true,
  seeds: [{ id: 1, type: "DECISION", label: "SCM-S35-D1", properties: {}, source_chunk_id: null, similarity: 0.9 }],
  neighbors: [
    {
      id: 2,
      type: "FILE",
      label: "src/tools/kg.ts",
      properties: {},
      relation: "MENTIONS",
      weight: 1.0,
      direction: "outgoing" as const,
      via_node_id: 1,
    },
  ],
});

// SCM-S54: the LLM reranker ships ON by default, so this Graph-RAG splice test
// MUST pin the flag state it intends to verify instead of inheriting the global
// default. We mock config with the LLM reranker EXPLICITLY OFF (and the graph
// rerank OFF too — this file only exercises the graph_context splice, not either
// rerank path). Every config key read by src/tools/search.ts is supplied so the
// real env never leaks in. The throwing chat() stub below then proves chat()
// never fires on the disabled path.
mock.module("../src/config.js", {
  namedExports: {
    config: {
      SCM_LLM_RERANK_ENABLED: false,
      SCM_RERANK_MODEL: "",
      SCM_LLM_RERANK_POOL: 12,
      SCM_LLM_RERANK_SNIPPET: 400,
      SCM_LLM_RERANK_TIMEOUT_MS: 8000,
      SCM_LLM_RERANK_PIN_TOP1: true,
      SCM_GRAPH_RERANK_ENABLED: false,
      SCM_GRAPH_RERANK_ALPHA: 0.7,
      SCM_GRAPH_RERANK_POOL: 40,
      SCM_GRAPH_RERANK_EXPAND: 10,
      SCM_GRAPH_RERANK_TIMEOUT_MS: 1500,
      SCM_GRAPH_MARGIN_THRESHOLD: 0.02,
    },
    memoryRoots: [],
  },
});

mock.module("../src/ollama.js", {
  namedExports: {
    embed: async () => {
      embedCalls += 1;
      return [[0.1, 0.2, 0.3]];
    },
    // SCM-S54: search.ts now imports chat() for the LLM reranker. The LLM flag
    // is OFF here, so chat() must never be invoked — throw if it is.
    chat: async () => {
      throw new Error("chat() must not be called when SCM_LLM_RERANK_ENABLED is off");
    },
  },
});

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from() {
        throw new Error("supabase.from should not be called in semantic-branch tests");
      },
    },
    searchChunks: async () => {
      searchChunksCalls += 1;
      return [
        {
          id: 7,
          content: "vector result content",
          file_origin: "src/tools/kg.ts",
          chunk_index: 0,
          metadata: {},
          similarity: 0.88,
          project_id: "__test_search_rag__",
        },
      ];
    },
    listBacklog: async () => [],
    listArchive: async () => [],
    fetchConceptChunks: async () => [],
    fetchChunksByIds: async () => [],
  },
});

mock.module("../src/tools/kg.js", {
  namedExports: {
    kgHybridSearch: async () => {
      kgHybridSearchCalls += 1;
      return kgBehavior();
    },
    upsertKgNode: async () => ({ ok: true, node_id: 1 }),
    upsertKgEdge: async () => ({ ok: true, edge_id: 1 }),
    listKgNodes: async () => [],
    listKgEdges: async () => [],
  },
});

const { searchMemory } = await import("../src/tools/search.js");

function resetMocks(): void {
  embedCalls = 0;
  searchChunksCalls = 0;
  kgHybridSearchCalls = 0;
  delete process.env.SCM_GRAPH_RAG_DISABLED;
  kgBehavior = async () => ({
    ok: true,
    seeds: [{ id: 1, type: "DECISION", label: "SCM-S35-D1", properties: {}, source_chunk_id: null, similarity: 0.9 }],
    neighbors: [
      {
        id: 2,
        type: "FILE",
        label: "src/tools/kg.ts",
        properties: {},
        relation: "MENTIONS",
        weight: 1.0,
        direction: "outgoing" as const,
        via_node_id: 1,
      },
    ],
  });
}

describe("search graph-RAG splice — semantic branch", () => {
  beforeEach(resetMocks);

  it("attaches graph_context with seeds + neighbors when kg search succeeds", async () => {
    const res = (await searchMemory({
      query: "something semantic about the knowledge graph",
      project_id: "__test_search_rag__",
    })) as { count: number; results: unknown[]; graph_context?: { seeds: unknown[]; neighbors: unknown[] } };
    assert.equal(res.count, 1);
    assert.ok(res.graph_context);
    assert.equal(res.graph_context.seeds.length, 1);
    assert.equal(res.graph_context.neighbors.length, 1);
    assert.equal(kgHybridSearchCalls, 1);
  });

  it("kgHybridSearch rejecting → response has count/results but no graph_context", async () => {
    kgBehavior = async () => {
      throw new Error("simulated kg failure");
    };
    const res = (await searchMemory({
      query: "another semantic query about the graph",
      project_id: "__test_search_rag__",
    })) as { count: number; results: unknown[]; graph_context?: unknown };
    assert.equal(res.count, 1);
    assert.equal(res.graph_context, undefined);
  });

  it("kgHybridSearch returning {ok:false} → no graph_context", async () => {
    kgBehavior = async () => ({ ok: false, reason: "stub" });
    const res = (await searchMemory({
      query: "semantic again with failing kg ok-false branch",
      project_id: "__test_search_rag__",
    })) as { graph_context?: unknown };
    assert.equal(res.graph_context, undefined);
  });

  it("SCM_GRAPH_RAG_DISABLED='1' → no kg call, no graph_context", async () => {
    process.env.SCM_GRAPH_RAG_DISABLED = "1";
    const res = (await searchMemory({
      query: "disabled semantic search graph rag here please",
      project_id: "__test_search_rag__",
    })) as { graph_context?: unknown };
    assert.equal(kgHybridSearchCalls, 0);
    assert.equal(res.graph_context, undefined);
  });

  it("non-semantic mode (backlog branch) → no kg call", async () => {
    const res = (await searchMemory({
      query: "backlog",
      project_id: "__test_search_rag__",
    })) as { mode: string; graph_context?: unknown };
    assert.equal(res.mode, "backlog");
    assert.equal(kgHybridSearchCalls, 0);
    assert.equal(res.graph_context, undefined);
  });
});
