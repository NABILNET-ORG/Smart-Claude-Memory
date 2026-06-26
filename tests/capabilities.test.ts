// Unit tests for src/tools/setup.ts::buildCapabilities — pure shape
// contract of the init_project capabilities header.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
// No Supabase / Ollama / filesystem access — buildCapabilities is pure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities } from "../src/tools/setup.js";

describe("buildCapabilities — v2.1.0 GLOBAL Vault UX contract", () => {
  test("AC-7: protocol field is 'smart-claude-memory/v2.1.0'", () => {
    const caps = buildCapabilities("any-project");
    assert.equal(caps.protocol, "smart-claude-memory/v2.1.0");
  });

  test("AC-8: global_scope advertises the browse_tool name + browse_args", () => {
    const caps = buildCapabilities("any-project");
    assert.equal(caps.global_scope.available, true);
    assert.equal(caps.global_scope.project_id, "GLOBAL");
    assert.equal(caps.global_scope.browse_tool, "list_global_patterns");
    assert.deepEqual(caps.global_scope.browse_args, [
      "metadata_filter",
      "limit",
      "offset",
      "include_content",
    ]);
  });

  test("AC-9: context_gathering_hints contains the canonical GLOBAL-browse exemplar", () => {
    const caps = buildCapabilities("any-project");
    const expected =
      "Browse GLOBAL: list_global_patterns({ metadata_filter: { type: 'PATTERN' }, limit: 10 })";
    assert.ok(
      caps.context_gathering_hints.includes(expected),
      `expected hints to include exactly: ${expected}`,
    );
  });

  test("project_id slug is echoed verbatim into capabilities.project_id", () => {
    const caps = buildCapabilities("my-cool-project");
    assert.equal(caps.project_id, "my-cool-project");
  });

  test("taxonomy is the four Sovereign types in canonical order", () => {
    const caps = buildCapabilities("x");
    assert.deepEqual(caps.taxonomy, ["DECISION", "PATTERN", "ERROR", "LOG"]);
  });
});
