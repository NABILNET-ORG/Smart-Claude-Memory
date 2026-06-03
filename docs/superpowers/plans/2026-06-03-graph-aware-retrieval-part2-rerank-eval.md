# Graph-Aware Retrieval — Implementation Plan (Part 2 of 2: Vector⊕Graph Re-Rank + Eval)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fuse vector similarity with graph proximity to **re-rank** `search_memory` results, and recover graph-connected chunks that vector search missed (the `SCM-S16-D1` cure) — behind a default-off flag, gated by an eval harness.

**Architecture:** A **pure scorer** (`src/tools/rerank.ts`) computes `score = α·v + (1−α)·g` over the candidate union. `search.ts` requests a wider pool (N=40), fetches ≤ M expansion chunks, calls the scorer, returns top-K. `α=1` reproduces today exactly. All knobs live in `src/config.ts` (Zod).

**Tech Stack:** as Part 1, plus the `match_memory_chunks` RPC (via `searchChunks`), `kgHybridSearch`, and `src/config.ts` Zod env parsing.

**Spec:** [2026-06-03-graph-aware-retrieval-design.md](../specs/2026-06-03-graph-aware-retrieval-design.md) (§5 Re-rank, §7 Errors, §8 Eval). **Depends on:** Part 1 (clean nodes).

**Naming note:** spec §5 wrote the master switch as `SCM_GRAPH_RERANK`; this plan uses `SCM_GRAPH_RERANK_ENABLED` to match the existing `SCM_GRAPH_EXTRACTOR_ENABLED` convention in the codebase.

---

## File Structure

- **Modify** `src/config.ts` — add the `graph_rerank_*` knobs to the Zod `Env` schema + the exported `config` mapping.
- **Create** `src/tools/rerank.ts` — pure fusion scorer (no I/O).
- **Modify** `src/supabase.ts` — `fetchChunksByIds()` + `cosineSim()` + `parseVector()`.
- **Modify** `src/tools/search.ts` — flag-gated re-rank at the existing `graph_context` site (~L225–268).
- **Create** `src/tools/metrics.ts`, `scripts/eval-graph-rerank.ts`, fixture `docs/superpowers/specs/s16-d1-eval-queries.json`.
- **Create** tests `tests/config-rerank.test.ts`, `tests/rerank.test.ts`, `tests/search-rerank.test.ts`, `tests/metrics.test.ts`; **modify** `package.json` (register each).

---

### Task 4: Config knobs (Zod)

**Files:** Modify `src/config.ts`; Test `tests/config-rerank.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config-rerank.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

describe("graph rerank config defaults", () => {
  it("ship-off, spec-aligned defaults", () => {
    assert.equal(config.graph_rerank_enabled, false);
    assert.equal(config.graph_rerank_alpha, 0.7);
    assert.equal(config.graph_rerank_decay, 0.5);
    assert.equal(config.graph_rerank_pool, 40);
    assert.equal(config.graph_rerank_expand, 10);
    assert.equal(config.graph_rerank_timeout_ms, 50);
  });
});
```

- [ ] **Step 2: Register, run, verify it fails** (`config.graph_rerank_enabled` is `undefined`).

- [ ] **Step 3: Implement** — add to the Zod `Env` object in `src/config.ts` (mirror existing entries at ~L20/L25):

```ts
  SCM_GRAPH_RERANK_ENABLED: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  SCM_GRAPH_RERANK_ALPHA: z.coerce.number().min(0).max(1).default(0.7),
  SCM_GRAPH_RERANK_DECAY: z.coerce.number().min(0).max(1).default(0.5),
  SCM_GRAPH_RERANK_POOL: z.coerce.number().int().positive().default(40),
  SCM_GRAPH_RERANK_EXPAND: z.coerce.number().int().min(0).default(10),
  SCM_GRAPH_RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(50),
```

Then expose them on the exported `config` object, following the file's existing snake_case mapping convention:

```ts
  graph_rerank_enabled: env.SCM_GRAPH_RERANK_ENABLED,
  graph_rerank_alpha: env.SCM_GRAPH_RERANK_ALPHA,
  graph_rerank_decay: env.SCM_GRAPH_RERANK_DECAY,
  graph_rerank_pool: env.SCM_GRAPH_RERANK_POOL,
  graph_rerank_expand: env.SCM_GRAPH_RERANK_EXPAND,
  graph_rerank_timeout_ms: env.SCM_GRAPH_RERANK_TIMEOUT_MS,
```

- [ ] **Step 4: Run, verify it passes.**

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc
git add src/config.ts tests/config-rerank.test.ts package.json
git commit -m "feat(config): add SCM_GRAPH_RERANK_* knobs (default off)"
```

---

### Task 5: Pure fusion scorer

**Files:** Create `src/tools/rerank.ts`; Test `tests/rerank.test.ts`.

- [ ] **Step 1: Write the failing test** (α=1 non-regression + graph lift)

```ts
// tests/rerank.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rerank } from "../src/tools/rerank.js";

const seed = { id: 1, type: "X", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.9 };
const cand = (id: number, similarity: number) => ({
  id, content: `c${id}`, file_origin: "f", chunk_index: 0, metadata: {}, similarity,
});

describe("rerank", () => {
  it("alpha=1 preserves pure-vector order (non-regression)", () => {
    const out = rerank({
      candidates: [cand(10, 0.5), cand(20, 0.8)], seeds: [seed], neighbors: [],
      expansion: [], params: { alpha: 1, decay: 0.5, expand: 10 },
    });
    assert.deepEqual(out.map((r) => r.id), [20, 10]);
  });

  it("graph proximity lifts a connected lower-vector chunk", () => {
    // chunk 10 holds the seed (hop 0, sim .9); chunk 99 is unconnected but higher vector.
    // alpha=0.3 makes graph weight (0.7) dominant, so the connected chunk wins decisively
    // (with only two candidates min-max gives a 0/1 split, so alpha=0.5 would tie).
    const out = rerank({
      candidates: [cand(10, 0.50), cand(99, 0.55)], seeds: [seed], neighbors: [],
      expansion: [], params: { alpha: 0.3, decay: 0.5, expand: 10 },
    });
    assert.equal(out[0].id, 10);
  });
});
```

- [ ] **Step 2: Register, run, verify it fails.**

- [ ] **Step 3: Implement `src/tools/rerank.ts`**

```ts
// src/tools/rerank.ts — pure vector⊕graph fusion (no I/O, no LLM).
import type { MatchRow } from "../supabase.js";
import type { KgSeed, KgNeighbor } from "./kg.js";

export interface RerankParams { alpha: number; decay: number; expand: number; }
export interface RerankInput {
  candidates: MatchRow[];
  seeds: KgSeed[];
  neighbors: KgNeighbor[];
  expansion: MatchRow[];
  params: RerankParams;
}

/** chunk_id -> graph proximity to the query seed set (hop 0 = seed itself, hop 1 = neighbor). */
function graphScoreByChunk(seeds: KgSeed[], neighbors: KgNeighbor[], decay: number): Map<number, number> {
  const seedSim = new Map<number, number>(seeds.map((s) => [s.id, s.similarity]));
  const g = new Map<number, number>();
  const add = (cid: number | null, v: number) => {
    if (cid != null) g.set(cid, (g.get(cid) ?? 0) + v);
  };
  for (const s of seeds) add(s.source_chunk_id, s.similarity); // hop 0
  for (const n of neighbors) add(n.source_chunk_id, (seedSim.get(n.via_node_id) ?? 0) * n.weight * decay); // hop 1
  return g;
}

/** Returns a min-max normalizer over the given values, collapsing to 1 when flat. */
function minmax(xs: number[]): (x: number) => number {
  if (!xs.length) return () => 0;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return (x) => (hi - lo < 1e-9 ? 1 : (x - lo) / (hi - lo));
}

export function rerank(input: RerankInput): MatchRow[] {
  const { seeds, neighbors, params } = input;
  const byId = new Map<number, MatchRow>();
  for (const r of [...input.candidates, ...input.expansion]) byId.set(r.id, r); // dedup union
  const union = [...byId.values()];
  if (!union.length) return [];

  const gScores = graphScoreByChunk(seeds, neighbors, params.decay);
  const vNorm = minmax(union.map((r) => r.similarity));
  const gNorm = minmax(union.map((r) => gScores.get(r.id) ?? 0));

  return union
    .map((r) => ({
      r,
      score: params.alpha * vNorm(r.similarity) + (1 - params.alpha) * gNorm(gScores.get(r.id) ?? 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}
```

- [ ] **Step 4: Run, verify both cases pass.**

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc
git add src/tools/rerank.ts tests/rerank.test.ts package.json
git commit -m "feat(search): pure vector⊕graph fusion scorer"
```

---

### Task 6: Expansion fetch + flag-gated integration

**Files:** Modify `src/supabase.ts` (`fetchChunksByIds`, `cosineSim`, `parseVector`); Modify `src/tools/search.ts`; Test `tests/search-rerank.test.ts`.

- [ ] **Step 1: Write the failing integration test** (mocks per `search-graph-rag.test.ts` conventions)

```ts
// tests/search-rerank.test.ts
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

describe("searchMemory re-rank integration", () => {
  it("lifts a graph-connected chunk above a higher-vector unconnected one", async () => {
    // Mock config directly: `config` caches env at import, so setting process.env in a
    // test is unreliable across the shared node:test process. Include EVERY config key
    // search.ts reads (confirm the full set when reading the file in Step 3b).
    mock.module("../src/config.js", {
      namedExports: { config: {
        graph_rerank_enabled: true, graph_rerank_alpha: 0.3, graph_rerank_decay: 0.5,
        graph_rerank_pool: 40, graph_rerank_expand: 10, graph_rerank_timeout_ms: 50,
      } },
    });
    mock.module("../src/ollama.js", {
      namedExports: { embed: async () => [new Array(768).fill(0.01)] }, // 768-dim (kgHybridSearch guard)
    });
    mock.module("../src/supabase.js", {
      namedExports: {
        searchChunks: async () => [
          { id: 10, content: "x", file_origin: "f", chunk_index: 0, metadata: {}, similarity: 0.50 },
          { id: 99, content: "y", file_origin: "f", chunk_index: 0, metadata: {}, similarity: 0.55 },
        ],
        fetchChunksByIds: async () => [],
      },
    });
    mock.module("../src/tools/kg.js", {
      namedExports: {
        kgHybridSearch: async () => ({
          ok: true,
          seeds: [{ id: 1, type: "X", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.95 }],
          neighbors: [],
        }),
      },
    });
    const { searchMemory } = await import("../src/tools/search.js");
    const res = await searchMemory({ query: "q", project_id: "p" });
    assert.equal(res.results[0].id, 10, "graph-connected chunk 10 lifted above 99");
  });
});
```

- [ ] **Step 2: Register, run, verify it fails.**

- [ ] **Step 3a: Add helpers to `src/supabase.ts`**

```ts
/** pgvector arrives as a JSON-ish string over PostgREST; normalize to number[]. */
export function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Fetch specific chunks (recall expansion) and score them vs the query vector in-memory. */
export async function fetchChunksByIds(
  projectId: string, ids: number[], queryEmbedding: number[],
): Promise<MatchRow[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("id,content,file_origin,chunk_index,metadata,embedding")
    .eq("project_id", projectId)
    .in("id", ids);
  if (error || !data) return [];
  return data.map((r: any) => ({
    id: r.id, content: r.content, file_origin: r.file_origin,
    chunk_index: r.chunk_index, metadata: r.metadata,
    similarity: cosineSim(queryEmbedding, parseVector(r.embedding)),
  }));
}
```

- [ ] **Step 3b: Integrate in `src/tools/search.ts`** (read L225–268 first)

Imports at top:
```ts
import { config } from "../config.js";
import { rerank } from "./rerank.js";
import { fetchChunksByIds } from "../supabase.js";
```

When re-rank is enabled, widen the candidate pool — change the `searchChunks(... matchCount ...)` argument to:
```ts
config.graph_rerank_enabled ? config.graph_rerank_pool : (args.limit ?? 5)
```

After `graphContext` is built and `chunks` (the `searchChunks` result) is in scope, replace the bare `results = chunks` with:
```ts
let results = chunks;
if (config.graph_rerank_enabled && graphContext && chunks.length) {
  const candIds = new Set(chunks.map((c) => c.id));
  const expandIds = [...new Set(
    graphContext.neighbors
      .map((n) => n.source_chunk_id)
      .filter((x): x is number => x != null && !candIds.has(x)),
  )].slice(0, config.graph_rerank_expand);

  let expansion: typeof chunks = [];
  try {
    expansion = await Promise.race([
      fetchChunksByIds(projectId, expandIds, queryVec),
      new Promise<typeof chunks>((_, reject) =>
        setTimeout(() => reject(new Error("rerank_timeout")), config.graph_rerank_timeout_ms),
      ),
    ]);
  } catch {
    console.warn("graph_rerank_skipped: expansion_timeout"); // §7: never silent
  }

  results = rerank({
    candidates: chunks,
    seeds: graphContext.seeds,
    neighbors: graphContext.neighbors,
    expansion,
    params: {
      alpha: config.graph_rerank_alpha,
      decay: config.graph_rerank_decay,
      expand: config.graph_rerank_expand,
    },
  });
}
results = results.slice(0, args.limit ?? 5);
```

Return `results` (not the raw `chunks`) in the response object, and keep `count: results.length`.

- [ ] **Step 4: Run + regression check**

Run `tests/search-rerank.test.ts` → PASS. Then `npm test` (full suite) → the existing `search-graph-rag.test.ts` must stay green (flag defaults off, so behavior is unchanged when the test doesn't set it).

- [ ] **Step 5: Build gate + commit**

```bash
npx tsx scripts/lint-boundaries.ts
npx tsc
git add src/supabase.ts src/tools/search.ts tests/search-rerank.test.ts package.json
git commit -m "feat(search): flag-gated graph-aware re-rank + recall expansion"
```

---

### Task 7: Eval harness (the ship-gate)

**Files:** Create `src/tools/metrics.ts`, `scripts/eval-graph-rerank.ts`, `docs/superpowers/specs/s16-d1-eval-queries.json`; Test `tests/metrics.test.ts`.

- [ ] **Step 1: Write the failing metrics test**

```ts
// tests/metrics.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, mrr } from "../src/tools/metrics.js";

describe("metrics", () => {
  it("recall@3", () => {
    assert.equal(recallAtK([5, 1, 9], 7, 3), 0); // gold 7 not in top-3
    assert.equal(recallAtK([5, 7, 9], 7, 3), 1);
  });
  it("MRR", () => {
    assert.equal(mrr([5, 7, 9], 7), 1 / 2);
    assert.equal(mrr([5, 1, 9], 7), 0);
  });
});
```

- [ ] **Step 2: Register, run, verify it fails.**

- [ ] **Step 3: Implement `src/tools/metrics.ts`**

```ts
// src/tools/metrics.ts — pure retrieval metrics.
export function recallAtK(rankedIds: number[], goldId: number, k: number): number {
  return rankedIds.slice(0, k).includes(goldId) ? 1 : 0;
}

export function mrr(rankedIds: number[], goldId: number): number {
  const i = rankedIds.indexOf(goldId);
  return i < 0 ? 0 : 1 / (i + 1);
}
```

- [ ] **Step 4: Run, verify it passes.**

- [ ] **Step 5: Create the fixture** `docs/superpowers/specs/s16-d1-eval-queries.json`

Curate 5–10 REAL cases where the gold chunk currently ranks worse than 3 (confirm each by running the harness with the flag OFF — `before.recall@3` should be low). Shape:
```json
[
  { "query": "<generic query that today buries the right chunk>", "gold_chunk_id": 12345, "project_id": "claude-memory" }
]
```
This is a data-curation step, not a placeholder: each entry must be verified to currently fail before it earns a place in the fixture.

- [ ] **Step 6: Implement `scripts/eval-graph-rerank.ts`** (single-phase — `config` caches env at import, so compare across two process runs)

```ts
// scripts/eval-graph-rerank.ts — prints recall@3 + MRR for the CURRENT config.
// Compare phases by running twice (flag off, then on) and diffing the JSON.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { searchMemory } from "../src/tools/search.js";
import { recallAtK, mrr } from "../src/tools/metrics.js";
import { config } from "../src/config.js";

interface EvalCase { query: string; gold_chunk_id: number; project_id: string; }

async function main(): Promise<void> {
  const cases: EvalCase[] = JSON.parse(
    readFileSync("docs/superpowers/specs/s16-d1-eval-queries.json", "utf8"),
  );
  let r3 = 0, m = 0;
  for (const c of cases) {
    const res: any = await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 });
    const ids: number[] = res.results.map((x: any) => x.id);
    r3 += recallAtK(ids, c.gold_chunk_id, 3);
    m += mrr(ids, c.gold_chunk_id);
  }
  console.log(JSON.stringify({
    rerank_enabled: config.graph_rerank_enabled,
    cases: cases.length,
    recall_at_3: r3 / cases.length,
    mrr: m / cases.length,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run both phases (against a seeded DB / `.env.test`):
```bash
SCM_GRAPH_RERANK_ENABLED=false npx tsx scripts/eval-graph-rerank.ts   # baseline
SCM_GRAPH_RERANK_ENABLED=true  npx tsx scripts/eval-graph-rerank.ts   # candidate
```

- [ ] **Step 7: Commit**

```bash
npx tsc
git add src/tools/metrics.ts scripts/eval-graph-rerank.ts docs/superpowers/specs/s16-d1-eval-queries.json tests/metrics.test.ts package.json
git commit -m "feat(eval): S16-D1 recall@3/MRR harness for graph re-rank ship-gate"
```

> **Ship-gate (spec §8/§9.5):** flip the `SCM_GRAPH_RERANK_ENABLED` default to `true` in `src/config.ts` **only** when the candidate phase shows `recall_at_3` strictly up and `mrr` not down, with **zero** regression on a control set of well-served queries. That default-flip is its own final commit + PR.

---

**Plan complete.** Parts 1–2 deliver: clean entity extraction, a purged graph, a pure fusion scorer, flag-gated graph-aware retrieval with recall expansion, and the eval harness that guards the default-on flip — exactly the spec's §9 rollout, one commit per step.
