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

  const ranked = U.map((r) => ({
    r,
    score: alpha * vNorm(r.similarity) + (1 - alpha) * gNorm(g.get(r.id) ?? 0),
  })).sort((a, b) => b.score - a.score);

  // SCM-S53 non-demoting anchor: pin the pure-vector top-1 to rank 1 so fusion
  // may reorder ranks 2+ to recover recall@3 without ever sacrificing the
  // strongest semantic anchor. (Pinning the full vector top-3 would LOCK the
  // recall@3 metric — graph could only ever reach rank 4; pinning only top-1
  // leaves slots 2-3 open for graph-recovered chunks. Trade-off: a graph-
  // recovered gold can reach rank 2 at best, capping its MRR contribution at
  // 0.5 — intentional; overall MRR then leans on the margin gate protecting
  // control.) No-op when candidates is empty (expansion-only union).
  // The anchor is the pure-vector top-1 = the highest-similarity candidate.
  // Resolve by MAX similarity (not positional [0]) so the pin is correct
  // regardless of input order — preserves the alpha=1 ≡ pure-vector invariant.
  // In production searchChunks is already similarity-desc, so this equals [0].
  const top = input.candidates.length
    ? input.candidates.reduce((best, c) => (c.similarity > best.similarity ? c : best))
    : undefined;
  if (!top) return ranked.map((x) => x.r);
  const anchorIdx = ranked.findIndex((x) => x.r.id === top.id);
  if (anchorIdx <= 0) return ranked.map((x) => x.r); // anchor already rank 1, or absent from union
  const [anchorEntry] = ranked.splice(anchorIdx, 1);
  return [anchorEntry.r, ...ranked.map((x) => x.r)];
}
