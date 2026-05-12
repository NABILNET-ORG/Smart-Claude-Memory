// MCP tool wrappers for Transactional Workflow Checkpoints
// (Agentic OS 2026 / Mission 4 / Phase B).
//
// Four handlers that wrap the pure service layer in
// src/transactions/checkpoint.ts and add the MCP-shaped envelope:
//
//   * checkpoint_create   — openCheckpoint() + cloud_backlog.metadata stamp
//                           when this is a root checkpoint tied to a backlog
//                           task. The stamp populates
//                           cloud_backlog.metadata.checkpoint_root_id, which
//                           archive_done_backlog (014) joins on to populate
//                           archive_backlog.chunk_id at archive time.
//   * checkpoint_commit   — commitCheckpoint()
//   * checkpoint_rollback — rollbackCheckpoint() + structured [M4] rollback
//                           signal log. No separate signals table — the
//                           miner's LEFT JOIN over workflow_checkpoints
//                           picks rolledback rows directly.
//   * checkpoint_list     — listCheckpoints() with safe limit bounds.
//
// Style mirrors src/tools/compact.ts (handler + input shape exports) and
// src/tools/sleep.ts (project_id resolution via currentProjectId default).
// Zero `any`, zero TODO, zero placeholders.

import { z } from "zod";
import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import {
  openCheckpoint,
  commitCheckpoint,
  rollbackCheckpoint,
  listCheckpoints,
  type CheckpointRow,
  type CheckpointStatus,
} from "../transactions/checkpoint.js";

// ─── shared project_id helper ───────────────────────────────────────────────

function resolveProjectId(explicit: string | undefined): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  return currentProjectId;
}

// ─── checkpoint_create ──────────────────────────────────────────────────────

export const checkpointCreateInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  skill_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "agent_skills.id when this checkpoint is anchoring a step of a JIT-retrieved skill. NULL when the workflow is ad-hoc.",
    ),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe(
      "Zero-based ordinal of this step within the workflow. Default 0 (root step).",
    ),
  step_label: z
    .string()
    .min(1)
    .describe(
      "Short human-readable label for the step (e.g. 'edit-and-typecheck', 'run-migration'). Required.",
    ),
  parent_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "workflow_checkpoints.id of the prior step in the chain. NULL = root step of the workflow.",
    ),
  backlog_task_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "cloud_backlog.id this workflow services. When provided AND parent_id is null, this checkpoint becomes the root and its id is stamped into cloud_backlog.metadata.checkpoint_root_id so archive_done_backlog can populate archive_backlog.chunk_id at archive time.",
    ),
};

const checkpointCreateSchema = z.object(checkpointCreateInputShape);
export type CheckpointCreateArgs = z.infer<typeof checkpointCreateSchema>;

export type CheckpointCreateResult = {
  checkpoint_id: number;
  status: "open";
  backlog_stamped: boolean;
};

/**
 * Stamp metadata.checkpoint_root_id onto a cloud_backlog row via a
 * read-modify-write. We avoid jsonb_set RPC plumbing (would require a new
 * SECURITY DEFINER fn) — the row count is always 1 here, so the round-trip
 * cost is negligible and the code stays portable.
 *
 * Returns true if the row was stamped, false if the row was not found or
 * the project_id didn't match (defensive guard against cross-tenant
 * stamping).
 */
async function stampCheckpointRootIdOnBacklog(
  projectId: string,
  backlogTaskId: number,
  checkpointId: number,
): Promise<boolean> {
  const { data: row, error: loadErr } = await supabase
    .from("cloud_backlog")
    .select("id, project_id, metadata")
    .eq("id", backlogTaskId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (loadErr) {
    throw new Error(
      `[M4] stampCheckpointRootIdOnBacklog: lookup failed: ${loadErr.message}`,
    );
  }
  if (!row) {
    // No matching row — log and report not-stamped; this is not a hard error
    // (caller may have passed a stale id; we don't want to fail the
    // checkpoint that was already inserted).
    console.log(
      `[M4] stamp skipped: cloud_backlog id=${backlogTaskId} not found in project=${projectId}`,
    );
    return false;
  }

  const existing: Record<string, unknown> =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const nextMetadata: Record<string, unknown> = {
    ...existing,
    checkpoint_root_id: checkpointId,
  };

  const { error: updateErr } = await supabase
    .from("cloud_backlog")
    .update({ metadata: nextMetadata })
    .eq("id", backlogTaskId)
    .eq("project_id", projectId);

  if (updateErr) {
    throw new Error(
      `[M4] stampCheckpointRootIdOnBacklog: update failed: ${updateErr.message}`,
    );
  }

  console.log(
    `[M4] stamped checkpoint_root_id=${checkpointId} on cloud_backlog.id=${backlogTaskId}`,
  );
  return true;
}

export async function checkpointCreateHandler(
  args: CheckpointCreateArgs,
): Promise<CheckpointCreateResult> {
  const parsed = checkpointCreateSchema.parse(args);
  const projectId = resolveProjectId(parsed.project_id);

  const skillId =
    parsed.skill_id === undefined || parsed.skill_id === null ? null : parsed.skill_id;
  const parentId =
    parsed.parent_id === undefined || parsed.parent_id === null ? null : parsed.parent_id;
  const stepIndex = parsed.step_index ?? 0;

  const opened = await openCheckpoint({
    projectId,
    skillId,
    stepIndex,
    stepLabel: parsed.step_label,
    parentId,
  });

  let backlogStamped = false;
  // Stamp only when this is a ROOT checkpoint (parentId is null) AND a
  // backlog task id was supplied. Non-root checkpoints inherit their root
  // via the parent_id chain; restamping a non-root would break the join.
  if (parentId === null && parsed.backlog_task_id !== undefined) {
    backlogStamped = await stampCheckpointRootIdOnBacklog(
      projectId,
      parsed.backlog_task_id,
      opened.id,
    );
  }

  return {
    checkpoint_id: opened.id,
    status: "open",
    backlog_stamped: backlogStamped,
  };
}

// ─── checkpoint_commit ──────────────────────────────────────────────────────

export const checkpointCommitInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  checkpoint_id: z
    .number()
    .int()
    .positive()
    .describe("workflow_checkpoints.id to mark committed."),
  source_chunk_id: z
    .number()
    .int()
    .positive()
    .describe(
      "memory_chunks.id whose trajectory_summaries entry is the replay anchor. Required — committed rows MUST pin a chunk.",
    ),
};

const checkpointCommitSchema = z.object(checkpointCommitInputShape);
export type CheckpointCommitArgs = z.infer<typeof checkpointCommitSchema>;

export type CheckpointCommitResult = {
  checkpoint_id: number;
  status: "committed";
  source_chunk_id: number;
};

export async function checkpointCommitHandler(
  args: CheckpointCommitArgs,
): Promise<CheckpointCommitResult> {
  const parsed = checkpointCommitSchema.parse(args);
  const projectId = resolveProjectId(parsed.project_id);

  const committed = await commitCheckpoint({
    projectId,
    checkpointId: parsed.checkpoint_id,
    sourceChunkId: parsed.source_chunk_id,
  });

  return {
    checkpoint_id: committed.id,
    status: "committed",
    source_chunk_id: committed.sourceChunkId,
  };
}

// ─── checkpoint_rollback ────────────────────────────────────────────────────

export const checkpointRollbackInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  checkpoint_id: z
    .number()
    .int()
    .positive()
    .describe("workflow_checkpoints.id to mark rolledback."),
  reason: z
    .string()
    .min(1)
    .describe(
      "Non-empty human-readable reason persisted to workflow_checkpoints.rollback_reason and surfaced to the M3 miner as a negative signal.",
    ),
};

const checkpointRollbackSchema = z.object(checkpointRollbackInputShape);
export type CheckpointRollbackArgs = z.infer<typeof checkpointRollbackSchema>;

export type CheckpointRollbackResult = {
  checkpoint_id: number;
  status: "rolledback";
  restored_from: {
    checkpoint_id: number;
    source_chunk_id: number;
  } | null;
};

export async function checkpointRollbackHandler(
  args: CheckpointRollbackArgs,
): Promise<CheckpointRollbackResult> {
  const parsed = checkpointRollbackSchema.parse(args);
  const projectId = resolveProjectId(parsed.project_id);

  const r = await rollbackCheckpoint({
    projectId,
    checkpointId: parsed.checkpoint_id,
    reason: parsed.reason,
  });

  // M3 signal: emit a structured log line. The miner reads
  // workflow_checkpoints directly (no separate signals table); this log is
  // purely operational visibility so a human can grep rollback churn.
  const anchor = r.restoredFrom
    ? `parent=${r.restoredFrom.checkpointId} source_chunk_id=${r.restoredFrom.sourceChunkId}`
    : "no_replay_anchor";
  console.log(
    `[M4] rollback_signal: project=${projectId} id=${r.id} reason=${parsed.reason} ${anchor}`,
  );

  return {
    checkpoint_id: r.id,
    status: "rolledback",
    restored_from: r.restoredFrom
      ? {
          checkpoint_id: r.restoredFrom.checkpointId,
          source_chunk_id: r.restoredFrom.sourceChunkId,
        }
      : null,
  };
}

// ─── checkpoint_list ────────────────────────────────────────────────────────

export const checkpointListInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  status: z
    .enum(["open", "committed", "rolledback"])
    .optional()
    .describe("Lifecycle filter. Omit to surface all states."),
  skill_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Filter by agent_skills.id. Omit to surface checkpoints regardless of skill linkage.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20)
    .describe("Hard cap on rows returned. Default 20, max 100."),
};

const checkpointListSchema = z.object(checkpointListInputShape);
export type CheckpointListArgs = z.infer<typeof checkpointListSchema>;

export type CheckpointListResult = {
  count: number;
  checkpoints: CheckpointRow[];
};

export async function checkpointListHandler(
  args: CheckpointListArgs,
): Promise<CheckpointListResult> {
  const parsed = checkpointListSchema.parse(args);
  const projectId = resolveProjectId(parsed.project_id);
  const limit = parsed.limit ?? 20;
  const status: CheckpointStatus | undefined = parsed.status;
  const skillId =
    parsed.skill_id === undefined || parsed.skill_id === null ? undefined : parsed.skill_id;

  const rows = await listCheckpoints({
    projectId,
    status,
    skillId,
    limit,
  });

  return { count: rows.length, checkpoints: rows };
}
