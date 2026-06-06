// scripts/trace-control-regressors.ts — SCM-S53 control-regressor diagnostic.
//
// READ-ONLY. Isolates exactly which CONTROL queries the gate+pin candidate
// demotes out of the top-3, and reports each one's pure-vector baseline rank,
// candidate rank, and top1-top2 margin — the data that decides whether a
// threshold bump can rescue them or the control/lift overlap is unresolvable.
//
// Uses real components (no rerank reimplementation):
//   - searchChunks  → the pure-vector primitive (baseline rank + margin); ignores the ENABLED flag
//   - searchMemory  → the live candidate path (gate@threshold + top-1 pin), ENABLED=true
//
//   npx tsx scripts/trace-control-regressors.ts
//   SCM_GRAPH_MARGIN_THRESHOLD=0.025 npx tsx scripts/trace-control-regressors.ts
import "dotenv/config";
import { readFileSync } from "node:fs";

interface EvalCase {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition?: string;
}

const FIXTURE = "docs/superpowers/specs/s52-shipgate-eval.json";
const round = (x: number): number => Number(x.toFixed(4));
const rankStr = (n: number): string => (Number.isFinite(n) ? String(n) : ">50");

async function main(): Promise<void> {
  // Candidate config: rerank ON, full timeout so the bridge executes.
  process.env.SCM_GRAPH_RERANK_ENABLED = "true";
  process.env.SCM_GRAPH_RERANK_TIMEOUT_MS = process.env.SCM_GRAPH_RERANK_TIMEOUT_MS ?? "30000";
  process.env.SCM_GRAPH_MARGIN_THRESHOLD = process.env.SCM_GRAPH_MARGIN_THRESHOLD ?? "0.02";

  const { searchMemory } = await import("../src/tools/search.js");
  const { searchChunks } = await import("../src/supabase.js");
  const { embed } = await import("../src/ollama.js");
  const { config } = await import("../src/config.js");
  const T = config.SCM_GRAPH_MARGIN_THRESHOLD;

  const cases: EvalCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const control = cases.filter((c) => (c.partition ?? "") === "control");

  type Row = {
    status: string;
    baseRank: number;
    candRank: number;
    margin: number;
    gated: boolean;
    gold: number;
    query: string;
  };
  const rows: Row[] = [];
  let baseHit = 0;
  let candHit = 0;
  let engaged = 0;

  for (const c of control) {
    const [qvec] = await embed([c.query]);
    // Pure-vector baseline (searchChunks is order-independent of the ENABLED flag).
    const vec = await searchChunks(c.project_id, qvec, 50, 0.0, null, true);
    const bIdx = vec.findIndex((r) => r.id === c.gold_chunk_id);
    const baseRank = bIdx === -1 ? Infinity : bIdx + 1;
    const margin = (vec[0]?.similarity ?? 0) - (vec[1]?.similarity ?? 0);
    const gated = margin >= T; // true ⇒ gate SKIPS graph (pure vector returned)
    if (!gated) engaged += 1;

    // Candidate (gate@T + top-1 pin), via the real search path.
    const res = (await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 })) as {
      results: { id: number }[];
    };
    const cIdx = res.results.findIndex((r) => r.id === c.gold_chunk_id);
    const candRank = cIdx === -1 ? Infinity : cIdx + 1;

    if (baseRank <= 3) baseHit += 1;
    if (candRank <= 3) candHit += 1;

    let status = "stable";
    if (baseRank <= 3 && candRank > 3) status = "REGRESSED";
    else if (baseRank > 3 && candRank <= 3) status = "improved";
    else if (baseRank > 3 && candRank > 3) status = "already-broken";
    rows.push({ status, baseRank, candRank, margin: round(margin), gated, gold: c.gold_chunk_id, query: c.query });
  }

  const show = (r: Row): void =>
    console.log(
      `  margin=${r.margin.toFixed(4)}  gate=${r.gated ? "SKIP " : "ENGAGE"}  baseRank=${rankStr(r.baseRank).padStart(3)} -> candRank=${rankStr(r.candRank).padStart(3)}  gold=${r.gold}  :: ${r.query.slice(0, 70)}`,
    );

  console.log(`# SCM-S53 control-regressor trace — shipgate control partition (n=${control.length}), threshold T=${T}`);
  console.log(`# control recall@3: baseline ${baseHit}/${control.length} (${round(baseHit / control.length)})  candidate ${candHit}/${control.length} (${round(candHit / control.length)})  | gate-engaged ${engaged}/${control.length}`);

  const regressors = rows.filter((r) => r.status === "REGRESSED").sort((a, b) => a.margin - b.margin);
  const improvers = rows.filter((r) => r.status === "improved").sort((a, b) => a.margin - b.margin);

  console.log(`\n## REGRESSORS (baseline rank ≤3 → candidate rank >3): ${regressors.length}`);
  regressors.forEach(show);
  console.log(`\n## IMPROVERS (baseline rank >3 → candidate rank ≤3): ${improvers.length}`);
  improvers.forEach(show);

  if (regressors.length) {
    const marginsAsc = regressors.map((r) => r.margin).sort((a, b) => a - b);
    const minRegMargin = marginsAsc[0];
    const maxRegMargin = marginsAsc[marginsAsc.length - 1];
    console.log(
      `\n## Analysis: regressor margins span ${round(minRegMargin)}–${round(maxRegMargin)}. The gate SKIPS a query when margin ≥ T, so protecting ALL regressors requires T ≤ ${round(minRegMargin)} — which also gate-skips nearly all lift (lift lives at similarly low margins). That co-location is the fundamental overlap.`,
    );
  } else {
    console.log("\n## Analysis: no control regressors at this threshold.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
