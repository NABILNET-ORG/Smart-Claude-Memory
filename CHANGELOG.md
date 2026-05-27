# Changelog

## [2.3.2] — 2026-05-26

**v2.3.2 — Security Compliance Sprint (Session 46, SCM-S46-F1 + SCM-S46-F2)**

Patch-level security release closing every finding in the Supabase Security Advisor report. No MCP tool surface change (still **58**), no test surface change, no new runtime dependencies. Two forward-only, idempotent migrations bring the schema in line with PostgREST least-privilege expectations. The documented `service_role`-only access pattern is preserved end-to-end — `service_role` retains its explicit `EXECUTE` grant and `BYPASSRLS` attribute, so no documented call path regresses.

### Added
- **`scripts/025_security_advisor_compliance.sql`** — four idempotent sections in one migration:
  - **RLS** enabled on `workflow_checkpoints` and `schema_migrations` (Supabase advisor `rls_disabled_in_public`).
  - **`SECURITY INVOKER`** flipped on three views (`kg_supernodes`, `v_daemon_budget_health`, `v_task_budget_health`) — Postgres views default to `SECURITY DEFINER`, which silently bypasses RLS of the underlying tables. Requires Postgres 15+ (Supabase is on PG15+).
  - **`search_path`** pinned to `public, extensions, pg_catalog` on `skill_graduations_touch_updated_at`, `match_chunks`, `kg_nodes_touch_updated_at`, `increment_daemon_bucket`. Closes the CVE-2018-1058 family attack surface for mutable-search-path functions. Discovers actual signatures from `pg_proc` at apply time, so overloads and parameter-list drift are handled automatically.
  - **`REVOKE EXECUTE … FROM PUBLIC`** on every user-defined function/procedure in `public` (23 rows touched). Strips the implicit grant Postgres applies to PUBLIC on `CREATE FUNCTION`; explicit role grants are preserved.
- **`scripts/026_revoke_anon_authenticated.sql`** — follow-up DO block looping `pg_proc × pg_namespace` for the `public` schema and explicitly `REVOKE EXECUTE … FROM anon, authenticated` on every function/procedure. The Advisor continued flagging `anon_security_definer_function_executable` and `authenticated_security_definer_function_executable` after Migration 025 because Supabase auto-grants `EXECUTE` to those two PostgREST roles on function creation; the catch-all PUBLIC revoke didn't strip them. Post-apply state: **23/23** functions retained `postgres` + `service_role` EXECUTE, **0/23** retained `anon` or `authenticated` EXECUTE.

### Notes
- Schema migrations applied total **26** (up from 24 at v2.3.1). Idempotent under `npm run schema` re-runs — every block uses `IF EXISTS` or a `pg_proc` lookup, so re-applying is a no-op.
- Verification at HEAD: live-DB queries against `pg_class.relrowsecurity`, `pg_options_to_table(reloptions)` for `security_invoker`, `pg_proc.proconfig` for `search_path`, and `aclexplode(proacl)` for the grant audit all confirm the expected post-state. Sample for `match_chunks(vector, double precision, integer, text)` shows `search_path=public, extensions, pg_catalog`.
- Design choice: signature-agnostic DO blocks (via `pg_get_function_identity_arguments`) rather than hardcoded `ALTER FUNCTION name(args)` statements. Tolerates future overloads without migration churn. The user-supplied function list became the *target* set; the apply-time enumeration is the *source of truth*.
- New DECISION `SCM-S46-D1` (Session 46) — backup-script sweep verdict (`scripts/backup-and-remove.ts` retained as production tooling, not legacy bloat). Memory ID 22800. Documents a 4-condition retention rule for future `init_project.legacy_sweep` candidates.

---

## [2.3.1] — 2026-05-25

**v2.3.1 — Post-Mega-Sprint Roll-Up: Backlog UI, KG Auto-Sync, Zero-Autonomy Governance**

Patch-level release rolling up the four post-v2.3.0 commits that landed in Session 43 Part 2 (Epic F + Epic G + tech-debt hardening + v2.1.11 governance pivot) plus the Session 44 dashboard reorder. MCP tool count unchanged at **58**. Schema migrations through `024`. Test suites 26 → **28** (added `gui-backlog.test.ts` + `file-watcher-daemon.test.ts`); test count 277 → **292** across **66** node-test runs. Zero new runtime dependencies. No API breakage.

### Added
- **`GET /api/backlog?project_id=…` HTTP route** in `src/gui/server.ts` — returns `{ project_id, total, by_status, tasks[] }` shaped exactly for the dashboard Kanban; bearer-token-gated through the same `GuiHandlers` seam as `/api/graph` and `/api/graph/clusters`; emits HTTP 200 with empty arrays (never 500) when the project has no rows. 7 dedicated tests in `tests/gui-backlog.test.ts` covering shape, status partitioning, auth parity, empty-project, and project-isolation (commit `9c5adea`).
- **Active Backlog Kanban dashboard** in `src/gui/public/{index.html,app.js,style.css}` — four-column todo / in_progress / blocked / done grid wired to `/api/backlog`, auto-refresh-aware, project-scoped header chip, count badges per lane, live priority/notes/timestamp display. First user-facing surface for the `manage_backlog` MCP tool that bypasses the chat transcript entirely (Epic F / M8).
- **`src/sync/file-watcher.ts` — Epic G KG Auto-Sync file-watcher daemon** — `fs.watch`-based debounced ingester that mirrors `MEMORY_ROOTS` edits into `memory_chunks` without requiring an explicit `sync_local_memory` call. Daemon-allow-list-aware (no Guardian friction), ARM-budget-gated, telemetry-emitting, idempotent via content hash. 8 dedicated tests in `tests/file-watcher-daemon.test.ts` covering debounce, dedup, allow-list backfill, and error recovery (commit `6c0f625`).
- **`scripts/024_*.sql`** — schema migration backing the file-watcher daemon's bookkeeping state. Migrations applied total **24** (up from 23 at v2.3.0). Idempotent under `npm run schema` re-runs.

### Changed
- **GUI dashboard section order** — `src/gui/public/index.html`: the Active Backlog Kanban now renders **first**, above the M7 Graduations lanes and the Knowledge Graph panel. Reasoning: backlog is the most-frequently-consulted surface during a session; surfacing it without scrolling materially reduces cognitive overhead on every dashboard load. Title bar and breadcrumb retain the M7 labelling for now (separate visual-identity decision).
- **Constitution v2.1.10 → v2.1.11 — Zero-Autonomy Session Termination Rule.** Strips the prior `context_pct + force` semantics in `manage_backlog({action:'session_end'})` and replaces them with a single hard rule: the Agent is FORBIDDEN from invoking `session_end` on its own — only explicit human commands ("end session", "wrap up", "handover") trigger it. Removes the LLM-self-reported-context-window heuristic that proved unreliable and was repeatedly abused as a lazy-exit excuse (commit `e0eabf1`). Runtime guard is the docstring on `manage_backlog` itself plus the CLAUDE.md Wrap-Up Ritual rewrite.
- **File-watcher daemon hardening** — post-launch tech-debt sweep tightening error-path emits so the daemon no longer produces the prior `[telemetry] insert failed` stderr noise observed in `clustering_scanner` and `file_watcher` flows. One-file refactor (`+24/-4`) preserving all daemon contracts (commit `44910c9`).

### Notes
- Verification at HEAD: `npm run build` clean (tsc + lint:boundaries + copy:gui mirroring 3 GUI files into `dist/gui/public/`), `npm test` 292/292 PASS across 66 suites, `scripts/smoke-epic-e-packaging.mjs` 27/27 PASS (tarball still boots, MCP handshake `protocolVersion: 2025-06-18`, 58 tools exposed), `npm run schema` 24/24 migrations applied.
- No new architectural decisions saved (DECISION IDs). Session 43 Part 2 / Session 44 work was governance + feature execution on patterns already chosen at v2.3.0. The `createRequire` pattern from Epic E and the daemon-allow-list backfill pattern from Epic G are both `package_skill` / GLOBAL-promotion candidates if either recurs.
- Constitution drift continues at v2.1.8 → v2.1.11 (intentional local customization preserving Sovereign Memory Protocol body). Operators wanting the canonical template still run `upgrade_constitution({force:true})`.

### Release Prep (Session 45 — 2026-05-25)
Distribution-readiness sweep against the existing v2.3.1 surface (no code or behavior change; published tarball, MCP tool count, schema, and test suite all unchanged). Lands as commit `cd67204` (`chore(release): prepare package.json for public distribution`):

- **`.gitignore`** — added `*.tgz` so packed releases (e.g. `smart-claude-memory-mcp-2.3.1.tgz`) can never be committed by accident. Verified via `git check-ignore` against the live tarball at repo root.
- **`package.json` `prepare` script** — `"prepare": "npm run build"`. Architecturally critical: git-based installs (`npm install git+https://github.com/NABILNET-ORG/Smart-Claude-Memory.git`) now auto-compile TypeScript → `dist/` via npm's lifecycle hook, so the `smart-claude-memory-mcp` binary resolves immediately on the consumer side. Also runs before `npm pack` / `npm publish` to guarantee fresh `dist/` in every published tarball.
- **npm keywords expanded 7 → 17** — adds `claude`, `anthropic`, `model-context-protocol`, `long-term-memory`, `sovereign-memory`, `rag`, `vector-database`, `embeddings`, `knowledge-graph`, `llm`, `agent` for public-registry discoverability. The other public metadata fields (`repository`, `bugs`, `homepage`, `author`, `license: MIT`, `engines.node >= 20`, `files[]`, `bin`) were already in place and verified npm-publish ready.

---

## [2.3.0] — 2026-05-24

**v2.3.0 — M8.3 Semantic Clustering (Mission 10)**

Ships the full M8.3 arc started in Session 41 (Tasks 1-4: schema + kmeans + louvain + daemon + MCP tools + HTTP route) and closed in Session 42 (Suite D HTTP-route tests + `check_system_health` clustering_scanner block + GUI Cluster View toggle). MCP tools 55 → **58**. Schema migrations through `023_kg_clustering.sql`. Test files 22 → **26**. Zero new runtime dependencies.

### Added
- **`scripts/023_kg_clustering.sql`** — `kg_supernodes` (per-project K-Means centroids, K=⌊√N⌋ capped) + `kg_node_clusters` (per-node supernode + community assignment) + `kg_knn_pairs` RPC for Louvain edge fetch (SCM-S41-D1).
- **`src/clustering/kmeans.ts`** — pure-TS spherical mini-batch K-Means with k-means++ seeding (duplicate-safe, no zero-distance loops), K=N identity branch, K-cap at √N for K-too-large, deterministic with seeded RNG. Suite A 10/10 GREEN (SCM-S41-D1).
- **`src/clustering/louvain.ts`** — single-level Louvain community detection in pure TS via seeded mulberry32 (no `graphology` dep). Suite B 6/6 GREEN (SCM-S41-D2).
- **`src/clustering/daemon.ts`** — `clustering_scanner` daemon: dirty-check (`kg_node_clusters` vs `kg_nodes` count), paged embedding fetch, K-Means → per-supernode subgraph → Louvain, bulk UPSERT, ARM-gated, telemetry-emitting. Suite C 8/8 GREEN against live Supabase (SCM-S41-D5).
- **3 new MCP tools** — `list_supernodes`, `list_cluster_members`, `trigger_clustering` (SCM-S41-D7).
- **`GET /api/graph/clusters?level=super|drill&supernode_id=N`** — flowed through the `GuiHandlers` seam in Session 42 (refactor commit `c72d187`); `level=super` returns the SuperNode graph (≤200 nodes), `level=drill` returns members of one supernode or a community-nested view when the supernode has >200 members (SCM-S41-D7).
- **Suite D — 5 HTTP-route tests** (`tests/clustering-routes.test.ts`): D1 super ≤200, D2 drill members, D3 drill community-nested, D4 bearer-token gate parity, D5 empty-result → 200-not-500.
- **`check_system_health.clustering_scanner`** block with `derived` health metrics (cold-boot grace, staleness, error-rate-1h) and worst-of overall rollup.
- **GUI Cluster View** in `src/gui/public/{index.html,app.js}` — toggle button + breadcrumb + back-button + SUPER/COMMUNITY palette entries (gold/steel-blue) + log₂(node_count) radius scaling + clickable SUPER nodes drill into their members, all layered on the existing kg renderer via a payload shim.

### Changed
- **Constitution v2.1.8 → v2.1.10** — adds the **Context Window Governance** Execution Imperative with `context_pct + force` semantics. Agent autonomy forbidden below 50%; `{force:true}` reserved for user-explicit-request only (SCM-S41-D3 / SCM-S41-D6). Runtime gate enforced in `src/tools/backlog.ts`.
- **GUI deterministic per-project port** — SHA-256(`projectId`) → stable port in `[7790, 8790)`; 3-layer idempotent auto-start (module-flag → TCP probe → bind); browser-fatigue protection (skip open when port already serving); `injectProjectBranding()` adds `PROJECT · <ID>` chip to dashboard header without any frontend changes. Hardcoded `claude-memory` fallback removed — universal (SCM-S41-D4).
- **`DaemonName` union** extended with `clustering_scanner`; `ClusteringEndedPayload` event kind added.

### Notes
- Constitution drift `v2.1.8 → v2.1.10` is intentional on local `CLAUDE.md` (preserves Sovereign Memory Protocol body). Operators who want the canonical template can run `upgrade_constitution({force:true})`.
- v2.2.2 CHANGELOG entry was inadvertently omitted in Session 39 — the full v2.2.2 body is documented in `ARCHITECTURE.md §6 Version History`.

---

## [2.2.2] — 2026-04 (backfill — entry missing from CHANGELOG at release time)

**v2.2.2 — Agentic Resource Manager (Mission 9)**

Structural enforcement of the *Tokens Are Currency* imperative. Adds `scripts/021_agent_budgets.sql`, `src/budget/{types,store,gate}.ts` primitives, runtime gates at all four LLM-touching call sites (`delegate_task`, `compose_skill_candidate`, `compose_global_rationale`, `index_image`) and the `trajectory_compactor` daemon. 5 new MCP tools (`start_task`, `end_task`, `get_task_budget`, `get_daemon_budget`, `reset_daemon_budget`) — roster 50 → 55. GUI `/api/budget` route + `#tele-budget` ticker. Foundation fix: `deriveDaemonStatus` cold-boot grace scales with cadence (`max(15min, interval_ms × 1.1)`). Default mode `SCM_BUDGET_ENFORCEMENT_MODE=off` ships zero behavior change for legacy operators. Full body in `ARCHITECTURE.md §6 Version History`.

---

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
