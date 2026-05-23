// M8.3 — single-level Louvain community detection in pure TypeScript.
// No deps. Deterministic via seeded mulberry32 PRNG (matches kmeans.ts).
//
// Phase-1 only: iterated local moving until no node changes community
// in a full pass. Phase-2 aggregation is intentionally omitted — this
// surface runs on kNN sub-graphs restricted to one Super Node (<=200
// nodes per spec), where single-level Louvain is sufficient and the
// aggregation cycle would only add complexity. Multi-level is reserved
// for a future v0.2 if profiling shows a need.
//
// Modularity (Newman 2004 / Blondel et al. 2008):
//   Q = Σ_C [ in_C / m - γ * (tot_C / 2m)^2 ]
//     in_C  = sum of edge weights with both endpoints in C
//     tot_C = sum of edge weights incident to any node in C
//     m     = total undirected edge weight (each edge counted once)
//     γ     = resolution (default 1)
//
// Input tolerances:
//   * (u,v) and (v,u) sum into a single undirected (u,v) weight.
//   * (u,u) self-loops are stripped at construction (test B5).
//   * weights ≤ 0 or non-finite are dropped (defensive).

export interface LouvainEdge {
  source: number;
  target: number;
  weight?: number;
}

export interface LouvainOptions {
  nodeCount: number;
  edges: LouvainEdge[];
  seed?: number;
  resolution?: number;
  maxPasses?: number;
}

export interface LouvainResult {
  communities: Int32Array;
  modularity: number;
  passes: number;
  communityCount: number;
}

const DEFAULT_MAX_PASSES = 50;
const TIE_EPSILON = 1e-10;

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

function fisherYates(n: number, rng: () => number): Int32Array {
  const arr = new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

interface BuiltGraph {
  n: number;
  // Per-node adjacency: flat [neighborIdx, weight, neighborIdx, weight, ...]
  adj: Float64Array[];
  degree: Float64Array;
  m: number;
}

function buildGraph(opts: LouvainOptions): BuiltGraph {
  const n = opts.nodeCount;
  // Encode unordered edge (u,v) as min*n+max so dedup is O(1).
  const accum = new Map<number, number>();
  for (const e of opts.edges) {
    const u = e.source;
    const v = e.target;
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || u >= n || v < 0 || v >= n) {
      throw new Error(`louvain: edge endpoint out of range (n=${n}, edge=${u}->${v})`);
    }
    if (u === v) continue; // strip self-loop (test B5)
    const w = e.weight ?? 1;
    if (!Number.isFinite(w) || w <= 0) continue;
    const lo = u < v ? u : v;
    const hi = u < v ? v : u;
    const key = lo * n + hi;
    accum.set(key, (accum.get(key) ?? 0) + w);
  }

  const adjList: number[][] = new Array(n);
  for (let i = 0; i < n; i++) adjList[i] = [];
  const degree = new Float64Array(n);
  let m = 0;
  for (const [key, w] of accum) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    adjList[lo].push(hi, w);
    adjList[hi].push(lo, w);
    degree[lo] += w;
    degree[hi] += w;
    m += w;
  }

  const adj: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Float64Array(adjList[i]);
  return { n, adj, degree, m };
}

function computeModularity(
  graph: BuiltGraph,
  communities: Int32Array,
  resolution: number,
): number {
  if (graph.m === 0) return 0;
  const m = graph.m;
  const m2 = 2 * m;

  const inC = new Map<number, number>();
  const totC = new Map<number, number>();

  for (let i = 0; i < graph.n; i++) {
    const c = communities[i];
    totC.set(c, (totC.get(c) ?? 0) + graph.degree[i]);
    const adj = graph.adj[i];
    for (let idx = 0; idx < adj.length; idx += 2) {
      const j = adj[idx] | 0;
      const w = adj[idx + 1];
      if (communities[j] === c) {
        // Each undirected intra-community edge is encountered twice (once
        // per endpoint) — accumulate raw and halve when reading.
        inC.set(c, (inC.get(c) ?? 0) + w);
      }
    }
  }

  let Q = 0;
  for (const [c, tot] of totC) {
    const inSum = inC.get(c) ?? 0;
    const inHalved = inSum / 2;
    const ratio = tot / m2;
    Q += inHalved / m - resolution * ratio * ratio;
  }
  return Q;
}

function runPhase1(
  graph: BuiltGraph,
  communities: Int32Array,
  tot: Float64Array,
  resolution: number,
  rng: () => number,
  maxPasses: number,
): number {
  const m2 = 2 * graph.m;
  let passes = 0;
  let improved = true;

  while (improved && passes < maxPasses) {
    improved = false;
    passes++;
    const order = fisherYates(graph.n, rng);

    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const k_i = graph.degree[i];
      if (k_i === 0) continue; // isolated node stays in its singleton

      const oldComm = communities[i];
      const adj = graph.adj[i];

      // Sum weight from i into each neighbor community (self-loops already
      // stripped at construction time — extra guard is cheap).
      const neighborComm = new Map<number, number>();
      for (let idx = 0; idx < adj.length; idx += 2) {
        const j = adj[idx] | 0;
        if (j === i) continue;
        const w = adj[idx + 1];
        const c = communities[j];
        neighborComm.set(c, (neighborComm.get(c) ?? 0) + w);
      }

      // Remove i from its current community FIRST, then test every
      // candidate (including "stay" = re-add to oldComm) with the
      // post-removal tot values. This is the standard Louvain ΔQ
      // optimization: the gain of inserting i into community c is
      //   k_iC - γ * tot[c] * k_i / (2m)
      // (constants that don't depend on c are dropped).
      tot[oldComm] -= k_i;

      const k_iA = neighborComm.get(oldComm) ?? 0;
      let bestComm = oldComm;
      let bestGain = k_iA - (resolution * tot[oldComm] * k_i) / m2;

      for (const [c, k_iC] of neighborComm) {
        if (c === oldComm) continue;
        const gain = k_iC - (resolution * tot[c] * k_i) / m2;
        if (gain > bestGain + TIE_EPSILON) {
          bestGain = gain;
          bestComm = c;
        }
      }

      tot[bestComm] += k_i;
      communities[i] = bestComm;
      if (bestComm !== oldComm) improved = true;
    }
  }

  return passes;
}

function compactCommunities(communities: Int32Array): {
  remapped: Int32Array;
  count: number;
} {
  const map = new Map<number, number>();
  const remapped = new Int32Array(communities.length);
  let next = 0;
  for (let i = 0; i < communities.length; i++) {
    const c = communities[i];
    let r = map.get(c);
    if (r === undefined) {
      r = next++;
      map.set(c, r);
    }
    remapped[i] = r;
  }
  return { remapped, count: next };
}

export function louvain(opts: LouvainOptions): LouvainResult {
  if (!Number.isInteger(opts.nodeCount) || opts.nodeCount <= 0) {
    throw new Error(
      `louvain: nodeCount must be a positive integer (got ${opts.nodeCount})`,
    );
  }
  const seed = opts.seed ?? 0;
  const resolution = opts.resolution ?? 1;
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error(`louvain: resolution must be > 0 (got ${resolution})`);
  }

  const graph = buildGraph(opts);

  // Initialize: every node in its own singleton community.
  const communities = new Int32Array(graph.n);
  const tot = new Float64Array(graph.n);
  for (let i = 0; i < graph.n; i++) {
    communities[i] = i;
    tot[i] = graph.degree[i];
  }

  if (graph.m === 0) {
    const { remapped, count } = compactCommunities(communities);
    return { communities: remapped, modularity: 0, passes: 0, communityCount: count };
  }

  const rng = mulberry32(seed);
  const passes = runPhase1(graph, communities, tot, resolution, rng, maxPasses);
  const { remapped, count } = compactCommunities(communities);
  const modularity = computeModularity(graph, remapped, resolution);

  return { communities: remapped, modularity, passes, communityCount: count };
}
