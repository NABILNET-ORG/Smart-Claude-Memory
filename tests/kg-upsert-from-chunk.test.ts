// SCM-S55 Commit B — Live tests for kg_upsert_node_from_chunk RPC + daemon path.
//
// Test 5a: RPC + grant — proves the EXECUTE grant is wired so the function is
//   callable via supabase-js with the service key, embedding is copied server-
//   side (not null), and source_chunk_id is set.
// Test 5b: daemon path — proves runGraphExtractorOnce does NOT select
//   `embedding` from memory_chunks (via mock) and calls upsertKgNodeFromChunk
//   (not upsertKgNode) for the primary node.
//
// Runtime: node --import tsx --experimental-test-module-mocks --no-warnings --test

import { test, describe, mock, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { upsertKgNodeFromChunk } from "../src/tools/kg.js";

// ─── 5a helpers ────────────────────────────────────────────────────────────

const createdProjectIds: string[] = [];
const createdChunkIds: number[] = [];

function newProject(): string {
  const id = `__test_upsert_from_chunk_${randomUUID().slice(0, 8)}__`;
  createdProjectIds.push(id);
  return id;
}

/** Deterministic 768-dim unit vector (same approach as kg.test.ts). */
function unitVector(seed: number): number[] {
  const v = new Array(768);
  let acc = 0;
  for (let i = 0; i < 768; i++) {
    const x = Math.sin((seed + 1) * (i + 1) * 0.013);
    v[i] = x;
    acc += x * x;
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

after(async () => {
  for (const pid of createdProjectIds) {
    await supabase.from("kg_nodes").delete().eq("project_id", pid);
  }
  for (const cid of createdChunkIds) {
    await supabase.from("memory_chunks").delete().eq("id", cid);
  }
});

// ─── 5a: RPC + grant (live DB) ────────────────────────────────────────────

describe("kg_upsert_node_from_chunk — RPC callable via supabase-js", () => {
  test("5a-1: inserts chunk with embedding; RPC copies embedding server-side; node created", async () => {
    const pid = newProject();
    const emb = unitVector(42);

    const { data: chunkData, error: chunkErr } = await supabase
      .from("memory_chunks")
      .insert({
        project_id: pid,
        file_origin: `scm55-test-${pid}`,
        chunk_index: 0,
        content: "SCM-S55 test chunk — embedding copy target",
        content_hash: `scm55-test-hash-${pid}`,
        metadata: { type: "DECISION" },
        embedding: emb,
      })
      .select("id")
      .single();
    assert.equal(chunkErr, null, `chunk insert failed: ${chunkErr?.message}`);
    const chunkId = (chunkData as { id: number }).id;
    createdChunkIds.push(chunkId);

    // Call wrapper — hits the RPC via service key.
    const result = await upsertKgNodeFromChunk({
      project_id: pid,
      type: "DECISION",
      label: "SCM-S55-D1-test",
      properties: { session: 55 },
      source_chunk_id: chunkId,
    });

    // If EXECUTE grant is missing, reason will contain "permission denied".
    assert.equal(
      result.ok,
      true,
      `RPC not callable (grant may be missing): ${!result.ok ? (result as { ok: false; reason: string }).reason : ""}`,
    );

    const nodeId = (result as { ok: true; node_id: number }).node_id;
    assert.ok(nodeId > 0, "node_id should be a positive integer");

    // Verify the node row: embedding non-null + source_chunk_id correct.
    const { data: nodeRow, error: nodeErr } = await supabase
      .from("kg_nodes")
      .select("id, embedding, source_chunk_id")
      .eq("id", nodeId)
      .single();
    assert.equal(nodeErr, null, `node fetch failed: ${nodeErr?.message}`);
    const row = nodeRow as { id: number; embedding: unknown; source_chunk_id: number | null };
    assert.equal(row.source_chunk_id, chunkId, "source_chunk_id should match inserted chunk");
    assert.ok(row.embedding !== null, "embedding should be non-null (copied server-side)");
  });

  test("5a-2: idempotent — same (project_id,type,label) key returns same node_id", async () => {
    const pid = newProject();
    const emb = unitVector(99);

    const { data: chunkData, error: chunkErr } = await supabase
      .from("memory_chunks")
      .insert({
        project_id: pid,
        file_origin: `scm55-idem-${pid}`,
        chunk_index: 0,
        content: "SCM-S55 idempotency chunk",
        content_hash: `scm55-idem-hash-${pid}`,
        metadata: { type: "PATTERN" },
        embedding: emb,
      })
      .select("id")
      .single();
    assert.equal(chunkErr, null);
    const chunkId = (chunkData as { id: number }).id;
    createdChunkIds.push(chunkId);

    const r1 = await upsertKgNodeFromChunk({
      project_id: pid,
      type: "PATTERN",
      label: "idempotent-node",
      properties: { v: 1 },
      source_chunk_id: chunkId,
    });
    assert.equal(r1.ok, true);

    const r2 = await upsertKgNodeFromChunk({
      project_id: pid,
      type: "PATTERN",
      label: "idempotent-node",
      properties: { v: 2 },
      source_chunk_id: chunkId,
    });
    assert.equal(r2.ok, true);
    assert.equal(
      (r1 as { ok: true; node_id: number }).node_id,
      (r2 as { ok: true; node_id: number }).node_id,
      "same node_id on conflict",
    );
  });

  test("5a-3: validation — empty project_id returns ok:false without hitting DB", async () => {
    const r = await upsertKgNodeFromChunk({
      project_id: "",
      type: "NOTE",
      label: "x",
      source_chunk_id: 1,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { ok: false; reason: string }).reason, "project_id_required");
  });
});

// ─── 5b: daemon mock — no `embedding` in memory_chunks select ─────────────
// Mock setup must be at module top-level (outside describe/test), exactly as
// in tests/graph-daemon.test.ts, so esbuild sees the await import at the
// correct async module scope.

type ChunkRow = {
  id: number;
  project_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
};

let capturedSelect: string | null = null;
const fromChunkCalls: unknown[] = [];

const fakeChunks: ChunkRow[] = [
  {
    id: 7001,
    project_id: "__test_daemon_scm55__",
    content: "SCM-S55-D1 decision about egress reduction for the graph daemon",
    metadata: { type: "DECISION" },
  },
];

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        if (table === "kg_nodes") {
          const b = {
            select() { return b; },
            not() { return b; },
            limit() { return Promise.resolve({ data: [], error: null }); },
          };
          return b;
        }
        if (table === "memory_chunks") {
          const b = {
            select(cols: string) {
              capturedSelect = cols;
              return b;
            },
            order() { return b; },
            limit() { return Promise.resolve({ data: fakeChunks.slice(), error: null }); },
          };
          return b;
        }
        throw new Error(`unexpected table in 5b mock: ${table}`);
      },
    },
    getKeepAliveStatus: () => ({}),
    FROZEN_CACHE_PATH: "/tmp/frozen-cache-mock.json",
  },
});

mock.module("../src/tools/kg.js", {
  namedExports: {
    upsertKgNode: async () => {
      throw new Error("upsertKgNode must NOT be called by the daemon primary path (SCM-S55)");
    },
    upsertKgNodeFromChunk: async (input: unknown) => {
      fromChunkCalls.push(input);
      return { ok: true, node_id: 9001 };
    },
    upsertKgEdge: async () => ({ ok: true, edge_id: 1 }),
    kgHybridSearch: async () => ({ ok: true, seeds: [], neighbors: [] }),
    listKgNodes: async () => [],
    listKgEdges: async () => [],
  },
});

const { runGraphExtractorOnce } = await import("../src/graph/daemon.js");

describe("graph daemon (SCM-S55) — no embedding egress from memory_chunks", () => {
  beforeEach(() => {
    capturedSelect = null;
    fromChunkCalls.length = 0;
  });

  test("5b-1: memory_chunks select does NOT include 'embedding'", async () => {
    await runGraphExtractorOnce({ batch: 5 });
    assert.ok(capturedSelect !== null, "memory_chunks.select() should have been called");
    assert.ok(
      !capturedSelect!.includes("embedding"),
      `'embedding' must not appear in select columns — got: "${capturedSelect}"`,
    );
  });

  test("5b-2: primary node uses upsertKgNodeFromChunk with correct source_chunk_id", async () => {
    await runGraphExtractorOnce({ batch: 5 });
    assert.ok(
      fromChunkCalls.length >= 1,
      "upsertKgNodeFromChunk should have been called for the primary node",
    );
    const call = fromChunkCalls[0] as { source_chunk_id: number };
    assert.equal(call.source_chunk_id, 7001, "source_chunk_id must equal the chunk's id");
  });

  test("5b-3: upsertKgNodeFromChunk call carries no embedding field", async () => {
    await runGraphExtractorOnce({ batch: 5 });
    const call = fromChunkCalls[0] as Record<string, unknown>;
    assert.equal(
      "embedding" in call,
      false,
      "call to upsertKgNodeFromChunk must not include an embedding field",
    );
  });
});
