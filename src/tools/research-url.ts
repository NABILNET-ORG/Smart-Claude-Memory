// MCP tool: research_url
//
// Fetch a public web page (SSRF-guarded via src/web/fetch.ts), convert it to
// clean text, chunk + embed it, and ingest the chunks into the project's
// searchable memory (memory_chunks) so they surface in search_memory exactly
// like local .md content.
//
// Unlike fetch_url, this passes a very high maxReturnChars so the FULL body is
// available to the chunker (the agent's context is protected here by the fact
// that only a small summary object is returned — never the body text).
//
// Refresh semantics: a URL is a single logical "file". Re-researching the same
// URL deletes the prior (project_id, file_origin=url) rows BEFORE inserting the
// new ones, so stale chunk_indexes never linger (mirrors sync_local_memory's
// delete-before-reembed on a changed file).

import { createHash } from "node:crypto";
import { chunkMarkdown } from "../chunker.js";
import { embed } from "../ollama.js";
import {
  upsertChunks,
  deleteChunksForFile,
  type ChunkRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";
import { fetchUrl } from "../web/fetch.js";

export type ResearchUrlArgs = {
  url: string;
  project_id?: string;
  timeout_ms?: number;
};

export type ResearchUrlOk = {
  ok: true;
  source_url: string;
  title: string | null;
  chunks_stored: number;
  bytes: number;
  truncated: boolean;
  project_id: string;
};

export type ResearchUrlErr = { ok: false; reason: string };

export type ResearchUrlResult = ResearchUrlOk | ResearchUrlErr;

// Effectively-unbounded return cap: ingestion needs the whole body. The real
// volume guard is SCM_FETCH_MAX_BYTES (applied while reading the socket).
const INGEST_RETURN_CHARS = Number.MAX_SAFE_INTEGER;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function researchUrl(args: ResearchUrlArgs): Promise<ResearchUrlResult> {
  if (!args.url || typeof args.url !== "string" || args.url.trim() === "") {
    return { ok: false, reason: "Missing required 'url' argument." };
  }

  const fetched = await fetchUrl(args.url, {
    timeoutMs: args.timeout_ms,
    maxReturnChars: INGEST_RETURN_CHARS,
  });
  if (!fetched.ok) return fetched;

  const projectId = args.project_id ?? currentProjectId;
  const sourceUrl = fetched.final_url || args.url;

  const text = fetched.text;
  if (!text.trim()) {
    return { ok: false, reason: "Fetched page contained no extractable text." };
  }

  const rawChunks = chunkMarkdown(text);
  if (rawChunks.length === 0) {
    return { ok: false, reason: "Page produced zero chunks after chunking." };
  }

  const embeddings = await embed(rawChunks.map((c) => c.content));
  const fileHash = sha256(text);
  const fetchedAt = new Date().toISOString();

  const rows: ChunkRow[] = rawChunks.map((c, i) => ({
    content: c.content,
    file_origin: sourceUrl,
    chunk_index: c.chunk_index,
    embedding: embeddings[i] as number[],
    file_hash: fileHash,
    metadata: {
      type: "LOG",
      kind: "web",
      source_url: sourceUrl,
      title: fetched.title,
      fetched_at: fetchedAt,
      ...(c.heading ? { heading: c.heading } : {}),
    },
  }));

  // Clean refresh: drop prior rows for this URL before inserting the new set.
  await deleteChunksForFile(projectId, sourceUrl);
  await upsertChunks(projectId, rows);

  return {
    ok: true,
    source_url: sourceUrl,
    title: fetched.title,
    chunks_stored: rows.length,
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    project_id: projectId,
  };
}
