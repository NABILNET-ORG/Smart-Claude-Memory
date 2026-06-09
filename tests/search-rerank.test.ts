import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { MatchRow } from "../src/supabase.js";

// Re-rank integration through searchMemory with all I/O mocked. node:test forbids
// re-mocking a specifier that is already mocked (ERR_INVALID_STATE) and caches the
// dynamically-imported search module after the first import, so we follow the
// proven pattern from search-graph-rag.test.ts: register every mock.module ONCE at
// module scope with MUTABLE behavior driven by the `let` variables below, import
// searchMemory ONCE, and have each test set the knobs it needs in beforeEach.
//
// `config` is a single mutable object — search.ts reads its fields at call time, so
// mutating it between tests deterministically pins the exact flag state each test
// verifies (never the global default). chat() is a throwing stub by default (proves
// it never fires on the disabled / peaked paths); the one ENABLED test swaps in a
// permutation-returning impl and asserts the reorder.

type ConfigShape = {
  SCM_GRAPH_RERANK_ENABLED: boolean;
  SCM_GRAPH_RERANK_ALPHA: number;
  SCM_GRAPH_RERANK_POOL: number;
  SCM_GRAPH_RERANK_EXPAND: number;
  SCM_GRAPH_RERANK_TIMEOUT_MS: number;
  SCM_GRAPH_MARGIN_THRESHOLD: number;
  SCM_LLM_RERANK_ENABLED: boolean;
  SCM_RERANK_MODEL: string;
  SCM_LLM_RERANK_POOL: number;
  SCM_LLM_RERANK_SNIPPET: number;
  SCM_LLM_RERANK_TIMEOUT_MS: number;
  SCM_LLM_RERANK_PIN_TOP1: boolean;
};

// Spec-aligned baseline; beforeEach resets to this, each test overrides per-knob.
const BASELINE_CONFIG: ConfigShape = {
  SCM_GRAPH_RERANK_ENABLED: false,
  SCM_GRAPH_RERANK_ALPHA: 0.7,
  SCM_GRAPH_RERANK_POOL: 40,
  SCM_GRAPH_RERANK_EXPAND: 10,
  SCM_GRAPH_RERANK_TIMEOUT_MS: 1500,
  SCM_GRAPH_MARGIN_THRESHOLD: 0.02,
  SCM_LLM_RERANK_ENABLED: false,
  SCM_RERANK_MODEL: "",
  SCM_LLM_RERANK_POOL: 12,
  SCM_LLM_RERANK_SNIPPET: 400,
  SCM_LLM_RERANK_TIMEOUT_MS: 8000,
  SCM_LLM_RERANK_PIN_TOP1: true,
};

// The live config object handed to search.ts. Mutated in place (never reassigned)
// so the reference search.ts captured at import stays valid.
const config: ConfigShape = { ...BASELINE_CONFIG };

const throwingChat = async (): Promise<string> => {
  throw new Error("chat() must not be called on this path");
};

// Mutable I/O knobs the tests drive.
let chatImpl: () => Promise<string> = throwingChat;
let chatCalls = 0;
let searchChunksRows: MatchRow[] = [];
let fetchConceptChunksRows: Array<{ concept_id: number; chunk_id: number; w_ck: number }> = [];
let fetchChunksByIdsRows: MatchRow[] = [];
let kgBehavior: () => Promise<unknown> = async () => ({ ok: false, reason: "stub" });

mock.module("../src/config.js", {
  namedExports: {
    config,
    memoryRoots: [],
  },
});

mock.module("../src/ollama.js", {
  namedExports: {
    embed: async () => [new Array(768).fill(0.01)],
    // SCM-S54: search.ts imports chat() for the LLM reranker. Default throws so any
    // disabled/peaked path that touches chat() fails loudly; the ENABLED test swaps
    // in a permutation-returning impl.
    chat: async () => {
      chatCalls += 1;
      return chatImpl();
    },
  },
});

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {},
    listBacklog: async () => [],
    listArchive: async () => [],
    searchChunks: async () => searchChunksRows,
    fetchConceptChunks: async () => fetchConceptChunksRows,
    fetchChunksByIds: async () => fetchChunksByIdsRows,
  },
});

mock.module("../src/tools/kg.js", {
  namedExports: {
    kgHybridSearch: async () => kgBehavior(),
  },
});

// The LLM path routes through the ARM daemon budget gate. Stub it to always allow
// so the rerank fires; search.ts only inspects `.decision`.
mock.module("../src/budget/gate.js", {
  namedExports: {
    checkDaemonBudget: async () => ({ decision: "allow" }),
    checkTaskBudget: async () => ({ decision: "allow" }),
  },
});

const { searchMemory } = await import("../src/tools/search.js");

const row = (id: number, similarity: number, content = `c-${id}`): MatchRow => ({
  id,
  content,
  file_origin: "f",
  chunk_index: 0,
  metadata: {},
  similarity,
});

beforeEach(() => {
  Object.assign(config, BASELINE_CONFIG);
  chatImpl = throwingChat;
  chatCalls = 0;
  searchChunksRows = [];
  fetchConceptChunksRows = [];
  fetchChunksByIdsRows = [];
  kgBehavior = async () => ({ ok: false, reason: "stub" });
});

// SCM-S53 — concept-bridge re-rank. searchChunks returns VECTOR order (88, 50, 20)
// with a TIGHT top-1/top-2 margin (0.005 < SCM_GRAPH_MARGIN_THRESHOLD 0.02) so the
// confidence gate ENGAGES the graph. The bridged chunk 20 is lifted above the
// unconnected rank-2 chunk 50, while the non-demoting pin keeps the vector top-1
// (88) at rank 1. The LLM flag is OFF so the graph path runs and chat() must not
// fire (the default throwing stub proves it).
describe("searchMemory concept-bridge re-rank integration", () => {
  it("lifts a concept-sharing chunk above a lower unconnected one without demoting the pinned top-1 (SCM-S53)", async () => {
    config.SCM_GRAPH_RERANK_ENABLED = true;
    config.SCM_GRAPH_RERANK_ALPHA = 0.3;
    config.SCM_GRAPH_RERANK_TIMEOUT_MS = 50;
    config.SCM_LLM_RERANK_ENABLED = false;
    searchChunksRows = [row(88, 0.55, "y"), row(50, 0.545, "z"), row(20, 0.5, "x")];
    fetchConceptChunksRows = [{ concept_id: 100, chunk_id: 20, w_ck: 1 }];
    kgBehavior = async () => ({
      ok: true,
      seeds: [{ id: 1, type: "NOTE", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.95 }],
      neighbors: [
        { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
      ],
    });

    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.equal(res.results[0].id, 88, "vector top-1 (88) is PINNED — non-demoting, never sacrificed");
    assert.equal(res.results[1].id, 20, "concept chunk 20 lifted above the unconnected rank-2 chunk 50 (bounded by the pin)");
    assert.equal(chatCalls, 0, "graph path active ⇒ chat() never fires");
  });
});

// SCM-S54 — LLM listwise rerank, end-to-end through searchMemory. The reranker now
// ships ON by default; every test EXPLICITLY pins the flag state it verifies.
describe("searchMemory LLM listwise rerank integration (SCM-S54)", () => {
  // Low-confidence (FLAT) pool: top1-top2 margin 0.005 < 0.02 threshold ⇒ the
  // confidence gate ENGAGES the reranker. Vector order 10,11,12; id 10 is max-sim.
  const flatPool = (): MatchRow[] => [row(10, 0.55), row(11, 0.545), row(12, 0.5)];

  it("DISABLED ⇒ pure vector order unchanged, chat() never fires", async () => {
    config.SCM_LLM_RERANK_ENABLED = false;
    config.SCM_GRAPH_RERANK_ENABLED = false;
    searchChunksRows = flatPool();

    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.deepEqual(
      res.results.map((r) => r.id),
      [10, 11, 12],
      "disabled ⇒ untouched pure-vector order",
    );
    assert.equal(chatCalls, 0, "disabled ⇒ chat() never fires");
  });

  it("ENABLED + FLAT margin ⇒ chat() fires and the LLM permutation reorders ranks 2+ (pin holds rank 1)", async () => {
    config.SCM_LLM_RERANK_ENABLED = true;
    config.SCM_RERANK_MODEL = "qwen3-coder:480b-cloud";
    config.SCM_LLM_RERANK_PIN_TOP1 = true;
    searchChunksRows = flatPool();
    // Valid listwise permutation: LLM ranks candidate 3 (id 12) best, then 2 (id 11),
    // then 1 (id 10) — i.e. it DEMOTES the max-sim anchor (id 10) to last. The
    // non-demoting pin re-anchors id 10 to rank 1 and preserves the LLM's relative
    // order for the REST (the LLM put 12 before 11), so the final order is 10,12,11.
    chatImpl = async () => '{"ranking":[3,2,1]}';

    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.equal(chatCalls, 1, "the enabled reranker must invoke chat() exactly once");
    assert.deepEqual(
      res.results.map((r) => r.id),
      [10, 12, 11],
      "pin restores max-sim id 10 to rank 1; the LLM's relative order for the rest (12 before 11) is kept",
    );
  });

  it("ENABLED + FLAT margin + pin OFF ⇒ pure LLM permutation stands (max-sim demoted)", async () => {
    config.SCM_LLM_RERANK_ENABLED = true;
    config.SCM_RERANK_MODEL = "qwen3-coder:480b-cloud";
    config.SCM_LLM_RERANK_PIN_TOP1 = false;
    searchChunksRows = flatPool();
    // Same permutation, but with the pin OFF the LLM's demotion of max-sim id 10 to
    // last stands: final order is exactly 12, 11, 10.
    chatImpl = async () => '{"ranking":[3,2,1]}';

    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.equal(chatCalls, 1, "the enabled reranker must invoke chat() exactly once");
    assert.deepEqual(
      res.results.map((r) => r.id),
      [12, 11, 10],
      "pin OFF ⇒ raw LLM order, max-sim id 10 demoted to last",
    );
  });

  it("ENABLED but PEAKED margin ⇒ confidence gate skips the reranker, chat() never fires", async () => {
    config.SCM_LLM_RERANK_ENABLED = true;
    config.SCM_RERANK_MODEL = "qwen3-coder:480b-cloud";
    // PEAKED: top1 0.90, top2 0.50 → margin 0.40 ≥ 0.02 ⇒ gate skips rerank.
    searchChunksRows = [row(10, 0.9), row(11, 0.5), row(12, 0.45)];

    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.deepEqual(
      res.results.map((r) => r.id),
      [10, 11, 12],
      "peaked margin ⇒ pure-vector order, reranker bypassed",
    );
    assert.equal(chatCalls, 0, "peaked margin ⇒ chat() never fires");
  });
});
