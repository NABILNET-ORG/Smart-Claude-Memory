// scripts/eval-graph-rerank.ts — SCM-S50 concept-bridge ship-gate eval.
//
// Prints recall@3 + MRR for the CURRENT config. `config` caches env at import,
// so compare phases by running twice and diffing the JSON:
//   SCM_GRAPH_RERANK_ENABLED=false npx tsx scripts/eval-graph-rerank.ts   # baseline
//   SCM_GRAPH_RERANK_ENABLED=true  npx tsx scripts/eval-graph-rerank.ts   # candidate
//
// Ship-gate (spec §8/§9): flip the SCM_GRAPH_RERANK_ENABLED default to true ONLY
// when the candidate phase shows recall_at_3 strictly up and mrr not down, with
// zero regression on a well-served control set. That flip is its own final PR.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { searchMemory } from "../src/tools/search.js";
import { recallAtK, mrr } from "../src/tools/metrics.js";
import { config } from "../src/config.js";

interface EvalCase {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition?: string; // SCM-S52: "control" | "lift" | "capability"; absent → "all"
}

// SCM-S52: fixture path is overridable so the same harness runs the s16 baseline,
// the s52 ship-gate, and the s52 capability set without code changes.
const FIXTURE = process.env.SCM_EVAL_FIXTURE ?? "docs/superpowers/specs/s16-d1-eval-queries.json";

async function main(): Promise<void> {
  const cases: EvalCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (!cases.length) {
    console.log(`[eval] ${FIXTURE} is empty — curate 5–10 queries whose gold chunk currently ranks > 3`);
    console.log("[eval] (verify each fails with SCM_GRAPH_RERANK_ENABLED=false BEFORE adding it).");
    return;
  }
  const verbose = process.env.EVAL_VERBOSE === "1" || process.env.EVAL_VERBOSE === "true";
  let r3 = 0;
  let m = 0;
  // SCM-S52: per-partition accumulators — lift (rank 4-40) and control (rank 1-3)
  // are scored independently because the flip rule needs lift-up AND control-not-down.
  const groups = new Map<string, { r3: number; m: number; n: number }>();
  const bump = (part: string, hit3: number, rr: number): void => {
    const g = groups.get(part) ?? { r3: 0, m: 0, n: 0 };
    g.r3 += hit3;
    g.m += rr;
    g.n += 1;
    groups.set(part, g);
  };
  const rows: { rank: string; top3: number; rr: number; gold: number; part: string; query: string }[] = [];
  for (const c of cases) {
    const res = (await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 })) as {
      results: { id: number }[];
    };
    const ids = res.results.map((x) => x.id);
    const hit3 = recallAtK(ids, c.gold_chunk_id, 3);
    const rr = mrr(ids, c.gold_chunk_id);
    r3 += hit3;
    m += rr;
    bump(c.partition ?? "all", hit3, rr);
    const idx = ids.indexOf(c.gold_chunk_id);
    rows.push({
      rank: idx === -1 ? ">10" : String(idx + 1),
      top3: hit3,
      rr,
      gold: c.gold_chunk_id,
      part: c.partition ?? "all",
      query: c.query,
    });
  }
  if (verbose) {
    for (const row of rows) {
      console.log(
        `[q] part=${row.part}\trank=${row.rank}\ttop3=${row.top3}\trr=${row.rr.toFixed(3)}\tgold=${row.gold}\t:: ${row.query.slice(0, 64)}`,
      );
    }
  }
  const partitions: Record<string, { n: number; recall_at_3: number; mrr: number }> = {};
  for (const [part, g] of [...groups.entries()].sort()) {
    partitions[part] = {
      n: g.n,
      recall_at_3: Number((g.r3 / g.n).toFixed(4)),
      mrr: Number((g.m / g.n).toFixed(4)),
    };
  }
  console.log(
    JSON.stringify(
      {
        rerank_enabled: config.SCM_GRAPH_RERANK_ENABLED,
        alpha: config.SCM_GRAPH_RERANK_ALPHA,
        fixture: FIXTURE,
        cases: cases.length,
        overall: {
          recall_at_3: Number((r3 / cases.length).toFixed(4)),
          mrr: Number((m / cases.length).toFixed(4)),
        },
        partitions,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
