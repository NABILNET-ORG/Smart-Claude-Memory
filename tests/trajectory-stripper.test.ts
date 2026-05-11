// Unit tests for src/trajectory/stripper.ts — pure heuristic noise stripper.
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripTrajectory } from "../src/trajectory/stripper.js";

const tok = (s: string): number => Math.ceil(s.length / 4);

describe("stripTrajectory", () => {
  describe("input boundaries", () => {
    it("returns zeroed result for empty input", () => {
      const r = stripTrajectory("");
      assert.deepEqual(r, { stripped: "", sourceTokens: 0, strippedTokens: 0 });
    });

    it("estimates source tokens as ceil(len/4)", () => {
      const raw = "a".repeat(17); // ceil(17/4) = 5
      const r = stripTrajectory(raw);
      assert.equal(r.sourceTokens, 5);
    });

    it("estimates stripped tokens as ceil(strippedLen/4)", () => {
      const raw = "hello world\nplain line";
      const r = stripTrajectory(raw);
      assert.equal(r.strippedTokens, Math.ceil(r.stripped.length / 4));
    });

    it("token counts are consistent with returned strings", () => {
      const raw = "first\nsecond\nthird";
      const r = stripTrajectory(raw);
      assert.equal(r.sourceTokens, tok(raw));
      assert.equal(r.strippedTokens, tok(r.stripped));
    });
  });

  describe("non-mutation contract", () => {
    it("does not mutate the input string reference (round-trip equality)", () => {
      const raw = "\x1b[31mred\x1b[0m\nDEBUG: noise\nkeep me";
      const original = raw;
      stripTrajectory(raw);
      assert.equal(raw, original);
    });
  });

  describe("ANSI stripping", () => {
    it("removes simple foreground color escapes", () => {
      const r = stripTrajectory("\x1b[31mred\x1b[0m");
      assert.equal(r.stripped, "red");
    });

    it("removes multiple ANSI codes inline", () => {
      const r = stripTrajectory("\x1b[1;32mbold green\x1b[0m end");
      assert.equal(r.stripped, "bold green end");
    });

    it("preserves content with no ANSI codes unchanged (single line)", () => {
      const r = stripTrajectory("plain text");
      assert.equal(r.stripped, "plain text");
    });
  });

  describe("JSON blob elision", () => {
    it("elides a JSON-shaped line longer than the 500 char threshold", () => {
      // Build a 600-char JSON object on a single line.
      const filler = "x".repeat(580);
      const jsonLine = `{"k":"${filler}"}`;
      assert.ok(jsonLine.length > 500, "fixture too short");
      const r = stripTrajectory(jsonLine);
      assert.equal(r.stripped, `[json blob ${jsonLine.length} chars elided]`);
    });

    it("preserves a JSON-shaped line at or under the threshold", () => {
      // A 400-char JSON line should be preserved verbatim.
      const filler = "y".repeat(390);
      const jsonLine = `{"k":"${filler}"}`;
      assert.ok(jsonLine.length < 500, "fixture too long");
      const r = stripTrajectory(jsonLine);
      assert.equal(r.stripped, jsonLine);
    });

    it("does not elide long non-JSON-shaped lines (no braces)", () => {
      const longProse = "z".repeat(600);
      const r = stripTrajectory(longProse);
      assert.equal(r.stripped, longProse);
    });

    it("elides a JSON array line when it has a colon and is long enough", () => {
      const filler = "a".repeat(580);
      const arrLine = `[{"k":"${filler}"}]`;
      assert.ok(arrLine.length > 500);
      const r = stripTrajectory(arrLine);
      assert.equal(r.stripped, `[json blob ${arrLine.length} chars elided]`);
    });
  });

  describe("stack trace truncation", () => {
    it("truncates >5 consecutive stack frames, keeping 5 plus marker", () => {
      const frames = Array.from({ length: 8 }, (_, i) => `    at func${i} (file:${i + 1})`);
      const raw = frames.join("\n");
      const r = stripTrajectory(raw);
      const lines = r.stripped.split("\n");
      assert.equal(lines.length, 6);
      for (let i = 0; i < 5; i++) {
        assert.equal(lines[i], frames[i]);
      }
      assert.equal(lines[5], "... [3 more frames elided]");
    });

    it("leaves <=5 frames untouched", () => {
      const frames = Array.from({ length: 4 }, (_, i) => `    at func${i} (file:${i + 1})`);
      const raw = frames.join("\n");
      const r = stripTrajectory(raw);
      assert.equal(r.stripped, raw);
    });

    it("leaves exactly 5 frames untouched", () => {
      const frames = Array.from({ length: 5 }, (_, i) => `    at func${i} (file:${i + 1})`);
      const raw = frames.join("\n");
      const r = stripTrajectory(raw);
      assert.equal(r.stripped, raw);
    });
  });

  describe("consecutive dedupe", () => {
    it("dedupes 3 identical consecutive lines into one plus repeat marker", () => {
      const r = stripTrajectory("foo\nfoo\nfoo");
      assert.equal(r.stripped, "foo\n[× 3 repeats]");
    });

    it("does not touch non-consecutive duplicates", () => {
      const r = stripTrajectory("foo\nbar\nfoo");
      assert.equal(r.stripped, "foo\nbar\nfoo");
    });

    it("leaves a single occurrence alone (no marker)", () => {
      const r = stripTrajectory("solo");
      assert.equal(r.stripped, "solo");
    });
  });

  describe("noise-level line stripping", () => {
    it("removes DEBUG:, TRACE: and VERBOSE: prefixed lines", () => {
      const raw = ["DEBUG: noise", "real content", "TRACE: more", "VERBOSE: extra"].join("\n");
      const r = stripTrajectory(raw);
      assert.equal(r.stripped, "real content");
    });

    it("preserves lines that merely contain DEBUG mid-string", () => {
      const raw = "INFO: DEBUG hint inside\nplain";
      const r = stripTrajectory(raw);
      assert.equal(r.stripped, raw);
    });
  });

  describe("100k-character safety cap", () => {
    it("caps oversized output at 100 000 chars and appends truncation marker", () => {
      const TRUNC_SUFFIX = "[... source truncated at 100k chars]";
      const raw = "a".repeat(150_000);
      const r = stripTrajectory(raw);
      assert.ok(r.stripped.length <= 100_000, `len ${r.stripped.length}`);
      assert.equal(r.stripped.length, 100_000);
      assert.ok(
        r.stripped.endsWith(TRUNC_SUFFIX),
        "expected truncation marker at end of stripped output",
      );
    });

    it("does not append the marker to inputs under the cap", () => {
      const raw = "a".repeat(1000);
      const r = stripTrajectory(raw);
      assert.equal(r.stripped, raw);
      assert.ok(!r.stripped.includes("[... source truncated"));
    });
  });
});
