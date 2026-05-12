// Sleep Learning — cluster miner (Agentic OS 2026 / Mission 3 / SCM-S19-D1).
// Pure function: reads trajectory_summaries INNER JOIN archive_backlog WHERE
// status='success', clusters by (a) 3-gram content hash AND (b) cosine ≥ 0.85
// over summary_embedding centroids, emits CandidateStub[]. NO writes.
//
// Returning shape conforms to scripts/012_sleep_learning.sql's
// upsert_skill_candidate RPC: pattern_hash is the dedupe key, source_*_ids
// arrays are provenance, frequency / success_count are bumped on re-mining.

import { createHash } from "node:crypto";
import { supabase } from "../supabase.js";

const THREE_GRAM_TOKEN_RE = /[a-z0-9]+/g;

export type CandidateStub = {
  project_id: string;
  pattern_hash: string;
  source_summary_ids: number[];
  source_backlog_ids: number[];
  frequency: number;
  success_count: number;
  candidate_embedding: number[] | null;
  /** Representative summary text — fed verbatim to the proposer. */
  representative_summary: string;
  /** All summaries in the cluster (for the proposer's distillation). */
  cluster_summaries: string[];
};

export type MineClustersOptions = {
  /** Project namespace to mine. Required — mining is per-project (Rule 10). */
  projectId: string;
  /** Hard ceiling on summary rows fetched per run. */
  batch?: number;
  /** Minimum cluster size to emit. Default 3 (Mission 3 spec). */
  minFreq?: number;
};

type SummaryRow = {
  id: number;
  project_id: string;
  summary: string;
  summary_embedding: number[] | null;
  source_chunk_id: number;
};

type ArchiveRow = {
  id: number;
  chunk_id: number | null;
};

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Tokenize → lowercase 3-grams → SHA1(top-K joined). Deterministic; gives a
 * stable shingle-fingerprint we can use as a coarse cluster key BEFORE
 * cosine refinement. Empty input falls back to a hash of "".
 */
function trigramHash(text: string): string {
  const tokens = text.toLowerCase().match(THREE_GRAM_TOKEN_RE) ?? [];
  const grams: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  // Sort + unique so word-order variance within a sentence collapses.
  const sorted = Array.from(new Set(grams)).sort();
  // Cap at first 64 trigrams — keeps the key short-text-stable but resists
  // collisions from long divergent tails.
  const head = sorted.slice(0, 64).join("|");
  return createHash("sha1").update(head).digest("hex");
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function meanVector(vectors: number[][]): number[] | null {
  const present = vectors.filter((v) => Array.isArray(v) && v.length > 0);
  if (present.length === 0) return null;
  const dim = present[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of present) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= present.length;
  return out;
}

// ─── data fetch ───────────────────────────────────────────────────────────

async function fetchSummariesForProject(
  projectId: string,
  limit: number,
): Promise<SummaryRow[]> {
  const { data, error } = await supabase
    .from("trajectory_summaries")
    .select("id, project_id, summary, summary_embedding, source_chunk_id")
    .eq("project_id", projectId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`mineClusters: trajectory_summaries scan failed: ${error.message}`);
  }
  const rows = (data ?? []) as SummaryRow[];
  return rows.filter((r) => typeof r.summary === "string" && r.summary.length > 0);
}

/**
 * Build a Map<source_chunk_id, archive_backlog.id> for the project where
 * archive_backlog.status='success'. Empty when the archive_backlog table
 * doesn't track chunk_id (older deployments) — that's fine, provenance is
 * advisory.
 */
async function fetchSuccessArchiveByChunk(
  projectId: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const { data, error } = await supabase
    .from("archive_backlog")
    .select("id, chunk_id")
    .eq("project_id", projectId)
    .eq("status", "done");
  if (error) {
    // Older deployments may lack the chunk_id column. Don't fail the daemon
    // tick — mining still works, source_backlog_ids stays empty for those.
    return out;
  }
  for (const row of (data ?? []) as ArchiveRow[]) {
    if (typeof row.chunk_id === "number") out.set(row.chunk_id, row.id);
  }
  return out;
}

// ─── M4 rollback signals (Mission 4 / Phase B integration) ────────────────
//
// The miner reads workflow_checkpoints directly — there is NO separate
// signals table. For each candidate cluster, every member's
// trajectory_summaries.source_chunk_id is checked against rolledback
// checkpoints; matches become negative-vote evidence that decrements the
// cluster's success_count (floor 0). This keeps a high-frequency cluster
// from getting promoted just because the same buggy pattern was rerun.
//
// Behaviour is strictly additive: when no rolledback rows exist (the M4
// table is absent on legacy deploys, or there are simply no rollbacks),
// the returned Map is empty and the mining loop is byte-identical to the
// pre-M4 path.

export type RollbackSignal = {
  rollback_count: number;
  last_rollback: string | null;
};

type RollbackRow = {
  source_chunk_id: number | null;
  status: string;
  created_at: string;
};

/**
 * Returns a Map<source_chunk_id, { rollback_count, last_rollback }> over
 * the supplied chunk ids. Pure read — no writes. Tolerant of missing
 * table: a query error (e.g. workflow_checkpoints not deployed yet) is
 * swallowed and an empty Map is returned, so legacy deploys keep mining.
 */
export async function fetchRollbackSignalsByChunk(
  projectId: string,
  chunkIds: number[],
): Promise<Map<number, RollbackSignal>> {
  const out = new Map<number, RollbackSignal>();
  if (!projectId || typeof projectId !== "string") return out;
  const ids = Array.from(
    new Set(chunkIds.filter((n): n is number => typeof n === "number" && Number.isFinite(n))),
  );
  if (ids.length === 0) return out;

  // PostgREST's IN-form via .in() — equivalent to ANY($2) at the SQL layer,
  // but stays inside the supabase-js builder so we don't need a custom RPC.
  // Note: we group in TS (no GROUP BY across .in()) — N here is bounded by
  // the per-tick batch (default 10, max 50), so O(N) aggregation is fine.
  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .select("source_chunk_id, status, created_at")
    .eq("project_id", projectId)
    .eq("status", "rolledback")
    .in("source_chunk_id", ids);

  if (error) {
    // workflow_checkpoints not deployed yet (M4 migration 014 not applied)
    // → return empty signal map. Mining proceeds without rollback penalty.
    return out;
  }

  for (const row of (data ?? []) as RollbackRow[]) {
    const sid = row.source_chunk_id;
    if (typeof sid !== "number") continue;
    const cur = out.get(sid);
    if (cur) {
      cur.rollback_count += 1;
      if (
        typeof row.created_at === "string" &&
        (cur.last_rollback === null || row.created_at > cur.last_rollback)
      ) {
        cur.last_rollback = row.created_at;
      }
    } else {
      out.set(sid, {
        rollback_count: 1,
        last_rollback: typeof row.created_at === "string" ? row.created_at : null,
      });
    }
  }
  return out;
}

// ─── clustering ───────────────────────────────────────────────────────────

type Cluster = {
  hash: string;
  summaries: SummaryRow[];
};

/**
 * Two-pass cluster:
 *   Pass 1 (coarse): group summaries by 3-gram hash. Same hash → certain cluster.
 *   Pass 2 (refine): for each pair of single-row coarse-buckets, merge if
 *     cosine(centroid_a, centroid_b) ≥ 0.85. Small-N (≤ batch=10 default)
 *     so O(n²) is fine here.
 *
 * This is a strict superset of a "pure 3-gram clustering" path: identical-
 * text re-runs always co-cluster (Pass 1), while semantically-equivalent
 * paraphrases that differ in surface tokens are pulled together by Pass 2.
 */
function clusterSummaries(rows: SummaryRow[]): Cluster[] {
  const buckets = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const h = trigramHash(r.summary);
    const arr = buckets.get(h);
    if (arr) arr.push(r);
    else buckets.set(h, [r]);
  }

  const clusters: Cluster[] = [];
  for (const [hash, summaries] of buckets) clusters.push({ hash, summaries });

  // Pass 2: cosine merge over centroids. We only attempt merges on clusters
  // that still have embeddings — null-vector buckets stay where they are.
  const COSINE_THRESHOLD = 0.85;
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      const ci = clusters[i];
      const vi = meanVector(
        ci.summaries.map((s) => s.summary_embedding ?? []).filter((v) => v.length > 0),
      );
      if (!vi) continue;
      for (let j = i + 1; j < clusters.length; j++) {
        const cj = clusters[j];
        const vj = meanVector(
          cj.summaries.map((s) => s.summary_embedding ?? []).filter((v) => v.length > 0),
        );
        if (!vj) continue;
        if (cosine(vi, vj) >= COSINE_THRESHOLD) {
          // Merge j into i. Keep the lexicographically-smaller hash so the
          // cluster identity is deterministic across runs.
          const newHash = ci.hash < cj.hash ? ci.hash : cj.hash;
          ci.hash = newHash;
          ci.summaries.push(...cj.summaries);
          clusters.splice(j, 1);
          mergedAny = true;
          break outer;
        }
      }
    }
  }

  return clusters;
}

// ─── public API ───────────────────────────────────────────────────────────

export async function mineClusters(
  opts: MineClustersOptions,
): Promise<CandidateStub[]> {
  const batch = opts.batch ?? 50;
  const minFreq = opts.minFreq ?? 3;
  if (!opts.projectId || typeof opts.projectId !== "string") {
    throw new Error("mineClusters: projectId is required");
  }

  const summaries = await fetchSummariesForProject(opts.projectId, batch);
  if (summaries.length === 0) return [];

  const archiveByChunk = await fetchSuccessArchiveByChunk(opts.projectId);

  // INNER JOIN semantics: keep only summaries whose source_chunk_id maps to
  // a successful archive_backlog row. Pure mining surface — failed/in-flight
  // tasks must NEVER seed a candidate skill.
  const successful = summaries.filter((s) =>
    archiveByChunk.has(s.source_chunk_id),
  );
  if (successful.length === 0) return [];

  const clusters = clusterSummaries(successful);

  // M4 / Phase B: load rollback signals for every source_chunk_id that
  // participates in any cluster ≥ minFreq. We scan ONCE per tick (single
  // round-trip over .in()) so the per-cluster overhead is O(1). When the
  // workflow_checkpoints table is not yet deployed (legacy boot path),
  // fetchRollbackSignalsByChunk returns an empty Map and mining is
  // byte-identical to the pre-M4 behavior.
  const candidateChunkIds: number[] = [];
  for (const c of clusters) {
    if (c.summaries.length < minFreq) continue;
    for (const s of c.summaries) candidateChunkIds.push(s.source_chunk_id);
  }
  const rollbackByChunk = await fetchRollbackSignalsByChunk(
    opts.projectId,
    candidateChunkIds,
  );

  const stubs: CandidateStub[] = [];
  for (const c of clusters) {
    if (c.summaries.length < minFreq) continue;

    const summaryIds = Array.from(
      new Set(c.summaries.map((s) => s.id)),
    ).sort((a, b) => a - b);
    const backlogIds = Array.from(
      new Set(
        c.summaries
          .map((s) => archiveByChunk.get(s.source_chunk_id))
          .filter((v): v is number => typeof v === "number"),
      ),
    ).sort((a, b) => a - b);

    const centroid = meanVector(
      c.summaries
        .map((s) => s.summary_embedding ?? [])
        .filter((v) => v.length > 0),
    );

    // Representative summary: the longest one in the cluster (heuristic —
    // tends to be the most information-rich variant for the LLM proposer).
    const representative = c.summaries
      .slice()
      .sort((a, b) => b.summary.length - a.summary.length)[0].summary;

    // Sum rollback votes across every chunk that fed this cluster.
    // Floor at 0 so success_count never goes negative — that would crash
    // the upsert_skill_candidate CHECK constraint (success_count ≥ 0).
    let clusterRollbackCount = 0;
    for (const s of c.summaries) {
      const sig = rollbackByChunk.get(s.source_chunk_id);
      if (sig) clusterRollbackCount += sig.rollback_count;
    }
    const baseSuccessCount = c.summaries.length;
    const adjustedSuccessCount = Math.max(
      0,
      baseSuccessCount - clusterRollbackCount,
    );
    if (clusterRollbackCount > 0) {
      console.log(
        `[M3] applied ${clusterRollbackCount} rollback signals to cluster hash=${c.hash} (success_count ${baseSuccessCount} -> ${adjustedSuccessCount})`,
      );
    }

    stubs.push({
      project_id: opts.projectId,
      pattern_hash: c.hash,
      source_summary_ids: summaryIds,
      source_backlog_ids: backlogIds,
      frequency: c.summaries.length,
      // INNER JOIN guarantees every contributing summary maps to a success
      // archive row, so the pre-M4 floor is c.summaries.length. M4 rollback
      // signals decrement this floor by clusterRollbackCount (≥ 0).
      success_count: adjustedSuccessCount,
      candidate_embedding: centroid,
      representative_summary: representative,
      cluster_summaries: c.summaries.map((s) => s.summary),
    });
  }

  // Stable order so re-running with the same data emits the same sequence.
  stubs.sort((a, b) => b.frequency - a.frequency || a.pattern_hash.localeCompare(b.pattern_hash));
  return stubs;
}
