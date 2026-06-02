// Unit tests for src/web/robots.ts — pure, hermetic (injected fixture fetch).
// Covers allow/disallow prefix matching, Crawl-delay, basic * / $ wildcards,
// User-agent group selection, and the missing/empty/unfetchable → allow-all
// degradation. Runtime: node:test + node:assert/strict.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  loadRobots,
  type RobotsFetch,
  type RobotsFetchResult,
} from "../src/web/robots.js";

const ORIGIN = "https://docs.test";

// Build a fixture fetch that returns the given robots body for /robots.txt.
function fetchServing(body: string): RobotsFetch {
  return async (url: string): Promise<RobotsFetchResult> => {
    assert.equal(url, `${ORIGIN}/robots.txt`, "robots fetched from origin root");
    return { ok: true, text: body };
  };
}

describe("loadRobots — Disallow prefix matching", () => {
  test("blocks paths under a Disallow prefix, allows others", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nDisallow: /private"),
    );
    assert.equal(r.isAllowed("/private"), false);
    assert.equal(r.isAllowed("/private/page"), false, "prefix match");
    assert.equal(r.isAllowed("/public"), true);
    assert.equal(r.isAllowed("/"), true);
  });

  test("empty Disallow means allow-all", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nDisallow:"),
    );
    assert.equal(r.isAllowed("/anything"), true);
  });

  test("Allow overrides a broader Disallow (longest-match wins)", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nDisallow: /docs\nAllow: /docs/public"),
    );
    assert.equal(r.isAllowed("/docs/secret"), false, "covered by Disallow");
    assert.equal(
      r.isAllowed("/docs/public/intro"),
      true,
      "longer Allow wins over shorter Disallow",
    );
  });
});

describe("loadRobots — Crawl-delay", () => {
  test("parses Crawl-delay seconds into ms", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nCrawl-delay: 2"),
    );
    assert.equal(r.crawlDelayMs, 2000);
  });

  test("fractional Crawl-delay rounds to ms", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nCrawl-delay: 0.5"),
    );
    assert.equal(r.crawlDelayMs, 500);
  });

  test("no Crawl-delay → 0", async () => {
    const r = await loadRobots(ORIGIN, fetchServing("User-agent: *\nDisallow:"));
    assert.equal(r.crawlDelayMs, 0);
  });
});

describe("loadRobots — wildcards", () => {
  test("'*' matches any run inside the path", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nDisallow: /*/tmp"),
    );
    assert.equal(r.isAllowed("/a/tmp"), false);
    assert.equal(r.isAllowed("/a/b/tmp"), false, "* spans multiple segments");
    assert.equal(r.isAllowed("/a/keep"), true);
  });

  test("trailing '$' anchors the end of the path", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: *\nDisallow: /page.html$"),
    );
    assert.equal(r.isAllowed("/page.html"), false, "exact match blocked");
    assert.equal(
      r.isAllowed("/page.html?x=1"),
      true,
      "$ prevents the query variant from matching",
    );
  });
});

describe("loadRobots — User-agent group selection", () => {
  test("ignores agent-specific groups, honors only User-agent: *", async () => {
    const body = [
      "User-agent: BadBot",
      "Disallow: /",
      "",
      "User-agent: *",
      "Disallow: /admin",
    ].join("\n");
    const r = await loadRobots(ORIGIN, fetchServing(body));
    assert.equal(r.isAllowed("/admin"), false, "the * group's rule applies");
    assert.equal(
      r.isAllowed("/home"),
      true,
      "BadBot's blanket Disallow: / must NOT apply to us",
    );
  });

  test("merges consecutive User-agent lines that include *", async () => {
    const body = ["User-agent: foo", "User-agent: *", "Disallow: /x"].join("\n");
    const r = await loadRobots(ORIGIN, fetchServing(body));
    assert.equal(r.isAllowed("/x"), false, "shared block applies to *");
  });

  test("ignores comments (trailing # ... is stripped from the value)", async () => {
    const body = "User-agent: *\nDisallow: /a # secret area";
    const r = await loadRobots(ORIGIN, fetchServing(body));
    // If the comment were NOT stripped, the pattern would be the literal
    // "/a # secret area" and "/a" would not match it. It matches → strip worked.
    assert.equal(r.isAllowed("/a"), false, "prefix /a is disallowed");
    assert.equal(r.isAllowed("/about"), false, "prefix match extends to /about");
    assert.equal(r.isAllowed("/b"), true, "unrelated path stays allowed");
  });
});

describe("loadRobots — degradation to allow-all", () => {
  test("fetch failure → allow-all", async () => {
    const r = await loadRobots(ORIGIN, async () => ({
      ok: false,
      reason: "HTTP 404",
    }));
    assert.equal(r.isAllowed("/anything"), true);
    assert.equal(r.crawlDelayMs, 0);
  });

  test("empty body → allow-all", async () => {
    const r = await loadRobots(ORIGIN, fetchServing("   \n  "));
    assert.equal(r.isAllowed("/anything"), true);
  });

  test("a thrown fetch → allow-all (never blocks the crawl)", async () => {
    const r = await loadRobots(ORIGIN, async () => {
      throw new Error("network down");
    });
    assert.equal(r.isAllowed("/anything"), true);
  });

  test("a robots with no * group at all → allow-all", async () => {
    const r = await loadRobots(
      ORIGIN,
      fetchServing("User-agent: SomeBot\nDisallow: /"),
    );
    assert.equal(r.isAllowed("/anything"), true, "no * group means nothing applies");
  });
});
