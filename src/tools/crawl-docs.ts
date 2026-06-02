// MCP tool: crawl_docs — SCM-S49-D2 (#312).
//
// A bounded, polite, SSRF-safe multi-page documentation crawler that ingests a
// site into memory_chunks by COMPOSING existing primitives — it owns no new
// HTTP, chunking, or DB code. It wires the real fetchUrl (SSRF guard + raw HTML
// exposure), the shared ingestPage pipeline, and the standard robots.txt loader
// into the pure BFS engine (src/web/crawl.ts), then drives the engine and
// returns a structured summary. It is the first tool to opt into the Resource
// Manager: each embed batch is gated through checkDaemonBudget; a budget block
// stops the crawl gracefully with stopped_reason "budget".
//
// This handler NEVER throws to the MCP layer — every failure (bad seed, SSRF
// rejection of the seed, unexpected engine error) is wrapped into the summary
// or a structured { ok:false, reason }.

import { config } from "../config.js";
import { currentProjectId } from "../project.js";
import { assertSafeUrl } from "../web/ssrf-guard.js";
import { fetchUrl } from "../web/fetch.js";
import { ingestPage } from "../web/ingest.js";
import { loadRobots, type RobotsFetchResult } from "../web/robots.js";
import {
  crawl,
  type CrawlDeps,
  type CrawlFetchResult,
  type CrawlResult,
} from "../web/crawl.js";
import { checkDaemonBudget } from "../budget/gate.js";

export type CrawlDocsArgs = {
  seed_url: string;
  max_depth?: number;
  max_pages?: number;
  same_origin_only?: boolean;
  respect_robots?: boolean;
  project_id?: string;
  allow_private?: boolean;
  allowlist?: string[];
  politeness_ms?: number;
};

export type CrawlDocsOk = CrawlResult & {
  ok: true;
  seed_url: string;
  project_id: string;
};

export type CrawlDocsErr = { ok: false; reason: string };

export type CrawlDocsResult = CrawlDocsOk | CrawlDocsErr;

// Ingestion needs the whole page body; the real volume guard is
// SCM_FETCH_MAX_BYTES (applied while reading the socket), same as research_url.
const INGEST_RETURN_CHARS = Number.MAX_SAFE_INTEGER;

// Daemon identity for the Resource Manager rolling-hour buckets.
const DAEMON = "crawl_docs";

// Sentinel thrown from ingestPage's beforeBatch hook when the budget gate
// blocks; caught by the ingest wrapper and translated into stopCrawl so the
// engine drains gracefully instead of surfacing an error.
class CrawlBudgetStop extends Error {
  constructor() {
    super("crawl budget exhausted");
    this.name = "CrawlBudgetStop";
  }
}

export async function crawlDocs(args: CrawlDocsArgs): Promise<CrawlDocsResult> {
  try {
    if (
      !args.seed_url ||
      typeof args.seed_url !== "string" ||
      args.seed_url.trim() === ""
    ) {
      return { ok: false, reason: "Missing required 'seed_url' argument." };
    }

    const projectId = args.project_id ?? currentProjectId;
    const allowPrivate = args.allow_private ?? false;
    const allowlist = args.allowlist ?? [];
    const sameOriginOnly = args.same_origin_only ?? true;
    const respectRobots = args.respect_robots ?? true;

    const maxDepth = args.max_depth ?? config.CRAWL_MAX_DEPTH;
    const maxPages = args.max_pages ?? config.CRAWL_MAX_PAGES;
    const maxPagesPerDomain = config.CRAWL_MAX_PAGES_PER_DOMAIN;
    const concurrency = config.CRAWL_CONCURRENCY;
    const politenessMs = args.politeness_ms ?? config.CRAWL_POLITENESS_MS;
    const embedBatch = config.CRAWL_EMBED_BATCH;
    const totalTimeoutMs = config.CRAWL_TIMEOUT_TOTAL_MS;

    // Validate the SEED up front so an obviously-bad/blocked seed returns a
    // clear error rather than an empty crawl. Per-link safety is enforced again
    // inside fetchUrl (every hop), so discovered links are guarded too.
    let seedSafe;
    try {
      seedSafe = await assertSafeUrl(args.seed_url, { allowPrivate, allowlist });
    } catch (e) {
      return { ok: false, reason: `Seed URL rejected: ${(e as Error).message}` };
    }
    const seedOrigin = seedSafe.origin;

    // ── Real fetch dep: fetchUrl with raw HTML exposed + per-hop SSRF guard ──
    const fetchDep = async (url: string): Promise<CrawlFetchResult> => {
      const r = await fetchUrl(url, {
        includeRaw: true,
        maxReturnChars: INGEST_RETURN_CHARS,
        allowPrivate,
        allowlist,
      });
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        final_url: r.final_url,
        text: r.text,
        title: r.title,
        html: r.html ?? "",
      };
    };

    // ── Real robots dep: fetch /robots.txt once via the same SSRF-guarded path.
    const robotsFetch = async (url: string): Promise<RobotsFetchResult> => {
      const r = await fetchUrl(url, {
        maxReturnChars: INGEST_RETURN_CHARS,
        allowPrivate,
        allowlist,
      });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, text: r.text };
    };
    const robots = respectRobots
      ? await loadRobots(seedOrigin, robotsFetch)
      : { isAllowed: () => true, crawlDelayMs: 0 };

    // ── Real ingest dep: shared ingestPage, budget-gated per embed batch ──────
    const ingestDep: CrawlDeps["ingest"] = async ({ url, text, title, depth }) => {
      try {
        const res = await ingestPage({
          url,
          text,
          title,
          projectId,
          embedBatch,
          meta: { seed_url: args.seed_url, depth },
          beforeBatch: async (batchSize) => {
            // Gate the embed fan-out. Daemons don't THROW on block (gate.ts),
            // so inspect the decision; also defensively treat a thrown
            // BudgetExceededError as a block.
            const decision = await checkDaemonBudget(
              DAEMON,
              "ollama_calls",
              batchSize,
            );
            if (decision.decision === "block") throw new CrawlBudgetStop();
          },
        });
        if (!res.ok) return { ok: false, reason: res.reason };
        return { ok: true, chunks_stored: res.chunks_stored };
      } catch (e) {
        if (
          e instanceof CrawlBudgetStop ||
          (e as Error).name === "BudgetExceededError"
        ) {
          return { ok: false, stopCrawl: true, reason: "budget" };
        }
        // Any other error is isolated to this page by the engine.
        throw e;
      }
    };

    const deps: CrawlDeps = { fetch: fetchDep, ingest: ingestDep, robots };

    const result = await crawl(
      args.seed_url,
      {
        maxDepth,
        maxPages,
        maxPagesPerDomain,
        concurrency,
        politenessMs,
        totalTimeoutMs,
        sameOriginOnly,
        respectRobots,
      },
      deps,
    );

    return { ok: true, seed_url: args.seed_url, project_id: projectId, ...result };
  } catch (e) {
    // Last-resort guard: the tool must never throw to the MCP layer.
    return { ok: false, reason: `crawl_docs failed: ${(e as Error).message}` };
  }
}
