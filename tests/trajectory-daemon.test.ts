// Smoke tests for src/trajectory/daemon.ts.
// Mocks supabase (PostgREST query builder) + embed + stripper + summarizer.
// Runtime: node:test + node:assert/strict.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mock state ─────────────────────────────────────────────────────────────
type Row = { id: number; project_id: string; content: string };
let memoryChunks: Row[] = [];
let summarizedIds = new Set<number>();
const upsertCalls: unknown[] = [];
let lookupError: { message: string } | null = null;
let lookupOverride: Row | null | undefined = undefined; // undefined = use store
let stripBehavior: (raw: string) => { stripped: string; sourceTokens: number; strippedTokens: number } =
  (raw) => ({ stripped: raw, sourceTokens: Math.ceil(raw.length / 4), strippedTokens: Math.ceil(raw.length / 4) });
let summarizeBehavior: () => Promise<{ summary: string; summaryTokens: number; model: string }> = async () => ({
  summary: "mock summary",
  summaryTokens: 3,
  model: "mock-model",
});

// ── Mock @supabase client ──────────────────────────────────────────────────
function makeMemoryChunksBuilder() {
  let filterId: number | null = null;
  const builder = {
    select() {
      return builder;
    },
    eq(_col: string, value: number) {
      filterId = value;
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return Promise.resolve({ data: memoryChunks.slice(), error: null });
    },
    range() {
      // memory_chunks scan doesn't currently use range(), but be safe.
      return Promise.resolve({ data: memoryChunks.slice(), error: null });
    },
    maybeSingle() {
      if (lookupError) return Promise.resolve({ data: null, error: lookupError });
      if (lookupOverride !== undefined)
        return Promise.resolve({ data: lookupOverride, error: null });
      const found = memoryChunks.find((r) => r.id === filterId) ?? null;
      return Promise.resolve({ data: found, error: null });
    },
  };
  return builder;
}

function makeTrajectorySummariesBuilder() {
  const builder = {
    select() {
      return builder;
    },
    range(_from: number, _to: number) {
      const data = [...summarizedIds].map((id) => ({ source_chunk_id: id }));
      // Always return them in one page (caller breaks when data.length < pageSize).
      return Promise.resolve({ data, error: null });
    },
    upsert(payload: unknown) {
      upsertCalls.push(payload);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return builder;
}

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        if (table === "memory_chunks") return makeMemoryChunksBuilder();
        if (table === "trajectory_summaries") return makeTrajectorySummariesBuilder();
        throw new Error(`unexpected table in mock: ${table}`);
      },
    },
    keepAliveSupabase: () => {},
    stopSupabaseKeepAlive: () => {},
  },
});

mock.module("../src/ollama.js", {
  namedExports: {
    embed: async () => [[0.1, 0.2, 0.3]],
    chat: async () => "should not be called when summarizer is mocked",
    captionImage: async () => "",
  },
});

mock.module("../src/trajectory/stripper.js", {
  namedExports: {
    stripTrajectory: (raw: string) => stripBehavior(raw),
  },
});

mock.module("../src/trajectory/summarizer.js", {
  namedExports: {
    summarizeTrajectory: () => summarizeBehavior(),
  },
});

const {
  startCompactor,
  stopCompactor,
  getCompactorStatus,
  runCompactionOnce,
  compactOneChunk,
} = await import("../src/trajectory/daemon.js");

// ── Resets ─────────────────────────────────────────────────────────────────
function resetMocks(): void {
  memoryChunks = [];
  summarizedIds = new Set();
  upsertCalls.length = 0;
  lookupError = null;
  lookupOverride = undefined;
  stripBehavior = (raw) => ({
    stripped: raw,
    sourceTokens: Math.ceil(raw.length / 4),
    strippedTokens: Math.ceil(raw.length / 4),
  });
  summarizeBehavior = async () => ({ summary: "mock summary", summaryTokens: 3, model: "mock-model" });
}

describe("compactor lifecycle", () => {
  beforeEach(() => {
    stopCompactor();
    resetMocks();
  });

  it("startCompactor is idempotent (second call is no-op)", () => {
    startCompactor();
    const first = getCompactorStatus();
    startCompactor(); // second call must not throw nor duplicate timer
    const second = getCompactorStatus();
    assert.equal(first.enabled, true);
    assert.equal(second.enabled, true);
    stopCompactor();
  });

  it("stopCompactor is a no-op when not started", () => {
    assert.doesNotThrow(() => stopCompactor());
    const status = getCompactorStatus();
    assert.equal(status.enabled, false);
  });

  it("getCompactorStatus returns the documented shape with correct types pre-tick", () => {
    stopCompactor();
    resetMocks();
    const s = getCompactorStatus();
    assert.equal(typeof s.enabled, "boolean");
    assert.equal(typeof s.interval_ms, "number");
    assert.equal(s.last_run_at, null);
    assert.equal(typeof s.last_run_compacted, "number");
    assert.equal(typeof s.last_run_skipped, "number");
    assert.equal(typeof s.last_run_errored, "number");
    assert.equal(typeof s.last_run_duration_ms, "number");
    assert.equal(typeof s.last_run_source_tokens, "number");
    assert.equal(typeof s.last_run_summary_tokens, "number");
    assert.equal(Object.keys(s).length, 9);
  });
});

describe("runCompactionOnce (dry run)", () => {
  beforeEach(() => {
    stopCompactor();
    resetMocks();
  });

  it("returns {compacted, skipped, errored, duration_ms} shape", async () => {
    const r = await runCompactionOnce({ limit: 5, dryRun: true });
    assert.equal(typeof r.compacted, "number");
    assert.equal(typeof r.skipped, "number");
    assert.equal(typeof r.errored, "number");
    assert.equal(typeof r.duration_ms, "number");
  });

  it("counts one compaction and one skip when 2 candidates pass byte filter", async () => {
    // Both rows are > 16 000 bytes so they pass fetchCandidates byte filter.
    const big = "x".repeat(20_000);
    memoryChunks = [
      { id: 1, project_id: "p", content: big },
      { id: 2, project_id: "p", content: big },
    ];
    // Row 1 strips to >=250 tokens (passes); row 2 strips to <250 (skipped).
    let call = 0;
    stripBehavior = (raw) => {
      call++;
      if (call === 1)
        return { stripped: raw, sourceTokens: 5000, strippedTokens: 1000 };
      return { stripped: "tiny", sourceTokens: 5000, strippedTokens: 100 };
    };
    const r = await runCompactionOnce({ limit: 5, dryRun: true });
    assert.equal(r.compacted, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.errored, 0);
    // dryRun=true must NOT have called the upsert mock.
    assert.equal(upsertCalls.length, 0);
  });
});

describe("compactOneChunk", () => {
  beforeEach(() => {
    stopCompactor();
    resetMocks();
  });

  it("returns not_found when supabase yields no row", async () => {
    lookupOverride = null;
    const r = await compactOneChunk(999, { dryRun: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_found");
    assert.equal(r.source_tokens, 0);
    assert.equal(r.summary_tokens, 0);
    assert.equal(r.compression_ratio, 0);
    assert.equal(r.summary, null);
  });

  it("returns too_small_after_strip when stripped tokens < 250", async () => {
    memoryChunks = [{ id: 7, project_id: "p", content: "short content" }];
    stripBehavior = () => ({ stripped: "tiny", sourceTokens: 100, strippedTokens: 50 });
    const r = await compactOneChunk(7, { dryRun: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too_small_after_strip");
    assert.equal(r.source_tokens, 100);
    assert.equal(r.summary_tokens, 0);
    assert.equal(r.summary, null);
  });

  it("returns ok=true with non-zero compression ratio in dryRun and skips upsert", async () => {
    memoryChunks = [{ id: 8, project_id: "p", content: "anything" }];
    stripBehavior = () => ({ stripped: "stripped form", sourceTokens: 1000, strippedTokens: 400 });
    summarizeBehavior = async () => ({ summary: "dense", summaryTokens: 50, model: "test-model" });

    const r = await compactOneChunk(8, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.source_tokens, 1000);
    assert.equal(r.summary_tokens, 50);
    assert.equal(r.summary, "dense");
    assert.equal(r.compression_ratio, 50 / 1000);
    assert.equal(r.reason, undefined);
    assert.equal(upsertCalls.length, 0); // dryRun bypasses DB write
  });
});
