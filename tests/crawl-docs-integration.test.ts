// Integration test for the docs crawler — SCM-S49-D2.
//
// Exercises the REAL ingestion path end-to-end against the live dev Supabase and
// real Ollama embeddings, while keeping the HTTP layer deterministic. Only the
// network I/O is faked: a FIXTURE fetch serves 3 interlinked HTML pages plus an
// allow-all /robots.txt on synthetic URLs (https://docs.test/a|/b|/c). Everything
// downstream is real — the pure crawl() engine, the REAL extractLinks running on
// the fixture HTML, the REAL loadRobots(fixtureFetch), and the REAL ingestPage
// (chunkMarkdown → embed → deleteChunksForFile → upsertChunks).
//
// ISOLATION CONTRACT (double-gated — Phase 1 design SCM-S49-D1):
//   1. EXCLUDED from `npm test`'s file list → never runs in the unit lane.
//   2. SELF-SKIPS unless RUN_DB_TESTS=1 (injected via --env-file=.env.test).
//
// NAMESPACE + CLEANUP:
//   Every row is written under a disposable project_id (PID). after() runs in a
//   finally so cleanup ALWAYS executes even on assertion failure, then re-queries
//   memory_chunks and logs the residual count (must be 0).
//
// Runtime: node:test + node:assert/strict (Node 20+, loaded via tsx).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/supabase.js";
import { ingestPage } from "../src/web/ingest.js";
import { loadRobots, type RobotsFetchResult } from "../src/web/robots.js";
import {
  crawl,
  type CrawlDeps,
  type CrawlFetchResult,
  type CrawlOpts,
} from "../src/web/crawl.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

// Disposable project namespace — pid keeps parallel CI runners from colliding.
const PID = `test-int-crawl-${Date.now()}-${process.pid}`;

const SEED = "https://docs.test/a";
const ORIGIN = "https://docs.test";

// Three interlinked pages: a → b → c, and c → a (a cycle, to prove visited
// dedup against re-ingesting the seed). Each has enough prose that chunkMarkdown
// yields at least one chunk.
const PAGES: Record<string, string> = {
  "/a": `<!doctype html><html><head><title>Page A</title></head><body>
    <h1>Page A</h1>
    <p>Alpha content about the crawler's first page. ${"Alpha ".repeat(40)}</p>
    <a href="/b">go to B</a>
  </body></html>`,
  "/b": `<!doctype html><html><head><title>Page B</title></head><body>
    <h1>Page B</h1>
    <p>Bravo content for the second page. ${"Bravo ".repeat(40)}</p>
    <a href="/c">go to C</a>
  </body></html>`,
  "/c": `<!doctype html><html><head><title>Page C</title></head><body>
    <h1>Page C</h1>
    <p>Charlie content on the third page. ${"Charlie ".repeat(40)}</p>
    <a href="/a">back to A</a>
  </body></html>`,
};

const ROBOTS_BODY = "User-agent: *\nDisallow:"; // allow-all

// Fixture fetch: serves robots.txt + the three HTML pages; 404 otherwise.
// Shape matches the subset of fetchUrl the crawler consumes (final_url, text,
// title, html). text mirrors what html-to-text would yield closely enough that
// chunkMarkdown produces chunks (the real ingestPage runs on it).
function fixtureFetch(url: string): Promise<CrawlFetchResult> {
  const u = new URL(url);
  if (u.pathname === "/robots.txt") {
    return Promise.resolve({
      ok: true,
      final_url: url,
      text: ROBOTS_BODY,
      title: null,
      html: "",
    });
  }
  const html = PAGES[u.pathname];
  if (html === undefined) {
    return Promise.resolve({ ok: false, reason: "HTTP 404" });
  }
  // Plain-text body for ingestion (headings preserved so chunker keeps sections).
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  return Promise.resolve({
    ok: true,
    final_url: url,
    text: `# ${titleMatch?.[1] ?? u.pathname}\n\n${text}`,
    title: titleMatch?.[1] ?? null,
    html,
  });
}

// robots fetch adapter over the fixture (loadRobots wants RobotsFetchResult).
async function fixtureRobotsFetch(url: string): Promise<RobotsFetchResult> {
  const r = await fixtureFetch(url);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, text: r.text };
}

// Real ingest dep: drives the REAL ingestPage against Supabase + Ollama.
const realIngest: CrawlDeps["ingest"] = async ({ url, text, title, depth }) => {
  const res = await ingestPage({
    url,
    text,
    title,
    projectId: PID,
    meta: { seed_url: SEED, depth },
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, chunks_stored: res.chunks_stored };
};

function crawlOpts(): CrawlOpts {
  return {
    maxDepth: 3,
    maxPages: 10,
    maxPagesPerDomain: 10,
    concurrency: 2,
    politenessMs: 0, // no real delay needed; HTTP is faked
    totalTimeoutMs: 60_000,
    sameOriginOnly: true,
    respectRobots: true,
  };
}

async function countChunks(): Promise<number> {
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", PID);
  if (error) throw new Error(`countChunks failed: ${error.message}`);
  return count ?? 0;
}

async function distinctOrigins(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("file_origin")
    .eq("project_id", PID);
  if (error) throw new Error(`distinctOrigins failed: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { file_origin: string }).file_origin));
}

describe("crawl_docs — real-DB integration (PID-isolated)", () => {
  before(() => {
    if (!RUN_DB_TESTS) {
      console.log("[crawl-integration] RUN_DB_TESTS!=1 — skipping real-DB lane");
    }
  });

  after(async () => {
    if (!RUN_DB_TESTS) return;
    try {
      await supabase.from("memory_chunks").delete().eq("project_id", PID);
    } finally {
      // Residual audit — MUST be 0 for this PID.
      let residual = -1;
      try {
        residual = await countChunks();
      } catch (e) {
        console.error(`[crawl-integration] residual audit failed: ${(e as Error).message}`);
      }
      console.log(
        `[crawl-integration] residual memory_chunks for PID=${PID} — ${residual}`,
      );
      // Hard guarantee, not just a log line: a non-zero (or unverifiable, -1)
      // residual FAILS the run so a cleanup leak can never pass green.
      assert.equal(
        residual,
        0,
        `teardown leaked ${residual} memory_chunks for PID=${PID}`,
      );
    }
  });

  test("ingests every reachable page; re-crawl is idempotent", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("RUN_DB_TESTS!=1");

    const deps: CrawlDeps = {
      fetch: fixtureFetch,
      ingest: realIngest,
      robots: await loadRobots(ORIGIN, fixtureRobotsFetch),
    };

    // ── First crawl ──────────────────────────────────────────────────────────
    const first = await crawl(SEED, crawlOpts(), deps);
    assert.equal(first.errors.length, 0, `no errors: ${JSON.stringify(first.errors)}`);
    assert.equal(first.pages_ingested, 3, "all three interlinked pages ingested");
    assert.ok(first.chunks_upserted > 0, "at least one chunk upserted");

    // Each page is its own memory_chunks "file" keyed by file_origin.
    const origins = await distinctOrigins();
    assert.equal(origins.size, 3, "three distinct file_origin values");
    assert.ok(origins.has("https://docs.test/a"), "page A present");
    assert.ok(origins.has("https://docs.test/b"), "page B present");
    assert.ok(origins.has("https://docs.test/c"), "page C present");

    const rowsAfterFirst = await countChunks();
    assert.ok(rowsAfterFirst > 0, "rows created on first crawl");
    assert.equal(
      rowsAfterFirst,
      first.chunks_upserted,
      "DB row count matches the engine's reported chunks_upserted",
    );

    // ── Re-crawl: must be IDEMPOTENT (delete-before-reembed per file_origin) ──
    const second = await crawl(SEED, crawlOpts(), deps);
    assert.equal(second.pages_ingested, 3, "re-crawl ingests the same three pages");
    const rowsAfterSecond = await countChunks();
    assert.equal(
      rowsAfterSecond,
      rowsAfterFirst,
      "row count stable after re-crawl — NOT doubled (idempotent upsert)",
    );
  });
});
