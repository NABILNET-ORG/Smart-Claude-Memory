// SCM-S39-D1 / v2.2.2 — MCP tool surface for the Agentic Resource Manager.
// Five thin handlers exposing the gate primitives in src/budget/.
// All schemas use Zod for both runtime validation AND introspection by
// the MCP SDK's tool registration in src/index.ts.

import { z } from "zod";
import { currentProjectId } from "../project.js";
import { resolveMode, resolveTaskCaps, resolveDaemonCap } from "../budget/gate.js";
import {
  closeTask,
  currentDaemonBucket,
  fetchTask,
  insertTask,
  resetDaemonBucket,
} from "../budget/store.js";
import type { BudgetTask, DaemonAxis, TaskCaps } from "../budget/types.js";

// ─── start_task ──────────────────────────────────────────────────────────

export const startTaskInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified CWD ('${currentProjectId}').`,
    ),
  caps: z
    .object({
      anthropic_tokens: z.number().int().positive().optional(),
      ollama_calls: z.number().int().positive().optional(),
      subagent_depth: z.number().int().positive().optional(),
    })
    .optional()
    .describe(
      "Optional per-axis cap overrides. Unspecified axes fall back to " +
        "env (SCM_TASK_CAP_<AXIS>) or hard-coded defaults " +
        "(anthropic_tokens=100000, ollama_calls=50, subagent_depth=2).",
    ),
};

export async function startTask(args: {
  project_id?: string;
  caps?: Partial<TaskCaps>;
}): Promise<{
  task_id: string;
  project_id: string;
  started_at: string;
  mode: BudgetTask["mode"];
  frozen_caps: TaskCaps;
}> {
  const projectId = args.project_id ?? currentProjectId;
  const mode = resolveMode();
  const frozen_caps = resolveTaskCaps(args.caps);
  const task = await insertTask(projectId, mode, frozen_caps);
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    started_at: task.started_at,
    mode: task.mode,
    frozen_caps: task.frozen_caps,
  };
}

// ─── end_task ────────────────────────────────────────────────────────────

export const endTaskInputShape = {
  task_id: z.string().uuid().describe("budget_tasks.task_id to close."),
};

export async function endTask(args: { task_id: string }): Promise<{
  task_id: string;
  ended_at: string;
  mode: BudgetTask["mode"];
  frozen_caps: TaskCaps;
  usage: {
    anthropic_tokens_used: number;
    ollama_calls_used: number;
    subagent_depth_max: number;
  };
  burn: { anthropic_tokens: number | null; ollama_calls: number | null };
}> {
  const task = await closeTask(args.task_id);
  const burn = {
    anthropic_tokens:
      task.frozen_caps.anthropic_tokens > 0
        ? task.anthropic_tokens_used / task.frozen_caps.anthropic_tokens
        : null,
    ollama_calls:
      task.frozen_caps.ollama_calls > 0
        ? task.ollama_calls_used / task.frozen_caps.ollama_calls
        : null,
  };
  return {
    task_id: task.task_id,
    ended_at: task.ended_at ?? new Date().toISOString(),
    mode: task.mode,
    frozen_caps: task.frozen_caps,
    usage: {
      anthropic_tokens_used: task.anthropic_tokens_used,
      ollama_calls_used: task.ollama_calls_used,
      subagent_depth_max: task.subagent_depth_max,
    },
    burn,
  };
}

// ─── get_task_budget ─────────────────────────────────────────────────────

export const getTaskBudgetInputShape = {
  task_id: z
    .string()
    .uuid()
    .describe("budget_tasks.task_id to inspect. Required — no implicit lookup."),
};

export async function getTaskBudget(args: {
  task_id: string;
}): Promise<
  | { ok: true; task: BudgetTask }
  | { ok: false; reason: "not_found"; task_id: string }
> {
  const task = await fetchTask(args.task_id);
  if (!task) return { ok: false, reason: "not_found", task_id: args.task_id };
  return { ok: true, task };
}

// ─── get_daemon_budget ───────────────────────────────────────────────────

export const getDaemonBudgetInputShape = {
  daemon: z
    .string()
    .optional()
    .describe(
      "Daemon name filter (e.g. 'trajectory_compactor'). Omit to return " +
        "all currently-gated daemons.",
    ),
  axis: z
    .enum(["ollama_calls", "embed_calls"])
    .optional()
    .describe("Axis filter. Default returns ollama_calls."),
};

export async function getDaemonBudget(args: {
  daemon?: string;
  axis?: DaemonAxis;
}): Promise<{
  mode: ReturnType<typeof resolveMode>;
  rows: Array<{
    daemon: string;
    axis: DaemonAxis;
    total_in_hour: number;
    cap: number;
    burn_ratio: number | null;
  }>;
}> {
  const axis: DaemonAxis = args.axis ?? "ollama_calls";
  // Known daemons under the budget contract. Future daemons get added here.
  const candidates = args.daemon
    ? [args.daemon]
    : ["trajectory_compactor"];
  const rows = await Promise.all(
    candidates.map(async (d) => {
      const total = await currentDaemonBucket(d, axis);
      const cap = resolveDaemonCap(d, axis);
      return {
        daemon: d,
        axis,
        total_in_hour: total,
        cap,
        burn_ratio: cap > 0 ? total / cap : null,
      };
    }),
  );
  return { mode: resolveMode(), rows };
}

// ─── reset_daemon_budget ─────────────────────────────────────────────────

export const resetDaemonBudgetInputShape = {
  daemon: z
    .string()
    .describe("Daemon name whose current-hour bucket should be zeroed."),
  axis: z
    .enum(["ollama_calls", "embed_calls"])
    .describe("Axis to reset."),
  confirm: z
    .literal(true)
    .describe(
      "Must be exactly `true` — explicit confirmation guard against accidental resets.",
    ),
};

export async function resetDaemonBudgetTool(args: {
  daemon: string;
  axis: DaemonAxis;
  confirm: true;
}): Promise<{
  ok: true;
  daemon: string;
  axis: DaemonAxis;
  was: number;
  hour_bucket_reset_at: string;
}> {
  if (args.confirm !== true) {
    throw new Error("reset_daemon_budget requires confirm: true");
  }
  const was = await resetDaemonBucket(args.daemon, args.axis);
  return {
    ok: true,
    daemon: args.daemon,
    axis: args.axis,
    was,
    hour_bucket_reset_at: new Date().toISOString(),
  };
}
