// M8.3 — spherical mini-batch k-means in pure TypeScript. No deps.
//
// "Spherical" means we operate on the unit sphere: every input is L2-
// normalized once at entry and centroids are renormalized after each
// update. With unit-length inputs L2 distance is monotone in cosine
// distance, which matches the vector_cosine_ops HNSW index on
// kg_nodes.embedding (extensions.vector_cosine_ops).
//
// Determinism: all randomness (k-means++ init + mini-batch sampling)
// flows from a single seeded mulberry32 PRNG. Same seed → bit-identical
// assignments and centroids.

export interface KMeansOptions {
  k: number;
  seed?: number;
  maxIters?: number;
  miniBatchSize?: number;
  tolerance?: number;
}

export interface KMeansResult {
  assignments: Int32Array;
  centroids: Float32Array[];
  iterations: number;
  converged: boolean;
  effectiveK: number;
}

const DEFAULT_MAX_ITERS = 50;
const DEFAULT_TOLERANCE = 1e-4;

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

function normalizeInto(v: Float32Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  if (s === 0) return;
  const inv = 1 / Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
}

function squaredL2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function copyNormalized(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  normalizeInto(out);
  return out;
}

function nearestCentroid(point: Float32Array, centroids: Float32Array[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = squaredL2(point, centroids[c]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// k-means++ seeding on already-normalized points. Skips zero-distance
// indices when sampling proportional to D² so we never pick the same
// point twice and never NaN on all-duplicate inputs.
function kmeansPlusPlus(
  points: Float32Array[],
  k: number,
  rng: () => number,
): Float32Array[] {
  const n = points.length;
  const centroids: Float32Array[] = [];
  const firstIdx = Math.floor(rng() * n);
  centroids.push(new Float32Array(points[firstIdx]));

  const dists = new Float64Array(n);
  for (let i = 0; i < n; i++) dists[i] = squaredL2(points[i], centroids[0]);

  while (centroids.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dists[i];
    if (sum === 0) break; // every point coincides with an existing centroid

    const target = rng() * sum;
    let acc = 0;
    let chosen = -1;
    for (let i = 0; i < n; i++) {
      if (dists[i] <= 0) continue;
      acc += dists[i];
      if (acc >= target) {
        chosen = i;
        break;
      }
    }
    if (chosen < 0) break;

    centroids.push(new Float32Array(points[chosen]));
    const cNew = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = squaredL2(points[i], cNew);
      if (d < dists[i]) dists[i] = d;
    }
  }
  return centroids;
}

export function kmeans(
  points: Float32Array[],
  opts: KMeansOptions,
): KMeansResult {
  if (!points || points.length === 0) {
    throw new Error("kmeans: points.length must be >= 1 (empty input)");
  }
  if (opts.k <= 0) {
    throw new Error(`kmeans: k must be >= 1, got ${opts.k}`);
  }

  const n = points.length;
  const d = points[0].length;
  const seed = opts.seed ?? 0;
  const maxIters = opts.maxIters ?? DEFAULT_MAX_ITERS;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const miniBatchSize = opts.miniBatchSize ?? 0;

  // Cap K. Daemons may pass K > N when N is small; library cap is
  // floor(sqrt(N)) for that branch. Exact K == N is honored as identity.
  let effectiveK: number;
  if (opts.k > n) effectiveK = Math.max(1, Math.floor(Math.sqrt(n)));
  else effectiveK = opts.k;

  // Normalize input copies once. Original Float32Arrays are not mutated.
  const X: Float32Array[] = new Array(n);
  for (let i = 0; i < n; i++) X[i] = copyNormalized(points[i]);

  // ── trivial branches ────────────────────────────────────────────────────
  if (effectiveK === 1) {
    const c = new Float32Array(d);
    for (const x of X) for (let j = 0; j < d; j++) c[j] += x[j];
    for (let j = 0; j < d; j++) c[j] /= n;
    normalizeInto(c);
    return {
      assignments: new Int32Array(n),
      centroids: [c],
      iterations: 1,
      converged: true,
      effectiveK: 1,
    };
  }
  if (effectiveK === n) {
    const a = new Int32Array(n);
    const cs: Float32Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = i;
      cs[i] = new Float32Array(X[i]);
    }
    return {
      assignments: a,
      centroids: cs,
      iterations: 1,
      converged: true,
      effectiveK: n,
    };
  }

  // ── seeded init ─────────────────────────────────────────────────────────
  const rng = mulberry32(seed);
  let centroids = kmeansPlusPlus(X, effectiveK, rng);
  // Init may return fewer centroids than requested when inputs collapse
  // (e.g., all duplicates). Honor whatever fits.
  effectiveK = centroids.length;

  const assignments = new Int32Array(n);
  const counts = new Int32Array(effectiveK);
  let iterations = 0;
  let converged = false;

  if (miniBatchSize > 0) {
    // ── mini-batch (Sculley 2010) ───────────────────────────────────────
    const b = Math.min(miniBatchSize, n);
    for (let iter = 0; iter < maxIters; iter++) {
      iterations = iter + 1;
      let shift = 0;
      for (let s = 0; s < b; s++) {
        const i = Math.floor(rng() * n);
        const c = nearestCentroid(X[i], centroids);
        counts[c] += 1;
        const eta = 1 / counts[c];
        const cv = centroids[c];
        const xi = X[i];
        let localShift = 0;
        for (let j = 0; j < d; j++) {
          const delta = eta * (xi[j] - cv[j]);
          cv[j] += delta;
          localShift += delta * delta;
        }
        shift += localShift;
      }
      for (let c = 0; c < effectiveK; c++) normalizeInto(centroids[c]);
      if (shift / b < tolerance) {
        converged = true;
        break;
      }
    }
    for (let i = 0; i < n; i++) assignments[i] = nearestCentroid(X[i], centroids);
    return { assignments, centroids, iterations, converged, effectiveK };
  }

  // ── full-batch Lloyd ────────────────────────────────────────────────────
  const next: Float32Array[] = new Array(effectiveK);
  for (let c = 0; c < effectiveK; c++) next[c] = new Float32Array(d);

  for (let iter = 0; iter < maxIters; iter++) {
    iterations = iter + 1;
    for (let i = 0; i < n; i++) assignments[i] = nearestCentroid(X[i], centroids);

    for (let c = 0; c < effectiveK; c++) {
      counts[c] = 0;
      const t = next[c];
      for (let j = 0; j < d; j++) t[j] = 0;
    }
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c] += 1;
      const tgt = next[c];
      const src = X[i];
      for (let j = 0; j < d; j++) tgt[j] += src[j];
    }

    let shift = 0;
    for (let c = 0; c < effectiveK; c++) {
      if (counts[c] === 0) continue; // leave centroid unchanged → no NaN
      const inv = 1 / counts[c];
      const t = next[c];
      for (let j = 0; j < d; j++) t[j] *= inv;
      normalizeInto(t);
      shift += squaredL2(centroids[c], t);
      centroids[c] = new Float32Array(t);
    }
    if (shift < tolerance) {
      converged = true;
      break;
    }
  }

  return { assignments, centroids, iterations, converged, effectiveK };
}
