// Offline mocked unit tests for the delta-gate isDirty() rewrite (SCM-S55).
// No live DB required — all Supabase calls are intercepted via mock.module.
// Runtime: node:test + node:assert/strict via tsx.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Controllable mock state ──────────────────────────────────────────────

let mockKgCount = 0;
let mockKgCountError: { message: string } | null = null;
let mockClCount = 0;
let mockClCountError: { message: string } | null = null;
let mockComputedAt: string | null = null;
let mockComputedAtError: { message: string } | null = null;

// Builder for count queries (head:true). Returns { count, error }.
function makeCountBuilder(getCount: () => number, getError: () => typeof mockKgCountError) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = chain;
  b.not = chain;
  // Terminal — resolves the count query
  b.then = (resolve: (v: unknown) => void) => {
    const err = getError();
    resolve({ count: err ? null : getCount(), error: err });
  };
  return b;
}

// Builder for the computed_at maybeSingle() query.
function makeComputedAtBuilder() {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = chain;
  b.order = chain;
  b.limit = chain;
  b.maybeSingle = () =>
    Promise.resolve({
      data: mockComputedAt !== null ? { computed_at: mockComputedAt } : null,
      error: mockComputedAtError,
    });
  return b;
}

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        if (table === "kg_nodes") {
          return makeCountBuilder(
            () => mockKgCount,
            () => mockKgCountError,
          );
        }
        if (table === "kg_node_clusters") {
          // Both the count query and the computed_at maybeSingle() use this table.
          // Distinguish by whether .maybeSingle is eventually called (the count
          // builder terminates via .then; the timestamp builder terminates via
          // .maybeSingle). We return a combined builder that supports both paths.
          const b: Record<string, unknown> = {};
          const chain = () => b;
          b.select = chain;
          b.eq = chain;
          b.not = chain;
          b.order = chain;
          b.limit = chain;
          // Terminal: count path (Promise.all awaits the object directly)
          b.then = (resolve: (v: unknown) => void) => {
            const err = mockClCountError;
            resolve({ count: err ? null : mockClCount, error: err });
          };
          // Terminal: computed_at path
          b.maybeSingle = () =>
            Promise.resolve({
              data: mockComputedAt !== null ? { computed_at: mockComputedAt } : null,
              error: mockComputedAtError,
            });
          return b;
        }
        throw new Error(`unexpected table in delta-gate mock: ${table}`);
      },
    },
    getKeepAliveStatus: () => ({}),
    FROZEN_CACHE_PATH: "/tmp/frozen-cache-mock.json",
  },
});

// Stub out heavy imports that daemon.ts pulls at module level but isDirty doesn't need.
mock.module("../src/telemetry/emit.js", { namedExports: { emit: async () => {} } });
mock.module("../src/budget/gate.js", {
  namedExports: { checkDaemonBudget: async () => ({ allowed: true }) },
});
mock.module("../src/clustering/kmeans.js", { namedExports: { kmeans: () => ({ assignments: [], centroids: [] }) } });
mock.module("../src/clustering/louvain.js", { namedExports: { louvain: () => ({}) } });

// Import AFTER mocks are registered.
const { isDirty } = await import("../src/clustering/daemon.js");

// ─── Helper ───────────────────────────────────────────────────────────────

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ─── Test cases ───────────────────────────────────────────────────────────

describe("isDirty delta-gate (offline mocked)", () => {
  // Case 1: kgCount=0 → false (nothing to cluster)
  it("returns false when kgCount=0", async () => {
    mockKgCount = 0;
    mockKgCountError = null;
    mockClCount = 0;
    mockClCountError = null;
    mockComputedAt = null;
    mockComputedAtError = null;
    assert.equal(await isDirty("proj-1"), false);
  });

  // Case 2: clCount=0, kgCount>0 → true (initial run — never clustered)
  it("returns true when clCount=0 and kgCount>0 (initial run)", async () => {
    mockKgCount = 10;
    mockKgCountError = null;
    mockClCount = 0;
    mockClCountError = null;
    mockComputedAt = null;
    mockComputedAtError = null;
    assert.equal(await isDirty("proj-2"), true);
  });

  // Case 3: delta=150 (kg=1150, cl=1000), lastComputedAt=1h ago → true (delta > threshold of 100)
  it("returns true when delta=150 exceeds threshold (1h old clusters)", async () => {
    mockKgCount = 1150;
    mockKgCountError = null;
    mockClCount = 1000;
    mockClCountError = null;
    mockComputedAt = isoAgo(60 * 60 * 1000); // 1 hour ago
    mockComputedAtError = null;
    assert.equal(await isDirty("proj-3"), true);
  });

  // Case 4: delta=50 (kg=1050, cl=1000), lastComputedAt=1h ago → false (within cooldown, small delta)
  it("returns false when delta=50 (< threshold) and lastComputedAt is 1h ago (within 24h cooldown)", async () => {
    mockKgCount = 1050;
    mockKgCountError = null;
    mockClCount = 1000;
    mockClCountError = null;
    mockComputedAt = isoAgo(60 * 60 * 1000); // 1 hour ago
    mockComputedAtError = null;
    assert.equal(await isDirty("proj-4"), false);
  });

  // Case 5: delta=50, lastComputedAt=25h ago → true (cooldown elapsed)
  it("returns true when delta=50 but lastComputedAt is 25h ago (cooldown elapsed)", async () => {
    mockKgCount = 1050;
    mockKgCountError = null;
    mockClCount = 1000;
    mockClCountError = null;
    mockComputedAt = isoAgo(25 * 60 * 60 * 1000); // 25 hours ago
    mockComputedAtError = null;
    assert.equal(await isDirty("proj-5"), true);
  });
});
