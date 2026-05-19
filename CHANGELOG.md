# Changelog

## [2.2.1] — 2026-05-19

**v2.2.1 — Docs-Only Patch: Core 3 Sync + Broken-Script Fix**

Restores 1:1 alignment between the published documentation and the v2.2.0 surface. No API change, no schema change, no MCP tool-surface change. Patch-level bump per semver — the only behavioral delta is the removal of two never-functional npm scripts.

### Fixed
- **README.md `[Bootstrap](#bootstrap)` link was dead** — the target heading was `## Install (3 steps, ~5 minutes)`, not `## Bootstrap`. Section renamed to `## Bootstrap (3-step setup, ~5 minutes)`; the duplicate-`## Install` ambiguity (L46 + L321) is resolved (L46 = package install, L321 = post-install setup ritual).
- **README.md migration-count claim** — said "18 schema migrations" while the project ships 21 (through `scripts/020_knowledge_graph.sql`).
- **`package.json` broken scripts** — removed `smoke:m8-kg` and `smoke:m8-gui`; both pointed at `scripts/smoke-m8-*.ts` files that never existed on disk.

### Added
- **README.md `## Usage — every command you'll actually run` section** with five reference blocks: quick CLI command table (10 npm scripts grouped by purpose), MCP tool invocation cheat sheet (14 canonical calls inside Claude Code), daily workflow recipes (6 task-shaped how-tos including session boot, indexing notes, capturing decisions, promoting to GLOBAL, GUI triage, session end), Knowledge Graph operations block (M8.1), full environment-variable reference table (13 SCM env vars across Supabase, Ollama, GUI, observability, graph daemon).
- **README.md `### Quick troubleshooting` table** covering the 5 most-likely setup failures with first-check advice.
- **README.md `### Full tool roster — 50 MCP tools by domain` subtable** under `## Toolbox` showing the categorized surface (Memory/Vision 7, Backlog/Living-docs 2, Guardian 11, Orchestrator 2, Ops 3, Trajectory 2, Skill Vault 6, Checkpoints 4, Curriculum 4, Graduation 4, Knowledge Graph 5).
- **ARCHITECTURE.md §4.10 — Hybrid-RAG Knowledge Graph & SVG Command Center (M8.1 / SCM-S36-D1).** Schema (migration `020`), `graph_extractor` daemon shape, 5 MCP tools, `/api/graph` route contract, force-directed renderer parameters, Boundary Invariant #1 preservation, failure modes.
- **ARCHITECTURE.md §4.11 — Modular GUI Subsystem (M8.2 / SCM-S38-D1).** Cross-mode `PUBLIC_DIR` resolution via `import.meta.url`, `serveStatic` + 16-entry MIME map + `path.relative` traversal guard, `fs.cpSync` build mirror, Google Fonts CSP relaxation, token-auth scope, 246-case test surface, dist-mode smoke evidence.
- **ARCHITECTURE.md §6 Version History — v2.2.0 row** summarizing the M3 → M8.2 arc (tool count 23 → 50, migrations through 020, tests 246/246, zero new runtime deps).

### Changed
- **README.md banner caption + version badge** v2.1.0 → v2.2.0.
- **README.md "twenty-three tools" elevator-pitch claim** → "fifty MCP tools" (the actual `grep -c '^server\.tool(' src/index.ts` output) with a milestone surface tour spanning memory/vision/backlog/hygiene/orchestration/system-health/M4–M8.
- **README.md `## npm scripts` table** refreshed from 5 entries to 10 — build chain, `copy:gui`, `gui`, `test`, `lint:boundaries`, accurate smoke list (no broken `smoke:m8-*` refs).

### Notes
- Tool surface unchanged at **50 MCP tools** registered in [src/index.ts](src/index.ts).
- 21 schema migrations unchanged.
- Backup branch `backup/pre-2.2.1-20260519` pushed to origin as the pre-bump snapshot — full rollback path remains `git reset --hard backup/pre-2.2.1-20260519` on `main`.

---

## [2.2.0] — 2026-05-19

**v2.2.0 — Agentic OS 2026 Production Baseline**

Multi-mission release covering Sessions 22–37. The largest single version arc since 2.0.0-rc1. **Zero new runtime dependencies across the entire arc.** Tagged at commit `052dc5f`; published as `smart-claude-memory-mcp@2.2.0` to npm (shasum `ac5d2bb`, 144 files, 270.6 kB packed, 1.1 MB unpacked).

### Added
- **M3 Sleep Learning (Single Brain mandate).** `compose_skill_candidate` / `promote_skill_candidate` / `reject_skill_candidate` / `list_skill_candidates` / `package_skill` / `request_skill` MCP tools. `src/sleep/proposer.ts` deleted — the sleep daemon mines stubs with NULL `proposed_name`/`proposed_steps`; the Orchestrator fills them in via `compose_skill_candidate` before any promotion. Verified across Sessions 22–25.
- **M4 Transactional Workflows.** `workflow_checkpoints` table (migration `014_workflow_checkpoints.sql`), `terminal_committed_checkpoint` recursive-CTE SQL function, `checkpoint_create` / `checkpoint_commit` / `checkpoint_rollback` / `checkpoint_list` MCP tools, restoration via M2 `get_trajectory_summary` (no snapshot engine). Closes the Session 19 archive_backlog.chunk_id backfill gap.
- **M5 Autonomous Curriculum (single-brain closure).** Deterministic queuer daemon `src/curriculum/{scanner,daemon}.ts` — three pure signal sources (`test_gap`, `rollback_repro`, stale-candidate refactor). MCP tools `list_curriculum_tasks` / `pull_curriculum_task` / `apply_curriculum_task` / `reject_curriculum_task`. Atomic auto-promote inside `apply_curriculum_task` SQL transaction — the verified curriculum cycle IS the curation. Migration `015_curriculum_tasks.sql`.
- **M6 Observability & Telemetry.** Append-only `daemon_telemetry` event table (migration `016_daemon_telemetry.sql`), `system_dashboard` MCP tool (24h compressed-Markdown rollups), per-daemon derived health blocks in `check_system_health`. 4th observability daemon `telemetry_pruner` with 30-day rolling retention (migration `018_telemetry_retention.sql`).
- **M7 Skill Graduation to GLOBAL.** Human-gated 3-state lifecycle (`proposed` → `composed` → `approved`/`rejected`). MCP tools `list_graduation_candidates` / `compose_global_rationale` / `confirm_promotion` / `reject_graduation`. Atomic `apply_graduation` RPC clones to `project_id='GLOBAL'` in one PostgreSQL transaction with `now()` collapsing across writes (microsecond-aligned). Migration `017_skill_graduations.sql`. Boundary Invariant #1 extended to `src/graduation/**` via `lint:boundaries`. The sole `is_global=true` mint path outside `save_memory({is_global:true})`.
- **M8.1 Hybrid-RAG Knowledge Graph + SVG Command Center.** `kg_nodes` + `kg_edges` schema (migration `020_knowledge_graph.sql`), deterministic `graph_extractor` daemon (`src/graph/{daemon,extractor}.ts`) — typed nodes (DECISION/PATTERN/ERROR/FILE) and edges with confidence score + chunk back-pointer. 5 MCP tools: `kg_upsert_node` / `kg_upsert_edge` / `list_kg_nodes` / `list_kg_edges` / `kg_hybrid_search`. Sovereign Command Center force-directed SVG visualizer (verified at 60 nodes / 0 overlapping pairs / drawer / `?type=FILE` filter end-to-end during Session 37 Visual QA).
- **M8.2 Modular GUI Subsystem.** Replaces the 703-line `DASHBOARD_HTML` monolith (`src/gui/static.ts`, deleted) with modular static assets in `src/gui/public/{index.html,style.css,app.js}`. Zero-dep `serveStatic` helper with URI-decode + `path.relative` traversal guard + 16-entry MIME map. Cross-mode `PUBLIC_DIR` via `import.meta.url`. Zero-dep build copy via `scripts/copy-gui-public.ts` using `fs.cpSync` (no `cpx`/`fs-extra` introduced). CSP relaxed for Google Fonts CDN (`fonts.googleapis.com` style, `fonts.gstatic.com` font). Token-auth scope changed to `/api/*` only — static assets stay open. Architectural details in ARCHITECTURE.md §4.11.
- **Cross-platform ESM standalone-entry-point fix (SCM-S37-P1, GLOBAL pattern).** Replaces the broken `import.meta.url === pathToFileURL(process.argv[1])` idiom with `path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])`. Catches three independent Windows-vs-POSIX path-comparison drifts (slash count, percent-encoded spaces, drive-letter casing). Promoted to GLOBAL Knowledge Vault as a universal pattern for any ESM service that double-purposes as library + CLI.

### Changed
- **Tool count 40 → 50.** Net +10 tools across M3/M4/M5/M6/M7/M8.1.
- **`build` script chain extended** from `lint:boundaries && tsc` to `lint:boundaries && tsc && npm run copy:gui`.
- **Test suite grew from ~91 to 246 cases** across 21 test files (full hermetic — no live Supabase/Ollama required).

### Notes
- 21 schema migrations through `020_knowledge_graph.sql` (was 18 in v2.0.1; v2.1.0 was migration-neutral; v2.1.1 was migration-neutral).
- Zero new runtime dependencies across the entire v2.0.1 → v2.2.0 arc.
- Six background daemons now observed: `sleep_learner`, `curriculum_scanner`, `trajectory_compactor`, `telemetry_pruner`, `graduation_scanner`, `graph_extractor`.

---

## [2.1.1] — 2026-05-17

**v2.1.1 — Install Crash Fix**

Patch release: resolved an `npm install` crash caused by the `archiver` transitive dependency tree and pivoted the plugin manifest to invoke the binary via `npx`. Issue surfaced through Session 28 release feedback on a freshly-cloned consumer machine.

### Fixed
- **`npm install` crashed on the `archiver` transitive dependency tree** (the `glob` transitive). Fixed via `package.json` `overrides` block pinning `archiver-utils.glob` to the project's resolved `$glob`. Restores clean install on Node ≥ 20 with fresh `npm@10+` lock-file generation.
- **`.claude-plugin/plugin.json` MCP server invocation** pivoted from a direct `node` call to `npx smart-claude-memory-mcp` so the marketplace install path no longer assumes a pre-built local checkout. Restores the "install plugin → boot Claude Code → tools work, no local repo required" promise.

### Notes
- Tool surface unchanged at 40 MCP tools.
- 19 schema migrations (no change from v2.1.0).
- Published to npm as `smart-claude-memory-mcp@2.1.1`.

---

## [2.1.0] — 2026-05-16

**v2.1.0 — GLOBAL Vault UX**

Browse-only enumeration of the reserved `'GLOBAL'` Knowledge Vault — pure SQL, zero embedding cost. Released to npm + GitHub during Session 28.

### Added
- **`list_global_patterns` MCP tool.** Deterministic SQL read against `memory_chunks WHERE project_id='GLOBAL'`. Tiered output: default returns a `content_preview` (≤120 chars); pass `include_content:true` for full content. Full JSONB `metadata_filter` matching `search_memory` (GIN-indexed containment). Pagination via `offset` + `limit` (default 10, hard cap 50), sorted `created_at DESC, id DESC`. Distinct from `search_memory({ include_global: true })` — that's "find by meaning" (semantic), this is "enumerate by attribute" (deterministic).
- **`init_project.capabilities` extended.** `global_scope` block gains `browse_tool` + `browse_args` fields. `context_gathering_hints` gains a GLOBAL-browse exemplar. `protocol` bumped to `smart-claude-memory/v2.1.0`.

### Notes
- Zero new dependencies, zero new indexes, zero new migrations — reuses the existing GIN(`jsonb_path_ops`) index from the §4 typed-retrieval surface and the existing `pg` pool.
- Tool surface grew from 39 → 40.
- Published to npm as `smart-claude-memory-mcp@2.1.0`.

---

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
