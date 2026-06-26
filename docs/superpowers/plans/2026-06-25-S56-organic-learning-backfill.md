# Organic-Learning Loop — Resume & Backfill (SCM-S56)

**Status:** Daemons RE-ENABLED (egress throttles removed from `.env`). The one-time **backfill** below is the remaining, scoped implementation task so the loop actually learns from the real rescued history. It is NOT a one-liner — it must be authored as committed, reviewed, idempotent, dry-run-default code (no fabricated summaries), per spec §7 + CLAUDE.md.

## Done (this session)
- Removed `SCM_CLUSTERING_INTERVAL_MS` (was ~30d) and `SCM_GRAPH_EXTRACTOR_INTERVAL_MS` (was 24h) from `.env` → daemons now use code defaults: clustering ~30min, graph extractor ~2min. Safe now we're local: the throttle was purely a **cloud-egress** mitigation (egress spec §3/§4.0); plain PG = zero egress. Delta-gate (commit `d46f595`) + server-side embedding copy (`cdc4b11`, migration `029`) already removed the underlying cost.
- `SCM_BUDGET_ENFORCEMENT_MODE` unset → defaults `off` (`src/budget/gate.ts:26`); daemons unblocked. No change needed.
- **Restart note:** `.env` changes take effect on the next MCP server start.

## Remaining backfill — 3 blockers (the loop mines ZERO skills until these ship)
The 6 daemons (`sleep_learner`, `trajectory_compactor`, `curriculum_scanner`, `graduation_scanner`, `graph_extractor`, `clustering_scanner`) will RUN but produce nothing until:

- **5.A — Curriculum TTL (foundation fix, its own commit FIRST).** No migration writes `status='expired'`; `015_curriculum_tasks.sql:235` only *filters* `expires_at > now()`. Add a TTL-expiry path (migration + scanner update).
- **5.B — Populate `archive_backlog.chunk_id`.** The ~144 real `done` rows have `chunk_id=NULL`, so the miner's hard gate (`src/sleep/miner.ts:302-312`) returns `[]`. Backfill links each archived item to its source chunk.
- **5.C — Backfill `trajectory_summaries` from real chunks.** Currently 0 rows. Summarize real history via the local Ollama summarizer + `nomic-embed-text` (768-d) — REAL summaries only, no fabrication.

**Shape:** one `--confirm` (dry-run default) script emitting a JSON manifest, mirroring `scripts/backup-and-remove.ts`. Order: 5.A (isolated foundation commit) → 5.B → 5.C → feature commit. No entangled commits.

## Verify the loop is learning (after backfill)
1. `check_system_health()` → all 6 daemons `enabled` + healthy + recent `lastRunAt` (`src/tools/health.ts`).
2. `trajectory_summaries` count for project → **> 0**.
3. `skill_candidates` rows with `state='mined'` AND non-empty `source_summary_ids`.
4. `trigger_clustering({force:true})` (`src/index.ts:1009`) → promotion into `agent_skills`, retrievable via `request_skill`.

## Risk
**Do not mistake "daemons green" for "loop learning."** Reverting intervals makes them *run*; real output requires 5.A–5.C. Source analysis label: `scm-s56-organic-loop-resume-analysis`.
