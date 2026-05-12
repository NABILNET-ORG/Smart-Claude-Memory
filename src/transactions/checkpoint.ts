// Transactional Workflow Checkpoint Service (Agentic OS 2026 / Mission 4 / Phase A).
//
// Pure service layer — NO MCP tool definitions live here (those land in Phase B
// under src/tools/checkpoint.ts). This module is the binding glue between the
// three earlier missions:
//
//   * M1 (agent_skills)        — `skillId` ties the checkpoint to a JIT-retrieved
//                                skill boundary.
//   * M2 (trajectory_summaries) — `sourceChunkId` pinned on commit IS the replay
//                                anchor; restore replays it via the existing
//                                `get_trajectory_summary` RPC.
//   * M3 (skill_candidates)    — rollback events feed the miner as negative
//                                examples (the LEFT JOIN extension itself is
//                                deferred to Phase B; this module emits the
//                                durable rolledback row that the miner reads).
//
// All functions:
//   * validate inputs and throw Error with `[M4]` prefix on bad shape
//   * surface Supabase failures verbatim wrapped with `[M4] <op>: <msg>`
//   * return typed results — no `any`, no placeholders
//
// Style mirrors src/sleep/miner.ts and src/trajectory/daemon.ts: throw on
// I/O failure (the caller / future Phase-B tool wrapper translates to MCP
// error envelope), use `supabase` from ../supabase.js, no module-level state
// (this is a pure service — daemon-style state belongs in Phase B if/when
// we add a checkpoint reaper).

import { supabase } from "../supabase.js";

// ─── types ──────────────────────────────────────────────────────────────────

export type CheckpointStatus = "open" | "committed" | "rolledback";

export type CheckpointRow = {
  id: number;
  project_id: string;
  skill_id: number | null;
  step_index: number;
  step_label: string;
  parent_id: number | null;
  source_chunk_id: number | null;
  status: CheckpointStatus;
  rollback_reason: string | null;
  created_at: string;
  committed_at: string | null;
};

export type OpenCheckpointArgs = {
  projectId: string;
  skillId?: number | null;
  stepIndex: number;
  stepLabel: string;
  parentId?: number | null;
};

export type OpenCheckpointResult = {
  id: number;
  status: "open";
};

export type CommitCheckpointArgs = {
  projectId: string;
  checkpointId: number;
  sourceChunkId: number;
};

export type CommitCheckpointResult = {
  id: number;
  status: "committed";
  sourceChunkId: number;
};

export type RollbackCheckpointArgs = {
  projectId: string;
  checkpointId: number;
  reason: string;
};

export type RollbackCheckpointResult = {
  id: number;
  status: "rolledback";
  restoredFrom: {
    checkpointId: number;
    sourceChunkId: number;
  } | null;
};

export type ListCheckpointsArgs = {
  projectId: string;
  status?: CheckpointStatus;
  skillId?: number | null;
  limit?: number;
};

export type RestoreFromArgs = {
  projectId: string;
  checkpointId: number;
};

export type RestoreFromResult = {
  replayChunkId: number | null;
  summary: string | null;
};

// ─── validation helpers ─────────────────────────────────────────────────────

function requireProjectId(projectId: unknown, fn: string): asserts projectId is string {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new Error(`[M4] ${fn}: projectId must be a non-empty string`);
  }
}

function requireCheckpointId(id: unknown, fn: string): asserts id is number {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(`[M4] ${fn}: checkpointId must be a positive integer`);
  }
}

function requireStepIndex(idx: unknown, fn: string): asserts idx is number {
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
    throw new Error(`[M4] ${fn}: stepIndex must be a non-negative integer`);
  }
}

function requireStepLabel(label: unknown, fn: string): asserts label is string {
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(`[M4] ${fn}: stepLabel must be a non-empty string`);
  }
}

function requireSourceChunkId(id: unknown, fn: string): asserts id is number {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(`[M4] ${fn}: sourceChunkId must be a positive integer`);
  }
}

function requireReason(reason: unknown, fn: string): asserts reason is string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(`[M4] ${fn}: reason must be a non-empty string`);
  }
}

// ─── openCheckpoint ─────────────────────────────────────────────────────────

export async function openCheckpoint(
  args: OpenCheckpointArgs,
): Promise<OpenCheckpointResult> {
  requireProjectId(args.projectId, "openCheckpoint");
  requireStepIndex(args.stepIndex, "openCheckpoint");
  requireStepLabel(args.stepLabel, "openCheckpoint");

  const skillId: number | null =
    args.skillId === undefined || args.skillId === null ? null : args.skillId;
  if (skillId !== null && (!Number.isInteger(skillId) || skillId <= 0)) {
    throw new Error(`[M4] openCheckpoint: skillId must be a positive integer or null`);
  }
  const parentId: number | null =
    args.parentId === undefined || args.parentId === null ? null : args.parentId;
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) {
    throw new Error(`[M4] openCheckpoint: parentId must be a positive integer or null`);
  }

  console.log(
    `[M4] openCheckpoint: project=${args.projectId} step=${args.stepIndex} label=${args.stepLabel} parent=${parentId ?? "root"}`,
  );

  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .insert({
      project_id: args.projectId,
      skill_id: skillId,
      step_index: args.stepIndex,
      step_label: args.stepLabel,
      parent_id: parentId,
      status: "open",
    })
    .select("id, status")
    .single();

  if (error) {
    throw new Error(`[M4] openCheckpoint: insert failed: ${error.message}`);
  }
  if (!data || typeof data.id !== "number") {
    throw new Error(`[M4] openCheckpoint: insert returned no row`);
  }
  if (data.status !== "open") {
    throw new Error(`[M4] openCheckpoint: unexpected status '${String(data.status)}'`);
  }
  return { id: data.id, status: "open" };
}

// ─── commitCheckpoint ───────────────────────────────────────────────────────

export async function commitCheckpoint(
  args: CommitCheckpointArgs,
): Promise<CommitCheckpointResult> {
  requireProjectId(args.projectId, "commitCheckpoint");
  requireCheckpointId(args.checkpointId, "commitCheckpoint");
  requireSourceChunkId(args.sourceChunkId, "commitCheckpoint");

  console.log(
    `[M4] commitCheckpoint: project=${args.projectId} id=${args.checkpointId} source_chunk_id=${args.sourceChunkId}`,
  );

  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .update({
      status: "committed",
      source_chunk_id: args.sourceChunkId,
      committed_at: new Date().toISOString(),
    })
    .eq("id", args.checkpointId)
    .eq("project_id", args.projectId)
    .eq("status", "open") // only open rows commit — idempotency + safety
    .select("id, status, source_chunk_id")
    .single();

  if (error) {
    throw new Error(`[M4] commitCheckpoint: update failed: ${error.message}`);
  }
  if (!data || typeof data.id !== "number") {
    throw new Error(
      `[M4] commitCheckpoint: row not found, not open, or project mismatch (id=${args.checkpointId})`,
    );
  }
  if (data.status !== "committed") {
    throw new Error(`[M4] commitCheckpoint: unexpected status '${String(data.status)}'`);
  }
  if (typeof data.source_chunk_id !== "number") {
    throw new Error(`[M4] commitCheckpoint: source_chunk_id not persisted`);
  }
  return {
    id: data.id,
    status: "committed",
    sourceChunkId: data.source_chunk_id,
  };
}

// ─── rollbackCheckpoint ─────────────────────────────────────────────────────
//
// Walks the parent chain to find the deepest committed ancestor's
// source_chunk_id via the SQL helper terminal_committed_checkpoint, then
// marks the target row as rolledback. The replay anchor (if any) is
// returned so the caller can drive restoreFrom().

export async function rollbackCheckpoint(
  args: RollbackCheckpointArgs,
): Promise<RollbackCheckpointResult> {
  requireProjectId(args.projectId, "rollbackCheckpoint");
  requireCheckpointId(args.checkpointId, "rollbackCheckpoint");
  requireReason(args.reason, "rollbackCheckpoint");

  console.log(
    `[M4] rollbackCheckpoint: project=${args.projectId} id=${args.checkpointId} reason=${args.reason}`,
  );

  // 1. Load the target row to discover its skill_id and parent_id so we can
  //    walk the chain from the parent (rolledback rows never anchor replay).
  const { data: target, error: loadErr } = await supabase
    .from("workflow_checkpoints")
    .select("id, project_id, skill_id, parent_id, status")
    .eq("id", args.checkpointId)
    .eq("project_id", args.projectId)
    .maybeSingle();

  if (loadErr) {
    throw new Error(`[M4] rollbackCheckpoint: lookup failed: ${loadErr.message}`);
  }
  if (!target) {
    throw new Error(
      `[M4] rollbackCheckpoint: checkpoint ${args.checkpointId} not found in project ${args.projectId}`,
    );
  }
  if (target.status === "rolledback") {
    throw new Error(
      `[M4] rollbackCheckpoint: checkpoint ${args.checkpointId} is already rolledback`,
    );
  }

  // 2. Find the replay anchor: deepest committed source_chunk_id reachable
  //    from the PARENT (not this row — we're rolling this one back).
  //    NULL parent = root rollback: no anchor exists.
  let restoredFrom: RollbackCheckpointResult["restoredFrom"] = null;
  const parentId =
    typeof target.parent_id === "number" ? target.parent_id : null;

  if (parentId !== null) {
    const skillId =
      typeof target.skill_id === "number" ? target.skill_id : null;
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "terminal_committed_checkpoint",
      {
        p_project_id: args.projectId,
        p_skill_id: skillId,
        p_root_id: parentId,
      },
    );
    if (rpcErr) {
      throw new Error(
        `[M4] rollbackCheckpoint: terminal_committed_checkpoint RPC failed: ${rpcErr.message}`,
      );
    }
    // Supabase RPC returns the scalar directly (PostgREST flattens single-column functions).
    const sourceChunkId =
      typeof rpcData === "number"
        ? rpcData
        : Array.isArray(rpcData) && rpcData.length > 0 && typeof rpcData[0] === "number"
          ? (rpcData[0] as number)
          : null;
    if (sourceChunkId !== null) {
      restoredFrom = { checkpointId: parentId, sourceChunkId };
    }
  }

  // 3. Mark this row rolledback. We use the same .eq() guard pattern as
  //    commit to prevent double-rollback races.
  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .update({
      status: "rolledback",
      rollback_reason: args.reason,
    })
    .eq("id", args.checkpointId)
    .eq("project_id", args.projectId)
    .neq("status", "rolledback")
    .select("id, status")
    .single();

  if (error) {
    throw new Error(`[M4] rollbackCheckpoint: update failed: ${error.message}`);
  }
  if (!data || typeof data.id !== "number") {
    throw new Error(
      `[M4] rollbackCheckpoint: row not found or already rolledback (id=${args.checkpointId})`,
    );
  }
  if (data.status !== "rolledback") {
    throw new Error(`[M4] rollbackCheckpoint: unexpected status '${String(data.status)}'`);
  }

  return {
    id: data.id,
    status: "rolledback",
    restoredFrom,
  };
}

// ─── listCheckpoints ────────────────────────────────────────────────────────

export async function listCheckpoints(
  args: ListCheckpointsArgs,
): Promise<CheckpointRow[]> {
  requireProjectId(args.projectId, "listCheckpoints");

  const limit =
    args.limit === undefined ? 50 : args.limit;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error(`[M4] listCheckpoints: limit must be an integer in (0, 500]`);
  }

  let q = supabase
    .from("workflow_checkpoints")
    .select(
      "id, project_id, skill_id, step_index, step_label, parent_id, source_chunk_id, status, rollback_reason, created_at, committed_at",
    )
    .eq("project_id", args.projectId);

  if (args.status !== undefined) {
    q = q.eq("status", args.status);
  }
  if (args.skillId !== undefined && args.skillId !== null) {
    q = q.eq("skill_id", args.skillId);
  }

  const { data, error } = await q
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`[M4] listCheckpoints: query failed: ${error.message}`);
  }
  return (data ?? []) as CheckpointRow[];
}

// ─── restoreFrom ────────────────────────────────────────────────────────────
//
// Looks up the checkpoint's source_chunk_id, then calls get_trajectory_summary
// (M2 RPC) to fetch the compressed replay surface. We do NOT depend on
// src/tools/compact.ts to avoid a service→tool layering inversion — the RPC
// call is the same one that tool wraps.

type GetTrajectorySummaryRpcRow = {
  summary: string;
  source_tokens: number;
  summary_tokens: number;
  compression_ratio: number;
  model: string;
  created_at: string;
};

export async function restoreFrom(
  args: RestoreFromArgs,
): Promise<RestoreFromResult> {
  requireProjectId(args.projectId, "restoreFrom");
  requireCheckpointId(args.checkpointId, "restoreFrom");

  console.log(
    `[M4] restoreFrom: project=${args.projectId} id=${args.checkpointId}`,
  );

  const { data: row, error: loadErr } = await supabase
    .from("workflow_checkpoints")
    .select("id, source_chunk_id, status")
    .eq("id", args.checkpointId)
    .eq("project_id", args.projectId)
    .maybeSingle();

  if (loadErr) {
    throw new Error(`[M4] restoreFrom: lookup failed: ${loadErr.message}`);
  }
  if (!row) {
    throw new Error(
      `[M4] restoreFrom: checkpoint ${args.checkpointId} not found in project ${args.projectId}`,
    );
  }

  const replayChunkId =
    typeof row.source_chunk_id === "number" ? row.source_chunk_id : null;
  if (replayChunkId === null) {
    return { replayChunkId: null, summary: null };
  }

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "get_trajectory_summary",
    { p_chunk_id: replayChunkId },
  );
  if (rpcErr) {
    throw new Error(`[M4] restoreFrom: get_trajectory_summary RPC failed: ${rpcErr.message}`);
  }
  const rows = (rpcData ?? []) as GetTrajectorySummaryRpcRow[];
  if (rows.length === 0) {
    // Checkpoint pinned a chunk but no summary exists yet (M2 daemon hasn't
    // run on it, or summary was purged). Return the pointer without payload
    // — caller can fall back to raw memory_chunks if desired.
    return { replayChunkId, summary: null };
  }
  const first = rows[0]!;
  return { replayChunkId, summary: first.summary };
}
