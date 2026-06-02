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

import { currentProjectId } from "../project.js";
import { fetchUrl } from "../web/fetch.js";
import { ingestPage } from "../web/ingest.js";

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

  // Delegate the chunk→embed→delete→upsert pipeline to the shared ingestPage().
  // Default (whole-page) batch + no meta extension reproduces the exact rows +
  // metadata research_url wrote before this extraction (behavior-preserving).
  const ingested = await ingestPage({
    url: sourceUrl,
    text: fetched.text,
    title: fetched.title,
    projectId,
  });
  if (!ingested.ok) return ingested;

  return {
    ok: true,
    source_url: sourceUrl,
    title: fetched.title,
    chunks_stored: ingested.chunks_stored,
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    project_id: projectId,
  };
}
