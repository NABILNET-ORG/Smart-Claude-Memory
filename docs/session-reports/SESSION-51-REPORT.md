# Session 51 Report — Smart Claude Memory

**Date:** 2026-06-05
**Branch:** `feat/graph-aware-retrieval` → merged & pushed to `origin/main` (`b6a26bb..30a7668`)
**Theme:** Secure Epic A at the finish line (concept-bridge ship-gate) and clear two broken windows — every fix driven by root-cause analysis.

---

## Outcome

| Item | Result |
|---|---|
| Epic A graph-rerank ship-gate | **Resolved — default stays OFF** (correctly *not* flipped) |
| #342 GUI browser-fatigue | **Fixed** (recency-marker guard) |
| #371 flaky clustering smoke C8 | **Fixed** (server-side DISTINCT RPC) |
| Full suite | **437 pass / 0 fail** (111 suites) |
| Integration | merged to `main`, pushed to `origin/main` |

**Headline:** two latent *production* bugs were hiding behind surface symptoms — a feature that secretly never ran (mistaken for "no recall lift") and a project-discovery scan that silently truncates (mistaken for a "flaky test"). Root-cause analysis surfaced both.

## Commits

| Commit | Summary |
|---|---|
| `fddbfb8` | `fix(search)`: graph-rerank timeout 50→1500ms + surface the swallowed bridge error |
| `2800a34` | `test(eval)`: EVAL_VERBOSE per-query harness + 6-query S16-D1 baseline fixture |
| `1e15827` | `fix(gui)`: recency-marker guard kills cross-session browser fatigue (#342) |
| `30a7668` | `fix(clustering)`: server-side DISTINCT RPC (migration 028) + de-flake C8 (#371) |

## Changes & Hurdles → Solutions

### 1. Epic A ship-gate (SCM-S51)
- **Hurdle:** the proposed eval fixture was unusable — 4 of 10 gold ids did not exist in `memory_chunks`, and the 10 "queries" were only labels `q1`…`q10` (never authored).
- **Root cause:** with a real 6-query fixture, OFF == ON (recall 0/0). Instrumenting the bare `catch {}` revealed `rerank_timeout`: `SCM_GRAPH_RERANK_TIMEOUT_MS=50ms` sat below measured Supabase RTT (167-213ms), so the concept-bridge rerank **never executed** in any real environment.
- **Solution:** raised the timeout default to 1500ms (`fddbfb8`). Confirmed retrieval is healthy (near-verbatim golds rank 1-2) and bridges exist (72 / 14 rows). Even when running, the hand-authored queries showed no lift → **did not flip the flag** (refused to P-hack a passing gate). Bridge-aware "Goldilocks" eval + KG densification deferred to backlog **#372**.

### 2. #342 — GUI browser-fatigue
- **Diagnosis:** the "stale 7788 probe" lead was a red herring. The GUI is an in-process HTTP server that dies with the MCP process; `probePort` only catches *concurrent* sessions, so a fresh tab opened on every sequential session. (7788 is the legacy no-project default — nothing listens there; the per-project port is a stable SHA-256 hash → 7814.)
- **Solution (TDD):** a per-port recency marker (`~/.claude-memory/gui-open-marker.json`, 12h TTL, override via `SCM_GUI_OPEN_TTL_MS`) gates the auto-open. The stable port lets an existing tab reconnect on refresh. 7 unit tests (`1e15827`).

### 3. #371 — flaky clustering smoke C8
- **Diagnosis:** two flaky assertions. (a) `discoverProjects` pulled ≤5000 *unordered* `kg_nodes` rows and de-duped in Node — once the global embedded-node count exceeds 5000, the arbitrary window can omit a live project (a latent **round-robin production bug** surfacing as a flaky test). (b) `assert(duration_ms < 10_000)` — a wall-clock perf gate inside a correctness smoke.
- **Solution:** migration **028** adds `clustering_discover_projects()` (server-side `SELECT DISTINCT`); the daemon calls the RPC, dropping the `limit(5000)` + JS dedup; removed the perf assertion. Verified 8/8 on two consecutive runs (`30a7668`).

## Institutionalized learnings
- ERROR memory **51431** — a silent `Promise.race` timeout below DB RTT hid a dead-on-arrival feature behind a passing (instant-mock) unit test.
- ERROR memory **51432** — `.limit(5000)` + client-side dedup → silent truncation; perf assertions do not belong in correctness tests.
- Backlog **#372** (P2) — densify KG + build a bridge-aware eval to unlock `SCM_GRAPH_RERANK_ENABLED`.

## Doc hygiene
- Removed 4 phantom gold ids from the Session-50 Ship-Gate table + recorded the truthful outcome.
- Pre-flight audit fixes: migration count 27→28 (README + ARCHITECTURE surface lines); repaired the README `#bootstrap` anchor.

## Verification
- `npm run build` clean throughout; full `npm test` = **437 pass / 0 fail** across 111 suites before the merge to `main`.
