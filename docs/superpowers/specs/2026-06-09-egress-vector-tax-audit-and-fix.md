# Egress Audit & Fix Proposal — "Vector Tax" Investigation

- **Status:** READ-ONLY audit complete · fix **proposed, not implemented** (awaiting approval)
- **Date:** 2026-06-09 · **Project:** `claude-memory`
- **Incident:** Supabase egress **12.671 GB** vs 5 GB free-tier quota. DB size **218 MB** (storage healthy) → the overage is **pure network egress**.
- **Method:** systematic-debugging Phase 1–2; read-only code audit (first-hand grep + delegated sweep). No DB writes, no eval runs.

---

## 1. Verdict (TL;DR)

- **Hypothesis — "search RPCs / `select()` return raw 768-dim embeddings": REFUTED** (first-hand evidence).
- **Real dominant driver:** the **clustering scanner daemon** pulls **every `kg_nodes` embedding** to the client for client-side K-Means, and **re-fires that full pull every 30 min** whenever the graph mutates — which it did continuously during the Sessions 52–54 KG densification/re-extraction.
- **Confidence:** the *code paths* are confirmed first-hand; the *byte attribution* to ~12 GB is a strong arithmetic inference. §5 proposes a cheap empirical clincher.

---

## 2. Evidence — the search path is CLEAN (hypothesis refuted)

| Surface | Return shape | Embedding? | Ref |
|---|---|---|---|
| `match_memory_chunks` (effective: 009, recreated identically in 011) | `(id, content, file_origin, chunk_index, metadata, similarity)` | **NO** — `vector(768)` appears only as the **input** `query_embedding` | `scripts/009:55-66`, `scripts/011:118-132` |
| `kg_hybrid_search` | `jsonb {seeds, neighbors}` with `id/label/similarity` | **NO** | `scripts/020` |
| `kg_bridge_chunks` | `(concept_id, chunk_id, w_ck)` scalars | **NO** | `scripts/027:15-18` |
| `src/tools/search.ts` direct reads | `select("id, content, file_origin, chunk_index, metadata, project_id")` | **NO** | `search.ts:96,140` |

Vector math (`<=>`) is computed **server-side**; only the scalar `similarity` leaves Postgres. The S52–54 eval harness drove `match_memory_chunks` → returned scalars only (≈ <0.05 GB even at 70 queries × pool × runs). **The search architecture is correct and exonerated.**

---

## 3. Evidence — the REAL leak (background daemons on `setInterval`)

Only **five** `.select(...embedding...)` sites exist in `src/`. The two that fire on a timer are the drain.

### 3.1 PRIMARY — clustering scanner (≈ the 12 GB)
- **Full-table vector pull:** `src/clustering/daemon.ts:166-184` `fetchEmbeddings` → `.from("kg_nodes").select("id, embedding").not("embedding","is",null)`, paged over **every embedded node**, into client-side K-Means.
- **Re-fire trigger:** `isDirty` (`daemon.ts:121-136`) returns true when `count(embedded kg_nodes) ≠ count(kg_node_clusters)`. During S52–54 densification (`SYMBOL 121→1237`; >5000 global embedded nodes) the node count grew on nearly every tick → counts never equalized → a **full embedding re-pull every 30-min tick** (`DEFAULT_INTERVAL_MS = 1_800_000`, `daemon.ts:35`).
- **Arithmetic:** ~9 KB per 768-float vector as PostgREST JSON; a full pass over the embedded-node set ≈ **0.13 GB**. 12.671 GB ÷ 0.13 ≈ **~90–98 full passes** ≈ ~2 days of 30-min ticks during densification. Coherent.
- **Note:** the "Float32Array immediately" optimization (`daemon.ts:7`) saves client *memory*, not *egress* — the wire payload is still JSON-serialized vectors.
- **ONGOING:** `graph_extractor` keeps adding nodes → `isDirty` stays true → clustering keeps re-pulling. This is a *structural* drain, not just historical.

### 3.2 SECONDARY — graph_extractor daemon (≈ 2 GB/mo, ongoing)
- `src/graph/daemon.ts:128-129` → `.from("memory_chunks").select("id, project_id, content, metadata, embedding")` every 2 min (`DEFAULT_INTERVAL_MS=120000`), batch ~10.
- **CORRECTION to the broad sweep:** the embedding is **NOT** dead weight — it is propagated into `kg_nodes.embedding` (`daemon.ts:199`). So we **cannot drop the column**; the fix is to copy the vector **server-side** (see §4.2).
- ~10 rows/tick × 720 ticks/day × ~9 KB ≈ **~65 MB/day** of embedding egress.

### 3.3 MINOR (real, but not the 12 GB)
- `src/tools/global-vault-export.ts:112` — full GLOBAL `memory_chunks` incl. `embedding`; **only on `export_global_vault`** (rare manual op), ~0.14 GB/call.
- `src/supabase.ts:377` `fetchChunksByIds` — selects `embedding` but **bounded** by `.in("id", <small recall-expansion set>)`. Not a driver.
- `src/sleep/miner.ts:107` — `summary_embedding` over `trajectory_summaries` (currently empty). Negligible.

---

## 4. Proposed Fix (structural — describe only, NO code yet)

### 4.0 Immediate mitigation (stop the bleed NOW — config only, reversible)
Raise `SCM_CLUSTERING_INTERVAL_MS` (30 min → 6–12 h) or disable the clustering scanner, and raise `SCM_GRAPH_EXTRACTOR_INTERVAL_MS`, until the structural fix ships. Halts the ongoing full-embedding re-pulls immediately. **Requires your go-ahead.**

### 4.1 PRIMARY — eliminate the clustering full-vector pull (migration `scripts/029_*` + daemon edit)
- **(a) Dirty-check delta-gate / cooldown [high leverage, low risk]:** re-cluster only when `new-node delta ≥ threshold` OR a cooldown has elapsed — not on every count mismatch. Turns ~98 full passes into a handful.
- **(b) Move K-Means server-side [the clean structural fix]:** add an RPC that computes cluster assignments inside Postgres and returns only `(node_id → cluster_id)`; embeddings never egress. `kg_knn_pairs` + Louvain are already server-side — K-Means is the only step pulling raw vectors. *Fallback if K-Means must stay client-side:* fetch vectors via an RPC returning compact `float4`/`bytea` (~3 KB/row vs ~9 KB JSON ≈ 3× cut).

### 4.2 SECONDARY — graph_extractor embedding propagation server-side
Replace the chunk-embedding fetch with a server-side upsert RPC that copies `memory_chunks.embedding → kg_nodes.embedding` by `chunk_id` inside Postgres. The daemon then fetches only `id/content/metadata` for lexical extraction; the 768-dim vector never crosses the wire. **Do NOT drop the column** (it is needed on `kg_nodes`).

### 4.3 TERTIARY — global-vault-export
Make `embedding` optional in the export (re-embed on import), or document it as a rare, explicit operator action.

---

## 5. Confirmation step (empirical clincher — recommended before/with the fix)
- If the Supabase dashboard exposes **egress-by-source**, confirm `kg_nodes`/clustering dominates.
- Else add a **one-tick byte counter** (sum serialized payload length) to `fetchEmbeddings` and the graph-daemon select, run once, read the numbers (systematic-debugging Phase 1.4 instrumentation).
- The fix is justified by inspection regardless — shipping all vectors to the client on a timer is wasteful — but this nails the attribution.

---

## 6. Reference Map

| Concern | Location |
|---|---|
| `match_memory_chunks` return shape (no embedding) | `scripts/009_fix_rpc_dual_scope.sql:55-66`, `scripts/011_trajectory_compaction.sql:118-132` |
| Clustering full-vector pull (PRIMARY) | `src/clustering/daemon.ts:166-184` (`fetchEmbeddings`), `:121-136` (`isDirty`), `:35` (interval) |
| Graph-extractor embedding pull (SECONDARY) | `src/graph/daemon.ts:128-129` (select), `:199` (propagation to `kg_nodes`) |
| Bounded / rare embedding reads | `src/supabase.ts:377`, `src/tools/global-vault-export.ts:112`, `src/sleep/miner.ts:107` |
| Clean search path | `src/tools/search.ts:96,140`; `scripts/020`, `scripts/027` |
