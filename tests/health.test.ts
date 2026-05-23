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
    // Pin `now` to the same instant the event was created. This eliminates
    // the sub-millisecond timing race that previously made this test flake
    // when `intervalMs` defaults to 0 (staleThreshold=0) and `Date.now()`
    // advanced past the toISOString-truncated event timestamp.
    const t = Date.now();
    const result = deriveDaemonStatus({
      enabled: true,
      events: [{ event_type: "run_ended", created_at: new Date(t).toISOString() }],
      uptimeSec: 30 * 60,
      graceMs: 15 * 60 * 1000,
      now: t,
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

  // SCM-S39-F1 — long-interval daemons (telemetry_pruner: 6h) must keep
  // pending past the 15-min static grace floor because their first scheduled
  // tick has not yet occurred. Effective grace = max(graceMs, intervalMs*1.1).
  test("long-interval daemon stays pending past 15min floor while within interval*1.1", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 20 * 60, // 20min — past static floor
      intervalMs: 6 * 60 * 60 * 1000, // 6h
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "pending");
    // Effective grace ≈ 396min (6h * 1.1) — must surface in the reason.
    assert.match(result.reason, /396min grace window/);
  });

  test("long-interval daemon flips to down once interval*1.1 has elapsed", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 7 * 60 * 60, // 7h — past 6h * 1.1 = 6.6h
      intervalMs: 6 * 60 * 60 * 1000, // 6h
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "down");
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
