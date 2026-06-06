# Session 53 Report — Graph-Rerank: Confidence-Gated / Non-Demoting Hybrid

**Date:** 2026-06-06
**Branch:** `feat/s52-graph-rerank-fair-eval`
**Epic:** #375 — Re-evaluate graph-rerank under confidence-gating / non-demoting fusion (closed)
**Decision:** `SCM-S53-D1` (memory id 56850)
**Feature commit:** `a309e1f`

---

## Outcome (TL;DR)

Built and **rigorously proved** a confidence-gated, non-demoting graph-rerank hybrid — then **consciously kept it OFF**. The mechanism recovers the hard tail (lift + capability) but cannot beat a corpus-level **control/lift margin overlap** without regressing well-served queries. The only configuration that clears the strict flip rule (`T=0.003`) is a degenerate, drift-fragile artifact (+1/25 lift, +0.0009 MRR) and was rejected as overfitting. Code is **merged, flag-gated OFF** as dormant infrastructure for future corpora / embedding models.

## Design (reframed)

Epic asked to "make α dynamic." We reframed to the simpler, safer **static-α + dynamic-engagement** model:
- **Binary margin gate** (`src/tools/search.ts`): skip the graph bridge when the pure-vector neighborhood is *peaked* — `vTop1 − vTop2 ≥ SCM_GRAPH_MARGIN_THRESHOLD` (confident ⇒ don't touch). Flat neighborhood ⇒ engage the graph.
- **Top-1 non-demoting pin** (`src/tools/rerank.ts`): anchor the max-similarity candidate to rank 1; the graph may only reorder ranks 2+. (Pinning the full top-3 would lock `recall@3`.)
- **Config** (`src/config.ts`): `SCM_GRAPH_MARGIN_THRESHOLD` (default `0.02`). `SCM_GRAPH_RERANK_ENABLED` stays `false`.

## Calibration → Evaluation (measure-first)

1. **Probe v1** (`scripts/probe-confidence-threshold.ts`) — **falsified** absolute top-1 similarity as a gate signal: control vs lift medians `0.7131` vs `0.6941` (1.03×), no gap. `nomic-embed` packs everything into ~0.61–0.83. A guessed `0.82` would have protected ~0 control.
2. **Probe v2** (`scripts/probe-margin-signal.ts`) — the **abs margin** `top1−top2` *is* a real signal (control 1.79× higher at median, 3.1× at p75; abs ≥ rel and simpler) but still `clean_gap=false` — overlap in the 0.003–0.05 band.
3. **Eval** (`scripts/eval-graph-rerank.ts`, frozen S52 fixtures, `TIMEOUT_MS=30000`) at `T=0.02`/α=0.7:

   | partition | OFF | ON | Δ |
   |---|---|---|---|
   | control recall@3 | 0.8444 | 0.8000 | **−0.044** ✗ |
   | lift recall@3 | 0.0 | 0.16 | +0.16 ✓ |
   | overall MRR | 0.4793 | 0.4716 | **−0.0077** ✗ |
   | capability recall@3 | 0.0 | 0.40 | +0.40 |

4. **Per-query trace** (`scripts/trace-control-regressors.ts`) — the 2 control regressors sit at margins **0.0033 / 0.0059** (vector rank 2→4, 3→8), *co-located* with the lift queries. The pin only protects rank 1, not rank-2/3 golds.
5. **Threshold × α sweep** (`scripts/sweep-report.ts`) — only `T=0.003`/α=0.7 passes, **degenerately** (+1/25 lift, +0.0009 MRR, control exactly flat). Every meaningful-engagement config (`T≥0.005`) regresses control; α=0.9 softens (−0.022) but still fails.

## Hurdles → Solutions

- **Absolute-similarity gate looked obvious but was a trap.** Probe v1 killed it before any code — saved shipping a useless/destructive gate.
- **Latent pin bug** caught by the `alpha=1 ≡ pure-vector` unit test: the pin anchored positional `candidates[0]` instead of the max-similarity row, breaking the invariant on unsorted input. Fixed to anchor by max similarity.
- **3 unit tests asserted the old *demoting* behavior** (graph chunk reaching rank 1). Reconciled to the SCM-S53 non-demoting contract (chunk lifts to rank 2, top-1 pinned). Full suite **437/437** green; `tsc` + `npm run build` clean.
- **A degenerate flip-rule pass** (`T=0.003`) tempted a false "win." Recognized as overfitting / p-hacking on a drifting DB → rejected.

## Open caveat

**Live-DB drift vs frozen fixtures:** baseline control recall@3 moved `1.0` (S52) → `0.8444` (now). The OFF-vs-ON comparison stays valid (same DB both runs), but **re-freeze the fixtures or explain the drift** before any future graph-rerank eval.

## Artifacts

- Memory `SCM-S53-D1` (id 56850, type DECISION)
- Commit `a309e1f` — config + gate + pin + tests + calibration toolkit (4 scripts)
- Files: `src/config.ts`, `src/tools/search.ts`, `src/tools/rerank.ts`, `tests/rerank.test.ts`, `tests/search-rerank.test.ts`, `scripts/{probe-confidence-threshold,probe-margin-signal,trace-control-regressors,sweep-report}.ts`
