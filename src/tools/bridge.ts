// src/tools/bridge.ts — concept-bridge helpers for graph-aware re-rank (SCM-S50).
// Pure: no I/O, no LLM.
import type { KgSeed, KgNeighbor } from "./kg.js";

/**
 * Weighted query-concept set C.
 *   W(k) = Σ over neighbor entries with node id k of  σ[via_seed] · edge_weight
 * A concept mentioned by several seeds accumulates their weighted contributions.
 * Neighbors whose via_node_id is not among the seeds are ignored.
 */
export function conceptWeights(seeds: KgSeed[], neighbors: KgNeighbor[]): Map<number, number> {
  const sigma = new Map<number, number>(seeds.map((s) => [s.id, s.similarity]));
  const W = new Map<number, number>();
  for (const n of neighbors) {
    const s = sigma.get(n.via_node_id);
    if (s === undefined) continue;
    W.set(n.id, (W.get(n.id) ?? 0) + s * n.weight);
  }
  return W;
}
