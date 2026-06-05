import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptWeights } from "../src/tools/bridge.js";

const seeds = [
  { id: 1, type: "NOTE", label: "a", properties: {}, source_chunk_id: 10, similarity: 0.9 },
  { id: 2, type: "NOTE", label: "b", properties: {}, source_chunk_id: 20, similarity: 0.6 },
];
const neighbors = [
  { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
  { id: 100, type: "SYMBOL", label: "search_memory", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 2 },
  { id: 200, type: "FILE", label: "gate.ts", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 1 },
];

describe("conceptWeights", () => {
  it("sums seed_sim × edge_weight per concept across seeds", () => {
    const W = conceptWeights(seeds as never, neighbors as never);
    assert.equal(W.get(100), 0.9 + 0.6); // mentioned by both seeds
    assert.equal(W.get(200), 0.9); // only seed 1
  });

  it("ignores neighbors whose via_node_id is not a known seed", () => {
    const W = conceptWeights(seeds as never, [
      { id: 300, type: "FILE", label: "x.ts", properties: {}, relation: "MENTIONS", weight: 1, direction: "outgoing", via_node_id: 999 },
    ] as never);
    assert.equal(W.has(300), false);
  });
});
