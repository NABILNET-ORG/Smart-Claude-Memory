# Smart Claude Memory v2.1.0 — GLOBAL Vault UX + npm Distribution

**Released:** 2026-05-17
**npm:** [`smart-claude-memory-mcp@2.1.0`](https://www.npmjs.com/package/smart-claude-memory-mcp)
**Tarball:** [smart-claude-memory-mcp-2.1.0.tgz](https://registry.npmjs.org/smart-claude-memory-mcp/-/smart-claude-memory-mcp-2.1.0.tgz)
**License:** MIT
**Tag:** [`v2.1.0`](https://github.com/NABILNET-ORG/Smart-Claude-Memory/releases/tag/v2.1.0)

---

## TL;DR

v2.1.0 lands the **GLOBAL Vault discovery loop** and ships the package to npm under [`smart-claude-memory-mcp`](https://www.npmjs.com/package/smart-claude-memory-mcp) — first public release on the registry. Two new universal patterns were promoted to the GLOBAL vault as part of the release process.

## Install

**Claude Code plugin (recommended for end users):**
```
/plugin install NABILNET-ORG/Smart-Claude-Memory
```

**npm (direct use / programmatic embedding):**
```bash
npm install smart-claude-memory-mcp
```

---

## Added

- **`list_global_patterns` MCP tool** — browse-only, tiered output (preview default; `include_content:true` opt-in to honor the [Tokens Are Currency] imperative), JSONB `metadata_filter` passthrough matching `search_memory`'s shape, `offset`/`limit` defaulting to 10, ordered by `updated_at DESC` aliased to `created_at`. Pure boundary against `search_memory({ include_global: true })` — no `query` arg.
- **`global_scope` capability extension** — `init_project` now surfaces `browse_tool` + `browse_args` + a discovery hint so agents auto-find the GLOBAL browse surface without re-reading docs.
- **Shared Zod schema module** (`src/tools/shared-schemas.ts`) — `metadataFilterSchema` extracted as a single source of truth shared between `search_memory` and `list_global_patterns`. Foundation for future tool-family additions.

## Changed

- **SCM protocol bumped to v2.1.0** — two literal-string edits in `setup.ts` (capability `type` at line 309 + runtime version at line 703). All downstream consumers automatically pick up the new protocol via `init_project`'s capability response.
- **`init_project` capability response** — `global_scope` block now populated with `browse_tool: "list_global_patterns"` and `browse_args: ["metadata_filter", "limit", "offset", "include_content"]`. Previous null placeholder removed.
- **`buildCapabilities`** extracted from `setup.ts` as a pure, independently testable function. Unit-tested in `tests/capabilities.test.ts`.

## Fixed

- **`deriveDaemonStatus` race condition** ([SCM-S27-D3](#sovereign-vetting-decisions)) — `tests/health.test.ts` was flaking at ~10-15%. Real root cause: when `intervalMs` was omitted, `staleThreshold = intervalMs * MULTIPLIER` collapsed to 0, and any positive staleness (even 1ms) tripped the `stalenessMs > 0 → 'down'` branch. **Defense-in-depth fix:** inject an optional `now` parameter for deterministic test pinning, and clamp computed durations with `Math.max(0, …)` to defend against an equal-or-earlier captured clock. Stress-tested 20× iterations: zero failures. +9 LOC, zero downstream call-site edits.

## Package Distribution

First v2.1.0 release on npm:

- `package.json` — dropped `"private": true`, added `"files"` allowlist (`dist/`, `hooks/`, `.claude-plugin/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `marketplace.json`), added `description`, `license`, `homepage`, `repository`, `bugs`, `keywords` (mirrored from `marketplace.json`).
- Tarball: 185 KB packed / 745 KB unpacked / 104 files. Source maps included for end-user debuggability.
- Two-pillar install path now live: **Claude Code plugin** (auto-wires MCP server + `md-policy.py` PreToolUse hook via `.claude-plugin/plugin.json`) OR **npm** (`smart-claude-memory-mcp` binary).

## Sovereign Vetting Decisions

Two decisions from the release work were promoted to the GLOBAL vault (cross-project universal truths):

- **SCM-S27-D2 — Foundation-First commit-sequencing pattern.** Hoist shared-dependency refactors to commit #1. Never bundle refactor + feature in one commit. Each commit independently revertable means `git bisect` lands on a single concern. Anti-pattern: refactor + feature combined pollutes bisect, mixes diagnostic context, raises review cost.
- **SCM-S27-D3 — Defense-in-depth for time-dependent pure functions.** Expose optional `now?: number` parameter (defaults to `Date.now()`) for deterministic test injection AND clamp computed durations with `Math.max(0, …)` to defend against clock-skew edge cases. Both required: option 2 alone leaves degenerate-threshold bug, option 1 alone leaves latent clock-skew bug. Combined = belt-and-suspenders.

Both are visible to every future project via dual-scope `search_memory`.

## Verification

- `npm run build` — boundary lint OK (4 files under `src/sleep`, `src/curriculum`, zero LLM imports; Boundary Invariant #1 holds), `tsc` clean exit.
- `npm pack --dry-run` — 104 files, 185 KB packed; critical inclusions present (`dist/`, `hooks/`, `.claude-plugin/plugin.json`, README, LICENSE, CHANGELOG, marketplace.json); forbidden directories cleanly excluded (`tests/`, `src/`, `docs/`, `backups/`, `scripts/`, `node_modules/`, `images/`).
- Full test suite: 75/75 green across 25 suites.
- `npm view smart-claude-memory-mcp` — confirms `latest: 2.1.0`, MIT license, 7 runtime deps, MCP SDK ^1.29.0.

## Commits in v2.1.0

| Commit | Subject |
|---|---|
| `2622529` | `refactor(schema): extract metadataFilterSchema to src/tools/shared-schemas.ts` |
| `d148a96` | `chore: bump SCM protocol to v2.1.0` |
| `b56e139` | `feat(capabilities): extend global_scope schema (null placeholder)` |
| `bf93b9f` | `feat(tool): register list_global_patterns stub + smoke test` |
| `d61c818` | `feat(tool): implement list_global_patterns SELECT + tiered output + AC tests` |
| `d989252` | `feat(capabilities): populate browse_tool + hint + capabilities tests` |
| `990da2d` | `docs(readme): update README for v2.1.0 GLOBAL Vault UX` |
| `dcb3c9d` | `fix(health): resolve sub-millisecond race condition in daemon status derivation + bump versions to 2.1.0` |
| `84f34c4` | `session: wrap-up Session 27 — v2.1.0 GLOBAL Vault UX shipped` |
| `e410f51` | `chore(pkg): prepare smart-claude-memory-mcp@2.1.0 for npm publish — drop private, add files allowlist + metadata` |

## Compatibility

- **Node:** ≥ 20
- **MCP SDK:** ^1.29.0
- **Supabase:** any project with `pg_vector` extension
- **Ollama:** local installation with `moondream` + `nomic-embed-text` pulled
- **Breaking changes from 2.0.1:** none. Tool surface expanded by 1 (`list_global_patterns`); existing tools unchanged. All migrations (1-18) unchanged.

## Links

- **Homepage:** [nabilnet.ai](https://nabilnet.ai)
- **Repository:** [github.com/NABILNET-ORG/Smart-Claude-Memory](https://github.com/NABILNET-ORG/Smart-Claude-Memory)
- **npm:** [smart-claude-memory-mcp](https://www.npmjs.com/package/smart-claude-memory-mcp)
- **Issues:** [github.com/NABILNET-ORG/Smart-Claude-Memory/issues](https://github.com/NABILNET-ORG/Smart-Claude-Memory/issues)
