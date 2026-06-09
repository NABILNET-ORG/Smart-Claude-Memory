// scripts/bakeoff-llm-rerank.ts — SCM-S54 LLM listwise reranker bake-off.
//
// Mirrors scripts/eval-graph-rerank.ts but calls llmRerank() DIRECTLY (instead
// of going through searchMemory) so it can capture per-call telemetry — outcome,
// latency, fired/skipped — that the tool surface swallows. It applies the SAME
// flat-margin gate searchMemory uses (fire only when vTop1 - vTop2 <
// SCM_GRAPH_MARGIN_THRESHOLD) so the measured numbers reflect production wiring.
//
// The model under test is chosen by SCM_RERANK_MODEL (falls back to
// OLLAMA_CHAT_MODEL). Run once per candidate model and diff the BAKEOFF_RESULT
// lines to pick the winner; that choice is then encoded as the SCM_RERANK_MODEL
// default in its own PR:
//
//   SCM_EVAL_FIXTURE=docs/.../fixture.json SCM_RERANK_MODEL=qwen3-coder:480b-cloud \
//     npx tsx scripts/bakeoff-llm-rerank.ts
//
// Vector-only baseline (no rerank) is the eval-graph-rerank.ts run with both
// flags off; this script reports the rerank candidate.
//
// ─── DRIFT CONTROL (SCM-S54): freeze → replay ────────────────────────────────
// The live corpus mutates between runs (proven: llm_fired drifted 40→42), which
// confounds cross-run rerank comparison. To measure rerank QUALITY independent
// of DB drift, split the bake-off into two env-selected phases against ONE frozen
// snapshot:
//
//   (1) FREEZE-OUT — `SCM_BAKEOFF_FREEZE_OUT=<path>`: embed + searchChunks once
//       per query, write the full candidate slates to <path>, then EXIT (no LLM).
//   (2) FREEZE-IN  — `SCM_BAKEOFF_FREEZE_IN=<path>`: load that snapshot (no DB at
//       all), apply the SAME flat-margin gate, fire ONE chat() per low-confidence
//       query, and from that SINGLE response derive THREE orderings —
//       vector / llm_nopin / llm_pin — scored side by side.
//
// When NEITHER env is set the original live behavior below is UNCHANGED.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { embed, chat } from "../src/ollama.js";
import { searchChunks, type MatchRow } from "../src/supabase.js";
import {
  llmRerank,
  buildRerankPrompt,
  parseAndHealRanking,
  pinMaxSimilarity,
  type RerankOutcome,
} from "../src/tools/llm-rerank.js";
import { recallAtK, mrr } from "../src/tools/metrics.js";
import { config } from "../src/config.js";

interface EvalCase {
  query: string;
  gold_chunk_id: number;
  project_id: string;
  partition?: string; // "control" | "lift" | "capability"; absent → "all"
}

/** One frozen query: the curated case plus the EXACT vector recall captured at
 *  freeze-out time. Replaying against this fixed `candidates` slate removes the
 *  live-DB drift that confounds cross-run rerank comparison. */
interface FrozenCase extends EvalCase {
  candidates: MatchRow[];
}

const FIXTURE = process.env.SCM_EVAL_FIXTURE ?? "docs/superpowers/specs/s16-d1-eval-queries.json";

interface PartAcc {
  r3: number;
  m: number;
  n: number;
}

/** Per-condition accumulator: overall + per-partition recall@3/MRR tallies. */
interface ConditionAcc {
  r3: number;
  m: number;
  groups: Map<string, PartAcc>;
}

function newConditionAcc(): ConditionAcc {
  return { r3: 0, m: 0, groups: new Map() };
}

/** Score one ordering for one case into a condition accumulator. */
function tallyCondition(
  acc: ConditionAcc,
  rankedIds: number[],
  goldId: number,
  partition: string,
): void {
  const hit3 = recallAtK(rankedIds, goldId, 3);
  const rr = mrr(rankedIds, goldId);
  acc.r3 += hit3;
  acc.m += rr;
  const g = acc.groups.get(partition) ?? { r3: 0, m: 0, n: 0 };
  g.r3 += hit3;
  g.m += rr;
  g.n += 1;
  acc.groups.set(partition, g);
}

/** Project a condition accumulator into the BAKEOFF_RESULT condition shape. */
function summarizeCondition(
  acc: ConditionAcc,
  total: number,
): {
  overall: { recall_at_3: number; mrr: number };
  partitions: Record<string, { n: number; recall_at_3: number; mrr: number }>;
} {
  const partitions: Record<string, { n: number; recall_at_3: number; mrr: number }> = {};
  for (const [part, g] of [...acc.groups.entries()].sort()) {
    partitions[part] = {
      n: g.n,
      recall_at_3: Number((g.r3 / g.n).toFixed(4)),
      mrr: Number((g.m / g.n).toFixed(4)),
    };
  }
  return {
    overall: {
      recall_at_3: Number((total ? acc.r3 / total : 0).toFixed(4)),
      mrr: Number((total ? acc.m / total : 0).toFixed(4)),
    },
    partitions,
  };
}

function resolveModel(): string {
  return config.SCM_RERANK_MODEL || process.env.OLLAMA_CHAT_MODEL || "qwen3-coder:480b-cloud";
}

function resolvePool(): number {
  return Math.max(10, config.SCM_LLM_RERANK_POOL);
}

/**
 * FREEZE-OUT phase. Embed + searchChunks ONCE per fixture query and persist the
 * full candidate slates (incl. id, content, similarity) to `outPath` as a JSON
 * array. No LLM, no rerank — this is the immutable recall snapshot every
 * freeze-in replay scores against. Exits after writing.
 */
async function runFreezeOut(cases: EvalCase[], outPath: string): Promise<void> {
  const pool = resolvePool();
  const frozen: FrozenCase[] = [];
  for (const c of cases) {
    const [queryVec] = await embed([c.query]);
    // Same recall path searchMemory + live mode use (dual-scope default on).
    const candidates = await searchChunks(c.project_id, queryVec, pool, 0.0, null, true);
    frozen.push({
      query: c.query,
      gold_chunk_id: c.gold_chunk_id,
      project_id: c.project_id,
      partition: c.partition,
      candidates,
    });
  }
  writeFileSync(outPath, JSON.stringify(frozen, null, 2), "utf8");
  const totalCands = frozen.reduce((n, f) => n + f.candidates.length, 0);
  console.log(
    `[bakeoff:freeze-out] wrote ${frozen.length} queries (${totalCands} candidates, pool=${pool}) → ${outPath}`,
  );
}

/**
 * FREEZE-IN phase. Load the frozen snapshot (NO live DB access — no embed, no
 * searchChunks) and replay every rerank condition against the identical slates.
 *
 * Per query, apply the SAME flat-margin gate as production/live mode
 * (lowConfidence = top1 - top2 < SCM_GRAPH_MARGIN_THRESHOLD; guard <2
 * candidates). When fired, make exactly ONE chat() call — mirroring how
 * llmRerank invokes chat — then heal the permutation. From that SINGLE response
 * derive THREE orderings scored side by side:
 *   • vector    = frozen candidate order (no rerank)
 *   • llm_nopin = candidates reordered by the healed order (pin OFF)
 *   • llm_pin   = pinMaxSimilarity(llm_nopin ordering) (pin ON)
 * When NOT fired (peaked), all three equal the frozen order.
 *
 * Never throws: a chat() rejection / timeout maps to the safe vector floor for
 * all three conditions, exactly like llmRerank's invariant.
 */
async function runFreezeIn(frozenPath: string): Promise<void> {
  const frozen: FrozenCase[] = JSON.parse(readFileSync(frozenPath, "utf8"));
  if (!frozen.length) {
    console.log(`[bakeoff:freeze-in] ${frozenPath} is empty — run freeze-out first.`);
    return;
  }
  const verbose = process.env.EVAL_VERBOSE === "1" || process.env.EVAL_VERBOSE === "true";
  const model = resolveModel();
  const marginThreshold = config.SCM_GRAPH_MARGIN_THRESHOLD;
  const timeoutMs = config.SCM_LLM_RERANK_TIMEOUT_MS;
  const snippetChars = config.SCM_LLM_RERANK_SNIPPET;

  const vectorAcc = newConditionAcc();
  const nopinAcc = newConditionAcc();
  const pinAcc = newConditionAcc();

  let fired = 0;
  let parseFail = 0; // parse_fail + error + timeout → "judge produced nothing usable"
  let latencySum = 0;
  const outcomeHist: Record<string, number> = {};

  for (const c of frozen) {
    const candidates = c.candidates;
    const partition = c.partition ?? "all";

    // Same flat-margin gate as searchMemory/live mode: fire ONLY on a
    // low-confidence (flat) neighborhood. Guard <2 candidates (no margin).
    const vTop1 = candidates[0]?.similarity ?? 0;
    const vTop2 = candidates[1]?.similarity ?? 0;
    const lowConfidence = vTop1 - vTop2 < marginThreshold;

    // All three orderings default to the frozen vector order (the peaked case).
    const vectorOrder = candidates;
    let nopinOrder = candidates;
    let pinOrder = candidates;
    let outcome: RerankOutcome | "skipped_peaked" = "skipped_peaked";

    if (lowConfidence && candidates.length > 1) {
      fired += 1;
      const messages = buildRerankPrompt(c.query, candidates, snippetChars);
      const t0 = Date.now();
      // Mirror llmRerank's chat() invocation exactly: rerank model, temperature
      // 0, JSON format, configured timeout. ONE call drives all three conditions.
      let raw: string | null = null;
      try {
        raw = await chat(messages, {
          model,
          temperature: 0,
          format: "json",
          timeoutMs,
        });
      } catch {
        raw = null;
      }
      const latencyMs = Date.now() - t0;
      latencySum += latencyMs;

      if (raw === null) {
        // chat() rejected (network/error/timeout) → safe vector floor for all
        // conditions, exactly like llmRerank's invariant. Classify as error.
        outcome = "error";
        parseFail += 1;
      } else {
        const parsed = parseAndHealRanking(raw, candidates.length);
        if (!parsed.parsedOk) {
          outcome = "parse_fail";
          parseFail += 1;
          // No usable permutation → all conditions stay at the frozen order.
        } else {
          outcome = parsed.healed ? "healed" : "ok";
          // Reorder candidates by the healed permutation (pin OFF), then the
          // pinned variant on top of that SAME ordering (pin ON).
          nopinOrder = parsed.order.map((pos) => candidates[pos - 1]);
          pinOrder = pinMaxSimilarity(nopinOrder);
        }
      }
    }

    outcomeHist[outcome] = (outcomeHist[outcome] ?? 0) + 1;

    const vectorIds = vectorOrder.map((x) => x.id);
    const nopinIds = nopinOrder.map((x) => x.id);
    const pinIds = pinOrder.map((x) => x.id);
    tallyCondition(vectorAcc, vectorIds, c.gold_chunk_id, partition);
    tallyCondition(nopinAcc, nopinIds, c.gold_chunk_id, partition);
    tallyCondition(pinAcc, pinIds, c.gold_chunk_id, partition);

    if (verbose) {
      const r = (ids: number[]): string => {
        const i = ids.indexOf(c.gold_chunk_id);
        return i === -1 ? ">pool" : String(i + 1);
      };
      console.log(
        `[q] part=${partition}\toutcome=${outcome}` +
          `\tvec=${r(vectorIds)}\tnopin=${r(nopinIds)}\tpin=${r(pinIds)}` +
          `\tgold=${c.gold_chunk_id}\t:: ${c.query.slice(0, 56)}`,
      );
    }
  }

  const total = frozen.length;
  const result = {
    rerank: "llm_listwise" as const,
    model,
    fixture: FIXTURE,
    frozen_in: frozenPath,
    cases: total,
    margin_threshold: marginThreshold,
    llm_fired: fired,
    parse_fail_rate: Number((fired ? parseFail / fired : 0).toFixed(4)),
    avg_latency_ms: Number((fired ? latencySum / fired : 0).toFixed(1)),
    outcome_histogram: outcomeHist,
    conditions: {
      vector: summarizeCondition(vectorAcc, total),
      llm_nopin: summarizeCondition(nopinAcc, total),
      llm_pin: summarizeCondition(pinAcc, total),
    },
  };

  console.log(JSON.stringify(result, null, 2));
  // Machine-parseable single line for diffing/CI capture.
  console.log(`BAKEOFF_RESULT=${JSON.stringify(result)}`);
}

async function runLive(): Promise<void> {
  const cases: EvalCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (!cases.length) {
    console.log(`[bakeoff] ${FIXTURE} is empty — curate queries whose gold chunk currently ranks > 3.`);
    return;
  }
  const verbose = process.env.EVAL_VERBOSE === "1" || process.env.EVAL_VERBOSE === "true";
  const model = config.SCM_RERANK_MODEL || process.env.OLLAMA_CHAT_MODEL || "qwen3-coder:480b-cloud";
  const pool = Math.max(10, config.SCM_LLM_RERANK_POOL);

  let r3 = 0;
  let m = 0;
  let fired = 0;
  let parseFail = 0; // parse_fail + error (the "judge produced nothing usable" rate)
  let latencySum = 0;
  const outcomeHist: Record<string, number> = {};
  const groups = new Map<string, PartAcc>();
  const bump = (part: string, hit3: number, rr: number): void => {
    const g = groups.get(part) ?? { r3: 0, m: 0, n: 0 };
    g.r3 += hit3;
    g.m += rr;
    g.n += 1;
    groups.set(part, g);
  };

  for (const c of cases) {
    const [queryVec] = await embed([c.query]);
    // Same recall path searchMemory uses (dual-scope default on).
    const candidates = await searchChunks(c.project_id, queryVec, pool, 0.0, null, true);

    // Same flat-margin gate as searchMemory: fire ONLY on a low-confidence
    // (flat) vector neighborhood; a peaked neighborhood keeps pure vector.
    const vTop1 = candidates[0]?.similarity ?? 0;
    const vTop2 = candidates[1]?.similarity ?? 0;
    const lowConfidence = vTop1 - vTop2 < config.SCM_GRAPH_MARGIN_THRESHOLD;

    let rankedIds: number[];
    let outcome: RerankOutcome | "skipped_peaked";
    if (lowConfidence && candidates.length > 1) {
      const out = await llmRerank(c.query, candidates, {
        chat,
        model,
        snippetChars: config.SCM_LLM_RERANK_SNIPPET,
        timeoutMs: config.SCM_LLM_RERANK_TIMEOUT_MS,
        pinTop1: config.SCM_LLM_RERANK_PIN_TOP1,
      });
      rankedIds = out.ranked.map((x) => x.id);
      outcome = out.outcome;
      fired += 1;
      latencySum += out.latencyMs;
      if (out.outcome === "parse_fail" || out.outcome === "error") parseFail += 1;
    } else {
      rankedIds = candidates.map((x) => x.id);
      outcome = "skipped_peaked";
    }
    outcomeHist[outcome] = (outcomeHist[outcome] ?? 0) + 1;

    const hit3 = recallAtK(rankedIds, c.gold_chunk_id, 3);
    const rr = mrr(rankedIds, c.gold_chunk_id);
    r3 += hit3;
    m += rr;
    bump(c.partition ?? "all", hit3, rr);

    if (verbose) {
      const idx = rankedIds.indexOf(c.gold_chunk_id);
      console.log(
        `[q] part=${c.partition ?? "all"}\toutcome=${outcome}\trank=${idx === -1 ? ">pool" : idx + 1}` +
          `\ttop3=${hit3}\trr=${rr.toFixed(3)}\tgold=${c.gold_chunk_id}\t:: ${c.query.slice(0, 56)}`,
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

  const result = {
    rerank: "llm_listwise" as const,
    model,
    fixture: FIXTURE,
    cases: cases.length,
    pool,
    margin_threshold: config.SCM_GRAPH_MARGIN_THRESHOLD,
    overall: {
      recall_at_3: Number((r3 / cases.length).toFixed(4)),
      mrr: Number((m / cases.length).toFixed(4)),
    },
    partitions,
    llm_fired: fired,
    parse_fail_rate: Number((fired ? parseFail / fired : 0).toFixed(4)),
    avg_latency_ms: Number((fired ? latencySum / fired : 0).toFixed(1)),
    outcome_histogram: outcomeHist,
  };

  console.log(JSON.stringify(result, null, 2));
  // Machine-parseable single line for diffing/CI capture.
  console.log(`BAKEOFF_RESULT=${JSON.stringify(result)}`);
}

/**
 * Mode dispatcher. Env selects the phase; if NEITHER freeze env is set the
 * original live behavior runs UNCHANGED:
 *   • SCM_BAKEOFF_FREEZE_OUT=<path> → freeze-out (snapshot recall, exit, no LLM)
 *   • SCM_BAKEOFF_FREEZE_IN=<path>  → freeze-in  (replay rerank, no live DB)
 *   • neither                       → live (embed + searchChunks + llmRerank)
 * Freeze-out wins if both are set (you must capture before you can replay).
 */
async function main(): Promise<void> {
  const freezeOut = process.env.SCM_BAKEOFF_FREEZE_OUT;
  const freezeIn = process.env.SCM_BAKEOFF_FREEZE_IN;
  if (freezeOut) {
    const cases: EvalCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
    if (!cases.length) {
      console.log(`[bakeoff:freeze-out] ${FIXTURE} is empty — curate queries first.`);
      return;
    }
    await runFreezeOut(cases, freezeOut);
    return;
  }
  if (freezeIn) {
    await runFreezeIn(freezeIn);
    return;
  }
  await runLive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
