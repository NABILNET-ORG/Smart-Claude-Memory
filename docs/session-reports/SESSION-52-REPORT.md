# Session 52 — Report

- **Date:** 2026-06-05 → 2026-06-06
- **Branch:** `feat/s52-graph-rerank-fair-eval` → **PR #7**
- **Theme:** Fair, non-circular evaluation of the concept-bridge graph re-rank (Epic #372).
- **Outcome:** Trustworthy negative — **keep `SCM_GRAPH_RERANK_ENABLED = false`.**

## One-line outcome
Densified the KG, built an honest two-set eval, ran OFF vs ON — the data says *don't ship it ON*:
the rerank helps hard queries but regresses the well-served common case at α=0.7.

## Changes (4 commits)

| Commit | Phase | What |
|---|---|---|
| `933e154` | Spec | `docs/superpowers/specs/2026-06-05-graph-rerank-fair-eval-design.md` — re-scoped #372 after recon broke the CONCEPT premise (0 CONCEPT nodes; regex-only extractor; bridge RPC uses FILE/DECISION/SYMBOL only). |
| `eaa0f4d` | 1 — Backfill | `scripts/backfill-kg-extraction.ts` — reuses the daemon's regex extractor over a project-scoped id-cursor (the daemon's global anti-join starves single projects). Coverage **12.4% → 91.9%**, nodes 1061→4318 (SYMBOL 121→1237), edges 1362→8001. Boundary Invariant #1 preserved (no LLM in the extractor path). |
| `c41643f` | 2 — Fixtures | `scripts/gen-fair-fixture.ts` — synthesizes ship-gate 70 (control 45 @rank1-3 + lift 25 @rank4-40, **partitioned blind to bridges = non-circular**) + capability 5 (engineered bridges; telemetry only) via local gemma. |
| `0f4566f` | 3–4 — Eval + verdict | `scripts/eval-graph-rerank.ts` gains `SCM_EVAL_FIXTURE` + **per-partition** recall@3/MRR; verdict recorded in spec §8. |

## Results (definitive run — frozen inputs, rerank timeout lifted so the treatment fully executes)

Ship-gate (the only set that decides the flip):

| Metric | OFF | ON (α=0.7) | |
|---|---|---|---|
| overall recall@3 | 0.643 | 0.700 | ↑ |
| overall MRR | 0.540 | 0.472 | ✗ down |
| control recall@3 (n=45) | 1.000 | 0.956 | ✗ regressed |
| lift recall@3 (n=25) | 0.000 | 0.240 | ↑ (mechanism works) |

Capability telemetry (does not vote): recall@3 **0 → 1.0**.
Flip rule (recall@3 ↑ **AND** MRR not ↓ **AND** no control regression) → **fails 2/3 → keep OFF.**

## Decisions
- **SCM-S52-D1** — design: "fair eval first" (no CONCEPT-layer build); two-set methodology (ship-gate decides, capability is telemetry only); synthesize fixtures **blind to bridges** to stay non-circular. (Spec §2.)
- **SCM-S52-D3** — verdict: keep `SCM_GRAPH_RERANK_ENABLED = false` (spec §8). *(D2 was reserved for the flip, which did not happen.)*

## Hurdles & solutions
1. **Broken premise (recon).** #372 assumed densifying CONCEPT nodes would help; recon proved CONCEPT count = 0, the extractor is regex-only (can't produce them), the bridge RPC never queries CONCEPT, and the old S16 fixture was structurally unwinnable (golds rank >200, unanchored). → Re-scoped to a fair eval using the existing extractor + an honest fixture.
2. **Sub-agents orphaned long jobs (×2).** Delegated workers backgrounded the ~20–40 min generator and returned; the orphans finished ~1.5 h later and **clobbered the committed fixtures mid-eval** (ship-gate 70→81; capability→`[]`), corrupting the first two eval runs. git-bash `ps` couldn't see the native Windows processes. → Diagnosed/cleared via `Get-CimInstance Win32_Process`; ran the definitive eval against **frozen copies** at generator-immune paths; thereafter owned long jobs in the main session (orphan-proof `run_in_background`). (ERROR `55529`; promoted GLOBAL `55530`.)
3. **Silent `rerank_timeout` (the 51431 trap).** The ON arm hit the 1500 ms guard — densification pushed bridge_rows to ~878. → Re-ran with `SCM_GRAPH_RERANK_TIMEOUT_MS=30000` so the treatment fully executed; refused to render a verdict until it did. (Density↔latency is now a recorded trade-off for any future default-ON.)

## Memories
- **DECISION `55528`** (verdict), **ERROR `55529`** (orphan clobber) — local.
- **GLOBAL** promotions this session: `55229` (silent sub-RTT timeout masking a dead feature), `55230` (DB-side vs client-side truncation), `55530` (orphaned background sub-agent job clobbering shared artifacts).

## Backlog
- **#372** → **done** — investigation complete; decision SCM-S52-D3 (flag stays OFF).
- **#375** (P2, new) — "Re-evaluate graph-rerank under confidence-gating / non-demoting fusion; make α dynamic so the graph only intervenes when pure-vector confidence is low."

## Follow-ups
- **PR #7** awaits human review/merge. Production default unchanged (`SCM_GRAPH_RERANK_ENABLED=false`).
- Reusable infra delivered: `backfill-kg-extraction.ts`, `gen-fair-fixture.ts`, per-partition `eval-graph-rerank.ts`, ship-gate + capability fixtures.
- Future directions: spec §8 (confidence-gating, non-demoting fusion, bridge-fetch latency budget).
