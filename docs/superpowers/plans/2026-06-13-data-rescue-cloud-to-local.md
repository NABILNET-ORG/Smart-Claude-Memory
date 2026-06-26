# Data Rescue Operation — Cloud → Local Supabase (DATA-ONLY clone)

- **Status:** RUNBOOK — execute when the cloud IO/egress restriction is lifted. **PR is HELD; Session 55 resumes after rescue.**
- **Date:** 2026-06-13 · **Branch:** `fix/scm-s55-egress-leak`
- **Goal:** losslessly clone ALL row data from the (restricted) cloud Supabase into the already-schema'd, currently-empty local Supabase — **data only**, schema untouched.

## Invariants
- Local schema is ALREADY applied (migrations 001–028) and EMPTY of data.
- Cloud holds the real data (~16k `memory_chunks` + KG + archive + skills + `GLOBAL` vault).
- We copy **public-schema rows only**. We do NOT touch schema, functions, roles, `auth`/`storage`/`realtime` (already correct locally).
- One-time op; ≈ the DB size (~218 MB) of cloud egress — covered by the lifted restriction / Pro month.

---

## PREREQUISITES
1. **Cloud reachable** (billing reset OR Pro upgrade lifts the IO/egress cap).
2. Local stack healthy (`docker ps` → `supabase_db_Claude-Memory` up), `.env` on local, schema applied.
3. A pg client whose **major version ≥ cloud Postgres major** (`psql --version`). If unsure, use the version-matched binaries inside the local container (Phase 2, variant B) or `npx supabase db dump`.
4. Connection strings as shell vars — **do NOT commit these**; pull the password from the commented cloud lines in `.env`:
   ```bash
   # CLOUD — use DIRECT :5432 if your network has IPv6, ELSE the SESSION pooler (:5432).
   # NEVER the transaction pooler (:6543) — it breaks pg_dump.
   export CLOUD_DB_URL='postgresql://postgres.hfdaaxjwtguysdtqoubh:<PASSWORD>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'   # session pooler (IPv4)
   # or: export CLOUD_DB_URL='postgresql://postgres:<PASSWORD>@db.hfdaaxjwtguysdtqoubh.supabase.co:5432/postgres'                  # direct
   export LOCAL_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
   ```

---

## PHASE 1 — Pre-flight (read-only: parity + baseline)
**1a. Schema parity** — ledgers must be identical (a data-only restore needs identical columns/types):
```bash
psql "$CLOUD_DB_URL" -c "select * from schema_migrations order by 1;" > /tmp/cloud_ledger.txt
psql "$LOCAL_DB_URL" -c "select * from schema_migrations order by 1;" > /tmp/local_ledger.txt
diff /tmp/cloud_ledger.txt /tmp/local_ledger.txt   # MUST be empty. If not, ALIGN schema before proceeding.
```
**1b. Cloud baseline counts** (record — you verify against these after restore):
```bash
psql "$CLOUD_DB_URL" -c "select 'memory_chunks' t,count(*) c from memory_chunks
  union all select 'kg_nodes',count(*) from kg_nodes
  union all select 'kg_edges',count(*) from kg_edges
  union all select 'archive_backlog',count(*) from archive_backlog
  union all select 'skill_candidates',count(*) from skill_candidates
  union all select 'curriculum_tasks',count(*) from curriculum_tasks
  union all select 'trajectory_summaries',count(*) from trajectory_summaries
  union all select 'agent_skills',count(*) from agent_skills order by 1;"
```

---

## PHASE 2 — Dump cloud DATA (data-only, public, exclude ledger, FK-safe)
**Variant A — raw `pg_dump` (primary):**
```bash
pg_dump "$CLOUD_DB_URL" \
  --data-only \
  --schema=public \
  --exclude-table=public.schema_migrations \
  --disable-triggers \
  --no-owner --no-privileges \
  --file=scm_cloud_data.sql
```
- `--data-only` rows only · `--schema=public` skips auth/storage/realtime · `--exclude-table=public.schema_migrations` keeps the LOCAL ledger intact · `--disable-triggers` bypasses FK insert-ordering on restore (runs as superuser on local) · `--no-owner/--no-privileges` drops cloud-role refs.
- pg_dump emits `setval(...)` for sequences, so identity counters restore correctly.

**Variant B — version-safe (run pg_dump from the matched local container):**
```bash
docker exec supabase_db_Claude-Memory pg_dump "$CLOUD_DB_URL" \
  --data-only --schema=public --exclude-table=public.schema_migrations \
  --disable-triggers --no-owner --no-privileges > scm_cloud_data.sql
```

**Variant C — Supabase CLI (convenience):** `npx supabase link --project-ref hfdaaxjwtguysdtqoubh` then `npx supabase db dump --data-only -f scm_cloud_data.sql` — but it includes `schema_migrations`; prefer A/B's explicit exclude, or TRUNCATE the local ledger before restore (cloud's ledger is equivalent).

---

## PHASE 3 — Restore into LOCAL (stop-on-error)
```bash
# SAFETY: confirm local is empty (re-running into a populated DB duplicates rows).
psql "$LOCAL_DB_URL" -c "select count(*) as memory_chunks from memory_chunks;"   # expect 0
# If a prior attempt left partial data, reset PUBLIC data (keep the ledger) first:
#   psql "$LOCAL_DB_URL" -c "DO \$\$ DECLARE r record; BEGIN
#     FOR r IN select tablename from pg_tables where schemaname='public' and tablename<>'schema_migrations'
#     LOOP EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE;', r.tablename); END LOOP; END \$\$;"

psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f scm_cloud_data.sql
```

---

## PHASE 4 — Verify (must match Phase 1 baseline)
```bash
# Same count query as Phase 1b, against $LOCAL_DB_URL — counts MUST match cloud.
psql "$LOCAL_DB_URL" -c "<paste the Phase 1b union-all query>"
# Embeddings hydrated:
psql "$LOCAL_DB_URL" -c "select count(*) total, count(embedding) with_emb from memory_chunks;"   # with_emb == cloud
# Sequences advanced past max id (spot-check one):
psql "$LOCAL_DB_URL" -c "select max(id) as max_id from memory_chunks;"
```
Spot-check a known chunk by id and one `kg_nodes` row with an embedding.

---

## PHASE 5 — Activate + resume
1. Ensure RPC EXECUTE grants exist on local (`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;`) so `search_memory`/`save_memory` work.
2. **Restart the MCP server** → `check_system_health()` shows local healthy with the real row count → `search_memory({query:'…'})` returns real hits.
3. **Resume Session 55** (organic learning) — the real Sessions 51–54 archive + chunks now exist locally for the 3-table backfill.

---

## Gotchas / risks
- **pg_dump client < cloud PG major** → "server version mismatch": use Variant B (container) or the `supabase` binaries.
- **Transaction pooler (:6543) breaks pg_dump** → use direct :5432 or the session pooler :5432.
- **Schema drift** (Phase 1a diff non-empty) → align first, or the restore errors on column mismatch.
- **pgvector version skew** (cloud vs local) is normally compatible; on a vector parse error, match pgvector versions.
- **Never restore twice** into a populated DB (PK/duplicate). Reset public data first.
- This is the ONLY heavy cloud op — run it right after the restriction lifts; budget ~one DB-size of egress.
