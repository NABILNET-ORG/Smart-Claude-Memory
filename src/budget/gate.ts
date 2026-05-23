// SCM-S39-D1 / v2.2.2 — Agentic Resource Manager gate.
// The ONLY enforcement function callers should import. Two disjoint
// entry points map to the two decoupled storage surfaces; both share
// the same off/warn/enforce mode switch via SCM_BUDGET_ENFORCEMENT_MODE.

import type {
  BudgetMode,
  DaemonAxis,
  GateDecision,
  TaskAxis,
  TaskCaps,
} from "./types.js";
import { BudgetExceededError } from "./types.js";
import {
  currentDaemonBucket,
  fetchTask,
  incrementDaemonBucket,
  incrementTaskCounter,
  recordDaemonEvent,
  recordTaskEvent,
} from "./store.js";

// ─── Mode + cap resolution ───────────────────────────────────────────────

export function resolveMode(): BudgetMode {
  const raw = (process.env.SCM_BUDGET_ENFORCEMENT_MODE ?? "off").toLowerCase();
  if (raw === "warn" || raw === "enforce") return raw;
  return "off";
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveTaskCaps(overrides?: Partial<TaskCaps>): TaskCaps {
  return {
    anthropic_tokens:
      overrides?.anthropic_tokens ??
      readIntEnv("SCM_TASK_CAP_ANTHROPIC_TOKENS", 100_000),
    ollama_calls:
      overrides?.ollama_calls ?? readIntEnv("SCM_TASK_CAP_OLLAMA_CALLS", 50),
    subagent_depth:
      overrides?.subagent_depth ?? readIntEnv("SCM_TASK_CAP_SUBAGENT_DEPTH", 2),
  };
}

// Daemon caps are looked up per-call so operators can retune without
// restart. Order of resolution:
//   1. SCM_<DAEMON_UPPER>_CAP_<AXIS_UPPER>_PER_HOUR (specific override).
//   2. SCM_DAEMON_CAP_<AXIS_UPPER>_PER_HOUR        (global default).
//   3. Hard-coded fallback.
export function resolveDaemonCap(daemon: string, axis: DaemonAxis): number {
  const axisUpper = axis.toUpperCase();
  const daemonUpper = daemon.toUpperCase();
  const specific = readIntEnv(`SCM_${daemonUpper}_CAP_${axisUpper}_PER_HOUR`, 0);
  if (specific > 0) return specific;
  const fallback = axis === "ollama_calls" ? 50 : 10_000;
  return readIntEnv(`SCM_DAEMON_CAP_${axisUpper}_PER_HOUR`, fallback);
}

// Burn-ratio thresholds for the warn band. Mirrors the GUI's color tokens.
export const WARN_RATIO = 0.8;

// Exported so tests/budget-gate.test.ts can drive the decision matrix
// without spinning up Supabase. Pure function: no I/O.
export function classify(
  total: number,
  cap: number,
  mode: BudgetMode,
): GateDecision["decision"] {
  if (mode === "off") return "allow";
  if (cap <= 0) return "allow";
  if (total > cap) return "block";
  if (total / cap >= WARN_RATIO) return "warn";
  return "allow";
}

// ─── Per-Task Gate ───────────────────────────────────────────────────────

export async function checkTaskBudget(
  task_id: string,
  axis: TaskAxis,
  delta: number,
): Promise<GateDecision> {
  const mode = resolveMode();
  // Mode=off short-circuit BEFORE any DB write. Zero overhead path.
  if (mode === "off") {
    return {
      decision: "allow",
      mode,
      axis,
      delta,
      total: 0,
      cap: 0,
      task_id,
      reason: "mode=off",
    };
  }
  const task = await fetchTask(task_id);
  if (!task) {
    throw new Error(`checkTaskBudget: task ${task_id} not found`);
  }
  const cap = task.frozen_caps[axis];
  const total = await incrementTaskCounter(task_id, axis, delta);
  const decision = classify(total, cap, mode);
  const result: GateDecision = {
    decision,
    mode,
    axis,
    delta,
    total,
    cap,
    task_id,
  };
  await recordTaskEvent(task_id, axis, delta, total, decision);
  if (decision === "block" && mode === "enforce") {
    throw new BudgetExceededError(result);
  }
  return result;
}

// ─── Per-Daemon Gate ─────────────────────────────────────────────────────

export async function checkDaemonBudget(
  daemon: string,
  axis: DaemonAxis,
  delta: number,
): Promise<GateDecision> {
  const mode = resolveMode();
  if (mode === "off") {
    return {
      decision: "allow",
      mode,
      axis,
      delta,
      total: 0,
      cap: 0,
      daemon,
      reason: "mode=off",
    };
  }
  const cap = resolveDaemonCap(daemon, axis);
  const total = await incrementDaemonBucket(daemon, axis, delta);
  const decision = classify(total, cap, mode);
  const hour_bucket = new Date(
    Date.now() - (Date.now() % 3_600_000),
  ).toISOString();
  const result: GateDecision = {
    decision,
    mode,
    axis,
    delta,
    total,
    cap,
    daemon,
    hour_bucket,
  };
  await recordDaemonEvent(daemon, axis, delta, total, cap, decision, mode);
  // Daemons never THROW on block — they return early and log run_skipped_budget
  // telemetry. Throwing from inside a setInterval tick would orphan the
  // process error handler and is incompatible with the .unref()'d daemon
  // contract. Callers must inspect `decision === 'block'` themselves.
  return result;
}

// ─── Read-only introspection (for MCP tools and the GUI ticker) ──────────

export async function readDaemonBucket(
  daemon: string,
  axis: DaemonAxis,
): Promise<{ total: number; cap: number; mode: BudgetMode }> {
  return {
    total: await currentDaemonBucket(daemon, axis),
    cap: resolveDaemonCap(daemon, axis),
    mode: resolveMode(),
  };
}
