// M8.1 Phase 1 — Knowledge Graph Extractor Daemon.
//
// Background process that polls for memory_chunks rows not yet anchored
// in kg_nodes (no row in kg_nodes with source_chunk_id = chunk.id), runs
// the pure extractor (src/graph/extractor.ts) on each, then upserts the
// resulting nodes + edges through src/tools/kg.ts.
//
// Mirrors src/trajectory/daemon.ts in shape: module-level state, idempotent
// start/stop, .unref()'d setInterval, re-entrancy guard via state.running.
//
// Two-step antijoin (PostgREST can't NOT-IN a subquery): page through
// kg_nodes.source_chunk_id (filtered NOT NULL) into a Set, then overfetch
// memory_chunks and filter client-side.
//
// Skipped chunks (LOG type or too-short) get a SENTINEL node anchored to
// the chunk so the daemon doesn't re-process them next tick.
//
// Boundary Invariant: zero LLM imports. Only supabase + tools/kg.

import { supabase } from "../supabase.js";
import { upsertKgNode, upsertKgNodeFromChunk, upsertKgEdge } from "../tools/kg.js";
import { extractFromChunk } from "./extractor.js";

const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_BATCH = 10;
const OVERFETCH_MULT = 5;
const ANTIJOIN_PAGE = 10_000;

// Derived-status thresholds — mirror src/tools/health.ts deriveDaemonStatus
// so callers see consistent semantics. Daemon owns these locally because
// the daemon's status getter is also consumed outside the health.ts roll-up.
const ERR_RATE_DEGRADED = 0.2;
const STALENESS_MULT = 4; // task spec — 4× interval for graph extractor.

type State = {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  batch: number;
  timer: NodeJS.Timeout | null;
  lastRunAt: string | null;
  lastRunExtracted: number;
  lastRunNodesCreated: number;
  lastRunEdgesCreated: number;
  lastRunSkipped: number;
  lastRunErrored: number;
  lastRunDurationMs: number;
  extractedTotal: number;
};

const state: State = {
  enabled: false,
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  timer: null,
  lastRunAt: null,
  lastRunExtracted: 0,
  lastRunNodesCreated: 0,
  lastRunEdgesCreated: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  extractedTotal: 0,
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isEnabled(): boolean {
  const raw = process.env.SCM_GRAPH_EXTRACTOR_ENABLED;
  if (raw === undefined) return true;
  return raw === "1";
}

function resolveConfig(): { intervalMs: number; batch: number } {
  return {
    intervalMs: readIntEnv("SCM_GRAPH_EXTRACTOR_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("SCM_GRAPH_EXTRACTOR_BATCH", DEFAULT_BATCH),
  };
}


type UnprocessedChunk = {
  id: number;
  project_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
};

async function fetchUnprocessed(batch: number): Promise<UnprocessedChunk[]> {
  const used = new Set<number>();
  const { data: usedRows, error: usedErr } = await supabase
    .from("kg_nodes")
    .select("source_chunk_id")
    .not("source_chunk_id", "is", null)
    .limit(ANTIJOIN_PAGE);
  if (usedErr) throw new Error(`kg_nodes scan failed: ${usedErr.message}`);
  for (const r of (usedRows ?? []) as Array<{ source_chunk_id: number | null }>) {
    if (typeof r.source_chunk_id === "number") used.add(r.source_chunk_id);
  }

  const { data: chunkRows, error: chunkErr } = await supabase
    .from("memory_chunks")
    .select("id, project_id, content, metadata")
    .order("id", { ascending: false })
    .limit(batch * OVERFETCH_MULT);
  if (chunkErr) throw new Error(`memory_chunks scan failed: ${chunkErr.message}`);

  const out: UnprocessedChunk[] = [];
  for (const row of (chunkRows ?? []) as Array<{
    id: number;
    project_id: string;
    content: string;
    metadata: Record<string, unknown> | null;
  }>) {
    if (out.length >= batch) break;
    if (typeof row.id !== "number" || typeof row.content !== "string") continue;
    if (used.has(row.id)) continue;
    out.push({
      id: row.id,
      project_id: row.project_id,
      content: row.content,
      metadata: row.metadata ?? null,
    });
  }
  return out;
}

type RunCounts = {
  extracted: number;
  nodes: number;
  edges: number;
  skipped: number;
  errored: number;
};

function makeKey(t: string, l: string): string {
  return `${t}|${l}`;
}

async function processChunk(
  chunk: UnprocessedChunk,
  counts: RunCounts,
): Promise<void> {
  try {
    const result = extractFromChunk(chunk);

    if (result.skipped) {
      // Sentinel: anchor the chunk so it doesn't re-enter the queue.
      // SCM-S55: sentinel anchor uses server-side RPC (embedding copy is a no-op
      // for skipped chunks but keeps the call path uniform).
      const sentinel = await upsertKgNodeFromChunk({
        project_id: chunk.project_id,
        type: "NOTE",
        label: `skipped:${chunk.id}`,
        properties: { reason: result.reason ?? "skipped" },
        source_chunk_id: chunk.id,
      });
      if (sentinel.ok) counts.nodes += 1;
      counts.skipped += 1;
      return;
    }

    // Upsert primary node first; capture node_id so we can resolve edges.
    const labelToId = new Map<string, number>();
    const [primary, ...secondaries] = result.nodes;
    if (!primary) return;

    // SCM-S55: use server-side RPC so embedding is copied inside Postgres.
    const primaryRes = await upsertKgNodeFromChunk({
      project_id: chunk.project_id,
      type: primary.type,
      label: primary.label,
      properties: primary.properties,
      source_chunk_id: primary.source_chunk_id ?? chunk.id,
    });
    if (!primaryRes.ok) {
      counts.errored += 1;
      return;
    }
    counts.nodes += 1;
    labelToId.set(makeKey(primary.type, primary.label), primaryRes.node_id);

    for (const n of secondaries) {
      const r = await upsertKgNode({
        project_id: chunk.project_id,
        type: n.type,
        label: n.label,
        properties: n.properties,
      });
      if (r.ok) {
        counts.nodes += 1;
        labelToId.set(makeKey(n.type, n.label), r.node_id);
      }
    }

    for (const e of result.edges) {
      const sId = labelToId.get(makeKey(e.source.type, e.source.label));
      const tId = labelToId.get(makeKey(e.target.type, e.target.label));
      if (sId == null || tId == null) continue;
      const er = await upsertKgEdge({
        project_id: chunk.project_id,
        source_id: sId,
        target_id: tId,
        relation: e.relation,
        weight: e.weight ?? 1.0,
        properties: e.properties ?? {},
      });
      if (er.ok) counts.edges += 1;
    }

    counts.extracted += 1;
  } catch {
    counts.errored += 1;
  }
}

export async function runGraphExtractorOnce(
  opts: { batch?: number } = {},
): Promise<RunCounts> {
  const counts: RunCounts = { extracted: 0, nodes: 0, edges: 0, skipped: 0, errored: 0 };
  if (!isEnabled()) return counts;

  const cfg = resolveConfig();
  const batch = opts.batch ?? cfg.batch;

  let chunks: UnprocessedChunk[] = [];
  try {
    chunks = await fetchUnprocessed(batch);
  } catch {
    counts.errored += 1;
    return counts;
  }

  for (const chunk of chunks) {
    await processChunk(chunk, counts);
  }

  return counts;
}

async function tick(): Promise<void> {
  if (state.running) return;
  if (!isEnabled()) {
    state.enabled = false;
    return;
  }
  state.enabled = true;
  state.running = true;
  const t0 = Date.now();
  try {
    const cfg = resolveConfig();
    state.intervalMs = cfg.intervalMs;
    state.batch = cfg.batch;

    const counts = await runGraphExtractorOnce({ batch: state.batch });
    state.lastRunAt = new Date().toISOString();
    state.lastRunExtracted = counts.extracted;
    state.lastRunNodesCreated = counts.nodes;
    state.lastRunEdgesCreated = counts.edges;
    state.lastRunSkipped = counts.skipped;
    state.lastRunErrored = counts.errored;
    state.lastRunDurationMs = Date.now() - t0;
    state.extractedTotal += counts.extracted;
  } catch {
    state.lastRunErrored += 1;
    state.lastRunAt = new Date().toISOString();
    state.lastRunDurationMs = Date.now() - t0;
  } finally {
    state.running = false;
  }
}

export function startGraphExtractor(opts: { intervalMs?: number; batch?: number } = {}): void {
  if (state.timer) return; // idempotent
  const cfg = resolveConfig();
  state.intervalMs = opts.intervalMs ?? cfg.intervalMs;
  state.batch = opts.batch ?? cfg.batch;
  state.enabled = isEnabled();
  // Fire-and-forget initial tick so first run happens immediately.
  void tick();
  state.timer = setInterval(() => void tick(), state.intervalMs);
  state.timer.unref?.();
}

export function stopGraphExtractor(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  state.enabled = false;
}

export type GraphDaemonStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  batch: number;
  last_run_at: string | null;
  last_run_extracted: number;
  last_run_nodes_created: number;
  last_run_edges_created: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  extracted_total: number;
  derived: {
    status: "healthy" | "pending" | "degraded";
    reason: string;
    error_rate_1h: number;
    staleness_ms: number | null;
    last_run_ended_at: string | null;
  };
};

function deriveStatus(): GraphDaemonStatus["derived"] {
  if (state.lastRunAt === null) {
    return {
      status: "pending",
      reason: "no tick has completed yet",
      error_rate_1h: 0,
      staleness_ms: null,
      last_run_ended_at: null,
    };
  }
  const lastMs = Date.parse(state.lastRunAt);
  const stalenessMs = Math.max(0, Date.now() - lastMs);
  const denom = state.lastRunExtracted + state.lastRunSkipped + state.lastRunErrored;
  const errRate = denom === 0 ? 0 : state.lastRunErrored / denom;
  const stale = stalenessMs > state.intervalMs * STALENESS_MULT;
  if (errRate > ERR_RATE_DEGRADED || stale) {
    return {
      status: "degraded",
      reason: stale
        ? `stale (${stalenessMs}ms > ${state.intervalMs * STALENESS_MULT}ms)`
        : `error_rate=${errRate.toFixed(3)} > ${ERR_RATE_DEGRADED}`,
      error_rate_1h: errRate,
      staleness_ms: stalenessMs,
      last_run_ended_at: state.lastRunAt,
    };
  }
  return {
    status: "healthy",
    reason: "within thresholds",
    error_rate_1h: errRate,
    staleness_ms: stalenessMs,
    last_run_ended_at: state.lastRunAt,
  };
}

export function getGraphExtractorStatus(): GraphDaemonStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    batch: state.batch,
    last_run_at: state.lastRunAt,
    last_run_extracted: state.lastRunExtracted,
    last_run_nodes_created: state.lastRunNodesCreated,
    last_run_edges_created: state.lastRunEdgesCreated,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    extracted_total: state.extractedTotal,
    derived: deriveStatus(),
  };
}
