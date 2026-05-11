// MCP tool handlers for Trajectory Compaction (Agentic OS 2026 / AgentDiet).
//
// Two tools:
//   * compact_trajectory       — manual entry to the compaction pipeline.
//                                With chunk_id: target one row. Without:
//                                run one daemon tick over the next batch.
//   * get_trajectory_summary   — read-back via the get_trajectory_summary RPC.

import { z } from "zod";
import { supabase } from "../supabase.js";
import {
  compactOneChunk,
  runCompactionOnce,
  type CompactOneResult,
} from "../trajectory/daemon.js";

// ─── compact_trajectory ─────────────────────────────────────────────────────

export const compactTrajectoryInput = z.object({
  chunk_id: z.number().int().positive().optional(),
  dry_run: z.boolean().optional().default(false),
  batch: z.number().int().positive().max(100).optional(),
});

export const compactTrajectoryInputShape = {
  chunk_id: z.number().int().positive().optional(),
  dry_run: z.boolean().optional().default(false),
  batch: z.number().int().positive().max(100).optional(),
};

export type CompactTrajectoryArgs = z.infer<typeof compactTrajectoryInput>;

export type CompactTrajectoryResult =
  | ({ mode: "single"; chunk_id: number } & CompactOneResult)
  | {
      mode: "batch";
      compacted: number;
      skipped: number;
      errored: number;
      duration_ms: number;
    };

export async function compactTrajectoryHandler(
  args: CompactTrajectoryArgs,
): Promise<CompactTrajectoryResult> {
  const dryRun = args.dry_run ?? false;
  if (args.chunk_id !== undefined) {
    const r = await compactOneChunk(args.chunk_id, { dryRun });
    return { mode: "single", chunk_id: args.chunk_id, ...r };
  }
  const limit = args.batch ?? 25;
  const r = await runCompactionOnce({ limit, dryRun });
  return { mode: "batch", ...r };
}

// ─── get_trajectory_summary ─────────────────────────────────────────────────

export const getTrajectorySummaryInput = z.object({
  chunk_id: z.number().int().positive(),
});

export const getTrajectorySummaryInputShape = {
  chunk_id: z.number().int().positive(),
};

export type GetTrajectorySummaryArgs = z.infer<typeof getTrajectorySummaryInput>;

export type GetTrajectorySummaryResult =
  | { found: false }
  | {
      found: true;
      summary: string;
      source_tokens: number;
      summary_tokens: number;
      compression_ratio: number;
      model: string;
      created_at: string;
    };

type RpcRow = {
  summary: string;
  source_tokens: number;
  summary_tokens: number;
  compression_ratio: number;
  model: string;
  created_at: string;
};

export async function getTrajectorySummaryHandler(
  args: GetTrajectorySummaryArgs,
): Promise<GetTrajectorySummaryResult> {
  const { data, error } = await supabase.rpc("get_trajectory_summary", {
    p_chunk_id: args.chunk_id,
  });
  if (error) {
    throw new Error(`get_trajectory_summary RPC failed: ${error.message}`);
  }
  const rows = (data ?? []) as RpcRow[];
  if (rows.length === 0) return { found: false };
  const row = rows[0]!;
  return {
    found: true,
    summary: row.summary,
    source_tokens: row.source_tokens,
    summary_tokens: row.summary_tokens,
    compression_ratio: row.compression_ratio,
    model: row.model,
    created_at: row.created_at,
  };
}
