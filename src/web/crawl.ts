// Pure bounded BFS crawl engine — SCM-S49-D2.
//
// This module owns the FRONTIER logic only: breadth-first traversal, bounding
// (depth / total pages / per-domain cap), same-origin confinement, visited-set
// dedup, a tiny in-house bounded concurrency pool (zero new dependency), and
// per-host politeness pacing. Every side-effecting concern — HTTP, ingestion,
// robots — is INJECTED via `deps`, so the engine runs fully offline under test.
//
// It calls the REAL extractLinks on the html that deps.fetch returns (link
// discovery is pure and deserves real coverage even in unit tests).
//
// Failure isolation: a page that fails to fetch/ingest, is disallowed by
// robots, or yields no text is recorded in skipped[]/errors[] and the crawl
// CONTINUES. The only hard stops are the configured bounds, the total deadline,
// an exhausted frontier, or an ingest result flagged stopCrawl (budget block).

import { extractLinks, normalizeUrl, sameOrigin } from "./links.js";
import type { RobotsRules } from "./robots.js";

// ─── Injected dependency contracts ────────────────────────────────────────

export type CrawlFetchResult =
  | { ok: true; final_url: string; text: string; title: string | null; html: string }
  | { ok: false; reason: string };

export type CrawlIngestArgs = {
  url: string;
  text: string;
  title: string | null;
  depth: number;
};

export type CrawlIngestResult = {
  ok: boolean;
  chunks_stored?: number;
  reason?: string;
  // When true, the engine stops scheduling new work and drains in-flight pages,
  // finishing with stopped_reason "budget". Set by the budget-gated wrapper.
  stopCrawl?: boolean;
};

export type CrawlDeps = {
  fetch: (url: string) => Promise<CrawlFetchResult>;
  ingest: (args: CrawlIngestArgs) => Promise<CrawlIngestResult>;
  robots: RobotsRules;
};

// ─── Options + result ─────────────────────────────────────────────────────

export type CrawlOpts = {
  maxDepth: number;
  /**
   * Hard cap on fetch ATTEMPTS, not successes: every page dequeued for
   * processing consumes one unit even if it is then robots-disallowed,
   * fetch-failed, or empty. This bounds total requests/work — the resource &
   * politeness budget — so `pages_ingested` may be < `maxPages` when pages are
   * skipped. (Per-domain-capped candidates are skipped WITHOUT consuming it.)
   */
  maxPages: number;
  maxPagesPerDomain: number;
  concurrency: number;
  politenessMs: number;
  totalTimeoutMs: number;
  sameOriginOnly: boolean;
  respectRobots: boolean;
  // Injectable clock + sleep so tests stay instant and deterministic.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type CrawlSkip = { url: string; reason: string };
export type CrawlError = { url: string; reason: string };

export type StoppedReason =
  | "frontier_empty"
  | "max_pages"
  | "deadline"
  | "budget";

export type CrawlResult = {
  pages_ingested: number;
  chunks_upserted: number;
  skipped: CrawlSkip[];
  errors: CrawlError[];
  stopped_reason: StoppedReason;
};

type FrontierItem = { url: string; depth: number };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Run a bounded BFS crawl from `seed`. Pure w.r.t. its deps — no imports of the
 * real fetch/ingest/robots. Always resolves with a structured summary; never
 * throws (a thrown dep is caught and recorded as an error for that page).
 */
export async function crawl(
  seed: string,
  opts: CrawlOpts,
  deps: CrawlDeps,
): Promise<CrawlResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.totalTimeoutMs;

  const seedNorm = normalizeUrl(seed);
  const skipped: CrawlSkip[] = [];
  const errors: CrawlError[] = [];

  if (!seedNorm) {
    return {
      pages_ingested: 0,
      chunks_upserted: 0,
      skipped: [{ url: seed, reason: "Invalid seed URL" }],
      errors: [],
      stopped_reason: "frontier_empty",
    };
  }

  const seedOrigin = new URL(seedNorm).origin;

  const visited = new Set<string>([seedNorm]);
  const frontier: FrontierItem[] = [{ url: seedNorm, depth: 0 }];
  const perDomain = new Map<string, number>();

  let pagesIngested = 0;
  let chunksUpserted = 0;
  // started: pages whose fetch we have committed to (counts against maxPages so
  // the engine never schedules more than the budget even with concurrency).
  let started = 0;
  let stopped: StoppedReason | null = null;

  // Enqueue helper: applies same-origin + visited dedup + depth bound.
  const enqueue = (rawUrl: string, depth: number): void => {
    const norm = normalizeUrl(rawUrl);
    if (!norm) return;
    if (visited.has(norm)) return;
    if (opts.sameOriginOnly && !sameOrigin(norm, seedOrigin)) return;
    if (depth > opts.maxDepth) return;
    visited.add(norm);
    frontier.push({ url: norm, depth });
  };

  // Process exactly one page: robots → fetch → ingest → discover links.
  const processOne = async (item: FrontierItem): Promise<void> => {
    const { url, depth } = item;

    if (opts.respectRobots && !deps.robots.isAllowed(pathOf(url))) {
      skipped.push({ url, reason: "Disallowed by robots.txt" });
      return;
    }

    let fetched: CrawlFetchResult;
    try {
      fetched = await deps.fetch(url);
    } catch (e) {
      errors.push({ url, reason: `fetch threw: ${(e as Error).message}` });
      return;
    }
    if (!fetched.ok) {
      skipped.push({ url, reason: fetched.reason });
      return;
    }

    let ingested: CrawlIngestResult;
    try {
      ingested = await deps.ingest({
        url: fetched.final_url || url,
        text: fetched.text,
        title: fetched.title,
        depth,
      });
    } catch (e) {
      errors.push({ url, reason: `ingest threw: ${(e as Error).message}` });
      return;
    }

    if (ingested.stopCrawl) {
      // Budget block: stop scheduling; do NOT count this page as ingested.
      stopped = stopped ?? "budget";
      return;
    }
    if (!ingested.ok) {
      skipped.push({ url, reason: ingested.reason ?? "ingest failed" });
      return;
    }

    pagesIngested += 1;
    chunksUpserted += ingested.chunks_stored ?? 0;

    // Discover same-origin links from the RAW html and enqueue the unseen ones.
    if (depth < opts.maxDepth) {
      const base = fetched.final_url || url;
      const links = extractLinks(fetched.html, base, seedOrigin);
      for (const link of links) enqueue(link, depth + 1);
    }
  };

  // Bounded BFS: drain the frontier in waves of up to `concurrency`, respecting
  // the per-domain cap and the total page budget, pacing each wave by the
  // politeness delay. A wave is awaited together (the in-house pool).
  const concurrency = Math.max(1, opts.concurrency);

  while (frontier.length > 0) {
    if (stopped) break;
    if (now() >= deadline) {
      stopped = "deadline";
      break;
    }

    // Assemble the next wave under the bounds.
    const wave: FrontierItem[] = [];
    while (frontier.length > 0 && wave.length < concurrency) {
      if (started >= opts.maxPages) {
        stopped = "max_pages";
        break;
      }
      const next = frontier.shift() as FrontierItem;
      const host = hostOf(next.url);
      const domainCount = perDomain.get(host) ?? 0;
      if (domainCount >= opts.maxPagesPerDomain) {
        skipped.push({ url: next.url, reason: "Per-domain page cap reached" });
        continue;
      }
      perDomain.set(host, domainCount + 1);
      started += 1;
      wave.push(next);
    }

    if (wave.length === 0) {
      // Either max_pages tripped or every candidate was domain-capped.
      if (stopped) break;
      if (frontier.length === 0) break;
      continue;
    }

    await Promise.all(wave.map((it) => processOne(it)));

    if (stopped) break;

    // Per-host politeness pacing between waves (robots Crawl-delay vs floor).
    if (frontier.length > 0 && now() < deadline) {
      const delay = Math.max(
        opts.respectRobots ? deps.robots.crawlDelayMs : 0,
        opts.politenessMs,
      );
      if (delay > 0) await sleep(delay);
    }
  }

  if (!stopped) {
    stopped = started >= opts.maxPages && frontier.length > 0
      ? "max_pages"
      : "frontier_empty";
  }

  return {
    pages_ingested: pagesIngested,
    chunks_upserted: chunksUpserted,
    skipped,
    errors,
    stopped_reason: stopped,
  };
}
