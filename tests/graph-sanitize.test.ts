import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForExtraction, isGarbageLabel } from "../src/graph/sanitize.js";

describe("sanitizeForExtraction", () => {
  it("strips fenced/mermaid blocks and tables, keeps prose identifiers", () => {
    const input = [
      "See `gate.ts` for budgets.",
      "```mermaid",
      "graph TD; n161 --> n162",
      "```",
      "| col | col |",
      "|-----|-----|",
      "> quoted n999 --> x",
    ].join("\n");
    const out = sanitizeForExtraction(input);
    assert.ok(out.includes("gate.ts"), "keeps real file ref");
    assert.ok(!out.includes("n161"), "drops mermaid node id");
    assert.ok(!out.includes("-->"), "drops mermaid arrows");
    assert.ok(!out.includes("|-----|"), "drops table delimiter");
  });
});

describe("isGarbageLabel", () => {
  it("rejects structural fragments, accepts real entities", () => {
    for (const bad of ["n161", "-->", "s\"]", "TD", "x", "subgraph"]) {
      assert.equal(isGarbageLabel(bad), true, `should reject: ${bad}`);
    }
    for (const ok of ["gate.ts", "search_memory", "SCM-S16-D1", "Knowledge Graph"]) {
      assert.equal(isGarbageLabel(ok), false, `should accept: ${ok}`);
    }
    // Prose that happens to contain quotes/brackets is NOT garbage — primary
    // node labels are whole first-lines and routinely contain them.
    for (const prose of ['He said "hi" about the gate', "see results[0] in search"]) {
      assert.equal(isGarbageLabel(prose), false, `prose, not garbage: ${prose}`);
    }
  });
});
