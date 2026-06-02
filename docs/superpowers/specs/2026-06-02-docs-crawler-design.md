# Phase 2 Design — Bounded Docs Crawler (#312)

- **Date:** 2026-06-02 · **Session:** 49 · **Decision:** SCM-S49-D2
- **Builds on:** Session 48 Agentic Superpowers (`fetch_url`, `research_url`, SSRF guard — commit `1558006`).
- **Depends on:** Phase 1 DB-integration lane (SCM-S49-D1) for its integration test.

## Goal

A bounded, polite, SSRF-safe multi-page crawler (`crawl_docs` tool) that ingests a documentation site into `memory_chunks` by **composing existing primitives** — not duplicating them.

## Locked decisions (user-approved, Session 49)

1. **Link extraction = zero-dep regex** over raw HTML + `new URL(href, base)` resolution + same-origin filter + `assertSafeUrl`. Honors the repo's zero-new-runtime-dependency ethos. Adequate for docs sites. (Alternative `linkedom` rejected to preserve zero-dep streak.)
2. **robots.txt = standard respect**: fetch `/robots.txt` once per origin; honor `User-agent: *` `Disallow` prefixes + `Crawl-delay`; basic `*`/`$` wildcard support. (Full RFC 9309 deferred as over-engineering.)

## Composition map — reuse vs. new

| Concern | Source | Action |
|---|---|---|
| HTTP + per-redirect SSRF | `fetchUrl()` (`src/web/fetch.ts`) | Reuse; add opt-in to expose raw HTML body |
| Per-link URL safety | `assertSafeUrl()` (`src/web/ssrf-guard.ts`) | Reuse as-is for every discovered link |
| HTML→text → chunk → embed → upsert | `research_url` (`src/tools/research-url.ts`) | Extract into shared `ingestPage()` |
| Chunking / embeddings / table | `chunkMarkdown` (800/100), Ollama `nomic-embed-text` 768-dim, `memory_chunks` (`file_origin`+`file_hash` idempotency) | Reuse as-is |
| Budget throttle | `checkDaemonBudget()` (`src/budget/gate.ts`) | Reuse to gate the embed fan-out |
| Limits/config | `src/config.ts` | Reuse + add `CRAWL_*` consts |
| Link extraction, frontier, politeness, robots | — | New (none exist) |

## Module layout (isolated, independently testable)

- `src/web/links.ts` — `extractLinks(html, baseUrl, seedOrigin)`: regex enumerate `<a href>`, resolve relative, same-origin filter, normalize + dedup.
- `src/web/robots.ts` — `loadRobots(origin, fetchFn)` → `{ isAllowed(path), crawlDelayMs }`. Small line parser; `User-agent:*` group; `Disallow` prefix match + basic `*`/`$`.
- `src/web/ingest.ts` — shared `ingestPage({ url, text, title, projectId, meta })` lifted out of `research_url` (both tools share ONE pipeline; satisfies the backlog's "batch-ingests via research_url's pipeline"). `research_url` is refactored to call it (behavior-preserving).
- `src/web/crawl.ts` — **pure engine** `crawl(seed, opts, deps)`: BFS frontier, bounding, dedup, concurrency, politeness. `deps = { fetch, ingest, robots }` injected → fully unit-testable with NO network.
- `src/tools/crawl-docs.ts` — MCP `crawl_docs` handler: resolve config, run budget gate, drive the engine, return a summary. Registered in `src/index.ts` mirroring `research_url`.

## Data flow

```
seed_url ─▶ assertSafeUrl ─▶ loadRobots(origin) ─▶ frontier = [{url, depth:0}]
  while frontier && pages < max_pages && now < deadline:
    take up to `concurrency` items ──per page──▶
      robots.isAllowed(path)?  (skip if no)
      fetchUrl(url, { includeRaw:true })  → { ok, final_url, text, html, title }
      ingestPage(text → chunkMarkdown → embed(batch) → upsert memory_chunks[file_origin=final_url])
      extractLinks(html, final_url, seedOrigin) → for each: unseen && depth+1 ≤ max_depth ⇒ enqueue
    await delay( max(robots.crawlDelayMs, CRAWL_POLITENESS_MS) )   // per-host politeness
  return { pages_ingested, chunks_upserted, skipped[], errors[], stopped_reason }
```

## Bounding & politeness (safety knobs)

- `max_depth` (BFS depth from seed), `max_pages` (hard total budget), `max_pages_per_domain`.
- **Same-origin only** (seed host) — no cross-origin following in MVP.
- `visited: Set<string>` of normalized URLs (strip fragment, trailing slash, default ports) → dedup.
- Per-host **delay** = `max(robots Crawl-delay, CRAWL_POLITENESS_MS)`.
- **Concurrency cap** via a tiny in-house bounded pool (default 2–3) — zero dep.
- **Total deadline** `CRAWL_TIMEOUT_TOTAL_MS`.
- Per-page failures are collected and **skipped, never fatal** (`fetchUrl` returns `{ok:false}`; SSRF rejections skip the link).

## Vector insertion

- Each page → one `memory_chunks` "file" keyed by `file_origin = final_url` → **idempotent re-crawl** via existing `deleteChunksForFile` before upsert.
- Embeddings batched (`CRAWL_EMBED_BATCH`).
- Metadata extends the S48 web shape: `{ type:"LOG", kind:"web", source_url, title, fetched_at, crawl_id, seed_url, depth }`.
- `project_id` from arg or `currentProjectId()`.

## Budget gate integration

First tool to opt into the Resource Manager. Before each embed batch: `checkDaemonBudget("crawl_docs", "ollama_calls", batchSize)`. On `"block"` → stop gracefully, return partial results with `stopped_reason: "budget"`. Network independently bounded by `max_pages`. (Daemon surface chosen over task surface: a single tool call has no task lifecycle; rolling-hour buckets fit a fan-out.)

## Config additions (`src/config.ts`)

`CRAWL_MAX_DEPTH` (default 2), `CRAWL_MAX_PAGES` (default 50), `CRAWL_MAX_PAGES_PER_DOMAIN` (default 50), `CRAWL_POLITENESS_MS` (default 1000), `CRAWL_CONCURRENCY` (default 3), `CRAWL_EMBED_BATCH` (default 16), `CRAWL_TIMEOUT_TOTAL_MS` (default 120000). All overridable via env; tool args override env.

## Tool surface

`crawl_docs({ seed_url, max_depth?, max_pages?, same_origin_only?=true, respect_robots?=true, project_id?, allow_private?=false, allowlist?=[], politeness_ms? })` — zod schema mirroring `research_url`. Returns `{ pages_ingested, chunks_upserted, skipped, errors, stopped_reason }`.

## Testing

- **Unit (`npm test`, mocked — no network):**
  - `links.test.ts` — relative resolution, same-origin filter, dedup/normalization, malformed href tolerance.
  - `robots.test.ts` — allow/disallow prefixes, `Crawl-delay`, `*`/`$` wildcard, missing/empty robots.
  - `crawl.test.ts` — engine with injected mock `fetch`/`ingest`/`robots`: depth bound, page budget, per-domain cap, visited dedup, error isolation, deadline, stopped_reason.
- **Integration (`npm run test:integration`, real DB — rides SCM-S49-D1 lane):**
  - `crawl-docs-integration.test.ts` — robust + non-flaky: inject a **fixture `fetch`** serving 3 interlinked HTML pages (+ allow-all `/robots.txt`) on synthetic URLs, but drive the **real** `extractLinks`, **real** `loadRobots`, and **real** `ingestPage` (real Ollama embeddings + real Supabase upsert) under a disposable `project_id = test-int-crawl-<ts>-<pid>`. Asserts: `memory_chunks` rows created per page (`file_origin`), chunk count > 0, **idempotent re-crawl** (row count stable, not doubled), then FK-safe teardown to **0 residual**. No external network → deterministic in CI; only the HTTP I/O is faked, the DB path is fully real.

## Error handling

`fetchUrl` never throws; SSRF/robots/HTTP failures are recorded in `skipped[]`/`errors[]` and the crawl continues. The tool handler wraps the engine and always returns a structured summary (never throws to the MCP layer).

## YAGNI / out of scope

`sitemap.xml` discovery, JS-rendered pages (headless browser), non-HTML assets, cross-origin following, incremental/scheduled re-crawl daemon, auth'd sites. Add later if a real need appears.

## Definition of Done

- `npm run build` → 0 errors; `lint:boundaries` green.
- New unit tests green inside `npm test` (count grows from 360).
- `npm run test:integration` green; crawl integration test leaves 0 residual rows.
- `research_url` behavior unchanged after the `ingestPage()` refactor (its existing path still works).
- Zero new runtime dependencies.
