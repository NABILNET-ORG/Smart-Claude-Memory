# Plugin Marketplace Packaging — Epic Design (v2.0.0 GA)

**Status:** Approved (Session 25, 2026-05-14)
**Owner:** Smart-Claude-Memory project
**Predecessor:** [SESSION-24-REPORT.md](../../session-reports/SESSION-24-REPORT.md) — closed Observability Epic, recommended marketplace packaging as the next epic
**Bridges:** Internal `v2.0.0-rc1` → Public `v2.0.0` GA

---

## 1. Mission

Bundle `smart-claude-memory` as an **installable Claude Code Plugin** that a brand-new user can adopt with zero database administration and zero hand-editing of `~/.claude.json` or `settings.json`. The current 5-step manual install ritual (clone → npm install → fill .env → apply 18 migrations one-by-one → hand-edit settings) becomes a 3-step path (clone marketplace repo → set 3 env vars → first MCP call auto-migrates).

The diagnostic surface delivered by the Observability Epic (4 daemons + GLOBAL Vault + system_dashboard) is the trust story we lean on for a public release. This epic does NOT introduce new features — it makes the existing surface installable.

## 2. Locked Assumptions

### 2.1 Distribution Model
The plugin ships as a **Claude Code Plugin** via `.claude-plugin/plugin.json`, which auto-wires:
- The stdio MCP server pointing at `${CLAUDE_PLUGIN_ROOT}/dist/index.js`
- The PreToolUse `Write|Edit|Bash` hook pointing at `${CLAUDE_PLUGIN_ROOT}/hooks/md-policy.py`

We do NOT pursue `npm install -g`, NOT publish to npm registry, NOT depend on the user manipulating `~/.claude.json` by hand. The plugin manifest is the single declaration; Claude Code's plugin loader resolves everything else.

### 2.2 BYO Supabase
The user creates an empty Supabase project and supplies three env vars:
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (service-role)
- `SUPABASE_POOLER_URL` (IPv4-reachable, for schema apply)

On first `init_project()` call, the plugin transparently applies all pending migrations against the user's empty DB. Subsequent `init_project()` calls become no-ops once the ledger reports zero pending. Idempotency is guaranteed by a new `schema_migrations` ledger table. Apply is NOT triggered on every MCP boot — only on `init_project` (explicit, user-driven entry point).

### 2.3 Ollama Stays Local
`moondream` + `nomic-embed-text` remain user-installed local dependencies. No change in scope. We add a preflight check that prints actionable `ollama pull moondream nomic-embed-text` instructions if missing. The plugin does NOT attempt to spawn or manage Ollama.

### 2.4 Hook Auto-Wiring
`hooks/md-policy.py` is registered via the plugin.json `hooks` block. The user no longer hand-edits `~/.claude/settings.json` to add the PreToolUse handler. Plugin install = hook live. Plugin uninstall = hook removed. Single source of truth.

## 3. Acceptance Criteria

A reviewer can verify GA-readiness by confirming all of:

1. **3-step install**: Cloning the marketplace repo, setting 3 env vars in `.env`, and making one MCP call reaches `overall: "pending"` → `"healthy"` with no manual schema, hook, or settings.json edits.
2. **No more cold-boot false-negatives**: For the first 15 minutes after a fresh plugin install, daemons without `run_ended` events report `pending`, NOT `down`. The top-level `overall` is never `down` solely because of a daemon in its grace window.
3. **Atomic migration apply**: Running `npm run schema` (or the equivalent on-boot path) applies all pending migrations atomically per file. Re-running is a no-op. Killing the process mid-apply leaves the DB in a consistent state.
4. **Ledger reporting**: First `init_project` on a fresh DB reports `{ migrations: { applied: 18, skipped: 0 } }`. Re-run reports `{ applied: 0, skipped: 18 }`.
5. **Version drop**: `package.json` version transitions from `2.0.0-rc1` → `2.0.0`. `marketplace.json` is published. A GA changelog enumerates the deltas from `rc1`.
6. **No regression in existing tests**: `npm run test` is green. The `lint:boundaries` gate is green. `npm run build` produces a clean dist/ with zero TS errors.

## 4. Architecture

### 4.1 Plugin Surface (new)

```
.claude-plugin/
  plugin.json           ← manifest: name, version, mcpServers, hooks, description
marketplace.json        ← top-level for marketplace listing (or in separate repo)
```

`plugin.json` declares:
- `mcpServers.smart-claude-memory` — stdio command + args pointing at `${CLAUDE_PLUGIN_ROOT}/dist/index.js`, plus env passthrough for the 7 SCM env vars
- `hooks.preToolUse[]` — single entry: `${CLAUDE_PLUGIN_ROOT}/hooks/md-policy.py` matching `Write|Edit|Bash`

### 4.2 Migration Ledger (new)

The applier creates the ledger table itself via `CREATE TABLE IF NOT EXISTS` on every run — no separate bootstrap migration file is required. The ledger schema:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

`scripts/apply-schema.ts` is rewritten to support two modes:
- `npm run schema` (no args) — scans `scripts/*.sql`, diffs against ledger, applies all pending in lexical order
- `npm run schema 001_schema.sql` (single arg) — legacy single-file mode, retained for emergencies

Apply algorithm:
1. Ensure `schema_migrations` table exists (CREATE IF NOT EXISTS).
2. `SELECT filename FROM schema_migrations` → set of applied names.
3. Glob `scripts/0*_*.sql`, lexical sort.
4. For each pending file: compute sha256 of the file, open a transaction, execute file body, INSERT into ledger, COMMIT. On any error: ROLLBACK and abort with clear error.
5. Print summary: `applied: N, skipped: M, total: 18`.

### 4.3 Health Enum Extension

`src/tools/health.ts`:
- `DerivedStatus` becomes `"healthy" | "pending" | "degraded" | "down"`.
- `SEVERITY` map gains `pending: 0.5` (between `healthy: 0` and `degraded: 1`). `pending` never promotes `overall` past `degraded`.
- Cold-boot derivation (current line 55-63) checks: if `enabled === true` AND `last_run_ended_at === null` AND `process.uptime() < GRACE_MS`, return `{ status: "pending", reason: "warming up — no run_ended events yet, within 15min grace" }`.
- `GRACE_MS` defaults to `15 * 60 * 1000` (15 min). Constant near the top of the file, not env-configurable in v1 (YAGNI).

### 4.4 Boot-Time Migration Apply

`src/tools/init.ts` (`init_project` handler):
- After current readiness checks, add a step: `applyPendingMigrations({ workspace })`.
- Implementation reuses the apply-schema logic (shared helper module: `src/lib/migrations.ts`).
- Failure mode: if Supabase is unreachable, return a `not_ready` overall with the specific check `migrations: not_ready, detail: <error message>`. Do NOT crash the MCP server.

### 4.5 Ollama Preflight

`src/tools/init.ts` already checks Ollama reachability. Extend to confirm `moondream` AND `nomic-embed-text` are present in the model list. If missing, surface a `not_ready` check with detail: `Missing models: <list>. Run: ollama pull <names>`.

## 5. Data Flow

```
[install path]
user installs plugin from marketplace
  → Claude Code reads .claude-plugin/plugin.json
  → registers MCP server (stdio, env passed through)
  → registers PreToolUse hook (md-policy.py)
user creates .env (3 mandatory vars + optional Ollama overrides)
user opens Claude Code in a project for the first time

[first MCP call]
init_project()
  → readiness checks (env, hook, MCP registration, dist build, Core 3)
  → applyPendingMigrations()
    → SELECT schema_migrations
    → diff vs scripts/*.sql
    → for each pending: BEGIN; execute; INSERT ledger; COMMIT
    → return { applied: N, skipped: M }
  → ollama preflight (reachable + required models)
  → return overall: ready | partial | not_ready

[steady state]
boot → 4 daemons start with first_seen_at=now
  → grace window: status "pending" until first run_ended emitted
  → after grace expires without run_ended: degrades to "down"
  → once run_ended observed: derived from staleness logic as before
```

## 6. Error Handling

| Failure | Behavior |
|---|---|
| `SUPABASE_URL` unreachable at boot | `init_project` returns `not_ready` with `supabase: not_ready, detail: <error>`. MCP server stays alive; subsequent tools that need DB will fail with a clear error. |
| Migration file syntax error | Transaction rolls back. Apply aborts on first failure. Ledger is not updated. Error message includes filename + Postgres error. |
| `schema_migrations` table cannot be created (perms) | `init_project` returns `not_ready` with `migrations: not_ready, detail: cannot create schema_migrations table — check service_role grants`. |
| Ollama unreachable | `init_project` `ollama: not_ready`. MCP server stays alive; tools using embeddings will fail with clear error. |
| Ollama reachable but model missing | `init_project` `ollama: partial, detail: Missing models: <list>. Run: ollama pull <names>`. |
| Plugin manifest invalid | Claude Code's plugin loader surfaces the error; out of our scope. |

No silent failures. No fallbacks that mask root cause. All failure paths print actionable next steps.

## 7. Testing

| Area | Test |
|---|---|
| Health pending state | Unit test in `tests/health.test.ts`: mock `process.uptime` to <15min, mock daemon with `last_run_ended_at: null`, assert `status === "pending"`. |
| Health grace expiry | Same test setup but uptime >15min, assert `status === "down"`. |
| Overall rollup | Test that `overall === "pending"` when one daemon pending and rest healthy; `overall === "degraded"` when one pending + one degraded; `overall === "down"` only when at least one is `down`. |
| Migration ledger | Integration test (`tests/migrations.test.ts`): apply against empty test DB, assert all 18 land in ledger; re-run, assert 0 applied. |
| Migration mid-failure | Force a syntax error in a copy of one migration, assert transaction rollback and ledger unchanged. |
| Plugin manifest | Schema-validate `plugin.json` against Claude Code's plugin schema (smoke test via `npx`). |
| README install ritual | Manual smoke test on a fresh Supabase project before tagging `2.0.0`. |

The brainstorming skill mandate of TDD applies to commits 1 (health) and 2 (migrations) — write the failing test first, then the implementation.

## 8. Foundation-First Commit Sequence

Each commit is its own isolated foundation gate. No entangled feature+infra commits.

| # | Commit | Type | Files Touched |
|---|--------|------|---------------|
| 1 | `fix(obs): health.ts pending state + 15min grace window` | Foundation (P0 FTUX fix) | `src/tools/health.ts`, `tests/health.test.ts` (new) |
| 2 | `feat(schema): schema_migrations ledger + apply-all idempotent CLI` | Foundation | `scripts/apply-schema.ts`, `src/lib/migrations.ts` (new), `tests/migrations.test.ts` (new) |
| 3 | `feat(boot): init_project auto-applies pending migrations on first call` | Feature | `src/tools/init.ts`, calls into `src/lib/migrations.ts` |
| 4 | `feat(plugin): .claude-plugin/plugin.json manifest + ${CLAUDE_PLUGIN_ROOT}` | Feature | `.claude-plugin/plugin.json` (new), refactor any hardcoded paths in `src/index.ts` to honor `${CLAUDE_PLUGIN_ROOT}` |
| 5 | `feat(plugin): auto-wire md-policy.py hook via plugin manifest` | Feature | `.claude-plugin/plugin.json` (hooks block), `hooks/md-policy.py` (path adjustments if any) |
| 6 | `feat(env): preflight check for Ollama models with actionable error` | Feature | `src/tools/init.ts` (extend ollama check), `src/lib/preflight.ts` (new, if extracted) |
| 7 | `docs: README rewrite — 3-step BYO Supabase install ritual` | Docs | `README.md`, `ARCHITECTURE.md` (new §x — Plugin Distribution), `docs/NEXT-SESSION-PROMPT.md` |
| 8 | `release(2.0.0): drop -rc1, marketplace.json, GA changelog` | Release | `package.json` (version), `marketplace.json` (new), `CHANGELOG.md` (new or extended) |

**Sequencing rules**:
- Commits 1 and 2 are pure foundation — they MUST land green before any feature commit. They are independently reviewable.
- Commit 3 depends on 2. Commit 5 depends on 4. Commit 8 depends on all preceding.
- Commits 4, 5, 6 can be developed in parallel after 1+2+3 land.
- No commit is allowed to bundle a foundation fix with a feature — discovered foundation issues mid-feature trigger a HALT, isolate the fix in its own commit, then resume.

## 9. Open Questions / Out of Scope

**Out of scope for this epic**:
- Multi-tenant Supabase (one DB, many projects) — already handled by `project_id` isolation, no new work.
- Custom marketplace branding (logos, screenshots) — packaging metadata only, polish lives in a follow-up.
- Auto-update flow inside Claude Code — Claude Code's plugin updater handles this; we don't reinvent it.
- Encrypted env var storage — user responsibility; we document `.env` best practices.

**Deferred to a follow-up** (Session 26+):
- `list_global_patterns` MCP tool (GLOBAL Vault UX from Session 24's Option 2).
- Install funnel telemetry — useful for adoption analytics but a new daemon and out of scope here.

## 10. Sign-off

Design approved by user in Session 25 (2026-05-14). Lock the spec; move to implementation planning via `writing-plans`.
