// M7 Graduation Daemon (Agentic OS 2026 / Mission 7 / SCM-S33-D3).
//
// Idle-time deterministic queuer. Every GRADUATION_INTERVAL_MS, runs the
// scanner against the current project's agent_skills and enqueues
// skill_graduations rows at state='proposed'. The Orchestrator (Claude)
// drives compose → confirm/reject downstream; the daemon never authors a
// global_rationale and never mints is_global=true.
//
// Boundary Invariant #1 (extended for M7 in 5f9d2b4): NO Ollama / Anthropic /
// OpenAI / generative imports in src/graduation/**. The lint fence asserts
// this — daemon.ts is included via the same ROOTS glob.
//
// Sovereign mandate (S33 lock, ARCHITECTURE.md §4.9):
//   1. Daemon NEVER calls apply_graduation, compose_global_rationale, or
//      reject_graduation. Its only write surface is INSERT INTO
//      skill_graduations (state='proposed', frozen telemetry snapshot).
//   2. Daemon NEVER writes project_id='GLOBAL'. Every INSERT carries the
//      source skill's local project_id verbatim.
//
// Style mirrors src/curriculum/daemon.ts exactly: module-level state,
// .unref()'d interval, re-entrancy guard, try/finally tick so the loop
// NEVER throws.

import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { findGraduationCandidates, type FindCandidatesOpts } from "./scanner.js";
import { emit } from "../telemetry/emit.js";

// Defaults locked 2026-05-18 (SCM-S33-D1 plan). Stagger interval one hour
// after curriculum_scanner to keep telemetry tick spikes from overlapping.
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 h
const DEFAULT_BATCH = 10;
const DEFAULT_MIN_FREQUENCY = 10;
const DEFAULT_MIN_SUCCESS_RATE = 0.9;
const DEFAULT_MIN_AGE_DAYS = 14;

// ─── state ────────────────────────────────────────────────────────────────

type DaemonState = {
  timer: NodeJS.Timeout | null;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  batch: number;
  minFrequency: number;
  minSuccessRate: number;
  minAgeDays: number;
  lastRunAt: string | null;
  lastRunProposed: number;
  lastRunSkipped: number;
  lastRunErrored: number;
  lastRunDurationMs: number;
  proposedTotal: number;
};

const state: DaemonState = {
  timer: null,
  enabled: false,
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  minFrequency: DEFAULT_MIN_FREQUENCY,
  minSuccessRate: DEFAULT_MIN_SUCCESS_RATE,
  minAgeDays: DEFAULT_MIN_AGE_DAYS,
  lastRunAt: null,
  lastRunProposed: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  proposedTotal: 0,
};

// ─── env helpers ──────────────────────────────────────────────────────────

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function resolveConfig(): {
  intervalMs: number;
  batch: number;
  minFrequency: number;
  minSuccessRate: number;
  minAgeDays: number;
} {
  return {
    intervalMs: readIntEnv("GRADUATION_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("GRADUATION_BATCH", DEFAULT_BATCH),
    minFrequency: readIntEnv("GRADUATION_MIN_FREQUENCY", DEFAULT_MIN_FREQUENCY),
    minSuccessRate: readFloatEnv("GRADUATION_MIN_SUCCESS_RATE", DEFAULT_MIN_SUCCESS_RATE),
    minAgeDays: readIntEnv("GRADUATION_MIN_AGE_DAYS", DEFAULT_MIN_AGE_DAYS),
  };
}

// ─── runScanOnce (publicly callable for smoke / Suite F) ──────────────────
// Scans the current project for graduation candidates and enqueues each as
// a skill_graduations row at state='proposed'. Telemetry snapshot is FROZEN
// at insert-time (frequency_at_propose / success_rate_at_propose /
// age_days_at_propose) — the source skill's live telemetry can continue to
// drift without invalidating the audit row.

export type GraduationScanResult = {
  total_proposed: number;
  total_skipped: number;
  total_errored: number;
  duration_ms: number;
};

export async function runGraduationScanOnce(
  opts: FindCandidatesOpts = {},
): Promise<GraduationScanResult> {
  const tStart = Date.now();
  const cfg = resolveConfig();
  // Default to current project, but the caller can override (multi-tenant
  // scans). The scanner's blocked-set filter ensures candidates already in
  // ('proposed','composed','approved') do NOT resurface.
  const candidates = await findGraduationCandidates({
    projectId: opts.projectId ?? currentProjectId,
    minFrequency: opts.minFrequency ?? cfg.minFrequency,
    minSuccessRate: opts.minSuccessRate ?? cfg.minSuccessRate,
    minAgeDays: opts.minAgeDays ?? cfg.minAgeDays,
    batch: opts.batch ?? cfg.batch,
  });

  let proposed = 0;
  let skipped = 0;
  let errored = 0;

  for (const c of candidates) {
    const { error } = await supabase.from("skill_graduations").insert({
      project_id: c.project_id,
      source_skill_id: c.source_skill_id,
      state: "proposed",
      frequency_at_propose: c.frequency_at_propose,
      success_rate_at_propose: c.success_rate_at_propose,
      age_days_at_propose: c.age_days_at_propose,
    });
    if (error) {
      // 23505 = unique_violation — partial UNIQUE caught a race where
      // another process inserted the same source_skill_id concurrently.
      // Treat as a skip, not an error — the conflicting row is exactly
      // what we wanted anyway.
      if ((error as { code?: string }).code === "23505") {
        skipped++;
      } else {
        errored++;
      }
    } else {
      proposed++;
    }
  }

  return {
    total_proposed: proposed,
    total_skipped: skipped,
    total_errored: errored,
    duration_ms: Date.now() - tStart,
  };
}

// ─── daemon tick ──────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const __tStart = Date.now();
  void emit({ daemon: "graduation_scanner", event: "run_started" });
  try {
    const r = await runGraduationScanOnce();
    state.lastRunProposed = r.total_proposed;
    state.lastRunSkipped = r.total_skipped;
    state.lastRunErrored = r.total_errored;
    state.lastRunDurationMs = r.duration_ms;
    state.lastRunAt = new Date().toISOString();
    state.proposedTotal += r.total_proposed;
    void emit({
      daemon: "graduation_scanner",
      event: "run_ended",
      payload: {
        proposed: state.lastRunProposed,
        skipped: state.lastRunSkipped,
        errored: state.lastRunErrored,
        duration_ms: Date.now() - __tStart,
      },
    });
  } catch (err) {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
    void emit({
      daemon: "graduation_scanner",
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

export function startGraduationDaemon(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.batch = cfg.batch;
  state.minFrequency = cfg.minFrequency;
  state.minSuccessRate = cfg.minSuccessRate;
  state.minAgeDays = cfg.minAgeDays;
  state.enabled = true;
  state.timer = setInterval(() => {
    if (state.running) return;
    void tick();
  }, state.intervalMs);
  state.timer.unref();
}

export function stopGraduationDaemon(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

// ─── status (mirrors getCurriculumStatus shape) ───────────────────────────

export type GraduationStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  batch: number;
  min_frequency: number;
  min_success_rate: number;
  min_age_days: number;
  last_run_at: string | null;
  last_run_proposed: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  proposed_total: number;
};

export function getGraduationStatus(): GraduationStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    batch: state.batch,
    min_frequency: state.minFrequency,
    min_success_rate: state.minSuccessRate,
    min_age_days: state.minAgeDays,
    last_run_at: state.lastRunAt,
    last_run_proposed: state.lastRunProposed,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    proposed_total: state.proposedTotal,
  };
}

export const runGraduationScannerOnce = tick;
