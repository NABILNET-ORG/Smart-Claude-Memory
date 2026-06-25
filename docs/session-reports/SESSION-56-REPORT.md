# Session 56 — Report

**Branch:** `fix/scm-s55-egress-leak` (PR [#8](https://github.com/NABILNET-ORG/Smart-Claude-Memory/pull/8)) · **Next session:** 57

## Summary
The session that finished what Session 55 planned: retire Supabase entirely and run on a self-hosted **plain PostgreSQL 17 + pgvector** database. We opened blocked — the local database was an empty shell and the memory server's tools wouldn't load — rescued the cloud data first (treating it as sacred), then migrated the data layer in tested phases behind the unchanged `src/supabase.ts` doorway, so all ~127 call sites and the entire 63-tool surface stayed byte-for-byte identical. Shipped v2.5.0, opened PR #8, took a triple backup, and remediated two security findings the automated PR reviews flagged.

## The arc
1. **Opened blocked — split-brain config + rogue egress.** The local database was empty and the server's tools failed to load: the global `~/.claude.json` had injected **cloud** Supabase credentials that fought the local `.env`. Diagnosed via a socket check. Also caught 4 rogue cloud-pointed MCP servers hammering the still-recovering cloud (egress + Disk-IO) and stopped them.
2. **Data rescue (the prerequisite gate).** Because local was empty, ran the Session-55 rescue runbook before touching anything else: a data-only dump of the cloud (~250 MB) restored into the local Supabase via the `supabase_admin` superuser. Verified **all 8 tables** match baseline — 16,302 `memory_chunks`, 11,031 `kg_nodes`, 12,159 `kg_edges`, 199 `archive`, 13 `agent_skills`, 2 `curriculum`, 2 `skill_candidates`, 0 `trajectory` — plus all 16,302 embeddings hydrated and vector search returning real hits.
3. **Migration to plain PostgreSQL — staged and tested each phase:**
   - **P2 — dependency audit.** No auth / storage / realtime / edge-function usage anywhere; the single doorway is `src/supabase.ts` (41 importers, ~103 `.from` + 24 `.rpc` ≈ 127 sites, 22 RPCs).
   - **P3 — stood up plain PG17 + pgvector** on host port `:5433` (`infra/plain-pg/docker-compose.yml`); applied the schema 0-error (dedicated `extensions` schema for pgvector + stub roles + full `public` schema). Snags solved: the `pg_dump` `\restrict` directive (re-dumped with host pg_dump 17.5) and "public schema already exists" (dropped the default public, let the dump recreate it).
   - **P4 — built `src/db/pg-adapter.ts`.** A `pg.Pool`-backed, PostgREST-shaped query builder + `.rpc`, sitting behind the unchanged `src/supabase.ts` (38 exports byte-identical). Added 27 adapter tests; full suite **502 pass / 0 regressions** (the 1 pre-existing graph-daemon failure was proven on a clean tree).
   - **P6 — loaded rescued data + the `schema_migrations` ledger** into plain PG; counts match baseline.
   - **P5 — cutover.** Repo-root `.env` → `:5433`; a non-destructive smoke proved search (real hits) + backlog (18 rows) on real data through the adapter.
   - **P7 — full run-through.** Entire suite **502 pass** against `:5433` as the default; data intact afterward.
   - **P8 — removed Supabase.** Dropped `@supabase/supabase-js`, stripped the unused `SUPABASE_URL` / `SUPABASE_SECRET_KEY` REST config (`config.ts`, `setup.ts`), deleted 3 dead smoke scripts, and **stopped all 11 Supabase containers** — the app was then PROVEN to run with Supabase fully down.
4. **Organic-learning loop re-enabled.** Removed the SCM-S55 egress throttles from `.env` (local = zero egress), so the daemons run again. The full "learn from real history" backfill (curriculum TTL + `archive_backlog.chunk_id` + trajectory summaries via Ollama) remains a build, scoped in `docs/superpowers/plans/2026-06-25-S56-organic-learning-backfill.md`.
5. **Phase 10 — docs + release.** Refreshed the Core-3 docs, bumped 2.4.0 → **2.5.0**, and opened **PR #8**.
6. **Phase 9 — durable backup.** A full `pg_dump` of plain PG (252 MB) + the 250 MB cloud-sourced data to `C:\Users\saeee\scm-backups\` — made from the verified-identical LOCAL copy, so **no new cloud egress**.
7. **Restart verification.** A fresh MCP server came up healthy on plain PG `:5433` — `check_system_health` ok, orchestrator v2.5.0, search returns real hits, daemons running.
8. **Security remediation (post-PR automated reviews):**
   - **GitGuardian** flagged the committed `POSTGRES_PASSWORD` in the compose file → parameterized via `${SCM_PG_PASSWORD}` + gitignored `.env` + added `.env.example`; **scrubbed from history** via amend + force-push (`1108a71` → `4898fb9`).
   - **Security review** flagged TLS verification disabled (`rejectUnauthorized:false`) → changed to `rejectUnauthorized:true` (fail-closed) for non-local connections in `pg-adapter.ts` + `setup.ts` + `apply-schema.ts` (`b486bf3`, pushed).

## Hurdles + solutions
- **Split-brain cloud/local config** (global `~/.claude.json` overriding local `.env`) → diagnosed via a socket check, then pointed everything at local.
- **`pg_dump` `\restrict` version mismatch** → re-dumped with the host pg_dump 17.5.
- **"public schema already exists" on restore** → dropped the default `public`, let the dump recreate it.
- **Restore needed superuser** → ran it as `supabase_admin`.
- **GitGuardian secret in committed config** → parameterized to `${SCM_PG_PASSWORD}` + gitignore, then scrubbed history.
- **Silent TLS downgrade** (`rejectUnauthorized:false`) → flipped to `rejectUnauthorized:true`, fail-closed for non-local.

## Decisions
- **SCM-S56-D1** — Adopt plain PostgreSQL 17 + pgvector via a `pg` adapter (`src/db/pg-adapter.ts`) behind `src/supabase.ts`. Preserve the exported surface so the ~127 call sites stay untouched; only the backend changed.
- **SCM-S56-D2** — Treat the rescued data as sacred: rescue + verify before any migration, keep a triple backup, and never delete the cloud copy until the local copy is proven identical.
- **SCM-S56-D3** — Secrets stay out of committed config (parameterize + gitignore) and TLS is verified (no silent downgrade) — fail-closed for any non-local connection.

## Remaining / Handover
- **Retire the cloud Supabase project** — user-driven; the data is fully backed up (local + two dump copies).
- **Organic-learning backfill build** — spec ready at `docs/superpowers/plans/2026-06-25-S56-organic-learning-backfill.md`.
- **Optional cleanup** — rename the `SUPABASE_*` env-var names to neutral `*_DB_URL` names; delete the 5 dead dev scripts still carrying `rejectUnauthorized:false`; sanitize the 2 remaining localhost literals (rescue runbook + a test fixture).
- **PR #8** — review and merge.

## Branch state
`1108a71` retire Supabase → plain PG17 + pgvector (squashed surface; `4898fb9` after the secret-history scrub) · `b486bf3` TLS fail-closed remediation · plus this report. PR [#8](https://github.com/NABILNET-ORG/Smart-Claude-Memory/pull/8) open against `main`.
