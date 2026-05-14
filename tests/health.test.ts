// Unit tests for src/tools/health.ts — pure status derivation + rollup.
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveDaemonStatus, rollupOverall } from "../src/tools/health.js";

describe("deriveDaemonStatus — pending state (grace window)", () => {
  test("daemon with no run_ended events within grace window returns pending", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "pending");
    assert.match(result.reason, /grace/i);
  });

  test("daemon with no run_ended events past grace window returns down", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 20 * 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "down");
    assert.match(result.reason, /no run_ended/i);
  });

  test("daemon with recent run_ended events returns healthy", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [{ event_type: "run_ended", created_at: new Date().toISOString() }],
      uptimeSec: 30 * 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "healthy");
  });

  test("disabled daemon never returns pending", () => {
    const result = deriveDaemonStatus({
      enabled: false,
      events: [],
      uptimeSec: 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.notEqual(result.status, "pending");
  });
});

describe("rollupOverall — pending does not promote past degraded", () => {
  test("all healthy except one pending → overall pending", () => {
    assert.equal(rollupOverall(["healthy", "pending", "healthy"]), "pending");
  });

  test("one pending + one degraded → overall degraded", () => {
    assert.equal(rollupOverall(["pending", "degraded", "healthy"]), "degraded");
  });

  test("one pending + one down → overall down", () => {
    assert.equal(rollupOverall(["pending", "down", "healthy"]), "down");
  });

  test("all healthy → overall healthy", () => {
    assert.equal(rollupOverall(["healthy", "healthy", "healthy"]), "healthy");
  });
});
