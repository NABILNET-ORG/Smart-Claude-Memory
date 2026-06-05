// scripts/backfill-kg-extraction.ts — Phase 1 KG densification backfill.
//
// One-shot, insert-only backfill that densifies the knowledge graph for a
// SINGLE project (default claude-memory) by re-running the existing pure-regex
// extractor over every not-yet-anchored memory_chunks row and upserting the
// resulting nodes/edges.
//
// WHY NOT just loop the daemon's runGraphExtractorOnce(): the daemon's
// fetchUnprocessed is GLOBAL and newest-first (no project filter, overfetch
// capped at batch*5, anti-join capped at 10k). On this multi-project DB
// (~17k chunks across 6 projects) a project-scoped drain can never reach 0 via
// the daemon tick — it keeps re-touching the newest rows of OTHER projects and
// starves claude-memory's older chunks. (Empirically: one tick anchored 1071
// nodes but moved claude-memory coverage 0%.) So this script REUSES the real
// extraction + upsert primitives the daemon itself imports —
//   extractFromChunk   (src/graph/extractor.ts)  — the pure regex extractor
//   upsertKgNode/Edge   (src/tools/kg.ts)         — the idempotent upserts
// and reproduces the daemon's processChunk orchestration VERBATIM (sentinel
// path, primary+secondary nodes, labelToId edge resolution). The only thing
// re-implemented is the ~15-line glue (processChunk is module-private, not
// exported) and a PROJECT-SCOPED, oldest-first paged fetch in place of the
// daemon's global fetchUnprocessed. No extraction or upsert logic is
// duplicated. Verified against src/graph/daemon.ts processChunk.
//
// Boundary Invariant #1: zero generative-LLM calls. All graph work flows
// through extractFromChunk (pure regex) + upsertKg* (DB RPCs). No Ollama, no
// LLM import anywhere in this file or its transitive imports.
//
// Termination contract (load-bearing): the queue is drained by paging
// memory_chunks for this project by id ASC and, per page, anchoring every
// chunk — including empty extractions, which get the SAME sentinel NOTE node
// (label `skipped:<id>`, source_chunk_id set) the daemon writes. Because every
// processed chunk is anchored (real node OR sentinel), the project-scoped
// anti-join is strictly monotone-decreasing and the loop is finite. A belt-
// and-braces stall guard breaks if a page somehow fails to anchor anything, so
// an unexpected upsert failure can never spin forever.
//
// Idempotency / concurrency: node upserts are UNIQUE(project_id,label,type),
// edge upserts UNIQUE(project_id,source_id,target_id,relation), so re-running
// is a no-op on already-anchored chunks and it is SAFE to run even while the
// graph_extractor daemon ticks concurrently — both sides race to anchor the
// same chunks and the unique constraints make double-anchoring harmless (one
// wins the insert, the other no-ops). Insert-only: no deletes.
//
// Env: standard script env-loading (dotenv/config) + the shared supabase
// client (src/supabase.ts → src/config.ts reads SUPABASE_URL /
// SUPABASE_SECRET_KEY). No creds hardcoded here.
//
// Usage:  tsx scripts/backfill-kg-extraction.ts
//   SCM_BACKFILL_PROJECT      project_id           (default: claude-memory)
//   SCM_BACKFILL_BATCH        chunks per page      (default: 200)
//   SCM_BACKFILL_CONCURRENCY  parallel chunks/pool (default: 16)
//   SCM_BACKFILL_MAX_BATCHES  safety cap           (default: 100000)

import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { extractFromChunk } from "../src/graph/extractor.js";
import { upsertKgNode, upsertKgEdge } from "../src/tools/kg.js";

const PROJECT = process.env.SCM_BACKFILL_PROJECT ?? "claude-memory";
const BATCH = readIntEnv("SCM_BACKFILL_BATCH", 200);
const MAX_BATCHES = readIntEnv("SCM_BACKFILL_MAX_BATCHES", 100_000);
// Number of chunks processed concurrently within a batch. Each chunk still runs
// the verbatim sequential processChunk pipeline; only DISTINCT chunks overlap,
// which is safe (independent rows, idempotent upserts) and collapses the
// dominant cost — sequential Supabase RPC round-trips. Tune via env.
const CONCURRENCY = readIntEnv("SCM_BACKFILL_CONCURRENCY", 16);

// PostgREST default row cap; we page explicitly past it for accurate counts.
const PAGE = 1_000;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── chunk shape + per-chunk pipeline (mirrors daemon UnprocessedChunk + ──────
// ── processChunk EXACTLY; only difference is it returns its own counts) ──────

type UnprocessedChunk = {
  id: number;
  project_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null;
};

type RunCounts = {
  extracted: number;
  nodes: number;
  edges: number;
  skipped: number;
  errored: number;
};

function makeKey(t: string, l: string): string {
  return `${t}|${l}`;
}

// pgvector round-trips as number[] OR the textual "[...]" form — normalise,
// identical to daemon.coerceEmbedding.
function coerceEmbedding(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return raw.every((v) => typeof v === "number") ? (raw as number[]) : null;
  }
  if (typeof raw === "string" && raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
        return parsed as number[];
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Byte-for-byte port of src/graph/daemon.ts processChunk: extract → sentinel
// (empty) OR primary+secondary nodes + labelToId edge resolution. Kept verbatim
// so backfill output is indistinguishable from daemon output. The empty-
// extraction SENTINEL is what guarantees the chunk is anchored and the loop
// terminates.
async function processChunk(chunk: UnprocessedChunk, counts: RunCounts): Promise<void> {
  try {
    const result = extractFromChunk(chunk);

    if (result.skipped) {
      // Sentinel: anchor the chunk so it doesn't re-enter the queue.
      const sentinel = await upsertKgNode({
        project_id: chunk.project_id,
        type: "NOTE",
        label: `skipped:${chunk.id}`,
        properties: { reason: result.reason ?? "skipped" },
        source_chunk_id: chunk.id,
      });
      if (sentinel.ok) counts.nodes += 1;
      counts.skipped += 1;
      return;
    }

    const labelToId = new Map<string, number>();
    const [primary, ...secondaries] = result.nodes;
    if (!primary) return;

    const primaryRes = await upsertKgNode({
      project_id: chunk.project_id,
      type: primary.type,
      label: primary.label,
      properties: primary.properties,
      embedding: primary.embedding ?? null,
      source_chunk_id: primary.source_chunk_id ?? chunk.id,
    });
    if (!primaryRes.ok) {
      counts.errored += 1;
      return;
    }
    counts.nodes += 1;
    labelToId.set(makeKey(primary.type, primary.label), primaryRes.node_id);

    for (const n of secondaries) {
      const r = await upsertKgNode({
        project_id: chunk.project_id,
        type: n.type,
        label: n.label,
        properties: n.properties,
      });
      if (r.ok) {
        counts.nodes += 1;
        labelToId.set(makeKey(n.type, n.label), r.node_id);
      }
    }

    for (const e of result.edges) {
      const sId = labelToId.get(makeKey(e.source.type, e.source.label));
      const tId = labelToId.get(makeKey(e.target.type, e.target.label));
      if (sId == null || tId == null) continue;
      const er = await upsertKgEdge({
        project_id: chunk.project_id,
        source_id: sId,
        target_id: tId,
        relation: e.relation,
        weight: e.weight ?? 1.0,
        properties: e.properties ?? {},
      });
      if (er.ok) counts.edges += 1;
    }

    counts.extracted += 1;
  } catch {
    counts.errored += 1;
  }
}

// Project-scoped, oldest-first page of chunks that are NOT yet anchored.
// Replaces the daemon's GLOBAL fetchUnprocessed so a single project drains to
// zero. `anchored` is the live set of distinct source_chunk_id already in
// kg_nodes for this project; we page memory_chunks by id ASC from `afterId`.
async function fetchUnprocessedPage(
  anchored: Set<number>,
  afterId: number,
  limit: number,
): Promise<UnprocessedChunk[]> {
  const out: UnprocessedChunk[] = [];
  let cursor = afterId;
  // Scan forward in id order, skipping already-anchored ids, until we collect
  // `limit` unprocessed chunks or run out of rows.
  for (;;) {
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, project_id, content, metadata, embedding")
      .eq("project_id", PROJECT)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`memory_chunks fetch failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: number;
      project_id: string;
      content: string;
      metadata: Record<string, unknown> | null;
      embedding: unknown;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.id;
      if (typeof row.id !== "number" || typeof row.content !== "string") continue;
      if (anchored.has(row.id)) continue;
      out.push({
        id: row.id,
        project_id: row.project_id,
        content: row.content,
        metadata: row.metadata ?? null,
        embedding: coerceEmbedding(row.embedding),
      });
      if (out.length >= limit) return out;
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

type GroupCount = Record<string, number>;

type Snapshot = {
  totalChunks: number;
  anchoredChunks: number;
  coveragePct: number;
  nodesByType: GroupCount;
  edgesByType: GroupCount;
  totalNodes: number;
  totalEdges: number;
};

// ── helpers: every read is scoped to PROJECT and pages past the 1k cap ──────

async function countChunks(): Promise<number> {
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", PROJECT);
  if (error) throw new Error(`memory_chunks count failed: ${error.message}`);
  return count ?? 0;
}

// Distinct source_chunk_id present in kg_nodes for this project. Paged so we
// never undercount on large graphs (PostgREST caps a single page at 1000).
async function anchoredChunkIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("source_chunk_id")
      .eq("project_id", PROJECT)
      .not("source_chunk_id", "is", null)
      .order("source_chunk_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`kg_nodes anchored scan failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ source_chunk_id: number | null }>;
    for (const r of rows) {
      if (typeof r.source_chunk_id === "number") ids.add(r.source_chunk_id);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

// Live unprocessed count using the daemon's exact anti-join shape: chunks for
// this project whose id is NOT in the kg_nodes.source_chunk_id set. This is the
// authoritative termination signal — when it reaches 0 the queue is drained.
async function countUnprocessed(anchored: Set<number>): Promise<number> {
  let from = 0;
  let unprocessed = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id")
      .eq("project_id", PROJECT)
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`memory_chunks unprocessed scan failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: number }>;
    for (const r of rows) {
      if (typeof r.id === "number" && !anchored.has(r.id)) unprocessed += 1;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return unprocessed;
}

async function groupCount(
  table: "kg_nodes" | "kg_edges",
  column: "type" | "relation",
): Promise<{ groups: GroupCount; total: number }> {
  const groups: GroupCount = {};
  let total = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .eq("project_id", PROJECT)
      .order(column, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} ${column} scan failed: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const key = String(r[column] ?? "<null>");
      groups[key] = (groups[key] ?? 0) + 1;
      total += 1;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return { groups, total };
}

async function snapshot(): Promise<{ snap: Snapshot; anchored: Set<number> }> {
  const totalChunks = await countChunks();
  const anchored = await anchoredChunkIds();
  const nodeAgg = await groupCount("kg_nodes", "type");
  const edgeAgg = await groupCount("kg_edges", "relation");
  const anchoredChunks = anchored.size;
  const coveragePct = totalChunks > 0 ? (anchoredChunks / totalChunks) * 100 : 0;
  return {
    snap: {
      totalChunks,
      anchoredChunks,
      coveragePct,
      nodesByType: nodeAgg.groups,
      edgesByType: edgeAgg.groups,
      totalNodes: nodeAgg.total,
      totalEdges: edgeAgg.total,
    },
    anchored,
  };
}

function fmtGroups(g: GroupCount): string {
  const keys = Object.keys(g).sort();
  if (keys.length === 0) return "    (none)";
  return keys.map((k) => `    ${k.padEnd(12)} ${g[k]}`).join("\n");
}

function printSnapshot(label: string, s: Snapshot): void {
  console.log(`\n── ${label} ──────────────────────────────────────────`);
  console.log(`  project                : ${PROJECT}`);
  console.log(`  total memory_chunks    : ${s.totalChunks}`);
  console.log(`  anchored chunks        : ${s.anchoredChunks}`);
  console.log(`  coverage               : ${s.coveragePct.toFixed(2)}%`);
  console.log(`  kg_nodes total         : ${s.totalNodes}`);
  console.log(`  nodes by type:\n${fmtGroups(s.nodesByType)}`);
  console.log(`  kg_edges total         : ${s.totalEdges}`);
  console.log(`  edges by relation:\n${fmtGroups(s.edgesByType)}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("KG densification backfill — Phase 1 (pure-regex re-extraction)");
  console.log(`project=${PROJECT}  batch=${BATCH}  max_batches=${MAX_BATCHES}`);

  // ── BEFORE ────────────────────────────────────────────────────────────
  const before = await snapshot();
  printSnapshot("BEFORE", before.snap);

  const anchored = before.anchored; // mutated in place as we anchor chunks
  let remaining = await countUnprocessed(anchored);
  console.log(`\n  unprocessed queue (before): ${remaining}`);
  if (remaining === 0) {
    console.log("  Queue already drained — nothing to backfill. (idempotent re-run)");
  }

  // ── DRAIN LOOP (project-scoped, oldest-first cursor) ────────────────────
  // Each batch: fetch up to BATCH not-yet-anchored chunks for this project
  // (id ASC from a moving cursor), run the verbatim daemon pipeline on each,
  // then fold every freshly-anchored id into `anchored` so the next fetch skips
  // them. Because every processed chunk is anchored (real node OR sentinel),
  // the queue is strictly monotone-decreasing → the loop is finite. The stall
  // guard is belt-and-braces: if a batch anchors nothing while rows remain
  // (e.g. an unexpected upsert failure), we break instead of spinning.
  let batches = 0;
  let errorTally = 0;
  let nodesCreated = 0;
  let edgesCreated = 0;
  let skippedAnchored = 0;
  let extractedReal = 0;
  let cursor = 0; // id high-water mark; chunks are fetched with id > cursor
  let stalled = false;
  let drainedCursor = false; // true once the id cursor has visited every chunk

  while (batches < MAX_BATCHES) {
    let chunks: UnprocessedChunk[];
    try {
      chunks = await fetchUnprocessedPage(anchored, cursor, BATCH);
    } catch (err) {
      // A fetch failure is fatal to progress — surface it and stop. (DB-level
      // errors here will also be caught by the bottom handler if rethrown.)
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [batch ${batches + 1}] FETCH FAILED: ${msg}`);
      throw err;
    }
    if (chunks.length === 0) {
      // No more unprocessed chunks past the cursor: the project queue is
      // exhausted. This is the clean terminal state.
      drainedCursor = true;
      break;
    }

    batches += 1;
    const counts: RunCounts = { extracted: 0, nodes: 0, edges: 0, skipped: 0, errored: 0 };
    const cursorBefore = cursor;

    // Process the batch in bounded-concurrency pools. Each chunk gets its own
    // RunCounts so the parallel tasks never race on shared counters; we fold the
    // per-chunk results back deterministically after each pool settles.
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const pool = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        pool.map(async (chunk) => {
          const c: RunCounts = { extracted: 0, nodes: 0, edges: 0, skipped: 0, errored: 0 };
          // processChunk has its own try/catch and never throws — one bad chunk
          // is tallied in c.errored and the pool continues.
          await processChunk(chunk, c);
          return { chunk, c };
        }),
      );
      for (const { chunk, c } of results) {
        counts.extracted += c.extracted;
        counts.nodes += c.nodes;
        counts.edges += c.edges;
        counts.skipped += c.skipped;
        counts.errored += c.errored;
        // A chunk is anchored unless its primary upsert errored (sentinel and
        // real-node paths both write a row with source_chunk_id). Only mark
        // anchored when this chunk recorded no error, so a genuinely failed
        // chunk is not falsely skipped — it surfaces as residual unanchored at
        // the end (reported, never silently dropped). The cursor still advances
        // past it so the loop cannot stall on a permanently-failing row.
        if (c.errored === 0) anchored.add(chunk.id);
        if (chunk.id > cursor) cursor = chunk.id;
      }
    }

    nodesCreated += counts.nodes;
    edgesCreated += counts.edges;
    skippedAnchored += counts.skipped;
    extractedReal += counts.extracted;
    errorTally += counts.errored;

    remaining = Math.max(0, remaining - chunks.length);
    console.log(
      `  [batch ${batches}] fetched=${chunks.length} extracted=${counts.extracted} ` +
        `nodes+=${counts.nodes} edges+=${counts.edges} skipped+=${counts.skipped} ` +
        `errored+=${counts.errored} | cursor=${cursor} ~remaining=${remaining}`,
    );

    // True infinite-loop condition = the id cursor failed to advance despite a
    // non-empty fetch (cannot happen while cursor = max consumed id, but guard
    // anyway). Forward progress is guaranteed by the strictly-increasing cursor,
    // so an all-errored batch is NOT a stall — the next fetch returns the next
    // id-range and the run still terminates.
    if (cursor <= cursorBefore) {
      stalled = true;
      console.error(
        `  STALL DETECTED at batch ${batches}: id cursor did not advance past ` +
          `${cursorBefore} despite fetching ${chunks.length} chunk(s). Stopping.`,
      );
      break;
    }
  }

  if (batches >= MAX_BATCHES) {
    console.error(
      `  Reached MAX_BATCHES=${MAX_BATCHES} — raise SCM_BACKFILL_MAX_BATCHES if ` +
        `chunks remain unprocessed.`,
    );
  }

  // ── AFTER ─────────────────────────────────────────────────────────────
  const after = await snapshot();
  printSnapshot("AFTER", after.snap);

  const stillUnanchored = await countUnprocessed(after.anchored);
  const elapsedMs = Date.now() - t0;
  // Chunks newly anchored this run = growth of the distinct-source_chunk_id set.
  const chunksProcessed = Math.max(0, after.snap.anchoredChunks - before.snap.anchoredChunks);

  console.log("\n── RUN SUMMARY ───────────────────────────────────────────");
  console.log(`  batches executed       : ${batches}`);
  console.log(`  chunks processed (run) : ${chunksProcessed}`);
  console.log(`  chunks w/ real extract : ${extractedReal}`);
  console.log(`  nodes upserted (run)   : ${nodesCreated}`);
  console.log(`  edges upserted (run)   : ${edgesCreated}`);
  console.log(`  chunks sentinel-skipped: ${skippedAnchored}`);
  console.log(`  per-run error tally    : ${errorTally}`);
  console.log(
    `  coverage delta         : ${before.snap.coveragePct.toFixed(2)}% -> ` +
      `${after.snap.coveragePct.toFixed(2)}%`,
  );
  console.log(`  chunks still unanchored: ${stillUnanchored}`);
  // Classify the terminal state. The id cursor visiting every chunk
  // (drainedCursor) is the definition of "done". Any chunk still unanchored
  // AFTER a full cursor drain is an EXPECTED duplicate-header collision: its
  // primary (type,label) already exists as a node anchored to an earlier chunk,
  // and upsertKgNode's UNIQUE(project_id,label,type) folds the duplicate into
  // that node WITHOUT repointing source_chunk_id. Such chunks legitimately
  // never get their own anchor row — the daemon behaves identically and would
  // re-touch them every tick. This is a clean, healthy outcome, NOT a failure.
  const incompleteDrain = !drainedCursor && stillUnanchored > 0;
  if (stillUnanchored === 0) {
    console.log(
      "    reason: n/a — every chunk has its own anchor row " +
        "(empty extractions carry a sentinel node).",
    );
  } else if (incompleteDrain) {
    console.log(
      stalled
        ? "    reason: run STALLED before draining the cursor (see stall diagnostic above) — re-run."
        : "    reason: hit MAX_BATCHES cap before draining the cursor — re-run to finish.",
    );
  } else {
    // drainedCursor === true, residual > 0
    console.log(
      "    reason: EXPECTED — these chunks' primary (type,label) duplicates a " +
        "header already anchored to an earlier chunk; the UNIQUE node upsert " +
        "folds them in (no separate anchor). Re-running will NOT change this; " +
        "it is inherent to the extractor's label model, not an error.",
    );
  }
  console.log(`  elapsed                : ${elapsedMs} ms`);

  // Exit non-zero ONLY on a genuinely incomplete drain (stalled, or cap hit with
  // the cursor not exhausted) so CI/automation can distinguish it from a clean
  // run whose only residual is expected duplicate-header collisions. DB-
  // unreachable / missing-env surfaces earlier as a thrown error (exit 1).
  if (incompleteDrain) process.exitCode = 2;
}

main().catch((err) => {
  // Fatal path: DB unreachable, missing env, or a non-batch error. Non-zero
  // exit per the error-handling contract.
  console.error("\nFATAL — backfill aborted:");
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
