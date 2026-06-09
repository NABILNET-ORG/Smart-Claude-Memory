// src/tools/llm-rerank.ts — SCM-S54 confidence-gated LLM LISTWISE reranker.
//
// DECISION (SCM-S54-D1): this is the precision layer atop nomic-embed vector
// recall. nomic compresses cosine similarity into a narrow band, so when the
// vector top-1/top-2 margin is FLAT the ordering is effectively a guess. We
// send the top-N candidates to the SERVER's chat() LLM judge and ask for an
// INDEX PERMUTATION (best→worst), then reorder. Listwise (one call, whole
// slate) — not pointwise — so the model reasons about candidates relative to
// each other.
//
// Pure + DI: chat() is injected so the parse/heal/reorder logic is unit-testable
// with zero network. STRICT INVARIANT: this module NEVER throws and NEVER drops
// or duplicates a candidate. On any failure (parse, timeout, error) it returns
// the ORIGINAL candidate order unchanged — the vector ranking is always a safe
// floor.

import type { MatchRow } from "../supabase.js";

/** Mirrors the message shape src/ollama.ts#chat accepts. */
export type RerankChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** The injected chat function. Structurally compatible with src/ollama.ts#chat:
 *  callers pass model/temperature/format/timeoutMs; we only require the JSON
 *  string back. `format` is optional so a mock can ignore it. */
export type RerankChatFn = (
  messages: RerankChatMessage[],
  opts?: {
    model?: string;
    temperature?: number;
    format?: "json" | Record<string, unknown>;
    timeoutMs?: number;
  },
) => Promise<string>;

export type RerankOutcome =
  | "ok"
  | "healed"
  | "parse_fail"
  | "timeout"
  | "error"
  | "budget_block";

export interface LlmRerankResult {
  ranked: MatchRow[];
  outcome: RerankOutcome;
  latencyMs: number;
  firedModel: string;
}

export interface ParsedRanking {
  /** Always a full permutation of 1..n (1-indexed positions into the input). */
  order: number[];
  /** True when the model's array was repaired (deduped / pruned / gap-filled). */
  healed: boolean;
  /** False when no usable JSON array was found (order falls back to identity). */
  parsedOk: boolean;
}

const DEFAULT_SNIPPET_CHARS = 400;

/**
 * Build the listwise rerank prompt. Candidates are numbered [1..N]; each line
 * shows its index and the first `snippetChars` of its content. The model is
 * instructed to return ONLY a JSON object {"ranking":[<permutation>]} ordering
 * the indices best→worst, with no prose. Returns a single-user-message array
 * ready for chat().
 */
export function buildRerankPrompt(
  query: string,
  candidates: MatchRow[],
  snippetChars: number = DEFAULT_SNIPPET_CHARS,
): RerankChatMessage[] {
  const n = candidates.length;
  const lines = candidates.map((c, i) => {
    const snippet = c.content.slice(0, snippetChars).replace(/\s+/g, " ").trim();
    return `[${i + 1}] ${snippet}`;
  });
  const body = [
    "You are a precise search-result re-ranker.",
    `Given a query and ${n} candidate snippets, order the candidates by how well`,
    "each answers the query, from BEST to WORST.",
    "",
    `QUERY: ${query}`,
    "",
    "CANDIDATES:",
    ...lines,
    "",
    `Respond with ONLY a JSON object of this exact shape (a permutation of the`,
    `integers 1..${n}, best first), and NOTHING else — no prose, no code fences:`,
    `{"ranking": [<index>, <index>, ...]}`,
  ].join("\n");
  return [{ role: "user", content: body }];
}

/** Locate the first JSON array of numbers in arbitrary model output.
 *  Tolerates code fences, surrounding prose, and a wrapping {"ranking":[...]} */
function extractRankingArray(raw: string): number[] | null {
  if (!raw) return null;
  // Strip code fences so a fenced ```json ... ``` block parses cleanly.
  const defenced = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");

  // Preferred: a "ranking": [ ... ] field anywhere in the text.
  const keyed = defenced.match(/"ranking"\s*:\s*\[([^\]]*)\]/i);
  if (keyed) {
    const nums = parseIntList(keyed[1]);
    if (nums.length) return nums;
  }

  // Fallback: the first bracketed list that contains at least one integer.
  const bracket = defenced.match(/\[([^\]]*\d[^\]]*)\]/);
  if (bracket) {
    const nums = parseIntList(bracket[1]);
    if (nums.length) return nums;
  }
  return null;
}

/** Parse a comma/whitespace-separated list, keeping only true integers. */
function parseIntList(inner: string): number[] {
  const out: number[] = [];
  for (const tok of inner.split(/[,\s]+/)) {
    const t = tok.trim();
    if (!t) continue;
    // Reject non-integers (e.g. "3.5") so a float can't masquerade as an index.
    if (!/^-?\d+$/.test(t)) continue;
    out.push(Number.parseInt(t, 10));
  }
  return out;
}

/**
 * Tolerant ranking parser + healer. Returns a FULL permutation of 1..n:
 *   - keep only integers in [1..n]
 *   - dedup (first occurrence wins)
 *   - drop out-of-range / hallucinated / non-integer tokens
 *   - append any MISSING indices in ascending original order (so unranked
 *     candidates retain their incoming vector order)
 * `parsedOk` is false when no usable JSON array was found — then `order` is the
 * identity 1..n and `healed` is false.
 */
export function parseAndHealRanking(raw: string, n: number): ParsedRanking {
  const identity = Array.from({ length: n }, (_, i) => i + 1);
  const arr = extractRankingArray(raw);
  if (arr === null) {
    return { order: identity, healed: false, parsedOk: false };
  }

  const seen = new Set<number>();
  const kept: number[] = [];
  for (const v of arr) {
    if (!Number.isInteger(v)) continue;
    if (v < 1 || v > n) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    kept.push(v);
  }

  // Append missing indices in ascending original order.
  const missing: number[] = [];
  for (let i = 1; i <= n; i++) {
    if (!seen.has(i)) missing.push(i);
  }
  const order = [...kept, ...missing];

  // Healed if the model's usable array wasn't already the full clean perm:
  // i.e. it dropped/duped/omitted something (kept.length !== n) OR a raw token
  // had to be discarded (arr.length !== kept.length).
  const healed = kept.length !== n || arr.length !== kept.length;
  return { order, healed, parsedOk: true };
}

/** Reorder candidates by a 1-indexed permutation. Caller guarantees `order`
 *  is a full permutation of 1..candidates.length (parseAndHealRanking does). */
function applyOrder(candidates: MatchRow[], order: number[]): MatchRow[] {
  return order.map((pos) => candidates[pos - 1]);
}

/**
 * SCM-S54 non-demoting top-1 pin (ports the SCM-S53 graph-rerank anchor). Given
 * an already-ranked list, anchor the MAX-vector-similarity candidate at rank 1
 * and preserve the input's relative order for everything else. The reranker may
 * therefore reorder ranks 2+ to recover recall, but can NEVER demote the
 * strongest semantic anchor out of rank 1.
 *
 * CRITICAL (SCM-S53 lesson): resolve the anchor by MAX similarity, NOT by
 * positional index 0 — positional breaks on unsorted input. In production the
 * vector candidates are similarity-desc so this equals the top-1, but the pin
 * stays correct for any input order.
 *
 * Pure + invariant-safe: returns a permutation of the SAME set with the SAME
 * length, never mutates the input, never throws. No-op when the anchor is
 * already first or the list is empty.
 */
export function pinMaxSimilarity(ranked: MatchRow[]): MatchRow[] {
  if (ranked.length < 2) return ranked;
  let anchorIdx = 0;
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].similarity > ranked[anchorIdx].similarity) anchorIdx = i;
  }
  if (anchorIdx === 0) return ranked; // anchor already rank 1 → no-op
  const anchor = ranked[anchorIdx];
  const rest = ranked.filter((_, i) => i !== anchorIdx);
  return [anchor, ...rest];
}

/**
 * Run the LLM listwise rerank over `candidates`.
 *
 * Measures wall-clock around chat(); calls chat() with the rerank model,
 * temperature 0, and JSON format; enforces `timeoutMs` via Promise.race. Then
 * heals the returned permutation and reorders.
 *
 * STRICT INVARIANT: on parse_fail / timeout / error, returns `ranked` =
 * ORIGINAL candidates unchanged (modulo the top-1 pin). NEVER throws. Output
 * length === input length, same id set (never drops, never duplicates). Empty
 * input short-circuits (no chat call) with outcome 'ok'.
 *
 * SCM-S54 pin: when `pinTop1` is on (undefined ⇒ default TRUE), the MAX-vector-
 * similarity candidate is anchored at rank 1 AFTER the LLM reorder/heal — the
 * reranker may reorder ranks 2+ but can never demote the strongest anchor. The
 * pin is also applied to the safe-floor fallback returns (timeout/error/
 * parse_fail); since those return the original vector order with max-sim already
 * first, the pin is a natural no-op there but still guarantees the rank-1 anchor.
 */
export async function llmRerank(
  query: string,
  candidates: MatchRow[],
  opts: {
    chat: RerankChatFn;
    model: string;
    snippetChars?: number;
    timeoutMs?: number;
    pinTop1?: boolean;
  },
): Promise<LlmRerankResult> {
  const firedModel = opts.model;
  // undefined ⇒ default TRUE (non-demoting pin is the safe default).
  const pinTop1 = opts.pinTop1 !== false;
  const pin = (rows: MatchRow[]): MatchRow[] =>
    pinTop1 ? pinMaxSimilarity(rows) : rows;
  if (candidates.length === 0) {
    return { ranked: [], outcome: "ok", latencyMs: 0, firedModel };
  }

  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const messages = buildRerankPrompt(query, candidates, snippetChars);

  const t0 = Date.now();
  let raw: string;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutSentinel = Symbol("rerank_timeout");
    const result = await Promise.race<string | typeof timeoutSentinel>([
      opts.chat(messages, {
        model: opts.model,
        temperature: 0,
        format: "json",
        timeoutMs,
      }),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(timeoutSentinel);
        }, timeoutMs);
      }),
    ]);
    if (result === timeoutSentinel) {
      return {
        ranked: pin(candidates),
        outcome: "timeout",
        latencyMs: Date.now() - t0,
        firedModel,
      };
    }
    raw = result;
  } catch {
    // §never-silent: any chat() rejection → safe vector floor. The caller logs
    // the outcome; we never surface the raw error (it would break the invariant
    // and could leak provider internals). Cause is observable via outcome.
    return {
      ranked: pin(candidates),
      outcome: "error",
      latencyMs: Date.now() - t0,
      firedModel,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // A late-resolving chat() can still race in after the timeout fired; honor
  // the timeout verdict so the contract (one outcome per call) holds.
  if (timedOut) {
    return {
      ranked: pin(candidates),
      outcome: "timeout",
      latencyMs: Date.now() - t0,
      firedModel,
    };
  }

  const latencyMs = Date.now() - t0;
  const parsed = parseAndHealRanking(raw, candidates.length);
  if (!parsed.parsedOk) {
    return { ranked: pin(candidates), outcome: "parse_fail", latencyMs, firedModel };
  }
  const ranked = pin(applyOrder(candidates, parsed.order));
  return {
    ranked,
    outcome: parsed.healed ? "healed" : "ok",
    latencyMs,
    firedModel,
  };
}
