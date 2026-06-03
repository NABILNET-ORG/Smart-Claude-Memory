# Session 49 — BACKLOG ZERO

**Developer:** [NABILNET.AI](https://nabilnet.ai) · **Project:** Smart Claude Memory · **Date:** 2026-06-03

---

## Headline — Active Backlog = 0

All **three** Session-48-deferred backlog tasks were shipped, verified, committed, and archived this session. The Active Backlog is now **empty** for the first time in the project's tracked history.

| Metric | Before | After |
|---|---|---|
| Active Backlog items | 3 | **0** |
| Unit tests | 360 | **414** (+54) |
| Integration lane | none | **`npm run test:integration`** (budget + crawl) |
| New runtime dependencies | — | **0** |
| Commits (all on `origin/main`) | — | **4** |

Every integration run asserts **0 residual rows**. Build is clean. **Zero** new runtime dependencies were introduced.

---

## #311 — Zero-infra DB-integration test lane (SCM-S49-D1)

**Commits:** `2b10994`, `0629ae1`

The `tests/budget-integration.test.ts` referenced by a comment in `budget-gate.test.ts` never actually existed — it was a phantom reference. This session created it: real-DB, end-to-end coverage of `checkTaskBudget` / `checkDaemonBudget`.

**The constraint.** No separate or local database was available (no Docker, no local Postgres, no second Supabase project), and the budget gate runs through a single public-schema `supabase-js` singleton — so the integration test had to exercise the *shared dev DB* without contaminating it.

**The decision — disposable-namespace isolation.** Every row the test writes is keyed to a unique, per-run namespace: `project_id` / `task_id` / `daemon` all use `test-int-<timestamp>`. Teardown is FK-safe and wrapped in `try/finally` so it **always** runs, and (after the hardening commit) it **asserts** zero residual rows rather than merely logging the count. The lane is **double-gated**:

1. Excluded from `npm test`'s explicit file manifest, so the default suite never touches a live DB.
2. Self-skips unless `RUN_DB_TESTS=1`, which is supplied via `.env.test` through the new `test:integration` script using Node's native `--env-file` — **zero new dependencies**.

**Hardening (`0629ae1`).** Teardown now ASSERTS zero residual instead of only logging it — turning a silent-leak risk into a hard failure.

---

## #312 — Bounded docs crawler `crawl_docs` (SCM-S49-D2)

**Commit:** `52ec1b9`

A bounded, same-origin multi-page crawler that **composes** the Session-48 fetch engine rather than reinventing it. New modules:

| Module | Role |
|---|---|
| `src/web/links.ts` | **LOCKED fork** — zero-dep regex same-origin link extraction |
| `src/web/robots.ts` | **LOCKED fork** — standard `robots.txt` respect: Disallow/Allow longest-match + Crawl-delay |
| `src/web/ingest.ts` | Shared `ingestPage()` lifted from `research_url` (behavior-preserving) |
| `src/web/crawl.ts` | Pure, injectable BFS engine — depth / `max_pages` / per-domain bounds, visited dedup, in-house concurrency pool, politeness, deadline |
| `src/tools/crawl-docs.ts` | Per-link `assertSafeUrl` reuse + budget-gated embeds via `checkDaemonBudget` |

**Tests.** +46 unit tests (links / robots / crawl) plus a crawl integration test that fetches a fixture and runs the **real** `extractLinks` / `ingestPage` paths, PID-isolated, asserting 0 residual rows.

**Review.** Code-reviewed end-to-end: the SSRF chain was verified (every link re-validated through `assertSafeUrl`), and re-crawl is idempotent. `max_pages` bounds **attempts** (documented as the resource/politeness budget, not a guaranteed page yield).

---

## #300 — Kanban intra-column drag-to-reorder (SCM-S49-D3)

**Commit:** `5392c67`

Intra-column card reordering for the Active Backlog Kanban — **no schema migration**. A fractional `rank` lives inside the existing `cloud_backlog.metadata` jsonb column.

- **Backend.** `sortColumn` orders each column by `effectiveKey = metadata.rank` when finite, otherwise falling back to the legacy `(priority, created_at)` index. `PATCH /api/backlog/:id` accepts `{ rank }` via a read-merge-write (`getBacklogRow`) that preserves all other metadata.
- **Frontend.** `getDragAfterElement` drives a live drop preview; the new rank is the fractional midpoint of its neighbours, computed with the **same** legacy-index fallback the server uses — so a card dropped between two unranked neighbours lands exactly between them. Moves are optimistic, with an exact `dragstart`-captured revert on PATCH failure.
- **Tests.** +8.

---

## Sovereign Scout

The **"namespace-isolation-on-a-shared-DB"** zero-infra integration-testing pattern was promoted to the **GLOBAL** vault (memory id **40920**) — it passes the Cross-Project Test (any project sharing a single dev DB can reuse it).

## Constitution drift

Left at **v2.1.8** per the Session 47 decision (explicit NO). `upgrade_constitution` was **not** run.

---

## Hurdles & Solutions

| Hurdle | Solution |
|---|---|
| No separate test DB available | Disposable-namespace isolation + asserted FK-safe teardown on the shared dev DB (now a GLOBAL pattern). |
| `budget_tasks.task_id` is a uuid PK | Used `project_id = NS` + `randomUUID()` for `task_id` (schema-faithful); teardown keyed on `project_id = NS`. |
| Integration teardowns logged but didn't assert residual | Now assert **0** residual (hardening commit `0629ae1`). |
| `robots` `patternToRegExp` sentinel was an invisible U+00A0 (NBSP) | Documented to prevent accidental retyping; confirmed it already prevents the "literal space → wildcard" bug. |
| `crawl_docs` `max_pages` ambiguity | Documented as bounding **fetch attempts** (resource / politeness budget). |
| `app.js` is browser JS (not tsc-checked) | Verified by line-by-line code review. |

---

## Decision IDs

- **SCM-S49-D1** — zero-infra DB-integration test lane
- **SCM-S49-D2** — bounded docs crawler
- **SCM-S49-D3** — kanban fractional `rank` reorder

**Memory rows:** `40919` (D1 + D2), `40920` (GLOBAL pattern), `40959` (D3).

---

## Commit Ledger

| SHA | Summary |
|---|---|
| `2b10994` | test: create isolated DB-integration lane for budget gate (#311) |
| `0629ae1` | test: assert zero residual in budget-integration teardown (#311 hardening) |
| `52ec1b9` | feat(tools): add multi-page docs crawler (#312) |
| `5392c67` | feat(ui): add intra-column drag-to-reorder for kanban (#300) |

All four commits are on `origin/main`.
