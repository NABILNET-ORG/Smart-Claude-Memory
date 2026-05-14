# Changelog

## [2.0.1] — 2026-05-14

**v2.0.1 — Tech-Debt & Operational-Hygiene Patch**

Pays off two pieces of debt carried out of v2.0.0 so the BYO-Supabase boot path becomes mathematically re-runnable. Zero schema-shape change, zero new features, zero new tool surface.

### Fixed
- **Migrations 010/011/012/015 — every `CREATE FUNCTION` now uses `CREATE OR REPLACE FUNCTION`** (10 functions, Backlog #131). Eliminates the duplicate-function-signature failure mode on migration re-apply, e.g. when a recovery-path operator deletes a ledger row and the apply loop replays the file. Every other DDL class in `scripts/` (extensions, tables, indexes, schemas, types, policies, triggers, `ADD COLUMN`, `ADD CONSTRAINT`) was already guarded — confirmed by the Session 26 read-only audit.
- **Migrations 005/014 — `INSERT INTO archive_backlog ... SELECT FROM moved` inside the `archive_done_backlog` RPC body gained bare `ON CONFLICT DO NOTHING`.** Note: this INSERT only runs when the RPC is called at runtime, not at migration apply time — so it is defensive call-time hygiene against a PK-collision failure mode in the archive flow, not strictly a migration-replay fix. The Session 26 audit conflated it with apply-time risk; the patch was kept on the v2.0.1 release because the call-time guarantee is independently useful.
- **Migration ledger denylist removed (Backlog #130).** `006_smoke.sql` and `006_verify.sql` were companion validation scripts that shared `scripts/` with real numbered migrations, forcing `loadMigrationFiles()` to maintain an explicit `excluded` Set. Both fixtures now live under `tests/sql_fixtures/`; `loadMigrationFiles()` collapsed to a single regex filter. The "every `0NN_*.sql` in `scripts/` is a migration" contract is now structural, not denylist-enforced.

### Added
- **Static idempotency check in `tests/migrations.test.ts`.** Parses every migration body and flags any top-level CREATE statement that lacks its idempotency guard (`OR REPLACE` for functions; `IF NOT EXISTS` for tables / indexes / extensions / `ADD COLUMN`). Runs unconditionally — no DB, no env flag, no live state — in <2 ms. The earlier provisional design used a destructive opt-in runtime re-apply test against `public.schema_migrations`; that approach was rejected because (a) shared-infra safeguards correctly block the truncate, and (b) the 18 migration bodies use `public.*` qualifiers throughout, which makes a clean temp-schema replay infeasible without a parser-level rewrite. Static analysis catches the regression class the audit identified and runs on every contributor's machine.

### Notes
- `schema_migrations.sha256` values for the 6 patched files diverge from what is recorded on already-applied dev DBs. This is silent and harmless: `applyPendingMigrations()` acts on filename presence only — applied rows are not re-validated — and fresh BYO-Supabase installs ship with the new hashes.
- The MCP server's tool surface is unchanged at 39 tools.
- The 18 schema migrations remain at version 18; only their re-runnability has improved.

## [2.0.0] — 2026-05-14

**v2.0.0 GA — Plugin Marketplace Release**

Smart-Claude-Memory is now installable as a Claude Code Plugin. Zero manual `~/.claude.json` edits, zero manual schema apply, zero hand-edited `~/.claude/settings.json` — first `init_project()` bootstraps an empty Supabase DB and verifies your Ollama models in one call.

### Added
- `.claude-plugin/plugin.json` manifest — installable via Claude Code marketplace; auto-wires the MCP server (with env passthrough for the 7 SCM vars) and the `md-policy.py` PreToolUse hook (`Write|Edit|Bash` matcher).
- `schema_migrations(filename, sha256, applied_at)` ledger table + idempotent apply-all CLI (`npm run schema`); re-runs are no-ops. Legacy single-file mode preserved for emergencies.
- `src/lib/migrations.ts` shared helper (`ensureLedger`, `loadMigrationFiles`, `listPendingMigrations`, `applyPendingMigrations`).
- `init_project` auto-applies pending migrations on first call against a fresh `pg.Client`. Surfaces a new `migrations` check + top-level `migrations: { applied, skipped, total }` block. Errors gracefully convert to `not_ready` without crashing the MCP server.
- `init_project` Ollama models preflight: queries `${OLLAMA_HOST}/api/tags` and verifies `moondream` + `nomic-embed-text` are pulled. Missing models surface a `partial` status with the exact `Run: ollama pull <names>` command. 5s timeout via `AbortController`.
- `scripts/backfill-ledger.ts` one-shot operational utility to sync `schema_migrations` for pre-existing DBs.
- `marketplace.json` for Claude Code marketplace publication.

### Changed
- Health enum extended: `"healthy" | "pending" | "degraded" | "down"`. Daemons within a 15-minute boot grace window report `pending` instead of `down`. Top-level `overall` no longer falsely promoted to `down` on cold boot. `pending` ranks below `degraded` (SEVERITY 0.5).
- `pg` promoted from `devDependencies` → `dependencies` (runtime use in `init_project`).
- README install ritual reduced from 5 steps to 3 (plugin install → empty Supabase + pull Ollama models → set 3 env vars).
- ARCHITECTURE.md gains a `## 7. Plugin Distribution` section covering manifest semantics, the migration ledger boot path, hook injection, and the pending/grace health state.

### Fixed
- `tests/trajectory-daemon.test.ts` key-count assertion (7 → 9) brought in sync with the per-tick token counters added in `58dc6d1` (Session 24).

### Migrated from 2.0.0-rc1
- All Observability Epic work (4 daemons + GLOBAL Vault + system_dashboard) carried over unchanged.
- No breaking changes to existing tool surfaces.

### Notes
- The MCP server's tool surface is unchanged at 39 tools.
- The 18 schema migrations are unchanged; only the apply mechanism evolved.
