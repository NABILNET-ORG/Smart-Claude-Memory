// src/tools/rerank.ts — concept-bridge fusion scorer (SCM-S50). Pure: no I/O.
import type { MatchRow, BridgeRow } from "../supabase.js";

export interface RerankParams {
  alpha: number; // vector vs graph weight; alpha=1 ≡ pure vector (non-regression boundary)
}

export interface RerankInput {
  candidates: MatchRow[]; // vector top-N
  expansion: MatchRow[]; // recall-recovered chunks (already scored vs query)
  conceptWeights: Map<number, number>; // W(k) for the query's concept set C
  bridge: BridgeRow[]; // (concept_id, chunk_id, edge weight) rows
  params: RerankParams;
}

/** g_raw(c) = Σ over bridge rows (k,c,w_ck), k ∈ C of  W(k) · w_ck. */
function graphScoreByChunk(bridge: BridgeRow[], W: Map<number, number>): Map<number, number> {
  const g = new Map<number, number>();
  for (const b of bridge) {
    const wk = W.get(b.concept_id);
    if (wk === undefined) continue; // concept not in the query set C
    g.set(b.chunk_id, (g.get(b.chunk_id) ?? 0) + wk * b.w_ck);
  }
  return g;
}

/** Min-max normalizer over xs; collapses to 1 when flat (no differentiation). */
function minmax(xs: number[]): (x: number) => number {
  if (!xs.length) return () => 0;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return (x) => (hi - lo < 1e-9 ? 1 : (x - lo) / (hi - lo));
}

/** score(c) = α·v(c) + (1−α)·g(c) over the candidate ∪ expansion union; sorted desc. */
export function rerank(input: RerankInput): MatchRow[] {
  const byId = new Map<number, MatchRow>();
  for (const r of [...input.candidates, ...input.expansion]) byId.set(r.id, r); // dedupe union
  const U = [...byId.values()];
  if (!U.length) return [];

  const g = graphScoreByChunk(input.bridge, input.conceptWeights);
  const vNorm = minmax(U.map((r) => r.similarity));
  const gNorm = minmax(U.map((r) => g.get(r.id) ?? 0));
  const { alpha } = input.params;

  return U.map((r) => ({
    r,
    score: alpha * vNorm(r.similarity) + (1 - alpha) * gNorm(g.get(r.id) ?? 0),
  }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}
