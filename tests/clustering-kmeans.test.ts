// M8.3 Suite A — pure unit tests for the spherical mini-batch k-means used
// to build coarse "Super Node" clusters over kg_nodes.embedding.
//
// Pure means: no Supabase, no Ollama, no fixtures on disk. Every input is
// constructed in-process from a seeded PRNG so the suite is deterministic
// and CI-stable.
//
// Contract under test (src/clustering/kmeans.ts):
//   kmeans(points, { k, seed?, maxIters?, miniBatchSize?, tolerance? })
//     → { assignments: Int32Array, centroids: Float32Array[],
//         iterations: number, converged: boolean, effectiveK: number }

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { kmeans } from "../src/clustering/kmeans.js";

// ─── deterministic PRNG (mulberry32) ──────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────
function f32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

function randn(rng: () => number): number {
  // Box-Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeGaussianCluster(
  rng: () => number,
  center: number[],
  sigma: number,
  n: number,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const p = new Float32Array(center.length);
    for (let d = 0; d < center.length; d++) p[d] = center[d] + sigma * randn(rng);
    out.push(p);
  }
  return out;
}

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Greedy centroid matching: for each centroid in `a`, find the nearest in
// `b` (on the unit sphere, where the algorithm operates) and report the
// max pairwise distance. Used by A7 to compare two runs.
function maxMatchedDistance(
  a: Float32Array[],
  b: Float32Array[],
): number {
  assert.equal(a.length, b.length);
  const used = new Set<number>();
  let worst = 0;
  for (const ca of a) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < b.length; j++) {
      if (used.has(j)) continue;
      const d = l2(normalize(ca), normalize(b[j]));
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    used.add(bestIdx);
    if (bestDist > worst) worst = bestDist;
  }
  return worst;
}

// ─── A1: deterministic with seed ──────────────────────────────────────────
test("A1: deterministic with seed", () => {
  const rng = mulberry32(7);
  const points: Float32Array[] = [];
  for (let i = 0; i < 60; i++) {
    const p = new Float32Array(8);
    for (let d = 0; d < 8; d++) p[d] = randn(rng);
    points.push(p);
  }

  const r1 = kmeans(points, { k: 5, seed: 123, maxIters: 30 });
  const r2 = kmeans(points, { k: 5, seed: 123, maxIters: 30 });

  assert.deepEqual(Array.from(r1.assignments), Array.from(r2.assignments));
  assert.equal(r1.iterations, r2.iterations);
  assert.equal(r1.centroids.length, r2.centroids.length);
  for (let c = 0; c < r1.centroids.length; c++) {
    assert.deepEqual(Array.from(r1.centroids[c]), Array.from(r2.centroids[c]));
  }

  const r3 = kmeans(points, { k: 5, seed: 999, maxIters: 30 });
  // Different seed → at least one differing assignment is expected.
  assert.notDeepEqual(Array.from(r1.assignments), Array.from(r3.assignments));
});

// ─── A2: converges in ≤ maxIters ──────────────────────────────────────────
test("A2: converges in <= maxIters and reports iteration count", () => {
  const rng = mulberry32(11);
  const points = [
    ...makeGaussianCluster(rng, [3, 0], 0.05, 30),
    ...makeGaussianCluster(rng, [-3, 0], 0.05, 30),
    ...makeGaussianCluster(rng, [0, 3], 0.05, 30),
  ];
  const res = kmeans(points, { k: 3, seed: 1, maxIters: 50 });
  assert.ok(res.iterations >= 1 && res.iterations <= 50, `iterations=${res.iterations}`);
  assert.equal(res.converged, true, "tight Gaussians must converge before maxIters");
});

// ─── A3: K=1 returns all-zero assignments ─────────────────────────────────
test("A3: K=1 returns all-zero assignments and one centroid", () => {
  const points = [f32([1, 0, 0]), f32([0, 1, 0]), f32([0, 0, 1]), f32([1, 1, 0])];
  const res = kmeans(points, { k: 1, seed: 0 });
  assert.equal(res.assignments.length, 4);
  for (let i = 0; i < 4; i++) assert.equal(res.assignments[i], 0);
  assert.equal(res.centroids.length, 1);
  assert.equal(res.effectiveK, 1);
});

// ─── A4: K=N returns identity assignment ──────────────────────────────────
test("A4: K=N returns identity (each point its own cluster)", () => {
  const points = [f32([1, 0]), f32([0, 1]), f32([-1, 0]), f32([0, -1])];
  const res = kmeans(points, { k: 4, seed: 0 });
  // Identity: assignments[i] === i for some permutation; simplest contract
  // is the natural order assignments[i] = i.
  assert.equal(res.effectiveK, 4);
  assert.equal(res.centroids.length, 4);
  const seen = new Set<number>();
  for (let i = 0; i < 4; i++) {
    assert.equal(res.assignments[i], i, `expected identity at i=${i}`);
    seen.add(res.assignments[i]);
  }
  assert.equal(seen.size, 4, "every cluster must be used exactly once");
});

// ─── A5: empty input throws ───────────────────────────────────────────────
test("A5: empty input throws", () => {
  assert.throws(() => kmeans([], { k: 3, seed: 0 }), /empty|no points|points\.length/i);
});

// ─── A6: normalizes embeddings before L2 distance ─────────────────────────
test("A6: spherical (cosine) — parallel vectors cluster regardless of magnitude", () => {
  // Two horizontal directions at different magnitudes + two vertical at
  // different magnitudes. Cosine-correct k-means groups by direction.
  const points = [f32([1, 0]), f32([5, 0]), f32([0, 1]), f32([0, 5])];
  const res = kmeans(points, { k: 2, seed: 0, maxIters: 20 });
  assert.equal(res.assignments[0], res.assignments[1], "[1,0] and [5,0] must share a cluster");
  assert.equal(res.assignments[2], res.assignments[3], "[0,1] and [0,5] must share a cluster");
  assert.notEqual(res.assignments[0], res.assignments[2], "horizontal vs vertical must split");
});

// ─── A7: mini-batch matches full-batch on synthetic Gaussians ─────────────
test("A7: mini-batch centroids match full-batch within tolerance", () => {
  const rng = mulberry32(42);
  // Three well-separated Gaussian clusters on the 2-sphere shoulder.
  const points = [
    ...makeGaussianCluster(rng, [4, 0], 0.1, 80),
    ...makeGaussianCluster(rng, [-4, 0], 0.1, 80),
    ...makeGaussianCluster(rng, [0, 4], 0.1, 80),
  ];

  const full = kmeans(points, { k: 3, seed: 7, maxIters: 50 });
  const mini = kmeans(points, { k: 3, seed: 7, maxIters: 200, miniBatchSize: 32 });

  assert.equal(full.centroids.length, 3);
  assert.equal(mini.centroids.length, 3);
  const worst = maxMatchedDistance(full.centroids, mini.centroids);
  // Both run on the unit sphere; well-separated clusters → centroids within
  // 0.2 L2 of each other after greedy match.
  assert.ok(worst < 0.2, `mini-batch centroid drift too large: ${worst}`);
});

// ─── A8: duplicates don't NaN ─────────────────────────────────────────────
test("A8: identical input vectors do not produce NaN centroids", () => {
  const points = [
    f32([1, 0, 0]), f32([1, 0, 0]), f32([1, 0, 0]),
    f32([0, 1, 0]), f32([0, 1, 0]),
  ];
  const res = kmeans(points, { k: 2, seed: 0, maxIters: 20 });
  for (const c of res.centroids) {
    for (const x of c) assert.ok(Number.isFinite(x), `centroid component must be finite, got ${x}`);
  }
  // The three [1,0,0] copies must all share a cluster.
  assert.equal(res.assignments[0], res.assignments[1]);
  assert.equal(res.assignments[1], res.assignments[2]);
});

// ─── A9: returns Int32Array (memory contract) ─────────────────────────────
test("A9: assignments is an Int32Array (memory contract)", () => {
  const points = [f32([1, 0]), f32([0, 1]), f32([-1, 0]), f32([0, -1])];
  const res = kmeans(points, { k: 2, seed: 0 });
  assert.ok(res.assignments instanceof Int32Array, "assignments must be Int32Array");
  assert.equal(res.assignments.length, points.length);
});

// ─── A10: caps K when caller passes too-large K (K > N) ───────────────────
test("A10: K > N is capped to floor(sqrt(N))", () => {
  // N=10, sqrt(N)=3.16 → cap to 3.
  const rng = mulberry32(3);
  const points: Float32Array[] = [];
  for (let i = 0; i < 10; i++) {
    const p = new Float32Array(4);
    for (let d = 0; d < 4; d++) p[d] = randn(rng);
    points.push(p);
  }
  const res = kmeans(points, { k: 100, seed: 0 });
  assert.equal(res.effectiveK, 3, "effectiveK must equal floor(sqrt(10))=3");
  assert.equal(res.centroids.length, 3);
  // No assignment may exceed effectiveK-1.
  for (const a of res.assignments) {
    assert.ok(a >= 0 && a < 3, `assignment out of range: ${a}`);
  }
});
