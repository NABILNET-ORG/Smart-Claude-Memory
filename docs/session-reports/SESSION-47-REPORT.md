# Session 47 Report — Orchestrator Bypass (Dual Mode) + Constitution Hardening

- **Version:** `2.3.2` (held — explicitly **no** bump this session)
- **Decision IDs:** `SCM-S47-D1`, `SCM-S47-D2`
- **Commits:** `cb5e320`, `be80a72`, `06ce992`, + this wrap-up
- **Branch:** `main` (all pushed to `origin/main`)

---

## 1. Mission

Make Smart-Claude-Memory **model-agnostic** so a native dynamic-workflow model (e.g. Opus 4.8 Ultra Code) can drive execution directly, and harden the Sovereign Constitution with a device-QA protocol. Three discrete pieces of work plus the wrap-up.

---

## 2. What shipped

| Area | Change | Commit |
|---|---|---|
| Constitution | Added **`[Interactive Device QA Protocol]`** (Step-by-Step Watcher) to the bottom of the Execution Imperatives in `src/tools/sovereign-constitution.ts` | `cb5e320` |
| Core 3 reconcile | Surgically reconciled root `CLAUDE.md` from 5 → **9** Execution Imperatives to match the template (added Resource Manager, Accessible Communication, Session Wrap-Up, Interactive Device QA); rebuilt `dist/` | `be80a72` |
| **Dual Mode** | New env toggle **`SCM_DELEGATION_ENABLED`** (`src/config.ts`, zod boolean, default `true`). When `false`: `src/index.ts` skips registering `delegate_task` + `sync_artefacts`; `src/tools/setup.ts` `buildCapabilities` injects `capabilities.execution_mode_notice` | `06ce992` |
| Docs hygiene | Wrap-up Step 0 audit fixed stale README tool counts (55→58, 22→58) and documented `SCM_DELEGATION_ENABLED` in the env-var table | this wrap-up |

### Dual Mode design notes
- `buildCapabilities` took a **defaulted `delegationEnabled = true` param** rather than importing `config` into the documented *pure* builder — preserved its purity contract and kept `tests/capabilities.test.ts` green with zero test edits.
- The two tool registrations were wrapped in `if (config.SCM_DELEGATION_ENABLED) { … }` **without re-indenting the body**, to keep `git blame` / bisect clean on both registrations.

---

## 3. Decisions

- **`SCM-S47-D1`** (local, id 29039) — Added `[Interactive Device QA Protocol]` to standardise manual device testing via real-time watchers; explicitly excludes simple unit/backend tests.
- **`SCM-S47-D2`** (local, id 29407) — Orchestrator Bypass (Dual Mode). The `capabilities.execution_mode_notice` acts as a pragmatic **runtime override** to the Constitution's mandatory-delegation rules when the toggle is `false`, so native models execute directly instead of looping on hidden delegation tools.
- **GLOBAL promotion** (id 29384, `PATTERN`) — the QA protocol passed the Cross-Project Test and was promoted to the GLOBAL vault with explicit user consent.

---

## 4. Hurdles & solutions

1. **Ollama outage mid-Epic.** Two consecutive `fetch failed` on `save_memory` for `SCM-S47-D2`. Diagnosed via `check_system_health` (Ollama `down`; Supabase OK 858ms) — the embed step was the blocker, not the DB. Did **not** blind-retry; reported, user restarted Ollama, then completed the save (id 29407) and verified retrievability (similarity 0.64). Two earlier saves (29039, 29384) had also been delayed by the same blip.
2. **Transient `search_memory` failure** at Dual-Mode start. Proceeded from first principles per the Active Retriever protocol's "failed-retrieve" clause — the source code was authoritative for the env-parsing convention.
3. **README drift caught by Step 0 audit.** Pre-existing inconsistency (`55 tools` at L413, `22 tools` at L603) vs actual **58** (`grep -c '^server.tool('`). Fixed before close per the BLOCKING audit rule; re-verified clean after `session_end`.

---

## 5. Verification

- `npm run build` clean both times (boundary-invariant lint + `tsc` + GUI copy), zero errors.
- Full test suite **292/292 pass** (66 suites); targeted `tests/capabilities.test.ts` **5/5**.
- `session_end`: `readme_sync.updated = true`, `architecture_sync.updated = true`; bloat audit clean (CLAUDE.md 4,301 tok, MEMORY.md 94 tok; `sovereign_purge_recommendation: null`).
- `package.json` confirmed `2.3.2` throughout; `v2.1.8` constitution version string left untouched per explicit user decision (deferred to next constitution-shipping release).

---

## 6. Files touched

- `src/tools/sovereign-constitution.ts` — new imperative (template).
- `CLAUDE.md` — reconciled to 9 imperatives (Core-3 Edit-only).
- `src/config.ts`, `src/index.ts`, `src/tools/setup.ts` — Dual Mode toggle.
- `README.md` — tool-count drift fix + `SCM_DELEGATION_ENABLED` env-var row.
- `docs/session-reports/SESSION-47-REPORT.md` — this report.

---

## 7. Carry-forward / watch items

- Backlog is **empty** — Session 48 starts from a clean slate.
- The `v2.1.8` protocol string in `CLAUDE.md` still trails the template's `v2.1.10`; align only during the next constitution-shipping release (intentional, not drift).
- When `SCM_DELEGATION_ENABLED=false`, the Constitution's delegation mandates are runtime-overridden by `execution_mode_notice` — the seam to watch if delegation behavior ever feels inconsistent.
