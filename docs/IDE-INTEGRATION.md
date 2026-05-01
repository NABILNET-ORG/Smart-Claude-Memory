# IDE Integration — smart-claude-memory v2.0.0-rc1

Canonical reference for running smart-claude-memory (SCM) outside Claude Code: **Cursor**, **Windsurf**, and **Cline** (VS Code MCP-compatible client). For SCM concepts (Sovereign Taxonomy, Architecture Guard, Orchestrator/Worker contract, Mermaid sync), see `../README.md` and `../ARCHITECTURE.md`.

## Overview

SCM is a stdio-based MCP server (Node 20+, TypeScript ESM). Every IDE that ships an MCP client launches it the same way: spawn `node` (or `tsx`) on the compiled entry point, speak JSON-RPC over stdio, optionally pass env vars for Supabase + Ollama. **What differs between IDEs is only the config-file location, the surrounding JSON key, and a few quirks around env-var interpolation and working-directory resolution.** The tools, schemas, and Sovereign contract are identical across clients — once SCM is registered, the boot ritual and Golden Startup Prompt from `README.md` apply verbatim.

## Project ID detection

SCM derives `project_id` from `slugify(basename(process.cwd()))` (see `src/project.ts`). The slug is lowercased, NFKD-normalized, stripped of non-`[a-z0-9_-]`, and collapsed to single hyphens. Empty results fall back to `"default"`.

Examples:

| `process.cwd()` | resulting `project_id` |
|---|---|
| `C:\Users\me\OneDrive\My Projects\Claude-Memory` | `claude-memory` |
| `/home/me/work/acme_backend` | `acme-backend` |
| `/tmp/` | `default` (no basename) |

**Override pattern.** `save_memory` and `search_memory` accept an explicit `project_id` argument that bypasses cwd detection. Use this when:

- The IDE launched SCM from a parent directory whose slug is unstable (monorepos, worktrees, VS Code multi-root workspaces).
- You want a deterministic key for CI runs.

**Reserved `'GLOBAL'` scope.** To save a universal lesson visible to every project, call `save_memory` with `metadata.is_global: true` — the row is routed to `project_id = 'GLOBAL'` and surfaces in every dual-scope `search_memory` call. Do not pass `project_id: "GLOBAL"` directly; use the `is_global` flag so the metadata stays consistent. See README "Universal Patterns → GLOBAL" for promotion criteria.

## Cursor

Cursor reads MCP servers from JSON. Per Cursor's official MCP docs:

- **Project-scoped:** `<project>/.cursor/mcp.json` — committed alongside the repo.
- **Global:** `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`).

Both files use the `mcpServers` envelope. Stdio is the default transport; remote (HTTP/SSE) entries use `url` instead of `command`/`args`.

```jsonc
// .cursor/mcp.json
{
  "mcpServers": {
    "smart-claude-memory": {
      "command": "node",
      "args": [
        "C:/Users/me/OneDrive/My Projects/Claude-Memory/dist/index.js"
      ],
      "env": {
        "SUPABASE_URL": "https://<your-ref>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service_role_key>",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "EMBED_MODEL": "nomic-embed-text",
        "EMBED_DIM": "768"
      }
    }
  }
}
```

**Quirks.**

- `command` is resolved against the user's `PATH` at Cursor launch time. On Windows, prefer the absolute path to `node.exe` if `node` isn't on `PATH` for the GUI process.
- Env-var **interpolation** in `.cursor/mcp.json` is not officially documented as supported — supply concrete values, or wrap the launch in a shell script that reads from an `.env` file. Mark this `<verify>` for your Cursor build if you depend on `${VAR}` substitution.
- Cursor sets the spawned process's cwd to the workspace root, so cwd-derived `project_id` matches the open folder.

**Boot ritual.** After Cursor reports the server as connected (green dot in Settings → MCP), open a fresh chat and paste the **Golden Startup Prompt** from `README.md` § "⚡ The Golden Startup Prompt". The same hard rules (Zero-Local-MD, 750-line ceiling, frozen-pattern block, manual test gate) apply — they are enforced server-side via `hooks/md-policy.py` regardless of the client.

## Windsurf

Windsurf (Cascade) reads MCP servers from a single JSON file:

- `~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`).

Source: [Windsurf Cascade MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp). Cascade supports three transports — `stdio`, Streamable HTTP, and SSE — and supports OAuth on each. Stdio is the right choice for SCM.

```jsonc
// ~/.codeium/windsurf/mcp_config.json
{
  "mcpServers": {
    "smart-claude-memory": {
      "command": "node",
      "args": [
        "C:/Users/me/OneDrive/My Projects/Claude-Memory/dist/index.js"
      ],
      "env": {
        "SUPABASE_URL": "https://<your-ref>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service_role_key>",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "EMBED_MODEL": "nomic-embed-text",
        "EMBED_DIM": "768"
      }
    }
  }
}
```

**Quirks.**

- After editing `mcp_config.json`, click **Refresh** in Settings → Tools → Windsurf Settings. Windsurf does not hot-reload the file.
- Windsurf supports **config interpolation** (`${env:VAR}` and similar) — useful if you want secrets out of the JSON. Verify the exact syntax in the official docs for your build.
- The plugin variant (Cascade for JetBrains) reads the same `~/.codeium/...` file; the path is identical across the desktop editor and JetBrains plugin.
- On Windows, use **forward slashes** in `args` paths to avoid escaping headaches. JSON does not require backslash escaping for forward slashes, and Node accepts both on Windows.

**Boot ritual.** Same Golden Startup Prompt as Cursor. Cascade's "Memories & Rules" feature is independent of SCM — keep them separate; do not duplicate SCM context into Cascade memories.

## Cline (VS Code)

Cline is a VS Code extension (Marketplace ID `saoudrizwan.claude-dev`, source: [github.com/cline/cline](https://github.com/cline/cline)). MCP servers are configured via the Cline UI **or** by editing the underlying settings file directly.

- **MCP settings file:** open Cline → click the **MCP Servers** icon → **Configure** tab → **Configure MCP Servers**. This opens the JSON file Cline reads. Filename and exact path: `cline_mcp_settings.json`, stored in the VS Code extension's global storage directory (commonly `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` on Windows; equivalent under `~/.config/Code/User/globalStorage/...` on Linux/macOS — `<verify>` per VS Code build/flavor: stable vs. Insiders vs. Cursor-VSCodium-fork).
- Cline supports **STDIO** (local) and **SSE** (remote) transports.

```jsonc
// cline_mcp_settings.json — STDIO
{
  "mcpServers": {
    "smart-claude-memory": {
      "command": "node",
      "args": [
        "C:/Users/me/OneDrive/My Projects/Claude-Memory/dist/index.js"
      ],
      "env": {
        "SUPABASE_URL": "https://<your-ref>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service_role_key>",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "EMBED_MODEL": "nomic-embed-text",
        "EMBED_DIM": "768"
      },
      "alwaysAllow": ["search_memory", "init_project"],
      "disabled": false
    }
  }
}
```

**Quirks.**

- `alwaysAllow` is Cline-specific — it lets you pre-approve specific tool names so Cline doesn't prompt on every call. Add only **read-only** tools here (e.g. `search_memory`, `list_frozen`, `check_system_health`); never auto-approve `delegate_task`, `confirm_verification`, or anything that writes.
- `disabled: true` toggles the server off without deleting the entry — useful for staging.
- Cline's **Global MCP Mode** (Settings → Configure → Advanced) toggles whether MCP tools count against context-window budget. Leave on the default unless you see token bloat.
- Cline launches MCP processes from the VS Code workspace root, so cwd-derived `project_id` matches the opened folder.
- The extension is sometimes referred to in marketplace metadata as **"Claude Dev"** (legacy name); `saoudrizwan.claude-dev` is the canonical extension ID even after the Cline rebrand. Forks (e.g. Roo Code) use the same JSON shape but a different settings filename.

**Boot ritual.** Same Golden Startup Prompt as Cursor and Windsurf.

## Capabilities Header

`init_project` is the documented entry point IDE clients should call on first connect. Today its response carries `core3` health (presence + mtime drift across CLAUDE.md / README.md / ARCHITECTURE.md), `legacy_backups` summary, and a `directive` string telling the client what to do next (typically: `delegate_audit`).

The v2.0.0-rc1 spec extends this response with an explicit **`capabilities`** block — a stable, machine-readable manifest the IDE client reads on first call to bootstrap its boot prompt. Expected fields:

- `protocol` — the SCM protocol version (e.g. `"smart-claude-memory/3"`).
- `project_id` — the slug derived for this workspace.
- `global_scope` — `true` if the dual-scope `'GLOBAL'` vault is reachable (Supabase up + schema present).
- `taxonomy` — enum of valid `metadata.type` values (`["DECISION", "PATTERN", "ERROR", "LOG"]`).
- `context_gathering_hints` — an ordered list of tool names + brief intent strings that the IDE should call before answering project questions (typically `init_project` → `check_system_health` → `search_memory`).
- `delegate_task_threshold` — heuristic cutoff (e.g. `lines_changed > 100` or `files_touched > 3`) above which the IDE client should refuse to edit directly and route through `delegate_task`.

IDE clients should treat the capabilities block as **the contract** — read it once per session and use it to wire the local boot prompt, instead of hard-coding tool names. See `../ARCHITECTURE.md` § Sovereign Orchestrator for the full delegation flow and ../CLAUDE.md § Hard Rules for what `delegate_task` actually enforces.

## Project ID mapping across IDEs

| Path layout | cwd at MCP launch | resulting `project_id` | recommendation |
|---|---|---|---|
| Single-folder open: `~/work/acme/` | `~/work/acme` | `acme` | use cwd default |
| Monorepo, opened at root: `~/work/acme-mono/` | `~/work/acme-mono` | `acme-mono` | use cwd default; tag rows by package via `metadata.package` |
| Monorepo, opened at sub-package: `~/work/acme-mono/packages/api` | `~/work/acme-mono/packages/api` | `api` (collides if many sub-packages share names) | **pass explicit `project_id: "acme-api"`** on every `save_memory` / `search_memory` |
| Git worktree: `~/work/acme.wt/feature-x` | `~/work/acme.wt/feature-x` | `feature-x` | pass explicit `project_id: "acme"` so worktrees share a vault |
| VS Code multi-root (Cline): primary root `~/work/acme/` | `~/work/acme` | `acme` | OK; secondary roots are not auto-merged — pass explicit `project_id` if you save from a secondary root |
| Universal pattern (any IDE) | n/a | `'GLOBAL'` (reserved) | use `metadata.is_global: true`, never set `project_id` directly |

**Rule of thumb.** If the cwd-slug is not stable across machines, IDE windows, or worktrees, pass `project_id` explicitly. The slug is a convenience, not a contract.

## Sources

- Windsurf — Cascade MCP integration. `https://docs.windsurf.com/windsurf/cascade/mcp` and `https://docs.windsurf.com/plugins/cascade/mcp` (retrieved 2026-04-30).
- Cline — Adding & Configuring MCP Servers. `https://docs.cline.bot/mcp/configuring-mcp-servers` and MCP Overview `https://docs.cline.bot/mcp/mcp-overview` (retrieved 2026-04-30).
- Cline — extension source + Marketplace ID. `https://github.com/cline/cline` (retrieved 2026-04-30).
- Cursor — MCP docs (canonical). `https://cursor.com/docs/context/mcp` (page is JS-rendered; field-level details for `<verify>` items confirmed against MCP-spec stdio transport — see below — retrieved 2026-04-30).
- Model Context Protocol — Transports specification (stdio + Streamable HTTP). `https://modelcontextprotocol.io/specification/2025-06-18/basic/transports` (retrieved 2026-04-30).
- Model Context Protocol — Example clients matrix. `https://modelcontextprotocol.io/clients` (retrieved 2026-04-30).
