# Session 11 Report — Sovereign DNA v2.1 Hardening

**Session window:** 2026-05-03 (boot via Golden Startup Prompt; clean tree, Active Backlog empty post-Session-10).
**Trigger fired:** Explicit User Command ("session end") per the v2.1 Trigger Rules established mid-session.
**Headline:** Smart Claude Memory advanced from Sovereign DNA v2.0 to v2.1; the canonical constitution template now ships four new hardening sections to every downstream sovereign-bound repo. Two universal PATTERNs were promoted to the GLOBAL vault. The infection-test workflow surfaced and memorialized a real Node.js/ES-module operational gotcha.

---

## Code changes

### 1. `src/tools/sovereign-constitution.ts` (committed in `a7eb07d`)

Two surgical edits to the `SOVEREIGN_CONSTITUTION_TEMPLATE` literal:

- Heading bumped from `## Sovereign Memory Protocol` to `## Sovereign Memory Protocol (v2.1)`.
- A 40-line block inserted between **Key Definitions** and **Sovereign Taxonomy** containing four new subsections:
  1. **Relationship & Personality (Sparring Protocol)** — Brainstorming vs Execution modes, Agent-as-Intellectual-Sparring-Partner identity.
  2. **Hard Rules (Hook-Enforced)** — 750-Line Ceiling, Zero-Local-MD (now Core 3 only), Manual Test Gate procedure.
  3. **Core 3 Integrity (Anti-Corruption)** — `Write` tool FORBIDDEN on `CLAUDE.md`/`README.md`/`ARCHITECTURE.md`; surgical `Edit` only.
  4. **Branding & Self-Audit** — NABILNET.AI link mandatory in every README; `SCM-S<N>-D<i>` Decision ID format; pre-wrap Final Checklist (zero build errors, no dead code, no scratch artefacts).

A separate edit (made in the prior trigger-rules mission of this same session) inserted a **Trigger Rules** block at the top of the **Session Handoff Protocol — Atomic Wrap-Up Ritual** section: sessions now end ONLY on context-window saturation (>50%) OR explicit user command. Task completion alone is no longer a trigger.

Final template size: 164 lines (well under the 750-line ceiling).

### 2. `CLAUDE.md` (committed in `a7eb07d`)

Five surgical edits mirroring the template into the local canonical doc:

- Heading bumped to `# CLAUDE.md — Smart Claude Memory MCP (v2.0.0-rc1, Sovereign DNA v2.1)`.
- Zero-Local-MD bullet tightened from 4 files (CLAUDE.md, MEMORY.md, README.md, ARCHITECTURE.md) to the Core 3 only.
- New Hard Rules bullet: **Core 3 Integrity (anti-corruption)** — `Write` forbidden on Core 3.
- New top-level section **Personality & Sparring Protocol** inserted after Terminology.
- New top-level section **Branding, Self-Audit, and Decision IDs** inserted between Conventions and Sovereign Memory Protocol.
- New subsection **Session Termination Triggers** (from earlier in the session) inside Sovereign Memory Protocol.

Final CLAUDE.md size: 165 lines (under ceiling).

### 3. `hooks/md-policy.py` (uncommitted at report time; included in the wrap commit)

Three surgical edits aligning the Python hook with v2.1:

- `ALLOW_ROOT_DEFAULT` constant (line 32): from `"CLAUDE.md,MEMORY.md,README.md,ARCHITECTURE.md"` to `"CLAUDE.md,README.md,ARCHITECTURE.md"`.
- Module docstring (line 6): rule-1 description updated to `CLAUDE.md / README.md / ARCHITECTURE.md`.
- Module docstring (line 15): `CLAUDE_MD_POLICY_ALLOW_ROOT_MD` env-var default updated to match.

Doc-vs-runtime drift (caused by the first round shipping CLAUDE.md ahead of the hook) is now closed.

### 4. `test-infection/` (created and deleted within the session)

Sandbox workspace used to verify that `ensureSovereignConstitution()` propagates v2.1 content to fresh repos. Lifecycle:

1. Round 1: created → `init_project` emitted a stale v2.0 CLAUDE.md (4329 bytes, no v2.1 markers).
2. Round 2 (post user-side MCP restart): re-ran `init_project` → emitted v2.1 CLAUDE.md (7942 bytes, all 8 markers present at lines 5/14/16/31/37/39/40/82).
3. Folder deleted after green test, per the original conditional ("if it works, delete").

---

## Decisions saved

| ID | Type | Scope | Title |
|---|---|---|---|
| `SCM-S11-D1` | DECISION | claude-memory | Finalize v2.0 as the Sovereign DNA baseline (later superseded by D3). |
| `SCM-S11-D2` | DECISION | claude-memory | Session boundaries driven by context saturation or explicit user command, never task completion. |
| `SCM-S11-D3` | DECISION | claude-memory | Sovereign DNA upgraded to v2.1 and ready for ecosystem-wide deployment. |
| `SCM-S11-D4` | DECISION | claude-memory | Discovery of the ES-module caching bottleneck in MCP server lifecycle. |
| `SCM-S11-D5` | DECISION | claude-memory | Living Docs Sync is now Step 0 of the Atomic Wrap-Up Ritual (constitutional requirement). |
| `SCM-S11-D6` | DECISION | claude-memory | All emitters aligned with Sovereign DNA v2.1 (dynamic Session N+1 numbering in `next_session_command_markdown`). |
| `PATTERN-DECISION-ID-FORMAT` | PATTERN | **GLOBAL** | `SCM-S<N>-D<i>` decision indexing as a universal traceability pattern. |
| `PATTERN-MCP-RESTART-AFTER-BUILD` | PATTERN | **GLOBAL** | Compiled MCP servers must be restarted after `dist/` rebuild — Node.js ES-module caching gotcha. |
| `PATTERN-SOVEREIGN-VETTING-GATE` | PATTERN | **GLOBAL** | Mandatory `global_rationale` enforcement (Rule 10) prevents vault pollution and ensures every cross-project memory carries a deterministic universality justification. |

D1 was issued during a brief "stick with v2.0" detour before the user pivoted to the v2.1 hardening plan. It is preserved as historical record (decisions are append-only); D3 is the operative baseline for ecosystem deployment.

---

## Technical hurdles & resolutions

### Hurdle 1 — Stale MCP server emits old template after rebuild

**Symptom:** After landing v2.1 in source + `npm run build` succeeded + commit `a7eb07d`, the infection test (`init_project` against a fresh sandbox workspace) emitted the OLD v2.0 template. None of the eight v2.1 markers (Sparring Protocol, Core 3 Integrity, NABILNET, Trigger Rules, etc.) appeared in the spawned CLAUDE.md.

**Diagnosis:** Node.js's ES-module loader caches imports for the lifetime of the process. The running `smart-claude-memory` MCP server held the pre-v2.1 `SOVEREIGN_CONSTITUTION_TEMPLATE` constant in memory. Rebuilding `dist/` updated the file on disk but had zero effect on the live server. No error surfaced — the server silently kept emitting the old template.

**Resolution:** User restarted the MCP host. Re-running `init_project` then emitted the v2.1 template correctly (7942 bytes, all 8 markers verified by Grep). The discovery was memorialized as DECISION SCM-S11-D4 (project-local, "this changes how we sequence rebuild-then-test work") and as the global PATTERN `PATTERN-MCP-RESTART-AFTER-BUILD` (universal Node.js/MCP gotcha visible to every future sovereign-bound project via dual-scope search).

### Hurdle 2 — Doc vs runtime drift on Zero-Local-MD allow-list

**Symptom:** v2.1 docs declared "only CLAUDE.md, README.md, ARCHITECTURE.md at root" but `hooks/md-policy.py`'s `ALLOW_ROOT_DEFAULT` still listed `MEMORY.md` as a fourth allowed file.

**Resolution:** Round 4 of the session tightened `ALLOW_ROOT_DEFAULT` and (Round 5) cleaned the two docstring locations that referenced `MEMORY.md` (lines 6 and 15). No `MEMORY.md` exists at project root, so the tightening had zero blast radius.

### Hurdle 3 — Direction reversal mid-session (v2.0 vs v2.1)

**Symptom:** A v2.1 hardening plan was issued, then immediately superseded by a "stick with v2.0 baseline" instruction (D1), then reversed again into the full v2.1 upgrade (D3).

**Resolution:** Each direction was honored in sequence. D1 stands as historical record. The Trigger Rules established between D1 and D3 (D2) survived the reversal because they apply to ALL sessions regardless of DNA version — they were a process improvement, not a versioned content rule.

---

## Process improvements landed this session

1. **Trigger Rules** — sessions now span multiple missions; wrap-up fires only on context >50% or explicit user command. This single rule probably saves the most tokens of any change in the session because it eliminates redundant boot rituals between every small task.
2. **Decision ID convention codified globally** — `SCM-S<N>-D<i>` format now searchable across every project in the GLOBAL vault, not just SCM.
3. **Restart-after-build documented universally** — the next project to ship a Node-compiled MCP server inherits this knowledge for free via dual-scope search.
4. **Final Checklist** — pre-wrap verification now formalized in the constitution: zero build errors, no dead code, no scratch artefacts. Verified at this report's writing: `npm run build` clean, only intended files modified, `test-infection/` deleted.

---

## Final Checklist (v2.1 self-audit)

- ✅ `npm run build` returns zero `tsc` errors.
- ✅ No dead code, unreachable branches, or stub functions introduced this session.
- ✅ No uncommitted backups, scratch files, or `.tmp` artefacts at root (`test-infection/` deleted).
- ✅ Tree state at report time: only `hooks/md-policy.py` pending (intentional — folded into the wrap commit).
- ✅ All four DECISIONs and two PATTERNs persisted to Supabase via `save_memory` and confirmed by id.

Session 11 closes with the v2.1 baseline shipped, validated end-to-end via the infection test, and the operational lessons captured for the next agent that boots into this codebase.

---

## Continuation Addendum (post initial wrap)

Session 11 continued past the first wrap-commit (`0cf9d8b`) to land three additional sovereign improvements before the final close. Decisions D5, D6 and PATTERN-SOVEREIGN-VETTING-GATE were added in this continuation phase.

### D5 — Living Docs Sync as Step 0 (commit `5def0a3`)

Reframed the Atomic Wrap-Up Ritual from 4 steps to 5. New **Step 0 — Mandatory Living Docs Sync** is inserted before the report: the Agent MUST call `manage_backlog({ action: "session_end" })` FIRST and verify both `readme_sync.updated === true` AND `architecture_sync.updated === true` before proceeding to Step 1. README.md (Recent Progress: 5 most recent archived tasks) and ARCHITECTURE.md (refreshed Mermaid diagrams) are non-negotiable living surfaces — a wrap that leaves them stale ships a lie to the next agent. Mirrored into [src/tools/sovereign-constitution.ts](src/tools/sovereign-constitution.ts) and [CLAUDE.md](CLAUDE.md). The cleanup commit `0ef5998` from Session 11's own first wrap was the motivating example: under the old 4-step ritual the sync ran AFTER the wrap commit, producing a leftover artefact. Step 0 collapses that into one wrap commit going forward.

### D6 — Emitter alignment with the Dynamic Numbering rule (commit `e20309d`)

Closed a doc-vs-runtime drift in [src/tools/backlog.ts](src/tools/backlog.ts). The constitution template promised the next-session line would emit `"# Then read docs/NEXT-SESSION-PROMPT.md for the full Session [N+1] plan."` but the runtime emitter shipped a hardcoded `"session boot prompt."` instead. Added a `nextSessionNumber(workspace)` helper that scans `docs/session-reports/` for `SESSION-<N>-REPORT.md` files, extracts the highest N via regex, and returns N+1 (default 1 if missing). Template literal updated to use the dynamic value. Verified post-restart: this very wrap-up's `manage_backlog({action:"session_end"})` response emitted `"Session 12 plan."` correctly, validating PATTERN-MCP-RESTART-AFTER-BUILD's prediction in real time.

### PATTERN-SOVEREIGN-VETTING-GATE → GLOBAL (id 10170)

Promoted Rule 10's mandatory global_rationale enforcement to a universal architecture pattern. Codifies the principle that any multi-project memory system needs a server-side, string-validated, audit-traceable gate to prevent the global vault from degrading into a project-specific dumping ground. Companion to PATTERN-DECISION-ID-FORMAT (id 10165) and PATTERN-MCP-RESTART-AFTER-BUILD (id 10166); together they form the Sovereign Memory Triad: typed taxonomy + vetting gate + scout proposal.

### Final tally

- **6 DECISIONs** (`SCM-S11-D1`…`SCM-S11-D6`).
- **3 GLOBAL PATTERNs** (`PATTERN-DECISION-ID-FORMAT`, `PATTERN-MCP-RESTART-AFTER-BUILD`, `PATTERN-SOVEREIGN-VETTING-GATE`).
- **6 commits** in the Session 11 timeline: `a7eb07d` (v2.1 hardening), `0cf9d8b` (initial wrap), `0ef5998` (artefact-sync cleanup), `5def0a3` (Living Docs Sync mandate), `e20309d` (emitter alignment), and the final wrap commit appended for this continuation addendum.
- **Step 0 verified live** in this final wrap: `readme_sync.updated === true && architecture_sync.updated === true` — the rule it codifies is now self-enforcing for all future wraps.
