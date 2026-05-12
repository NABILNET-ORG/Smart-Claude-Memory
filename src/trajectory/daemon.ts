// Trajectory Compaction Daemon (Agentic OS 2026 — Mission 2 / AgentDiet).
// Idle compactor: every TRAJECTORY_COMPACTOR_INTERVAL_MS, pulls bloated
// memory_chunks rows (no matching trajectory_summaries row) and compresses
// each via stripTrajectory → summarizeTrajectory → optional embed → INSERT.
// Mirrors the keepAlive pattern in supabase.ts:74-135 — module-level state,
// idempotent start/stop, .unref()'d interval, re-entrancy guard.

import { embed } from "../ollama.js";
import { supabase } from "../supabase.js";
import { emit } from "../telemetry/emit.js";
import { stripTrajectory } from "./stripper.js";
import { summarizeTrajectory } from "./summarizer.js";

const DEFAULT_INTERVAL_MS = 600_000;
const DEFAULT_BATCH = 25;
const DEFAULT_MIN_BYTES = 16_000;
const MIN_STRIPPED_TOKENS = 250;

const state = {
  enabled: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  minBytes: DEFAULT_MIN_BYTES,
  lastRunAt: null as string | null,
  lastRunCompacted: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  timer: null as NodeJS.Timeout | null,
  running: false,
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(): { intervalMs: number; batch: number; minBytes: number } {
  return {
    intervalMs: readIntEnv("TRAJECTORY_COMPACTOR_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("TRAJECTORY_COMPACTOR_BATCH", DEFAULT_BATCH),
    minBytes: readIntEnv("TRAJECTORY_COMPACTOR_MIN_BYTES", DEFAULT_MIN_BYTES),
  };
}

type CandidateRow = { id: number; project_id: string; content: string };

// PostgREST cannot filter by octet_length directly: we exclude already-
// summarized rows via a Set and filter byte length in code. Over-fetch
// headroom absorbs rows that don't clear the byte threshold.
async function fetchCandidates(limit: number, minBytes: number): Promise<CandidateRow[]> {
  const summarized = new Set<number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("trajectory_summaries")
      .select("source_chunk_id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchCandidates: scan failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (typeof row.source_chunk_id === "number") summarized.add(row.source_chunk_id);
    }
    if (data.length < pageSize) break;
  }

  const overFetch = Math.max(limit * 4, limit + 50);
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("id, project_id, content")
    .order("id", { ascending: true })
    .limit(overFetch);
  if (error) throw new Error(`fetchCandidates: memory_chunks scan failed: ${error.message}`);

  const candidates: CandidateRow[] = [];
  for (const row of data ?? []) {
    if (candidates.length >= limit) break;
    if (typeof row.id !== "number" || typeof row.content !== "string") continue;
    if (summarized.has(row.id)) continue;
    if (Buffer.byteLength(row.content, "utf8") <= minBytes) continue;
    candidates.push({ id: row.id, project_id: row.project_id as string, content: row.content });
  }
  return candidates;
}

export type CompactOneResult = {
  ok: boolean;
  source_tokens: number;
  summary_tokens: number;
  compression_ratio: number;
  summary: string | null;
  reason?: string;
};

function result(
  ok: boolean,
  source: number,
  summaryTokens: number,
  summary: string | null,
  reason?: string,
): CompactOneResult {
  const r: CompactOneResult = {
    ok,
    source_tokens: source,
    summary_tokens: summaryTokens,
    compression_ratio: source > 0 ? summaryTokens / source : 0,
    summary,
  };
  if (reason) r.reason = reason;
  return r;
}

export async function compactOneChunk(
  chunkId: number,
  opts: { dryRun?: boolean } = {},
): Promise<CompactOneResult> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("id, project_id, content")
    .eq("id", chunkId)
    .maybeSingle();
  if (error) return result(false, 0, 0, null, `lookup_failed: ${error.message}`);
  if (!data || typeof data.content !== "string") return result(false, 0, 0, null, "not_found");

  const { stripped, sourceTokens, strippedTokens } = stripTrajectory(data.content);
  if (strippedTokens < MIN_STRIPPED_TOKENS) {
    return result(false, sourceTokens, 0, null, "too_small_after_strip");
  }

  const { summary, summaryTokens, model } = await summarizeTrajectory(stripped);

  // Best-effort embedding (summary_embedding is nullable in
  // scripts/011_trajectory_compaction.sql) — embed failures do not abort.
  let summaryEmbedding: number[] | null = null;
  try {
    const [vec] = await embed([summary]);
    if (Array.isArray(vec) && vec.length > 0) summaryEmbedding = vec;
  } catch {
    summaryEmbedding = null;
  }

  if (opts.dryRun) return result(true, sourceTokens, summaryTokens, summary);

  const { error: insertError } = await supabase.from("trajectory_summaries").upsert(
    {
      project_id: data.project_id as string,
      source_chunk_id: chunkId,
      summary,
      summary_embedding: summaryEmbedding,
      source_tokens: sourceTokens,
      summary_tokens: summaryTokens,
      strategy: "heuristic+llm",
      model,
    },
    { onConflict: "project_id,source_chunk_id" },
  );
  if (insertError) {
    return result(false, sourceTokens, summaryTokens, summary, `insert_failed: ${insertError.message}`);
  }
  return result(true, sourceTokens, summaryTokens, summary);
}

export async function runCompactionOnce(
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<{ compacted: number; skipped: number; errored: number; duration_ms: number }> {
  const t0 = Date.now();
  const cfg = resolveConfig();
  const limit = opts.limit ?? cfg.batch;
  let compacted = 0;
  let skipped = 0;
  let errored = 0;

  try {
    const candidates = await fetchCandidates(limit, cfg.minBytes);
    for (const row of candidates) {
      try {
        const r = await compactOneChunk(row.id, { dryRun: opts.dryRun });
        if (r.ok) compacted++;
        else skipped++;
      } catch {
        errored++;
      }
    }
  } catch {
    errored++;
  }

  return { compacted, skipped, errored, duration_ms: Date.now() - t0 };
}

// Daemon tick — wrapped in try/finally so the loop NEVER throws.
async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const __tStart = Date.now();
  void emit({ daemon: "trajectory_compactor", event: "run_started" });
  try {
    const result = await runCompactionOnce({ limit: state.batch });
    state.lastRunCompacted = result.compacted;
    state.lastRunSkipped = result.skipped;
    state.lastRunErrored = result.errored;
    state.lastRunDurationMs = result.duration_ms;
    state.lastRunAt = new Date().toISOString();
    void emit({
      daemon: "trajectory_compactor",
      event: "run_ended",
      payload: {
        compacted: state.lastRunCompacted,
        skipped: state.lastRunSkipped,
        errored: state.lastRunErrored,
        duration_ms: Date.now() - __tStart,
      },
    });
  } catch (err) {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
    void emit({
      daemon: "trajectory_compactor",
      event: "run_errored",
      payload: {
        error_message: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - __tStart,
      },
    });
  } finally {
    state.running = false;
  }
}

// Public alias for one-shot invocation (smoke tests, Task 6 dashboard probe).
// Keeps the internal `tick` name stable while exposing a stable external name.
export const runTrajectoryCompactorOnce = tick;

export function startCompactor(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.batch = cfg.batch;
  state.minBytes = cfg.minBytes;
  state.enabled = true;
  state.timer = setInterval(() => void tick(), state.intervalMs);
  state.timer.unref();
}

export function stopCompactor(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

export type CompactorStatus = {
  enabled: boolean;
  interval_ms: number;
  last_run_at: string | null;
  last_run_compacted: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
};

export function getCompactorStatus(): CompactorStatus {
  return {
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    last_run_at: state.lastRunAt,
    last_run_compacted: state.lastRunCompacted,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
  };
}
