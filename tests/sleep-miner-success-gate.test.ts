// Unit test for the miner success gate after SCM-S58: "successful" is sourced
// from the successful_chunks view, not archive_backlog. Mocks the supabase shim
// at the module boundary (no live DB).
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import { test, describe, mock, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

// Table fixtures the fake builder serves.
let successfulChunkRows: Array<{ chunk_id: number }> = [];
let summaryRows: Array<{
  id: number;
  project_id: string;
  summary: string;
  summary_embedding: number[] | null;
  source_chunk_id: number;
}> = [];

function makeBuilder(table: string) {
  // All miner reads are terminal `await`s on a chain ending in .eq()/.limit()/.in().
  // We resolve the right dataset by table and ignore the (irrelevant-to-routing) filters.
  const result =
    table === "successful_chunks"
      ? { data: successfulChunkRows, error: null }
      : table === "trajectory_summaries"
        ? { data: summaryRows, error: null }
        : { data: [], error: null }; // workflow_checkpoints rollback scan → empty
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

mock.module("../src/supabase.js", {
  namedExports: { supabase: { from: (t: string) => makeBuilder(t) } },
});

const { mineClusters } = await import("../src/sleep/miner.js");

describe("miner success gate — sourced from successful_chunks", () => {
  beforeEach(() => {
    successfulChunkRows = [];
    summaryRows = [];
  });

  test("only summaries whose source chunk is in successful_chunks are mined", async () => {
    // 3 summaries on successful chunks (identical embedding → one cluster ≥ minFreq=3)
    // + 1 summary on a NON-successful chunk that must be excluded.
    const emb = [1, 0, 0];
    summaryRows = [
      { id: 1, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 10 },
      { id: 2, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 11 },
      { id: 3, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 12 },
      { id: 4, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 99 },
    ];
    successfulChunkRows = [{ chunk_id: 10 }, { chunk_id: 11 }, { chunk_id: 12 }];

    const stubs = await mineClusters({ projectId: "p", batch: 50, minFreq: 3 });

    assert.ok(stubs.length >= 1, "a cluster of 3 successful summaries should yield a candidate");
    assert.ok(stubs.every((s) => !s.source_summary_ids.includes(4)), "summary 4 (non-successful chunk) must not appear in any candidate");
    assert.deepEqual(stubs[0]!.source_backlog_ids, [], "backlog provenance is empty post-SCM-S58");
  });

  test("empty success set → no candidates", async () => {
    summaryRows = [
      { id: 1, project_id: "p", summary: "a", summary_embedding: [1, 0], source_chunk_id: 10 },
    ];
    successfulChunkRows = [];
    const stubs = await mineClusters({ projectId: "p", batch: 50, minFreq: 3 });
    assert.deepEqual(stubs, []);
  });
});
