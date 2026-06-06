// scripts/probe-margin-signal.ts — SCM-S53 confidence-gate calibration, Probe v2.
//
// READ-ONLY measurement. Probe v1 proved absolute top-1 similarity does NOT
// separate CONTROL from LIFT+CAPAB (medians 0.7131 vs 0.6941, no clean gap) —
// nomic-embed packs everything into a narrow band. v2 tests RELATIVE confidence:
// the shape of the neighborhood, not its absolute height.
//
// Per frozen S52 case (rerank forced OFF, so results[0..2] are the raw vector
// top-3):
//   abs_margin = top1 - top2                  (gap to the runner-up)
//   rel_margin = (top1 - top3) / top1         (normalized drop-off over top-3)
//
// Hypothesis: a PEAKED neighborhood (large margin) ⇒ confident retrieval ⇒
// control; a FLAT neighborhood (small margin) ⇒ the vector is guessing ⇒ lift.
// Gate fires (SKIP graph) when margin >= T; graph RUNS when margin < T.
//
//   npx tsx scripts/probe-margin-signal.ts
//   PROBE_VERBOSE=1 npx tsx scripts/probe-margin-signal.ts   # per-case dump
import "dotenv/config";
import { readFileSync } from "node:fs";

interface EvalCase {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition?: string; // "control" | "lift" | "capability"; absent → "all"
}

const FIXTURES = [
  "docs/superpowers/specs/s52-shipgate-eval.json",
  "docs/superpowers/specs/s52-capability-eval.json",
];

const round = (x: number): number => Number(x.toFixed(4));

function describe(xs: number[]): { n: number; min: number; p25: number; median: number; avg: number; p75: number; max: number } {
  if (!xs.length) return { n: 0, min: NaN, p25: NaN, median: NaN, avg: NaN, p75: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return {
    n: s.length,
    min: round(s[0]),
    p25: round(q(0.25)),
    median: round(q(0.5)),
    avg: round(s.reduce((a, b) => a + b, 0) / s.length),
    p75: round(q(0.75)),
    max: round(s[s.length - 1]),
  };
}

const cell = (v: number): string => (Number.isNaN(v) ? "-" : v.toFixed(4)).padStart(8);
const fmt = (d: ReturnType<typeof describe>): string =>
  `n=${String(d.n).padStart(2)}  min=${cell(d.min)}  p25=${cell(d.p25)}  med=${cell(d.median)}  avg=${cell(d.avg)}  p75=${cell(d.p75)}  max=${cell(d.max)}`;

/** Distribution + separation + data-driven sweep for one margin metric. */
function report(label: string, control: number[], lift: number[]): void {
  console.log(`\n## ${label}`);
  console.log(`  CONTROL     ${fmt(describe(control))}`);
  console.log(`  LIFT+CAPAB  ${fmt(describe(lift))}`);

  const maxLift = lift.length ? Math.max(...lift) : NaN;
  const minControl = control.length ? Math.min(...control) : NaN;
  const cleanGap = maxLift < minControl;
  console.log(
    `  Separation: max(lift)=${round(maxLift)}  min(control)=${round(minControl)}  clean_gap=${cleanGap}  gap_width=${cleanGap ? round(minControl - maxLift) : 0}`,
  );
  if (cleanGap) {
    console.log(`  → CLEAN: any T in (${round(maxLift)}, ${round(minControl)}] separates perfectly. Suggest T=${round((maxLift + minControl) / 2)}.`);
  }

  // Sweep across the OBSERVED range so the grid always covers the real spread.
  const all = [...control, ...lift];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  console.log("  Sweep (gate SKIPS graph when margin >= T):");
  for (let k = 0; k <= 10; k++) {
    const t = round(lo + ((hi - lo) * k) / 10);
    const ctl = control.filter((x) => x >= t).length;
    const lf = lift.filter((x) => x < t).length;
    const ctlPct = control.length ? round((ctl / control.length) * 100) : 0;
    const lfPct = lift.length ? round((lf / lift.length) * 100) : 0;
    console.log(
      `    T=${t.toFixed(4)}  control_protected ${String(ctl).padStart(2)}/${control.length} (${String(ctlPct).padStart(5)}%)  lift_engaged ${String(lf).padStart(2)}/${lift.length} (${String(lfPct).padStart(5)}%)`,
    );
  }
}

async function main(): Promise<void> {
  // Force pure vector BEFORE the search module (and its cached config) loads, so
  // results[0..2] are the raw vector top-3 the gate would actually see.
  process.env.SCM_GRAPH_RERANK_ENABLED = "false";
  const { searchMemory } = await import("../src/tools/search.js");

  const cases: EvalCase[] = FIXTURES.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as EvalCase[]);

  const absControl: number[] = [];
  const absLift: number[] = [];
  const relControl: number[] = [];
  const relLift: number[] = [];
  const perCase: { abs: number; rel: number; part: string; goldRank: string }[] = [];
  let skipped = 0;

  for (const c of cases) {
    const res = (await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 })) as {
      results: { id: number; similarity: number }[];
    };
    const r0 = res.results[0]?.similarity;
    const r1 = res.results[1]?.similarity;
    const r2 = res.results[2]?.similarity;
    if (r0 === undefined || r1 === undefined || r2 === undefined || r0 <= 0) {
      skipped++; // need a real top-3 to form both margins
      continue;
    }
    const absM = r0 - r1;
    const relM = (r0 - r2) / r0;
    const isControl = (c.partition ?? "all") === "control";
    (isControl ? absControl : absLift).push(absM);
    (isControl ? relControl : relLift).push(relM);
    const idx = res.results.findIndex((x) => x.id === c.gold_chunk_id);
    perCase.push({ abs: round(absM), rel: round(relM), part: c.partition ?? "all", goldRank: idx === -1 ? ">10" : String(idx + 1) });
  }

  console.log(
    `# SCM-S53 Probe v2 — margin signals on ${cases.length} frozen S52 cases (rerank OFF)${skipped ? `, skipped ${skipped} (<3 results)` : ""}`,
  );
  report("ABS margin   top1 - top2", absControl, absLift);
  report("REL margin   (top1 - top3) / top1", relControl, relLift);

  if (process.env.PROBE_VERBOSE === "1") {
    console.log("\n## Per-case (sorted by rel margin asc)");
    for (const p of perCase.sort((a, b) => a.rel - b.rel)) {
      console.log(`  rel=${p.rel.toFixed(4)}  abs=${p.abs.toFixed(4)}  part=${p.part.padEnd(11)} goldRank=${p.goldRank}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
