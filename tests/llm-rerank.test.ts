import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MatchRow } from "../src/supabase.js";
import {
  buildRerankPrompt,
  parseAndHealRanking,
  llmRerank,
} from "../src/tools/llm-rerank.js";

// SCM-S54 — LLM listwise reranker. Pure parse/heal + prompt builder are tested
// directly; llmRerank is tested with a MOCKED chat() so no Ollama is required.

const row = (id: number, similarity: number, content = `content-${id}`): MatchRow => ({
  id,
  content,
  file_origin: "f",
  chunk_index: 0,
  metadata: {},
  similarity,
});

// A deterministic candidate pool in vector (similarity-desc) order.
const pool = (n: number): MatchRow[] =>
  Array.from({ length: n }, (_, i) => row(100 + i, 1 - i * 0.01));

describe("parseAndHealRanking", () => {
  it("accepts a perfect permutation unchanged (parsedOk, not healed)", () => {
    const r = parseAndHealRanking('{"ranking":[3,1,2]}', 3);
    assert.deepEqual(r.order, [3, 1, 2]);
    assert.equal(r.parsedOk, true);
    assert.equal(r.healed, false);
  });

  it("appends MISSING indices in ascending original order (preserves vector order for unranked)", () => {
    // model returned only 3 and 1; 2,4,5 are missing → appended ascending.
    const r = parseAndHealRanking('{"ranking":[3,1]}', 5);
    assert.deepEqual(r.order, [3, 1, 2, 4, 5]);
    assert.equal(r.parsedOk, true);
    assert.equal(r.healed, true);
  });

  it("dedups repeated indices (first wins)", () => {
    const r = parseAndHealRanking('{"ranking":[2,2,1,3,1]}', 3);
    assert.deepEqual(r.order, [2, 1, 3]);
    assert.equal(r.healed, true);
  });

  it("drops out-of-range and hallucinated indices then heals the gap", () => {
    // 0 (too low), 9 (too high), 3.5 ignored as non-int; valid set {1,2,3}.
    const r = parseAndHealRanking('{"ranking":[9,2,0,3]}', 3);
    assert.deepEqual(r.order, [2, 3, 1]);
    assert.equal(r.healed, true);
  });

  it("extracts JSON wrapped in markdown code fences", () => {
    const raw = "```json\n{\"ranking\": [2, 1, 3]}\n```";
    const r = parseAndHealRanking(raw, 3);
    assert.deepEqual(r.order, [2, 1, 3]);
    assert.equal(r.parsedOk, true);
  });

  it("extracts a bare JSON array with surrounding prose", () => {
    const r = parseAndHealRanking("Here is the ranking: [3, 2, 1] — best first.", 3);
    assert.deepEqual(r.order, [3, 2, 1]);
    assert.equal(r.parsedOk, true);
  });

  it("total garbage ⇒ parsedOk=false and identity order", () => {
    const r = parseAndHealRanking("the cat sat on the mat", 4);
    assert.deepEqual(r.order, [1, 2, 3, 4]);
    assert.equal(r.parsedOk, false);
    assert.equal(r.healed, false);
  });

  it("empty input ⇒ parsedOk=false and empty identity", () => {
    const r = parseAndHealRanking("", 0);
    assert.deepEqual(r.order, []);
    assert.equal(r.parsedOk, false);
  });
});

describe("buildRerankPrompt", () => {
  it("numbers candidates 1..N in a single user message", () => {
    const cands = pool(3);
    const msgs = buildRerankPrompt("my query", cands);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
    const body = msgs[0].content;
    assert.match(body, /\[1\]/);
    assert.match(body, /\[2\]/);
    assert.match(body, /\[3\]/);
    assert.ok(!body.includes("[4]"), "must not number past N");
    assert.match(body, /my query/);
  });

  it("truncates each snippet to snippetChars", () => {
    const long = "x".repeat(1000);
    const msgs = buildRerankPrompt("q", [row(1, 0.5, long)], 50);
    const body = msgs[0].content;
    // The 1000-char content must not appear verbatim; truncated to 50.
    assert.ok(!body.includes(long), "full content must be truncated");
    assert.ok(body.includes("x".repeat(50)), "first 50 chars retained");
    assert.ok(!body.includes("x".repeat(51)), "no more than snippetChars retained");
  });
});

describe("llmRerank", () => {
  it("reorders candidates per the model permutation (outcome ok)", async () => {
    const cands = pool(3); // ids 100,101,102
    const chat = async () => '{"ranking":[3,1,2]}';
    // pinTop1:false isolates the pure-permutation behavior (the non-demoting
    // pin is exercised in its own describe block below).
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000, pinTop1: false });
    assert.deepEqual(res.ranked.map((c) => c.id), [102, 100, 101]);
    assert.equal(res.outcome, "ok");
    assert.equal(res.firedModel, "m");
    assert.ok(res.latencyMs >= 0);
  });

  it("reports outcome 'healed' when the model omits indices", async () => {
    const cands = pool(4);
    const chat = async () => '{"ranking":[2,1]}';
    // pinTop1:false isolates the heal behavior from the top-1 pin.
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000, pinTop1: false });
    assert.deepEqual(res.ranked.map((c) => c.id), [101, 100, 102, 103]);
    assert.equal(res.outcome, "healed");
    assert.equal(res.ranked.length, cands.length);
  });

  it("reports outcome 'parse_fail' and returns ORIGINAL order on garbage", async () => {
    const cands = pool(3);
    const chat = async () => "not json at all";
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000 });
    assert.deepEqual(res.ranked.map((c) => c.id), cands.map((c) => c.id));
    assert.equal(res.outcome, "parse_fail");
  });

  it("mock timeout ⇒ outcome 'timeout' + ORIGINAL order (never throws)", async () => {
    const cands = pool(3);
    // chat never resolves before the timeout fires.
    const chat = () => new Promise<string>(() => {});
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 20 });
    assert.equal(res.outcome, "timeout");
    assert.deepEqual(res.ranked.map((c) => c.id), cands.map((c) => c.id));
  });

  it("mock throw ⇒ outcome 'error' + ORIGINAL order (never throws)", async () => {
    const cands = pool(3);
    const chat = async () => {
      throw new Error("boom");
    };
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000 });
    assert.equal(res.outcome, "error");
    assert.deepEqual(res.ranked.map((c) => c.id), cands.map((c) => c.id));
  });

  it("never-drop invariant: output length === input length and same id set", async () => {
    const cands = pool(6);
    // model hallucinates wildly: out-of-range, dupes, missing.
    const chat = async () => '{"ranking":[99,2,2,4,-1,1]}';
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000 });
    assert.equal(res.ranked.length, cands.length);
    assert.deepEqual(
      new Set(res.ranked.map((c) => c.id)),
      new Set(cands.map((c) => c.id)),
    );
  });

  it("empty candidate list ⇒ empty result, no chat call, outcome ok", async () => {
    let called = false;
    const chat = async () => {
      called = true;
      return "[]";
    };
    const res = await llmRerank("q", [], { chat, model: "m", timeoutMs: 1000 });
    assert.deepEqual(res.ranked, []);
    assert.equal(called, false, "must not call chat on empty input");
    assert.equal(res.outcome, "ok");
  });
});

// SCM-S54 non-demoting top-1 pin (ports the SCM-S53 graph-rerank anchor): the
// MAX-vector-similarity candidate is re-pinned to rank 1 AFTER the LLM reorder,
// so the reranker may reorder ranks 2+ but can never demote the strongest
// semantic anchor. pinTop1 defaults TRUE; pinTop1:false yields pure LLM order.
describe("llmRerank pinTop1 (non-demoting top-1 anchor)", () => {
  it("(a) re-pins a demoted max-sim candidate to rank 1 (LLM ranked it last)", async () => {
    const cands = pool(3); // ids 100(sim 1.00),101(0.99),102(0.98) — 100 is max-sim
    // LLM demotes the max-sim anchor (index 1) to the very end: order [2,3,1].
    const chat = async () => '{"ranking":[2,3,1]}';
    const res = await llmRerank("q", cands, {
      chat,
      model: "m",
      timeoutMs: 1000,
      pinTop1: true,
    });
    // Pin forces id 100 back to rank 1; LLM's relative order for the rest
    // (101 before 102) is preserved.
    assert.deepEqual(res.ranked.map((c) => c.id), [100, 101, 102]);
    // Outcome reflects the LLM parse (a full clean perm ⇒ "ok"), not the pin.
    assert.equal(res.outcome, "ok");
  });

  it("(b) pinTop1:false ⇒ pure LLM order, no pin", async () => {
    const cands = pool(3); // 100 is max-sim
    const chat = async () => '{"ranking":[2,3,1]}';
    const res = await llmRerank("q", cands, {
      chat,
      model: "m",
      timeoutMs: 1000,
      pinTop1: false,
    });
    // No pin: the LLM's demotion of 100 to last stands.
    assert.deepEqual(res.ranked.map((c) => c.id), [101, 102, 100]);
  });

  it("(c) no-op when the LLM already placed max-sim first", async () => {
    const cands = pool(3); // 100 is max-sim
    // LLM keeps 100 (index 1) at rank 1, reorders the tail.
    const chat = async () => '{"ranking":[1,3,2]}';
    const res = await llmRerank("q", cands, {
      chat,
      model: "m",
      timeoutMs: 1000,
      pinTop1: true,
    });
    // Identical to the pure LLM order — the pin changed nothing.
    assert.deepEqual(res.ranked.map((c) => c.id), [100, 102, 101]);
  });

  it("(d) output stays a permutation (length + id set) with pin on", async () => {
    const cands = pool(6);
    // Hallucinated array: out-of-range, dupes, missing — heal + pin together.
    const chat = async () => '{"ranking":[99,3,3,5,-1,2]}';
    const res = await llmRerank("q", cands, {
      chat,
      model: "m",
      timeoutMs: 1000,
      pinTop1: true,
    });
    assert.equal(res.ranked.length, cands.length);
    assert.deepEqual(
      new Set(res.ranked.map((c) => c.id)),
      new Set(cands.map((c) => c.id)),
    );
    // The max-sim anchor (id 100) must be rank 1 regardless of the LLM mess.
    assert.equal(res.ranked[0].id, 100);
  });

  it("(e) pins by MAX similarity, not position (unsorted input)", async () => {
    // Deliberately UNSORTED: candidates[0] is NOT the highest similarity.
    // id 200 sim 0.40, id 201 sim 0.95 (TRUE max), id 202 sim 0.60.
    const cands: MatchRow[] = [row(200, 0.4), row(201, 0.95), row(202, 0.6)];
    // LLM ranks the true max-sim (index 2) LAST: order [1,3,2].
    const chat = async () => '{"ranking":[1,3,2]}';
    const res = await llmRerank("q", cands, {
      chat,
      model: "m",
      timeoutMs: 1000,
      pinTop1: true,
    });
    // Pin selects id 201 (max sim), NOT candidates[0] (id 200); rest keep LLM
    // relative order (200 before 202).
    assert.equal(res.ranked[0].id, 201, "max-similarity candidate pinned, not index 0");
    assert.deepEqual(res.ranked.map((c) => c.id), [201, 200, 202]);
  });

  it("(f) pinTop1 defaults TRUE when the opt is omitted", async () => {
    const cands = pool(3); // 100 is max-sim
    const chat = async () => '{"ranking":[2,3,1]}'; // demotes 100 to last
    // No pinTop1 passed → default TRUE → 100 re-pinned to rank 1.
    const res = await llmRerank("q", cands, { chat, model: "m", timeoutMs: 1000 });
    assert.equal(res.ranked[0].id, 100, "default pin must anchor max-sim at rank 1");
  });
});
