// src/tools/metrics.ts — pure retrieval metrics for the SCM-S50 eval harness.

/** 1 if the gold chunk id is within the top-k of the ranked list, else 0. */
export function recallAtK(rankedIds: number[], goldId: number, k: number): number {
  return rankedIds.slice(0, k).includes(goldId) ? 1 : 0;
}

/** Reciprocal rank of the gold chunk id (1-indexed); 0 if absent. */
export function mrr(rankedIds: number[], goldId: number): number {
  const i = rankedIds.indexOf(goldId);
  return i < 0 ? 0 : 1 / (i + 1);
}
