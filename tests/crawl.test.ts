// Unit tests for src/web/crawl.ts — the pure BFS engine.
// FULLY hermetic: fetch/ingest/robots are injected mocks; the clock + sleep are
// injected so the suite is instant and deterministic. NO network, NO DB. Real
// extractLinks runs inside the engine on the mock HTML (link discovery is pure).
// Runtime: node:test + node:assert/strict.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  crawl,
  type CrawlDeps,
  type CrawlFetchResult,
  type CrawlIngestResult,
  type CrawlOpts,
} from "../src/web/crawl.js";
import type { RobotsRules } from "../src/web/robots.js";

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, crawlDelayMs: 0 };

// Instant, deterministic time: no real timers. now() advances only when the
// test explicitly drives it; sleep is a no-op (the engine paces via politeness
// but we don't want real delays).
function fixedClock(start = 0): { now: () => number } {
  return { now: () => start };
}
const noSleep = async (): Promise<void> => {};

// Default opts; individual tests override the knobs they exercise.
function opts(over: Partial<CrawlOpts> = {}): CrawlOpts {
  return {
    maxDepth: 5,
    maxPages: 100,
    maxPagesPerDomain: 100,
    concurrency: 3,
    politenessMs: 0,
    totalTimeoutMs: 60_000,
    sameOriginOnly: true,
    respectRobots: true,
    now: fixedClock().now,
    sleep: noSleep,
    ...over,
  };
}

// Build a deps object backed by an in-memory site map: path → html. Records the
// set of ingested URLs. Robots defaults to allow-all.
function siteDeps(
  pages: Record<string, string>,
  over: Partial<CrawlDeps> = {},
): { deps: CrawlDeps; ingested: string[]; fetches: string[] } {
  const ingested: string[] = [];
  const fetches: string[] = [];

  const fetch = async (url: string): Promise<CrawlFetchResult> => {
    fetches.push(url);
    const u = new URL(url);
    const html = pages[u.pathname];
    if (html === undefined) return { ok: false, reason: "HTTP 404" };
    return { ok: true, final_url: url, text: `text of ${u.pathname}`, title: u.pathname, html };
  };

  const ingest = async ({ url }: { url: string }): Promise<CrawlIngestResult> => {
    ingested.push(url);
    return { ok: true, chunks_stored: 2 };
  };

  return {
    ingested,
    fetches,
    deps: { fetch, ingest, robots: ALLOW_ALL, ...over },
  };
}

describe("crawl engine — traversal + bounding", () => {
  test("crawls a small interlinked site and ingests every reachable page", async () => {
    const { deps, ingested } = siteDeps({
      "/": `<a href="/a">a</a><a href="/b">b</a>`,
      "/a": `<a href="/c">c</a>`,
      "/b": `<a href="/c">c</a>`, // /c reachable from two parents → visited once
      "/c": `no links`,
    });
    const res = await crawl("https://docs.test/", opts(), deps);
    assert.equal(res.pages_ingested, 4, "/, /a, /b, /c each ingested once");
    assert.equal(res.chunks_upserted, 8, "2 chunks per page × 4");
    assert.equal(
      ingested.filter((u) => u.endsWith("/c")).length,
      1,
      "/c ingested exactly once despite two inbound links (visited dedup)",
    );
    assert.equal(res.stopped_reason, "frontier_empty");
  });

  test("respects max_depth (BFS depth from seed)", async () => {
    const { deps, ingested } = siteDeps({
      "/": `<a href="/d1">d1</a>`,
      "/d1": `<a href="/d2">d2</a>`,
      "/d2": `<a href="/d3">d3</a>`,
      "/d3": `end`,
    });
    const res = await crawl("https://docs.test/", opts({ maxDepth: 1 }), deps);
    // depth 0 = seed, depth 1 = /d1; /d2 (depth 2) must not be fetched.
    assert.deepEqual(ingested.sort(), [
      "https://docs.test/",
      "https://docs.test/d1",
    ]);
    assert.equal(res.pages_ingested, 2);
  });

  test("max_depth 0 ingests only the seed", async () => {
    const { deps, ingested } = siteDeps({
      "/": `<a href="/a">a</a>`,
      "/a": `x`,
    });
    const res = await crawl("https://docs.test/", opts({ maxDepth: 0 }), deps);
    assert.deepEqual(ingested, ["https://docs.test/"]);
    assert.equal(res.pages_ingested, 1);
  });

  test("enforces max_pages and reports stopped_reason=max_pages", async () => {
    // A hub linking to many children; cap total pages at 3.
    const { deps } = siteDeps({
      "/": `<a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a><a href="/p4">4</a>`,
      "/p1": `x`,
      "/p2": `x`,
      "/p3": `x`,
      "/p4": `x`,
    });
    const res = await crawl(
      "https://docs.test/",
      opts({ maxPages: 3, concurrency: 1 }),
      deps,
    );
    assert.equal(res.pages_ingested, 3, "exactly the page budget");
    assert.equal(res.stopped_reason, "max_pages");
  });

  test("enforces max_pages_per_domain", async () => {
    const { deps, fetches } = siteDeps({
      "/": `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`,
      "/a": `x`,
      "/b": `x`,
      "/c": `x`,
    });
    const res = await crawl(
      "https://docs.test/",
      opts({ maxPagesPerDomain: 2, concurrency: 1 }),
      deps,
    );
    assert.equal(res.pages_ingested, 2, "only 2 pages from the single domain");
    assert.equal(fetches.length, 2, "domain-capped candidates are never fetched");
    assert.ok(
      res.skipped.some((s) => s.reason.includes("Per-domain")),
      "the over-cap candidate is recorded as skipped",
    );
  });
});

describe("crawl engine — failure isolation", () => {
  test("a fetch failure is skipped, not fatal; siblings still crawl", async () => {
    const { deps } = siteDeps({
      "/": `<a href="/ok">ok</a><a href="/missing">missing</a>`,
      "/ok": `x`,
      // /missing has no entry → fetch returns ok:false
    });
    const res = await crawl("https://docs.test/", opts(), deps);
    assert.equal(res.pages_ingested, 2, "seed + /ok");
    assert.ok(
      res.skipped.some((s) => s.url.endsWith("/missing")),
      "the 404 is recorded in skipped[]",
    );
    assert.equal(res.errors.length, 0);
  });

  test("a thrown fetch is captured in errors[], crawl continues", async () => {
    const base = siteDeps({
      "/": `<a href="/boom">boom</a><a href="/ok">ok</a>`,
      "/ok": `x`,
      "/boom": `x`,
    });
    const deps: CrawlDeps = {
      ...base.deps,
      fetch: async (url: string) => {
        if (url.endsWith("/boom")) throw new Error("socket reset");
        return base.deps.fetch(url);
      },
    };
    const res = await crawl("https://docs.test/", opts({ concurrency: 1 }), deps);
    assert.ok(
      res.errors.some((e) => e.url.endsWith("/boom") && e.reason.includes("socket reset")),
      "the thrown fetch is isolated into errors[]",
    );
    assert.ok(res.pages_ingested >= 2, "seed + /ok still ingested");
  });

  test("a thrown ingest is captured in errors[]", async () => {
    const base = siteDeps({ "/": `seed only` });
    const deps: CrawlDeps = {
      ...base.deps,
      ingest: async () => {
        throw new Error("db down");
      },
    };
    const res = await crawl("https://docs.test/", opts(), deps);
    assert.equal(res.pages_ingested, 0);
    assert.ok(res.errors.some((e) => e.reason.includes("db down")));
  });
});

describe("crawl engine — robots, deadline, same-origin, budget", () => {
  test("robots disallow skips matching pages", async () => {
    const robots: RobotsRules = {
      isAllowed: (p: string) => !p.startsWith("/private"),
      crawlDelayMs: 0,
    };
    const { deps } = siteDeps(
      {
        "/": `<a href="/public">pub</a><a href="/private/x">priv</a>`,
        "/public": `x`,
        "/private/x": `x`,
      },
      { robots },
    );
    const res = await crawl("https://docs.test/", opts(), deps);
    assert.ok(
      res.skipped.some((s) => s.url.includes("/private") && s.reason.includes("robots")),
      "the disallowed page is skipped with a robots reason",
    );
    assert.ok(!res.skipped.some((s) => s.url.includes("/public")));
  });

  test("respect_robots=false ignores Disallow rules", async () => {
    const robots: RobotsRules = { isAllowed: () => false, crawlDelayMs: 0 };
    const { deps } = siteDeps({ "/": `seed` }, { robots });
    const res = await crawl(
      "https://docs.test/",
      opts({ respectRobots: false }),
      deps,
    );
    assert.equal(res.pages_ingested, 1, "robots ignored → seed still crawled");
  });

  test("total deadline stops the crawl with stopped_reason=deadline", async () => {
    // Clock jumps past the deadline on the second read (after seed processed).
    let t = 0;
    const ticking = () => {
      const v = t;
      t += 100_000; // each call advances 100s
      return v;
    };
    const { deps } = siteDeps({
      "/": `<a href="/a">a</a>`,
      "/a": `<a href="/b">b</a>`,
      "/b": `x`,
    });
    const res = await crawl(
      "https://docs.test/",
      opts({ totalTimeoutMs: 50_000, now: ticking, concurrency: 1 }),
      deps,
    );
    assert.equal(res.stopped_reason, "deadline");
  });

  test("cross-origin links are not followed (same_origin_only)", async () => {
    const base = siteDeps({
      "/": `<a href="https://evil.test/x">evil</a><a href="/a">a</a>`,
      "/a": `x`,
    });
    // Fetch records every URL it is asked for — assert evil.test is never fetched.
    const res = await crawl("https://docs.test/", opts(), base.deps);
    assert.ok(
      !base.fetches.some((u) => u.includes("evil.test")),
      "no cross-origin fetch",
    );
    assert.equal(res.pages_ingested, 2, "seed + same-origin /a only");
  });

  test("an ingest flagged stopCrawl halts with stopped_reason=budget", async () => {
    const base = siteDeps({
      "/": `<a href="/a">a</a><a href="/b">b</a>`,
      "/a": `x`,
      "/b": `x`,
    });
    let calls = 0;
    const deps: CrawlDeps = {
      ...base.deps,
      ingest: async ({ url }) => {
        calls += 1;
        // Allow the seed, then signal a budget stop on the next page.
        if (calls === 1) return { ok: true, chunks_stored: 1 };
        return { ok: false, stopCrawl: true, reason: "budget" };
      },
    };
    const res = await crawl("https://docs.test/", opts({ concurrency: 1 }), deps);
    assert.equal(res.stopped_reason, "budget");
    assert.equal(res.pages_ingested, 1, "only the seed counted before the budget stop");
  });

  test("an invalid seed yields a structured (non-throwing) result", async () => {
    const { deps } = siteDeps({ "/": `x` });
    const res = await crawl("not-a-url", opts(), deps);
    assert.equal(res.pages_ingested, 0);
    assert.equal(res.stopped_reason, "frontier_empty");
    assert.ok(res.skipped.some((s) => s.reason.includes("Invalid seed")));
  });
});
