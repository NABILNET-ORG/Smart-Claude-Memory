# Session 54 Report — LLM-as-a-Judge Listwise Reranker (qwen + non-demoting pin)

## Outcome (TL;DR)

Shipped a confidence-gated, **server-side LLM listwise reranker** as the precision layer over nomic-embed recall, and **enabled it by default** with `qwen3-coder:480b-cloud` + a non-demoting top-1 pin — after a drift-controlled bake-off. This is the **first rerank mechanism to clear the strict S52/S53 flip-rule** (the concept-bridge graph rerank stays OFF). Session also opened by closing out the S52/S53 graph-rerank branch (fast-forward merged to `main`, secured on origin).

## What shipped

- **`src/tools/llm-rerank.ts`** (new): listwise rerank. Candidates labeled `[1..N]`; the server `chat()` LLM returns an index permutation `{"ranking":[...]}` (Ollama `format:json`, temperature 0); `parseAndHealRanking` tolerantly extracts JSON, drops hallucinated/out-of-range indices, appends missing ones in original vector order; **non-demoting top-1 pin** (`pinMaxSimilarity`) anchors the max-similarity candidate at rank 1 (LLM may only reorder ranks 2+). Strict fallback to pure vector order on parse-fail/timeout/budget-block; never drops or duplicates. Returns `{ranked, outcome, latencyMs, firedModel}`.
- **`src/tools/search.ts`**: wired at the existing rerank seam; fires ONLY on flat-margin (low-confidence) queries (reuses `SCM_GRAPH_MARGIN_THRESHOLD`); routed through the budget gate (`checkDaemonBudget`); mutually exclusive with graph rerank; OFF path identical to before.
- **`src/config.ts`**: `SCM_LLM_RERANK_ENABLED` (true), `SCM_RERANK_MODEL` (`qwen3-coder:480b-cloud`), `SCM_LLM_RERANK_PIN_TOP1` (true), `SCM_LLM_RERANK_POOL` (12), `SCM_LLM_RERANK_SNIPPET` (400), `SCM_LLM_RERANK_TIMEOUT_MS` (8000).
- **`src/ollama.ts`**: `chat()` gained a backward-compatible `format` option (`json` / schema).
- **`scripts/bakeoff-llm-rerank.ts`** (new): drift-controlled freeze→replay bake-off harness.

## Bake-off (drift-controlled)

Initial **live** runs were confounded by corpus drift — caught when `llm_fired` changed 40→42 across runs (the margin gate is pre-rerank, so any change proves the recall/DB moved under us). Fix: a **freeze→replay** harness froze the vector recall once, then replayed all conditions (vector / LLM-no-pin / LLM-pin) against the identical snapshot from a single LLM call per query. This is the structural answer to the S53 open caveat (live-DB drift).

Frozen results (70 queries, 42 fired, pin ON):

| metric | vector | qwen + pin | minimax + pin |
|---|---|---|---|
| overall recall@3 | 0.500 | 0.586 (+0.086) | 0.600 (+0.100) |
| overall MRR | 0.465 | 0.490 | 0.499 |
| control recall@3 (n=45) | 0.733 | 0.756 ✓ | 0.756 ✓ |
| lift recall@3 (n=25) | 0.08 | 0.28 | 0.32 |
| avg latency / call | — | ~1.5s | ~16.9s |
| parse-fail rate | — | 0% | 7.1% |

Both clear the flip-rule. **Chose qwen** (SCM-S54-D2): for a per-search hot path, 1.5s + 0% structured-output failure decisively beat minimax's marginal +1-query lift at ~11× latency + 7.1% JSON failure. Reliability + speed + structural integrity (the pin) over a marginal reasoning edge.

## Hurdles → Solutions

- **Small local model (`gemma4:e2b`) unusable** — 100% timeout/fallback at an 8s budget. Disqualified; confirms only a capable model handles strict listwise JSON within a hot-path budget.
- **Live-DB drift confound** — cross-run numbers were invalid (control appeared to "regress" from drift, not the pin). Solution: the freeze→replay harness; the `llm_fired` 40→42 tell was the smoking gun.
- **The pin's value was hidden by drift** — measured drift-free, the non-demoting pin converts qwen's lone control regression (no-pin 0.733→0.711) into **+1** (0.756), which is exactly what clears the flip-rule.
- **Flipping the default ON broke OFF-assuming tests** — reconciled so each test explicitly pins the flag state (mutable module-mock), preserving the `disabled ⇒ pure-vector` coverage and proving `chat()` never fires when disabled.

## Decisions

- **SCM-S54-D1** — architecture: server-side LLM listwise reranker; index-permutation JSON; flat-margin gated; budget-gated; default model chosen by eval.
- **SCM-S54-D2** — verdict: `qwen3-coder:480b-cloud` + non-demoting pin, **ENABLED by default**, chosen over `minimax-m3:cloud` on latency + structured-output reliability.

## Artifacts

- Branch `feat/s54-llm-rerank`; feature commit `5b99fe3`. Build clean + **465/465 tests** green.
- New: `src/tools/llm-rerank.ts`, `scripts/bakeoff-llm-rerank.ts`, `tests/llm-rerank.test.ts`.
- Docs: README env-var reference (6 new knobs), ARCHITECTURE §4.1.1 (rerank stage + flow).
