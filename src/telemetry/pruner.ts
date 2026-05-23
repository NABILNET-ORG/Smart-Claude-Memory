// Telemetry Retention Pruner Daemon (Backlog #124).
// Rolling DELETE: every TELEMETRY_PRUNER_INTERVAL_MS, removes rows from
// daemon_telemetry with created_at older than TELEMETRY_PRUNER_RETENTION_DAYS.
// Mirrors the trajectory daemon shape (src/trajectory/daemon.ts): module-level
// state, idempotent start/stop, .unref()'d interval, re-entrancy guard.
// Emits standard run_started / run_ended / run_errored telemetry — itself a
// daemon producer, so its own activity is observable via system_dashboard.

import { supabase } from "../supabase.js";
import { emit } from "./emit.js";

const DEFAULT_INTERVAL_MS = 21_600_000; // 6h — 4 ticks/day keeps the daemon
//                                         inside the 1h health window.
const DEFAULT_RETENTION_DAYS = 30;

const state = {
  enabled: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  retentionDays: DEFAULT_RETENTION_DAYS,
  lastRunAt: null as string | null,
  lastRunDeleted: 0,
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

function resolveConfig(): { intervalMs: number; retentionDays: number } {
  return {
    intervalMs: readIntEnv("TELEMETRY_PRUNER_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    retentionDays: readIntEnv("TELEMETRY_PRUNER_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
  };
}

// One-shot prune. Exposed for smoke tests + manual invocation. Always returns
// a structured outcome — never throws, since callers (tick + smoke tests)
// must observe error counts deterministically.
//
// SCM-S39-D1: now also prunes the three append-only ARM tables on the
// same retention. budget_tasks itself is intentionally NOT pruned — task
// rows are audit-grade and persistent, like memory_chunks. The per-task
// event log, the daemon event log, and the rotated daemon buckets all
// fall under the same TELEMETRY_PRUNER_RETENTION_DAYS window.
export async function runPruneOnce(
  opts: { retentionDays?: number } = {},
): Promise<{ deleted: number; errored: number; duration_ms: number }> {
  const t0 = Date.now();
  const retentionDays = opts.retentionDays ?? state.retentionDays;
  const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  try {
    // Four parallel DELETEs — each scoped to its natural time axis.
    // count:'exact' on each so we can aggregate the total for telemetry.
    const [telemetryRes, taskEventRes, daemonEventRes, daemonBucketRes] =
      await Promise.all([
        supabase
          .from("daemon_telemetry")
          .delete({ count: "exact" })
          .lt("created_at", cutoffIso),
        supabase
          .from("budget_task_events")
          .delete({ count: "exact" })
          .lt("ts", cutoffIso),
        supabase
          .from("daemon_budget_events")
          .delete({ count: "exact" })
          .lt("ts", cutoffIso),
        supabase
          .from("daemon_budget_buckets")
          .delete({ count: "exact" })
          .lt("hour_bucket", cutoffIso),
      ]);
    const errored =
      (telemetryRes.error ? 1 : 0) +
      (taskEventRes.error ? 1 : 0) +
      (daemonEventRes.error ? 1 : 0) +
      (daemonBucketRes.error ? 1 : 0);
    const deleted =
      (telemetryRes.count ?? 0) +
      (taskEventRes.count ?? 0) +
      (daemonEventRes.count ?? 0) +
      (daemonBucketRes.count ?? 0);
    return { deleted, errored, duration_ms: Date.now() - t0 };
  } catch {
    return { deleted: 0, errored: 1, duration_ms: Date.now() - t0 };
  }
}

// Daemon tick — wrapped in try/finally so the loop NEVER throws.
async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const __tStart = Date.now();
  void emit({ daemon: "telemetry_pruner", event: "run_started" });
  try {
    const result = await runPruneOnce({ retentionDays: state.retentionDays });
    state.lastRunDeleted = result.deleted;
    state.lastRunErrored = result.errored;
    state.lastRunDurationMs = result.duration_ms;
    state.lastRunAt = new Date().toISOString();
    if (result.errored > 0) {
      void emit({
        daemon: "telemetry_pruner",
        event: "run_errored",
        payload: {
          error_message: "delete query failed (see server stderr for details)",
          duration_ms: Date.now() - __tStart,
        },
      });
    } else {
      void emit({
        daemon: "telemetry_pruner",
        event: "run_ended",
        payload: {
          deleted: state.lastRunDeleted,
          retention_days: state.retentionDays,
          duration_ms: Date.now() - __tStart,
        },
      });
    }
  } catch (err) {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
    void emit({
      daemon: "telemetry_pruner",
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

// Public alias for one-shot invocation (smoke tests, manual probes).
export const runTelemetryPrunerOnce = tick;

export function startTelemetryPruner(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.retentionDays = cfg.retentionDays;
  state.enabled = true;
  state.timer = setInterval(() => void tick(), state.intervalMs);
  state.timer.unref();
}

export function stopTelemetryPruner(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

export type TelemetryPrunerStatus = {
  enabled: boolean;
  interval_ms: number;
  retention_days: number;
  last_run_at: string | null;
  last_run_deleted: number;
  last_run_errored: number;
  last_run_duration_ms: number;
};

export function getTelemetryPrunerStatus(): TelemetryPrunerStatus {
  return {
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    retention_days: state.retentionDays,
    last_run_at: state.lastRunAt,
    last_run_deleted: state.lastRunDeleted,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
  };
}
