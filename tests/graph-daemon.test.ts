// M8.1 Phase 1 — Smoke tests for src/graph/daemon.ts.
// Mocks supabase (kg_nodes antijoin + memory_chunks fetch) AND src/tools/kg.js
// (upsertKgNode / upsertKgEdge) so no live DB is needed.
// Runtime: node:test + node:assert/strict.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mock state ────────────────────────────────────────────────────────────
type ChunkRow = {
  id: number;
  project_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null | string;
};

let memoryChunks: ChunkRow[] = [];
let usedSourceChunkIds: Array<{ source_chunk_id: number | null }> = [];

let nodeIdCounter = 0;
let edgeIdCounter = 0;
const upsertNodeCalls: unknown[] = [];
const upsertEdgeCalls: unknown[] = [];
// Per-test injectable failure on upsertKgNode keyed by (label).
let nodeFailOnLabel: string | null = null;
let nodeThrowOnLabel: string | null = null;

function makeKgNodesBuilder() {
  const builder = {
    select() {
      return builder;
    },
    not() {
      return builder;
    },
    limit() {
      return Promise.resolve({ data: usedSourceChunkIds.slice(), error: null });
    },
  };
  return builder;
}

function makeMemoryChunksBuilder() {
  const builder = {
    select() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return Promise.resolve({ data: memoryChunks.slice(), error: null });
    },
  };
  return builder;
}

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        if (table === "kg_nodes") return makeKgNodesBuilder();
        if (table === "memory_chunks") return makeMemoryChunksBuilder();
        throw new Error(`unexpected table in graph-daemon mock: ${table}`);
      },
    },
    getKeepAliveStatus: () => ({}),
    FROZEN_CACHE_PATH: "/tmp/frozen-cache-mock.json",
  },
});

mock.module("../src/tools/kg.js", {
  namedExports: {
    upsertKgNode: async (input: { label: string }) => {
      upsertNodeCalls.push(input);
      if (nodeThrowOnLabel && input.label === nodeThrowOnLabel) {
        throw new Error("simulated upsert throw");
      }
      if (nodeFailOnLabel && input.label === nodeFailOnLabel) {
        return { ok: false, reason: "simulated_fail" };
      }
      nodeIdCounter += 1;
      return { ok: true, node_id: nodeIdCounter };
    },
    upsertKgNodeFromChunk: async (input: { label: string }) => {
      upsertNodeCalls.push(input);
      if (nodeThrowOnLabel && input.label === nodeThrowOnLabel) {
        throw new Error("simulated upsert throw");
      }
      if (nodeFailOnLabel && input.label === nodeFailOnLabel) {
        return { ok: false, reason: "simulated_fail" };
      }
      nodeIdCounter += 1;
      return { ok: true, node_id: nodeIdCounter };
    },
    upsertKgEdge: async (input: unknown) => {
      upsertEdgeCalls.push(input);
      edgeIdCounter += 1;
      return { ok: true, edge_id: edgeIdCounter };
    },
    kgHybridSearch: async () => ({ ok: true, seeds: [], neighbors: [] }),
    listKgNodes: async () => [],
    listKgEdges: async () => [],
  },
});

const {
  runGraphExtractorOnce,
  startGraphExtractor,
  stopGraphExtractor,
  getGraphExtractorStatus,
} = await import("../src/graph/daemon.js");

function resetMocks(): void {
  memoryChunks = [];
  usedSourceChunkIds = [];
  upsertNodeCalls.length = 0;
  upsertEdgeCalls.length = 0;
  nodeIdCounter = 0;
  edgeIdCounter = 0;
  nodeFailOnLabel = null;
  nodeThrowOnLabel = null;
  delete process.env.SCM_GRAPH_EXTRACTOR_ENABLED;
}

describe("graph daemon — runGraphExtractorOnce", () => {
  beforeEach(() => {
    stopGraphExtractor();
    resetMocks();
  });

  it("processes 2 unprocessed chunks, upserts primary + file-ref nodes", async () => {
    memoryChunks = [
      {
        id: 101,
        project_id: "__test_graph__",
        content: "First DECISION — see src/a.ts and src/b.ts for context.",
        metadata: { type: "DECISION" },
        embedding: null,
      },
      {
        id: 102,
        project_id: "__test_graph__",
        content: "Second NOTE mentions src/c.ts and src/d.ts as references.",
        metadata: { type: "NOTE" },
        embedding: null,
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 2 });
    assert.equal(counts.extracted, 2);
    assert.equal(counts.skipped, 0);
    assert.equal(counts.errored, 0);
    // 2 primaries + 4 file refs = 6 node upserts.
    assert.equal(upsertNodeCalls.length, 6);
    // 4 MENTIONS edges expected.
    assert.equal(upsertEdgeCalls.length, 4);
  });

  it("LOG-type chunk is skipped, emits one sentinel node", async () => {
    memoryChunks = [
      {
        id: 201,
        project_id: "__test_graph__",
        content: "log line content over twenty characters",
        metadata: { type: "LOG" },
        embedding: null,
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.extracted, 0);
    assert.equal(upsertNodeCalls.length, 1);
    const node = upsertNodeCalls[0] as { label: string; type: string };
    assert.equal(node.type, "NOTE");
    assert.equal(node.label, "skipped:201");
  });

  it("one chunk throws during upsert → errored=1; other chunk still succeeds", async () => {
    memoryChunks = [
      {
        id: 301,
        project_id: "__test_graph__",
        content: "First good entry mentions src/ok.ts in body.",
        metadata: { type: "NOTE" },
        embedding: null,
      },
      {
        id: 302,
        project_id: "__test_graph__",
        content: "POISON entry with no file refs",
        metadata: { type: "NOTE" },
        embedding: null,
      },
    ];
    // memory_chunks is ordered DESC by id, so id 302 comes first. Its
    // primary label is sanitised firstNonEmptyLine → "POISON entry with
    // no file refs". Force that upsert to throw.
    nodeThrowOnLabel = "POISON entry with no file refs";
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.errored, 1);
    assert.equal(counts.extracted, 1);
  });

  it("getGraphExtractorStatus pre-run reports pending + not running + 0 totals", () => {
    const s = getGraphExtractorStatus();
    assert.equal(s.derived.status, "pending");
    assert.equal(s.running, false);
    assert.equal(s.extracted_total, 0);
    assert.equal(s.last_run_at, null);
  });

  it("startGraphExtractor / stopGraphExtractor toggles enabled + clears timer", async () => {
    startGraphExtractor({ intervalMs: 5_000, batch: 1 });
    // Yield so initial void tick() can flip running briefly then finish.
    await new Promise((r) => setTimeout(r, 10));
    stopGraphExtractor();
    const after = getGraphExtractorStatus();
    assert.equal(after.enabled, false);
    assert.equal(after.running, false);
  });

  it("SCM_GRAPH_EXTRACTOR_ENABLED='0' → runGraphExtractorOnce zero-counts, no supabase calls", async () => {
    process.env.SCM_GRAPH_EXTRACTOR_ENABLED = "0";
    memoryChunks = [
      {
        id: 401,
        project_id: "__test_graph__",
        content: "Would normally extract here for sure",
        metadata: { type: "NOTE" },
        embedding: null,
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 1 });
    assert.equal(counts.extracted, 0);
    assert.equal(counts.skipped, 0);
    assert.equal(counts.errored, 0);
    assert.equal(upsertNodeCalls.length, 0);
  });
});
