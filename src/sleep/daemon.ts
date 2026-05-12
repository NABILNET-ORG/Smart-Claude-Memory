// Sleep Learning Daemon (Agentic OS 2026 / Mission 3 / SCM-S19-D1).
// Idle miner: every SLEEP_LEARNER_INTERVAL_MS, calls mineClusters() over the
// current project's trajectory_summaries ⋈ archive_backlog (success), emits
// skill_candidates via upsert_skill_candidate RPC.
//
// SCM-S22-D1 (M3 Proposer Remediation / Single Brain mandate):
// The daemon ONLY mines + stubs. Generative naming/step-extraction is the
// Orchestrator's domain (compose_skill_candidate tool). Auto-promotion is
// likewise Orchestrator-only — there is no Node-side promotion path.
// Boundary Invariant #1: no AI/LLM imports inside src/sleep/**.
//
// Mirrors src/trajectory/daemon.ts: module-level state, .unref()'d interval,
// re-entrancy guard, try/finally tick so the loop NEVER throws.

import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { mineClusters, type CandidateStub } from "./miner.js";

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_BATCH = 10;
const DEFAULT_MIN_FREQ = 3;

const state = {
  enabled: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  minFreq: DEFAULT_MIN_FREQ,
  lastRunAt: null as string | null,
  lastRunMined: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  candidatesMinedTotal: 0,
  timer: null as NodeJS.Timeout | null,
  running: false,
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(): {
  intervalMs: number;
  batch: number;
  minFreq: number;
} {
  return {
    intervalMs: readIntEnv("SLEEP_LEARNER_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("SLEEP_LEARNER_BATCH", DEFAULT_BATCH),
    minFreq: readIntEnv("SLEEP_LEARNER_MIN_FREQ", DEFAULT_MIN_FREQ),
  };
}

// ─── per-cluster mining ───────────────────────────────────────────────────

export type MineOneResult = {
  ok: boolean;
  candidate_id: number | null;
  is_new: boolean;
  reason?: string;
};

/**
 * Process one cluster: upsert a stub via the RPC with NULL proposed_name /
 * proposed_steps / model. The Orchestrator fills those in via
 * compose_skill_candidate before promotion. Per-cluster try/catch — one bad
 * cluster never breaks the batch.
 */
export async function mineOneCluster(
  stub: CandidateStub,
): Promise<MineOneResult> {
  const { data: upsertData, error: upsertError } = await supabase.rpc(
    "upsert_skill_candidate",
    {
      p_project_id: stub.project_id,
      p_pattern_hash: stub.pattern_hash,
      p_source_summary_ids: stub.source_summary_ids,
      p_source_backlog_ids: stub.source_backlog_ids,
      p_frequency: stub.frequency,
      p_success_count: stub.success_count,
      p_candidate_embedding: stub.candidate_embedding,
      p_proposed_name: null,
      p_proposed_steps: null,
      p_model: null,
      p_strategy: "centroid+ngram",
    },
  );

  if (upsertError) {
    return {
      ok: false,
      candidate_id: null,
      is_new: false,
      reason: `upsert_failed: ${upsertError.message}`,
    };
  }

  // upsert_skill_candidate returns SETOF (id, state, frequency, success_count, is_new).
  const rows = (upsertData ?? []) as Array<{
    id: number;
    state: string;
    is_new: boolean;
  }>;
  if (rows.length === 0) {
    return {
      ok: false,
      candidate_id: null,
      is_new: false,
      reason: "upsert_returned_no_rows",
    };
  }
  const head = rows[0];

  return {
    ok: true,
    candidate_id: head.id,
    is_new: head.is_new,
  };
}

// ─── per-run orchestration ────────────────────────────────────────────────

export type RunOnceResult = {
  mined: number;
  skipped: number;
  errored: number;
  duration_ms: number;
};

export async function runMiningOnce(
  opts: { projectId?: string; batch?: number; minFreq?: number } = {},
): Promise<RunOnceResult> {
  const t0 = Date.now();
  const cfg = resolveConfig();
  const projectId = opts.projectId ?? currentProjectId;
  const batch = opts.batch ?? cfg.batch;
  const minFreq = opts.minFreq ?? cfg.minFreq;

  let mined = 0;
  let skipped = 0;
  let errored = 0;

  try {
    const stubs = await mineClusters({ projectId, batch, minFreq });
    for (const stub of stubs) {
      try {
        const r = await mineOneCluster(stub);
        if (r.ok) {
          if (r.is_new) mined++;
          else skipped++;
        } else {
          errored++;
        }
      } catch {
        errored++;
      }
    }
  } catch {
    errored++;
  }

  return {
    mined,
    skipped,
    errored,
    duration_ms: Date.now() - t0,
  };
}

// ─── daemon lifecycle ─────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const r = await runMiningOnce({
      batch: state.batch,
      minFreq: state.minFreq,
    });
    state.lastRunMined = r.mined;
    state.lastRunSkipped = r.skipped;
    state.lastRunErrored = r.errored;
    state.lastRunDurationMs = r.duration_ms;
    state.lastRunAt = new Date().toISOString();
    state.candidatesMinedTotal += r.mined;
  } catch {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
  } finally {
    state.running = false;
  }
}

export function startSleepLearner(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.batch = cfg.batch;
  state.minFreq = cfg.minFreq;
  state.enabled = true;
  state.timer = setInterval(() => {
    if (state.running) return;
    void tick();
  }, state.intervalMs);
  state.timer.unref();
}

export function stopSleepLearner(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

export type SleepLearnerStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  batch: number;
  min_freq: number;
  last_run_at: string | null;
  last_run_mined: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  candidates_mined_total: number;
};

export function getSleepLearnerStatus(): SleepLearnerStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    batch: state.batch,
    min_freq: state.minFreq,
    last_run_at: state.lastRunAt,
    last_run_mined: state.lastRunMined,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    candidates_mined_total: state.candidatesMinedTotal,
  };
}
