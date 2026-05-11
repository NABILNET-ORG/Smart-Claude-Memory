# Session 16 — Factory Bug Fix: Strict Hash Validation in `upgrade_constitution`

**Date:** 2026-05-10 → 2026-05-11
**Branch / commits:** `main` — `b546e03` (strict-hash fix), pushed to `origin/main` (`c96fe15..b546e03`)
**Bound protocol:** Sovereign Memory Protocol v2.1.6

---

## Mission

Single-mission session driven by a field-discovered logical flaw in [src/tools/sovereign-constitution.ts](src/tools/sovereign-constitution.ts) (the `upgrade_constitution` tool shipped in Session 15's PR #6, commit `c96fe15`):

> A naive early exit `if (fromVersion === toVersion) return already_synced;` short-circuited the function BEFORE any hash computation. A half-applied upgrade — header bumped to `v2.1.6` but body missing the new rules (e.g., agent hallucinated and skipped the Boy Scout exception injection) — would masquerade as in-sync, AND `force: true` was bypassed because the equality check ran first.

The class is identical to the failure that motivated `upgrade_constitution` itself (Session 15, SCM-S16-D2 GLOBAL-promotion candidate): **trusting a self-reported field instead of computing the truth.** Header strings are claims; hashes are evidence.

---

## Code Changes

| Commit | Files | Δ | Surface |
|---|---|---|---|
| `b546e03` | `src/tools/sovereign-constitution.ts` | +11 / -4 | Removed naive version-equality early exit. New ordering: (1) compute `blockHash`, (2) compare against `KNOWN_CANONICAL_HASHES[toVersion]` — only byte-exact match returns `already_synced`, (3) evaluate `isAutoSafe` against the registered hash for the claimed `fromVersion`, (4) `force: true` ALWAYS overwrites a non-canonical block regardless of header version. Updated `drift_detected.recommendation` text to mention both claimed and target hash mismatch. |

`npm run build` → zero `tsc` errors. Commit isolated per **Foundation First Protocol** (v2.1.6 directive) — no entanglement with feature work.

---

## Behavior Matrix (before vs. after)

| Scenario | Before | After |
|---|---|---|
| Block byte-matches `v2.1.6` canonical | `already_synced` ✓ | `already_synced` ✓ |
| Header says `v2.1.6`, body missing rules (hallucination case) | `already_synced` ✗ (silent corruption) | `drift_detected` (or overwrite with `force:true`) ✓ |
| Block on `v2.1.5` canonical, target `v2.1.6` | `synced` (mode: `auto_safe`) ✓ | `synced` (mode: `auto_safe`) ✓ |
| Block on `v2.1.5` customized, target `v2.1.6`, no force | `drift_detected` ✓ | `drift_detected` ✓ |
| Header says `v2.1.6`, body corrupted, `force: true` | `already_synced` ✗ (force bypassed) | `synced` (mode: `force`) ✓ |

The two `✗` rows are the bugs this commit closes.

---

## Decisions

- **SCM-S16-D3** (id `11503`, project-local, `type: ERROR`, `status: fixed`) — Strict hash validation replaces naive version-string check in `upgradeConstitutionBlock`. Same class of bug as SCM-S16-D2 — verify by hash, not by self-declared metadata.

No GLOBAL promotion this session. The underlying principle (*"verify by hash, not by self-reported version"*) is already encoded structurally in the tool; promotion would only matter if a sibling project ships an analogous self-reporting check.

---

## Hurdles & Solutions

- **None.** Single-file surgical edit, clean compile, isolated commit. The session validated the Foundation First Protocol working as designed: bug discovered in the previous session's shipped tool was addressed in one isolated commit with no surrounding refactor.

---

## Pre-Wrap Checklist

- `npm run build` → zero `tsc` errors.
- `git push origin main` → `c96fe15..b546e03  main -> main` ✓
- `manage_backlog({ action: "session_end" })` → `readme_sync.updated === true`, `architecture_sync.updated === true`.
- Bloat audit: CLAUDE.md = 1704 tok, hidden MEMORY.md = 94 tok (both well under 10k threshold).
- Backlog: empty (0 todo / 0 in-progress / 0 blocked).
- No `sovereign_purge_recommendation`.

---

## Drift / Follow-up (carried from Session 15)

These v2.1.7 candidates remain open after Session 16:

- **`KNOWN_CANONICAL_HASHES` build-time integrity check.** CI step that refuses to ship if the current template's SHA-256 isn't registered under `CANONICAL_CONSTITUTION_VERSION`. Prevents silent registry rot. With Session 16's strict-hash fix, a missing-registry-entry release would now correctly surface as `drift_detected` on every downstream `init_project`, but a build-time gate is still cheaper than discovering it at runtime.
- **Backfill `KNOWN_CANONICAL_HASHES` for v2.0.0–v2.1.4** — extends `auto_safe` coverage to older sovereign-bound repos.
- **MCP tool surface frozen-list smoke test** — catches silent surface drift on tool registration/deletion.
- **`manage_backlog session_end` numbering bug** — off-by-one in the emitted `Session [N]` string; tool should accept session context or read a marker.
- **Active Memory Hygiene rule reconciliation with auto-memory framework** — v2.1.6 mandates "Current Focus / Pending Tasks" two-section schema; auto-memory uses a Memory Index pointer format. Rephrase to "surgically prune stale entries" rather than mandating a fixed schema.
- **GLOBAL promotion: "deterministic > LLM for mechanical workflows"** — SCM-S16-D2's universal principle; pair with Session 16's reaffirmation ("verify by hash, not self-report") as the same lesson at two granularities.

No new follow-ups generated by Session 16 itself.

---

## Session-Number Convention Note (carried forward)

Per Session 15's wrap note, memory rows id `11498` (search-precision) and id `11499` (deterministic DNA sync) carry the prefix `SCM-S16-D1` / `SCM-S16-D2` but were Session 15 work — the IDs were drafted before the user clarified session framing.

This session (officially Session 16) saved its lone DECISION/ERROR as **`SCM-S16-D3`** (id `11503`) — the gap (no `S16-D1` / `S16-D2` belonging to Session 16) preserves the existing memory rows without renumbering churn. Future sessions starting at `SCM-S17-D*` should treat `S16-D1` and `S16-D2` as Session 15 carryovers and `S16-D3` as the only true Session 16 decision.
