# Graph-Aware Retrieval — Design Spec

| | |
|---|---|
| **Epic** | A (v2.5.0 Keystone) |
| **Session** | 50 |
| **Decision** | `SCM-S50-D1` (to be saved on approval) |
| **Status** | **DRAFT — awaiting user review** |
| **Date** | 2026-06-03 |
| **Author** | Orchestrator (Opus 4.8) |
| **Context** | Fixes `SCM-S16-D1` (top-K recall bug); builds on the Session 37 KG milestone (migration `020_knowledge_graph.sql`); honors `SCM-S19-D1` recall-purity principle |

---

## 1. Problem & Motivation

Three coupled defects, all verified against code + DB this session:

1. **The graph rides along decoratively.** [`src/tools/search.ts:232`](../../../src/tools/search.ts) runs vector top-K, then attaches `graph_context` (seeds + neighbors) to the response **without it influencing rank or recall**. The graph is computed, returned, and ignored.
2. **The documented recall bug (`SCM-S16-D1`).** Top-K=3 vector retrieval lets "generic queries get squeezed out by closer-similarity neighbors" — high-value chunks that ARE graph-connected to the query never enter the result set. A pure reorder cannot fix this; the right chunk is not in the candidate pool.
3. **Garbage-tier nodes.** `graph_extractor` anchors raw-markdown fragments (`> n161`, `s"]`) because it tokenizes Mermaid / code / table syntax as entities. Re-ranking on this signal would amplify noise — so extraction quality is a **hard prerequisite**, not a parallel nice-to-have.

**No prior decision blocks this.** A `{type:DECISION}` memory sweep found `graph_context` shipped read-only in the Session 37 KG milestone as *visualization* context; leaving it out of ranking was incompleteness, not a deliberate latency/correctness trade-off. `SCM-S19-D1`'s "recall purity" principle actively *supports* cleaning the graph before consuming it.

---

## 2. Goals / Non-Goals

**Goals**

- **G1** — `graph_extractor` emits entity-grade nodes (symbols, files, decisions, concepts); zero Mermaid/markdown fragments.
- **G2** — `search_memory` fuses vector similarity with graph proximity to **re-rank** results.
- **G3** — Graph-augmented **recall**: pull in high-value seed-neighbor chunks that vector top-N missed (the `SCM-S16-D1` cure).
- **G4** — Provable non-regression and a measurable before/after on the `SCM-S16-D1` failure set.

**Non-Goals (YAGNI)**

- **N1** — No full GraphRAG / community-summary retrieval.
- **N2** — No generative LLM anywhere in the extractor (Boundary Invariant #1).
- **N3** — No embedding arithmetic in the extractor — lexical dedup only (user ruling, this session).
- **N4** — No new daemon, no schema redesign — reuse `kg_nodes` / `kg_edges` (migration `020`).

---

## 3. Boundary Invariants

- **BI-1 (hard)** — `src/graph/**` extractor contains **zero** generative-LLM calls. Reinforced by the existing `lint:boundaries` discipline; this spec adds a static test (T2) asserting no Ollama/LLM import is reachable from the extractor module.
- **BI-2** — Re-ranking ships **off by default** (`SCM_GRAPH_RERANK=false`) until the eval gate (T4) passes. `α = 1.0` reproduces today's ranking exactly → boundary-safe.
- **BI-3** — The query-time path adds **no** LLM call and **no** new embedding call — pure arithmetic over already-retrieved rows plus one indexed graph fetch.

---

## 4. Component 1 — Deterministic Extraction Fix

**Unit:** `src/graph/extract.ts` (pure functions) consumed by `src/graph/daemon.ts`.
**Interface:** `extractEntities(chunkText, chunkMeta) -> { nodes: Node[], edges: Edge[] }` — no I/O, fully unit-testable in isolation.

**Root cause:** the extractor tokenizes **raw markdown**, so `graph TD; n161 --> n162`, blockquotes, and table delimiter rows become "entities." The fix is structural, not statistical.

**Pipeline (every stage deterministic):**

1. **Sanitize first (the 90% win).** Before tokenizing, strip: fenced code blocks, ` ```mermaid ` blocks, HTML tags, table delimiter rows (`|---|`), blockquote-prefixed diagram lines, and inline-code spans that are not identifier-shaped. Operate on **prose only**. This single stage removes the entire garbage class (`> n161`, `s"]`).
2. **Typed candidate producers** (regex classes → node `type`):

   | Producer | Pattern (sketch) | Node type |
   |---|---|---|
   | Symbol | backticked OR CamelCase / snake_case / `dotted.path` / `fn()` | `SYMBOL` |
   | File | `src/…`, `[\w/-]+\.\w{1,5}` | `FILE` |
   | Decision | `SCM-S\d+-D\d+` | `DECISION` |
   | Milestone | `\bM\d\b` | `MILESTONE` |
   | Concept | Title-Case multiword run (≥ 2 words) | `CONCEPT` |

   Backticked spans are treated as high-confidence — the author already flagged them as entities.
3. **Normalize + denylist (lexical only).** Casefold for the dedup key, strip trailing brackets/punctuation, enforce min length ≥ 3, drop pure-stopword tokens, and apply a hard denylist of structural tokens (`graph`, `subgraph`, `-->`, `TD`, `LR`, `n\d+`, `s"]`, …).
4. **Edges = intra-chunk co-occurrence.** Node pairs co-occurring within a chunk/section → `MENTIONS` / `RELATES_TO`, `weight` = co-occurrence count (integer arithmetic). Existing `direction` / `via_node_id` semantics preserved.
5. **Dedup = lexical** (casefold + canonical form). Embedding-based merge is explicitly **OUT** (user ruling — keep the daemon pure, cheap, fast).

**Backfill migration.** A one-off re-extraction over existing `memory_chunks` to purge already-poisoned nodes/edges. Idempotent (`UNIQUE(project_id, label, type)`); gated behind a script flag; logs before/after counts. Nodes no longer produced (e.g. `> n161`) are deleted.

---

## 5. Component 2 — Graph-Aware Re-Rank

**Unit:** `src/tools/rerank.ts` (pure scoring) invoked from `src/tools/search.ts` at the existing `graph_context` site (≈ line 232).
**Interface:** `rerank(candidates, seeds, edgeMap, params) -> rankedResults` — no I/O; the single graph fetch is performed by the caller.

### Stage 1 — Retrieve (latency unchanged)

Vector top-**N** (N = 40, env `SCM_GRAPH_RERANK_POOL`) via the existing `vector_cosine_ops` index. Identical to today's first step.

### Stage 2 — Fuse (in-memory, O(N))

For candidate chunk `c` with node-set `Nodes(c)`, and query seed set `S` (each seed `s` carrying its vector similarity `σ_s`, already present in `graph_context.seeds[].similarity`):

```
# vector component — min-max normalized across the N candidates → [0,1]
v(c) = (cos(c) − cos_min) / (cos_max − cos_min + ε)

# graph component — seed-weighted, edge-weighted, hop-decayed; then min-max → [0,1]
g_raw(c) = Σ_{s ∈ S}  σ_s · Σ_{e : s → n, n ∈ Nodes(c)}  w_e · γ^{hops(e)}
g(c)     = (g_raw(c) − g_min) / (g_max − g_min + ε)

# fused score
score(c) = α · v(c) + (1 − α) · g(c)
```

`w_e` = edge `weight` (already returned in `graph_context.neighbors[].weight`); `hops`: seed = 0, 1-hop neighbor = 1 (today's `graph_context` is 1-hop, so `hops ∈ {0,1}`; the formula generalizes if depth grows).

**Parameters (all env-tunable):**

| Param | Env var | Default | Meaning |
|---|---|---|---|
| α | `SCM_GRAPH_RERANK_ALPHA` | `0.7` | vector vs. graph weight; **α=1 ≡ today** |
| γ | `SCM_GRAPH_RERANK_DECAY` | `0.5` | per-hop decay |
| N | `SCM_GRAPH_RERANK_POOL` | `40` | vector candidate pool size |
| M | `SCM_GRAPH_RERANK_EXPAND` | `10` | max recall-expansion neighbors |
| timeout | `SCM_GRAPH_RERANK_TIMEOUT_MS` | `50` | graph-fetch budget before fallback |
| flag | `SCM_GRAPH_RERANK` | `false` | master switch |

### Stage 3 — Recall Expansion (the `SCM-S16-D1` cure)

Collect up to **M** chunks that are strong seed-neighbors but fell **outside** the vector top-N (identified from the seed-edge fetch below). Their embeddings come back in that **same** fetch, so `cos` is computed **in-memory** against the query vector already on hand — no extra round-trip. Score them with the same formula and re-rank the **union** `(N ∪ expansion)`. Return the top-K. This is what recovers "squeezed-out high-value neighbors" — reorder alone cannot, because those chunks were never in the pool.

### Graph fetch

A **single** indexed query: `kg_edges` where `source_node_id IN (seed_ids)`, joined to node→chunk membership (`kg_nodes.source_chunk_id`) and the embeddings of the expansion-candidate chunks. All remaining work — proximity, fusion, and the expansion cosine — is arithmetic over ≤ N + M (~50) in-memory rows.

---

## 6. Data Flow

```
query
  → embed                                   # existing single Ollama call (unchanged)
  → vector top-N  (vector_cosine_ops)        # unchanged
  → seed nodes + 1-hop neighbors             # already computed today (graph_context)
  → [NEW] 1 indexed fetch: seed edges ⋈ node→chunk membership ⋈ expansion embeddings
  → [NEW] rerank(): v(c), g(c), score(c), recall-expansion (≤ M)  — all in-memory arithmetic
  → top-K  →  response (graph_context still returned for transparency)
```

---

## 7. Error Handling & Failure Modes (no silent failure)

| Condition | Behavior |
|---|---|
| Flag off (`SCM_GRAPH_RERANK=false`) | Stage 1 result returned verbatim (today's behavior). |
| Empty graph / no seeds / no edges | `g(c)=0 ∀c` → `score = α·v(c)` → identical ordering to today. Safe degenerate. |
| Graph fetch exceeds timeout | Abandon graph stage, return pure-vector top-K, emit `graph_rerank_skipped{reason}` telemetry. Never blocks a search. |
| `cos_max == cos_min` (normalization) | ε guard; `v(c)=1 ∀c`, graph becomes sole tie-breaker; still bounded. |

---

## 8. Testing & Verification (the ship-gate)

- **T1 — Extractor unit tests.** Feed chunks containing Mermaid/code/tables; assert **zero** structural fragments emitted; assert known symbols/files/decisions ARE emitted. Explicit regression fixtures for `> n161` and `s"]`.
- **T2 — Boundary test (BI-1).** Static assertion: no LLM/Ollama import reachable from `src/graph/extract.ts`.
- **T3 — Re-rank unit tests.** Synthetic candidates + edges; assert **α=1 ≡ pure-vector order** (non-regression); assert a seeded high-graph/low-vector chunk rises; assert expansion injects an out-of-pool neighbor.
- **T4 — `SCM-S16-D1` eval harness (the proof).** A fixture of the generic queries that currently bury the correct chunk past top-3. Metrics: **recall@3** and **MRR**, before (α=1) vs. after (α=0.7 + expansion). **Ship-gate:** recall@3 strictly improves with **no** regression on a control set of well-served queries.
- **T5 — Latency assertion.** Added query latency **< 30 ms p50** on the eval set.

`npm run build` green **and** T1–T5 passing are the precondition for `confirm_verification` (Self-Verification imperative).

---

## 9. Rollout (Foundation-First, one commit per step)

1. Land extraction fix + unit tests (T1, T2). — *Foundation Fix commit.*
2. Run backfill migration (purge garbage nodes); observe node-quality delta.
3. Land re-rank behind `SCM_GRAPH_RERANK=false` + tests (T3). — *Feature commit on top.*
4. Build the `SCM-S16-D1` eval harness (T4); tune α/γ on it.
5. Flip `SCM_GRAPH_RERANK=true` to default **only after** the T4 ship-gate passes.
6. *(Deferred → Epic-C synergy)* surface node-quality + re-rank telemetry in the GUI.

No entangled commits: the extractor (foundation) lands and is verified before the re-rank (feature) rides on top.

---

## 10. Open Questions (resolved with defaults — no TBDs)

| Question | Resolution |
|---|---|
| α default | `0.7` (vector-dominant). Re-tunable on the T4 harness; not a blocker. |
| Embedding dedup in extractor | **OUT** (user ruling, this session). |
| Recall-expansion cap M | `10`; revisit only if eval shows starvation. |
| Per-type edge weighting | Keep existing weights (e.g. `REFERENCES` already weight 1.5); no new scheme in v1. |

---

## 11. Decision Record

On approval, save as `SCM-S50-D1` (`save_memory`, `type: DECISION`):

> "Graph-Aware Retrieval — deterministic entity extraction (pure lexical, no LLM/embeddings in the extractor) + vector⊕graph re-rank with recall expansion; `α=1` non-regression boundary; gated on the `SCM-S16-D1` eval harness."

**Sovereign Vetting (deferred):** the pattern "fuse vector recall with a deterministic knowledge graph for re-ranking, gated by an eval harness" is a GLOBAL-vault candidate (passes the Cross-Project Test — any RAG-over-memory project hits the decorative-graph trap). Consent to promote will be requested **after** it ships and the eval is observed green, not now.
