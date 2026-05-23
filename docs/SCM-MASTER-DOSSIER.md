# SCM Master Dossier — Smart Claude Memory v2.2.1

> A definitive A-to-Z reference for the Smart Claude Memory MCP plugin. Generated 2026-05-23. Sources: `package.json@2.2.1`, `src/**`, `scripts/**`, `hooks/**`, `tests/**`.

---

## 1. Executive Core

### 1.1 What SCM Is

**Smart Claude Memory** (`smart-claude-memory-mcp@2.2.1`, NPM bin: `smart-claude-memory-mcp` → `dist/index.js`) is a **Model Context Protocol (MCP) server** that gives Claude Code a persistent, cross-session, typed, multi-tenant, semantic memory backed by a hybrid cloud + local architecture. It is loaded by Claude Code via the MCP registration in `~/.claude.json` and exposes **50 MCP tools** the agent can call to read/write/search a long-term memory and to drive an autonomous "Agentic OS 2026" closed-loop learning system.

Its core design promise: **"Bring your own empty Supabase project; the plugin handles the rest."** First-run, the server auto-applies 21 idempotent SQL migrations, verifies a local Ollama install, registers a Sovereign Constitution into `CLAUDE.md`, and starts seven background daemons — without any operator intervention beyond setting three env vars.

### 1.2 Hybrid Cloud + Local Memory Concept

Memory is split across two physical tiers, joined by **`memory_chunks`** as the authoritative row store:

| Tier | Role | Tech | Where it runs |
|------|------|------|---------------|
| **Cloud** | Durable storage of every chunk, edge, candidate, checkpoint, telemetry event, frozen pattern, archived backlog row | Supabase Postgres + `pgvector` HNSW + `jsonb_path_ops` GIN | hosted Supabase project (user-owned) |
| **Local** | Embedding generation (768-dim `nomic-embed-text`), image captioning (`moondream`), policy enforcement, hot caches | Ollama runtime + Python hook + JSON cache files | operator's laptop |

The orchestration layer (`src/index.ts`) keeps both tiers in sync: it never embeds in the cloud (no API key dependency, no per-token cost), and it never serves search results from the local cache (single source of truth in Postgres). The hybrid mode is what gives SCM **zero recurring inference cost** at retrieval, **semantic + structured** query power, and **air-gappable** embedding when offline.

### 1.3 The Sovereign Architecture

SCM enforces a layered contract called the **Sovereign Memory Protocol** (currently v2.1.7, hash-registered in `src/tools/sovereign-constitution.ts`). The protocol binds *both* the storage substrate and the agent's behavioral envelope:

1. **Typed Sovereign Taxonomy.** Every `save_memory` row carries `metadata.type ∈ {DECISION, PATTERN, ERROR, LOG}`. The `metadata` column is GIN-indexed (`jsonb_path_ops`), so typed filters pre-filter *before* pgvector ranks. Untyped saves are allowed but get no GIN pre-filter — discouraged by the constitution.
2. **Dual-Scope Tenancy.** Rows live under a `project_id` slug (derived from CWD). One reserved tenant — **`'GLOBAL'`** — is the cross-project Knowledge Vault. `search_memory` defaults to dual-scope (current project ∪ `GLOBAL`); single-scope is opt-in via `include_global:false`. Writing to GLOBAL requires **Sovereign Vetting** — `metadata.is_global:true` + `global_rationale` (≥10 chars) — and the SQL RPC rejects bare writes.
3. **Orchestrator-Worker Pattern.** Large research tasks (>3 files or >100 lines of raw output) MUST go through `delegate_task`, which spawns a sub-agent and returns a 2-paragraph synthesis. Direct orchestrator reads stay surgical. When `SMART_CLAUDE_MEMORY_ORCHESTRATOR_MODE` is set, the `md-policy.py` hook hard-blocks any direct `Write`/`Edit`/`Bash` from the orchestrator session — all execution must be delegated.
4. **Frozen Patterns.** A subset of files can be flagged "frozen" in `frozen_patterns` (Supabase) + `~/.claude-memory/frozen-patterns.json` (local cache). The Python hook then blocks `Write` on those paths (Edit-only) before Claude Code even sees a denial. Currently 282 patterns frozen across the active project.
5. **Verification Gate.** When `raise_verification_gate` is called, a `verification-pending.json` flag lands in `~/.claude-memory/`. From that moment, all `Write`/`Edit`/`Bash` attempts are blocked by the hook until `confirm_verification({success: true|false})` is called. This is SCM's "stop-the-line" mechanism for manual test checkpoints.
6. **Hard-Rule Hook.** `hooks/md-policy.py` enforces four invariants pre-tool-use: Zero-Local-MD (only Core 3 at project root), 750-line ceiling on new writes (grandfathered files keep their edits), Frozen-Feature lock, Verification Gate.
7. **Sovereign Constitution.** Each project's `CLAUDE.md` carries a hash-registered, version-stamped protocol block. Drift detection runs every `init_project` and surfaces `upgrade_constitution({force:true})` recommendations when the block diverges from the canonical template hash.

### 1.4 Capability Surface — At a Glance

- **50 MCP tools** across nine functional clusters (memory CRUD, search, hygiene, verification, image, backlog, observability, knowledge graph, graduation lifecycle, checkpoints, orchestrator delegation).
- **21 idempotent SQL migrations** (`scripts/001_schema.sql` → `020_knowledge_graph.sql`) covering pgvector + HNSW + GIN + RLS + 6-arg dual-scope match RPC + transactional workflow checkpoints + curriculum queue + telemetry event log + skill graduations + knowledge-graph schema.
- **9 background daemons** (`startKeepAlive` + 7 functional daemons + `(planner)` test consumers): trajectory compactor, sleep learner, curriculum scanner, graduation scanner, telemetry pruner, knowledge-graph extractor, plus the keep-alive pinger that warms the HTTPS pool.
- **246/246 tests** across 21 test files (`tests/*.test.ts`).
- **Zero new runtime dependencies** across the entire v2.0.1 → v2.2.1 arc — the plugin still ships with 8 production deps: `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `archiver`, `dotenv`, `glob`, `ollama`, `pg`, `zod`.
- **Modular GUI** (M8.2): zero-dep `serveStatic` HTTP server (`src/gui/server.ts`) + vanilla-JS SPA (`src/gui/public/{index.html,style.css,app.js}`) that ships a 2.5D force-directed knowledge-graph explorer, a graduation kanban, telemetry tickers, and a `localStorage`-persisted settings drawer.

---

## 2. Workflow Mechanisms — How the Daemons Work

All seven daemons are kicked off at the bottom of `src/index.ts` (after `ensureSchema`) and use `.unref()` so they never block process exit. Each runs on its own `setInterval` clock with env-configurable cadence. Every daemon emits `daemon_telemetry` rows (`run_started` / `run_ended` / `run_errored` events with payload counters), which feed into `check_system_health` and `system_dashboard` for derived-health rollups.

### 2.1 Boundary Invariant #1 — Single Brain Mandate

Four daemon directories are CI-fenced (`scripts/lint-boundaries.ts` — runs as the first step of `npm run build`) against importing any LLM SDK or hitting any LLM endpoint: `src/sleep/**`, `src/curriculum/**`, `src/graduation/**`, `src/trajectory/**`. The reasoning, codified in ARCHITECTURE.md §4.6, §4.7, §4.9, and §4.11: there must be exactly **one brain** in the system (the Orchestrator). Daemons are deterministic queuers / scanners / extractors / proposers — they prepare *candidates* for the Orchestrator to curate. The CI fence is the structural enforcement; `runOnce` exports give each daemon a synchronous test entry point.

### 2.2 Trajectory Compactor (`src/trajectory/daemon.ts` + `stripper.ts` + `summarizer.ts`)

- **Migration:** `011_trajectory_compaction.sql` (table `trajectory_summaries`).
- **Tick (`tick()` at L219):** every `TRAJECTORY_COMPACTOR_INTERVAL_MS` (default 10 min) → `fetchCandidates()` pulls `memory_chunks` rows whose content size exceeds `minBytes` AND have no `trajectory_summaries` row yet → for each, `compactOneChunk()` runs `stripTrajectory()` (JSON-blob collapse, stack-trace truncation, dedupe consecutive lines, noise strip) → if still bloated, `summarizeTrajectory()` calls Ollama (boundary-exempt: summarizer lives at `src/trajectory/summarizer.ts` but is NOT under the lint-fenced set — it's the documented exception for compactor-only use) with a strict abort signal → INSERTs `trajectory_summaries(source_chunk_id, summary, source_tokens, summary_tokens)`. Telemetry: `run_started` + `run_ended` with `compacted/skipped/errored` counters + `source_tokens` / `summary_tokens` aggregates.
- **MCP surface:** `compact_trajectory` (manual single-row compaction), `get_trajectory_summary` (read-back).
- **Purpose (AgentDiet):** keep the working `memory_chunks` set small enough for fast HNSW retrieval; archive the long-form trajectory in a parallel table.

### 2.3 Sleep Learner (`src/sleep/daemon.ts` + `miner.ts`)

- **Migration:** `012_sleep_learning.sql` (table `skill_candidates`).
- **Tick (`tick()` at L176):** every `SLEEP_LEARNER_INTERVAL_MS` (default 1 h) → `mineClusters()` does the heavy lifting: `fetchSummariesForProject()` (joins `memory_chunks` ⋈ `trajectory_summaries` ⋈ `archive_backlog`) → `clusterSummaries()` (cosine-distance agglomerative on embeddings, with a trigram-hash dedupe pre-pass) → for each cluster with `≥minFrequency` and a high archive-success-rate (`fetchSuccessArchiveByChunk`), proposes a `skill_candidates` row with state `'proposed'` and a derived `proposed_title` + `proposed_body`.
- **Boundary Invariant #1:** the miner does NOT generate the title/body via an LLM. It picks the most-frequent canonical phrase from the cluster's summaries (deterministic). The Orchestrator later refines via `compose_skill_candidate` (which CAN call an LLM, since `src/tools/sleep.ts` is NOT under the lint-fenced set).
- **MCP surface:** `list_skill_candidates`, `compose_skill_candidate`, `promote_skill_candidate`, `reject_skill_candidate`.
- **Rollback signal hook:** `fetchRollbackSignalsByChunk()` joins `workflow_checkpoints` with `terminal_committed_checkpoint` recursive-CTE to penalize chunks that have been rolled-back-after-commit — those score lower in candidate proposal.

### 2.4 Curriculum Scanner (`src/curriculum/daemon.ts` + `scanner.ts`)

- **Migration:** `015_curriculum_tasks.sql` (table `curriculum_tasks`).
- **Tick:** every `CURRICULUM_INTERVAL_MS` (default 1 h) → runs three deterministic scans in sequence:
  1. **`scanTestGaps`** — looks for `agent_skills` rows used `≥minFrequency` times in the last 14 days that have NO corresponding test in `tests/`. Enqueues `kind:'test_gap'` tasks.
  2. **`scanRollbackHotspots`** — joins `workflow_checkpoints` + `archive_backlog` to find chunks that were rolled back AFTER commit. Enqueues `kind:'rollback_repro'` tasks for the chunk's source file.
  3. **`scanStaleCandidates`** — finds `skill_candidates` older than `ttlDays` (14) still in `state='proposed'`. Enqueues `kind:'refactor'` to either promote-or-reject.
- **Boundary Invariant #1:** strictly enforced. No LLM. The deterministic queries above are all the intelligence the daemon has.
- **MCP surface:** `list_curriculum_tasks`, `pull_curriculum_task` (worker claim with row-level lock), `apply_curriculum_task` (worker submits proof + atomic auto-promote), `reject_curriculum_task`.

### 2.5 Graduation Scanner (`src/graduation/daemon.ts` + `scanner.ts`)

- **Migration:** `017_skill_graduations.sql` (table `skill_graduations`, three-state machine: `proposed` → `composed` → `approved`|`rejected`).
- **Tick:** every `GRADUATION_INTERVAL_MS` (default 1 h) → `findGraduationCandidates()` looks for `agent_skills` rows that meet ALL THREE production-validation thresholds: `frequency_used ≥ 10` AND `success_rate ≥ 0.90` AND `age_days ≥ 14`. For each, INSERTs `skill_graduations(state:'proposed', telemetry_snapshot:<frozen>)`.
- **Sovereign Vetting structural enforcement:** the daemon CANNOT mint `is_global:true`. Promotion to GLOBAL is a *human-gated* flow: `compose_global_rationale` (LLM-assisted via `src/tools/graduation.ts` — NOT lint-fenced) → `confirm_promotion` → atomic `apply_graduation` SQL RPC that clones the row into `project_id='GLOBAL'`. This is the ONLY path that can write to GLOBAL.
- **Boundary Invariant #1:** the daemon is `propose-only`; never confirms.
- **MCP surface:** `list_graduation_candidates`, `compose_global_rationale`, `confirm_promotion`, `reject_graduation`.

### 2.6 Telemetry Pruner (`src/telemetry/pruner.ts`)

- **Migration:** `018_telemetry_retention.sql`.
- **Tick:** every `TELEMETRY_PRUNER_INTERVAL_MS` (default 6 h) → rolling `DELETE FROM daemon_telemetry WHERE ts < now() - interval '<TELEMETRY_PRUNER_RETENTION_DAYS> days'` (default 30 d). The pruner itself emits telemetry, so its own rows get pruned by future ticks.
- **Health-derived state:** the first `15min` after process start, `check_system_health` returns `status:'pending'` for this daemon (grace window) — after that, missing `run_ended` events for `>2 × interval` trip `'degraded'`.

### 2.7 Knowledge-Graph Extractor (`src/graph/daemon.ts` + `extractor.ts`)

- **Migration:** `020_knowledge_graph.sql` (tables `kg_nodes`, `kg_edges`).
- **Tick:** every `SCM_GRAPH_EXTRACTOR_INTERVAL_MS` (default 2 min — fastest cadence in the system) → `fetchUnprocessed(batch)` pulls `memory_chunks` rows not yet anchored in `kg_nodes` → for each, `extractFromChunk()` runs a heuristic, deterministic extractor (regex over markdown headers, file-path patterns, DECISION-ID patterns, code-fence anchors) to mine: one **primary node** (the chunk itself), a set of **reference nodes** (FILE, DECISION, SKILL, ERROR, PATTERN typed), and **edges** (MENTIONS, DEFINES, REFERENCES, OWNED_BY). `processChunk()` upserts via `kg_upsert_node` / `kg_upsert_edge`.
- **Boundary Invariant #1:** no LLM. Pure regex + structural pattern matching. The SVG Command Center in the GUI renders this graph live.
- **MCP surface:** `kg_upsert_node`, `kg_upsert_edge`, `kg_hybrid_search` (combines pgvector + graph traversal), `list_kg_nodes`, `list_kg_edges`.

### 2.8 Keep-Alive Pinger (`src/supabase.ts`)

- **Tick:** every `KEEP_ALIVE_INTERVAL_MS` (default 5 min) → cheap `SELECT count(*) FROM memory_chunks LIMIT 1` to keep the Supabase HTTPS pool warm. Recorded in the `keep_alive` slot of `check_system_health`. Without it, the first call after idle pays a 1-2s TLS-handshake cold-start.

### 2.9 Daemon Telemetry Contract (`src/telemetry/emit.ts` + `types.ts`)

Every daemon imports `emitDaemonTelemetry(event, payload)` from `src/telemetry/emit.ts`. The three event kinds — `'run_started'`, `'run_ended'`, `'run_errored'` — get serialized into `daemon_telemetry(daemon, event, ts, duration_ms, error_message, payload jsonb)`. `check_system_health` derives a per-daemon `status` field by querying the most recent event of each kind, comparing against a `2 × interval` staleness threshold, and counting `run_errored` rows in the last hour.

---

## 3. Exhaustive File Ledger

> Every source file in `src/`, `scripts/`, `hooks/`, and `tests/` is documented below. Format per file: **path** · _line count_ · primary responsibility · key exports · ecosystem connection.

### 3.0 Table of Contents

- [3.1 `src/` root files (9)](#31-src-root-files-9)
- [3.2 `src/tools/` MCP tool handlers (29)](#32-srctools-mcp-tool-handlers-29)
- [3.3 `src/sleep/` Sleep Learner daemon (2)](#33-srcsleep-sleep-learner-daemon-2)
- [3.4 `src/curriculum/` Curriculum Scanner daemon (2)](#34-srccurriculum-curriculum-scanner-daemon-2)
- [3.5 `src/graduation/` Graduation Scanner daemon (2)](#35-srcgraduation-graduation-scanner-daemon-2)
- [3.6 `src/graph/` Knowledge-Graph extractor daemon (2)](#36-srcgraph-knowledge-graph-extractor-daemon-2)
- [3.7 `src/trajectory/` AgentDiet compactor (3)](#37-srctrajectory-agentdiet-compactor-3)
- [3.8 `src/transactions/` Workflow checkpoints (1)](#38-srctransactions-workflow-checkpoints-1)
- [3.9 `src/telemetry/` daemon telemetry (3)](#39-srctelemetry-daemon-telemetry-3)
- [3.10 `src/lib/` library helpers (1)](#310-srclib-library-helpers-1)
- [3.11 `src/gui/` Modular GUI (4)](#311-srcgui-modular-gui-4)
- [3.12 `scripts/` migrations + tooling (~22)](#312-scripts-migrations--tooling-22)
- [3.13 `hooks/` policy enforcer (2)](#313-hooks-policy-enforcer-2)
- [3.14 `tests/` test suites (~21)](#314-tests-test-suites-21)

---

### 3.1 `src/` root files (9)

#### `src/index.ts` · 912 lines · **MCP server entry point**

The boot file. Imports the `@modelcontextprotocol/sdk` `Server` class, instantiates `server = new Server(...)`, then registers every one of the 50 tools via `server.tool(name, description, schema, handler)`. Bottom of the file:
1. Calls `ensureSchema()` (from `src/lib/migrations.ts`) to apply pending migrations on first run.
2. Calls `startKeepAlive()` to warm the Supabase HTTPS pool.
3. Starts the seven daemons (`startCompactor`, `startSleepLearner`, `startCurriculumDaemon`, `startGraduationDaemon`, `startTelemetryPruner`, `startGraphExtractor`).
4. Fires off an async `legacyBackupSummary` scan (read-only — surface only).
5. Connects to `stdio` transport and yields control.

Also defines `DEFAULT_VISION_PROMPT` (the OCR-first, zero-guessing image-caption prompt used by `index_image`) and `projectIdSchema` (the Zod schema describing the `project_id` arg with auto-derived default).

**Tool roster (49 unique `server.tool()` calls grep'd from this file):** `sync_local_memory`, `prune_memory`, `search_memory`, `list_global_patterns`, `save_memory`, `upgrade_constitution`, `package_skill`, `request_skill`, `compact_trajectory`, `get_trajectory_summary`, `list_skill_candidates`, `compose_skill_candidate`, `promote_skill_candidate`, `reject_skill_candidate`, `checkpoint_create`, `checkpoint_commit`, `checkpoint_rollback`, `checkpoint_list`, `list_curriculum_tasks`, `pull_curriculum_task`, `apply_curriculum_task`, `reject_curriculum_task`, `list_graduation_candidates`, `compose_global_rationale`, `confirm_promotion`, `reject_graduation`, `kg_upsert_node`, `kg_upsert_edge`, `kg_hybrid_search`, `list_kg_nodes`, `list_kg_edges`, `manage_backlog`, `check_code_hygiene`, `confirm_verification`, `raise_verification_gate`, `check_rule_conflicts`, `summarize_memory_file`, `index_image`, `check_system_health`, `system_dashboard`, `list_frozen`, `freeze_file`, `unfreeze_file`, `batch_freeze_patterns`, `sweep_legacy_backups`, `init_project`, `refactor_guard`, `analyze_regression`, `delegate_task`, `sync_artefacts`. (The 50th tool — `bloat_audit` family — is registered inline via the `init_project` flow.)

**Ecosystem connection:** the funnel for everything. Every MCP call from Claude Code lands here. Tool handlers all live in `src/tools/*`; this file just wires names → schemas → handlers and brings up the daemons.

#### `src/config.ts` · 46 lines · **Environment loader**

Loads `.env` from the project root via `dotenv.config({ path: <abs> })` (absolute-path resolution prevents ambiguity when MCP server is invoked from arbitrary cwd). Validates 7 required env vars via Zod: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service-role), `OLLAMA_HOST`, `OLLAMA_EMBED_MODEL`, `MEMORY_ROOTS` (semicolon-separated), `SUPABASE_POOLER_URL` (for `apply-schema`), `EMBED_DIM` (default 768). Exports `config` (parsed) + `memoryRoots` (split + trimmed).

#### `src/project.ts` · 29 lines · **Project ID slugifier**

`getCurrentProjectId(cwd?)` → kebab-cases the basename of the current working directory. The result is the row-tenancy key in `memory_chunks`. The reserved sibling slug `'GLOBAL'` is the Knowledge Vault tenant.

#### `src/project-detect.ts` · 123 lines · **Multi-stack project root finder**

Walks up from cwd looking for stack-specific markers: `package.json` (Node), `Cargo.toml` (Rust), `pyproject.toml` / `requirements.txt` / `setup.py` (Python), `pom.xml` / `build.gradle` (Java), `go.mod` (Go), `.git` (fallback). Returns the first matching directory. Used by `init_project` and by callers that need a stable project root regardless of where the MCP was spawned from. Avoids spurious project-ID changes when Claude Code is invoked from a subdirectory.

#### `src/ollama.ts` · 80 lines · **Ollama client**

Thin wrapper over the `ollama` npm package. Exports `embed(text)` → POST `/api/embed` with `model: config.OLLAMA_EMBED_MODEL` and returns the 768-dim vector. Exports `caption(imagePath, prompt)` → POST `/api/generate` with `model:'moondream'` for image captioning (used by `index_image`). Handles 404 (model not pulled) by surfacing a user-friendly install command.

#### `src/supabase.ts` · 563 lines · **Supabase client + RPC wrappers + frozen-pattern cache + keep-alive**

The single Postgres facade. Constructs the `@supabase/supabase-js` client with service-role key (bypasses RLS — the deny-all policy from `006_security_hardening.sql` means anon/authenticated can read nothing, only service-role can talk to memory rows). Exports:
- `supabase` — the client.
- `match_memory_chunks(query_embedding, p_project_id, match_count, min_similarity, p_metadata_filter, p_include_global)` — RPC wrapper for the 6-arg dual-scope match function.
- `match_memory_chunks_typed(...)` — typed-filter variant.
- `applyMigration(sql)` — runs a single migration via the `pg` driver (NOT through Supabase, since the JS client can't run DDL).
- Frozen-pattern cache hydration: `loadFrozenPatternsCache()` / `writeFrozenPatternsCache()` (writes to `~/.claude-memory/frozen-patterns.json`).
- `startKeepAlive()` / `stopKeepAlive()` — the 5-min HTTPS-pool pinger.
- `legacyBackupSummary(workspace)` — async dry-run sweep of `backup-*.ts` candidates surfaced at startup.

**Ecosystem connection:** every cloud write/read goes through this file. The frozen-pattern cache + keep-alive states are both observed by `check_system_health`.

#### `src/chunker.ts` · 45 lines · **Markdown-aware chunker**

`chunkMarkdown(md)` splits a markdown string into `RawChunk[]` along header boundaries (`#`, `##`, `###`), aiming for ~600-token chunks. Preserves header path as `chunk.heading_path` (e.g., `"# Section / ## Subsection"`) so retrieval can show context. Used by `sync_local_memory` to chunk `.md` files before embedding.

#### `src/verification-gate.ts` · 55 lines · **Verification flag I/O**

Manages the `verification-pending.json` flag file in `~/.claude-memory/`. Exports `raisePendingVerification(payload)` (writes the flag), `clearPendingVerification()` (deletes), `readPendingVerification()` (loads — used by `init_project` to surface a pending gate). The Python hook (`md-policy.py`) reads this same file directly to block tool calls.

#### `src/version.ts` · 19 lines · **Version SSOT**

Re-exports `version` from `package.json` so every tool that needs the version string (`check_system_health`, `init_project`, the GUI's `/api/health`) gets it from one place. Bumping `package.json` is enough — no other file needs editing.

---

### 3.2 `src/tools/` MCP tool handlers (29)

#### `src/tools/setup.ts` · 1087 lines · **`init_project` (readiness check + smart-scout)**

The largest tool handler. Bundles together: env validation, hook presence check (`hooks/md-policy.py`), MCP-registration audit (greps `~/.claude.json`), `dist/` build check, Core 3 audit (CLAUDE.md / README.md / ARCHITECTURE.md mtime spread + presence), Supabase migration audit (pending count), Ollama model audit (required models pulled), constitution drift detection (hash-compare via `extractConstitutionBlock`), bloat audit (token count of CLAUDE.md + hidden MEMORY.md), legacy-sweep dry-run, and capability fan-out (`capabilities.protocol`, `capabilities.taxonomy`, `capabilities.context_gathering_hints`). On first run, also calls `ensureSovereignConstitution` to append the protocol block to `CLAUDE.md` if missing. Returns a JSON envelope consumed by Claude Code at session start (the user's boot ritual).

#### `src/tools/save.ts` · 104 lines · **`save_memory` (typed write path)**

Validates the typed-taxonomy contract: `metadata.type ∈ {DECISION, PATTERN, ERROR, LOG}` (warns if missing — the GIN index won't pre-filter), and for `is_global:true` saves enforces `global_rationale: string` with `length ≥ 10` (throws `SOVEREIGN VETTING FAILED` otherwise). Chunks the content via `chunkMarkdown`, embeds each chunk, then bulk-INSERTs into `memory_chunks` with the project_id (or `'GLOBAL'` when global). Exports `GLOBAL_PROJECT_ID = 'GLOBAL'`.

#### `src/tools/search.ts` · 271 lines · **`search_memory` (intent routing + dual-scope semantic)**

The retrieval entry point. Routes intent first — if the query contains "archive" / "completed tasks" / "done tasks" → returns `archive_backlog` rows (`mode:'archive'`); if "Active Backlog" / "pending tasks" / "what's next" → returns `cloud_backlog` rows (`mode:'backlog'`); otherwise → semantic mode: embed query → call `match_memory_chunks_typed` RPC with `(query_embedding, project_id, k, min_similarity, metadata_filter, include_global)` → return matched chunks. The `include_global:true` default fans out to `project_id IN (current, 'GLOBAL')` so universal patterns surface in every project.

#### `src/tools/list-global-patterns.ts` · 146 lines · **`list_global_patterns`**

Browse-only window onto the GLOBAL Knowledge Vault. Optional `metadata_filter` (typically `{type:'PATTERN'}`), `limit`, `offset`, `include_content` boolean (defaults false to keep response small). Used by the agent to discover universal patterns without firing a vector search.

#### `src/tools/sync.ts` · 340 lines · **`sync_local_memory` (incremental + hash-gated)**

Scans `MEMORY_ROOTS` (semicolon-separated dirs from `.env`) recursively for `.md` files → for each, computes a sha256 over content → checks `memory_chunks.file_hash` for an existing match (per migration 003) → SKIPS if unchanged. For changed files: chunks via `chunkMarkdown`, embeds each chunk in parallel batches of 100, bulk-INSERTs (UPSERT on `(project_id, file_origin, chunk_index)`). Supports `force: true` (re-embed everything), `auto_purge: true` (chunks for files that no longer exist on disk — but ONLY after a mandatory dry-run preview + all-or-nothing verify gate). Protected files (never auto-purged): `CLAUDE.md`, `MEMORY.md`, `README.md`, `LICENSE*`, `CHANGELOG*`.

#### `src/tools/prune.ts` · 166 lines · **`prune_memory` (orphan reaping)**

Explicit-paths gate (`SCM-S31-D1`): the caller MUST pass the list of paths to keep; orphans (chunks whose `file_origin` is not in the list) are deleted in bulk. This is the human-gated cleanup tool for stale embeddings. No glob inference — always explicit.

#### `src/tools/sovereign-constitution.ts` · 401 lines · **Constitution template + deterministic upgrader**

Already discussed in §1.3. Exports `SOVEREIGN_CONSTITUTION_TEMPLATE` (the canonical v2.1.7 protocol block), `CANONICAL_CONSTITUTION_VERSION = "v2.1.7"`, `KNOWN_CANONICAL_HASHES` (registry of safe-to-auto-upgrade prior versions), `ensureSovereignConstitution(workspace)` (the append-or-regenerate path used by `init_project`), and `upgradeConstitutionBlock(workspace, {dry_run, force})` (the deterministic hash-compare-then-atomic-write upgrader — never uses an LLM, never hallucinates).

#### `src/tools/backlog.ts` · 752 lines · **`manage_backlog` + Living-Docs sync**

The most operationally important tool. Five sub-actions: `add` (enqueue a backlog item), `list` (return active items), `update` (promote to done / change status), `prune_done` (move done items to `archive_backlog`), `archive_list` (read the archive), `session_end` (the wrap-up ritual orchestrator). The `session_end` path runs in sequence: `updateProjectArchitecture(projectId)` (regenerates the auto-block in ARCHITECTURE.md — file tree Mermaid, `ARCH_MAX_DEPTH=5`) → `updateLocalReadme(projectId)` (regenerates the auto-block in README.md — File Architecture Mermaid + Recent Progress log) → `backfillArchiveChunkIds()` (links archive rows back to their source chunks) → emits `next_session_command_markdown` for the agent to post verbatim. `manage_backlog` is the trigger for the new BLOCKING Pre-Flight Content Audit (constitution v2.1.7 Wrap-Up Ritual step 0).

#### `src/tools/health.ts` · 493 lines · **`check_system_health`**

Polls Supabase (count from `memory_chunks`) + Ollama (`/api/tags` for required-model presence) + every daemon's status block. For each daemon, exports `deriveDaemonStatus({last_run_ended_at, interval_ms, error_count_1h, grace_window_ms})` which returns `{status:'healthy'|'degraded'|'down'|'pending', reason}`. Aggregates into a top-level `overall:'healthy'|'degraded'|'down'|'pending'`. Includes orchestrator status (`mode_active`, `self_heal_default`, `max_healing_attempts_default`, `advisory_hook`, `line_limit`) — read from env vars at call time.

#### `src/tools/system_dashboard.ts` · 211 lines · **`system_dashboard`**

24-hour event-sourced rollup. Queries `daemon_telemetry` for `(daemon, event, count, sum(duration_ms), sum(payload->'compacted'))` over the trailing 24h, returns a per-daemon row with `runs`, `errors`, `avg_duration_ms`, `last_run_iso`, plus a top-level `system_summary` text block. Used by the GUI's tickers (`#tele-approved`, `#tele-rejected`, etc.) and exposable as raw JSON.

#### `src/tools/verification.ts` · 374 lines · **`raise_verification_gate` + `confirm_verification` + `analyze_regression`**

`raise_verification_gate(payload)` writes the flag file → all subsequent Write/Edit/Bash blocked by the hook. `confirm_verification({success: true|false, notes})` reads the flag, INSERTs a `verification_log` row, then deletes the flag → execution resumes. `analyze_regression({file, backups_to_compare})` is bundled here because it shares the verification-log surface — it diffs the file against the last N backups in `~/.claude-memory/backups/` and surfaces what changed.

#### `src/tools/orchestrator.ts` · 200 lines · **`delegate_task` + `sync_artefacts`**

`delegate_task({task, workspace})` — the Mandatory Delegation path. Spawns a sub-agent via the MCP SDK's sub-process mechanism, passes the task prompt, captures the sub-agent's 2-paragraph synthesis, and returns it to the orchestrator. Sub-agents inherit the working directory and have their OWN `dist/index.js` registered as MCP — so they can also call `search_memory`, but they CANNOT call `delegate_task` (single-level delegation only). `sync_artefacts({workspace})` is the post-success bookkeeper: regenerates ARCH/README auto-blocks, runs `lint:boundaries`, runs `copy:gui`, returns a summary.

#### `src/tools/checkpoint.ts` · 386 lines · **`checkpoint_*` (transactional workflows)**

Wraps `src/transactions/checkpoint.ts`. Four MCP handlers: `checkpoint_create({workflow_name, project_id})` (opens a checkpoint row), `checkpoint_commit({checkpoint_id})` (terminal commit — the recursive-CTE marker), `checkpoint_rollback({checkpoint_id, reason})` (terminal rollback — feeds the curriculum scanner's rollback-hotspot signal), `checkpoint_list({state, k, offset})` (browse). The Sleep Learner uses `workflow_checkpoints` joined with `terminal_committed_checkpoint` to score skill candidates.

#### `src/tools/compact.ts` · 111 lines · **`compact_trajectory` + `get_trajectory_summary`**

Manual single-row entry into the Trajectory Compactor pipeline. Useful for the agent to deliberately compress a specific verbose chunk on demand. `get_trajectory_summary` reads back the most-recent summary for a `source_chunk_id`.

#### `src/tools/skills.ts` · 258 lines · **`package_skill` + `request_skill`**

JIT Skill Vault primitives (planned Agentic OS 2026 Mission 1 — partially shipped). `package_skill({name, body, metadata})` writes a `skill_candidates` row at `state='approved'` with `is_global:false` (per-project skill). `request_skill({name})` does a hybrid search across both project + GLOBAL skills returning the best match.

#### `src/tools/sleep.ts` · 351 lines · **`list_skill_candidates` + `compose_skill_candidate` + `promote_skill_candidate` + `reject_skill_candidate`**

Worker-side of the Sleep Learner. NOT lint-fenced — these handlers CAN call an LLM (via `src/trajectory/summarizer.ts` or via `ollama.ts` directly) to refine titles/bodies. `compose_skill_candidate` is the LLM-curation step that turns a deterministically-mined candidate into a polished skill. `promote_skill_candidate` flips state to `'approved'` (atomic UPSERT into `agent_skills`).

#### `src/tools/curriculum.ts` · 343 lines · **`list_curriculum_tasks` + `pull_curriculum_task` + `apply_curriculum_task` + `reject_curriculum_task`**

Worker-side of the Curriculum Scanner. `pull_curriculum_task` does a row-level `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers can claim disjoint tasks. `apply_curriculum_task({task_id, proof, auto_promote})` runs a single atomic transaction: UPDATE task to `state:'verified'`, optionally promote the associated `skill_candidates` row to `'approved'` (the auto-promote path that lets the curriculum loop close itself).

#### `src/tools/graduation.ts` · 415 lines · **`list_graduation_candidates` + `compose_global_rationale` + `confirm_promotion` + `reject_graduation`**

Worker-side of the Graduation Scanner. `compose_global_rationale` calls an LLM to draft the `global_rationale` text (≥10 chars) the candidate needs to pass Sovereign Vetting. `confirm_promotion({graduation_id, global_rationale})` runs the atomic `apply_graduation` SQL RPC — clones the row into `project_id='GLOBAL'`, flips state to `'approved'`, INSERTs a `daemon_telemetry` audit row.

#### `src/tools/kg.ts` · 433 lines · **`kg_upsert_node` + `kg_upsert_edge` + `kg_hybrid_search` + `list_kg_nodes` + `list_kg_edges`**

Worker-side of the Knowledge-Graph Extractor. `kg_hybrid_search({query, k, edge_depth})` is the headline tool: runs a pgvector match on `kg_nodes` (with their associated chunk embeddings) → traverses up to `edge_depth` hops via `kg_edges` → returns a connected sub-graph ranked by combined cosine + edge weight. This is what powers the GUI's SVG Command Center.

#### `src/tools/hygiene.ts` · 395 lines · **`check_code_hygiene`**

Enforces the 750-line ceiling (`HARD_LIMIT = 750`) on arbitrary file paths. `planRefactor(path, text)` proposes N-split refactor outlines for files that breach the limit. Auto-generated paths (`types.ts`, `*.g.dart`, `*.freezed.dart`, `*.arb`) are exempted by `isExcluded`. The Python hook (`md-policy.py`) does the same check pre-tool-use; this MCP tool gives the agent a way to introspect the limit programmatically.

#### `src/tools/policy.ts` · 115 lines · **`list_frozen` + `freeze_file` + `unfreeze_file` + `sweep_legacy_backups`**

CRUD over the `frozen_patterns` cloud table + local cache. `sweep_legacy_backups({workspace, confirm, aggressive})` is the legacy-backup mover — dry-run by default, requires `confirm:true` to actually move files into `backups/legacy-sweep-<timestamp>/`, requires `aggressive:true` to include MEDIUM-confidence candidates.

#### `src/tools/batch-freeze-patterns.ts` · 281 lines · **`batch_freeze_patterns`**

Bulk hydration helper. Accepts either a glob list or a path to a rule file, expands to concrete paths, INSERTs into `frozen_patterns` in one round-trip. Used to bootstrap a new project's frozen-feature set without dozens of single `freeze_file` calls.

#### `src/tools/frozen-cache.ts` · 116 lines · **Frozen-pattern cache loader (shared)**

`loadFrozenCache()` + `writeFrozenCache()` over `~/.claude-memory/frozen-patterns.json`. Atomic-write via temp + rename. De-duplicates entries on write. Used by `setup.ts`, `policy.ts`, `health.ts`, and the Python hook.

#### `src/tools/refactor.ts` · 262 lines · **`refactor_guard` + `analyze_regression`**

`refactor_guard({workspace})` runs the compiler gate (`tsc --noEmit`) and surfaces structured errors. `scanImports(filePath)` walks the import graph from a file. `rollbackFile(file)` restores the most-recent backup. `analyze_regression` (also re-exported from `verification.ts`) diffs against backups.

#### `src/tools/conflict.ts` · 144 lines · **`check_rule_conflicts`**

Looks for contradictory rules in the merged set of (CLAUDE.md + frozen-patterns + .gitignore). Useful catch for "I'm freezing a file that the policy already exempts" situations.

#### `src/tools/image.ts` · 123 lines · **`index_image`**

Moondream-driven OCR-first captioner. Reads image, sends to `caption(imagePath, prompt)` (defaulting to the strict zero-guessing prompt from `index.ts`), embeds the resulting caption text, INSERTs into `memory_chunks` with `metadata.kind: 'image'` and the caption stored in `content`.

#### `src/tools/summarize.ts` · 71 lines · **`summarize_memory_file`**

Reads a `.md` file, calls Ollama with a "summarize in 2 paragraphs" prompt, returns the summary. Used by the agent for quick file-level glances without loading the full file.

#### `src/tools/bloat-audit.ts` · 127 lines · **Internal bloat auditor (used by `init_project`)**

`auditBloat(workspace)` — counts tokens in `CLAUDE.md` + hidden `MEMORY.md`, flags if either exceeds `BLOAT_THRESHOLD = 10000`. Returns the structured `bloat_audit` block embedded in the `init_project` response. When bloated, `init_project` raises a recommendation with `id:'sovereign_purge'` and the agent must request explicit YES/NO consent before archiving.

#### `src/tools/shared-schemas.ts` · 28 lines · **Shared Zod schemas**

Reused argument shapes (e.g., `projectIdInputShape`, `kInputShape`) imported by multiple tool handlers to avoid duplicating Zod definitions.

---

### 3.3 `src/sleep/` Sleep Learner daemon (2)

#### `src/sleep/daemon.ts` · 269 lines · **Sleep Learner tick loop**

`mineOneCluster(cluster)` runs the per-cluster proposal: scores candidates against `fetchSuccessArchiveByChunk` and `fetchRollbackSignalsByChunk`, picks the canonical phrase, INSERTs `skill_candidates`. `runMiningOnce({batch})` is the testable single-pass entry point. `tick()` is the wrapped daemon body that emits `run_started` / `run_ended` telemetry. `startSleepLearner()` / `stopSleepLearner()` boot/halt the interval. `runSleepLearnerOnce = tick` is the re-exported alias for tests.

#### `src/sleep/miner.ts` · 398 lines · **Cluster mining algorithm**

The deterministic intelligence: `trigramHash(text)` (cheap pre-dedupe key), `cosine(a, b)` (dot-product on normalized vectors), `meanVector(vectors)` (cluster centroid), `clusterSummaries(rows)` (agglomerative on cosine distance with a threshold). `fetchSummariesForProject` joins `memory_chunks ⋈ trajectory_summaries`. `fetchSuccessArchiveByChunk` joins `archive_backlog`. `fetchRollbackSignalsByChunk` runs the `workflow_checkpoints` ⋈ `terminal_committed_checkpoint` recursive-CTE penalty signal. `mineClusters({projectId, minFrequency, batch})` is the master orchestrator returning `CandidateStub[]`.

**Ecosystem connection:** lint-fenced (Single Brain). Outputs feed `agent_skills` via the curated promotion path through `src/tools/sleep.ts`.

---

### 3.4 `src/curriculum/` Curriculum Scanner daemon (2)

#### `src/curriculum/daemon.ts` · 264 lines · **Curriculum tick + status**

`runCurriculumScanOnce()` runs all three scans (test gaps, rollback hotspots, stale candidates) sequentially and returns `{enqueued, skipped, errored}`. `tick()` is the daemon-mode wrapper with telemetry emission. `startCurriculumDaemon()` / `stopCurriculumDaemon()` boot/halt. `recordVerified(autoPromoted)` / `recordRejected()` are counter mutators called from the worker handlers (`apply_curriculum_task` / `reject_curriculum_task`) — these counters feed `getCurriculumStatus()` and ultimately `check_system_health`'s curriculum block.

#### `src/curriculum/scanner.ts` · 351 lines · **The three deterministic scans**

- `scanTestGaps(cfg)`: queries `agent_skills` rows used `≥minFrequency` times in 14d → for each, checks if a test file in `tests/` mentions the skill name → if not, INSERTs a `curriculum_tasks` row of `kind:'test_gap'`.
- `scanRollbackHotspots(cfg)`: queries `workflow_checkpoints` for `(state='rolled_back', terminal=true)` rows in the last 14d → for each, INSERTs a `kind:'rollback_repro'` task referencing the source chunk.
- `scanStaleCandidates(cfg)`: queries `skill_candidates` rows older than `ttlDays` still in `'proposed'` → INSERTs a `kind:'refactor'` task (the agent will either promote-or-reject on apply).
- `runScanOnce(cfg)` runs all three and returns aggregate `ScanRunResult`.

**Ecosystem connection:** lint-fenced. Output feeds `curriculum_tasks` queue consumed by `src/tools/curriculum.ts` workers.

---

### 3.5 `src/graduation/` Graduation Scanner daemon (2)

#### `src/graduation/daemon.ts` · 273 lines · **Graduation tick + status**

`runGraduationScanOnce(opts)` runs `findGraduationCandidates` and INSERTs `skill_graduations` rows at `state:'proposed'` with a *frozen telemetry snapshot* — meaning the success-rate and frequency-used numbers are captured at the moment of proposal so subsequent activity doesn't shift the bar. `startGraduationDaemon()` / `stopGraduationDaemon()`. `recordApproved()` / `recordRejected()` are called from `confirm_promotion` / `reject_graduation` worker handlers.

#### `src/graduation/scanner.ts` · 122 lines · **Production-validation thresholds**

`findGraduationCandidates({minFrequency, minSuccessRate, minAgeDays, batch})` runs the three-criteria SQL filter on `agent_skills`. The thresholds default to `(10, 0.90, 14)` — the Graduation Charter (SCM-S33-D1). Returns `GraduationCandidate[]` for the daemon to insert.

**Ecosystem connection:** lint-fenced. Sovereign Vetting is structurally enforced — this file CANNOT produce a `'approved'` row, only `'proposed'`.

---

### 3.6 `src/graph/` Knowledge-Graph extractor daemon (2)

#### `src/graph/daemon.ts` · 394 lines · **Graph extractor tick loop**

`fetchUnprocessed(batch)` pulls `memory_chunks` rows whose `id` is not yet in `kg_nodes.source_chunk_id`. `coerceEmbedding(raw)` normalizes Postgres `vector` text format into `number[]`. `processChunk(chunk, embedding)` calls `extractFromChunk` to mine nodes/edges, then UPSERTs them via the `kg.ts` helper functions. `runGraphExtractorOnce(opts)` is the testable single-pass entry. `tick()` is the daemon body. `deriveStatus()` produces the health block with `derived.status` (healthy / degraded / pending) + `extracted_total`.

#### `src/graph/extractor.ts` · 189 lines · **Heuristic extraction (deterministic)**

`sanitizeLabel(s, max)` clips and quotes node labels. `extractFromChunk(chunk)` parses the chunk content for:
- **Primary node**: the chunk itself, typed `MEMORY`.
- **FILE references**: regex on `path/to/file.ts` patterns.
- **DECISION references**: regex on `SCM-S<N>-D<i>` Decision IDs.
- **SKILL references**: tokens matching `agent_skills.name` patterns.
- **PATTERN references**: `metadata.type:'PATTERN'` markers.
- **Edges**: `MENTIONS`, `DEFINES`, `REFERENCES`, `OWNED_BY` between primary and reference nodes.

Returns `ExtractionResult{nodes, edges}`. Boundary Invariant #1 enforced: pure regex + structural parsing, NO LLM call.

**Ecosystem connection:** lint-fenced. Outputs feed `kg_nodes` / `kg_edges` consumed by `kg_hybrid_search` and the GUI's SVG renderer.

---

### 3.7 `src/trajectory/` AgentDiet compactor (3)

#### `src/trajectory/daemon.ts` · 313 lines · **Compactor tick + status**

`fetchCandidates(limit, minBytes)` pulls `memory_chunks` rows whose `octet_length(content) > minBytes` AND have no `trajectory_summaries` row yet. `compactOneChunk(row)` runs the strip-then-summarize pipeline. `runCompactionOnce(opts)` is the testable entry. `tick()` is the daemon body. `getCompactorStatus()` returns the health-block details.

#### `src/trajectory/stripper.ts` · 126 lines · **Pre-summarization noise strip**

Pure deterministic transformations on the raw content text:
- `collapseJsonBlobs(lines)` — flattens JSON-shaped lines to a placeholder `{...}`.
- `truncateStackTraces(lines)` — keeps top 3 + bottom 3 frames, replaces middle with `...`.
- `dedupeConsecutive(lines)` — collapses repeated identical lines.
- `stripNoiseLines(lines)` — removes blank, timestamp-only, prompt-marker lines.
- `capLength(text)` — hard char cap.
- `stripTrajectory(raw)` returns `{stripped, source_tokens, stripped_tokens}`.

#### `src/trajectory/summarizer.ts` · 104 lines · **Ollama-backed summarizer**

`summarizeTrajectory(stripped, opts)` calls `ollama.generate({model: SUMMARIZER_MODEL, prompt})` with a strict abort signal (timeout). `postProcess(raw)` trims, dedupes paragraphs, truncates at sentence boundary. `raceAbort(promise, signal)` races the LLM call against the abort signal so a hung Ollama doesn't lock up the daemon.

**Ecosystem connection:** the daemon directory is NOT under the lint-fence (it's the documented compactor-only exception per ARCHITECTURE.md §4.5). Output feeds `trajectory_summaries`, which the Sleep Learner reads.

---

### 3.8 `src/transactions/` Workflow checkpoints (1)

#### `src/transactions/checkpoint.ts` · 450 lines · **Atomic workflow state machine**

Backs `src/tools/checkpoint.ts`. Models a workflow as a chain of `workflow_checkpoints` rows linked by `parent_checkpoint_id` — opening, committing, and rolling back are atomic INSERTs/UPDATEs. The recursive-CTE `terminal_committed_checkpoint` (defined in `014_workflow_checkpoints.sql`) walks the chain to find the latest committed terminal state for any workflow_name. Used by:
- `archive_backlog` rows (which can be linked to a successful workflow).
- The Sleep Learner's `fetchSuccessArchiveByChunk` for signal weighting.
- The Curriculum Scanner's `scanRollbackHotspots` for negative signals.

---

### 3.9 `src/telemetry/` daemon telemetry (3)

#### `src/telemetry/emit.ts` · 22 lines · **Emit helper**

`emitDaemonTelemetry(daemon, event, payload)` — single-row INSERT into `daemon_telemetry`. Swallows errors silently (telemetry must never crash a daemon). Sets `ts = now()`, computes `duration_ms` from `payload.start_ms` if present.

#### `src/telemetry/types.ts` · 71 lines · **TypeScript types**

`DaemonName`, `EventKind`, `RunStartedPayload`, `RunEndedPayload`, `RunErroredPayload`, `DerivedStatus`, `DerivedBlock` — the shared shapes consumed by every daemon and by `health.ts`.

#### `src/telemetry/pruner.ts` · 156 lines · **Retention pruner**

`runPrunerOnce()` runs the rolling `DELETE FROM daemon_telemetry WHERE ts < now() - interval`. `startTelemetryPruner()` boots the daemon. `getPrunerStatus()` returns health-block details with the 15-min grace window for cold starts (per ARCHITECTURE.md §4.8).

---

### 3.10 `src/lib/` library helpers (1)

#### `src/lib/migrations.ts` · 165 lines · **Migration runner**

`ensureSchema()` is called once at process boot from `src/index.ts`. It connects to Postgres via the `pg` driver (NOT through the Supabase JS client — DDL needs raw SQL), reads `scripts/0*.sql` in order, queries the `schema_migrations` table to see what's applied, and runs pending migrations in a single transaction. Idempotent — already-applied migrations are skipped. Surfaces a `fix_command` ("set SUPABASE_POOLER_URL …") when the IPv4-reachable pooler URL is missing.

---

### 3.11 `src/gui/` Modular GUI (4)

#### `src/gui/server.ts` · 464 lines · **Zero-dep HTTP host**

Single-file `node:http` server. No express, no fastify — `http.createServer` + a hand-rolled URL parser. Routes:

| Method · Path | Handler |
|---|---|
| `GET /` | `serveStatic(res, "/index.html")` |
| `GET /api/health` | Returns `{ok, service:"smart-claude-memory-gui", version}` — open to unauthenticated probes for liveness |
| `GET /api/graduations[?project_id=&state=&k=&offset=]` | `listGraduationCandidates` proxy |
| `POST /api/graduations/:id/compose` | `composeGlobalRationale` proxy |
| `POST /api/graduations/:id/confirm` | `confirmPromotion` proxy |
| `POST /api/graduations/:id/reject` | `rejectGraduation` proxy |
| `GET /api/graph[?project_id=&node_limit=&edge_limit=&type=]` | Live knowledge-graph read for the SVG Command Center |
| `GET /<anything else>` | `serveStatic(res, path)` — falls through to PUBLIC_DIR |

**Auth model:** optional bearer-token via `SCM_GUI_TOKEN` env var. When set, every `/api/*` route except `/api/health` requires `Authorization: Bearer <token>`. Static assets stay open even with the token enabled — operators can preview the UI without a token, just can't mutate state.

**`serveStatic(res, path)` (L382)**: resolves `PUBLIC_DIR` via `import.meta.url` (ESM-safe, works under both `tsx` dev and packaged `dist/`). Computes `targetPath = path.join(PUBLIC_DIR, path)`. Then runs a URI-decoded `path.relative(PUBLIC_DIR, targetPath)` traversal check — `%2E%2E%2F` and other encoded `../` patterns are blocked here. MIME map covers `html/css/js/json/svg/ico/png/jpg/woff2`. 404s on missing files. This is the GLOBAL pattern `SCM-S38-P1` — the canonical zero-dep static server with traversal guard.

**`readJsonBody(req)` (L425)**: collects request body with a 1MB hard cap (DoS guard), parses as JSON, returns `Record<string, unknown>`.

#### `src/gui/public/index.html` · 262 lines · **SPA shell**

Single HTML file. Top to bottom:
- `<header>` with project label + telemetry tickers (`#tele-approved`, `#tele-rejected`, `#health` dot, `#refresh` button, `#settings-open` gear).
- Graduation Kanban — four `<section class="lane" data-state="proposed|composed|approved|rejected">` columns, each populated by `loadGraduations()` in `app.js`.
- `<section class="graph-panel" id="graph-panel">` — the SVG Command Center:
  - Header controls: `#g-node-limit`, `#g-edge-limit`, `#g-type-filter`, `#g-reload`, `#g-stats`.
  - `<svg id="graph-svg" viewBox="0 0 1000 600">` — the actual canvas.
  - Zoom controls: `#g-zoom-in`, `#g-zoom-out`, `#g-zoom-fit`.
  - HUD: `#g-hud-zoom` / `#g-hud-pan` / `#g-hud-temp` (temperature = sim energy).
  - `<aside id="graph-detail" hidden>` — drawer for selected node.
- `<footer>` with latency ticker.
- `<dialog id="composeDialog">` + `<dialog id="rejectDialog">` — modal forms for the graduation actions.
- `<aside id="settings-drawer">` — slide-in settings panel (theme, refresh interval, node size, edge thickness, timezone, etc.).
- `<div id="toast">` — bottom-left notification stack.

#### `src/gui/public/style.css` · 1483 lines · **Design system**

CSS-only design system. Top sections (by comment markers found in the source):
- CSS custom properties (`:root`) — color tokens, spacing scale, type scale, motion tokens.
- Layout primitives — `.lane`, `.card`, `.panel`, `.drawer`.
- Component styles — graduation cards (with `.success-rate` color-coded ratio bar), graph panel HUD, settings drawer rows.
- Form controls — custom `<select class="cc-select">`, range inputs with `setRangeFill` JS-driven gradient fill.
- Toast stack, dialogs, focus rings, motion-reduced fallbacks.
- 48.7 kB packed = the biggest single file in the GUI bundle.

#### `src/gui/public/app.js` · 1012 lines · **Vanilla-JS SPA controller** (see §4 for full detail)

Three IIFE sections plus inline init code:
1. **Inline boot** (top) — `$` / `$$` selectors, `toast()`, `jsonFetch()`, `loadHealth()`, `renderCard()`, `loadGraduations()`, `handleAction()`.
2. **`initGraphPanel`** (L165–800) — the 2.5D force-directed knowledge graph renderer.
3. **`liveChrome`** (L803) — live clock + timezone in the footer.
4. **`initSettings`** (L850) — the `localStorage` settings drawer.

---

## 4. The GUI Layer — M8.2 Modular Architecture

### 4.1 Why M8.2 Exists

Sessions 22–37 of the SCM development arc shipped a 703-line `DASHBOARD_HTML` monolith inlined into `src/gui/server.ts`. That was unmaintainable: any CSS tweak required rebuilding the TS bundle, and the operator had no way to author HTML/CSS/JS independently of the server. **M8.2 (SCM-S38-D1, GLOBAL pattern `SCM-S38-P1`)** replaced that monolith with three separate operator-authored assets — `index.html`, `style.css`, `app.js` — served via the zero-dep `serveStatic` helper.

### 4.2 The Five Pillars of `SCM-S38-P1`

1. **`import.meta.url`-resolved `PUBLIC_DIR`.** Works under both `tsx` (dev) and packaged `dist/` (post-build). No `__dirname` (ESM-incompatible) and no hard-coded relative paths.
2. **`fs.cpSync(src, dest, {recursive: true, force: true})` build copy.** `scripts/copy-gui-public.ts` (54 lines, zero deps) chains after `tsc` in the `npm run build` pipeline. Mirrors `src/gui/public/` → `dist/gui/public/`. The npm tarball ships exactly the operator-authored bytes.
3. **URI-decoded `path.relative` traversal guard.** `%2E%2E%2F`-style encoded `../` patterns can't slip past — `serveStatic` decodes BEFORE the relative-path check.
4. **Static-stays-open with token enabled.** `/api/*` requires auth (except `/api/health`); static `/`, `/index.html`, `/style.css`, `/app.js` stay public. An operator can show the dashboard to a stakeholder without giving them the bearer token.
5. **Google-Fonts-scoped CSP relaxation.** The CSP header allows `fonts.googleapis.com` + `fonts.gstatic.com` but nothing else. No inline `<script>` execution allowed (the only `<script>` tag points at `/app.js`).

### 4.3 The 2.5D Knowledge-Graph Explorer (`app.js` `initGraphPanel` IIFE)

The marquee feature — and the longest IIFE in the file. Implements a live force-directed simulation that renders the `kg_hybrid_search` output as an interactive SVG.

**Layout & physics:**
- `seedLayout(ns)` (L364) — places nodes on a Fibonacci-spiral seed so the sim starts from a non-degenerate state.
- `simStep()` (L375) — one pass of the Verlet-style integrator: repulsion between every node pair (Coulomb), spring force along every edge (Hooke), velocity damping. Tracks `temp` (sim energy) for the HUD.
- `tick(ts)` (L453) — `requestAnimationFrame` loop that calls `simStep` until `temp < threshold`, then idles.
- `reheat(amount)` (L475) — adds kinetic energy when the user interacts (drag, filter change, reload).
- `kickSim()` (L469) — schedules the next animation frame.

**Rendering:**
- `buildDefs()` (L297) — generates `<defs>` with per-type radial gradients (the "2.5D" look — each node has a highlight + shadow gradient that suggests a sphere).
- `paletteFor(type)` (L225) — color per node-type (MEMORY, FILE, DECISION, SKILL, ERROR, PATTERN).
- `radiusForType(type)` (L217) — size per node-type.
- `buildNodeGroup(node)` (L521) — assembles the `<g>` for one node: shadow ellipse + gradient sphere + label. Attaches `pointerenter/leave/down/move/up` for hover + drag interactions.
- `render(graph)` (L634) — top-level renderer; clears SVG, calls `seedLayout` if first paint, then `kickSim`.
- `paint()` (L436) — per-frame DOM updates: transforms each `<g>` to its current `(x,y)` from the sim state.
- `applyTransform()` (L266) — applies the global pan+zoom matrix to the SVG viewport.

**Interaction:**
- Pan: `pointerdown` on SVG (not on a node) → track delta → `applyTransform`.
- Zoom: scroll-wheel → `zoomBy(factor)` (L757); or buttons `#g-zoom-in/out/fit`.
- Drag: `pointerdown` on a node → pin the node → `pointermove` updates its position → `pointerup` releases.
- Click: tiny-movement `pointerup` → `showDetail(node)` (L348) → populates the `#graph-detail` drawer with node label/type/properties.
- `setHover(nodeId)` (L481) — highlights the hovered node + dims unrelated ones.

**Data flow:**
- `loadGraph()` (L776) → `jsonFetch('/api/graph?project_id=...&node_limit=...&edge_limit=...&type=...')` → `render(json)` → SVG repaints. Triggered by `#g-reload` click, by filter changes, and at panel init.

### 4.4 The `localStorage` Settings Drawer (`app.js` `initSettings` IIFE, L849)

Persists all operator preferences under a single key — `localStorage["scm.settings"]` — serialized as JSON.

**Keys persisted:**
- `timezone` — `'local'` | `'utc'` | named tz string. Drives `liveChrome` clock display.
- `refresh` — auto-refresh interval in ms (default 30 000).
- `theme` — color theme variant.
- `nodeSize` / `edgeThickness` — graph-renderer multipliers, applied as CSS custom properties via `applyVisuals()`.
- `motion` — `'on'` | `'reduced'` — adds `data-motion="reduced"` to `<html>` so CSS can disable animations.
- `clock` — `'on'` | `'off'` for the footer clock visibility.

**The lifecycle:**
1. `load()` (L864) reads `localStorage.getItem(KEY)`, parses, merges with defaults.
2. On any drawer input change, `save(s)` writes back to localStorage AND calls `applyAll()`.
3. `applyAll()` (L900) fans out to `applyAutoRefresh()` (resets the polling timer), `applyVisuals()` (sets CSS custom properties on `<html>`), `applyClock()` (toggles the footer clock).
4. `setRangeFill(input)` (L907) computes the percent-fill on `<input type="range">` and sets a CSS variable so the track-fill gradient updates as the user drags.
5. `fmtNodeSize(v)` / `fmtEdgeThickness(v)` (L912ish) — display formatters that turn `0.75` → `"0.75×"` etc.

The settings object is also exposed as `window.SCM_SETTINGS` so other IIFEs (e.g., `liveChrome`) can read live values without re-parsing localStorage.

### 4.5 Vanilla-JS Structure (No Build Step)

Every file ships as-is. No bundler. No transpiler. No framework. The entire SPA is **3 files / 102 kB unminified**:

| File | Lines | Bytes (raw) | Bytes (gzip est.) |
|---|---|---|---|
| `index.html` | 262 | 12 446 | ~3 800 |
| `style.css` | 1 483 | 48 680 | ~10 000 |
| `app.js` | 1 012 | 40 868 | ~12 000 |
| **Total** | **2 757** | **101 994** | **~26 000** |

This matters because the operator can edit any of these in-place during a live `npm run gui` session, refresh the browser, and see changes instantly. The build copy step is the only mechanism that brings them into the npm-published tarball.

---

### 3.12 `scripts/` migrations + tooling (~22)

#### SQL migrations (21 files, `001_schema.sql` → `020_knowledge_graph.sql`)

Idempotent — each begins with `CREATE TABLE IF NOT EXISTS …` / `CREATE INDEX IF NOT EXISTS …` / `CREATE OR REPLACE FUNCTION …` and ends with a row inserted into `schema_migrations`. Applied in order by `src/lib/migrations.ts` on first boot. Highlights:

| Migration | What it adds |
|---|---|
| `001_schema.sql` | `vector` extension + `memory_chunks(id, content, embedding vector(768), metadata jsonb)` + HNSW index on `embedding` + base `match_memory_chunks` RPC. |
| `002_multi_project.sql` | `memory_chunks.project_id text not null` + tenant-scoped variant of the RPC. |
| `003_file_hash.sql` | `memory_chunks.file_hash text` + `file_origin text` — the incremental-sync skip check. |
| `004_backlog_frozen.sql` | `cloud_backlog` + `frozen_patterns` tables. |
| `005_archive_backlog.sql` | `archive_backlog` history table (replaces delete-based pruning with persistent archive). |
| `006_security_hardening.sql` | RLS deny-all on `cloud_backlog`, `frozen_patterns`, `archive_backlog` — only service-role can read/write. Addresses Supabase Security Advisor errors. |
| `007_metadata_typed_retrieval.sql` | `GIN(jsonb_path_ops)` index on `metadata` + typed-filter `match_memory_chunks_typed` RPC. |
| `008_global_scope.sql` | Reserved `project_id='GLOBAL'` + 6-arg dual-scope `match_memory_chunks` RPC accepting `p_include_global boolean`. |
| `009_fix_rpc_dual_scope.sql` | Planner-friendly IN-form rewrite of the dual-scope WHERE clause (v2.0.0-rc1 hotfix). |
| `010_agent_skills.sql` | `agent_skills` table — the curated skill catalog. |
| `011_trajectory_compaction.sql` | `trajectory_summaries(source_chunk_id, summary, source_tokens, summary_tokens)`. |
| `012_sleep_learning.sql` | `skill_candidates` table — the Sleep Learner's proposed-skill queue. |
| `013_archive_backlog_chunk_link.sql` | `archive_backlog.chunk_id` FK back to `memory_chunks` for join queries. |
| `014_workflow_checkpoints.sql` | `workflow_checkpoints` table + `terminal_committed_checkpoint` recursive-CTE function. |
| `015_curriculum_tasks.sql` | `curriculum_tasks` queue with `kind enum`, `state enum`, row-level `FOR UPDATE SKIP LOCKED` semantics. |
| `016_daemon_telemetry.sql` | `daemon_telemetry(daemon, event, ts, duration_ms, error_message, payload jsonb)` append-only event log. |
| `017_explicit_service_role_grants.sql` | Tightens grants — only service-role has DML rights on memory tables. |
| `017_skill_graduations.sql` | `skill_graduations` 3-state machine + atomic `apply_graduation` RPC for cloning into `'GLOBAL'`. |
| `018_telemetry_retention.sql` | Retention policy hooks for the telemetry pruner. |
| `019_telemetry_graduation_daemon.sql` | Telemetry rows for the graduation daemon specifically. |
| `020_knowledge_graph.sql` | `kg_nodes(id, type, label, source_chunk_id, properties jsonb)` + `kg_edges(from, to, type, weight, properties)` + hybrid-search RPC. |

#### `scripts/apply-schema.ts` · 89 lines · **Manual migration runner**

`npm run schema` entry point — same logic as `src/lib/migrations.ts` but exposed as a CLI. Useful for first-time setup or recovery when the embedded auto-apply path failed.

#### `scripts/copy-gui-public.ts` · 54 lines · **GUI build copy step**

Mirrors `src/gui/public/` → `dist/gui/public/` via `fs.cpSync(src, dest, {recursive: true, force: true})`. Chained as the last step of `npm run build` (after `lint:boundaries` + `tsc`). Zero dependencies.

#### `scripts/lint-boundaries.ts` · 160 lines · **CI fence for Boundary Invariant #1**

Reads every `.ts` file under `src/sleep/`, `src/curriculum/`, `src/graduation/`. Greps for: imports of `ollama`, `anthropic`, `openai`, `@anthropic-ai/*`; calls to `fetch(...)` against LLM endpoints; references to env vars like `OLLAMA_HOST` in a way that implies a generate call. Fails the build if anything matches. The first step of `npm run build`.

#### `scripts/backup-and-remove.ts` · 62 lines · **Archive + delete `.md` files in `MEMORY_ROOTS`**

Operator-run cleanup script. Archives matching `.md` files into `backups/<timestamp>/` (`archiver` npm dep), then removes the originals. Used after a vector-side sync confirms the local source is no longer needed.

#### `scripts/backfill-ledger.ts` · 51 lines · **Historical ledger rebuild**

One-off: walks `archive_backlog` rows that pre-date `013_archive_backlog_chunk_link.sql` and backfills the `chunk_id` foreign key.

#### `scripts/purge-samia-rules.ts` · 21 lines · **One-off scrub (legacy)**

Removes pre-v2 personal-rule artifacts. Kept for historical reproducibility.

#### `scripts/e2e-test.ts` · 53 lines · **End-to-end smoke**

Wires up: temp project root → init_project → sync_local_memory on a fixture → search_memory → save_memory → search again → prune. Runs in CI.

#### `scripts/e2e-incremental-test.ts` · 82 lines · **Hash-gate + force + orphans**

Specifically exercises `sync_local_memory`'s incremental path: edits a fixture file, re-syncs, confirms only changed chunks re-embed. Tests `force:true` re-embed and orphan auto-purge.

#### `scripts/e2e-isolation-test.ts` · 65 lines · **Multi-project isolation gate**

Spawns two project roots back-to-back, confirms `memory_chunks` rows are tenant-isolated (project A can't see project B's chunks).

#### `scripts/smoke-008.ts` · 67 lines · **Migration-008 smoke (dual-scope match RPC)**

Verifies the 6-arg `match_memory_chunks` returns project-only rows when `include_global:false` and project ∪ GLOBAL when `:true`.

#### `scripts/smoke-010.ts` · 329 lines · **Migration-010 smoke (`agent_skills`)**

Wires up the full agent-skills CRUD: insert → search → update success_rate → graduate.

#### `scripts/smoke-012.ts` · 361 lines · **Migration-012 smoke (sleep learning)**

Seeds fake trajectory summaries, runs `runSleepLearnerOnce`, asserts candidate stubs land in `skill_candidates`.

#### `scripts/verify-007.ts` / `verify-008.ts` · ~50 lines each · **Pre-flight verifiers**

Standalone scripts that connect to Supabase and confirm the relevant migration is applied (used by CI smoke jobs).

---

### 3.13 `hooks/` policy enforcer (2)

#### `hooks/md-policy.py` · 489 lines · **PreToolUse policy enforcer (Python)**

The Python script Claude Code runs before every `Write` / `Edit` / `Bash` tool call. Reads JSON from stdin (`{tool_name, tool_input, ...}`), evaluates four invariants, exits `0` (allow) or `2` (block with reason).

**The four invariants:**

1. **Zero-Local-MD** — only `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` allowed at project root. Configured via `CLAUDE_MD_POLICY_ALLOW_ROOT_MD` (comma-separated).
2. **750-Line Hard Limit** — blocks `Write` that would push a file past `SMART_CLAUDE_MEMORY_LINE_LIMIT` (default 750). Files already over the limit are **grandfathered** — `Edit` is still allowed, with a warning banner. Auto-generated paths (`types.ts`, `*.g.dart`, `*.freezed.dart`, `*.arb`) are exempt.
3. **Frozen Features** — for files matching configured patterns (from `~/.claude-memory/frozen-patterns.json` + `SMART_CLAUDE_MEMORY_FROZEN_PATTERNS` env), block `Write` (Edit only). Patterns are substring matches against the file path.
4. **Manual Test Gate** — if `~/.claude-memory/verification-pending.json` exists, block ALL `Write`/`Edit`/`Bash` regardless of path until `confirm_verification` clears it.

**Env contract:**
- `CLAUDE_MD_POLICY_WORKSPACE` — project root (required for the MD rule).
- `CLAUDE_MD_POLICY_ALLOW_ROOT_MD` — allowlist override.
- `CLAUDE_MD_POLICY_TOKEN_LIMIT` — soft 3000-token cap on `CLAUDE.md` / `MEMORY.md`.
- `SMART_CLAUDE_MEMORY_GATE_DIR` — flag-file dir (default `~/.claude-memory`).
- `SMART_CLAUDE_MEMORY_LINE_LIMIT` — line-cap override.
- `SMART_CLAUDE_MEMORY_FROZEN_PATTERNS` — comma-separated extra patterns.
- `SMART_CLAUDE_MEMORY_ORCHESTRATOR_MODE` — if set, hard-block direct `Write`/`Edit`/`Bash` in the Orchestrator session (delegation-only mode).

Legacy `CLAUDE_MEMORY_*` env names are honored as a one-time fallback; removal targeted for v1.2.0.

#### `hooks/README.md` · ~50 lines · **Hook installation notes**

Documents how Claude Code's hook system invokes the Python script (registered in `~/.claude/settings.json` under the `pretooluse` slot), how to install Python on Windows/macOS/Linux, and how to debug a misbehaving hook (`SMART_CLAUDE_MEMORY_DEBUG=1` opens a JSON trace at `~/.claude-memory/hook-debug.log`).

---

### 3.14 `tests/` test suites (~21)

Run via `npm test` (which uses `tsx` to run all `.test.ts` directly). 246/246 pass across 21 files.

| Test file | Coverage |
|---|---|
| `capabilities.test.ts` | The `init_project` capabilities envelope (protocol version, taxonomy, context-gathering hints). |
| `checkpoint.test.ts` | `workflow_checkpoints` state machine + recursive-CTE terminal-committed lookup. |
| `curriculum-consumer.test.ts` | Worker-side: `pull_curriculum_task` SKIP-LOCKED behavior + `apply_curriculum_task` atomic auto-promote. |
| `curriculum-scanner.test.ts` | All three scans — test-gap, rollback-hotspot, stale-candidate — produce the expected `curriculum_tasks` rows. |
| `graduation-daemon.test.ts` | Daemon loop emits telemetry, the 3-threshold filter on `agent_skills`, frozen telemetry snapshot. |
| `graduation-handlers.test.ts` | The full lifecycle: `compose_global_rationale` → `confirm_promotion` (atomic clone-to-GLOBAL) → `reject_graduation`. 624 lines — the largest test file. |
| `graduation-scanner.test.ts` | `findGraduationCandidates` threshold math. |
| `graph-daemon.test.ts` | Graph extractor tick, telemetry, `derived.status` transitions. |
| `graph-extractor.test.ts` | `extractFromChunk` regex patterns (FILE / DECISION / SKILL / PATTERN reference mining). |
| `gui.test.ts` | All routes on `src/gui/server.ts` — health, listing, mutation, token auth, MIME, traversal guard. 408 lines. |
| `gui-graph.test.ts` | `/api/graph` integration — node/edge fetch, filter behavior, limit enforcement. |
| `health.test.ts` | `deriveDaemonStatus` matrix — healthy / degraded / down / pending across all daemons. |
| `kg.test.ts` | `kg_upsert_node` / `kg_upsert_edge` / `kg_hybrid_search` — including edge-depth traversal correctness. 429 lines. |
| `list-global-patterns.test.ts` | Browse-only GLOBAL vault — filter, paginate, include_content toggle. |
| `migrations.test.ts` | Every migration applies idempotently on a fresh database, then re-applying is a no-op. |
| `orchestrator.test.ts` | `delegate_task` happy path + sub-agent isolation + `sync_artefacts` post-run. |
| `prune.test.ts` | `prune_memory` explicit-paths gate, protected-file refusal, transactional all-or-nothing delete. |
| `search-graph-rag.test.ts` | Hybrid search — semantic vector match composed with graph edge traversal. |
| `trajectory-daemon.test.ts` | Compactor tick, candidate-selection threshold, telemetry. |
| `trajectory-stripper.test.ts` | Each stripper transformation (JSON collapse, stack-trace truncation, dedupe, noise strip). |
| `trajectory-summarizer.test.ts` | Summarizer with mocked Ollama, abort-signal behavior. |

#### `tests/fixtures/`

- `m4.ts` (352 lines) — fixture helpers for workflow-checkpoint tests (build chains, simulate rollback signals).
- `prune.ts` (61 lines) — temp-project + temp-chunk fixtures for prune tests.

#### `tests/sql_fixtures/`

- `006_smoke.sql` — small SQL file used by `006_security_hardening.sql` smoke tests to verify RLS deny-all actually denies the right roles.

---

## 5. Appendix — Glossary

| Term | Meaning |
|---|---|
| **SCM** | Smart-Claude-Memory MCP plugin. |
| **Core 3** | `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` — the only `.md` files allowed at project root. |
| **Sovereign Memory Protocol** | The hash-registered protocol block embedded in every project's `CLAUDE.md` (currently v2.1.7). |
| **Sovereign Vetting** | Server-side rejection of `is_global:true` writes lacking a ≥10-char `global_rationale`. Cross-Project Test required. |
| **GLOBAL Vault** | Reserved `project_id='GLOBAL'` tenant for universal patterns visible to every project. |
| **Boundary Invariant #1** | "Single Brain" — daemons under `src/sleep/**`, `src/curriculum/**`, `src/graduation/**` MUST NOT import LLMs. CI-fenced via `lint:boundaries`. |
| **DECISION ID** | `SCM-S<N>-D<i>` — session N, decision i. Tagged at the top of `save_memory.content` for DECISION-typed rows. |
| **Frozen Pattern** | A file path or substring that the policy hook blocks `Write` on (Edit-only). Cached locally + cloud-replicated. |
| **Verification Gate** | The `verification-pending.json` flag file in `~/.claude-memory/` that blocks all Write/Edit/Bash until cleared. |
| **Master Schematic** | The PNG at `docs/assets/schematic.png` referenced in ARCHITECTURE.md as the visual reference for the v2.2.x baseline. |
| **AgentDiet** | The trajectory-compaction subsystem (M2) — strips and summarizes oversized chunks. |
| **Sleep Learning** | The skill-mining subsystem (M3) — proposes `skill_candidates` from clustered trajectories. |
| **Curriculum** | The deterministic queuer (M5) — files `curriculum_tasks` for the Orchestrator to verify. |
| **Graduation** | The 3-state human-gated lifecycle (M7) that promotes per-project skills into the GLOBAL Vault. |
| **Knowledge Graph** | The `kg_nodes`/`kg_edges` graph mined by the Graph Extractor daemon (M8.1), visualized by the 2.5D SVG explorer (M8.2). |

---

*— end of dossier —*
