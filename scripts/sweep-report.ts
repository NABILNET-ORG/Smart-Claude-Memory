// scripts/sweep-report.ts — SCM-S53 sweep tabulator. Reads the harness JSON
// outputs in scripts/.eval-out/ (base-ship.json + sweep-T<thr>-a<alpha>.json)
// and prints control/lift/MRR deltas vs baseline with the flip-rule verdict per
// config. Pure reporting over real harness output — no eval logic reimplemented.
//   npx tsx scripts/sweep-report.ts
import { readFileSync, readdirSync } from "node:fs";

const DIR = "scripts/.eval-out";
const r = (x: number): string => Number(x).toFixed(4);
const sd = (x: number): string => (x >= 0 ? "+" : "") + x.toFixed(4);

interface Harness {
  partitions: { control?: { recall_at_3: number }; lift?: { recall_at_3: number } };
  overall: { mrr: number };
}

const base = JSON.parse(readFileSync(`${DIR}/base-ship.json`, "utf8")) as Harness;
const bC = base.partitions.control!.recall_at_3;
const bL = base.partitions.lift!.recall_at_3;
const bM = base.overall.mrr;

console.log(`BASELINE (OFF): control_r@3=${r(bC)}  lift_r@3=${r(bL)}  overall_MRR=${r(bM)}\n`);
console.log("  T       alpha  control_r@3 (Δ)        lift_r@3 (Δ)         MRR (Δ)             flip-rule");

const rows = readdirSync(DIR)
  .filter((f) => /^sweep-T[\d.]+-a[\d.]+\.json$/.test(f))
  .map((f) => {
    const m = f.match(/sweep-T([\d.]+)-a([\d.]+)\.json/)!;
    const T = Number(m[1]);
    const A = Number(m[2]);
    try {
      const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as Harness;
      return { T, A, c: j.partitions.control?.recall_at_3 ?? NaN, l: j.partitions.lift?.recall_at_3 ?? NaN, mm: j.overall.mrr };
    } catch {
      return { T, A, c: NaN, l: NaN, mm: NaN, err: true as const };
    }
  })
  .sort((a, b) => a.T - b.T || a.A - b.A);

for (const p of rows) {
  if ("err" in p) {
    console.log(`  ${p.T.toFixed(3)}   ${p.A.toFixed(2)}   <run error>`);
    continue;
  }
  const liftUp = p.l > bL;
  const ctlOk = p.c >= bC;
  const mrrOk = p.mm >= bM;
  const pass = liftUp && ctlOk && mrrOk;
  const fails = [liftUp ? "" : "lift", ctlOk ? "" : "control", mrrOk ? "" : "MRR"].filter(Boolean);
  const verdict = pass ? "PASS ✅" : `FAIL [${fails.join(",")}↓]`;
  console.log(
    `  ${p.T.toFixed(3)}   ${p.A.toFixed(2)}   ${r(p.c)} (${sd(p.c - bC)})   ${r(p.l)} (${sd(p.l - bL)})   ${r(p.mm)} (${sd(p.mm - bM)})   ${verdict}`,
  );
}
