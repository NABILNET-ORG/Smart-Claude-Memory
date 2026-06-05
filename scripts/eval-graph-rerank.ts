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
}

const FIXTURE = "docs/superpowers/specs/s16-d1-eval-queries.json";

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
  const rows: { rank: string; top3: number; rr: number; gold: number; query: string }[] = [];
  for (const c of cases) {
    const res = (await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 })) as {
      results: { id: number }[];
    };
    const ids = res.results.map((x) => x.id);
    const hit3 = recallAtK(ids, c.gold_chunk_id, 3);
    const rr = mrr(ids, c.gold_chunk_id);
    r3 += hit3;
    m += rr;
    const idx = ids.indexOf(c.gold_chunk_id);
    rows.push({ rank: idx === -1 ? ">10" : String(idx + 1), top3: hit3, rr, gold: c.gold_chunk_id, query: c.query });
  }
  if (verbose) {
    for (const row of rows) {
      console.log(
        `[q] rank=${row.rank}\ttop3=${row.top3}\trr=${row.rr.toFixed(3)}\tgold=${row.gold}\t:: ${row.query.slice(0, 72)}`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        rerank_enabled: config.SCM_GRAPH_RERANK_ENABLED,
        alpha: config.SCM_GRAPH_RERANK_ALPHA,
        cases: cases.length,
        recall_at_3: Number((r3 / cases.length).toFixed(4)),
        mrr: Number((m / cases.length).toFixed(4)),
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
