# Graph-Aware Retrieval — Implementation Plan (Part 2 of 2: Concept-Bridge Re-Rank + Eval)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-rank `search_memory` results by fusing vector similarity with **concept-bridge** graph proximity, and recover graph-connected chunks vector search missed (the `SCM-S16-D1` cure) — behind a default-off flag, gated by an eval harness.

**Architecture (2-hop concept-bridge).** The graph connects chunks only *through* shared concept nodes: `chunk A → concept (SYMBOL/FILE/DECISION) → chunk B`. `kg_hybrid_search` returns the query's seed chunks (primaries, with `similarity`) and the concepts they mention (1-hop neighbors). We weight those concepts, then run **one indexed bridge query** to find every chunk that mentions them, score candidates + expansion chunks by shared-concept overlap, and fuse with the vector score. `α=1` reproduces today exactly.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), `node:test` + `node:assert/strict`, `tsx`, Supabase RPC `match_memory_chunks` + `kg_hybrid_search`, `src/config.ts` Zod env, `pg`-free (uses the supabase client).

**Spec:** [graph-aware-retrieval-design.md](../specs/2026-06-03-graph-aware-retrieval-design.md). **Depends on:** Part 1 (clean graph + SYMBOL bridges, shipped).

---

## Grounded data shapes (verified against live schema + DB, SCM-S50)

- **`kg_hybrid_search` → `seeds[]`**: `{id, type, label, properties, source_chunk_id, similarity}`. Only `embedding IS NOT NULL` nodes seed ⇒ seeds are chunk-anchoring primaries; `similarity` = σ.
- **`neighbors[]`**: `{id, type, label, properties, relation, weight, direction, via_node_id}`. **No chunk linkage** — neighbors are concept nodes; `via_node_id` points at the seed they hang off.
- **Chunk-id for a primary** is in **`properties->>'source_chunk_id'`** (authoritative: 356/381) more reliably than the `source_chunk_id` column (206/381; column ⊂ properties, 0 disagreements). **Always read `COALESCE(source_chunk_id, (properties->>'source_chunk_id')::bigint)`.**
- **Edges** (primary → concept): `NOTE→FILE`(703), `DECISION→FILE`(181), `DECISION→DECISION`(14, REFERENCES w1.5), `NOTE→DECISION`(11), `NOTE→SYMBOL`(11). **DECISION is dual-role** (primary AND concept), so the bridge selects the chunk-anchor end by "has a chunk id," not by type.
- Concept types: FILE/SYMBOL are 100% null-embedding/null-chunk (pure bridges).

---

## The math (the integration we're implementing)

Given seeds `S` (σ per seed) and neighbor entries `(k, w, via=s)`:

```
W(k)      = Σ over neighbor entries with id k of  σ[s] · w          # weighted query-concept set C = {k : W(k)>0}
B         = bridge(C.ids) → rows (concept_id k, chunk_id c, w_ck)   # one indexed query (SQL below)
g_raw(c)  = Σ over B rows (k,c,w_ck), k ∈ C of  W(k) · w_ck
candidates= vector top-N (MatchRow, cosine)
expansion = bridged chunks ∉ candidates, top-M by g_raw → fetch content+embedding → cosine
U         = candidates ∪ expansion (dedupe by chunk id)
v(c)      = minmax_U(cosine(c))      g(c) = minmax_U(g_raw(c))   (g_raw=0 if no shared concept)
score(c)  = α·v(c) + (1−α)·g(c)      → sort desc → top-K
```

`α=1` ≡ today (expansion cosine ≤ vector-pool floor → cannot displace top-K). `α<1` lifts concept-sharing chunks = the `SCM-S16-D1` cure. **Known minor effect (v1, not fixed):** a seed chunk that mentions `k` feeds its own σ into `W(k)` and receives it back in `g(c)` — small self-reinforcement, harmless; revisit if the eval shows over-boosting.

**Bridge SQL** (`$1` = concept ids, `$2` = project_id):

```sql
SELECT c.id AS concept_id,
       COALESCE(p.source_chunk_id, (p.properties->>'source_chunk_id')::bigint) AS chunk_id,
       e.weight AS w_ck
FROM kg_nodes c
JOIN kg_edges e ON (e.source_id = c.id OR e.target_id = c.id) AND e.project_id = $2
JOIN kg_nodes p ON p.id = CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END
                AND p.project_id = $2
WHERE c.id = ANY($1::bigint[])
  AND c.type IN ('FILE','DECISION','SYMBOL')
  AND COALESCE(p.source_chunk_id, (p.properties->>'source_chunk_id')::bigint) IS NOT NULL;
```

---

## As-Built Reconciliation (executed Session 50 — SCM-S50)

Part 2 shipped on `feat/graph-aware-retrieval` (T5–T10), full suite **430/430** green. Corrections to the draft below, recorded so this plan matches reality:

1. **No config mapping layer.** `config` is `z.infer<typeof Env>`, so knobs are read directly as **`config.SCM_GRAPH_RERANK_*`** (the T5/T9 blocks below are corrected from the draft's snake_case `config.graph_rerank_*`).
2. **`RerankParams` is `{ alpha }` only** — `search.ts` caps expansion and the bridge is fixed 2-hop, so no `expand`/`decay` reaches the scorer.
3. **`BridgeRow` lives in `src/supabase.ts`** (with the fetch fns); `rerank.ts` imports it.
4. **The bridge selects `p` by "has a chunk id", not by type** — including DECISION primaries (181 edges) the agent's `p.type NOT IN (...)` draft would have dropped.
5. **`search-graph-rag.test.ts` mock gained `fetchConceptChunks`/`fetchChunksByIds` no-ops** — search.ts's new imports must resolve even with rerank off.
6. **RPC smoke-validated** post-migration: 8 concept ids → 23 bridge rows via the service-role client.

**Commit trail:** `35980f5` (T5) · `2e1d77a` (T6) · `6f47432` (T7 + migration 027) · `ae51d60` (T8) · `be8e2d1` (T9) · `2653735` (T10).

**Remaining before the default-on flip (ship-gate):** curate `s16-d1-eval-queries.json` with verified-failing queries → run `eval-graph-rerank.ts` off-vs-on → confirm recall@3 up / mrr not down / no control regression → flip `SCM_GRAPH_RERANK_ENABLED`'s default in `src/config.ts` (its own PR).

---

## File Structure

- **Modify** `src/config.ts` — `SCM_GRAPH_RERANK_*` knobs (Zod). [T5]
- **Create** `src/tools/bridge.ts` — pure `conceptWeights(seeds, neighbors)` + `graphScores(bridgeRows, W)`. [T6, T8 helpers]
- **Modify** `src/supabase.ts` — `fetchConceptChunks(projectId, conceptIds)` (bridge query) + `fetchChunksByIds(projectId, ids, queryVec)` (expansion) + `cosineSim`/`parseVector`. [T7]
- **Create** `src/tools/rerank.ts` — pure `rerank(candidates, expansion, conceptWeights, bridgeRows, params)`. [T8]
- **Modify** `src/tools/search.ts` — flag-gated concept-bridge re-rank at the `graph_context` site. [T9]
- **Create** `src/tools/metrics.ts`, `scripts/eval-graph-rerank.ts`, fixture `docs/superpowers/specs/s16-d1-eval-queries.json`. [T10]
- **Modify** `package.json` — register each new test file in the `test` script list.

---

### Task 5: Config knobs (Zod)

**Files:** Modify `src/config.ts`; Test `tests/config-rerank.test.ts`.

- [ ] **Step 1: RED** — test the defaults (`config.SCM_GRAPH_RERANK_ENABLED===false`, `alpha===0.7`, `pool===40`, `expand===10`, `timeout_ms===50`). **No `decay` knob** — the concept-bridge is always exactly 2-hop (seed→concept→chunk), so there's no variable hop to decay; γ is dropped from spec §5 as YAGNI.
- [ ] **Step 2:** register test, run, fails.
- [ ] **Step 3: GREEN** — add to the Zod `Env` object + `config` mapping:
```ts
SCM_GRAPH_RERANK_ENABLED: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
SCM_GRAPH_RERANK_ALPHA: z.coerce.number().min(0).max(1).default(0.7),
SCM_GRAPH_RERANK_POOL: z.coerce.number().int().positive().default(40),
SCM_GRAPH_RERANK_EXPAND: z.coerce.number().int().min(0).default(10),
SCM_GRAPH_RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(50),
```
Read directly as `config.SCM_GRAPH_RERANK_*` — `config` is `z.infer<typeof Env>` with no snake_case mapping layer.
- [ ] **Step 4:** run → pass. **Step 5:** `npx tsc` + commit `feat(config): add SCM_GRAPH_RERANK_* knobs (default off)`.

> Naming: spec §5 said `SCM_GRAPH_RERANK`; we use `_ENABLED` to match `SCM_GRAPH_EXTRACTOR_ENABLED`.

---

### Task 6: Concept weighting (pure)

**Files:** Create `src/tools/bridge.ts`; Test `tests/bridge-concepts.test.ts`.

- [ ] **Step 1: RED**
```ts
// tests/bridge-concepts.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptWeights } from "../src/tools/bridge.js";

const seeds = [
  { id: 1, type: "NOTE", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.9 },
  { id: 2, type: "NOTE", label: "b", properties: {}, source_chunk_id: 20, similarity: 0.6 },
];
const neighbors = [
  { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
  { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 2 },
  { id: 200, type: "FILE", label: "gate.ts", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
];

describe("conceptWeights", () => {
  it("sums seed_sim × edge_weight per concept across seeds", () => {
    const W = conceptWeights(seeds as any, neighbors as any);
    assert.equal(W.get(100), 0.9 + 0.6); // mentioned by both seeds
    assert.equal(W.get(200), 0.9);       // only seed 1
  });
});
```
- [ ] **Step 2:** register, run, fails.
- [ ] **Step 3: GREEN** — `src/tools/bridge.ts`:
```ts
import type { KgSeed, KgNeighbor } from "./kg.js";

/** W(k) = Σ over neighbor entries of σ[via_seed] · edge_weight. */
export function conceptWeights(seeds: KgSeed[], neighbors: KgNeighbor[]): Map<number, number> {
  const sigma = new Map<number, number>(seeds.map((s) => [s.id, s.similarity]));
  const W = new Map<number, number>();
  for (const n of neighbors) {
    const s = sigma.get(n.via_node_id);
    if (s === undefined) continue;
    W.set(n.id, (W.get(n.id) ?? 0) + s * n.weight);
  }
  return W;
}
```
- [ ] **Step 4:** run → pass. **Step 5:** `npx tsc` + commit `feat(search): concept-weighting for graph re-rank`.

---

### Task 7: Bridge + expansion DB fns

**Files:** Modify `src/supabase.ts` (`fetchConceptChunks`, `fetchChunksByIds`, `cosineSim`, `parseVector`); Test `tests/bridge-fetch.test.ts` (mocked supabase client).

- [ ] **Step 1: RED** — mock the supabase client's `.rpc`/query path; assert `fetchConceptChunks` returns `{concept_id, chunk_id, w_ck}[]` and `fetchChunksByIds` maps rows → `MatchRow` with `similarity = cosineSim(queryVec, parseVector(embedding))`.
- [ ] **Step 2:** register, run, fails.
- [ ] **Step 3: GREEN** — implement. `fetchConceptChunks` runs the **bridge SQL** above via `supabase.rpc` (add a thin `kg_bridge_chunks(p_concept_ids bigint[], p_project_id text)` SQL function — migration `scripts/0NN_kg_bridge.sql`, `SECURITY DEFINER`, `set search_path = public, extensions, pg_catalog`) **or** via a parameterized `.rpc`. Prefer a migration function so the COALESCE logic lives in SQL. `fetchChunksByIds` selects `id,content,file_origin,chunk_index,metadata,embedding` from `memory_chunks` `.in("id", ids)` and computes cosine in JS.
```ts
export function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return [];
}
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return na && nb ? dot / (Math.sqrt(na)*Math.sqrt(nb)) : 0;
}
export interface BridgeRow { concept_id: number; chunk_id: number; w_ck: number; }
export async function fetchConceptChunks(projectId: string, conceptIds: number[]): Promise<BridgeRow[]> {
  if (!conceptIds.length) return [];
  const { data, error } = await supabase.rpc("kg_bridge_chunks", { p_concept_ids: conceptIds, p_project_id: projectId });
  if (error || !data) return [];
  return data as BridgeRow[];
}
```
- [ ] **Step 4:** run → pass. **Step 5:** `npm run schema 0NN_kg_bridge.sql` (apply migration), `npx tsc` + commit `feat(search): kg_bridge_chunks RPC + concept/expansion fetch`.

> CI gate asserts ≥20 `scripts/*.sql` — a new migration is additive-safe. RPC must replicate `set search_path` (SECURITY DEFINER) or `vector`/COALESCE ops misbehave.

---

### Task 8: Fusion scorer (pure)

**Files:** add `rerank` to `src/tools/rerank.ts`; Test `tests/rerank.test.ts`.

- [ ] **Step 1: RED** (α=1 non-regression + concept lift via expansion)
```ts
// tests/rerank.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rerank } from "../src/tools/rerank.js";

const row = (id: number, similarity: number) => ({ id, content: `c${id}`, file_origin: "f", chunk_index: 0, metadata: {}, similarity });
const W = new Map<number, number>([[100, 1.5]]);              // concept 100 is hot
const bridge = [{ concept_id: 100, chunk_id: 20, w_ck: 1 }, { concept_id: 100, chunk_id: 99, w_ck: 1 }];

describe("rerank (concept-bridge)", () => {
  it("alpha=1 preserves pure-vector order", () => {
    const out = rerank({ candidates: [row(10, 0.5), row(20, 0.8)], expansion: [], conceptWeights: W, bridge, params: { alpha: 1, expand: 10 } });
    assert.deepEqual(out.map((r) => r.id), [20, 10]);
  });
  it("alpha=0.3 lifts a concept-sharing chunk over a higher-vector unconnected one", () => {
    // chunk 20 shares hot concept 100 (g_raw=1.5); chunk 88 shares nothing but slightly higher vector
    const out = rerank({ candidates: [row(20, 0.50), row(88, 0.55)], expansion: [], conceptWeights: W, bridge, params: { alpha: 0.3, expand: 10 } });
    assert.equal(out[0].id, 20);
  });
});
```
(Two candidates ⇒ min-max gives a 0/1 split, so α=0.3 makes the graph term decisive — avoids a tie, per the Part 1 lesson.)
- [ ] **Step 2:** register, run, fails.
- [ ] **Step 3: GREEN** — `src/tools/rerank.ts`:
```ts
import type { MatchRow } from "../supabase.js";
import type { BridgeRow } from "../supabase.js";

export interface RerankParams { alpha: number; expand: number; }
export interface RerankInput {
  candidates: MatchRow[];
  expansion: MatchRow[];
  conceptWeights: Map<number, number>;
  bridge: BridgeRow[];
  params: RerankParams;
}

function graphScoreByChunk(bridge: BridgeRow[], W: Map<number, number>): Map<number, number> {
  const g = new Map<number, number>();
  for (const b of bridge) {
    const wk = W.get(b.concept_id);
    if (wk === undefined) continue;             // concept not in query set C
    g.set(b.chunk_id, (g.get(b.chunk_id) ?? 0) + wk * b.w_ck);
  }
  return g;
}
function minmax(xs: number[]): (x: number) => number {
  if (!xs.length) return () => 0;
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return (x) => (hi - lo < 1e-9 ? 1 : (x - lo) / (hi - lo));
}

export function rerank(input: RerankInput): MatchRow[] {
  const byId = new Map<number, MatchRow>();
  for (const r of [...input.candidates, ...input.expansion]) byId.set(r.id, r); // dedupe union
  const U = [...byId.values()];
  if (!U.length) return [];
  const g = graphScoreByChunk(input.bridge, input.conceptWeights);
  const vN = minmax(U.map((r) => r.similarity));
  const gN = minmax(U.map((r) => g.get(r.id) ?? 0));
  const { alpha } = input.params;
  return U
    .map((r) => ({ r, s: alpha * vN(r.similarity) + (1 - alpha) * gN(g.get(r.id) ?? 0) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
}
```
- [ ] **Step 4:** run → pass. **Step 5:** `npx tsc` + commit `feat(search): concept-bridge fusion scorer`.

---

### Task 9: Flag-gated integration in `search.ts`

**Files:** Modify `src/tools/search.ts`; Test `tests/search-rerank.test.ts` (mock `config`, `ollama`, `supabase`, `kg`).

- [ ] **Step 1: RED** — mock `config` (rerank on, α=0.3), `embed` (768-dim), `searchChunks` (two candidates), `kgHybridSearch` (one seed + one neighbor concept), `fetchConceptChunks` (bridge row linking the concept to the lower-vector candidate), `fetchChunksByIds` (`[]`). Assert the concept-sharing candidate is lifted to `results[0]`.
- [ ] **Step 2:** register, run, fails.
- [ ] **Step 3: GREEN** — at the `graph_context` site, when `config.SCM_GRAPH_RERANK_ENABLED`:
```ts
const pool = config.SCM_GRAPH_RERANK_ENABLED ? config.SCM_GRAPH_RERANK_POOL : (args.limit ?? 5);
// ...searchChunks(..., pool, ...) and kgHybridSearch(...) as today...
let results = chunks;
if (config.SCM_GRAPH_RERANK_ENABLED && graphContext && chunks.length) {
  const W = conceptWeights(graphContext.seeds, graphContext.neighbors);
  const conceptIds = [...W.keys()];
  let bridge: BridgeRow[] = [];
  try {
    bridge = await withTimeout(fetchConceptChunks(projectId, conceptIds), config.SCM_GRAPH_RERANK_TIMEOUT_MS);
  } catch { console.warn("graph_rerank_skipped: bridge_timeout"); }
  // expansion = bridged chunks not already candidates, top-M by g_raw
  const candIds = new Set(chunks.map((c) => c.id));
  const gRaw = new Map<number, number>();
  for (const b of bridge) { const wk = W.get(b.concept_id); if (wk) gRaw.set(b.chunk_id, (gRaw.get(b.chunk_id) ?? 0) + wk * b.w_ck); }
  const expandIds = [...gRaw.entries()].filter(([id]) => !candIds.has(id))
    .sort((a, b) => b[1] - a[1]).slice(0, config.SCM_GRAPH_RERANK_EXPAND).map(([id]) => id);
  let expansion: typeof chunks = [];
  if (expandIds.length) { try { expansion = await withTimeout(fetchChunksByIds(projectId, expandIds, queryVec), config.SCM_GRAPH_RERANK_TIMEOUT_MS); } catch { console.warn("graph_rerank_skipped: expansion_timeout"); } }
  results = rerank({ candidates: chunks, expansion, conceptWeights: W, bridge, params: { alpha: config.SCM_GRAPH_RERANK_ALPHA, expand: config.SCM_GRAPH_RERANK_EXPAND } });
}
results = results.slice(0, args.limit ?? 5);
```
Add a small `withTimeout(promise, ms)` helper (Promise.race → throw on timeout). Return `results` (count = `results.length`).
- [ ] **Step 4:** run `tests/search-rerank.test.ts` → pass; `npm test` → existing `search-graph-rag.test.ts` green (flag off by default). **Step 5:** `lint:boundaries` + `npx tsc` + commit `feat(search): flag-gated concept-bridge re-rank + recall expansion`.

---

### Task 10: Eval harness (ship-gate)

**Files:** Create `src/tools/metrics.ts` (`recallAtK`, `mrr` — pure, TDD), `scripts/eval-graph-rerank.ts` (single-phase, run twice: flag off vs on; `config` caches env at import), fixture `docs/superpowers/specs/s16-d1-eval-queries.json` (curate 5–10 real queries whose gold chunk currently ranks > 3 — verify each fails in the off-phase before adding it).

- [ ] TDD `metrics.ts` (recall@3, MRR). Implement the harness printing `{rerank_enabled, recall_at_3, mrr}`. Commit `feat(eval): S16-D1 recall@3/MRR harness`.

> **Ship-gate (spec §8/§9):** flip `SCM_GRAPH_RERANK_ENABLED` default to `true` only when the on-phase shows `recall_at_3` strictly up and `mrr` not down, with zero regression on a well-served control set. That flip is its own final commit + PR.

---

**Plan reconciled to the 2-hop concept-bridge reality.** Pure logic (T6, T8, metrics) gets full red→green TDD; DB fns (T7) and integration (T9) get mocked tests; the eval (T10) guards the default-on flip.
