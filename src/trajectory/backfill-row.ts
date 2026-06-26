// Pure mapper: build a trajectory_summaries upsert row from a successful chunk,
// its LLM summary, and the summary embedding. Extracted from the backfill script
// so it can be unit-tested without running the script's main().

export type SummaryUpsertRow = {
  project_id: string;
  source_chunk_id: number;
  summary: string;
  summary_embedding: number[] | null;
  source_tokens: number;
  summary_tokens: number;
  strategy: string;
  model: string;
};

/** ~4 chars per token, matching the summarizer's own estimate. Clamped to >=1
 *  because trajectory_summaries.source_tokens has a NOT NULL CHECK (>= 0). */
export function buildSummaryRow(
  projectId: string,
  chunk: { chunk_id: number; content: string },
  summary: { summary: string; summaryTokens: number; model: string },
  embedding: number[] | null,
): SummaryUpsertRow {
  return {
    project_id: projectId,
    source_chunk_id: chunk.chunk_id,
    summary: summary.summary,
    summary_embedding: embedding,
    source_tokens: Math.max(1, Math.ceil(chunk.content.length / 4)),
    summary_tokens: summary.summaryTokens,
    strategy: "backfill",
    model: summary.model,
  };
}
