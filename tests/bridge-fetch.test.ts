import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVector, cosineSim, rowToMatch } from "../src/supabase.js";

describe("parseVector", () => {
  it("parses arrays and pgvector strings, tolerates garbage", () => {
    assert.deepEqual(parseVector([1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(parseVector("[1,2,3]"), [1, 2, 3]);
    assert.deepEqual(parseVector(null), []);
    assert.deepEqual(parseVector("not-json"), []);
  });
});

describe("cosineSim", () => {
  it("is 1 for identical, 0 for orthogonal or empty", () => {
    assert.equal(cosineSim([1, 0], [1, 0]), 1);
    assert.equal(cosineSim([1, 0], [0, 1]), 0);
    assert.equal(cosineSim([], [1, 2]), 0);
  });
});

describe("rowToMatch", () => {
  it("maps a memory_chunks row to MatchRow with cosine vs query", () => {
    const row = { id: 5, content: "x", file_origin: "f", chunk_index: 2, metadata: { a: 1 }, embedding: "[1,0]" };
    const m = rowToMatch(row as never, [1, 0]);
    assert.equal(m.id, 5);
    assert.equal(m.content, "x");
    assert.equal(m.file_origin, "f");
    assert.equal(m.chunk_index, 2);
    assert.deepEqual(m.metadata, { a: 1 });
    assert.equal(m.similarity, 1);
  });
});
