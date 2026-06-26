# Session 56 — Plain-PostgreSQL Migration: Design & Live Status

**Goal:** Retire Supabase; run SCM on a plain PostgreSQL 17 + pgvector database that the user fully owns.
**Direction confirmed by user** (Session 56 goal): the plain-database path, not self-hosted Supabase.

---

## Live status (what is DONE and proven)

| Item | State | Evidence |
|---|---|---|
| Cloud→local **data rescue** | ✅ DONE & VERIFIED | 8 tables match cloud baseline exactly (16,302 memory_chunks, 11,031 kg_nodes, 12,159 kg_edges, …); all 16,302 embeddings present; vector search returns real hits. Dump retained at scratchpad `rescue/scm_cloud_data.sql` (250 MB). Cloud copy untouched. |
| 4 rogue cloud-pointed MCP servers | ✅ Stopped | were pinning cloud CPU @98% + burning quota |
| **Phase 2** — dependency audit | ✅ DONE | No auth / storage / realtime / edge-function use. Single doorway = `src/supabase.ts` (41 importers, ~103 `.from()` + 24 `.rpc()` = ~127 call sites, 22 distinct RPCs). |
| **Phase 3** — stand up plain PG | ✅ DONE | `pgvector/pgvector:pg17` on :5433 (`infra/plain-pg/docker-compose.yml`); schema applied 0-error → 19 tables / 25 functions / 75 indexes / 5 vector cols. `extensions` schema holds vector+pgcrypto+uuid-ossp; placeholder roles created. |

**Pending user OK (non-blocking):** point the MCP server at local by removing the cloud `SUPABASE_URL`/`SUPABASE_SECRET_KEY` override in `~/.claude.json` → `mcpServers.smart-claude-memory.env` (backup already at `~/.claude.json.bak-scm-s56`). This both fixes the un-loading tools and stops any cloud hammering.

---

## Phase 4 design — the plain-pg adapter (the big build)

**Principle:** swap the *internals* of `src/supabase.ts`; keep its *exported surface* byte-identical so the ~127 call sites and 41 importers stay untouched.

**Connection:** a single `pg.Pool` (reuse the existing `src/lib/migrations.ts` query pattern + `isLocalDb` SSL logic). Reads `SUPABASE_DB_URL` (already local `…@127.0.0.1:5433/postgres` after cutover).

**Two surfaces to reproduce:**
1. **`.rpc(name, args)`** → `pool.query('select * from "<name>"($1,$2,…)', [...])`. Mechanical; 22 functions enumerated below. Lowest risk — do first, test first.
2. **`.from(table)…` query builder** → a thin PostgREST-shaped builder returning `{ data, error }` (never throws). Must cover the operators actually used: `select / insert / update / delete / upsert(onConflict) / eq / neq / gt / gte / lt / lte / in / is / order / limit / range / single / maybeSingle / contains`. Build ONLY what the call sites use (audit the 103 sites to bound it), not all of PostgREST.

**RPC functions to preserve (22):** apply_curriculum_task, apply_graduation, archive_done_backlog, bump_skill_telemetry, clustering_discover_projects, kg_knn_pairs, enqueue_curriculum_task, get_trajectory_summary, increment_daemon_bucket, kg_bridge_chunks, match_memory_chunks, kg_hybrid_search, kg_upsert_edge, kg_upsert_node, kg_upsert_node_from_chunk, match_agent_skills, upsert_agent_skill, promote_candidate_to_skill, pull_next_curriculum_task, upsert_memory_rule, upsert_skill_candidate, terminal_committed_checkpoint.

**Method:** test-driven. For each surface, write tests against the real plain DB (:5433, already has schema+can be seeded) first, then implement until green. No call-site edits in Phase 4 — only `src/supabase.ts` internals.

---

## Remaining stages (after Phase 4)

- **Phase 5 — cutover, area by area:** flip `SUPABASE_DB_URL` to :5433; exercise search → KG → backlog → daemons → dashboard, testing each before the next.
- **Phase 6 — data into plain PG:** restore the retained data-only dump into :5433 (on plain PG, `postgres` IS superuser, so `--disable-triggers` works directly — no supabase_admin needed). Verify counts table-by-table vs the same baseline.
- **Phase 7 — full run-through** on plain PG; prove search/dashboard/daemons.
- **Phase 8 — remove Supabase:** stop+remove the local Supabase stack, delete `@supabase/supabase-js`, drop the placeholder roles/RLS that only existed for Supabase, simplify config.
- **Phase 9 — retire cloud:** final cloud backup stored safely, then close the cloud project (only after local fully proven).
- **Phase 10 — docs:** rewrite Core-3 for the plain-PG reality; bump version; resume organic-learning loop on the real history; open PR.

## Risk notes
- `pg_dump`/`psql` `\restrict` directive: in-container tool is newer than host psql 17.5 — use **host** pg_dump (17.5) for portable dumps, or apply via a matching-version client.
- Keep the `{data,error}` contract exact — call sites branch on `error`, they do not catch throws.
- Vector columns are `extensions.vector(768)` — keep the `extensions` schema + search_path on plain PG.
