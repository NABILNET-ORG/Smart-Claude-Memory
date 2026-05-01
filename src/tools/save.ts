import { createHash } from "node:crypto";
import { embed } from "../ollama.js";
import { upsertRule } from "../supabase.js";
import { currentProjectId } from "../project.js";

/**
 * Sovereign Taxonomy (v2.0.0-rc1): every memory should be classified into one of four
 * types. The type lives in `metadata.type` and is the primary filter dimension
 * for `search_memory`'s metadata_filter. The taxonomy is enforced in TypeScript
 * (Zod) — the SQL layer keeps the column flexible per ADR.
 *
 *   DECISION  — architectural choices + their rationale
 *   PATTERN   — code standards / Rule 5–8 enforcement notes
 *   ERROR     — bug post-mortems and the fix that resolved them
 *   LOG       — general session progress and uncategorizable notes
 *
 * GLOBAL Knowledge Vault: when metadata.is_global is true the row is routed
 * to the reserved project_id 'GLOBAL' regardless of any explicit project_id
 * argument. The is_global flag is preserved inside the persisted metadata
 * jsonb for audit/traceability. search_memory dual-scopes across the caller's
 * project_id and 'GLOBAL' by default.
 */
export type MemoryType = "DECISION" | "PATTERN" | "ERROR" | "LOG";

/** Reserved project_id for the GLOBAL Knowledge Vault. */
export const GLOBAL_PROJECT_ID = "GLOBAL";

export type SaveMemoryMetadata = {
  type?: MemoryType;
  status?: string;
  context_id?: string;
  /** When true, the row is stored under project_id='GLOBAL' (universal scope). */
  is_global?: boolean;
  // Pass-through extras are explicitly allowed; the JSONB column has no schema.
  [k: string]: unknown;
};

export async function saveMemory(args: {
  content: string;
  project_id?: string;
  file_origin?: string;
  chunk_index?: number;
  metadata?: SaveMemoryMetadata;
}): Promise<{
  id: number;
  project_id: string;
  type: MemoryType | null;
  is_global: boolean;
}> {
  const metadata: SaveMemoryMetadata = { ...(args.metadata ?? {}) };
  const isGlobal = metadata.is_global === true;

  // GLOBAL routing: if the caller flagged the memory as universal, override
  // the row's project_id to the reserved 'GLOBAL' bucket regardless of the
  // explicit project_id argument. The is_global flag is KEPT inside the
  // persisted metadata jsonb for audit/traceability.
  const projectId = isGlobal
    ? GLOBAL_PROJECT_ID
    : (args.project_id ?? currentProjectId);
  const chunkIndex = args.chunk_index ?? 0;

  // Default file_origin keys inline-saved memories by content hash so callers
  // who skip the field don't accidentally collide on the (project_id,
  // file_origin, chunk_index) unique key.
  const fileOrigin =
    args.file_origin ??
    `inline:${createHash("sha256").update(args.content).digest("hex").slice(0, 12)}`;

  const type = (metadata.type as MemoryType | undefined) ?? null;

  const [vec] = await embed([args.content]);
  const id = await upsertRule(
    projectId,
    fileOrigin,
    chunkIndex,
    args.content,
    vec,
    metadata as Record<string, unknown>,
  );

  return { id, project_id: projectId, type, is_global: isGlobal };
}
