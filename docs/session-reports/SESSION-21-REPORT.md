# Session 21 — M5 Autonomous Curriculum Shipped — Agentic OS 2026 Loop Closed

**Date.** 2026-05-12
**Mission.** Agentic OS 2026 Mission 5 (backlog #115, P4 — final). Close the loop: a deterministic queuer enqueues curriculum tasks, the Orchestrator (Claude) is the sole executor, and verified tasks atomically trigger M3 auto-promotion — the only sanctioned path to flip `SLEEP_LEARNER_AUTO_PROMOTE`.
**Status.** Shipped + verified end-to-end. Migration 015 applied, 4 MCP tools registered, daemon wired into boot, smoke test GREEN with 8 assertions across the full enqueue → pull → checkpoint → apply → auto-promote path. Backlog now empty — Agentic OS 2026 mission set complete.

---

## 1. What changed

### 1.1 Sovereign Decisions

- **SCM-S21-D1** — **Single-Brain Closure.** The architecture review enforced three mandates on the M5 design *before* code was written: (1) the curriculum daemon contains zero generative AI (no Ollama, no @anthropic-ai, no openai); (2) the Orchestrator (Claude) is the sole executor of any code-touching work — the daemon writes only to `curriculum_tasks` rows; (3) M5 is the only mission permitted to fire `promote_candidate_to_skill` outside of M3's manual path, and even that fires only inside one atomic SQL transaction. The boundary invariants are CI-enforceable: lint fence (no LLM imports in `src/curriculum/**`) + grep audit (exactly one TS call site for `supabase.rpc("promote_candidate_to_skill", ...)`, in `sleep.ts`). Both passed.

- **SCM-S21-D2** — **GLOBAL PATTERN: PG `RETURNS TABLE` OUT params shadow column names.** Caught mid-smoke when `pull_next_curriculum_task` raised `column reference "project_id" is ambiguous`. The fix is to always alias the table inside the function body (`from public.curriculum_tasks ct where ct.project_id = ...`) or use `RETURNS SETOF <table>` instead. The CREATE FUNCTION step never fails on this — invocation is the only reliable verifier. Saved as GLOBAL because it bites every Postgres/Supabase project, not just this one.

### 1.2 Files created

- `scripts/015_curriculum_tasks.sql` (304 lines) — `curriculum_tasks` table + 3 RPCs (`enqueue_curriculum_task`, `pull_next_curriculum_task` with `FOR UPDATE SKIP LOCKED`, `apply_curriculum_task` with atomic auto-promote). Partial UNIQUE index on (project_id, target_path, kind) WHERE status='queued' for idempotent enqueue. RLS `deny_anon_authenticated` mirrors 006/010/011/012/014. All RPCs `SECURITY DEFINER` with `search_path` including `'extensions'`.

- `src/curriculum/scanner.ts` (256 lines) — three deterministic signal sources:
  - `scanTestGaps()` reads `coverage/coverage-summary.json` (optional), enqueues files with `pct < ceiling AND lines > min`.
  - `scanRollbackHotspots()` aggregates `workflow_checkpoints WHERE status='rolledback'` in the last 30 days, threshold ≥ 3.
  - `scanStaleCandidates()` selects `skill_candidates WHERE state='mined' AND frequency ≥ N AND created_at < now() - 7d`. **Only** this source sets `linked_candidate_id` — the M3 auto-promote bridge.

- `src/curriculum/daemon.ts` (174 lines) — interval-based runner. Mirrors `src/sleep/daemon.ts` shape exactly: module-level state, `.unref()`'d interval, re-entrancy guard, try/finally tick. Env knobs: `CURRICULUM_INTERVAL_MS=3600000`, `CURRICULUM_BATCH=10`, `CURRICULUM_MIN_FREQ=3`, `CURRICULUM_TTL_DAYS=14`. Deliberately omits any `_MODEL` / `_PROPOSER` env — there is no generation surface to configure.

- `src/tools/curriculum.ts` (267 lines) — 4 MCP tools: `list_curriculum_tasks`, `pull_curriculum_task`, `apply_curriculum_task`, `reject_curriculum_task`. `apply` checks `verification-pending.json` absence via `getPending()` before calling the SQL RPC (escape hatch: `bypass_verification_gate: true` for tooling/smoke).

- `scripts/smoke-m5.ts` (231 lines) — end-to-end repeatable smoke. Seeds mock candidate → enqueues → pulls → opens+commits checkpoint → applies → asserts atomic auto-promote landed in `agent_skills` → cleans up. Eight assertions; all pass.

- `docs/session-reports/SESSION-21-REPORT.md` — this file.

### 1.3 Files modified

- `ARCHITECTURE.md` — inserted §4.7 "Autonomous Curriculum — Single-Brain Closure" (Mermaid lifecycle + TECH_STACK + boundary invariants).
- `src/index.ts` — 4 new tool registrations + `startCurriculumDaemon()` boot.
- `src/tools/health.ts` — added `curriculum_scanner` health block in `HealthReport` + `checkSystemHealth` return.

---

## 2. Hurdles + solutions

1. **PG ambiguity in `pull_next_curriculum_task`.** First smoke failed at the pull step with `column reference "project_id" is ambiguous`. Root cause: `RETURNS TABLE (id bigint, project_id text, ...)` declares OUT parameters that live in the same name space as table columns inside the function body. Fix: alias the table as `ct` and qualify every column reference. The migration uses `DROP FUNCTION IF EXISTS` + `CREATE FUNCTION`, so re-applying in place (pre-commit) was safe and preserved the immutability spirit (no committed history was retroactively edited). Now saved as a GLOBAL pattern (SCM-S21-D2).

2. **`memory_chunks.embedding NOT NULL` blocked the smoke's stub-chunk approach.** The smoke originally tried to fabricate a memory_chunks row to anchor the M4 checkpoint. Refused to write a 768-dim zero vector (would pollute search). Pivoted to selecting any existing project chunk as the anchor — the M4 checkpoint binding only needs `source_chunk_id NOT NULL` on commit, no semantic constraint on the row's content.

3. **`memory_chunks` column name drift.** The smoke assumed a `source` column; the actual schema uses `file_origin` + `content_hash` + `embedding` (with `embedding` NOT NULL). Resolved by querying the real schema before adapting the smoke (kept under context budget via `ctx_execute`).

4. **Single Brain mandate retroactively flagged M3 `proposer.ts`.** M3's existing daemon uses `gemma4:e2b` to generate skill names/steps inside the daemon — predates the M5 mandate. Per surgical-edit rule, M5 does NOT touch it; flagged as a forward remediation pass in ARCHITECTURE.md §4.7.

---

## 3. Verification trail

1. **TS build** — `npm run build` → zero errors first try after wiring health + index.
2. **Boundary Invariant #1 (lint fence)** — `0 violations across 2 files in src/curriculum/`. No imports from `ollama`, `@anthropic-ai/*`, `openai`. No `/generate` `/chat` `/completions` URL patterns.
3. **Boundary Invariant #2 (audit)** — strict pattern `\.rpc\(\s*["']promote_candidate_to_skill["']` matched exactly 1 TS call site: `src/tools/sleep.ts:140` (M3 manual promotion). Zero hits in `src/curriculum/*`. The curriculum path goes through `apply_curriculum_task` RPC, which calls `promote_candidate_to_skill` *inside SQL* — the boundary holds.
4. **Migration 015** — `npx tsx scripts/apply-schema.ts 015_curriculum_tasks.sql` → "Schema applied." (twice: first apply revealed the OUT-param shadowing bug; second apply was the patched DROP+CREATE).
5. **End-to-end smoke** — `npx tsx scripts/smoke-m5.ts` → GREEN. 8 assertions:
   - enqueue returns one row + is_new=true
   - pull returns one row, claims our task, flips to 'pulled', carries linked_candidate_id
   - apply returns one row, status='verified', pins linked_checkpoint_id, fires auto-promote with the correct candidate_id, returns a real skill_id
   - persistence check: curriculum_tasks.status='verified', skill_candidates.state='promoted' + promoted_skill_id wired, agent_skills row exists with correct name and v1.
   - Cleanup deletes the four created rows; smoke is repeatable.

---

## 4. Curator invariant (do not regress)

- **`src/curriculum/**` MUST remain LLM-free.** The CI lint fence is the contract. If a future feature needs to enrich a curriculum task with LLM-generated text, that work happens *in the Orchestrator session* via existing tools — never inside the daemon module.
- **`promote_candidate_to_skill` TS call sites MUST remain at exactly ONE.** Any second TS-level call is a regression. The boundary lives in SQL: `apply_curriculum_task` RPC and the M3 `promote_skill_candidate` tool are the only two paths.
- **M3's `SLEEP_LEARNER_AUTO_PROMOTE` env knob MUST remain default `false`.** M5 does NOT flip this globally; auto-promote is scoped to the one SQL transaction inside `apply_curriculum_task`.

---

## 5. Open items / next session

- **M3 `proposer.ts` remediation.** M3's daemon still calls Ollama `gemma4:e2b` to generate skill name + steps inside the background. The Single Brain mandate retroactively flags this. A future session should strip `proposer.ts`, replace the daemon's "propose" step with a deterministic `proposed_name` derivation (e.g. `pattern_hash` slice or first-frequent-token n-gram), and let the Orchestrator author the final `name` + `description` + `trigger_keywords` at promote time. Out of M5 scope; non-blocking.
- **CI integration of the lint fences.** The Boundary Invariant audits run today via ad-hoc Node scripts. A CI step (`npm run lint:curriculum`) would make regressions hard-blocking. Small follow-up.
- **Coverage signal opt-in.** `scanTestGaps()` only fires when `coverage/coverage-summary.json` exists. The repo doesn't currently emit one. A future session could add `npm test -- --coverage` to the release flow or wire `c8` to make the signal live.
- **Backlog is empty.** All five Agentic OS 2026 missions are shipped. Next session has no carryover work; the door is open for new product directions or hardening passes.
