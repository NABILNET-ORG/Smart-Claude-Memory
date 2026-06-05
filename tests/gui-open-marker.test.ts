import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldOpenBrowserNow, shouldOpenForPort, stampOpenForPort } from "../src/gui/server.js";

// #342 browser-fatigue fix: the in-process GUI server dies with the MCP process,
// so probePort misses it on every fresh sequential session and a new tab opens.
// A per-port recency marker (12h TTL) suppresses the redundant auto-open; the
// stable per-project port means an existing tab reconnects on refresh.
const TTL = 12 * 60 * 60 * 1000; // 12h
const HOUR = 60 * 60 * 1000;

describe("gui browser auto-open recency guard", () => {
  describe("shouldOpenBrowserNow (pure)", () => {
    it("opens when there is no prior open recorded", () => {
      assert.equal(shouldOpenBrowserNow(undefined, TTL, 1_000_000), true);
    });
    it("suppresses when opened within the TTL window", () => {
      const now = 100 * HOUR;
      assert.equal(shouldOpenBrowserNow(now - 1 * HOUR, TTL, now), false);
    });
    it("opens again once the TTL has elapsed", () => {
      const now = 100 * HOUR;
      assert.equal(shouldOpenBrowserNow(now - 13 * HOUR, TTL, now), true);
    });
    it("opens (never suppresses) when TTL <= 0 — escape hatch", () => {
      const now = 100 * HOUR;
      assert.equal(shouldOpenBrowserNow(now, 0, now), true);
    });
    it("opens when the stored timestamp is not a finite number", () => {
      assert.equal(shouldOpenBrowserNow(NaN, TTL, 1_000), true);
    });
  });

  describe("per-port marker round-trip", () => {
    const file = path.join(os.tmpdir(), `scm-gui-marker-test-${process.pid}.json`);
    afterEach(() => {
      if (existsSync(file)) rmSync(file);
    });

    it("suppresses the same port after stamping, but never a different project's port", () => {
      const now = 100 * HOUR;
      assert.equal(shouldOpenForPort(7814, TTL, now, file), true, "first time → open");
      stampOpenForPort(7814, now, file);
      assert.equal(shouldOpenForPort(7814, TTL, now + 1 * HOUR, file), false, "within TTL → suppress");
      assert.equal(shouldOpenForPort(9999, TTL, now + 1 * HOUR, file), true, "other project/port → open");
    });

    it("re-opens the same port after the TTL elapses", () => {
      const now = 100 * HOUR;
      stampOpenForPort(7814, now, file);
      assert.equal(shouldOpenForPort(7814, TTL, now + 13 * HOUR, file), true);
    });
  });
});
