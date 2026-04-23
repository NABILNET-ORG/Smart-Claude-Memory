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

export type MatchRow = {
  id: number;
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  similarity: number;
};

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

export async function upsertChunks(
  projectId: string,
  rows: Array<Chunk & { embedding: number[] }>,
): Promise<{ count: number }> {
  if (rows.length === 0) return { count: 0 };

  const payload = rows.map((r) => ({
    project_id: projectId,
    content: r.content,
    file_origin: r.file_origin,
    chunk_index: r.chunk_index,
    embedding: r.embedding,
    content_hash: md5(r.content),
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
