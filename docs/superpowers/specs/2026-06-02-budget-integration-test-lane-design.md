# Phase 1 Design — Budget DB-Integration Test Lane (#311)

- **Date:** 2026-06-02 · **Session:** 49 · **Decision:** SCM-S49-D1
- **Imperative:** Foundation First — establish the safety net BEFORE the DB-heavy Docs Crawler (#312).

## Problem

`tests/budget-gate.test.ts` covers only the budget gate's **pure logic** and its own comment promises that DB-touching paths "are covered by integration tests in `tests/budget-integration.test.ts`" — **but that file never existed.** `checkTaskBudget` / `checkDaemonBudget` (`src/budget/gate.ts`) write to four tables — `budget_tasks`, `budget_task_events`, `daemon_budget_buckets`, `daemon_budget_events` — with **zero end-to-end coverage**.

## Constraints (from Session 49 investigation)

- Runner: Node native `node:test` + `tsx`. `npm test` lists **37 files explicitly** (no globs) → a new file is isolated unless added to that list.
- The unit suite mocks Supabase (`mock.module("../src/supabase.js")`); it never hits a DB.
- **No** local Postgres / Docker / 2nd Supabase project. One dev Supabase only.
- The gate runs through the **public-schema `supabase-js` singleton** (`src/supabase.ts`); env via `src/config.ts` (dotenv + zod, `exit(1)` if missing).
- Precedent: `tests/migrations.test.ts` is the only real-DB test (env-gated, temp schema, before/after teardown).

## Decision (SCM-S49-D1): Namespace-isolation + guaranteed cleanup

Run the gate **end-to-end against the live dev Supabase under a disposable namespace per run**, deleting everything in teardown. Chosen over (a) temp-schema — can't exercise the supabase-js code path the gate actually uses — and (b) provision-real-DB — no infra/creds available now. Rationale: tests the **real** path, matches the repo's `project_id` tenancy guard, zero new infra.

## Design

### New files
- `tests/budget-integration.test.ts` — the integration suite.
- `.env.test` (committed, **no secrets**) — sets `RUN_DB_TESTS=1`.

### Edits
- `package.json`: add `"test:integration"` running ONLY the integration file via the same `node:test`+`tsx` invocation, with `--env-file=.env.test`. The `test` script stays **byte-for-byte unchanged**.
- `tests/budget-gate.test.ts`: the phantom-reference comment now points to a real file (tidy).

### Isolation contract (double-gated)
1. **Excluded** from `npm test`'s explicit 37-file list → never runs in the unit lane.
2. **Self-skips** unless `RUN_DB_TESTS=1` (set only by `.env.test` via `test:integration`). Unset → suite skips with a clear log line.

### Namespace + lifecycle
- `NS = \`test-int-${Date.now()}-${pid}\`` — unique per run; used as `project_id` / `task_id` and as the daemon name for daemon-budget rows.
- `before()`: seed the prerequisite `budget_tasks` row (NS ids, small `frozen_caps`).
- `after()` (in `finally`, ALWAYS runs): FK-safe DELETE for NS across all four tables — children before parents:
  `budget_task_events` → `budget_tasks`, then `daemon_budget_events` → `daemon_budget_buckets`.

### Assertions (must have teeth)
- **Task axis:** with a low cap, repeated `checkTaskBudget` accumulates and flips `allow → refuse` at the cap; `budget_task_events` rows recorded; running total monotonic.
- **Daemon axis:** `checkDaemonBudget` increments the current hour bucket; a second call sees the accumulated count; event rows recorded.
- **Enforcement-mode aware:** the refuse decision depends on `SCM_BUDGET_ENFORCEMENT_MODE` (off|warn|enforce). The test sets the mode it needs (or asserts the `decision` field accordingly) so it is deterministic regardless of ambient env.

## Definition of Done
- `npm run build` → 0 errors.
- `npm run test:integration` → green; exercises both axes against the real DB.
- `npm test` → unchanged (37 files), no new failures, no DB hits.
- Post-run: **0 residual rows** for any `test-int-*` namespace across all four tables.

## Out of scope (deferred)
Multi-suite integration framework, CI wiring, temp-schema DDL harness. Add later if more DB suites land (see backlog #311).
