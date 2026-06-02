// Shared web-page ingestion pipeline — SCM-S49-D2.
//
// Lifted verbatim out of research_url so BOTH research_url AND crawl_docs share
// ONE chunk→embed→upsert path (the backlog's "batch-ingests via research_url's
// pipeline"). A page is a single logical "file" keyed by file_origin = url:
// re-ingesting the same url deletes the prior (project_id, file_origin) rows
// BEFORE inserting the new set, so stale chunk_indexes never linger (mirrors
// sync_local_memory's delete-before-reembed on a changed file).
//
// Behavior-preserving contract: when called with the default (whole-page) batch
// and no beforeBatch hook, the rows + metadata produced are byte-for-byte what
// research_url produced before this extraction.

import { createHash } from "node:crypto";
import { chunkMarkdown } from "../chunker.js";
import { embed } from "../ollama.js";
import {
  upsertChunks,
  deleteChunksForFile,
  type ChunkRow,
} from "../supabase.js";

export type IngestPageArgs = {
  /** The page URL — used as file_origin and as the source_url metadata field. */
  url: string;
  /** Cleaned, plain-text page body (already HTML-stripped by fetchUrl). */
  text: string;
  /** Page <title>, or null. */
  title: string | null;
  /** Project namespace the chunks are written under. */
  projectId: string;
  /**
   * Extra metadata merged into every chunk's metadata object (e.g. crawl_id,
   * seed_url, depth). Merged AFTER the base web fields; pass {} for the
   * research_url shape. Does NOT override type/kind/source_url/title/fetched_at
   * unless a key collides (callers must not collide).
   */
  meta?: Record<string, unknown>;
  /**
   * Embed fan-out batch size. Default = all chunks in ONE embed() call
   * (research_url's historical behavior). The crawler passes a finite batch so
   * it can gate each batch through the budget manager via beforeBatch.
   */
  embedBatch?: number;
  /**
   * Optional async hook invoked once per embed batch with that batch's size,
   * BEFORE the embed() call. The crawler uses it to run checkDaemonBudget and
   * throw BudgetExceededError to stop the fan-out. If it throws, the throw
   * propagates to the caller and NO partial rows are written for this page
   * (delete+upsert happen only after all embeddings succeed).
   */
  beforeBatch?: (batchSize: number) => Promise<void>;
};

export type IngestPageOk = {
  ok: true;
  source_url: string;
  title: string | null;
  chunks_stored: number;
};

export type IngestPageErr = { ok: false; reason: string };

export type IngestPageResult = IngestPageOk | IngestPageErr;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Chunk + embed + upsert one fetched page into memory_chunks. Idempotent per
 * (projectId, url): prior rows for that file_origin are deleted before insert.
 * Returns a small summary; never the body text.
 */
export async function ingestPage(args: IngestPageArgs): Promise<IngestPageResult> {
  const { url, text, title, projectId, meta } = args;

  if (!text.trim()) {
    return { ok: false, reason: "Fetched page contained no extractable text." };
  }

  const rawChunks = chunkMarkdown(text);
  if (rawChunks.length === 0) {
    return { ok: false, reason: "Page produced zero chunks after chunking." };
  }

  // Embed in batches. Default batch = all chunks (single call) preserves the
  // exact research_url behavior; a finite embedBatch lets the crawler gate the
  // fan-out. Order is preserved so embeddings[i] aligns with rawChunks[i].
  const batchSize =
    args.embedBatch && args.embedBatch > 0 ? args.embedBatch : rawChunks.length;
  const embeddings: number[][] = [];
  for (let i = 0; i < rawChunks.length; i += batchSize) {
    const slice = rawChunks.slice(i, i + batchSize);
    if (args.beforeBatch) await args.beforeBatch(slice.length);
    const batch = await embed(slice.map((c) => c.content));
    for (const e of batch) embeddings.push(e);
  }

  const fileHash = sha256(text);
  const fetchedAt = new Date().toISOString();

  const rows: ChunkRow[] = rawChunks.map((c, i) => ({
    content: c.content,
    file_origin: url,
    chunk_index: c.chunk_index,
    embedding: embeddings[i] as number[],
    file_hash: fileHash,
    metadata: {
      type: "LOG",
      kind: "web",
      source_url: url,
      title,
      fetched_at: fetchedAt,
      ...(c.heading ? { heading: c.heading } : {}),
      ...(meta ?? {}),
    },
  }));

  // Clean refresh: drop prior rows for this URL before inserting the new set.
  await deleteChunksForFile(projectId, url);
  await upsertChunks(projectId, rows);

  return {
    ok: true,
    source_url: url,
    title,
    chunks_stored: rows.length,
  };
}
