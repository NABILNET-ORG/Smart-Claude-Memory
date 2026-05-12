// MCP tool wrappers for M5 Autonomous Curriculum
// (Agentic OS 2026 / Mission 5 / SCM-S21-D1).
//
// Four handlers. The daemon is a deterministic queuer; these tools are the
// Orchestrator's interface to the queue:
//
//   * list_curriculum_tasks   — inspection / dashboards.
//   * pull_curriculum_task    — atomic claim via pull_next_curriculum_task RPC
//                               (FOR UPDATE SKIP LOCKED). The Orchestrator's
//                               entry point for picking up work.
//   * apply_curriculum_task   — verification-gated finalize. Asserts the
//                               verification-pending.json gate is CLEAR
//                               BEFORE calling the apply_curriculum_task RPC.
//                               The RPC itself does the atomic SQL work
//                               (status flip + optional auto-promote).
//   * reject_curriculum_task  — manual veto (status='rejected').
//
// Boundary Invariant #2 (ARCHITECTURE.md §4.7): the auto-promote path lives
// only inside the SQL RPC — this tool surface does NOT call
// promote_candidate_to_skill directly. Audit by greping:
//   grep -rn promote_candidate_to_skill src/
// Should yield exactly ONE TS call site — sleep.ts (manual M3 promotion).
// Curriculum.ts must NOT appear.
//
// Style mirrors src/tools/sleep.ts and src/tools/checkpoint.ts.

import { z } from "zod";
import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { getPending } from "../verification-gate.js";
import { recordVerified, recordRejected } from "../curriculum/daemon.js";

// ─── shared project_id helper (mirrors sleep.ts / checkpoint.ts) ──────────

function resolveProjectId(explicit: string | undefined): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  return currentProjectId;
}

// ─── list_curriculum_tasks ────────────────────────────────────────────────

export const listCurriculumTasksInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace filter. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  status: z
    .enum(["queued", "pulled", "attempted", "verified", "rejected", "expired"])
    .optional()
    .describe(
      "Filter by task lifecycle state. Omit to return all states (capped by limit).",
    ),
  kind: z
    .enum(["test_gap", "refactor", "rollback_repro"])
    .optional()
    .describe(
      "Filter by signal source: test_gap (low coverage), refactor (stale skill candidate), rollback_repro (M4 rollback hotspot).",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum rows to return. Default 20, hard cap 100."),
};

type CurriculumTaskRow = {
  id: number;
  project_id: string;
  kind: string;
  target_path: string;
  rationale: string;
  signal_source: Record<string, unknown>;
  linked_candidate_id: number | null;
  linked_checkpoint_id: number | null;
  status: string;
  rejection_reason: string | null;
  pulled_by_session_id: string | null;
  pulled_at: string | null;
  verified_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listCurriculumTasks(args: {
  project_id?: string;
  status?: string;
  kind?: string;
  limit?: number;
}): Promise<{ count: number; tasks: CurriculumTaskRow[] }> {
  const projectId = resolveProjectId(args.project_id);
  const limit = args.limit ?? 20;

  let q = supabase
    .from("curriculum_tasks")
    .select(
      "id, project_id, kind, target_path, rationale, signal_source, " +
        "linked_candidate_id, linked_checkpoint_id, status, rejection_reason, " +
        "pulled_by_session_id, pulled_at, verified_at, expires_at, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (args.status) q = q.eq("status", args.status);
  if (args.kind) q = q.eq("kind", args.kind);

  const { data, error } = await q;
  if (error) {
    throw new Error(`list_curriculum_tasks failed: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as CurriculumTaskRow[];
  return { count: rows.length, tasks: rows };
}

// ─── pull_curriculum_task ─────────────────────────────────────────────────

export const pullCurriculumTaskInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  kind: z
    .enum(["test_gap", "refactor", "rollback_repro"])
    .nullable()
    .optional()
    .describe(
      "Optionally restrict the claim to a single kind. NULL/omitted = any kind. Auto-promote-eligible tasks (linked_candidate_id IS NOT NULL) are prioritized regardless.",
    ),
  session_id: z
    .string()
    .min(1)
    .describe(
      "Session identifier stamped on the claimed row (audit trail). Use the orchestrator's session id, conversation id, or any stable string for this run.",
    ),
};

type PullResult = {
  id: number;
  project_id: string;
  kind: string;
  target_path: string;
  rationale: string;
  signal_source: Record<string, unknown>;
  linked_candidate_id: number | null;
  status: string;
  pulled_by_session_id: string;
  pulled_at: string;
  expires_at: string | null;
  created_at: string;
};

export async function pullCurriculumTask(args: {
  project_id?: string;
  kind?: string | null;
  session_id: string;
}): Promise<{ claimed: boolean; task: PullResult | null }> {
  const projectId = resolveProjectId(args.project_id);

  const { data, error } = await supabase.rpc("pull_next_curriculum_task", {
    p_project_id: projectId,
    p_kind: args.kind ?? null,
    p_session_id: args.session_id,
  });

  if (error) {
    throw new Error(`pull_curriculum_task failed: ${error.message}`);
  }

  const rows = (data ?? []) as PullResult[];
  if (rows.length === 0) {
    return { claimed: false, task: null };
  }
  return { claimed: true, task: rows[0] };
}

// ─── apply_curriculum_task ────────────────────────────────────────────────

export const applyCurriculumTaskInputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe(
      "curriculum_tasks.id of the row to finalize. Must currently be in 'pulled' or 'attempted' state.",
    ),
  success: z
    .boolean()
    .describe(
      "TRUE finalizes as verified (requires checkpoint_id + committed checkpoint). FALSE finalizes as rejected.",
    ),
  checkpoint_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "workflow_checkpoints.id wrapping the orchestrator's write. Required when success=true; the RPC asserts status='committed'.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Skill description passed to promote_candidate_to_skill when linked_candidate_id is set on the task. On success+linked, defaults to 'Auto-promoted via M5 curriculum task #N'. On failure, used as rejection_reason if provided.",
    ),
  trigger_keywords: z
    .array(z.string())
    .optional()
    .describe(
      "Skill trigger keywords passed to promote_candidate_to_skill when linked_candidate_id is set. Defaults to []. Ignored on failure.",
    ),
  bypass_verification_gate: z
    .boolean()
    .optional()
    .describe(
      "ESCAPE HATCH. Default false. When false (and success=true), the tool refuses to apply if verification-pending.json exists — the Orchestrator must clear it via confirm_verification first. Set true ONLY for smoke tests / tooling.",
    ),
};

type ApplyResult = {
  task_id: number;
  applied_status: string;
  linked_checkpoint_id: number | null;
  promoted_candidate_id: number | null;
  promoted_skill_id: number | null;
  promoted_at: string | null;
};

export async function applyCurriculumTask(args: {
  task_id: number;
  success: boolean;
  checkpoint_id?: number | null;
  description?: string;
  trigger_keywords?: string[];
  bypass_verification_gate?: boolean;
}): Promise<{
  ok: boolean;
  gate_clear: boolean;
  reason?: string;
  result: ApplyResult | null;
}> {
  // Boundary Invariant: verification gate clearance is checked BEFORE the RPC.
  // The daemon never reaches this code path; this is Orchestrator-only.
  // Failure path skips the gate check (rejection has no main-touching write).
  let gateClear = true;
  if (args.success && !args.bypass_verification_gate) {
    const pending = await getPending();
    if (pending !== null) {
      gateClear = false;
      return {
        ok: false,
        gate_clear: false,
        reason: `[M5] verification gate not cleared: ${pending.file ?? "pending"}. ` +
          `Call confirm_verification({ success: true|false }) before applying.`,
        result: null,
      };
    }
  }

  const { data, error } = await supabase.rpc("apply_curriculum_task", {
    p_task_id: args.task_id,
    p_success: args.success,
    p_checkpoint_id: args.checkpoint_id ?? null,
    p_description: args.description ?? null,
    p_trigger_keywords: args.trigger_keywords ?? null,
  });

  if (error) {
    return {
      ok: false,
      gate_clear: gateClear,
      reason: `[M5] apply_curriculum_task RPC failed: ${error.message}`,
      result: null,
    };
  }

  const rows = (data ?? []) as ApplyResult[];
  if (rows.length === 0) {
    return {
      ok: false,
      gate_clear: gateClear,
      reason: "[M5] apply_curriculum_task returned no rows",
      result: null,
    };
  }

  const r = rows[0];
  if (r.applied_status === "verified") {
    recordVerified(r.promoted_candidate_id !== null);
  } else if (r.applied_status === "rejected") {
    recordRejected();
  }

  return { ok: true, gate_clear: gateClear, result: r };
}

// ─── reject_curriculum_task ───────────────────────────────────────────────

export const rejectCurriculumTaskInputShape = {
  task_id: z
    .number()
    .int()
    .positive()
    .describe("curriculum_tasks.id to reject."),
  reason: z
    .string()
    .min(1)
    .describe("Free-text rationale stored on the row. Surfaced in list_curriculum_tasks."),
};

export async function rejectCurriculumTask(args: {
  task_id: number;
  reason: string;
}): Promise<{ ok: boolean; task_id: number; status: string }> {
  const { data, error } = await supabase
    .from("curriculum_tasks")
    .update({
      status: "rejected",
      rejection_reason: args.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.task_id)
    .select("id, status")
    .single();

  if (error) {
    throw new Error(`reject_curriculum_task failed: ${error.message}`);
  }

  recordRejected();
  return { ok: true, task_id: data.id, status: data.status };
}
