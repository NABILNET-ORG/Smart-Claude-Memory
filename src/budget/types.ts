// SCM-S39-D1 / v2.2.2 — Agentic Resource Manager type surface.
// Decoupled task vs daemon budgets share a common decision shape but
// nothing else. See scripts/021_agent_budgets.sql for the storage layout.

export type BudgetMode = "off" | "warn" | "enforce";

// ─── Per-Task Surface (Orchestrator LLM lifecycle) ────────────────────────

export type TaskAxis = "anthropic_tokens" | "ollama_calls" | "subagent_depth";

export type TaskCaps = {
  anthropic_tokens: number;
  ollama_calls: number;
  subagent_depth: number;
};

export type BudgetTask = {
  task_id: string;
  project_id: string;
  started_at: string;
  ended_at: string | null;
  mode: BudgetMode;
  frozen_caps: TaskCaps;
  anthropic_tokens_used: number;
  ollama_calls_used: number;
  subagent_depth_max: number;
};

// ─── Per-Daemon Surface (rolling-hour buckets) ────────────────────────────

export type DaemonAxis = "ollama_calls" | "embed_calls";

export type DaemonBucket = {
  daemon: string;
  axis: DaemonAxis;
  hour_bucket: string;
  count: number;
  first_seen: string;
  last_seen: string;
};

// ─── Shared decision shape returned by both gate paths ────────────────────

export type GateDecision = {
  decision: "allow" | "warn" | "block";
  mode: BudgetMode;
  axis: TaskAxis | DaemonAxis;
  delta: number;
  total: number; // task: total_after; daemon: total_in_hour.
  cap: number;
  hour_bucket?: string; // daemon-only.
  task_id?: string; // task-only.
  daemon?: string; // daemon-only.
  reason?: string;
};

export class BudgetExceededError extends Error {
  constructor(public readonly decision: GateDecision) {
    super(
      `budget exceeded: ${decision.axis} total=${decision.total} cap=${decision.cap}` +
        (decision.task_id ? ` task=${decision.task_id}` : "") +
        (decision.daemon ? ` daemon=${decision.daemon}` : ""),
    );
    this.name = "BudgetExceededError";
  }
}
