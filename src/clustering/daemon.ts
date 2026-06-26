// M8.3 — Clustering Scanner Daemon (Task 3, SCM-S41-D5).
//
// Per-project pipeline: kg_nodes.embedding → K-Means (Task 1) → kg_knn_pairs
// RPC → per-supernode Louvain (Task 2) → bulk UPSERT into kg_node_clusters.
//
// Memory discipline (50k × 768-d × 4B ≈ 153 MB worst case):
//   * Embeddings page-fetched into Float32Array immediately (not number[]),
//     so the only large allocation is a single contiguous Float32Array per
//     point — half the footprint of Float64Array.
//   * Intermediate maps + kNN row arrays are explicitly null-released between
//     phases so the GC has a chance to reclaim before the next phase peaks.
//   * Louvain runs per-supernode rather than over the whole graph: peak heap
//     during the community phase is bounded by the largest supernode (~√N
//     nodes), NOT N.
//   * Bulk UPSERT batched at 500 rows so a project with 50k clusters never
//     emits a single multi-megabyte INSERT body.
//
// Lifecycle mirrors src/sleep/daemon.ts: module-level state, .unref()'d
// interval, re-entrancy guard, try/finally tick. Universal — discovers
// active projects via `SELECT DISTINCT project_id FROM kg_nodes`; never
// hardcodes a project name.
//
// ARM gated via checkDaemonBudget("clustering_scanner", "ollama_calls", 0):
// the delta=0 call still registers the daemon in daemon_budget_buckets so
// system_dashboard can surface its presence.

import { supabase } from "../supabase.js";
import { emit } from "../telemetry/emit.js";
import { checkDaemonBudget } from "../budget/gate.js";
import { kmeans } from "./kmeans.js";
import { louvain, type LouvainEdge } from "./louvain.js";

// ─── tunables (env-overridable) ───────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 1_800_000; // 30 min
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_UPSERT_BATCH = 500;
const DEFAULT_KNN_K = 15;
const DEFAULT_KNN_MIN_SIM = 0.5;
const DEFAULT_KMEANS_MAX_ITERS = 50;
const DEFAULT_DELTA_THRESHOLD = 100;
const DEFAULT_COOLDOWN_MS = 86_400_000; // 24 h

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig() {
  return {
    intervalMs: readIntEnv("SCM_CLUSTERING_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    pageSize: readIntEnv("SCM_CLUSTERING_PAGE_SIZE", DEFAULT_PAGE_SIZE),
    upsertBatch: readIntEnv("SCM_CLUSTERING_UPSERT_BATCH", DEFAULT_UPSERT_BATCH),
    knnK: readIntEnv("SCM_CLUSTERING_KNN_K", DEFAULT_KNN_K),
    deltaThreshold: readIntEnv("SCM_CLUSTERING_DELTA_THRESHOLD", DEFAULT_DELTA_THRESHOLD),
    cooldownMs: readIntEnv("SCM_CLUSTERING_COOLDOWN_MS", DEFAULT_COOLDOWN_MS),
  };
}

// ─── module state ─────────────────────────────────────────────────────────

const state = {
  enabled: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  lastRunAt: null as string | null,
  lastRunProjectId: null as string | null,
  lastRunClustered: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  clustersWrittenTotal: 0,
  timer: null as NodeJS.Timeout | null,
  running: false,
  roundRobinCursor: 0,
};

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * pgvector serialisation crosses the supabase-js boundary as either a JSON
 * array (newer realtime) or a "[1,2,3]" string. Handle both; reject empties.
 */
function parseEmbedding(raw: unknown): Float32Array | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return Float32Array.from(parsed);
    } catch {
      /* fall through */
    }
    return null;
  }
  if (Array.isArray(raw) && raw.length > 0) return Float32Array.from(raw);
  return null;
}

/**
 * Distinct project IDs whose kg_nodes have at least one embedding. Delegates
 * the DISTINCT to Postgres via the clustering_discover_projects RPC (migration
 * 028) so it returns exactly one row per project and is NEVER truncated. This
 * replaces the old unordered limit(5000) + client-side dedup, which could
 * silently skip projects once the global embedded-node count exceeded 5000 —
 * a round-robin gap that also flaked the C8 smoke test (#371).
 */
export async function discoverProjects(): Promise<string[]> {
  const { data, error } = await supabase.rpc("clustering_discover_projects");
  if (error || !data) return [];
  const seen = new Set<string>();
  for (const row of data as Array<{ project_id?: unknown }>) {
    const pid = row.project_id;
    if (typeof pid === "string" && pid.length > 0) seen.add(pid);
  }
  return [...seen].sort(); // RPC already orders; the sort is defensive
}

/**
 * Delta-gated dirty check — re-cluster only when it's actually worth it:
 *   1. kgCount=0 → skip (nothing to cluster).
 *   2. clCount=0 → run (never clustered yet — initial pass).
 *   3. |kgCount - clCount| > DELTA_THRESHOLD → run (significant growth/shrink).
 *   4. lastComputedAt is null → run (defensive).
 *   5. elapsed >= COOLDOWN_MS → run (cooldown expired).
 *   6. Otherwise → skip (within cooldown AND small delta → saves egress + IO).
 *
 * Returns true conservatively on transient query errors so a real change is
 * never silently masked.
 *
 * Knobs (env-overridable):
 *   SCM_CLUSTERING_DELTA_THRESHOLD  default 100
 *   SCM_CLUSTERING_COOLDOWN_MS      default 86_400_000 (24 h)
 */
/**
 * Pure decision function — separated from I/O so it can be unit-tested without
 * any DB mocking infrastructure.  All inputs are already-resolved values.
 *
 * Rules (in evaluation order):
 *   1. kgCount=0  → false  (nothing to cluster)
 *   2. clCount=0  → true   (never clustered — initial run)
 *   3. |kgCount − clCount| > deltaThreshold → true  (significant growth/shrink)
 *   4. lastComputedAt=null → true  (defensive)
 *   5. elapsed >= cooldownMs → true  (cooldown expired)
 *   6. Otherwise → false  (within cooldown + small delta)
 */
export function decideDirty(
  kgCount: number,
  clCount: number,
  lastComputedAt: string | null,
  nowMs: number,
  deltaThreshold: number,
  cooldownMs: number,
): boolean {
  if (kgCount === 0) return false;
  if (clCount === 0) return true;
  if (Math.abs(kgCount - clCount) > deltaThreshold) return true;
  if (lastComputedAt === null) return true;
  return nowMs - new Date(lastComputedAt).getTime() >= cooldownMs;
}

export async function isDirty(projectId: string): Promise<boolean> {
  const { deltaThreshold, cooldownMs } = resolveConfig();

  const [kgRes, clRes] = await Promise.all([
    supabase
      .from("kg_nodes")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .not("embedding", "is", null),
    supabase
      .from("kg_node_clusters")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId),
  ]);
  if (kgRes.error || clRes.error) return true;   // fail-open on transient errors
  const kgCount = kgRes.count ?? 0;
  const clCount = clRes.count ?? 0;

  // Fast path — no need to hit DB a third time if already decided.
  if (kgCount === 0 || clCount === 0 || Math.abs(kgCount - clCount) > deltaThreshold) {
    return decideDirty(kgCount, clCount, null, Date.now(), deltaThreshold, cooldownMs);
  }

  const clMax = await supabase
    .from("kg_node_clusters")
    .select("computed_at")
    .eq("project_id", projectId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (clMax.error) return true;                  // fail-open on transient errors
  const lastComputedAt = clMax.data?.computed_at ?? null;
  return decideDirty(kgCount, clCount, lastComputedAt, Date.now(), deltaThreshold, cooldownMs);
}

// ─── core pipeline ────────────────────────────────────────────────────────

type EmbeddingPage = { ids: number[]; embeddings: Float32Array[] };

async function fetchEmbeddings(projectId: string, pageSize: number): Promise<EmbeddingPage> {
  const ids: number[] = [];
  const embeddings: Float32Array[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("id, embedding")
      .eq("project_id", projectId)
      .not("embedding", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`fetchEmbeddings page ${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const emb = parseEmbedding((row as { embedding?: unknown }).embedding);
      if (!emb) continue;
      ids.push(Number((row as { id: number | string }).id));
      embeddings.push(emb);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return { ids, embeddings };
}

export type ClusterRow = {
  project_id: string;
  node_id: number;
  supernode_id: number;
  community_id: number;
};

/**
 * FK-safe bulk upsert into kg_node_clusters.
 *
 * kg_node_clusters.node_id REFERENCES kg_nodes(id) ON DELETE CASCADE, so a
 * node deleted between the K-Means read and this write would cause a FK
 * violation that aborts the whole batch.  We defend by pre-filtering: fetch
 * the set of still-existing node_ids for this project, then drop any row
 * whose node_id is no longer present before emitting each UPSERT batch.
 * Deleted nodes are silently skipped; their cluster rows were already removed
 * by CASCADE, so no data is lost.
 */
export async function bulkUpsertClusters(rows: ClusterRow[], batchSize: number): Promise<void> {
  if (rows.length === 0) return;

  // Collect all node_ids in this batch and fetch which still exist.
  const projectId = rows[0].project_id;
  const nodeIds = rows.map((r) => r.node_id);
  const { data: existingData, error: existErr } = await supabase
    .from("kg_nodes")
    .select("id")
    .eq("project_id", projectId)
    .in("id", nodeIds);
  if (existErr) {
    throw new Error(`bulkUpsertClusters existence check: ${existErr.message}`);
  }
  const existingIds = new Set<number>((existingData ?? []).map((r: { id: number }) => Number(r.id)));
  const liveRows = rows.filter((r) => existingIds.has(r.node_id));

  for (let i = 0; i < liveRows.length; i += batchSize) {
    const slice = liveRows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("kg_node_clusters")
      .upsert(slice, { onConflict: "project_id,node_id" });
    if (error) {
      throw new Error(`bulkUpsertClusters batch[${i}..${i + slice.length}): ${error.message}`);
    }
  }
}

export type RunProjectResult = {
  ok: boolean;
  project_id: string;
  status:
    | "no_embeddings"
    | "not_dirty"
    | "budget_blocked"
    | "clustered"
    | "error";
  embeddings_loaded: number;
  kmeans_k: number;
  supernodes_created: number;
  louvain_communities: number;
  rows_upserted: number;
  duration_ms: number;
  error?: string;
};

/**
 * Run the full clustering pipeline for ONE project. Safe to call manually
 * (smoke tests, MCP `trigger_clustering` tool) or from the daemon tick.
 *
 * @param projectId       Slugified project namespace (NEVER hardcoded).
 * @param opts.force      Skip the dirty-check (caller knows there's work to do).
 */
export async function runClusteringForProject(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<RunProjectResult> {
  const t0 = Date.now();
  const cfg = resolveConfig();
  const force = opts.force === true;

  const base: RunProjectResult = {
    ok: true,
    project_id: projectId,
    status: "no_embeddings",
    embeddings_loaded: 0,
    kmeans_k: 0,
    supernodes_created: 0,
    louvain_communities: 0,
    rows_upserted: 0,
    duration_ms: 0,
  };

  // ARM gate registration — delta=0 so we never exhaust the budget, but the
  // call still writes a daemon_budget_buckets row when mode is enforce/warn.
  const gate = await checkDaemonBudget("clustering_scanner", "ollama_calls", 0);
  if (gate.decision === "block") {
    return { ...base, status: "budget_blocked", duration_ms: Date.now() - t0 };
  }

  try {
    if (!force) {
      const dirty = await isDirty(projectId);
      if (!dirty) return { ...base, status: "not_dirty", duration_ms: Date.now() - t0 };
    }

    // ── phase 1: page-fetch embeddings ──────────────────────────────────
    const page = await fetchEmbeddings(projectId, cfg.pageSize);
    if (page.embeddings.length === 0) {
      return { ...base, status: "no_embeddings", duration_ms: Date.now() - t0 };
    }

    // ── phase 2: K-Means (K = ceil(sqrt(N))) ────────────────────────────
    const n = page.embeddings.length;
    const k = Math.max(1, Math.ceil(Math.sqrt(n)));
    const km = kmeans(page.embeddings, {
      k,
      seed: 0,
      maxIters: DEFAULT_KMEANS_MAX_ITERS,
    });

    // Build nodeId → supernode_id map + nodes-per-supernode lookup. After this,
    // we no longer need the raw embeddings — null them so GC can reclaim.
    const nodeIdToSupernode = new Map<number, number>();
    const nodesPerSupernode = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const nodeId = page.ids[i];
      const sn = km.assignments[i];
      nodeIdToSupernode.set(nodeId, sn);
      const bucket = nodesPerSupernode.get(sn);
      if (bucket) bucket.push(nodeId);
      else nodesPerSupernode.set(sn, [nodeId]);
    }
    // Release the page payload — Float32Array buffers are by far the largest
    // allocation in this function.
    page.embeddings.length = 0;
    (km.centroids as unknown as Float32Array[]).length = 0;

    // ── phase 3: kNN pairs via RPC + per-supernode Louvain ──────────────
    const knnRpc = await supabase.rpc("kg_knn_pairs", {
      p_project_id: projectId,
      p_k: cfg.knnK,
      p_min_sim: DEFAULT_KNN_MIN_SIM,
    });
    const knnRows = (knnRpc.data ?? []) as Array<{
      source_id: number | string;
      target_id: number | string;
      similarity: number;
    }>;

    // Bucket edges by supernode AND remap node_ids to local 0..m-1 indices
    // expected by louvain().
    const supernodeLocalIdx = new Map<number, Map<number, number>>();
    const supernodeEdges = new Map<number, LouvainEdge[]>();
    for (const [sn, members] of nodesPerSupernode) {
      const localMap = new Map<number, number>();
      members.forEach((nodeId, idx) => localMap.set(nodeId, idx));
      supernodeLocalIdx.set(sn, localMap);
      supernodeEdges.set(sn, []);
    }
    for (const pair of knnRows) {
      const srcId = Number(pair.source_id);
      const tgtId = Number(pair.target_id);
      const srcSN = nodeIdToSupernode.get(srcId);
      const tgtSN = nodeIdToSupernode.get(tgtId);
      if (srcSN === undefined || tgtSN === undefined) continue;
      if (srcSN !== tgtSN) continue; // only intra-supernode edges drive Louvain
      const local = supernodeLocalIdx.get(srcSN)!;
      const srcLocal = local.get(srcId);
      const tgtLocal = local.get(tgtId);
      if (srcLocal === undefined || tgtLocal === undefined) continue;
      supernodeEdges.get(srcSN)!.push({
        source: srcLocal,
        target: tgtLocal,
        weight: pair.similarity,
      });
    }
    // Done with raw kNN payload — drop the reference.
    knnRows.length = 0;

    // ── phase 4: per-supernode Louvain → community_id ───────────────────
    const communityIdByNodeId = new Map<number, number>();
    let totalLouvainCommunities = 0;
    for (const [sn, members] of nodesPerSupernode) {
      const edges = supernodeEdges.get(sn) ?? [];
      if (members.length === 1 || edges.length === 0) {
        // Trivial case: singleton or edgeless supernode → community 0.
        for (const nodeId of members) communityIdByNodeId.set(nodeId, 0);
        totalLouvainCommunities += members.length === 0 ? 0 : 1;
        continue;
      }
      const lv = louvain({ nodeCount: members.length, edges, seed: 0 });
      const local = supernodeLocalIdx.get(sn)!;
      for (const [nodeId, localIdx] of local) {
        communityIdByNodeId.set(nodeId, lv.communities[localIdx]);
      }
      totalLouvainCommunities += lv.communityCount;
    }
    // Drop intermediate per-supernode buffers.
    supernodeEdges.clear();
    supernodeLocalIdx.clear();

    // ── phase 5: bulk UPSERT into kg_node_clusters ──────────────────────
    const rows: ClusterRow[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const nodeId = page.ids[i];
      rows[i] = {
        project_id: projectId,
        node_id: nodeId,
        supernode_id: nodeIdToSupernode.get(nodeId) ?? 0,
        community_id: communityIdByNodeId.get(nodeId) ?? 0,
      };
    }
    nodeIdToSupernode.clear();
    nodesPerSupernode.clear();
    communityIdByNodeId.clear();

    await bulkUpsertClusters(rows, cfg.upsertBatch);
    const upserted = rows.length;
    rows.length = 0;

    const result: RunProjectResult = {
      ok: true,
      project_id: projectId,
      status: "clustered",
      embeddings_loaded: n,
      kmeans_k: km.effectiveK,
      supernodes_created: km.effectiveK,
      louvain_communities: totalLouvainCommunities,
      rows_upserted: upserted,
      duration_ms: Date.now() - t0,
    };
    return result;
  } catch (err) {
    return {
      ok: false,
      project_id: projectId,
      status: "error",
      embeddings_loaded: 0,
      kmeans_k: 0,
      supernodes_created: 0,
      louvain_communities: 0,
      rows_upserted: 0,
      duration_ms: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

// ─── daemon lifecycle ─────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const tStart = Date.now();
  void emit({ daemon: "clustering_scanner", event: "run_started" });

  let clustered = 0;
  let skipped = 0;
  let errored = 0;
  let projectId: string | null = null;

  try {
    const projects = await discoverProjects();
    if (projects.length === 0) {
      skipped++;
    } else {
      // Round-robin: pick next project; advance cursor (mod len) so each tick
      // covers a different project. Universal — never tied to a specific id.
      const idx = state.roundRobinCursor % projects.length;
      state.roundRobinCursor = (state.roundRobinCursor + 1) % Math.max(1, projects.length);
      projectId = projects[idx];

      const r = await runClusteringForProject(projectId);
      if (r.status === "clustered") clustered = r.rows_upserted;
      else if (r.status === "error") errored++;
      else skipped++;
    }
  } catch (err) {
    errored++;
    void emit({
      daemon: "clustering_scanner",
      event: "run_errored",
      payload: {
        error_message: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - tStart,
      },
    });
  } finally {
    state.lastRunAt = new Date().toISOString();
    state.lastRunProjectId = projectId;
    state.lastRunClustered = clustered;
    state.lastRunSkipped = skipped;
    state.lastRunErrored = errored;
    state.lastRunDurationMs = Date.now() - tStart;
    state.clustersWrittenTotal += clustered;
    void emit({
      daemon: "clustering_scanner",
      event: "run_ended",
      payload: {
        project_id: projectId,
        clustered,
        skipped,
        errored,
        duration_ms: state.lastRunDurationMs,
      },
    });
    state.running = false;
  }
}

export function startClusteringScanner(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.enabled = true;
  state.timer = setInterval(() => {
    if (state.running) return;
    void tick();
  }, state.intervalMs);
  state.timer.unref();
}

export function stopClusteringScanner(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

export type ClusteringScannerStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  last_run_at: string | null;
  last_run_project_id: string | null;
  last_run_clustered: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  clusters_written_total: number;
};

export function getClusteringScannerStatus(): ClusteringScannerStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    last_run_at: state.lastRunAt,
    last_run_project_id: state.lastRunProjectId,
    last_run_clustered: state.lastRunClustered,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    clusters_written_total: state.clustersWrittenTotal,
  };
}

export const runClusteringTickOnce = tick;
