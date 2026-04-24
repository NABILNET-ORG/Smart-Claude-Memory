import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { config } from "./config.js";

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

export type Chunk = {
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata?: Record<string, unknown>;
};

export type ChunkRow = Chunk & {
  embedding: number[];
  file_hash: string;
};

export type MatchRow = {
  id: number;
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  similarity: number;
};

export function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/**
 * Returns a Map<file_origin, file_hash> for every file already indexed under projectId.
 * Used by sync_local_memory to skip files whose content hasn't changed.
 */
export async function listFileHashes(projectId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("file_origin, file_hash")
      .eq("project_id", projectId)
      .not("file_hash", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`listFileHashes failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.file_origin && row.file_hash && !map.has(row.file_origin)) {
        map.set(row.file_origin, row.file_hash);
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

/**
 * Remove every chunk belonging to a given (project, file). Used before re-embedding
 * a changed file so stale chunk_indexes don't linger.
 */
export async function deleteChunksForFile(
  projectId: string,
  fileOrigin: string,
): Promise<number> {
  const { error, count } = await supabase
    .from("memory_chunks")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin);
  if (error) throw new Error(`deleteChunksForFile failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Confirm a file is fully resident in Supabase before it's safe to delete locally.
 * Returns the chunk count, or 0 if nothing matches (project_id, file_origin, file_hash).
 */
export async function verifyFileSynced(
  projectId: string,
  fileOrigin: string,
  fileHash: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin)
    .eq("file_hash", fileHash);
  if (error) throw new Error(`verifyFileSynced failed: ${error.message}`);
  return count ?? 0;
}

export async function upsertChunks(
  projectId: string,
  rows: ChunkRow[],
): Promise<{ count: number }> {
  if (rows.length === 0) return { count: 0 };

  const payload = rows.map((r) => ({
    project_id: projectId,
    content: r.content,
    file_origin: r.file_origin,
    chunk_index: r.chunk_index,
    embedding: r.embedding,
    content_hash: md5(r.content),
    file_hash: r.file_hash,
    metadata: r.metadata ?? {},
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("memory_chunks")
    .upsert(payload, { onConflict: "project_id,file_origin,chunk_index" });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return { count: rows.length };
}

export async function searchChunks(
  projectId: string,
  queryEmbedding: number[],
  matchCount = 5,
  minSimilarity = 0.0,
): Promise<MatchRow[]> {
  const { data, error } = await supabase.rpc("match_memory_chunks", {
    query_embedding: queryEmbedding,
    p_project_id: projectId,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return (data ?? []) as MatchRow[];
}

// ─── cloud_backlog ────────────────────────────────────────────────────────

export type BacklogStatus = "todo" | "in_progress" | "blocked" | "done";

export type BacklogRow = {
  id: number;
  project_id: string;
  title: string;
  status: BacklogStatus;
  priority: number;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function addBacklog(
  projectId: string,
  title: string,
  opts: { priority?: number; notes?: string; metadata?: Record<string, unknown> } = {},
): Promise<BacklogRow> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .insert({
      project_id: projectId,
      title,
      priority: opts.priority ?? 3,
      notes: opts.notes ?? null,
      metadata: opts.metadata ?? {},
    })
    .select()
    .single();
  if (error) throw new Error(`addBacklog failed: ${error.message}`);
  return data as BacklogRow;
}

export async function listBacklog(
  projectId: string,
  opts: { status?: BacklogStatus | BacklogStatus[] } = {},
): Promise<BacklogRow[]> {
  let q = supabase.from("cloud_backlog").select("*").eq("project_id", projectId);
  if (opts.status) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    q = q.in("status", arr);
  }
  const { data, error } = await q.order("priority", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw new Error(`listBacklog failed: ${error.message}`);
  return (data ?? []) as BacklogRow[];
}

export async function updateBacklog(
  id: number,
  patch: Partial<Pick<BacklogRow, "title" | "status" | "priority" | "notes" | "metadata">>,
): Promise<BacklogRow> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`updateBacklog failed: ${error.message}`);
  return data as BacklogRow;
}

export type ArchiveRow = {
  id: number;
  cloud_backlog_id: number | null;
  project_id: string;
  title: string;
  status: BacklogStatus;
  priority: number;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string;
};

/**
 * Transactionally moves every `status='done'` row for a project from
 * cloud_backlog into archive_backlog. The heavy lifting is the SQL function
 * archive_done_backlog() — a CTE with DELETE ... RETURNING feeding INSERT
 * runs as a single atomic statement. If the insert fails, the delete rolls
 * back automatically; there is no window where rows can be lost or doubled.
 */
export async function archiveDoneBacklog(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc("archive_done_backlog", {
    p_project_id: projectId,
  });
  if (error) throw new Error(`archiveDoneBacklog failed: ${error.message}`);
  return (data as number) ?? 0;
}

export async function listArchive(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ArchiveRow[]> {
  let q = supabase
    .from("archive_backlog")
    .select("*")
    .eq("project_id", projectId)
    .order("archived_at", { ascending: false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`listArchive failed: ${error.message}`);
  return (data ?? []) as ArchiveRow[];
}

// ─── frozen_features ──────────────────────────────────────────────────────

export async function listFrozenPatterns(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("frozen_features")
    .select("pattern")
    .eq("project_id", projectId);
  if (error) throw new Error(`listFrozenPatterns failed: ${error.message}`);
  return (data ?? []).map((r) => r.pattern as string);
}

export async function addFrozenPattern(
  projectId: string,
  pattern: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase
    .from("frozen_features")
    .upsert({ project_id: projectId, pattern, reason: reason ?? null }, {
      onConflict: "project_id,pattern",
    });
  if (error) throw new Error(`addFrozenPattern failed: ${error.message}`);
}

export async function upsertRule(
  projectId: string,
  fileOrigin: string,
  chunkIndex: number,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const { data, error } = await supabase.rpc("upsert_memory_rule", {
    p_project_id: projectId,
    p_file_origin: fileOrigin,
    p_chunk_index: chunkIndex,
    p_content: content,
    p_embedding: embedding,
    p_metadata: metadata,
  });
  if (error) throw new Error(`Supabase upsertRule failed: ${error.message}`);
  return data as number;
}
