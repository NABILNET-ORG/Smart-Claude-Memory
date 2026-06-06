// scripts/probe-confidence-threshold.ts — SCM-S53 confidence-gate calibration.
//
// READ-ONLY measurement (no DB writes, no code changes). Runs PURE-VECTOR search
// (graph-rerank forced OFF) over the frozen S52 fixtures and reports the
// pure-vector top-1 similarity distribution grouped by Control vs Lift/Capability,
// plus a threshold sweep. This is the empirical basis for choosing
// SCM_GRAPH_CONFIDENCE_THRESHOLD — replacing the placeholder 0.82 guess.
//
//   npx tsx scripts/probe-confidence-threshold.ts
//   PROBE_VERBOSE=1 npx tsx scripts/probe-confidence-threshold.ts   # per-case dump
//
// Why force OFF, why dynamic import: the gate tests candidates[0].similarity —
// the RAW vector pool top-1, before any rerank. searchMemory().results[0] only
// equals that value when rerank is OFF. `config` caches env at import, so we
// must override the flag BEFORE importing the search module.
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

/** Distribution summary; quantiles via linear interpolation. */
function describe(xs: number[]): { n: number; min: number; p25: number; median: number; avg: number; p75: number; max: number } {
  if (!xs.length) return { n: 0, min: NaN, p25: NaN, median: NaN, avg: NaN, p75: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return {
    n: s.length,
    min: round(s[0]),
    p25: round(quantile(0.25)),
    median: round(quantile(0.5)),
    avg: round(s.reduce((a, b) => a + b, 0) / s.length),
    p75: round(quantile(0.75)),
    max: round(s[s.length - 1]),
  };
}

const cell = (v: number): string => (Number.isNaN(v) ? "-" : v.toFixed(4)).padStart(8);
const fmt = (d: ReturnType<typeof describe>): string =>
  `n=${String(d.n).padStart(2)}  min=${cell(d.min)}  p25=${cell(d.p25)}  med=${cell(d.median)}  avg=${cell(d.avg)}  p75=${cell(d.p75)}  max=${cell(d.max)}`;

async function main(): Promise<void> {
  // Force pure vector BEFORE the search module (and its cached config) loads.
  process.env.SCM_GRAPH_RERANK_ENABLED = "false";
  const { searchMemory } = await import("../src/tools/search.js");

  const cases: EvalCase[] = FIXTURES.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as EvalCase[]);

  const byPartition = new Map<string, number[]>();
  const control: number[] = [];
  const liftCap: number[] = [];
  const perCase: { top1: number; part: string; goldRank: string }[] = [];

  for (const c of cases) {
    const res = (await searchMemory({ query: c.query, project_id: c.project_id, limit: 10 })) as {
      results: { id: number; similarity: number }[];
    };
    const top1 = res.results[0]?.similarity ?? 0;
    const part = c.partition ?? "all";
    if (!byPartition.has(part)) byPartition.set(part, []);
    byPartition.get(part)!.push(top1);
    (part === "control" ? control : liftCap).push(top1); // lift + capability merged
    const idx = res.results.findIndex((x) => x.id === c.gold_chunk_id);
    perCase.push({ top1: round(top1), part, goldRank: idx === -1 ? ">10" : String(idx + 1) });
  }

  // Threshold sweep: gate SKIPS graph (protects) when top1 >= T; runs graph when top1 < T.
  const sweep: string[] = [];
  for (let T = 0.5; T <= 0.951; T += 0.05) {
    const t = round(T);
    const ctl = control.filter((x) => x >= t).length;
    const lift = liftCap.filter((x) => x < t).length;
    const ctlPct = control.length ? round((ctl / control.length) * 100) : 0;
    const liftPct = liftCap.length ? round((lift / liftCap.length) * 100) : 0;
    sweep.push(
      `  T=${t.toFixed(2)}   control_protected ${String(ctl).padStart(2)}/${control.length} (${String(ctlPct).padStart(5)}%)   lift_engaged ${String(lift).padStart(2)}/${liftCap.length} (${String(liftPct).padStart(5)}%)`,
    );
  }

  const maxLift = liftCap.length ? Math.max(...liftCap) : NaN;
  const minControl = control.length ? Math.min(...control) : NaN;
  const cleanGap = maxLift < minControl;

  console.log(`# SCM-S53 confidence-gate probe — pure-vector top-1 similarity (${cases.length} frozen S52 cases, rerank OFF)`);
  console.log("");
  console.log("## Per-partition");
  for (const [k, v] of [...byPartition.entries()].sort()) console.log(`  ${k.padEnd(11)} ${fmt(describe(v))}`);
  console.log("");
  console.log("## Grouped (the gate's two worlds)");
  console.log(`  CONTROL     ${fmt(describe(control))}`);
  console.log(`  LIFT+CAPAB  ${fmt(describe(liftCap))}`);
  console.log("");
  console.log(
    `## Separation: max(lift+cap)=${cell(round(maxLift)).trim()}  min(control)=${cell(round(minControl)).trim()}  clean_gap=${cleanGap}  gap_width=${cleanGap ? round(minControl - maxLift) : 0}`,
  );
  if (cleanGap) {
    console.log(`  → Any T in (${round(maxLift)}, ${round(minControl)}] protects ALL control AND engages ALL lift. Suggest T=${round((maxLift + minControl) / 2)}.`);
  } else {
    console.log("  → OVERLAP: no single T is perfect. Read the sweep and trade control-protection vs lift-recovery.");
  }
  console.log("");
  console.log("## Threshold sweep");
  for (const line of sweep) console.log(line);

  if (process.env.PROBE_VERBOSE === "1") {
    console.log("\n## Per-case (sorted by top1 asc)");
    for (const p of perCase.sort((a, b) => a.top1 - b.top1)) {
      console.log(`  top1=${p.top1.toFixed(4)}  part=${p.part.padEnd(11)} goldRank=${p.goldRank}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
