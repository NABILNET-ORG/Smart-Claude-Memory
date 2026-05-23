// SCM-S39-D1 / v2.2.2 — Storage wrappers for the Agentic Resource Manager.
// Thin layer over Supabase. The gate (src/budget/gate.ts) is the only
// caller; nothing else in the codebase should import from this file.

import { supabase } from "../supabase.js";
import type {
  BudgetMode,
  BudgetTask,
  DaemonAxis,
  TaskAxis,
  TaskCaps,
} from "./types.js";

// ─── Per-Task Surface ────────────────────────────────────────────────────

export async function insertTask(
  project_id: string,
  mode: BudgetMode,
  frozen_caps: TaskCaps,
): Promise<BudgetTask> {
  const { data, error } = await supabase
    .from("budget_tasks")
    .insert({ project_id, mode, frozen_caps })
    .select(
      "task_id, project_id, started_at, ended_at, mode, frozen_caps, " +
        "anthropic_tokens_used, ollama_calls_used, subagent_depth_max",
    )
    .single();
  if (error) throw new Error(`insertTask failed: ${error.message}`);
  return data as unknown as BudgetTask;
}

export async function fetchTask(task_id: string): Promise<BudgetTask | null> {
  const { data, error } = await supabase
    .from("budget_tasks")
    .select(
      "task_id, project_id, started_at, ended_at, mode, frozen_caps, " +
        "anthropic_tokens_used, ollama_calls_used, subagent_depth_max",
    )
    .eq("task_id", task_id)
    .maybeSingle();
  if (error) throw new Error(`fetchTask failed: ${error.message}`);
  return (data as BudgetTask | null) ?? null;
}

export async function incrementTaskCounter(
  task_id: string,
  axis: TaskAxis,
  delta: number,
): Promise<number> {
  // SQL UPDATE ... RETURNING for atomic read-after-write. The Supabase
  // JS client does not expose RETURNING directly for UPDATE; the .select()
  // chained call here is equivalent because Supabase issues UPDATE ...
  // RETURNING * under the hood when .select() follows .update().
  const column =
    axis === "anthropic_tokens"
      ? "anthropic_tokens_used"
      : axis === "ollama_calls"
        ? "ollama_calls_used"
        : "subagent_depth_max";
  // Read-modify-write — task-side counters are written by a single
  // process (the Orchestrator), so the gap between SELECT and UPDATE is
  // not racey in practice. If concurrent updates ever become possible
  // (multi-Orchestrator?), promote this to a Postgres function.
  const current = await fetchTask(task_id);
  if (!current) throw new Error(`incrementTaskCounter: task ${task_id} not found`);
  const before =
    axis === "anthropic_tokens"
      ? current.anthropic_tokens_used
      : axis === "ollama_calls"
        ? current.ollama_calls_used
        : current.subagent_depth_max;
  const next =
    axis === "subagent_depth" ? Math.max(before, delta) : before + delta;
  const { error } = await supabase
    .from("budget_tasks")
    .update({ [column]: next })
    .eq("task_id", task_id);
  if (error) throw new Error(`incrementTaskCounter failed: ${error.message}`);
  return next;
}

export async function closeTask(task_id: string): Promise<BudgetTask> {
  const { data, error } = await supabase
    .from("budget_tasks")
    .update({ ended_at: new Date().toISOString() })
    .eq("task_id", task_id)
    .select(
      "task_id, project_id, started_at, ended_at, mode, frozen_caps, " +
        "anthropic_tokens_used, ollama_calls_used, subagent_depth_max",
    )
    .single();
  if (error) throw new Error(`closeTask failed: ${error.message}`);
  return data as unknown as BudgetTask;
}

export async function recordTaskEvent(
  task_id: string,
  axis: TaskAxis,
  delta: number,
  total_after: number,
  decision: "allow" | "warn" | "block",
  payload?: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("budget_task_events").insert({
    task_id,
    axis,
    delta,
    total_after,
    decision,
    payload: payload ?? null,
  });
  if (error) {
    // Telemetry-grade failure tolerance — never throw from the audit path.
    console.error(`[budget] recordTaskEvent failed: ${error.message}`);
  }
}

// ─── Per-Daemon Surface ──────────────────────────────────────────────────

export async function incrementDaemonBucket(
  daemon: string,
  axis: DaemonAxis,
  delta: number,
): Promise<number> {
  const { data, error } = await supabase.rpc("increment_daemon_bucket", {
    p_daemon: daemon,
    p_axis: axis,
    p_delta: delta,
  });
  if (error) throw new Error(`increment_daemon_bucket failed: ${error.message}`);
  if (typeof data !== "number") {
    throw new Error(`increment_daemon_bucket returned non-number: ${typeof data}`);
  }
  return data;
}

export async function recordDaemonEvent(
  daemon: string,
  axis: DaemonAxis,
  delta: number,
  total_in_hour: number,
  cap: number,
  decision: "allow" | "warn" | "block",
  mode: BudgetMode,
  payload?: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("daemon_budget_events").insert({
    daemon,
    axis,
    delta,
    total_in_hour,
    cap,
    decision,
    mode,
    payload: payload ?? null,
  });
  if (error) {
    console.error(`[budget] recordDaemonEvent failed: ${error.message}`);
  }
}

export async function currentDaemonBucket(
  daemon: string,
  axis: DaemonAxis,
): Promise<number> {
  // Read-only check — used by get_daemon_budget MCP tool.
  const { data, error } = await supabase
    .from("daemon_budget_buckets")
    .select("count")
    .eq("daemon", daemon)
    .eq("axis", axis)
    .gte(
      "hour_bucket",
      new Date(Date.now() - (Date.now() % 3_600_000)).toISOString(),
    )
    .maybeSingle();
  if (error) throw new Error(`currentDaemonBucket failed: ${error.message}`);
  return data ? (data as { count: number }).count : 0;
}

export async function resetDaemonBucket(
  daemon: string,
  axis: DaemonAxis,
): Promise<number> {
  // Operator-only escape hatch — zeroes the current hour's bucket.
  // Returns the count that was deleted for audit purposes.
  const before = await currentDaemonBucket(daemon, axis);
  const hourStart = new Date(
    Date.now() - (Date.now() % 3_600_000),
  ).toISOString();
  const { error } = await supabase
    .from("daemon_budget_buckets")
    .update({ count: 0 })
    .eq("daemon", daemon)
    .eq("axis", axis)
    .gte("hour_bucket", hourStart);
  if (error) throw new Error(`resetDaemonBucket failed: ${error.message}`);
  return before;
}
