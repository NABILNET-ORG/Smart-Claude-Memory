// Curriculum Daemon (Agentic OS 2026 / Mission 5 / SCM-S21-D1).
//
// Idle-time deterministic queuer. Every CURRICULUM_INTERVAL_MS, runs the
// three scanner sources (test_gap, rollback_repro, stale_candidate) and
// enqueues curriculum_tasks rows. The Orchestrator (Claude) pulls these
// stubs and writes code; the daemon never authors content.
//
// Boundary Invariant #1 (ARCHITECTURE.md §4.7): NO Ollama / Anthropic /
// OpenAI / generative imports. The CI lint fence asserts this.
//
// Style mirrors src/sleep/daemon.ts:
//   * module-level state, .unref()'d interval, re-entrancy guard,
//     try/finally tick so the loop NEVER throws.

import { currentProjectId } from "../project.js";
import { runScanOnce, type ScannerConfig } from "./scanner.js";
import { emit } from "../telemetry/emit.js";

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 h, staggered +30 min after sleep_learner
const DEFAULT_BATCH = 10;
const DEFAULT_MIN_FREQ = 3;
const DEFAULT_TTL_DAYS = 14;
const DEFAULT_TEST_GAP_PCT_CEILING = 50;
const DEFAULT_TEST_GAP_MIN_LINES = 100;
const DEFAULT_ROLLBACK_THRESHOLD = 3;
const DEFAULT_ROLLBACK_WINDOW_DAYS = 30;
const DEFAULT_STALE_CANDIDATE_MIN_AGE_DAYS = 7;

// ─── state ────────────────────────────────────────────────────────────────

type DaemonState = {
  timer: NodeJS.Timeout | null;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  batch: number;
  minFreq: number;
  ttlDays: number;
  lastRunAt: string | null;
  lastRunQueued: number;
  lastRunSkipped: number;
  lastRunErrored: number;
  lastRunDurationMs: number;
  queuedTotal: number;
  verifiedTotal: number;
  rejectedTotal: number;
  autoPromotionsTotal: number;
};

const state: DaemonState = {
  timer: null,
  enabled: false,
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  minFreq: DEFAULT_MIN_FREQ,
  ttlDays: DEFAULT_TTL_DAYS,
  lastRunAt: null,
  lastRunQueued: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  queuedTotal: 0,
  verifiedTotal: 0,
  rejectedTotal: 0,
  autoPromotionsTotal: 0,
};

// ─── env helpers (mirror src/sleep/daemon.ts) ─────────────────────────────

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(): {
  intervalMs: number;
  batch: number;
  minFreq: number;
  ttlDays: number;
  testGapPctCeiling: number;
  testGapMinLines: number;
  rollbackThreshold: number;
  rollbackWindowDays: number;
  staleCandidateMinAgeDays: number;
} {
  return {
    intervalMs: readIntEnv("CURRICULUM_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("CURRICULUM_BATCH", DEFAULT_BATCH),
    minFreq: readIntEnv("CURRICULUM_MIN_FREQ", DEFAULT_MIN_FREQ),
    ttlDays: readIntEnv("CURRICULUM_TTL_DAYS", DEFAULT_TTL_DAYS),
    testGapPctCeiling: readIntEnv("CURRICULUM_TEST_GAP_PCT", DEFAULT_TEST_GAP_PCT_CEILING),
    testGapMinLines: readIntEnv("CURRICULUM_TEST_GAP_MIN_LINES", DEFAULT_TEST_GAP_MIN_LINES),
    rollbackThreshold: readIntEnv("CURRICULUM_ROLLBACK_THRESHOLD", DEFAULT_ROLLBACK_THRESHOLD),
    rollbackWindowDays: readIntEnv("CURRICULUM_ROLLBACK_WINDOW_DAYS", DEFAULT_ROLLBACK_WINDOW_DAYS),
    staleCandidateMinAgeDays: readIntEnv("CURRICULUM_STALE_CANDIDATE_MIN_AGE_DAYS", DEFAULT_STALE_CANDIDATE_MIN_AGE_DAYS),
  };
}

function buildScannerConfig(): ScannerConfig {
  const cfg = resolveConfig();
  return {
    projectId: currentProjectId,
    workspace: process.cwd(),
    minFreq: cfg.minFreq,
    ttlDays: cfg.ttlDays,
    testGapCoveragePctCeiling: cfg.testGapPctCeiling,
    testGapMinLines: cfg.testGapMinLines,
    rollbackThreshold: cfg.rollbackThreshold,
    rollbackWindowDays: cfg.rollbackWindowDays,
    staleCandidateMinAgeDays: cfg.staleCandidateMinAgeDays,
  };
}

// ─── runScanOnce wrapper (publicly callable for smoke tests) ──────────────

export async function runCurriculumScanOnce(): Promise<{
  total_enqueued: number;
  total_skipped: number;
  total_errored: number;
  duration_ms: number;
  per_source: Array<{
    source: string;
    scanned: number;
    enqueued: number;
    skipped: number;
    errored: number;
  }>;
}> {
  const scannerCfg = buildScannerConfig();
  const result = await runScanOnce(scannerCfg);
  return {
    total_enqueued: result.total_enqueued,
    total_skipped: result.total_skipped,
    total_errored: result.total_errored,
    duration_ms: result.duration_ms,
    per_source: result.per_source,
  };
}

// ─── daemon tick ──────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const __tStart = Date.now();
  void emit({ daemon: "curriculum_scanner", event: "run_started" });
  try {
    const r = await runCurriculumScanOnce();
    state.lastRunQueued = r.total_enqueued;
    state.lastRunSkipped = r.total_skipped;
    state.lastRunErrored = r.total_errored;
    state.lastRunDurationMs = r.duration_ms;
    state.lastRunAt = new Date().toISOString();
    state.queuedTotal += r.total_enqueued;
    void emit({
      daemon: "curriculum_scanner",
      event: "run_ended",
      payload: {
        queued: state.lastRunQueued,
        skipped: state.lastRunSkipped,
        errored: state.lastRunErrored,
        duration_ms: Date.now() - __tStart,
      },
    });
  } catch (err) {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
    void emit({
      daemon: "curriculum_scanner",
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

// ─── public start/stop ────────────────────────────────────────────────────

export function startCurriculumDaemon(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.batch = cfg.batch;
  state.minFreq = cfg.minFreq;
  state.ttlDays = cfg.ttlDays;
  state.enabled = true;
  state.timer = setInterval(() => {
    if (state.running) return;
    void tick();
  }, state.intervalMs);
  state.timer.unref();
}

export function stopCurriculumDaemon(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

// ─── stats incrementers (called by tools/curriculum.ts on apply) ──────────

export function recordVerified(autoPromoted: boolean): void {
  state.verifiedTotal++;
  if (autoPromoted) state.autoPromotionsTotal++;
  void emit({ daemon: "curriculum_scanner", event: "task_outcome", payload: { verified: 1 } });
  if (autoPromoted) {
    void emit({ daemon: "curriculum_scanner", event: "task_outcome", payload: { auto_promoted: 1 } });
  }
}

export function recordRejected(): void {
  state.rejectedTotal++;
  void emit({ daemon: "curriculum_scanner", event: "task_outcome", payload: { rejected: 1 } });
}

// ─── status (mirrors getSleepLearnerStatus shape) ─────────────────────────

export type CurriculumStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  batch: number;
  min_freq: number;
  ttl_days: number;
  last_run_at: string | null;
  last_run_queued: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  queued_total: number;
  verified_total: number;
  rejected_total: number;
  auto_promotions_total: number;
};

export function getCurriculumStatus(): CurriculumStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    batch: state.batch,
    min_freq: state.minFreq,
    ttl_days: state.ttlDays,
    last_run_at: state.lastRunAt,
    last_run_queued: state.lastRunQueued,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    queued_total: state.queuedTotal,
    verified_total: state.verifiedTotal,
    rejected_total: state.rejectedTotal,
    auto_promotions_total: state.autoPromotionsTotal,
  };
}

export const runCurriculumScannerOnce = tick;
