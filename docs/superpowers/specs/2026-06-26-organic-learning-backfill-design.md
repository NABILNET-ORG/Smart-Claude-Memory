# Organic-Learning Backfill — Design Spec

**Date:** 2026-06-26
**Status:** Proposed (awaiting review)
**Scope:** `claude-memory` project (pilot); script parameterized for later expansion
**Supersedes:** step 5.B of `docs/superpowers/plans/2026-06-25-S56-organic-learning-backfill.md`

## Problem

The six organic-learning daemons run, but the skill miner produces **zero** skills.
`src/sleep/miner.ts:mineClusters` is an inner join:

1. `fetchSummariesForProject` → `trajectory_summaries` (currently **0 rows**).
2. `fetchSuccessArchiveByChunk` → `archive_backlog` rows with a non-null `chunk_id` — the
   "this trajectory succeeded" signal.
3. Only summaries whose `source_chunk_id` is in that success set are mined
   (*"failed/in-flight tasks must NEVER seed a candidate skill"*, miner.ts:307).

So mining needs **both** a populated summaries table **and** a trustworthy success signal.
Inspection of the live DB shows the planned signal has no honest data path:

- All 201 `archive_backlog` done-rows are release milestones ("v0.9.0 — …"),
  `metadata = {}`, `chunk_id` NULL. No shared key joins them to `memory_chunks`
  (archive has `title`/`notes`/`cloud_backlog_id`; chunks have `content`/`content_hash`/`file_origin`).
- A fuzzy title/timestamp match would seed garbage skills — the exact failure the plan warns against.

## Goal & success criteria

Make the loop mine **real, high-precision skills** from this project's successful work.

Done when, for `claude-memory`:

- `trajectory_summaries` is populated for the successful chunk set.
- Running the miner yields ≥1 `skill_candidate` with `state='mined'`.
- `trigger_clustering({force:true})` → at least one skill retrievable via `request_skill`.
- Re-running the backfill is a no-op (idempotent).

## The success rule (single source of truth)

A `memory_chunks` row is **successful, learnable work** iff its metadata asserts a
completed/canonical outcome:

- `metadata->>'type' IN ('DECISION','PATTERN')`, **OR**
- `metadata->>'status' IN ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed')`, **OR**
- `metadata->>'is_global' = 'true'`.

Explicitly **excluded**: `type IN ('ERROR','LOG','image')`, untyped chunks, and ambiguous
in-flight statuses (notably `'active'`).

Live sizing (all projects): claude-memory **76**, samia-tarot-cowork 112, GLOBAL 45,
nobla-agent 12, nabilnetai 8, saeee 0. Small but precise — correct for quality-first mining.

The rule is defined **once** as a SQL view and reused by both the miner gate and the
backfill, so the two can never drift.

## Components

### 1. Migration — `0NN_successful_chunks_view.sql`

```sql
CREATE OR REPLACE VIEW successful_chunks AS
SELECT id AS chunk_id, project_id, metadata
FROM memory_chunks
WHERE metadata->>'type' IN ('DECISION','PATTERN')
   OR metadata->>'status' IN ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed')
   OR metadata->>'is_global' = 'true';
```

(If a `metadata` GIN index is present it accelerates this; regardless, a seq scan over
~16k rows is acceptable.)

### 2. Honest success gate — `src/sleep/miner.ts`

Replace `fetchSuccessArchiveByChunk` as the success source with `fetchSuccessfulChunkIds(projectId)`
reading `successful_chunks`. Preserve `mineClusters`'s contract: the gate
`successful = summaries.filter(s => successSet.has(s.source_chunk_id))` is unchanged; the
provenance previously taken from the backlog id becomes the chunk's own id (a more direct
lineage). Existing miner tests updated to the new source; the "never mine non-successful
chunks" guarantee is retained.

**Alternative considered (not chosen):** seed synthetic `archive_backlog` rows for each
successful chunk — zero miner change, but it pollutes the backlog table and creates ongoing
sync debt as new chunks get typed. The live-view gate stays correct with no sync. Flagged
here in case the provenance change is undesirable on review.

### 3. Backfill script — `scripts/backfill-trajectory-summaries.ts`

Mirrors `scripts/backup-and-remove.ts` conventions: **dry-run by default**, `--confirm` to
write, `--project=<id>` (default `claude-memory`), emits a JSON manifest.

For each row in `successful_chunks` for the project **not already** in `trajectory_summaries`:

1. Load the chunk content.
2. Summarize via `summarizeTrajectory` (`gemma3:e2b`).
3. Embed the summary via `embed` (`nomic-embed-text`, 768-d).
4. Insert into `trajectory_summaries (project_id, source_chunk_id, summary, summary_embedding, …)`.

Idempotent via the existing `UNIQUE(project_id, source_chunk_id)` — re-runs skip done rows.
Per-chunk failures (e.g. an Ollama hiccup) are logged and skipped, not fatal; the manifest
records summarized/skipped/failed counts.

## Data flow

`successful_chunks` (view) → backfill summarizes each → `trajectory_summaries` → miner
inner-joins summaries against the same view → clusters ≥ `minFreq` → `skill_candidates` →
clustering/graduation → `agent_skills` (retrievable via `request_skill`).

## Testing

- Unit (node:test, Node 22+): the success-rule view via a temp schema with fixture chunks
  (DECISION/PATTERN/success-status/is_global → included; ERROR/LOG/untyped/active → excluded).
  Mock Ollama at the boundary for the script's summarize/embed; assert idempotency (second
  run inserts nothing) and per-chunk failure isolation. Update miner tests for the new source.
- Boundary-only mocks; real DB for the view/migration test.

## Verification (manual, end-to-end)

1. `--confirm` the backfill for claude-memory; manifest shows ~76 summarized.
2. `trajectory_summaries` count > 0.
3. Run the miner (or a sleep_learner tick); confirm `skill_candidates state='mined'`.
4. `trigger_clustering({force:true})`; `request_skill` returns a real skill.
5. Re-run the backfill → 0 new inserts.

## Scope

- **In:** the success-rule view, the miner success-gate change, the summaries backfill, for `claude-memory`.
- **Deferred (separate commits):** plan step 5.A (curriculum TTL-expiry writer — an independent
  subsystem, not a blocker here); multi-project expansion (run the script per project once the
  pilot is validated).
- **Out:** daemon-interval tuning (already done), budget enforcement (stays off), any fabricated
  summaries (real Ollama output only).

## Open edges (resolve in the implementation plan)

- Final status allow-list — confirm `'active'` excluded; decide on long-tail variants like `verified-live-apk68`.
- Next free migration number `0NN`.
- Exact `trajectory_summaries` column set (match migration 011) and manifest location.
