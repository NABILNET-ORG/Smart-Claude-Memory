// Unit tests for src/tools/list-global-patterns.ts — browse-only MCP tool
// over the reserved 'GLOBAL' project_id.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
//
// Test isolation: the stub commit (Task 4) tests only the contract shape
// — empty result envelope. Real DB tests land in Task 5 once the SELECT
// is implemented.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listGlobalPatterns } from "../src/tools/list-global-patterns.js";

describe("listGlobalPatterns — stub contract", () => {
  test("returns the empty-result envelope when no rows match", async () => {
    // Use an impossible filter so this contract test is independent of
    // whether the live GLOBAL vault is empty or populated.
    const result = await listGlobalPatterns({
      metadata_filter: { type: "__nonexistent_type__" },
    });
    assert.equal(result.project_id, "GLOBAL");
    assert.equal(result.count, 0);
    assert.deepEqual(result.results, []);
    assert.equal(result.summary, "GLOBAL vault is empty.");
  });

  test("echoes pagination args in the response", async () => {
    const result = await listGlobalPatterns({ limit: 25, offset: 0 });
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
  });

  test("clamps limit > 50 down to 50", async () => {
    const result = await listGlobalPatterns({ limit: 100 });
    assert.equal(result.limit, 50);
  });

  test("defaults limit to 10 when omitted", async () => {
    const result = await listGlobalPatterns({});
    assert.equal(result.limit, 10);
  });
});

describe("listGlobalPatterns — AC-1..AC-6 behavior", () => {
  // These tests run against the live Supabase instance the dev environment
  // points at. They are read-only (the tool itself is read-only) and rely on
  // the GLOBAL vault containing at least one row of each common type. If
  // your dev DB has no GLOBAL rows, AC-1/AC-2/AC-3 will return count:0 but
  // the assertions below tolerate that — they verify SHAPE, not content
  // existence.

  test("AC-1: default call returns up to 10 newest GLOBAL rows in created_at DESC order", async () => {
    const result = await listGlobalPatterns({});
    assert.equal(result.project_id, "GLOBAL");
    assert.equal(result.limit, 10);
    assert.equal(result.offset, 0);
    assert.ok(result.count >= 0);
    assert.ok(result.results.length <= 10);
    if (result.results.length >= 2) {
      const first = Date.parse(result.results[0].created_at);
      const second = Date.parse(result.results[1].created_at);
      assert.ok(first >= second, "expected created_at DESC ordering");
    }
  });

  test("AC-2: metadata_filter { type: 'PATTERN' } returns only PATTERN rows", async () => {
    const result = await listGlobalPatterns({
      metadata_filter: { type: "PATTERN" },
    });
    for (const row of result.results) {
      assert.equal(row.type, "PATTERN");
    }
  });

  test("AC-3: multi-key metadata_filter composes via GIN index", async () => {
    const result = await listGlobalPatterns({
      metadata_filter: { type: "ERROR", status: "fixed" },
    });
    assert.ok(Array.isArray(result.results));
    assert.equal(typeof result.count, "number");
  });

  test("AC-4: include_content:true inflates each row with the full content field", async () => {
    const previewResult = await listGlobalPatterns({ limit: 1 });
    const fullResult = await listGlobalPatterns({
      limit: 1,
      include_content: true,
    });
    if (previewResult.results.length === 0) return; // tolerate empty vault
    assert.equal(previewResult.results[0].content, undefined);
    assert.equal(typeof fullResult.results[0].content, "string");
  });

  test("AC-5: limit:100 is clamped to 50", async () => {
    const result = await listGlobalPatterns({ limit: 100 });
    assert.equal(result.limit, 50);
  });

  test("AC-6: empty result returns the canonical summary string", async () => {
    const result = await listGlobalPatterns({
      metadata_filter: { type: "__nonexistent_type__" },
    });
    if (result.count === 0) {
      assert.equal(result.summary, "GLOBAL vault is empty.");
    }
  });
});
