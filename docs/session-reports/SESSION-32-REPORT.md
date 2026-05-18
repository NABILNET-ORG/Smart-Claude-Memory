# Session 32 — Report

**Date:** 2026-05-18
**Mission:** M5 Curriculum Consumer Epic — close the autonomous learning loop end-to-end.
**Outcome:** ✓ COMPLETE. 15 new green tests (135/135 total). Atomic-tx proof verified to the microsecond. Production-leak fix shipped.

---

## 1. Headline

The M5 Autonomous Curriculum is now production-validated on **both** sides:

| Half | Tests | Status |
|---|---|---|
| **Producer** (scanRollbackHotspots + scanStaleCandidates) | S30 — 13 chars + 2 smokes | Verified (S30-D5, S30-D6) |
| **Consumer** (list/pull/apply/reject) | **S32 — 15 chars + 1 smoke** | **Verified (S32-D1)** |

The agent now has the proven ability to consume its own curriculum: M5 scanner enqueues `curriculum_tasks` → Orchestrator pulls (FOR UPDATE SKIP LOCKED) → wraps work in an M4 checkpoint → clears the verification gate → applies success+linked → atomic auto-promote mints an `agent_skills` row → next session JIT-retrieves the new skill.

---

## 2. Mission Recap

### 2.1 Audit finding (Pre-Epic)

The 4 M5 Consumer tools (`list_curriculum_tasks`, `pull_curriculum_task`, `apply_curriculum_task`, `reject_curriculum_task`) were:

- **SHIPPED**: `src/tools/curriculum.ts:92-342` (S21-D1).
- **REGISTERED**: `src/index.ts:446-481` (S21).
- **SQL-BACKED**: `scripts/015_curriculum_tasks.sql` — `enqueue/pull_next/apply_curriculum_task` RPCs + 4 indexes + RLS deny-anon.
- **LIVE-VALIDATED**: S22-D3 observed an atomic apply with 3-row timestamp match.

But they had **ZERO Vitest/node:test characterization coverage**. Gap mirrored exactly the M5 PRODUCER gap that S30 closed for the scanner side. Additionally, `scripts/smoke-m5.ts` (S21) exercises raw SQL RPCs directly — the MCP handler layer (gate-check, error-wrap, daemon telemetry hooks) was unverified end-to-end.

### 2.2 Plan (docs/specs/m5-curriculum-consumer.md)

11 bite-sized tasks. Approved by user before any code touched. Scope explicitly fenced (YAGNI):
- No new tool features. No SQL migrations. No producer-path retests. No GLOBAL writes.

### 2.3 Delivered (9 commits, all on `main`)

| Commit | Scope |
|---|---|
| `5d4bda2` | `tests/fixtures/m4.ts` extended: `insertThrowawayCurriculumTask` helper, `proposedSteps` opt on candidate fixture, `cleanupProject` extended to delete `agent_skills` by project_id |
| `0f8cf77` | Suite A — `list_curriculum_tasks` (3 tests) |
| `217dbe6` | Suite B — `pull_curriculum_task` (4 tests, incl. linked-priority over FIFO + kind-filter SKIP LOCKED) |
| `110a9d7` | Suite C — `apply_curriculum_task` success (4 tests, incl. **C2 atomic-tx proof**) |
| `126240c` | Suite D — `apply_curriculum_task` failure (1 test) |
| `d3f32a3` | Suite E — `reject_curriculum_task` (3 tests, incl. idempotency characterization) |
| `80b8585` | `scripts/smoke-m5-consumer.ts` — handler-layer e2e (28 assertions, ~5-7s) |
| `c260715` | `package.json` — `npm test` 120 → 135, `smoke:m5-consumer` registered |
| `46e0637` | `sync_artefacts` doc-tree refresh + spec file commit |

---

## 3. The Atomic-TX Proof (C2 + Smoke)

The load-bearing assertion of the entire Epic. Inside `apply_curriculum_task`'s single SQL transaction:

```
curriculum_tasks.verified_at         = now()    -- L376
   ↓ (same tx)
promote_candidate_to_skill():
  skill_candidates.updated_at        = now()    -- 012:318
  agent_skills.created_at            = now()    -- table default
  RPC returns promoted_at            = now()    -- 015:324
```

PostgreSQL's `now()` returns transaction-start time and is constant within a single transaction. Therefore all four timestamps must be **IDENTICAL to the microsecond** if (and only if) atomicity holds.

**Smoke verification (live run):**

```
ATOMIC: task.verified_at        (2026-05-18T08:53:25.004773+00:00)
        === candidate.updated_at (2026-05-18T08:53:25.004773+00:00)
ATOMIC: candidate.updated_at    (2026-05-18T08:53:25.004773+00:00)
        === skill.created_at     (2026-05-18T08:53:25.004773+00:00)
ATOMIC: RPC promoted_at         (2026-05-18T08:53:25.004773+00:00)
        === task.verified_at     (2026-05-18T08:53:25.004773+00:00)
```

Four equality checks, all matching at microsecond precision. The Boundary Invariant #2 from ARCHITECTURE.md §4.7 ("M5 is the ONLY caller permitted to fire `promote_candidate_to_skill` outside the M3 manual path, and only inside one atomic SQL transaction") is now empirically witnessed by the test suite.

---

## 4. Hurdles + Solutions

### 4.1 Plan-vs-reality gaps (caught + fixed in-flight)

The plan was drafted against the audit synthesis; ground-truth from the actual code surfaced six discrepancies during Task 1:

| # | Plan said | Actual | Fix |
|---|---|---|---|
| 1 | Handlers exported as `handleListCurriculumTasks` etc. | Exported as `listCurriculumTasks` (no `handle` prefix) | Test imports updated before any test ran |
| 2 | Gate-block → `applyCurriculumTask` THROWS | Returns `{ ok:false, gate_clear:false, reason }` | C3 uses `assert.equal(result.ok, false)`, not `assert.rejects` |
| 3 | Input param `failure_reason`; storage `failure_reason` | Input `description`; storage `rejection_reason` | D1 + E suite use correct names |
| 4 | `skill_candidates.promoted_at` column | Column does NOT exist; only `updated_at` | C2 atomic-tx proof rewritten against `updated_at` |
| 5 | `uniqueProjectId('s32-cc')` accepts a prefix | Takes ZERO args | Tests call `uniqueProjectId()` |
| 6 | `cleanupProject` cleans all M-series tables | Did NOT clean `agent_skills` → real leak risk for C2/smoke | **See §4.2 below** |

### 4.2 Production leak fix — `cleanupProject` did NOT clean `agent_skills` (Risk #1 → real)

Identified in the plan's Risk Register as a possibility; confirmed in Task 1. The `cleanupProject` helper at `tests/fixtures/m4.ts:144` deleted from 5 tables (curriculum_tasks → skill_candidates → workflow_checkpoints → cloud_backlog → memory_chunks) but **not** `agent_skills`. Any prior M5 producer test that triggered an atomic promote (none did, by design; producer suite SCM-S30-D6 explicitly scoped to enqueue only) would have leaked rows into the live `agent_skills` vault — the same vault that backs JIT skill retrieval across all projects.

**Fix (commit `5d4bda2`):** Extended `cleanupProject` to also `DELETE FROM agent_skills WHERE project_id = $1`. FK direction is safe: `skill_candidates.promoted_skill_id → agent_skills(id) ON DELETE SET NULL`. Delete order is now: curriculum_tasks → skill_candidates → agent_skills → workflow_checkpoints → cloud_backlog → memory_chunks.

This is a latent fix for S30 as well, not just S32 — any future producer test that approaches the apply boundary inherits the protection.

### 4.3 `manage_backlog` session_end command template stale

The `next_session_command_markdown` field from `session_end` still hardcodes "Session 32 plan" in the comment line. Stale — should auto-increment N. Filed as a small follow-up nice-to-have; the user-facing fix is manual replacement to "Session 33" in this report's final output.

---

## 5. DECISION IDs

- **SCM-S32-D1** (chunk #12293, project-local) — full Epic record. Pass Cross-Project Test result: kept LOCAL (project-specific verification, not universal pattern; the fixture-cleanup leak fix is the only globally-interesting fragment, and it lives in code already).

No new GLOBAL patterns promoted this session.

---

## 6. Verification Trail (end-of-session, all green)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm test` | **135/135 pass** (was 120; +15 new: list 3 + pull 4 + apply success 4 + apply failure 1 + reject 3) — ~37s wall-clock |
| `npm run smoke:m4` | GREEN (9s) |
| `npm run smoke:m5-rollback` | GREEN (3s) |
| `npm run smoke:m5-stale` | GREEN (3s) |
| `npm run smoke:m5-consumer` | GREEN (7s, 28 assertions, atomic-tx microseconds matched) |
| Boundary Invariant #1 (no LLM in `src/curriculum/**`) | Held (no code touched) |
| Boundary Invariant #2 (single `promote_candidate_to_skill` TS call site) | Held (no code touched) |
| `sync_artefacts` | README.md + ARCHITECTURE.md refreshed |

Zero production bugs surfaced under all 15 characterization + 28 smoke assertions.

---

## 7. Git State (wrap-up)

- Branch: `main` (single-branch workflow per session preference).
- Working tree clean.
- **42 commits ahead of `origin/main`** prior to this wrap-up commit (S31 wrap + S32 Epic + this report). Pushed in step 4 of the ritual.

---

## 8. Open Items

**None.**

The M5 Autonomous Curriculum Mission Set is closed. Both producer (S30) and consumer (S32) sides are characterized, smoked, and live-validated. The autonomous learning loop demonstrably closes end-to-end:

```
M5 scanner (deterministic, no LLM)
  → enqueue curriculum_tasks (status=queued)
    → Orchestrator pull (FOR UPDATE SKIP LOCKED, linked-first priority)
      → M4 checkpoint open + work + commit
        → verification gate clear
          → apply_curriculum_task success+linked
            → atomic auto-promote → agent_skills row minted
              → next session JIT-retrieves new skill
```

Backlog: empty.

---

## 9. Session 33 Hand-off

Boot command emitted via the standard wrap-up format (see end of message). With M5 fully closed, the next session has no predetermined Epic — open for new direction.
