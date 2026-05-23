// M8.3 Suite B — pure unit tests for single-level Louvain community
// detection. Operates on (source, target, weight) edge lists as produced
// by the kg_knn_pairs RPC; no Supabase, no Ollama, no fixtures on disk.
//
// Contract under test (src/clustering/louvain.ts):
//   louvain({ nodeCount, edges, seed?, resolution?, maxPasses? })
//     → { communities: Int32Array, modularity: number,
//         passes: number, communityCount: number }

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { louvain, type LouvainEdge } from "../src/clustering/louvain.js";

// ─── helpers ──────────────────────────────────────────────────────────────
function cliqueEdges(nodes: number[], weight = 1): LouvainEdge[] {
  const out: LouvainEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      out.push({ source: nodes[i], target: nodes[j], weight });
    }
  }
  return out;
}

function pathEdges(n: number): LouvainEdge[] {
  const out: LouvainEdge[] = [];
  for (let i = 0; i < n - 1; i++) out.push({ source: i, target: i + 1, weight: 1 });
  return out;
}

// ─── B1: single connected component collapses to one community ────────────
test("B1: K4 collapses to one community", () => {
  const res = louvain({ nodeCount: 4, edges: cliqueEdges([0, 1, 2, 3]), seed: 0 });
  assert.equal(res.communityCount, 1, `expected 1 community, got ${res.communityCount}`);
  for (let i = 0; i < 4; i++) assert.equal(res.communities[i], 0);
  // K4 modularity in 1 community is 0 (perfectly random against null model).
  assert.ok(Math.abs(res.modularity) < 1e-9, `Q should be 0, got ${res.modularity}`);
});

// ─── B2: two cleanly separated cliques recover two communities ────────────
test("B2: two K4 cliques + thin bridge yield 2 communities", () => {
  const edges: LouvainEdge[] = [
    ...cliqueEdges([0, 1, 2, 3]),
    ...cliqueEdges([4, 5, 6, 7]),
    { source: 3, target: 4, weight: 0.1 }, // intentionally weak bridge
  ];
  const res = louvain({ nodeCount: 8, edges, seed: 0 });
  assert.equal(res.communityCount, 2, `expected 2 communities, got ${res.communityCount}`);
  const c0 = res.communities[0];
  const c4 = res.communities[4];
  assert.notEqual(c0, c4, "the two cliques must end up in distinct communities");
  for (let i = 0; i < 4; i++) {
    assert.equal(res.communities[i], c0, `clique-A node ${i} must share community with node 0`);
  }
  for (let i = 4; i < 8; i++) {
    assert.equal(res.communities[i], c4, `clique-B node ${i} must share community with node 4`);
  }
  assert.ok(res.modularity > 0.3, `partitioned cliques must yield Q > 0.3, got ${res.modularity}`);
});

// ─── B3: path graph yields multi-cluster partition with positive Q ────────
test("B3: long path partitions into multiple communities with positive modularity", () => {
  const n = 12;
  const res = louvain({ nodeCount: n, edges: pathEdges(n), seed: 0 });
  assert.ok(
    res.communityCount >= 2 && res.communityCount < n,
    `expected 2..${n - 1} communities, got ${res.communityCount}`,
  );
  assert.ok(res.modularity > 0.2, `path graph Q must exceed 0.2, got ${res.modularity}`);
  // Communities must be a partition of 0..n-1 (every node assigned, ids dense)
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) seen.add(res.communities[i]);
  assert.equal(seen.size, res.communityCount, "communityCount must match distinct ids");
  for (const id of seen) {
    assert.ok(id >= 0 && id < res.communityCount, `community id ${id} out of dense range`);
  }
});

// ─── B4: nodeCount=0 throws; edges=[] yields clean singletons ─────────────
test("B4: nodeCount=0 throws; nodeCount>0 with no edges returns singletons", () => {
  assert.throws(
    () => louvain({ nodeCount: 0, edges: [] }),
    /nodeCount/i,
    "nodeCount=0 must throw",
  );
  const res = louvain({ nodeCount: 5, edges: [], seed: 0 });
  assert.equal(res.communityCount, 5, "no edges → every node is its own community");
  assert.equal(res.modularity, 0, "modularity of edgeless graph is 0 by definition");
  assert.equal(res.passes, 0, "no edges → no Phase-1 passes needed");
  for (let i = 0; i < 5; i++) assert.equal(res.communities[i], i, `singleton id ${i}`);
});

// ─── B5: self-loops in input do not affect the result ────────────────────
test("B5: self-loops are stripped and have no effect on output", () => {
  const baseEdges: LouvainEdge[] = [
    ...cliqueEdges([0, 1, 2]),
    ...cliqueEdges([3, 4, 5]),
    { source: 2, target: 3, weight: 0.5 },
  ];
  const withLoops: LouvainEdge[] = [
    ...baseEdges,
    { source: 0, target: 0, weight: 100 },
    { source: 5, target: 5, weight: 50 },
    { source: 3, target: 3, weight: 1e6 },
  ];
  const r1 = louvain({ nodeCount: 6, edges: baseEdges, seed: 0 });
  const r2 = louvain({ nodeCount: 6, edges: withLoops, seed: 0 });
  assert.equal(r1.communityCount, r2.communityCount);
  assert.deepEqual(
    Array.from(r1.communities),
    Array.from(r2.communities),
    "self-loops must not change community assignments",
  );
  assert.ok(
    Math.abs(r1.modularity - r2.modularity) < 1e-12,
    `self-loops must not shift modularity (delta=${r1.modularity - r2.modularity})`,
  );
});

// ─── B6: edge weights influence the community structure ──────────────────
test("B6: edge weight on the bridge edge changes the partition", () => {
  const buildEdges = (bridgeWeight: number): LouvainEdge[] => [
    ...cliqueEdges([0, 1, 2]),
    ...cliqueEdges([3, 4, 5]),
    { source: 2, target: 3, weight: bridgeWeight },
  ];
  const light = louvain({ nodeCount: 6, edges: buildEdges(0.05), seed: 0 });
  const heavy = louvain({ nodeCount: 6, edges: buildEdges(50), seed: 0 });

  // Light bridge: each triangle stays as its own community — 2 in total,
  // and the bridge endpoints (2,3) stay in their respective triangles.
  assert.equal(light.communityCount, 2, "weak bridge keeps the two triangles apart");
  assert.notEqual(
    light.communities[2],
    light.communities[3],
    "weak bridge: nodes 2 and 3 stay in their respective triangles",
  );

  // Heavy bridge: the bridge endpoints (2,3) MUST share a community — their
  // cross-edge weight dominates any same-triangle pull. The overall partition
  // necessarily differs from the light-bridge case (which is the point of B6).
  assert.equal(
    heavy.communities[2],
    heavy.communities[3],
    "heavy bridge pulls nodes 2 and 3 into the same community",
  );
  assert.notEqual(
    light.communityCount,
    heavy.communityCount,
    `weight matters: light/heavy partitions must differ ` +
      `(light=${light.communityCount}, heavy=${heavy.communityCount})`,
  );
});
