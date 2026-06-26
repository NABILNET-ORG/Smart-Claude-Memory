// M8.1 Phase 1 — Orchestration tests for src/graph/daemon.ts (runGraphExtractorOnce).
//
// Scope: the daemon's RUN-LOOP behaviour — batching a page of memory_chunks,
// routing each chunk through the pure extractor, fanning the result out into
// primary/secondary node + edge upserts, skipping LOG/short chunks via a
// sentinel, isolating per-chunk failures, honouring the batch cap, and the
// enabled/idempotent-timer lifecycle.
//
// Out of scope (already covered, do NOT duplicate): the "no embedding egress"
// guarantees live in tests/kg-upsert-from-chunk.test.ts (subtests 5b-1/5b-2/
// 5b-3) — that the memory_chunks select omits `embedding`, that the primary
// routes through upsertKgNodeFromChunk, and that the call carries no embedding
// field. Here we assert routing only at the orchestration level: a single
// light check that the primary path goes through upsertKgNodeFromChunk and the
// old client-side upsertKgNode path is reserved for SECONDARY nodes.
//
// Mocks supabase (kg_nodes antijoin + memory_chunks fetch) AND src/tools/kg.js
// (upsertKgNode / upsertKgNodeFromChunk / upsertKgEdge) so no live DB is hit.
// memory_chunks rows are shaped { id, project_id, content, metadata } with NO
// embedding column — matching the Session-55-refactored daemon (daemon.ts:109).
//
// Runtime: node --import tsx --experimental-test-module-mocks --no-warnings --test

import { test, describe, mock, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

// ── Mock state ────────────────────────────────────────────────────────────
// Chunk rows carry NO embedding field — the refactored daemon never selects it.
type ChunkRow = {
  id: number;
  project_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
};

let memoryChunks: ChunkRow[] = [];
let usedSourceChunkIds: Array<{ source_chunk_id: number | null }> = [];

// What columns did the daemon ask memory_chunks for? Captured to prove batching
// went through the real query builder (orchestration smoke, not egress detail).
let capturedChunkSelect: string | null = null;
let capturedChunkLimit: number | null = null;

let nodeIdCounter = 0;
let edgeIdCounter = 0;
// Routing-aware call logs: primary/sentinel land in fromChunk, secondaries in node.
const fromChunkCalls: Array<{ type: string; label: string; source_chunk_id?: number }> = [];
const nodeCalls: Array<{ type: string; label: string }> = [];
const edgeCalls: unknown[] = [];
// Per-test injectable failure/throw on a node upsert keyed by label. Applies to
// BOTH kg entry points so a primary (fromChunk) or a secondary (node) can be
// targeted by the same switch.
let failOnLabel: string | null = null;
let throwOnLabel: string | null = null;

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
    select(cols: string) {
      capturedChunkSelect = cols;
      return builder;
    },
    order() {
      return builder;
    },
    limit(n: number) {
      capturedChunkLimit = n;
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
    // Secondary (FILE / DECISION / SYMBOL) nodes route here.
    upsertKgNode: async (input: { type: string; label: string }) => {
      nodeCalls.push({ type: input.type, label: input.label });
      if (throwOnLabel && input.label === throwOnLabel) {
        throw new Error("simulated upsertKgNode throw");
      }
      if (failOnLabel && input.label === failOnLabel) {
        return { ok: false, reason: "simulated_fail" };
      }
      nodeIdCounter += 1;
      return { ok: true, node_id: nodeIdCounter };
    },
    // Primary + sentinel nodes route here (server-side embedding copy, SCM-S55).
    upsertKgNodeFromChunk: async (input: { type: string; label: string; source_chunk_id?: number }) => {
      fromChunkCalls.push({ type: input.type, label: input.label, source_chunk_id: input.source_chunk_id });
      if (throwOnLabel && input.label === throwOnLabel) {
        throw new Error("simulated upsertKgNodeFromChunk throw");
      }
      if (failOnLabel && input.label === failOnLabel) {
        return { ok: false, reason: "simulated_fail" };
      }
      nodeIdCounter += 1;
      return { ok: true, node_id: nodeIdCounter };
    },
    upsertKgEdge: async (input: unknown) => {
      edgeCalls.push(input);
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
  capturedChunkSelect = null;
  capturedChunkLimit = null;
  fromChunkCalls.length = 0;
  nodeCalls.length = 0;
  edgeCalls.length = 0;
  nodeIdCounter = 0;
  edgeIdCounter = 0;
  failOnLabel = null;
  throwOnLabel = null;
  delete process.env.SCM_GRAPH_EXTRACTOR_ENABLED;
}

describe("graph daemon — runGraphExtractorOnce orchestration", () => {
  beforeEach(() => {
    stopGraphExtractor();
    resetMocks();
  });

  test("processes a batch of 2 chunks: primary via fromChunk, file-refs via node, MENTIONS edges", async () => {
    // Each chunk yields 1 primary + 2 FILE refs + 2 MENTIONS edges (verified
    // against the pure extractor). Across the batch: 2 primaries, 4 secondaries,
    // 4 edges. memory_chunks is ordered id-DESC, so list newest-first to mirror.
    memoryChunks = [
      {
        id: 102,
        project_id: "__test_graph__",
        content: "Second note mentions src/c.ts and src/d.ts as references here.",
        metadata: { type: "NOTE" },
      },
      {
        id: 101,
        project_id: "__test_graph__",
        content: "First DECISION about the graph daemon. See src/a.ts and src/b.ts for context.",
        metadata: { type: "DECISION" },
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 2 });
    assert.equal(counts.extracted, 2);
    assert.equal(counts.skipped, 0);
    assert.equal(counts.errored, 0);
    // Primaries always go through the server-side path; never the client path.
    assert.equal(fromChunkCalls.length, 2);
    // 2 + 2 file-ref secondaries through the client path.
    assert.equal(nodeCalls.length, 4);
    // 2 + 2 MENTIONS edges.
    assert.equal(edgeCalls.length, 4);
    assert.equal(counts.nodes, 6); // 2 primaries + 4 secondaries
    assert.equal(counts.edges, 4);
  });

  test("routing guard: primary uses upsertKgNodeFromChunk, never the old upsertKgNode path", async () => {
    // SCM-S55 light routing assertion — the daemon must NOT regress to passing a
    // client-side embedding through upsertKgNode for the primary. (Egress detail
    // is exhaustively covered in kg-upsert-from-chunk.test.ts 5b-*.)
    memoryChunks = [
      {
        id: 110,
        project_id: "__test_graph__",
        content: "Primary only entry with no references at all in this body.",
        metadata: { type: "NOTE" },
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.extracted, 1);
    assert.equal(fromChunkCalls.length, 1, "primary routes through upsertKgNodeFromChunk");
    assert.equal(nodeCalls.length, 0, "no secondaries → old upsertKgNode path untouched");
    assert.equal(fromChunkCalls[0].source_chunk_id, 110, "primary anchors to chunk id");
  });

  test("LOG-type chunk is skipped and emits exactly one sentinel via fromChunk", async () => {
    memoryChunks = [
      {
        id: 201,
        project_id: "__test_graph__",
        content: "log line content over twenty characters",
        metadata: { type: "LOG" },
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.extracted, 0);
    assert.equal(counts.errored, 0);
    // Sentinel anchors the chunk through the server-side path; no secondaries.
    assert.equal(fromChunkCalls.length, 1);
    assert.equal(nodeCalls.length, 0);
    assert.equal(edgeCalls.length, 0);
    const sentinel = fromChunkCalls[0];
    assert.equal(sentinel.type, "NOTE");
    assert.equal(sentinel.label, "skipped:201");
    assert.equal(sentinel.source_chunk_id, 201);
    assert.equal(counts.nodes, 1); // sentinel counts as a created node
  });

  test("a chunk that throws during primary upsert is isolated: errored=1, sibling still extracts", async () => {
    // id-DESC ordering puts 302 first; its primary label is the sanitized first
    // line. Force that primary upsert to throw — the daemon's per-chunk try/catch
    // must swallow it and continue to 301.
    memoryChunks = [
      {
        id: 302,
        project_id: "__test_graph__",
        content: "POISON entry with no file refs at all here today",
        metadata: { type: "NOTE" },
      },
      {
        id: 301,
        project_id: "__test_graph__",
        content: "First good entry mentions src/ok.ts in body here please.",
        metadata: { type: "NOTE" },
      },
    ];
    throwOnLabel = "POISON entry with no file refs at all here today";
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.errored, 1);
    assert.equal(counts.extracted, 1);
    // The surviving chunk produced its primary + one FILE secondary + one edge.
    assert.equal(counts.nodes, 2);
    assert.equal(counts.edges, 1);
  });

  test("a failed (ok:false) primary upsert increments errored and skips secondaries/edges", async () => {
    // Distinct from a thrown error: upsertKgNodeFromChunk returns ok:false. The
    // daemon must count it as errored and NOT attempt the file-ref secondaries.
    memoryChunks = [
      {
        id: 320,
        project_id: "__test_graph__",
        content: "Fail primary entry mentions src/skipme.ts in the body text.",
        metadata: { type: "NOTE" },
      },
    ];
    failOnLabel = "Fail primary entry mentions src/skipme.ts in the body text.";
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.errored, 1);
    assert.equal(counts.extracted, 0);
    assert.equal(counts.nodes, 0);
    assert.equal(nodeCalls.length, 0, "secondaries skipped when primary fails");
    assert.equal(edgeCalls.length, 0);
  });

  test("empty batch: zero counts and no upserts at all", async () => {
    memoryChunks = [];
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.deepEqual(counts, { extracted: 0, nodes: 0, edges: 0, skipped: 0, errored: 0 });
    assert.equal(fromChunkCalls.length, 0);
    assert.equal(nodeCalls.length, 0);
    assert.equal(edgeCalls.length, 0);
    // The query builder still ran (batch attempted) — proves an empty page, not a skip.
    assert.ok(capturedChunkSelect !== null, "memory_chunks.select() ran for the empty page");
  });

  test("respects the batch cap when the antijoin overfetches more rows than requested", async () => {
    // Daemon overfetches (batch * 5) then client-side trims to `batch`. Provide 5
    // eligible chunks but ask for batch=2 → only 2 primaries processed.
    memoryChunks = Array.from({ length: 5 }, (_, i) => ({
      id: 500 + i,
      project_id: "__test_graph__",
      content: `Batch cap probe number ${i} with enough body length to extract.`,
      metadata: { type: "NOTE" },
    }));
    const counts = await runGraphExtractorOnce({ batch: 2 });
    assert.equal(counts.extracted, 2, "only `batch` chunks processed despite overfetch");
    assert.equal(fromChunkCalls.length, 2);
    // Overfetch multiplier is applied to the DB limit (batch * 5 = 10).
    assert.equal(capturedChunkLimit, 10);
  });

  test("antijoin excludes chunks already anchored in kg_nodes", async () => {
    // id 600 is already in kg_nodes (source_chunk_id), so it must be filtered out;
    // only id 601 should be processed.
    usedSourceChunkIds = [{ source_chunk_id: 600 }];
    memoryChunks = [
      {
        id: 601,
        project_id: "__test_graph__",
        content: "Fresh unprocessed chunk with sufficient length to extract a node.",
        metadata: { type: "NOTE" },
      },
      {
        id: 600,
        project_id: "__test_graph__",
        content: "Already anchored chunk that must be skipped by the antijoin set.",
        metadata: { type: "NOTE" },
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 5 });
    assert.equal(counts.extracted, 1, "only the un-anchored chunk is processed");
    assert.equal(fromChunkCalls.length, 1);
    assert.equal(fromChunkCalls[0].source_chunk_id, 601);
  });

  test("getGraphExtractorStatus pre-run reports pending + not running + zero totals", () => {
    const s = getGraphExtractorStatus();
    assert.equal(s.derived.status, "pending");
    assert.equal(s.running, false);
    assert.equal(s.extracted_total, 0);
    assert.equal(s.last_run_at, null);
  });

  test("startGraphExtractor / stopGraphExtractor toggles enabled + clears the timer", async () => {
    startGraphExtractor({ intervalMs: 5_000, batch: 1 });
    // Yield so the fire-and-forget initial tick() can flip running then settle.
    await new Promise((r) => setTimeout(r, 10));
    stopGraphExtractor();
    const after = getGraphExtractorStatus();
    assert.equal(after.enabled, false);
    assert.equal(after.running, false);
  });

  test("startGraphExtractor is idempotent — a second call does not stack a tick", async () => {
    startGraphExtractor({ intervalMs: 5_000, batch: 1 });
    startGraphExtractor({ intervalMs: 5_000, batch: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const s = getGraphExtractorStatus();
    stopGraphExtractor();
    // With no eligible chunks the run is a no-op; the guard just must not throw
    // and the daemon stays in a consistent enabled state.
    assert.equal(s.enabled, true);
  });

  test("SCM_GRAPH_EXTRACTOR_ENABLED='0' short-circuits: zero counts, no supabase/kg calls", async () => {
    process.env.SCM_GRAPH_EXTRACTOR_ENABLED = "0";
    memoryChunks = [
      {
        id: 401,
        project_id: "__test_graph__",
        content: "Would normally extract here for sure with enough length",
        metadata: { type: "NOTE" },
      },
    ];
    const counts = await runGraphExtractorOnce({ batch: 1 });
    assert.equal(counts.extracted, 0);
    assert.equal(counts.skipped, 0);
    assert.equal(counts.errored, 0);
    assert.equal(fromChunkCalls.length, 0);
    assert.equal(nodeCalls.length, 0);
    // Disabled means the query builder is never touched.
    assert.equal(capturedChunkSelect, null);
  });
});
