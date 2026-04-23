<div align="center">

# claude-memory

**Hybrid cloud-local memory for Claude — semantic retrieval instead of context bloat.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29+-6e56cf)](https://modelcontextprotocol.io/)
[![pgvector](https://img.shields.io/badge/pgvector-HNSW-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Ollama](https://img.shields.io/badge/Ollama-local%20embeddings-000)](https://ollama.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

---

## The problem

Claude sessions load `memory.md`, `rules.md`, `cloud.md`, and a dozen other context files at startup. Every token you spend on "what does this project do" is a token you can't spend on the actual task. At scale, you end up burning budget re-reading the same notes hundreds of times per week.

## What this does

`claude-memory` is a **Model Context Protocol server** that replaces "read every .md at startup" with "search them on demand." It chunks your markdown notes, embeds them with a local Ollama model, stores them in Supabase (pgvector), and exposes three tools to Claude:

| Tool | Purpose |
|---|---|
| `sync_local_memory` | Scan folders → chunk → embed → upsert |
| `search_memory` | Semantic search over the current project's chunks |
| `update_rule` | Targeted single-chunk upsert without re-scanning |

Memory is strictly **per-project**: when you're in project A, Claude cannot see project B's notes. See [Multi-project isolation](#multi-project-isolation).

---

## Hybrid cloud-local architecture

```
┌────────────────────────┐       ┌──────────────────┐       ┌─────────────────────┐
│  Claude Code (client)  │◀─────▶│  claude-memory   │──────▶│  Ollama (localhost) │
│                        │ stdio │   MCP server     │ HTTP  │  nomic-embed-text   │
└────────────────────────┘       │    (TypeScript)  │       │  768-dim vectors    │
                                 │                  │       └─────────────────────┘
                                 │                  │       ┌─────────────────────┐
                                 │                  │──────▶│  Supabase + pgvector│
                                 └──────────────────┘ HTTPS │  HNSW cosine index  │
                                                            └─────────────────────┘
```

**Two independent planes by design:**

- **Local plane — Ollama.** Every byte of your notes is embedded on your own machine. Content never leaves your device in plaintext for vectorization. No per-token API fees, no third-party seeing your prompts.
- **Cloud plane — Supabase.** Durable storage, indexable across devices, cheap. Only the vectors + the source text live here — and only the text you explicitly choose to sync.

You get the privacy posture of local inference with the durability and cross-machine access of a managed Postgres.

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

## Getting started

### Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com/) running locally, with an embedding model pulled:
  ```bash
  ollama pull nomic-embed-text
  ```
- A [Supabase](https://supabase.com/) project (free tier is fine)

### 1. Clone and install

```bash
git clone https://github.com/NABILNET-ORG/Claude-Memory.git
cd Claude-Memory
npm install
```

### 2. Configure `.env`

Copy [.env.example](.env.example) to `.env` and fill it in:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
SUPABASE_SECRET_KEY=sb_secret_xxx

# Direct connection — IPv6-only on newer projects; keep for reference.
SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres

# Transaction pooler — IPv4-reachable. Required if your network has no IPv6 route.
# Dashboard: Project Settings → Database → Connection pooler.
SUPABASE_POOLER_URL=postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres

OLLAMA_HOST=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
EMBED_DIM=768

MEMORY_ROOTS=/abs/path/to/notes;/another/path
CHUNK_SIZE=800
CHUNK_OVERLAP=100
```

> **Why two connection strings?** Supabase's `db.<ref>.supabase.co` endpoint is **IPv6-only** on projects created after early 2024. If your network doesn't route public IPv6 (most home/office Windows boxes don't), direct connects fail with `ENETUNREACH`. The **transaction pooler** at `aws-1-<region>.pooler.supabase.com:6543` is IPv4-reachable and is what `scripts/apply-schema.ts` uses by preference.

### 3. Apply the schema

```bash
npm run schema                              # applies 001_schema.sql
npm run schema -- 002_multi_project.sql     # applies multi-project migration
```

Or, if you prefer to paste SQL manually: open [Supabase SQL Editor](https://supabase.com/dashboard) and run [scripts/001_schema.sql](scripts/001_schema.sql) followed by [scripts/002_multi_project.sql](scripts/002_multi_project.sql).

### 4. Build

```bash
npm run build
```

### 5. Register with Claude Code

**User scope** (available in every project you open) — add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/Claude-Memory/dist/index.js"],
      "env": {}
    }
  }
}
```

**Project scope** (only this repo) — create `.mcp.json` in the target project's root with the same block.

Restart Claude Code. Run `/mcp`. You should see `claude-memory` connected with three tools.

### 6. Index your notes

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
  content_hash text not null,
  metadata     jsonb not null default '{}'::jsonb,
  project_id   text not null default 'default',
  updated_at   timestamptz not null default now(),
  unique (project_id, file_origin, chunk_index)
);

create index on memory_chunks using hnsw (embedding vector_cosine_ops);
create index on memory_chunks (project_id);
```

The RPC `match_memory_chunks(query_embedding, p_project_id, match_count, min_similarity)` enforces the isolation filter in SQL. Full schema + RPC definitions in [scripts/001_schema.sql](scripts/001_schema.sql) and [scripts/002_multi_project.sql](scripts/002_multi_project.sql).

---

## Project layout

```
src/
├── index.ts        MCP server entry — tool registration
├── config.ts       Env loader (absolute .env path resolution)
├── project.ts      project_id detection + slugification
├── ollama.ts       POST /api/embed client
├── supabase.ts     Table + RPC wrappers
├── chunker.ts      Markdown-aware splitter
└── tools/
    ├── sync.ts     sync_local_memory handler
    ├── search.ts   search_memory handler
    └── update-rule.ts

scripts/
├── 001_schema.sql
├── 002_multi_project.sql
├── apply-schema.ts
├── backup-and-remove.ts
├── e2e-test.ts
└── e2e-isolation-test.ts
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
- **Re-sync is idempotent but full.** `sync_local_memory` re-embeds every chunk on every call. Cheap on local Ollama, but if your corpus is large, hash-gate it.

---

## Security

- `.env` is git-ignored. Never commit it.
- Rotate `SUPABASE_SECRET_KEY` and your database password anytime they touch a log, a terminal history, or a chat transcript.
- The backup script writes unencrypted `.zip` files to `backups/` (also git-ignored). If your notes are sensitive, encrypt the archive before uploading anywhere.

---

## License

MIT. See [LICENSE](LICENSE).
