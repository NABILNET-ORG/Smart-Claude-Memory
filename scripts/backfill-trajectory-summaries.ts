// Backfill trajectory_summaries for a project's "successful" memory chunks so the
// skill miner has a non-empty mining surface. Env-var driven (house pattern,
// mirrors scripts/backfill-kg-extraction.ts). Idempotent via the
// trajectory_summaries (project_id, source_chunk_id) unique index.
//
// Usage:
//   tsx scripts/backfill-trajectory-summaries.ts              # dry run: report only
//   SCM_BACKFILL_CONFIRM=1 tsx scripts/backfill-trajectory-summaries.ts
//
// Config (env):
//   SCM_BACKFILL_PROJECT   default "claude-memory"
//   SCM_BACKFILL_CONFIRM   unset/anything-but-"1" = dry run; "1" = write
//   SCM_BACKFILL_LIMIT     max chunks this run (default 1000)
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { summarizeTrajectory } from "../src/trajectory/summarizer.js";
import { embed } from "../src/ollama.js";
import { buildSummaryRow } from "../src/trajectory/backfill-row.js";

const PROJECT = process.env.SCM_BACKFILL_PROJECT ?? "claude-memory";
const CONFIRM = process.env.SCM_BACKFILL_CONFIRM === "1";
const LIMIT = readIntEnv("SCM_BACKFILL_LIMIT", 1000);

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type PendingChunk = { chunk_id: number; content: string };

async function fetchPending(limit: number): Promise<PendingChunk[]> {
  const { data: succ, error: succErr } = await supabase
    .from("successful_chunks")
    .select("chunk_id")
    .eq("project_id", PROJECT);
  if (succErr) throw new Error(`successful_chunks scan failed: ${succErr.message}`);
  const succIds = (succ ?? []).map((r: { chunk_id: number }) => r.chunk_id);
  if (succIds.length === 0) return [];

  const { data: done, error: doneErr } = await supabase
    .from("trajectory_summaries")
    .select("source_chunk_id")
    .eq("project_id", PROJECT);
  if (doneErr) throw new Error(`trajectory_summaries scan failed: ${doneErr.message}`);
  const doneSet = new Set((done ?? []).map((r: { source_chunk_id: number }) => r.source_chunk_id));

  const pendingIds = succIds.filter((id) => !doneSet.has(id)).slice(0, limit);
  if (pendingIds.length === 0) return [];

  const { data: chunks, error: chunkErr } = await supabase
    .from("memory_chunks")
    .select("id, content")
    .in("id", pendingIds);
  if (chunkErr) throw new Error(`memory_chunks load failed: ${chunkErr.message}`);
  return (chunks ?? [])
    .filter((c: { content: unknown }) => typeof c.content === "string" && (c.content as string).trim().length > 0)
    .map((c: { id: number; content: string }) => ({ chunk_id: c.id, content: c.content }));
}

async function main(): Promise<void> {
  const pending = await fetchPending(LIMIT);
  console.log(`[backfill] project=${PROJECT} confirm=${CONFIRM} pending=${pending.length}`);

  if (!CONFIRM) {
    for (const c of pending.slice(0, 10)) {
      console.log(`  would summarize chunk ${c.chunk_id} (${c.content.length} chars)`);
    }
    console.log(
      `[backfill] DRY RUN — set SCM_BACKFILL_CONFIRM=1 to write. ` +
        `${pending.length} chunk(s) would be summarized.`,
    );
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const chunk of pending) {
    try {
      const summary = await summarizeTrajectory(chunk.content);
      let embedding: number[] | null = null;
      try {
        const [vec] = await embed([summary.summary]);
        if (Array.isArray(vec) && vec.length > 0) embedding = vec;
      } catch {
        embedding = null; // embeddings are best-effort; the row is still useful
      }
      const row = buildSummaryRow(PROJECT, chunk, summary, embedding);
      const { error } = await supabase
        .from("trajectory_summaries")
        .upsert(row, { onConflict: "project_id,source_chunk_id" });
      if (error) throw new Error(error.message);
      ok += 1;
      if (ok % 10 === 0) console.log(`  [progress] ${ok}/${pending.length} summarized`);
    } catch (err) {
      failed += 1;
      console.error(`  [skip] chunk ${chunk.chunk_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[backfill] DONE project=${PROJECT} summarized=${ok} failed=${failed} of ${pending.length}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("\nFATAL — backfill aborted:");
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
