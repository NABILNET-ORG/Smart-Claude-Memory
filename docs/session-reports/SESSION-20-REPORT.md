# Session 20 — M4 Transactional Workflows Deployed (+ S19 backfill closed)

**Date.** 2026-05-12
**Mission.** Agentic OS 2026 Mission 4 (backlog #114, P3). Multi-step agent tasks are now transactional: each step opens a checkpoint that either commits (pinning a `trajectory_summaries` row as its replay anchor) or rolls back (walking the parent chain to the last committed step, emitting an `[M3]` failure signal). No snapshot engine — restoration replays trajectory_summaries by `source_chunk_id`.
**Status.** Shipped + verified end-to-end. Migration 014 applied, 7-step smoke test GREEN, S19 backfill executed live (12 scanned → 5 backfilled, AMBIGUOUS=0). M5 (Autonomous Curriculum, #115, P4) is the last active backlog item.

---

## 1. What changed

### 1.1 Sovereign Decisions

- **SCM-S20-D1** — **Migration immutability win.** The S19 backfill required the `archive_done_backlog(text)` RPC (defined in `scripts/005_archive_backlog.sql`) to populate `archive_backlog.chunk_id`. The naïve path would have been to retroactively edit 005. Rejected: migrations are immutable history, and editing 005 pollutes bisect + breaks deterministic replay on fresh DBs. Decision: ship the patch as a `CREATE OR REPLACE FUNCTION` statement inside the **new** migration `scripts/014_workflow_checkpoints.sql`. The contract (`returns int`, same `with moved as (...) insert ...` shape) is preserved; only the `chunk_id` enrichment is added. 005 remains byte-identical to its merge commit.

- **SCM-S20-D2** — **Unified invariant: checkpoint = M1 + M2 + M3.** Rejected a separate `workflow_steps` snapshot store. The invariant binds existing infrastructure: `agent_skills.steps[i]` (M1) is the boundary, `trajectory_summaries.source_chunk_id` (M2) is the delta, and rollback events feed `skill_candidates.success_count` (M3) as the learner signal. All three converge on `memory_chunks.id` as the spine. M4 ships the binding, not a parallel engine.

- **SCM-S20-D3** — **Miner graceful degradation.** `fetchRollbackSignalsByChunk` swallows query errors silently and returns an empty map. Reason: clusters where migration 014 has not yet been applied (legacy/cold deploys, fresh forks) MUST keep mining byte-identically. The check failure is non-fatal: zero rollback signals → zero `success_count` decrements → identical mining behavior to pre-M4. This preserves backward compatibility without a feature flag.

### 1.2 Files created
- `scripts/014_workflow_checkpoints.sql` (216 LOC) — `workflow_checkpoints` table (10 cols, 3 indexes, CHECK constraint on `status ∈ {open, committed, rolledback}`), `terminal_committed_checkpoint(p_project_id, p_skill_id, p_root_id)` recursive CTE RPC returning `bigint`, and `CREATE OR REPLACE FUNCTION archive_done_backlog(text)` that lifts `chunk_id` from `cloud_backlog.metadata->>'checkpoint_root_id'` via a lateral subquery — preserves 005's exact return shape.
- `src/transactions/checkpoint.ts` (449 LOC) — pure service layer: `openCheckpoint`, `commitCheckpoint`, `rollbackCheckpoint`, `listCheckpoints`, `restoreFrom`. Status-guarded updates prevent double-commit/double-rollback races. RPC delegation to `terminal_committed_checkpoint` for chain walking; reuse of `get_trajectory_summary` for replay. Structured `[M4]` logging matches M2/M3 prefix convention.
- `src/tools/checkpoint.ts` (385 LOC) — four MCP tool wrappers: `checkpoint_create` (stamps `cloud_backlog.metadata.checkpoint_root_id` when opening a root checkpoint against a backlog task — closes S19 for all future runs), `checkpoint_commit`, `checkpoint_rollback`, `checkpoint_list`. Mirrors `src/tools/compact.ts` shape.

### 1.3 Files modified
- `src/index.ts` (+69) — four new `server.tool` registrations alongside M2/M3 imports; `backfill_archive_chunks` action wired into `manage_backlog` schema.
- `src/sleep/miner.ts` (+123) — `fetchRollbackSignalsByChunk(projectId, chunkIds)` helper; mining loop decrements `success_count` per cluster (floor 0); `[M3] applied N rollback signals` log when N≥1. Existing schema (`skill_candidates` has no `notes`/`metadata` column) → signal captured exclusively via the count decrement.
- `src/tools/backlog.ts` (+201) — `backfillArchiveChunkIds(projectId, dryRun)` helper + `backfill_archive_chunks` action branch. RPC-path first (lifts chunk_id from `terminal_committed_checkpoint` when `checkpoint_root_id` present), heuristic ilike fallback for legacy rows, skip-on-ambiguous (`count > 1`) safeguard.
- `ARCHITECTURE.md` (+44) — new `## M4 — Transactional Workflows (Checkpoints)` section between M3 and `## 5. File Architecture`: mission paragraph, lifecycle Mermaid flowchart, components table, restoration contract, S19 closure note.

---

## 2. Hurdles + solutions

- **Hurdle: `archive_done_backlog` 005 was the natural place for the chunk_id patch.** Solution: deferred to user review, who explicitly enforced the immutability rule. The `CREATE OR REPLACE` inside 014 preserves 005's byte history and the live RPC contract simultaneously.
- **Hurdle: deferred-tool list is frozen at session start.** After the user restarted Claude Code, the 4 new `checkpoint_*` MCP tools were live in the rebuilt server but invisible to this conversation's deferred tool registry. Solution: invoked the helper's exact code path via `scripts/_m4_backfill_runner.mjs` (same algorithm as the MCP tool handler) — no functional gap, and the dry/live separation was preserved.
- **Hurdle: `skill_candidates` has neither `metadata` nor `notes` column.** Initially proposed appending `; rollback_count=N` to a `notes` text column; schema audit (`scripts/012_sleep_learning.sql`) showed neither exists. Solution: capture the rollback signal exclusively via `success_count` decrement and a structured `[M3] applied N rollback signals` log line. Adding a column was out of scope; the count channel is sufficient for current pattern-quality math.

---

## 3. Verification trail

1. **TS build (refactor_guard gate)** — Phase A green first try (2.5 s, zero errors). Phase B green first try (2.4 s, zero errors). No self-healing required.
2. **Migration apply** — `npx tsx scripts/apply-schema.ts 014_workflow_checkpoints.sql` → `Schema applied.` Pooler URL path used (IPv4-reachable).
3. **End-to-end smoke (7 steps)** — `openCheckpoint(root)` → id=1; `openCheckpoint(child, parent=1)` → id=2; `commitCheckpoint(2, source_chunk=7904)` → status=committed; `rollbackCheckpoint(3, ...)` → `restoredFrom: {checkpointId: 2, sourceChunkId: 7904}` (parent-chain walk verified); `listCheckpoints` → 3 rows with correct statuses; `terminal_committed_checkpoint` RPC → chunk_id=7904; cleanup OK.
4. **Backfill dry run** — 12 scanned, 0 ambiguous, 5 heuristic-unique, 7 zero-match.
5. **Backfill live** — same 12/0/5/7 verdict, writes applied. Post-check: `archive_backlog` (claude-memory) chunk_id NULL=7, populated=5. Many-to-one attribution flagged: tasks #15/#16/#17 → chunk 11342, tasks #14/#9 → chunk 11343 (likely shared session-summary chunks; appropriate for M3 mining provenance, not corruption).

---

## 4. Curator invariant (do not regress)

- **Never edit `scripts/005_archive_backlog.sql`** to repair `archive_done_backlog` — patch via `CREATE OR REPLACE FUNCTION` inside the newest forward-migration. All migrations under `scripts/0*.sql` are immutable history.
- **Miner rollback fetch must remain swallow-on-error.** If a future change makes it throw, fresh forks and legacy deploys without 014 will crash the daemon. The empty-map fallback is the explicit backward-compat surface.
- **`checkpoint_create` MUST stamp `cloud_backlog.metadata.checkpoint_root_id`** when both `parent_id IS NULL` AND `backlog_task_id` is provided. Skipping this silently breaks S19 closure for future archive cycles — the RPC enrichment will see no key and fall back to NULL.
- **Restoration replays trajectory_summaries, never a snapshot.** If a future change tries to add a state-blob column to `workflow_checkpoints`, reject — the unified invariant collapses if M4 introduces a parallel store.

---

## 5. Open items / next session

- **M5 — Autonomous Curriculum** (backlog #115, P4). Last active backlog item. Zero-human exploration mode: agent writes tests/refactors during idle time, gated by `confirm_verification` before any write touches main.
- **MCP tool registry visibility lag.** Worth documenting in CLAUDE.md: deferred tool lists in Claude Code are fixed at session boot; mid-session MCP restarts don't refresh the host's view. Workaround: invoke handlers via the compiled `dist/` directly when validation can't wait a session boundary.
- **Heuristic-backfill many-to-one attribution.** 5 of the 12 legacy rows share two parent chunks (#11342, #11343). Acceptable for M3 mining (chunks DO source those tasks), but a future hardening pass could anchor on `cloud_backlog.metadata.session_id` if one is added.
- **The 7 still-NULL archive_backlog rows** in claude-memory will remain NULL until either (a) they're re-archived through M4-aware paths, or (b) a future enhancement adds a stronger heuristic (e.g., date-windowed search).
