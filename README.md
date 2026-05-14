<div align="center">

# Smart Claude Memory

![Smart Claude Memory v2.1.0 Master Schematic](docs/assets/schematic.png)

*Master schematic — the definitive visual reference for the Smart Claude Memory v2.1.0 production baseline.*

**Hybrid cloud-local memory for Claude — semantic retrieval instead of context bloat.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29+-6e56cf)](https://modelcontextprotocol.io/)
[![pgvector](https://img.shields.io/badge/pgvector-HNSW-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Ollama](https://img.shields.io/badge/Ollama-local%20embeddings-000)](https://ollama.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Version](https://img.shields.io/badge/version-2.0.0--rc1-green)](#)
[![Developer](https://img.shields.io/badge/developer-NABILNET.AI-6e56cf?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyTDIgNy4xN0wxMiAxMi4zM0wyMiA3LjE3WiIvPjwvc3ZnPg==)](https://nabilnet.ai)

**Developed by [NABILNET.AI](https://nabilnet.ai)**

</div>

---

## The problem

Claude sessions load `memory.md`, `rules.md`, `cloud.md`, and a dozen other context files at startup. Every token you spend on "what does this project do" is a token you can't spend on the actual task. At scale, you end up burning budget re-reading the same notes hundreds of times per week.

## What this does

`smart-claude-memory` is a **Model Context Protocol server** that replaces "read every .md at startup" with "search them on demand." It chunks your markdown notes, embeds them with a local Ollama model, stores them in Supabase (pgvector), and exposes **twenty-two tools** to Claude spanning memory, vision, backlog, hygiene, orchestration, and system health. The elevator pitch:

| Tool | Purpose |
|---|---|
| `sync_local_memory` | Scan folders → **MD5 hash-gate** → chunk → embed → **bulk upsert**. Skips unchanged files. |
| `search_memory` | Semantic search + intent routing (archive / backlog / semantic) |
| `manage_backlog` | Per-project task handover with persistent archive |

See the [Toolbox](#toolbox) for the complete surface and [ARCHITECTURE.md](ARCHITECTURE.md) for the request-flow diagram.

Memory is strictly **per-project**: when you're in project A, Claude cannot see project B's notes. See [Multi-project isolation](#multi-project-isolation).

---

## System Architecture

The system operates under the Sovereign Orchestrator pattern with Autonomous Self-Healing. The diagrams below are mirrored from [ARCHITECTURE.md](ARCHITECTURE.md), which remains the canonical source of truth.

**Two independent planes by design:**

- **Local plane — Ollama.** Every byte of your notes is embedded on your own machine. Content never leaves your device in plaintext for vectorization. No per-token API fees, no third-party seeing your prompts.
- **Cloud plane — Supabase.** Durable storage, indexable across devices, cheap. Only the vectors + the source text live here — and only the text you explicitly choose to sync.

You get the privacy posture of local inference with the durability and cross-machine access of a managed Postgres.

### Delegation Flow

```mermaid
flowchart TD
    subgraph ORC["Orchestrator (Main Session) — strategic context only"]
        U[User request]
        D[delegate_task]
        S[sync_artefacts]
        R[Report 2-para synthesis to user]
    end

    subgraph WRK["Background Worker (Isolated context)"]
        E[Edits / Bash / Research]
        G[refactor_guard gate]
        H{Gate OK?}
        HL[Self-Healing Loop]
        RB[refactor_guard rollback]
        SY[Emit 2-para synthesis]
    end

    U --> D
    D -->|canonical worker prompt| E
    E --> G
    G --> H
    H -->|pass| SY
    H -->|fail| HL
    HL -->|healed| G
    HL -->|exhausted| RB
    RB --> SY
    SY -->|only synthesis returns| S
    S --> R
```

### Autonomous Self-Healing Loop

```mermaid
flowchart LR
    G1[refactor_guard gate] -->|pass| DONE([Emit synthesis])
    G1 -->|fail| AR[analyze_regression<br/>file + backups_to_compare]
    AR --> CP[closest_prior backup<br/>smallest edit distance]
    CP --> LF[Minimal local fix<br/>preserves feature intent]
    LF --> G2[refactor_guard gate]
    G2 -->|pass| DONE
    G2 -->|fail and attempts lt max| NEXT[Change hypothesis]
    NEXT --> AR
    G2 -->|attempts equal max| RBK[refactor_guard rollback]
    RBK --> DONE
```

### Multi-Stack Compiler Map

```mermaid
flowchart TB
    P[Project root] --> D{Detect stack}
    D -->|package.json + tsconfig.json| TS[tsc --noEmit]
    D -->|package.json only| NODE[npm run build / lint]
    D -->|pubspec.yaml| FL[flutter analyze / dart analyze]
    D -->|Cargo.toml| RS[cargo check]
    D -->|pyproject.toml| PY[mypy / ruff]
    D -->|go.mod| GO[go vet / go build]
    TS --> OUT[Exit code + summarized output]
    NODE --> OUT
    FL --> OUT
    RS --> OUT
    PY --> OUT
    GO --> OUT
```

> See [ARCHITECTURE.md](ARCHITECTURE.md) for the full prose + §4 auto-generated file-tree + §5 version history.

---

## Multi-project isolation

Every chunk is tagged with a `project_id`. The MCP server auto-derives it from the **slugified basename of the current working directory** at startup:

```
C:\Users\you\repos\acme-api       → project_id = "acme-api"
~/code/side-projects/note-taker   → project_id = "note-taker"
```

The SQL function `match_memory_chunks` enforces the filter **at the database layer** — not just in application code:

```sql
where m.project_id = p_project_id
```

Concretely: when you `cd` into `acme-api/` and launch Claude, calls to `search_memory` **cannot** return rows tagged `note-taker`. This is verified by [scripts/e2e-isolation-test.ts](scripts/e2e-isolation-test.ts), which seeds both projects with the same file name and proves zero cross-talk.

Need to reach into another project on purpose? Pass `project_id` explicitly:

```
search_memory({ query: "auth flow", project_id: "acme-api" })
```

---

## Toolbox

| Tool | Category | Summary |
|---|---|---|
| `sync_local_memory` | Memory | Hash-gated incremental sync of `.md` files; bulk upsert in 100-chunk batches; `force` re-embed; `auto_purge` with dry-run + verify-before-delete |
| `search_memory` | Memory | Intent routing — `archive` > `backlog` > `semantic`. Optional `metadata_filter` (e.g. `{ "type": "DECISION" }`) narrows via the GIN index before vector similarity. **Dual-scope by default (v2.0.0-rc1):** searches across the current project AND the reserved `'GLOBAL'` vault; pass `include_global: false` to restrict to the current project. Archive tasks never leak into vector results unless requested. |
| `save_memory` | Memory | Save a typed memory chunk — embed via Ollama, upsert with `metadata.type` from the Sovereign Taxonomy (`DECISION` / `PATTERN` / `ERROR` / `LOG`). v2 canonical write path. **v2.0.0-rc1:** set `metadata.is_global: true` to route the row to the reserved `project_id: 'GLOBAL'` vault for cross-project visibility. **Sovereign Vetting:** when `is_global: true`, you MUST also supply `metadata.global_rationale` and the memory must pass the Cross-Project Test (Rule 10). |
| `summarize_memory_file` | Memory | LLM-driven compression of `CLAUDE.md` / `MEMORY.md` toward a token target (default 3000) |
| `manage_backlog` | Backlog | `add` / `list` / `update` / `prune_done` (archives) / `archive_list` / `session_end` with Progress Report + resume prompt |
| `index_image` | Vision | Moondream caption → `nomic-embed-text` embed → upsert. Auto-converts WebP/GIF/BMP via ffmpeg. |
| `check_code_hygiene` | Guardian | 750-line rule with auto-generated file exclusions; N-split refactor plan for oversized files |
| `check_rule_conflicts` | Guardian | Opt-in LLM-based intent conflict detection between a proposed change and retrieved rules |
| `raise_verification_gate` | Guardian | Arm the Hard Stop flag after a risky edit |
| `confirm_verification` | Guardian | Clear or reassert the Hard Stop gate — Claude must call this after manual verification |
| `check_system_health` | Ops | Supabase reachability (memory_chunks count) + Ollama reachability + required-model presence (moondream, nomic-embed-text) + background keep-alive state |
| `init_project` | Ops | Readiness report for a workspace: required env vars, md-policy.py hook, MCP registration in settings, compiled dist. Also runs a **smart-scout pass** over `.claude/rules/*.md` and emits a `recommendations.hydrate_policies` block with batch-hydration candidates when any are found (key omitted entirely otherwise). Returns `ready` / `partial` / `not_ready` with fix instructions per check. |
| `batch_freeze_patterns` | Guardian | Bulk-hydrate the frozen-pattern cache from globs or a `## Frozen Patterns` markdown section in a rule file. Strict line-by-line extraction, atomic writes, dedup with first-writer-wins, optional `dry_run`. |
| `list_frozen` | Guardian | List all frozen pattern entries for the current project (returns `pattern`, `source`, `added_at`). Use before touching any structural-looking file. |
| `freeze_file` | Guardian | Add a path or pattern to the frozen-pattern cache so future `Write` (full replacement) on matching files is hard-blocked by the hook. |
| `unfreeze_file` | Guardian | Remove a path or pattern from the frozen-pattern cache. |
| `sweep_legacy_backups` | Ops | Move stray `backup-*` / `*.bak` artefacts into a timestamped quarantine folder. Defaults to `dry_run`; HIGH-confidence files only unless `aggressive: true`. |
| `refactor_guard` | Guardian | Single source of compile truth — auto-detects stack and runs the native gate (`tsc --noEmit`, `flutter analyze`, `cargo check`, …). Also exposes `rollback` for last-resort recovery. |
| `analyze_regression` | Guardian | Diffs the current file against recent backups and surfaces the `closest_prior` snapshot to guide the minimal local fix during the self-healing loop. |
| `delegate_task` | Orchestrator | Emit a canonical worker sub-agent prompt — the worker does the edit → `refactor_guard` gate → up to 3 self-heal attempts → returns only a 2-paragraph synthesis. Backbone of the Sovereign Orchestrator pattern. |
| `sync_artefacts` | Orchestrator | Refresh `README.md` Recent Progress + the marker-bounded Mermaid block in `ARCHITECTURE.md` + `project_file_architecture.md` after a worker reports success. Doc-only subset of `manage_backlog({ action: "session_end" })`. |

**Companion hook:** [hooks/md-policy.py](hooks/md-policy.py) enforces Zero-Local-MD allowlist, 750-line ceiling, frozen-feature patterns, and the Manual Test Gate from the Claude Code `PreToolUse` layer. Without it the Guardian tools are advisory; with it they are binding.

---

## Living Documentation

`manage_backlog({ action: "session_end" })` writes **two** artefacts into the project on every call, in parallel, so the repo self-documents without manual effort:

### 1. README progress log → `README.md`

1. Archives completed tasks (atomic PL/pgSQL transaction into `archive_backlog`).
2. Pulls the last 5 archived rows via `listArchive`.
3. Replaces the `### 🚀 Recent Progress

* [DONE] [OBS-EPIC] Telemetry retention policy (rolling window for daemon_telemetry) (archived at 2026-05-14).
* [DONE] [OBS-EPIC] Aggregate per-chunk token counters in compactor state for richer telemetry (archived at 2026-05-14).
* [DONE] [FOUNDATION-FIX] Explicit service_role grants for May 30 Supabase compliance (archived at 2026-05-13).
* [DONE] [OBS-EPIC] Metrics schema + persistence layer (telemetry table + TS types) (archived at 2026-05-13).
* [DONE] [OBS-EPIC] Instrument 3 daemons with structured metric emit (archived at 2026-05-13).
### 🚀 Recent Progress

* [DONE] Fix login form validation (archived at 2026-04-24).
* [DONE] Add cache invalidation hook (archived at 2026-04-23).
...
```

### 2. Architecture map → `project_file_architecture.md`

1. Walks the project tree (cwd), ignoring `node_modules`, `.git`, `dist`, `build`, `backups`, and friends.
2. Caps depth at 3 and children per folder at 25; overflows show as `… (N more)`.
3. Renders a Mermaid `flowchart TD` — GitHub renders it natively in the doc.
4. Replaces only the `mermaid` fenced block; any human prose in the file is left intact. Creates the file with a professional header on first run.

### Safety rails (shared)

- If the MCP server's `cwd` slug doesn't match the `session_end` `project_id`, **both syncs are skipped** with an explicit warning — neither artefact is written into the wrong repo.
- Failures surface as `warning` fields in `readme_sync` / `architecture_sync`; the archive + resume-prompt logic always completes.
- Hook allowlist includes `README.md`; `project_file_architecture.md` is not on it — make sure your Zero-Local-MD allowlist covers it too (`CLAUDE_MD_POLICY_ALLOW_ROOT_MD="CLAUDE.md,MEMORY.md,README.md,project_file_architecture.md"`).

Net effect: every session leaves a timestamped handover note and a current file-tree diagram in the repo.

---

## Incremental sync (v0.3.0)

For corpora with thousands of files, re-embedding on every call is wasteful. `sync_local_memory` now runs a **hash-gated** pipeline:

1. Snapshot `Map<file_origin, file_hash>` for the current `project_id` in one paginated SELECT.
2. For each local file, compute MD5 **before** chunking or embedding.
3. If the hash matches the DB, skip — zero Ollama calls, zero writes.
4. If it differs (or is new), chunk + embed and buffer the rows.
5. Flush in batches of 100 chunks per upsert to minimize round-trips.
6. If a file is gone locally but still in the DB, it's reported in `orphan_files` (not auto-pruned).

Measured on this repo's own README (28 chunks, single file):

| Run | Behavior | Time | Ollama calls |
|---|---|---|---|
| Cold sync | Embed + upsert | **~3.7 s** | 28 |
| Unchanged rerun | All skip | **~0.3 s** | **0** |
| One file modified | Skip N−1, re-embed 1 | proportional to the delta | 1 file's worth |

### Output shape

```json
{
  "project_id": "acme-api",
  "force": false,
  "scanned": 812,
  "skipped": 806,
  "added": 3,
  "updated": 3,
  "orphans": 1,
  "orphan_files": ["/abs/path/legacy.md"],
  "chunks_upserted": 47,
  "chunks_deleted": 21,
  "ms": 1840
}
```

### Force re-embed

Pass `force: true` to bypass the skip gate. Pre-existing files are still correctly classified as `updated` (not `added`) and their stale chunks are purged before re-insert — critical when a file shrinks.

```
sync_local_memory({ force: true })
```

Verified by [scripts/e2e-incremental-test.ts](scripts/e2e-incremental-test.ts), which walks five phases: cold, rerun, modify+add+delete, force, and row-shape integrity.

---

## Install (3 steps, ~5 minutes)

### 1. Install the plugin from the marketplace

In Claude Code, open the plugin marketplace and install **smart-claude-memory** (or, while the marketplace listing is being prepared, clone this repo and `claude plugin add <path>` it locally). The plugin manifest at `.claude-plugin/plugin.json` auto-wires both the MCP server and the `md-policy.py` PreToolUse hook. **No `~/.claude.json` or `~/.claude/settings.json` edits required.**

### 2. Create an empty Supabase project + Ollama models

- Create a free Supabase project at [supabase.com](https://supabase.com).
- Install [Ollama](https://ollama.com/) and pull the two required models:

```bash
ollama pull moondream
ollama pull nomic-embed-text
```

### 3. Set 3 env vars in your project's `.env`

```env
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SECRET_KEY=<service-role-key>
SUPABASE_POOLER_URL=postgres://postgres:<password>@<pooler-host>:6543/postgres
```

Then call `init_project()` from Claude Code. The plugin **auto-applies all 18 schema migrations** to your empty DB on the first call, verifies your Ollama models are pulled, and reports `overall: pending → healthy` within a few minutes. Zero manual `npm run schema`, zero hand-edited settings.

### Optional env vars

| Name | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBED_DIM` | `768` | Embedding vector dimension |
| `MEMORY_ROOTS` | (empty) | Semicolon-separated folders to sync |

> **Why a pooler URL?** Supabase's `db.<ref>.supabase.co` endpoint is **IPv6-only** on projects created after early 2024. If your network doesn't route public IPv6 (most home/office Windows boxes don't), direct connects fail with `ENETUNREACH`. The **transaction pooler** at `aws-1-<region>.pooler.supabase.com:6543` is IPv4-reachable and is what the auto-migration loop uses.

### First-run index your notes

From a Claude Code session inside the project whose notes you want to offload:

```
sync_local_memory()
```

Then free up context by archiving the originals:

```bash
npm run backup                                              # dry run
npx tsx scripts/backup-and-remove.ts --confirm-delete       # zip + delete
```

---

## ⚡ The Golden Startup Prompt

To ensure a seamless, context-efficient, and secure session in any project using this plugin, copy and paste the following prompt as your very first interaction with the agent.

```text
SYSTEM INITIALIZATION:
I am using the `smart-claude-memory` plugin. Follow these standards:
1. **Check Readiness:** Run `init_project` to verify the workspace and health.
2. **Sync State:** Run `sync_local_memory()` to ensure the vector database is up to date with my local notes.
3. **Operate via Tools:** From now on, do NOT read large `.md` files directly. Use `search_memory()` for context retrieval and respect the `md-policy.py` hook for all writes.
4. **Typed Retrieval (v2):** When saving memories use `save_memory` with `metadata.type` from the Sovereign Taxonomy — `DECISION` (architectural choices + rationale), `PATTERN` (code standards + Rule 5–8 enforcement), `ERROR` (bug post-mortems + fixes), or `LOG` (general session progress). When retrieving, narrow `search_memory` with `metadata_filter` (e.g. `{ "type": "DECISION" }`) so the GIN index pre-filters before vector similarity. After updates, run `sync_artefacts` to keep cloud + local aligned.
5. **MANDATORY DELEGATION:** Any read-heavy investigation touching > 3 files OR resulting in > 100 lines of raw output (Grep / Read / Logcat) MUST be delegated via `delegate_task` to a worker. Never flood the main context. Request only the 2-paragraph synthesis.
6. **Initial Sync (Core 3 Audit):** `init_project` (Rule 1) returns a `core3` block reporting on `CLAUDE.md`, `README.md`, and `ARCHITECTURE.md` — the project's three architectural sources of truth. If any is missing, or if `core3.in_sync` is `false`, immediately `delegate_task` a Core-3 audit BEFORE any other work. Request a 2-paragraph synthesis with the proposed reconciliation. The Architecture Guard treats these three files as load-bearing; nothing else proceeds until they agree.
7. **Modular Diagramming:** Mermaid diagrams in `ARCHITECTURE.md` and `README.md` MUST be split into small per-section blocks — one block per `##` subsystem, ≤ ~40 nodes each. GitHub silently fails to render oversized Mermaid graphs; a single monolithic flowchart will appear blank in the rendered view. Never emit one mega-graph. When `manage_backlog({ action: "session_end" })` regenerates the diagram, it produces one block per logical section, not one giant tree.
8. **Session-End Lock & Handoff:** Before ending the session, call `manage_backlog({ action: "session_end" })` to flush the backlog, regenerate the per-section Mermaid diagrams, and run `sync_artefacts` to push state to the cloud. The response includes a `next_session_command_markdown` field — **POST THAT MARKDOWN BLOCK VERBATIM as your final message to chat.** It is a copy-paste-ready boot command (`init_project` + `search_memory` for the Active Backlog + pointer to `docs/NEXT-SESSION-PROMPT.md`) that the user pastes into the next session. This locks a coherent baseline so the next session opens with the Core 3, the diagrams, and the cloud memory all aligned.
9. **Universal Patterns → GLOBAL (v2.0.0-rc1):** Any pattern, lesson-learned, or architectural decision deemed **universal** — applicable across projects, not just this one — MUST be saved with `metadata.is_global: true`. The row is stored under the reserved `project_id: 'GLOBAL'` and surfaces in dual-scope search across every project. Use this to **immunize future projects against known errors** (a bug fixed once never has to be re-discovered). Inverse: do NOT promote project-local context to GLOBAL — the vault loses signal if it becomes a dumping ground.
10. **Sovereign Vetting:** The GLOBAL vault is a high-signal environment. Every global save must pass the **Cross-Project Test**: *if the current project were deleted tomorrow, would this memory still be a gold-standard reference for others?* If no, keep it local. When `metadata.is_global: true`, you **MUST** also include `metadata.global_rationale` — a one- or two-sentence justification of why this memory is a universal truth (not project-specific). Saves that fail the Cross-Project Test pollute the vault and are forbidden. The agent is its own auditor: only Arch-Patterns that apply to ALL projects (universal architectural decisions, multi-project bug fixes) qualify.
```

---

## How `project_id` is derived

[src/project.ts](src/project.ts):

```ts
export function detectProjectId(cwd = process.cwd()): string {
  return slugify(basename(cwd) || "default");
}
```

Captured once at MCP server startup. Claude Code launches an MCP subprocess per session with `cwd` set to the workspace root, so `basename(cwd)` is a stable project identifier for the lifetime of that session.

Collisions are possible if two unrelated projects share a folder name (`utils/`, `backend/`, etc.). To harden, override explicitly:

```
sync_local_memory({ project_id: "acme-backend-prod" })
```

---

## Database schema

```sql
create table memory_chunks (
  id           bigserial primary key,
  content      text not null,
  embedding    vector(768) not null,
  file_origin  text not null,
  chunk_index  int not null default 0,
  content_hash text not null,                  -- MD5 of the chunk text
  file_hash    text,                           -- MD5 of the whole file at last sync (v0.3.0)
  metadata     jsonb not null default '{}'::jsonb,
  project_id   text not null default 'default',
  updated_at   timestamptz not null default now(),
  unique (project_id, file_origin, chunk_index)
);

create index on memory_chunks using hnsw (embedding vector_cosine_ops);
create index on memory_chunks (project_id);
create index on memory_chunks (project_id, file_origin);   -- powers the hash-gate lookup
```

The current 6-arg RPC `match_memory_chunks(query_embedding, p_project_id, match_count, min_similarity, p_metadata_filter, p_include_global)` (introduced by migration 008 and patched in 009 to use the planner-friendly IN-form `WHERE m.project_id IN (p_project_id, CASE WHEN p_include_global THEN 'GLOBAL' END)`) enforces tenancy + the typed-metadata filter + the optional `'GLOBAL'` fan-out, all in SQL — before pgvector ranks the candidate set. The legacy 4-arg form from migration 001 is superseded but left intact in the file for historical reference. All chunks from the same file share one `file_hash`, so the incremental-sync skip check is a single `SELECT file_origin, file_hash WHERE project_id = ?`. Full schema + RPC definitions in [scripts/001_schema.sql](scripts/001_schema.sql), [scripts/002_multi_project.sql](scripts/002_multi_project.sql), [scripts/003_file_hash.sql](scripts/003_file_hash.sql), [scripts/007_metadata_typed_retrieval.sql](scripts/007_metadata_typed_retrieval.sql), [scripts/008_global_scope.sql](scripts/008_global_scope.sql), and [scripts/009_fix_rpc_dual_scope.sql](scripts/009_fix_rpc_dual_scope.sql).

---

## Project layout

```
src/
├── index.ts              MCP server entry — registers all 22 tools
├── config.ts             Env loader (absolute .env path resolution)
├── project.ts            project_id detection + slugification
├── project-detect.ts     Multi-stack project root detection
├── ollama.ts             POST /api/embed client
├── supabase.ts           Table + RPC wrappers + frozen-pattern cache
├── chunker.ts            Markdown-aware splitter
├── verification-gate.ts  Hard-stop verification flag (PreToolUse blocker)
├── version.ts            Version SSOT — re-exports from package.json
└── tools/
    ├── backlog.ts                manage_backlog (add / list / update / prune_done / archive_list / session_end)
    ├── batch-freeze-patterns.ts  batch_freeze_patterns (bulk-hydrate from globs or rule file)
    ├── conflict.ts               check_rule_conflicts
    ├── frozen-cache.ts           Shared loader for the frozen-pattern cache (atomic writes, dedup)
    ├── health.ts                 check_system_health (Supabase + Ollama + keep-alive + orchestrator)
    ├── hygiene.ts                check_code_hygiene (750-line ceiling, N-split refactor plans)
    ├── image.ts                  index_image (Moondream caption → embed → upsert)
    ├── orchestrator.ts           delegate_task + sync_artefacts (Sovereign Orchestrator pattern)
    ├── policy.ts                 list_frozen / freeze_file / unfreeze_file / sweep_legacy_backups
    ├── refactor.ts               refactor_guard (compile gate) + analyze_regression (backup diff)
    ├── save.ts                   save_memory (typed write path with Sovereign Vetting)
    ├── search.ts                 search_memory (intent routing + dual-scope semantic)
    ├── setup.ts                  init_project (readiness checks + smart-scout)
    ├── sovereign-constitution.ts CLAUDE.md Sovereign-binding template + helper
    ├── summarize.ts              summarize_memory_file
    ├── sync.ts                   sync_local_memory (hash-gated incremental)
    └── verification.ts           raise_verification_gate / confirm_verification

scripts/
├── 001_schema.sql                    base table + HNSW index + base RPCs
├── 002_multi_project.sql             project_id + per-project isolation
├── 003_file_hash.sql                 file_hash column for incremental sync
├── 004_backlog_frozen.sql            cloud_backlog + frozen_patterns tables
├── 005_archive_backlog.sql           archive_backlog history table
├── 006_security_hardening.sql        RLS deny-all + service-role-only access
├── 006_smoke.sql                     smoke checks for 006
├── 006_verify.sql                    verifier for 006
├── 007_metadata_typed_retrieval.sql  GIN(jsonb_path_ops) + typed-filter match RPC
├── 008_global_scope.sql              'GLOBAL' project_id + 6-arg dual-scope match RPC
├── 009_fix_rpc_dual_scope.sql        IN-form WHERE planner fix (v2.0.0-rc1 hotfix)
├── apply-schema.ts                   `npm run schema` runner
├── backup-and-remove.ts              archive + delete .md files in MEMORY_ROOTS
├── e2e-test.ts                       end-to-end smoke
├── e2e-isolation-test.ts             multi-project isolation gate
├── e2e-incremental-test.ts           hash-gate / force / orphans
├── purge-samia-rules.ts              one-off scrub (legacy)
├── smoke-008.ts                      smoke for 008 dual-scope
├── verify-007.ts                     verifier for 007 typed retrieval
└── verify-008.ts                     verifier for 008 dual-scope
```

---

## npm scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run dev` | Run the server via `tsx` (no build step) |
| `npm run start` | Run the compiled server |
| `npm run schema` | Apply `001_schema.sql` (or pass `-- <file>` for another) |
| `npm run backup` | Dry-run backup of all `.md` in `MEMORY_ROOTS` |

---

## Design decisions worth knowing

- **Embedding model is load-bearing.** `EMBED_DIM` must match the model's output. Swapping `nomic-embed-text` (768) for `mxbai-embed-large` (1024) means dropping and rebuilding the `embedding` column. Don't mix dimensions.
- **Service-role key, no RLS.** The MCP server runs locally with no user context; it uses `sb_secret_*` which bypasses RLS. If you expose this server to untrusted callers, add RLS plus a `user_id` column.
- **Chunking is heading-aware, not token-aware.** Sections split on `##` / `###`; long sections slide-window at `CHUNK_SIZE` with `CHUNK_OVERLAP`. Good enough for most prose; swap in a tokenizer-driven chunker if you're indexing code.
- **Sync is incremental by default.** Unchanged files are skipped via `file_hash` comparison; no embedding calls, no writes. Pass `force: true` to re-embed everything. Chunks are flushed in 100-row batches to minimize Supabase round-trips.
- **Orphans are reported, not pruned.** Files removed from disk stay in the DB and show up in `orphan_files`. A dedicated `prune_memory` tool is deferred to a later release so deletions are never silent.
- **Version is a single source of truth.** [src/version.ts](src/version.ts) reads `version` from `package.json` via `createRequire(import.meta.url)` and re-exports it. The MCP server registration in [src/index.ts](src/index.ts), the `check_system_health` orchestrator block, and the `delegate_task` response envelope all import that one constant — no hard-coded literals anywhere. Bumping `package.json` propagates through the next build with zero drift between `npm view` and what the tool surface reports.
- **Policy hydration is bulk + idempotent.** [src/tools/batch-freeze-patterns.ts](src/tools/batch-freeze-patterns.ts) accepts globs or a markdown rule file, scans only the section under an exact `## Frozen Patterns` heading, strips backticks/list markers, and writes through the shared loader at [src/tools/frozen-cache.ts](src/tools/frozen-cache.ts). Cache entries are now `{ pattern, source, added_at }` objects (legacy strings are lazily migrated on read), all writes go through `<file>.tmp` + `rename`, and dedup is first-writer-wins on trimmed pattern equality — so re-running against the same rule file is a no-op. The `source` field is what powers smart-scout suppression.

---

## Security

- `.env` is git-ignored. Never commit it.
- Rotate `SUPABASE_SECRET_KEY` and your database password anytime they touch a log, a terminal history, or a chat transcript.
- The backup script writes unencrypted `.zip` files to `backups/` (also git-ignored). If your notes are sensitive, encrypt the archive before uploading anywhere.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Developer

Built and maintained by **[NABILNET.AI](https://nabilnet.ai)**.

For inquiries, integrations, or sovereign-grade Claude Code tooling, visit [nabilnet.ai](https://nabilnet.ai).

### 🗺️ File Architecture

_Auto-synced at 2026-05-14T14:36:27.117Z for `smart-claude-memory`._

```mermaid
flowchart TD
  n0["Claude-Memory/"]
  n1[".claude/"]
  n0 --> n1
  n2["docs/"]
  n0 --> n2
  n3["assets/"]
  n2 --> n3
  n4["schematic.png"]
  n3 --> n4
  n5["scm-memory/"]
  n2 --> n5
  n6["legacy_claude.md"]
  n5 --> n6
  n7["legacy_memory.md"]
  n5 --> n7
  n8["session-reports/"]
  n2 --> n8
  n9["SESSION-10-REPORT.md"]
  n8 --> n9
  n10["SESSION-11-REPORT.md"]
  n8 --> n10
  n11["SESSION-12-REPORT.md"]
  n8 --> n11
  n12["SESSION-13-REPORT.md"]
  n8 --> n12
  n13["SESSION-14-REPORT.md"]
  n8 --> n13
  n14["SESSION-15-REPORT.md"]
  n8 --> n14
  n15["SESSION-16-REPORT.md"]
  n8 --> n15
  n16["SESSION-17-REPORT.md"]
  n8 --> n16
  n17["SESSION-18-REPORT.md"]
  n8 --> n17
  n18["SESSION-19-REPORT.md"]
  n8 --> n18
  n19["SESSION-20-REPORT.md"]
  n8 --> n19
  n20["SESSION-21-REPORT.md"]
  n8 --> n20
  n21["SESSION-22-REPORT.md"]
  n8 --> n21
  n22["SESSION-23-REPORT.md"]
  n8 --> n22
  n23["SESSION-24-REPORT.md"]
  n8 --> n23
  n24["superpowers/"]
  n2 --> n24
  n25["plans/"]
  n24 --> n25
  n26["2026-05-12-observability-telemetry.md"]
  n25 --> n26
  n27["2026-05-14-marketplace-packaging.md"]
  n25 --> n27
  n28["specs/"]
  n24 --> n28
  n29["2026-05-13-telemetry-retention-design.md"]
  n28 --> n29
  n30["2026-05-14-marketplace-packaging-design.md"]
  n28 --> n30
  n31["IDE-INTEGRATION.md"]
  n2 --> n31
  n32["NEXT-SESSION-PROMPT.md"]
  n2 --> n32
  n33["hooks/"]
  n0 --> n33
  n34["md-policy.py"]
  n33 --> n34
  n35["README.md"]
  n33 --> n35
  n36["images/"]
  n0 --> n36
  n37["GPT SMC v2.0-rc1.png"]
  n36 --> n37
  n38["scripts/"]
  n0 --> n38
  n39["001_schema.sql"]
  n38 --> n39
  n40["002_multi_project.sql"]
  n38 --> n40
  n41["003_file_hash.sql"]
  n38 --> n41
  n42["004_backlog_frozen.sql"]
  n38 --> n42
  n43["005_archive_backlog.sql"]
  n38 --> n43
  n44["006_security_hardening.sql"]
  n38 --> n44
  n45["006_smoke.sql"]
  n38 --> n45
  n46["006_verify.sql"]
  n38 --> n46
  n47["007_metadata_typed_retrieval.sql"]
  n38 --> n47
  n48["008_global_scope.sql"]
  n38 --> n48
  n49["009_fix_rpc_dual_scope.sql"]
  n38 --> n49
  n50["010_agent_skills.sql"]
  n38 --> n50
  n51["011_trajectory_compaction.sql"]
  n38 --> n51
  n52["012_sleep_learning.sql"]
  n38 --> n52
  n53["013_archive_backlog_chunk_link.sql"]
  n38 --> n53
  n54["014_workflow_checkpoints.sql"]
  n38 --> n54
  n55["015_curriculum_tasks.sql"]
  n38 --> n55
  n56["016_daemon_telemetry.sql"]
  n38 --> n56
  n57["017_explicit_service_role_grants.sql"]
  n38 --> n57
  n58["018_telemetry_retention.sql"]
  n38 --> n58
  n59["apply-schema.ts"]
  n38 --> n59
  n60["backfill-ledger.ts"]
  n38 --> n60
  n61["backup-and-remove.ts"]
  n38 --> n61
  n62["e2e-incremental-test.ts"]
  n38 --> n62
  n63["e2e-isolation-test.ts"]
  n38 --> n63
  n64["… (21 more)"]
  n38 --> n64
  n65["src/"]
  n0 --> n65
  n66["curriculum/"]
  n65 --> n66
  n67["daemon.ts"]
  n66 --> n67
  n68["scanner.ts"]
  n66 --> n68
  n69["lib/"]
  n65 --> n69
  n70["migrations.ts"]
  n69 --> n70
  n71["sleep/"]
  n65 --> n71
  n72["daemon.ts"]
  n71 --> n72
  n73["miner.ts"]
  n71 --> n73
  n74["telemetry/"]
  n65 --> n74
  n75["emit.ts"]
  n74 --> n75
  n76["pruner.ts"]
  n74 --> n76
  n77["types.ts"]
  n74 --> n77
  n78["tools/"]
  n65 --> n78
  n79["backlog.ts"]
  n78 --> n79
  n80["batch-freeze-patterns.ts"]
  n78 --> n80
  n81["bloat-audit.ts"]
  n78 --> n81
  n82["checkpoint.ts"]
  n78 --> n82
  n83["compact.ts"]
  n78 --> n83
  n84["conflict.ts"]
  n78 --> n84
  n85["curriculum.ts"]
  n78 --> n85
  n86["frozen-cache.ts"]
  n78 --> n86
  n87["health.ts"]
  n78 --> n87
  n88["hygiene.ts"]
  n78 --> n88
  n89["image.ts"]
  n78 --> n89
  n90["orchestrator.ts"]
  n78 --> n90
  n91["policy.ts"]
  n78 --> n91
  n92["refactor.ts"]
  n78 --> n92
  n93["save.ts"]
  n78 --> n93
  n94["search.ts"]
  n78 --> n94
  n95["setup.ts"]
  n78 --> n95
  n96["skills.ts"]
  n78 --> n96
  n97["sleep.ts"]
  n78 --> n97
  n98["sovereign-constitution.ts"]
  n78 --> n98
  n99["summarize.ts"]
  n78 --> n99
  n100["sync.ts"]
  n78 --> n100
  n101["system_dashboard.ts"]
  n78 --> n101
  n102["verification.ts"]
  n78 --> n102
  n103["trajectory/"]
  n65 --> n103
  n104["daemon.ts"]
  n103 --> n104
  n105["stripper.ts"]
  n103 --> n105
  n106["summarizer.ts"]
  n103 --> n106
  n107["transactions/"]
  n65 --> n107
  n108["checkpoint.ts"]
  n107 --> n108
  n109["chunker.ts"]
  n65 --> n109
  n110["config.ts"]
  n65 --> n110
  n111["index.ts"]
  n65 --> n111
  n112["ollama.ts"]
  n65 --> n112
  n113["project-detect.ts"]
  n65 --> n113
  n114["project.ts"]
  n65 --> n114
  n115["supabase.ts"]
  n65 --> n115
  n116["verification-gate.ts"]
  n65 --> n116
  n117["version.ts"]
  n65 --> n117
  n118["tests/"]
  n0 --> n118
  n119["health.test.ts"]
  n118 --> n119
  n120["migrations.test.ts"]
  n118 --> n120
  n121["trajectory-daemon.test.ts"]
  n118 --> n121
  n122["trajectory-stripper.test.ts"]
  n118 --> n122
  n123["trajectory-summarizer.test.ts"]
  n118 --> n123
  n124[".env.example"]
  n0 --> n124
  n125[".gitignore"]
  n0 --> n125
  n126["ARCHITECTURE.md"]
  n0 --> n126
  n127["CHANGELOG.md"]
  n0 --> n127
  n128["CLAUDE.md"]
  n0 --> n128
  n129["LICENSE"]
  n0 --> n129
  n130["marketplace.json"]
  n0 --> n130
  n131["package-lock.json"]
  n0 --> n131
  n132["package.json"]
  n0 --> n132
  n133["project_file_architecture.md"]
  n0 --> n133
  n134["README.md"]
  n0 --> n134
  n135["tsconfig.json"]
  n0 --> n135
```