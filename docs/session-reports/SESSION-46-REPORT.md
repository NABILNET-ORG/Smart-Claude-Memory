# Session 46 — Security Compliance Sprint

**Date:** 2026-05-26
**Branch:** `main`
**Release:** v2.3.1 → **v2.3.2** (patch — security)
**Commits:** `bc26fb2` (schematic) · `b033482` (Migration 025) · `bfe37bc` (Migration 026 + version bump + docs)

## What shipped

Two forward-only, idempotent SQL migrations closing every finding in the Supabase Security Advisor report, plus the v2.3.2 release-prep paperwork. No MCP tool surface change (still 58), no test surface change, zero new runtime dependencies. The documented `service_role`-only access pattern is preserved end-to-end.

### Migration 025 — `scripts/025_security_advisor_compliance.sql`

Four idempotent sections, one file:

1. **RLS enabled** on `workflow_checkpoints` and `schema_migrations` (advisor: `rls_disabled_in_public`).
2. **`SECURITY INVOKER`** flipped on three views — `kg_supernodes`, `v_daemon_budget_health`, `v_task_budget_health`. Postgres views default to `SECURITY DEFINER`, which silently bypasses RLS on underlying tables. Requires PG15+.
3. **`search_path` pinned** to `public, extensions, pg_catalog` on four functions — `skill_graduations_touch_updated_at`, `match_chunks`, `kg_nodes_touch_updated_at`, `increment_daemon_bucket`. Closes the CVE-2018-1058 mutable-search-path attack surface. Discovers signatures from `pg_proc` at apply time, tolerates overloads.
4. **`REVOKE EXECUTE … FROM PUBLIC`** swept across all 23 user-defined functions/procedures in `public` via signature-agnostic DO block using `pg_get_function_identity_arguments`.

### Migration 026 — `scripts/026_revoke_anon_authenticated.sql`

Follow-up DO block that explicitly `REVOKE EXECUTE … FROM anon, authenticated` for every function/procedure in `public`. Why this was needed after 025: PostgREST exposes RPCs through the `anon` and `authenticated` roles, and Supabase auto-grants `EXECUTE` to both on `CREATE FUNCTION` — the catch-all PUBLIC revoke did not strip those explicit role grants, so the linter (correctly) continued flagging `anon_security_definer_function_executable` and `authenticated_security_definer_function_executable`.

Live-DB verification after both migrations applied:
- `workflow_checkpoints.rowsecurity = true`, `schema_migrations.rowsecurity = true`
- All three views: `security_invoker = true`
- All four named functions: `proconfig` contains `search_path=public, extensions, pg_catalog`
- 23 functions in `public`; `anon` EXECUTE count = **0**, `authenticated` EXECUTE count = **0**; `postgres` + `service_role` retain 23/23

### Release artifacts

- `package.json`: 2.3.1 → 2.3.2
- `CHANGELOG.md`: new `## [2.3.2] — 2026-05-26` section at top
- `ARCHITECTURE.md`: version stamp bumped (line 1), schematic caption extended, **v2.3.2** row added to §6 Version History
- `README.md`: schematic alt-text + caption updated, version badge bumped to 2.3.2, install-tag example bumped to `#v2.3.2`, tool roster header version-stamp bumped

### Hurdles + solutions

- **`init_project.legacy_sweep` flagged `scripts/backup-and-remove.ts`** at MEDIUM confidence. Sweep verdict: **KEEP — production tooling**. Five independent signals (npm script alias, README first-run flow, sweep's own false-positive table in `src/tools/setup.ts:1026`, distinct architectural role vs. `prune_memory`, production-grade code). Captured as Backlog #278 (done) + DECISION `SCM-S46-D1` (memory id 22800) with a 4-condition retention rule for future sweep candidates.
- **First `Copy-Item` for the schematic swap wasn't actually executed in the shell.** Caught by checking `git status` after the apparent copy — the working tree was clean and mtime was 22 days old. Ran the copy myself; new file size 1,860,749 (was 1,920,192), confirmed via `git diff --stat` before committing.
- **Bun in the context-mode sandbox couldn't resolve project deps.** TS verification scripts kept failing with parse errors on `import` statements when running through the sandbox. Worked around by writing a one-off `scripts/verify-NNN.ts` inside the project root, running it via `npx tsx`, then deleting it. Net effect: no churn in tracked files.
- **`pg_proc` enumeration over signature enumeration.** The advisor named ~18 RPCs but the safe sweep is every function/procedure in `public`. Used `pg_get_function_identity_arguments(p.oid)` so the migration tolerates overloads and future parameter-list drift without churn. Migration 025 touched 23 functions; Migration 026 touched the same 23.

### Decisions

- `SCM-S46-D1` (DECISION, project-local, memory id 22800) — `scripts/backup-and-remove.ts` retention rule: a file matching the `backup-*` sweep heuristic is PRODUCTION (not legacy bloat) if any of: (a) referenced by a documented npm script, (b) cited in README operational flow, (c) listed in the sweep heuristic's own false-positive table, (d) has a distinct architectural purpose from existing tools.

### Schema surface

Migrations applied through `026_revoke_anon_authenticated.sql`. Total migration count: **26** (was 24 at v2.3.1). All idempotent — `npm run schema` is safe to re-run.
