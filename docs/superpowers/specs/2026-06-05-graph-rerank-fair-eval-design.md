# Design: Fair Evaluation of Concept-Bridge Graph Re-Rank (SCM-S52-D1)

- **Date:** 2026-06-05
- **Session:** 52
- **Status:** Approved (brainstorm complete; user-approved execution)
- **Backlog:** #372 (Epic) — re-scoped by this design
- **Owner:** Orchestrator + delegated workers

---

## 1. Problem & Evidence

Epic #372 asked us to "densify the KG via CONCEPT/SYMBOL re-extraction and build a
bridge-aware Goldilocks eval fixture" to justify flipping `SCM_GRAPH_RERANK_ENABLED`
ON by default. A read-only Recon Scout (live `GROUP BY` on the pooler; live
re-embedding of all 6 current eval queries) **broke three premises**:

1. **CONCEPT density cannot be raised by re-extraction.** There are **0 CONCEPT
   nodes** in the entire `kg_nodes` table, and `src/graph/extractor.ts` is
   **regex-only with no LLM call** — it can emit only `NOTE` / `FILE` / `SYMBOL` /
   `DECISION`. The bridge RPC `kg_bridge_chunks` (`scripts/027_kg_bridge.sql`) does
   not even query CONCEPT; it bridges `FILE` / `DECISION` / `SYMBOL` only. "CONCEPT"
   is, today, a no-op everywhere in the pipeline.
2. **The S51 eval was structurally unwinnable.** All 6 gold chunks rank **>200** in
   pure vector (far outside the 40-chunk candidate pool) **and** each has **0 anchored
   `kg_nodes`**. Neither arm could ever surface them. The "no recall lift" verdict was
   an artifact of an impossible fixture, not evidence about the feature.
3. **The graph is ~20% populated** (473 / 2369 `claude-memory` chunks anchored).
   Coverage — not concept-richness — is the first-order gap.

Per the lesson promoted to GLOBAL this session (silent timeout masked a dead feature:
*"prove the treatment actually executed before concluding it doesn't help"*), we still
**do not know** whether graph re-rank helps. Session 52 answers that honestly.

### Hard numbers (Recon Scout)

| Metric | Value |
|---|---|
| CONCEPT nodes (whole table) | **0** |
| SYMBOL nodes (claude-memory) | 121 |
| (CONCEPT+SYMBOL)/(FILE+NOTE) | **0.143** |
| claude-memory nodes / edges | 1021 / 1310 |
| GLOBAL nodes / edges | 42 / 22 |
| KG chunk coverage (claude-memory) | **473 / 2369 (~20%)** |
| Current 6 gold chunks | vector rank **>200**, **0 anchored nodes** each |

---

## 2. Locked Decisions

1. **Goal — Fair eval first (minimal).** Do **not** build a CONCEPT extractor or
   extend the bridge RPC. Backfill coverage with the existing regex extractor, build a
   fair fixture, measure, and flip the flag only on honest lift. A documented
   "stays OFF" is a valid, successful outcome.
2. **Method — Two sets.**
   - **Ship-Gate set** = *Representative* queries (golds sampled blind to bridges) +
     a *Control* partition (queries pure-vector already nails). **This set alone
     decides the flag flip.**
   - **Capability set** = a few *Goldilocks* queries engineered to satisfy the bridge
     inequality. **Telemetry/diagnostic only — never decides the flip.** (Using it to
     decide would be circular — it can only confirm the mechanism on cases selected
     because the mechanism works.)
3. **Fixture source — Synthesize from anchored chunks.** Sample anchored chunks as
   ground-truth golds; generate an oblique-but-faithful query per gold via local
   Ollama (`gemma`); keep those whose gold lands at **vector rank 4–40** (difficulty
   filter) for the lift partition, and **rank 1–3** for the control partition. Selection
   is **blind to bridge presence** — that is what keeps the Ship-Gate non-circular.
4. **Verdict rule.** Flip `SCM_GRAPH_RERANK_ENABLED` default to `true` in
   `src/config.ts` **iff**, on the Ship-Gate set: recall@3 **strictly increases** AND
   MRR **does not decrease** AND the control partition shows **no recall@3 regression**.
   Otherwise keep OFF and document the numbers.

> **Architectural boundary (Invariant #1).** Generative LLMs are forbidden in the
> **extractor daemon** (core production pipeline) — Phase 1 backfill therefore uses the
> pure-regex extractor only. Using a local LLM (`gemma`) inside the **eval harness** to
> synthesize *test data* (Phase 2) violates no invariant; it is standard practice and is
> strictly outside the production retrieval/extraction path.

---

## 3. System Facts (for implementers)

- **Fusion score** (`src/tools/rerank.ts`, `src/config.ts:50-64`): with `α = 0.7`,
  pool `40`, expand `10`, timeout `1500 ms`:

  ```
  score(c) = α · minmax(vSim(c)) + (1 − α) · minmax(gRaw(c))
  gRaw(c)  = Σ_{k∈C} W(k) · w_ck       W(k) = Σ σ[seed] · edge_weight
  ```

  Both terms min-max normalized over the candidate ∪ expansion union.
- **Bridge fetch:** `fetchConceptChunks` → `src/supabase.ts:358` → RPC
  `kg_bridge_chunks`; bridges `c.type ∈ {FILE, DECISION, SYMBOL}`.
- **Vector search:** `searchChunks` → `src/supabase.ts:272` → `match_memory_chunks`.
- **Graph population:** `src/graph/daemon.ts` `fetchUnprocessed` (anti-join, batch 10,
  every 120 s) is the **only** populating path. Upserts are idempotent
  (`UNIQUE(project_id, label, type)`), so a concurrent bulk backfill is race-safe.
- **No bulk backfill script exists** (`scripts/purge-graph-nodes.ts` only deletes).

### Goldilocks inequality (capability-set construction only)

A gold `g` recovers into top-3 under ON iff, after min-max normalization over the pool:

```
(1 − α) · gNorm(g)  >  α · [ vNorm(rank3) − vNorm(g) ]
```

i.e. the 0.3-weighted normalized graph score must exceed the 0.7-weighted normalized
vector gap from `g` to the incumbent rank-3 chunk. Construct capability queries whose
gold shares a high-`W(k)·w_ck` FILE/SYMBOL/DECISION bridge with the query's top seeds.

---

## 4. Phased Plan

### Phase 1 — Backfill (delegated; **initiated now**)
- **Deliverable:** new `scripts/backfill-kg-extraction.ts` that **reuses** the daemon's
  extractor + upsert path (no duplicated extraction logic), drains the `fetchUnprocessed`
  anti-join queue for `project_id='claude-memory'` in large batches with no throttle,
  idempotent, error-handled per batch, and prints **before/after**: total chunks,
  anchored chunks, coverage %, node counts by type, edge counts by type, elapsed.
- **Acceptance:** anti-join queue drained to 0 eligible chunks; coverage % and
  SYMBOL/FILE/DECISION node counts reported and materially up; build gate green; run is
  non-destructive (insert-only).

### Phase 2 — Build the two sets (delegated; after Phase 1)
- **Deliverable A — `scripts/gen-fair-fixture.ts`:** sample anchored chunks; generate an
  oblique query per gold via local Ollama (`gemma`); compute each gold's pure-vector rank;
  emit `docs/superpowers/specs/s52-shipgate-eval.json` partitioned into `lift` (rank 4–40)
  and `control` (rank 1–3), **blind to bridges**. Target ≥ 20 lift + ≥ 10 control queries
  (abort with a clear message if the lift band cannot be populated — see R1).
- **Deliverable B — capability set:** `docs/superpowers/specs/s52-capability-eval.json`,
  ~5 queries engineered to satisfy the §3 inequality (golds anchored + high-weight bridge
  to seeds). Hand-verified that the bridge fires.
- **Acceptance:** both JSON fixtures validate against the harness schema
  (`query`, `gold_chunk_id`, `project_id`, `partition`); lift band non-empty; capability
  queries each have a confirmed bridge path.

### Phase 3 — Eval run (delegated; after Phase 2)
- **Deliverable:** extend `scripts/eval-graph-rerank.ts` to accept a `--fixture <path>`
  arg (currently hardcoded), run OFF vs ON across both fixtures with `EVAL_VERBOSE=1`,
  and write a results table (recall@3, MRR) per fixture **and per partition**.
- **Acceptance:** four result cells produced (Ship-Gate{lift,control} × {OFF,ON}) plus
  capability{OFF,ON}; raw per-query verbose log retained out-of-context (summarized only).

### Phase 4 — Verdict & flip (orchestrator)
- Apply the §2.4 decision rule to the Ship-Gate numbers.
- If PASS: flip the default in `src/config.ts`, add a regression test asserting the new
  default, record `SCM-S52-D2` (the flip) with the numbers. If FAIL: keep OFF, record
  `SCM-S52-D3` (kept-OFF + evidence). Capability numbers logged either way.

---

## 5. Non-Goals (YAGNI)

- No LLM-based CONCEPT extractor; no new node types.
- No change to `kg_bridge_chunks` to bridge CONCEPT.
- No fusion-weight (`α`) tuning this session — evaluate the shipped formula as-is.
- No flag flip without a Ship-Gate pass.

---

## 6. Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Synthetic queries too lexically close → vector nails everything → empty lift band | Generate oblique paraphrases; verify lift band ≥ 20; if short, increase obliqueness / sample harder chunks; abort loudly rather than ship a thin fixture |
| R2 | Some chunks produce no node → golds still unanchored | Sample golds only from the **anchored** set post-backfill; report residual unanchored count |
| R3 | Fair eval shows no lift | Valid "keep OFF" outcome; document numbers — not a failure (see §1 lesson) |
| R4 | Daemon runs during backfill | Idempotent upserts make it race-safe; no mitigation needed |
| R5 | Eval harness fixture path hardcoded | Phase 3 adds `--fixture` arg before the runs |
| R6 | Curation bias sneaks into "representative" | Selection filters on **difficulty only**, never bridge presence; capability set kept strictly separate and non-deciding |

---

## 7. Key Files

| Path | Role |
|---|---|
| `src/graph/extractor.ts` | Regex extractor — NOTE/FILE/SYMBOL/DECISION, no LLM |
| `src/graph/daemon.ts` | Anti-join poller; only KG-populating path |
| `scripts/backfill-kg-extraction.ts` | **NEW** — Phase 1 bulk backfill |
| `scripts/gen-fair-fixture.ts` | **NEW** — Phase 2 fixture synthesizer |
| `scripts/027_kg_bridge.sql` | `kg_bridge_chunks` RPC (FILE/DECISION/SYMBOL) |
| `src/supabase.ts` | `:358` fetchConceptChunks, `:272` searchChunks |
| `src/tools/rerank.ts` / `bridge.ts` | Fusion scorer / `W(k)` weights |
| `src/tools/search.ts` | Rerank orchestration (pool 40, expand 10, timeout-guarded) |
| `scripts/eval-graph-rerank.ts` / `src/tools/metrics.ts` | Eval harness; recall@3 / MRR |
| `docs/superpowers/specs/s16-d1-eval-queries.json` | Old 6-query fixture (unwinnable; superseded) |
| `src/config.ts` | `:50-64` α/pool/expand/timeout; flip target for `SCM_GRAPH_RERANK_ENABLED` |
