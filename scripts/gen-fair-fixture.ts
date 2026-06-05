// scripts/gen-fair-fixture.ts — SCM-S52 Phase 2: synthesize an HONEST OFF-vs-ON
// eval fixture for the concept-bridge graph re-rank.
//
// Produces TWO fixtures, by design kept strictly separate (spec §2.2):
//
//   A) SHIP-GATE  → docs/superpowers/specs/s52-shipgate-eval.json
//      Difficulty-partitioned, BLIND to bridges. This set ALONE decides the
//      SCM_GRAPH_RERANK_ENABLED flip. Golds are sampled from anchored
//      claude-memory chunks; for each we generate an oblique-but-faithful NL
//      query (local Ollama `gemma`), embed it (nomic-embed-text), run a
//      PURE-VECTOR search, and partition STRICTLY by the gold's pure-vector
//      rank — never by whether a bridge exists:
//          control = rank 1-3   (vector already nails  → regression guard)
//          lift    = rank 4-40  (vector misses top-3   → where a bridge COULD help)
//          discard = rank >40 or not found
//      Non-circularity invariant: bridges are NEVER consulted when selecting or
//      partitioning the ship-gate. Difficulty (vector rank) is the ONLY filter.
//
//   B) CAPABILITY → docs/superpowers/specs/s52-capability-eval.json
//      ~5 queries ENGINEERED to satisfy the §3 Goldilocks inequality: gold
//      anchored, pure-vector rank 4-40, AND shares a high-weight FILE/SYMBOL/
//      DECISION bridge with the query's top vector seeds so that with α=0.7 the
//      ON-arm pulls the gold into top-3. Each candidate is verified by ACTUALLY
//      RUNNING the ON-arm rerank (the exact fusion from src/tools/search.ts) and
//      KEEPING ONLY queries where the gold demonstrably improves OFF→ON into
//      top-3. DIAGNOSTIC ONLY — never merged into the ship-gate.
//
// ── Boundary Invariant #1 ────────────────────────────────────────────────
// Invariant #1 forbids generative LLMs in the EXTRACTOR pipeline (src/graph/*).
// This is an EVAL-HARNESS data-synthesis script: using local Ollama `gemma` to
// author test queries is explicitly allowed and standard practice. This file
// touches NOTHING under src/graph/ and imports no extractor code. All retrieval
// and fusion is REUSED from the shipped modules below — none is reimplemented:
//   searchChunks        (src/supabase.ts:272)  — pure-vector ranking
//   fetchConceptChunks  (src/supabase.ts:358)  — kg_bridge_chunks RPC (FILE/DECISION/SYMBOL)
//   fetchChunksByIds    (src/supabase.ts)      — recall expansion
//   kgHybridSearch      (src/tools/kg.ts)      — seeds + 1-hop neighbors
//   conceptWeights      (src/tools/bridge.ts)  — W(k)
//   rerank              (src/tools/rerank.ts)  — α-fusion scorer
//   embed               (src/ollama.ts)        — nomic-embed-text
//   chat                (src/ollama.ts)        — gemma query generation
//   config              (src/config.ts)        — α / pool / expand
//
// ── Reproducibility ──────────────────────────────────────────────────────
// gemma generation is non-deterministic, so the COMMITTED JSON is the artifact
// of record: the eval reproduces from the file even though re-running this
// generator would author different query wordings. Entries are pretty-printed
// with deterministic ordering (control before lift; capability by OFF→ON gain).
//
// Env: standard dotenv (via src/config.ts) + shared supabase client. No creds
// here. Usage:  tsx scripts/gen-fair-fixture.ts
//   SCM_FIX_PROJECT       project_id            (default: claude-memory)
//   SCM_FIX_CANDIDATES    golds to sample       (default: 220)
//   SCM_FIX_POOL          pure-vector pool depth (default: 60; > 40 so rank>40 is observable)
//   SCM_FIX_GEMMA_MODEL   Ollama gen model      (default: gemma4:e2b)
//   SCM_FIX_SEED          deterministic sampling order seed (default: 52)

import "dotenv/config";
import { writeFileSync } from "node:fs";
import {
  supabase,
  searchChunks,
  fetchConceptChunks,
  fetchChunksByIds,
  type MatchRow,
} from "../src/supabase.js";
import { embed, chat } from "../src/ollama.js";
import { kgHybridSearch, type KgSeed, type KgNeighbor } from "../src/tools/kg.js";
import { conceptWeights } from "../src/tools/bridge.js";
import { rerank } from "../src/tools/rerank.js";
import { config } from "../src/config.js";

const PROJECT = process.env.SCM_FIX_PROJECT ?? "claude-memory";
const N_CANDIDATES = Number(process.env.SCM_FIX_CANDIDATES ?? 220);
const POOL = Number(process.env.SCM_FIX_POOL ?? 60); // > 40 so the discard band is observable
const GEMMA_MODEL = process.env.SCM_FIX_GEMMA_MODEL ?? "gemma4:e2b";
const SEED = Number(process.env.SCM_FIX_SEED ?? 52);

const SHIPGATE_OUT = "docs/superpowers/specs/s52-shipgate-eval.json";
const CAPABILITY_OUT = "docs/superpowers/specs/s52-capability-eval.json";

const TARGET_LIFT = 25;
const TARGET_CONTROL = 15;
const TARGET_CAPABILITY = 5;

// ── fixture entry schemas (superset of what eval-graph-rerank.ts reads) ──────
// The harness destructures only { query, gold_chunk_id, project_id }; the extra
// diagnostic fields are ignored by it (confirmed against scripts/eval-graph-rerank.ts).
interface ShipGateEntry {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition: "control" | "lift";
  vector_rank: number;
}
interface CapabilityEntry {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition: "capability";
  vector_rank: number;
  bridge_note: string;
}

type GoldChunk = { id: number; content: string; file_origin: string };

// ── deterministic PRNG (mulberry32) so candidate sampling order is reproducible ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── candidate golds: ANCHORED claude-memory chunks (those with >=1 real kg_node) ──
// Pull the distinct source_chunk_ids of non-sentinel nodes, then fetch the chunk
// bodies. Oversample to survive obliqueness + difficulty filtering.
async function fetchAnchoredGolds(limit: number): Promise<GoldChunk[]> {
  // distinct anchored chunk ids (exclude the daemon's `skipped:<id>` sentinels)
  const ids = new Set<number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("source_chunk_id")
      .eq("project_id", PROJECT)
      .not("source_chunk_id", "is", null)
      .not("label", "like", "skipped:%")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`anchored-id fetch failed: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      const cid = (r as { source_chunk_id: number | null }).source_chunk_id;
      if (cid != null) ids.add(Number(cid));
    }
    if (rows.length < PAGE) break;
  }
  const idList = shuffle([...ids]).slice(0, limit);

  // fetch chunk bodies; skip empties / pure-structural noise unsuitable for a query
  const golds: GoldChunk[] = [];
  const CHUNK_PAGE = 200;
  for (let i = 0; i < idList.length; i += CHUNK_PAGE) {
    const slice = idList.slice(i, i + CHUNK_PAGE);
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id,content,file_origin")
      .eq("project_id", PROJECT)
      .in("id", slice);
    if (error) throw new Error(`chunk-body fetch failed: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as { id: number; content: string; file_origin: string };
      const content = (row.content ?? "").trim();
      if (content.length >= 80) golds.push({ id: row.id, content, file_origin: row.file_origin });
    }
  }
  // preserve the shuffled order from idList for determinism
  const order = new Map(idList.map((id, idx) => [id, idx]));
  golds.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return golds;
}

// ── gemma: oblique-but-faithful query whose true answer IS this chunk ─────────
// Instruct gemma to AVOID the chunk's distinctive identifiers/terms so the query
// is genuinely hard for pure lexical/vector matching (spec R1).
async function generateObliqueQuery(chunk: GoldChunk): Promise<string | null> {
  const sys =
    "You write a single natural-language search question for a developer knowledge base. " +
    "The question's TRUE answer must be the passage provided. " +
    "Phrase it OBLIQUELY: describe the underlying concept or situation in plain words. " +
    "DO NOT reuse the passage's distinctive identifiers, file names, symbol names, code tokens, " +
    "decision IDs (like SCM-S50-D1), version numbers, or rare technical terms verbatim. " +
    "Use everyday paraphrase instead. Output ONLY the question on one line, no quotes, no preamble.";
  const user = `PASSAGE:\n${chunk.content.slice(0, 1200)}\n\nWrite ONE oblique question whose answer is this passage.`;
  let raw: string;
  try {
    raw = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { model: GEMMA_MODEL, temperature: 0.6, timeoutMs: 60_000 },
    );
  } catch (e) {
    console.warn(`  gemma error on chunk ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  // sanitize: first non-empty line, strip surrounding quotes / list markers / "Question:" prefix
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const q = line
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(?:Question|Q)\s*[:\-]\s*/i, "")
    .replace(/^[-*\d.)\s]+/, "")
    .trim();
  if (q.length < 12) return null;
  return q;
}

// ── pure-vector rank of the gold within a deep pool (BLIND to bridges) ────────
async function pureVectorRank(queryVec: number[], goldId: number): Promise<number> {
  const rows: MatchRow[] = await searchChunks(PROJECT, queryVec, POOL, 0.0, null, true);
  const idx = rows.findIndex((r) => r.id === goldId);
  return idx < 0 ? -1 : idx + 1; // 1-indexed; -1 = not in pool
}

// ── ON-arm rerank: EXACT replica of the fusion block in src/tools/search.ts ──
// Returns the reranked id list (top `config pool`), used ONLY for the capability
// set to PROVE a bridge fires (OFF rank → ON rank). Mirrors search.ts verbatim:
// kgHybridSearch → conceptWeights → fetchConceptChunks → expand top-W misses via
// fetchChunksByIds → rerank(α=config). No timeout race here (offline harness).
async function onArmRankedIds(
  queryVec: number[],
  candidates: MatchRow[],
): Promise<{ ids: number[]; bridgeRows: number; note: string }> {
  const graph = await kgHybridSearch({ project_id: PROJECT, query_embedding: queryVec });
  if (!graph.ok) return { ids: candidates.map((c) => c.id), bridgeRows: 0, note: "no_graph_context" };
  const seeds: KgSeed[] = graph.seeds;
  const neighbors: KgNeighbor[] = graph.neighbors;
  const W = conceptWeights(seeds, neighbors);
  const conceptIds = [...W.keys()];
  if (!conceptIds.length) return { ids: candidates.map((c) => c.id), bridgeRows: 0, note: "empty_concept_set" };

  const bridge = await fetchConceptChunks(PROJECT, conceptIds);
  const candidateIds = new Set(candidates.map((c) => c.id));
  const gRaw = new Map<number, number>();
  for (const b of bridge) {
    const wk = W.get(b.concept_id);
    if (wk !== undefined) gRaw.set(b.chunk_id, (gRaw.get(b.chunk_id) ?? 0) + wk * b.w_ck);
  }
  const expandIds = [...gRaw.entries()]
    .filter(([id]) => !candidateIds.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.SCM_GRAPH_RERANK_EXPAND)
    .map(([id]) => id);
  const expansion = expandIds.length ? await fetchChunksByIds(PROJECT, expandIds, queryVec) : [];
  const ranked = rerank({
    candidates,
    expansion,
    conceptWeights: W,
    bridge,
    params: { alpha: config.SCM_GRAPH_RERANK_ALPHA },
  });
  return { ids: ranked.map((r) => r.id), bridgeRows: bridge.length, note: "" };
}

// ── identify which concept node carries the gold's bridge (for bridge_note) ──
async function bridgeCarrierFor(
  queryVec: number[],
  goldId: number,
): Promise<{ nodeId: number; nodeLabel: string; nodeType: string; w_ck: number } | null> {
  const graph = await kgHybridSearch({ project_id: PROJECT, query_embedding: queryVec });
  if (!graph.ok) return null;
  const W = conceptWeights(graph.seeds, graph.neighbors);
  const conceptIds = [...W.keys()];
  if (!conceptIds.length) return null;
  const bridge = await fetchConceptChunks(PROJECT, conceptIds);
  // the bridge rows that connect the gold chunk, ranked by W(k)*w_ck contribution
  const carriers = bridge
    .filter((b) => b.chunk_id === goldId && W.get(b.concept_id) !== undefined)
    .map((b) => ({ concept_id: b.concept_id, contrib: (W.get(b.concept_id) ?? 0) * b.w_ck, w_ck: b.w_ck }))
    .sort((a, b) => b.contrib - a.contrib);
  if (!carriers.length) return null;
  const top = carriers[0];
  // resolve the concept node label/type for a human-readable note
  const { data } = await supabase
    .from("kg_nodes")
    .select("id,label,type")
    .eq("id", top.concept_id)
    .limit(1);
  const node = (data ?? [])[0] as { id: number; label: string; type: string } | undefined;
  return {
    nodeId: top.concept_id,
    nodeLabel: node?.label ?? `node:${top.concept_id}`,
    nodeType: node?.type ?? "?",
    w_ck: top.w_ck,
  };
}

function histogram(ranks: number[]): string {
  const bands: Record<string, number> = { "1-3": 0, "4-10": 0, "11-20": 0, "21-40": 0, ">40_or_miss": 0 };
  for (const r of ranks) {
    if (r >= 1 && r <= 3) bands["1-3"]++;
    else if (r >= 4 && r <= 10) bands["4-10"]++;
    else if (r >= 11 && r <= 20) bands["11-20"]++;
    else if (r >= 21 && r <= 40) bands["21-40"]++;
    else bands[">40_or_miss"]++;
  }
  return Object.entries(bands)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

async function main(): Promise<void> {
  console.log(`[gen] project=${PROJECT}  candidates=${N_CANDIDATES}  pool=${POOL}  gemma=${GEMMA_MODEL}  seed=${SEED}`);

  const golds = await fetchAnchoredGolds(N_CANDIDATES);
  console.log(`[gen] sampled ${golds.length} anchored candidate golds (content >= 80 chars)`);

  const control: ShipGateEntry[] = [];
  const lift: ShipGateEntry[] = [];
  const allRanks: number[] = [];
  // record per-gold context for the capability pass (reuse work; avoid re-embedding)
  const liftCtx: { gold: GoldChunk; query: string; queryVec: number[]; rank: number; candidates: MatchRow[] }[] = [];

  let processed = 0;
  for (const gold of golds) {
    // EARLY-STOP (spec-R1 efficiency): halt as soon as BOTH ship-gate bands hit
    // target (>=TARGET_LIFT lift AND >=TARGET_CONTROL control). N_CANDIDATES stays
    // the ceiling. Every lift entry already records a liftCtx context, so by the
    // time lift fills there are TARGET_LIFT contexts available for the (<=5-query)
    // capability pass — no need to over-process the whole candidate pool. If the
    // pool exhausts first, the loop ends naturally and the shortfall is reported.
    if (control.length >= TARGET_CONTROL && lift.length >= TARGET_LIFT) break;
    processed++;

    const query = await generateObliqueQuery(gold);
    if (!query) continue;
    let queryVec: number[];
    try {
      [queryVec] = await embed([query]);
    } catch (e) {
      console.warn(`  embed error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const rank = await pureVectorRank(queryVec, gold.id);
    allRanks.push(rank);

    if (rank >= 1 && rank <= 3) {
      if (control.length < TARGET_CONTROL * 3) {
        control.push({ query, gold_chunk_id: gold.id, project_id: PROJECT, partition: "control", vector_rank: rank });
      }
    } else if (rank >= 4 && rank <= 40) {
      lift.push({ query, gold_chunk_id: gold.id, project_id: PROJECT, partition: "lift", vector_rank: rank });
      // capture full vector candidate pool now for the capability ON-arm replay
      const cands: MatchRow[] = await searchChunks(PROJECT, queryVec, POOL, 0.0, null, true);
      liftCtx.push({ gold, query, queryVec, rank, candidates: cands });
    }
    // rank > 40 or -1 → discard (still counted in allRanks for the honest histogram)

    if (processed % 20 === 0) {
      console.log(
        `  ..progress processed=${processed}/${golds.length}  control=${control.length}  lift=${lift.length}`,
      );
    }
  }

  // ── deterministic ordering: control first (by vector_rank, then id), then lift ──
  control.sort((a, b) => a.vector_rank - b.vector_rank || a.gold_chunk_id - b.gold_chunk_id);
  lift.sort((a, b) => a.vector_rank - b.vector_rank || a.gold_chunk_id - b.gold_chunk_id);
  const shipgate: ShipGateEntry[] = [...control, ...lift];

  console.log("");
  console.log("=== SHIP-GATE RESULTS ===");
  console.log(`control(rank1-3)=${control.length}  lift(rank4-40)=${lift.length}  processed=${processed}`);
  console.log(`pure-vector rank histogram (all ${allRanks.length} generated): ${histogram(allRanks)}`);
  if (lift.length < TARGET_LIFT) {
    console.log(
      `*** R1 SHORTFALL: lift band has ${lift.length} (< ${TARGET_LIFT}). ` +
        `Reported honestly; NOT padded with rank>40 and filter NOT loosened (spec R1). ***`,
    );
  }
  if (control.length < TARGET_CONTROL) {
    console.log(`*** NOTE: control band has ${control.length} (< ${TARGET_CONTROL}). ***`);
  }

  writeFileSync(SHIPGATE_OUT, JSON.stringify(shipgate, null, 2) + "\n", "utf8");
  console.log(`[gen] wrote ${shipgate.length} ship-gate entries → ${SHIPGATE_OUT}`);

  // ── CAPABILITY SET: from lift golds, keep ONLY those that ACTUALLY improve ──
  // OFF→ON into top-3 under the real fusion, AND carry an identifiable bridge.
  console.log("");
  console.log("=== CAPABILITY CONSTRUCTION (diagnostic; replay real ON-arm) ===");
  const capability: CapabilityEntry[] = [];
  for (const ctx of liftCtx) {
    if (capability.length >= TARGET_CAPABILITY) break;
    const offIdx = ctx.candidates.findIndex((r) => r.id === ctx.gold.id);
    const offRank = offIdx < 0 ? -1 : offIdx + 1;
    if (!(offRank >= 4 && offRank <= 40)) continue; // §3 precondition (already true for lift)

    const on = await onArmRankedIds(ctx.queryVec, ctx.candidates);
    const onIdx = on.ids.findIndex((id) => id === ctx.gold.id);
    const onRank = onIdx < 0 ? -1 : onIdx + 1;
    const improvedIntoTop3 = onRank >= 1 && onRank <= 3 && (offRank < 0 || onRank < offRank);
    if (!improvedIntoTop3) continue;

    const carrier = await bridgeCarrierFor(ctx.queryVec, ctx.gold.id);
    if (!carrier) continue; // require an identifiable bridge node for an honest note

    const note =
      `bridge via ${carrier.nodeType} '${carrier.nodeLabel}' (node #${carrier.nodeId}, w_ck=${carrier.w_ck.toFixed(3)}); ` +
      `OFF rank ${offRank} → ON rank ${onRank} (α=${config.SCM_GRAPH_RERANK_ALPHA}, bridge_rows=${on.bridgeRows})`;
    capability.push({
      query: ctx.query,
      gold_chunk_id: ctx.gold.id,
      project_id: PROJECT,
      partition: "capability",
      vector_rank: ctx.rank,
      bridge_note: note,
    });
    console.log(`  + capability gold=${ctx.gold.id}  ${note}`);
  }

  // deterministic ordering: by OFF→ON gain proxy (lower ON rank first, then id)
  capability.sort((a, b) => a.vector_rank - b.vector_rank || a.gold_chunk_id - b.gold_chunk_id);
  writeFileSync(CAPABILITY_OUT, JSON.stringify(capability, null, 2) + "\n", "utf8");

  console.log("");
  console.log("=== CAPABILITY RESULTS ===");
  console.log(`capability queries (proven OFF→ON top-3 lift): ${capability.length} / target ${TARGET_CAPABILITY}`);
  if (capability.length < TARGET_CAPABILITY) {
    console.log(
      `*** NOTE: only ${capability.length} capability queries demonstrably fire the bridge into top-3. ` +
        `Reported honestly; diagnostic-only set, never decides the flip. ***`,
    );
  }
  console.log(`[gen] wrote ${capability.length} capability entries → ${CAPABILITY_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
