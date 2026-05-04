# Session 12 Report — Strategic Context Policy + Doc-vs-Code Reality Sync

**Session window:** 2026-05-03 → 2026-05-04 (UTC). Boot via Golden Startup Prompt; Active Backlog empty post-Session 11.
**Trigger fired:** Explicit User Command ("session end") per the v2.1 Trigger Rules.
**Headline:** Codified the **Orchestrator-Worker Separation** as named DNA in the Sovereign constitution and brought Core 3 docs (`README.md`) back in sync with the actual v2.0.0-rc1 code surface. One DECISION shipped (`SCM-S12-D1`, local + GLOBAL). Two wrap commits on `origin/main`: `648902e` (work) + `d429fe3` (originally tagged as "Session 11 continuation 2"; renumbered to Session 12 in this report).

---

## Numbering correction

The wrap commit `d429fe3` and this session's prior in-flight artefacts initially referred to the work as "Session 11 continuation 2" because the original DECISION (`SCM-S11-D7`) carried that label. The user clarified post-wrap: **this was Session 12, not a Session 11 continuation.** This report establishes the correct numbering. Forward-fix only — no history rewrite — because the renumbered commits were already pushed to `origin/main`. The original `SCM-S11-D7` rows remain in Supabase as historical record; **`SCM-S12-D1` supersedes them** as the canonical decision ID for this work.

---

## Code changes

### 1. `src/tools/sovereign-constitution.ts` (commit `648902e`)

Added a new `### Strategic Context Policy (Orchestrator-Worker Separation)` block under `### SCM Tool Conventions` in the `SOVEREIGN_CONSTITUTION_TEMPLATE` literal. Four mandatory rules:

1. **Context Hygiene First** — Orchestrator MUST NOT read >100-line files or run multi-file research / complex builds in the main session; reads of that size go through `delegate_task` and return only a 2-paragraph synthesis. Reading ≤100 lines purely to drive a surgical `Edit` is the only exception.
2. **Mandatory Delegation** — any task touching >3 files OR producing >100 lines of raw output (Grep / Read / build logs / test runs) MUST be delegated. No soft path.
3. **Synthesis Only** — 2-paragraph return contract from the Worker; compiler errors summarized in ≤1 sentence each (error code + symbol).
4. **Orchestrator Mode** — when env var `SMART_CLAUDE_MEMORY_ORCHESTRATOR_MODE` is set, all direct `Write`/`Edit`/`Bash` calls in the main session are hard-blocked by `hooks/md-policy.py` (PreToolUse hook). The kill-switch / enforcement teeth for the other three rules.

Every new sovereign-bound repo will inherit this block via `ensureSovereignConstitution`. Final template size still well under the 750-line ceiling.

### 2. `CLAUDE.md` (commit `648902e`)

Mirrored the same `### Strategic Context Policy` block into the local CLAUDE.md under `### SCM Tool Conventions`, immediately after the existing "Mandatory delegation" bullet and before `### Session Termination Triggers`. The local mirror keeps the operating manual for *this* repo aligned with the canonical template that ships to every downstream sovereign-bound project.

### 3. `README.md` — five surgical edits (commit `648902e`)

A read-only audit (delegated to an Explore subagent — context-hygiene rule applied to the audit itself) measured drift between [README.md](../../README.md) and the source tree. Five surgical `Edit` calls applied:

- **Tool count claim** — "thirteen tools" → **"twenty-two tools"**. Verified via `grep -nE '^\s*server\.tool\(' src/index.ts` returning 22 lines.
- **Toolbox table** — added the 8 missing rows: `list_frozen`, `freeze_file`, `unfreeze_file`, `sweep_legacy_backups`, `refactor_guard`, `analyze_regression`, `delegate_task`, `sync_artefacts`.
- **Schema-apply migrations** — extended from `001..003` to **`001..009`** (covers `004_backlog_frozen`, `005_archive_backlog`, `006_security_hardening`, `007_metadata_typed_retrieval`, `008_global_scope`, `009_fix_rpc_dual_scope`).
- **Project layout tree** — refreshed to show all 9 root `src/` files, all 18 `src/tools/` files, and all 11 SQL migrations + 9 helper scripts (was showing only 6 + 3 + 3 + 5).
- **Database schema RPC signature** — updated from the legacy 4-arg form to the current 6-arg dual-scope form: `match_memory_chunks(query_embedding, p_project_id, match_count, min_similarity, p_metadata_filter, p_include_global)` (introduced in 008, planner-fixed in 009 via the IN-form `WHERE` clause).

ARCHITECTURE.md §1–4 and §6 audited and verified clean (no edits required). §5 (the marker-bounded auto-block) refreshed by `sync_artefacts` after each surgical pass.

### 4. `docs/session-reports/SESSION-11-REPORT.md` (commit `d429fe3`, then this renumber commit)

Originally received a "Continuation 2" section in commit `d429fe3` describing this Session 12 work. After the user's numbering correction, that section is removed from `SESSION-11-REPORT.md` and re-homed in this `SESSION-12-REPORT.md`. Session 11's report now ends cleanly at its original "Continuation Addendum" close.

---

## Decisions saved

| ID | Type | Scope | Title |
|---|---|---|---|
| `SCM-S12-D1` (formerly `SCM-S11-D7`) | DECISION | claude-memory + **GLOBAL** | Strategic Context Policy: codify the four Orchestrator-Worker Separation rules as named DNA in the Sovereign constitution. |

The original mis-numbered rows (`SCM-S11-D7`: project-local id `10173`, GLOBAL id `10379`) remain in Supabase as historical record (saves are append-only). The canonical superseding rows are saved in this session under id `SCM-S12-D1` with a `metadata.supersedes` reference to the originals.

---

## Technical hurdles & resolutions

### Hurdle 1 — Documentation drift after sustained code evolution

**Symptom:** README.md still claimed "thirteen tools" while `src/index.ts` had grown to 22 `server.tool()` registrations. Toolbox table was missing 8 rows. Schema-apply step listed only migrations 001..003 while 11 SQL migration files existed on disk. Database schema section showed the legacy 4-arg `match_memory_chunks` RPC signature instead of the 6-arg dual-scope form introduced in migration 008.

**Diagnosis:** Cumulative drift from Sessions 6 through 11. The auto-managed sections (Recent Progress, marker-bounded ARCHITECTURE.md §5) had been keeping pace via `sync_artefacts`, but the human-authored sections (Toolbox, Project layout, Database schema, narrative claims) had not been touched and silently fell behind.

**Resolution:** Delegated the audit to an Explore subagent (read-only, no main-context pollution). Subagent returned a 2-paragraph synthesis identifying 5 high-priority drifts in README and 0 in ARCHITECTURE §1–4/§6. Verified the subagent's tool list against the actual `src/index.ts` registrations via a single `ctx_batch_execute` call (9 commands batched). Five surgical `Edit` calls applied in sequence; each respected the Core 3 anti-corruption rule (no `Write` to README, only targeted line-level replacements).

### Hurdle 2 — Mid-session protocol amendment expanded the work

**Symptom:** Mid-way through the README sync, the user pivoted with: "ACTION: ENFORCE ORCHESTRATOR-WORKER DELEGATION IN DNA". This required adding the 4 Strategic Context Policy rules to *both* the canonical template AND the local CLAUDE.md before continuing the doc sync.

**Resolution:** Re-prioritized the TodoWrite list: paused the README edits (3 of 5 complete), interleaved the constitution work (template edit → CLAUDE.md mirror → `npm run build` clean → DECISION saved local + GLOBAL), then resumed the README edits. Single `npm run build` confirmed no TS errors after the template edit. Both constitution edits used the same Strategic Context Policy block content (one with template-literal escaping, one with raw markdown) — minimal divergence risk.

### Hurdle 3 — Session number ambiguity

**Symptom:** The user's mid-session instruction said "save a DECISION (id SCM-S11-D7)", continuing the prior session's decision-index sequence. The wrap commit `d429fe3` was tagged as "Session 11 continuation 2" on that basis. Post-wrap the user clarified: "this was session 12 not 11".

**Resolution:** Forward-fix only — `origin/main` already had the renumbered commits. Created this `SESSION-12-REPORT.md`, removed the misnumbered "Continuation 2" section from `SESSION-11-REPORT.md`, and saved the canonical superseding `SCM-S12-D1` decision rows (project-local + GLOBAL) with a `metadata.supersedes` cross-reference to the original. The git history retains the original wrap commit message; this renumber commit is a forward correction, not a rewrite.

---

## Final Checklist (v2.1 self-audit)

- ✅ `npm run build` returns zero `tsc` errors.
- ✅ No dead code, unreachable branches, or stub functions introduced this session.
- ✅ No uncommitted backups, scratch files, or `.tmp` artefacts at root.
- ✅ Living Docs Sync (Step 0) verified live during the wrap: `readme_sync.updated === true && architecture_sync.updated === true`.
- ✅ All edits to Core 3 used surgical `Edit` (zero `Write` calls on CLAUDE.md / README.md / ARCHITECTURE.md).
- ✅ DECISION `SCM-S12-D1` saved local + promoted to GLOBAL with sovereign rationale ≥ 10 chars (Sovereign Vetting passed).

---

## Final tally — Session 12

- **1 DECISION** (`SCM-S12-D1`, local + GLOBAL — supersedes the originally mis-numbered `SCM-S11-D7` rows).
- **3 commits** on `origin/main`: `648902e` (Strategic Context Policy + README sync), `d429fe3` (originally-tagged "Session 11 continuation 2" wrap), and the renumber-fix commit appended for this report.
- **2 modified Core 3 files** (CLAUDE.md, README.md), **1 modified template** (`src/tools/sovereign-constitution.ts`), **2 session reports touched** (SESSION-11-REPORT.md trimmed, SESSION-12-REPORT.md created).
- **0 destructive operations** — no force-push, no history rewrite, no `Write` on Core 3.

Session 12 closes. Session 13 boots with `init_project()` + `search_memory({ query: "Active Backlog" })` per the resume prompt below.
