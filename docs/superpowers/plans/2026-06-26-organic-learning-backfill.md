# Organic-Learning Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the skill miner produce real skills by giving it a trustworthy, metadata-driven "successful trajectory" signal and a populated `trajectory_summaries` table for the `claude-memory` project.

**Architecture:** A single-source-of-truth SQL view (`successful_chunks`) encodes which memory chunks represent successful, learnable work. The miner's success gate reads that view instead of the mismatched `archive_backlog` linkage. A one-shot, env-var-driven backfill script summarizes + embeds each successful, not-yet-summarized chunk into `trajectory_summaries`.

**Tech Stack:** TypeScript (Node ≥22, run via `tsx`), `node:test` + `node:assert/strict`, plain PostgreSQL 17 + pgvector (local :5433) behind the `supabase` shim (`src/db/pg-adapter.ts`), Ollama (`gemma3:e2b` summaries, `nomic-embed-text` 768-d embeddings).

## Global Constraints

- Node floor **≥22** (the test runner uses `node:test` mock.module).
- Migrations are `scripts/0NN_*.sql`, lex-sorted, applied by `scripts/apply-schema.ts` (each file wrapped in `BEGIN/COMMIT` by the harness — **do not** add transaction blocks). Next free number is **031**.
- Migration bodies must be idempotent (`tests/migrations.test.ts` statically enforces it). `create or replace view` and `grant` are safe.
- The test runner uses an **explicit file list** in `package.json` `"test"` — every new test file MUST be appended there or it never runs.
- DB access in scripts/src: `import { supabase } from "../src/supabase.js";` then `.from(t).select(...)/.upsert(...)`. Vectors: assign `number[]` to a `vector` column; the adapter serializes it — never hand-format the literal.
- Real Ollama output only — no fabricated summaries. Per-chunk failures are logged and skipped, never fatal.
- Production-ready: no placeholders, no `// TODO`, no `.skip`.

---

### Task 1: `successful_chunks` view migration

**Files:**
- Create: `scripts/031_successful_chunks_view.sql`
- Create: `tests/successful-chunks-view.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script)

**Interfaces:**
- Produces: a Postgres view `public.successful_chunks(chunk_id bigint, project_id text, metadata jsonb)` — one row per `memory_chunks` row that satisfies the success rule. Consumed by Task 2 (miner) and Task 4 (backfill).

- [ ] **Step 1: Write the migration**

Create `scripts/031_successful_chunks_view.sql`:

```sql
-- 031_successful_chunks_view.sql
-- SCM-S58 — Organic-learning backfill: metadata-driven "successful work" signal.
--
-- Problem: the skill miner (src/sleep/miner.ts) inner-joins trajectory summaries
-- against a "successful trajectory" set previously sourced from archive_backlog
-- rows carrying a chunk_id. In reality archive_backlog holds release milestones
-- with no chunk linkage, so the success set is always empty and zero skills mine.
--
-- Fix: define "successful, learnable work" as a property of the memory itself,
-- exposed as a single-source-of-truth view the miner reads. A chunk qualifies
-- when its metadata marks canonical knowledge (type DECISION/PATTERN), a finished
-- status, or global promotion. ERROR/LOG/untyped/in-flight chunks are excluded.
--
-- Idempotent: CREATE OR REPLACE VIEW + idempotent GRANT.

create or replace view public.successful_chunks as
select
  id          as chunk_id,
  project_id,
  metadata
from public.memory_chunks
where metadata->>'type' in ('DECISION', 'PATTERN')
   or metadata->>'status' in (
        'shipped', 'applied', 'implemented', 'verified',
        'deployed', 'fixed', 'verified-live', 'session-closed'
      )
   or metadata->>'is_global' = 'true';

grant select on public.successful_chunks to service_role;
```

- [ ] **Step 2: Apply the migration to the local DB**

Run: `npm run schema`
Expected: output lists `031_successful_chunks_view.sql` as applied (or "0 pending" on a second run). No errors.

- [ ] **Step 3: Write the failing test**

Create `tests/successful-chunks-view.test.ts`:

```ts
// Integration test for the successful_chunks view (scripts/031). Runs against the
// live dev DB (the view must be applied via `npm run schema` first). No fixture
// inserts — asserts the view exactly implements the agreed metadata success rule
// over existing data, and spot-checks one real included + one real excluded chunk.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import "dotenv/config";
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import pg from "pg";

const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
const RUN = !!connectionString && process.env.SKIP_DB_TESTS !== "1";
let client: pg.Client | null = null;

const RULE_WHERE = `
     metadata->>'type' in ('DECISION','PATTERN')
  or metadata->>'status' in ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed')
  or metadata->>'is_global' = 'true'`;

describe("successful_chunks view — metadata-driven success rule", () => {
  before(async () => {
    if (!RUN) return;
    client = new pg.Client({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString ?? "")
        ? false
        : { rejectUnauthorized: true },
    });
    await client.connect();
  });

  after(async () => {
    if (!client) return;
    await client.end();
    client = null;
  });

  test("view row set exactly equals the metadata rule, and is non-empty", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const view = await client.query<{ n: number }>(
      `select count(*)::int as n from public.successful_chunks`,
    );
    const direct = await client.query<{ n: number }>(
      `select count(*)::int as n from public.memory_chunks where ${RULE_WHERE}`,
    );
    assert.equal(view.rows[0]!.n, direct.rows[0]!.n, "view count must equal direct rule count");
    assert.ok(view.rows[0]!.n > 0, "expected a non-empty success set on the dev DB");
  });

  test("a real DECISION chunk is included; a real ERROR chunk is excluded", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const dec = await client.query<{ id: number }>(
      `select id from public.memory_chunks where metadata->>'type'='DECISION' limit 1`,
    );
    const err = await client.query<{ id: number }>(
      `select id from public.memory_chunks where metadata->>'type'='ERROR' limit 1`,
    );
    if (dec.rows[0]) {
      const r = await client.query(`select 1 from public.successful_chunks where chunk_id=$1`, [dec.rows[0].id]);
      assert.equal(r.rowCount, 1, "DECISION chunk must be in the view");
    }
    if (err.rows[0]) {
      const r = await client.query(`select 1 from public.successful_chunks where chunk_id=$1`, [err.rows[0].id]);
      assert.equal(r.rowCount, 0, "ERROR chunk must NOT be in the view");
    }
  });
});
```

- [ ] **Step 4: Register the test, run it, verify it passes**

Append ` tests/successful-chunks-view.test.ts` to the end of the `"test"` script value in `package.json`.

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/successful-chunks-view.test.ts`
(env: `SUPABASE_DB_URL`/`SUPABASE_POOLER_URL` = `postgresql://postgres:postgres@127.0.0.1:5433/postgres`)
Expected: PASS (2 tests). If it fails with "relation successful_chunks does not exist", re-run Step 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/031_successful_chunks_view.sql tests/successful-chunks-view.test.ts package.json
git commit -m "feat(db): successful_chunks view — metadata-driven success rule (SCM-S58)"
```

---

### Task 2: Point the miner's success gate at `successful_chunks`

**Files:**
- Modify: `src/sleep/miner.ts` (replace `fetchSuccessArchiveByChunk`; update `mineClusters`; remove the now-orphan `ArchiveRow` type)
- Create: `tests/sleep-miner-success-gate.test.ts`
- Modify: `package.json` (append the new test file)

**Interfaces:**
- Consumes: `successful_chunks` view (Task 1).
- Produces: `mineClusters(opts)` unchanged signature; candidates now have `source_backlog_ids: []` (success no longer derives from backlog; lineage is via `source_summary_ids`).

- [ ] **Step 1: Write the failing test**

Create `tests/sleep-miner-success-gate.test.ts`:

```ts
// Unit test for the miner success gate after SCM-S58: "successful" is sourced
// from the successful_chunks view, not archive_backlog. Mocks the supabase shim
// at the module boundary (no live DB).
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import { test, describe, mock, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

// Table fixtures the fake builder serves.
let successfulChunkRows: Array<{ chunk_id: number }> = [];
let summaryRows: Array<{
  id: number;
  project_id: string;
  summary: string;
  summary_embedding: number[] | null;
  source_chunk_id: number;
}> = [];

function makeBuilder(table: string) {
  // All miner reads are terminal `await`s on a chain ending in .eq()/.limit()/.in().
  // We resolve the right dataset by table and ignore the (irrelevant-to-routing) filters.
  const result =
    table === "successful_chunks"
      ? { data: successfulChunkRows, error: null }
      : table === "trajectory_summaries"
        ? { data: summaryRows, error: null }
        : { data: [], error: null }; // workflow_checkpoints rollback scan → empty
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

mock.module("../src/supabase.js", {
  namedExports: { supabase: { from: (t: string) => makeBuilder(t) } },
});

const { mineClusters } = await import("../src/sleep/miner.js");

describe("miner success gate — sourced from successful_chunks", () => {
  beforeEach(() => {
    successfulChunkRows = [];
    summaryRows = [];
  });

  test("only summaries whose source chunk is in successful_chunks are mined", async () => {
    // 3 summaries on successful chunks (identical embedding → one cluster ≥ minFreq=3)
    // + 1 summary on a NON-successful chunk that must be excluded.
    const emb = [1, 0, 0];
    summaryRows = [
      { id: 1, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 10 },
      { id: 2, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 11 },
      { id: 3, project_id: "p", summary: "ship the widget via the gate", summary_embedding: emb, source_chunk_id: 12 },
      { id: 4, project_id: "p", summary: "unrelated excluded trajectory", summary_embedding: [0, 1, 0], source_chunk_id: 99 },
    ];
    successfulChunkRows = [{ chunk_id: 10 }, { chunk_id: 11 }, { chunk_id: 12 }];

    const stubs = await mineClusters({ projectId: "p", batch: 50, minFreq: 3 });

    assert.ok(stubs.length >= 1, "a cluster of 3 successful summaries should yield a candidate");
    const all = stubs.flatMap((s) => s.source_summary_ids);
    assert.ok(!all.includes(4), "non-successful summary 4 must never be mined");
    assert.deepEqual(stubs[0]!.source_backlog_ids, [], "backlog provenance is empty post-SCM-S58");
  });

  test("empty success set → no candidates", async () => {
    summaryRows = [
      { id: 1, project_id: "p", summary: "a", summary_embedding: [1, 0], source_chunk_id: 10 },
    ];
    successfulChunkRows = [];
    const stubs = await mineClusters({ projectId: "p", batch: 50, minFreq: 3 });
    assert.deepEqual(stubs, []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Append ` tests/sleep-miner-success-gate.test.ts` to the `"test"` script in `package.json`, then run:
`node --import tsx --experimental-test-module-mocks --no-warnings --test tests/sleep-miner-success-gate.test.ts`
Expected: FAIL — the mock serves `successful_chunks`, but `miner.ts` still queries `archive_backlog` (so the gate sees an empty success set → `[]`), failing the first assertion.

- [ ] **Step 3: Replace the success source in `src/sleep/miner.ts`**

Delete the `ArchiveRow` type (lines ~46-49) and the entire `fetchSuccessArchiveByChunk` function (lines ~124-142). Add in their place:

```ts
// SCM-S58: success is a metadata-driven property of the chunk, exposed by the
// successful_chunks view (scripts/031). Returns the set of source_chunk_ids that
// represent successful, learnable work. Replaces the old archive_backlog linkage.
async function fetchSuccessfulChunkIds(projectId: string): Promise<Set<number>> {
  const out = new Set<number>();
  const { data, error } = await supabase
    .from("successful_chunks")
    .select("chunk_id")
    .eq("project_id", projectId);
  if (error) {
    // View missing on an un-migrated deployment — don't fail the daemon tick;
    // mining yields nothing until migration 031 is applied.
    return out;
  }
  for (const row of (data ?? []) as Array<{ chunk_id: number }>) {
    if (typeof row.chunk_id === "number") out.add(row.chunk_id);
  }
  return out;
}
```

In `mineClusters`, replace the success-set + gate (lines ~304-312):

```ts
  const successfulChunkIds = await fetchSuccessfulChunkIds(opts.projectId);

  // INNER JOIN semantics: keep only summaries whose source_chunk_id is marked
  // successful by the successful_chunks view. Failed/in-flight/non-canonical
  // work must NEVER seed a candidate skill.
  const successful = summaries.filter((s) =>
    successfulChunkIds.has(s.source_chunk_id),
  );
  if (successful.length === 0) return [];
```

Replace the `backlogIds` derivation (lines ~339-345) with:

```ts
    // SCM-S58: success no longer originates from archive_backlog, so there is no
    // backlog provenance. Lineage is carried by source_summary_ids.
    const backlogIds: number[] = [];
```

- [ ] **Step 4: Run the test + full suite to verify pass + no regression**

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/sleep-miner-success-gate.test.ts`
Expected: PASS (2 tests).
Run: `npm run build` → Expected: exit 0 (no unused-symbol / type errors; confirms `ArchiveRow` removal left nothing dangling).
Run the full suite (env as above): `npm test` → Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/sleep/miner.ts tests/sleep-miner-success-gate.test.ts package.json
git commit -m "feat(miner): source success gate from successful_chunks view (SCM-S58)"
```

---

### Task 3: `buildSummaryRow` mapper (pure, tested)

**Files:**
- Create: `src/trajectory/backfill-row.ts`
- Create: `tests/backfill-row.test.ts`
- Modify: `package.json` (append the new test file)

**Interfaces:**
- Produces: `buildSummaryRow(projectId, chunk, summary, embedding) → SummaryUpsertRow` and the `SummaryUpsertRow` type. Consumed by Task 4 (the script). Extracted into `src/` so the test can import it without triggering the script's `main()`.

- [ ] **Step 1: Write the failing test**

Create `tests/backfill-row.test.ts`:

```ts
// Unit test for the trajectory_summaries row mapper used by the backfill script.
// Pure function — no DB, no Ollama.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { buildSummaryRow } from "../src/trajectory/backfill-row.js";

describe("buildSummaryRow", () => {
  test("maps chunk + summary + embedding into a trajectory_summaries row", () => {
    const row = buildSummaryRow(
      "claude-memory",
      { chunk_id: 42, content: "x".repeat(400) },
      { summary: "did a thing", summaryTokens: 3, model: "gemma3:e2b" },
      [0.1, 0.2, 0.3],
    );
    assert.equal(row.project_id, "claude-memory");
    assert.equal(row.source_chunk_id, 42);
    assert.equal(row.summary, "did a thing");
    assert.deepEqual(row.summary_embedding, [0.1, 0.2, 0.3]);
    assert.equal(row.source_tokens, 100); // ceil(400 / 4)
    assert.equal(row.summary_tokens, 3);
    assert.equal(row.strategy, "backfill");
    assert.equal(row.model, "gemma3:e2b");
  });

  test("source_tokens is clamped to >=1 (satisfies the NOT NULL >=0 check) and null embedding passes through", () => {
    const row = buildSummaryRow(
      "p",
      { chunk_id: 1, content: "" },
      { summary: "s", summaryTokens: 1, model: "m" },
      null,
    );
    assert.ok(row.source_tokens >= 1);
    assert.equal(row.summary_embedding, null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Append ` tests/backfill-row.test.ts` to the `"test"` script in `package.json`, then run:
`node --import tsx --experimental-test-module-mocks --no-warnings --test tests/backfill-row.test.ts`
Expected: FAIL with "Cannot find module '../src/trajectory/backfill-row.js'".

- [ ] **Step 3: Write the implementation**

Create `src/trajectory/backfill-row.ts`:

```ts
// Pure mapper: build a trajectory_summaries upsert row from a successful chunk,
// its LLM summary, and the summary embedding. Extracted from the backfill script
// so it can be unit-tested without running the script's main().

export type SummaryUpsertRow = {
  project_id: string;
  source_chunk_id: number;
  summary: string;
  summary_embedding: number[] | null;
  source_tokens: number;
  summary_tokens: number;
  strategy: string;
  model: string;
};

/** ~4 chars per token, matching the summarizer's own estimate. Clamped to >=1
 *  because trajectory_summaries.source_tokens has a NOT NULL CHECK (>= 0). */
export function buildSummaryRow(
  projectId: string,
  chunk: { chunk_id: number; content: string },
  summary: { summary: string; summaryTokens: number; model: string },
  embedding: number[] | null,
): SummaryUpsertRow {
  return {
    project_id: projectId,
    source_chunk_id: chunk.chunk_id,
    summary: summary.summary,
    summary_embedding: embedding,
    source_tokens: Math.max(1, Math.ceil(chunk.content.length / 4)),
    summary_tokens: summary.summaryTokens,
    strategy: "backfill",
    model: summary.model,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/backfill-row.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/backfill-row.ts tests/backfill-row.test.ts package.json
git commit -m "feat(trajectory): buildSummaryRow mapper for the backfill (SCM-S58)"
```

---

### Task 4: Backfill script (orchestration + manual verification)

**Files:**
- Create: `scripts/backfill-trajectory-summaries.ts`

**Interfaces:**
- Consumes: `successful_chunks` (Task 1), `buildSummaryRow` (Task 3), `summarizeTrajectory`, `embed`, `supabase`.
- Produces: rows in `trajectory_summaries` for the target project's successful chunks. No new exported API.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-trajectory-summaries.ts`:

```ts
// Backfill trajectory_summaries for a project's "successful" memory chunks so the
// skill miner has a non-empty mining surface. Env-var driven (house pattern,
// mirrors scripts/backfill-kg-extraction.ts). Idempotent via the
// trajectory_summaries (project_id, source_chunk_id) unique index.
//
// Usage:
//   tsx scripts/backfill-trajectory-summaries.ts              # dry run: report only
//   SCM_BACKFILL_CONFIRM=1 tsx scripts/backfill-trajectory-summaries.ts
//
// Config (env):
//   SCM_BACKFILL_PROJECT   default "claude-memory"
//   SCM_BACKFILL_CONFIRM   unset/anything-but-"1" = dry run; "1" = write
//   SCM_BACKFILL_LIMIT     max chunks this run (default 1000)
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { summarizeTrajectory } from "../src/trajectory/summarizer.js";
import { embed } from "../src/ollama.js";
import { buildSummaryRow } from "../src/trajectory/backfill-row.js";

const PROJECT = process.env.SCM_BACKFILL_PROJECT ?? "claude-memory";
const CONFIRM = process.env.SCM_BACKFILL_CONFIRM === "1";
const LIMIT = readIntEnv("SCM_BACKFILL_LIMIT", 1000);

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type PendingChunk = { chunk_id: number; content: string };

async function fetchPending(limit: number): Promise<PendingChunk[]> {
  const { data: succ, error: succErr } = await supabase
    .from("successful_chunks")
    .select("chunk_id")
    .eq("project_id", PROJECT);
  if (succErr) throw new Error(`successful_chunks scan failed: ${succErr.message}`);
  const succIds = (succ ?? []).map((r: { chunk_id: number }) => r.chunk_id);
  if (succIds.length === 0) return [];

  const { data: done, error: doneErr } = await supabase
    .from("trajectory_summaries")
    .select("source_chunk_id")
    .eq("project_id", PROJECT);
  if (doneErr) throw new Error(`trajectory_summaries scan failed: ${doneErr.message}`);
  const doneSet = new Set((done ?? []).map((r: { source_chunk_id: number }) => r.source_chunk_id));

  const pendingIds = succIds.filter((id) => !doneSet.has(id)).slice(0, limit);
  if (pendingIds.length === 0) return [];

  const { data: chunks, error: chunkErr } = await supabase
    .from("memory_chunks")
    .select("id, content")
    .in("id", pendingIds);
  if (chunkErr) throw new Error(`memory_chunks load failed: ${chunkErr.message}`);
  return (chunks ?? [])
    .filter((c: { content: unknown }) => typeof c.content === "string" && (c.content as string).trim().length > 0)
    .map((c: { id: number; content: string }) => ({ chunk_id: c.id, content: c.content }));
}

async function main(): Promise<void> {
  const pending = await fetchPending(LIMIT);
  console.log(`[backfill] project=${PROJECT} confirm=${CONFIRM} pending=${pending.length}`);

  if (!CONFIRM) {
    for (const c of pending.slice(0, 10)) {
      console.log(`  would summarize chunk ${c.chunk_id} (${c.content.length} chars)`);
    }
    console.log(
      `[backfill] DRY RUN — set SCM_BACKFILL_CONFIRM=1 to write. ` +
        `${pending.length} chunk(s) would be summarized.`,
    );
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const chunk of pending) {
    try {
      const summary = await summarizeTrajectory(chunk.content);
      let embedding: number[] | null = null;
      try {
        const [vec] = await embed([summary.summary]);
        if (Array.isArray(vec) && vec.length > 0) embedding = vec;
      } catch {
        embedding = null; // embeddings are best-effort; the row is still useful
      }
      const row = buildSummaryRow(PROJECT, chunk, summary, embedding);
      const { error } = await supabase
        .from("trajectory_summaries")
        .upsert(row, { onConflict: "project_id,source_chunk_id" });
      if (error) throw new Error(error.message);
      ok += 1;
      if (ok % 10 === 0) console.log(`  [progress] ${ok}/${pending.length} summarized`);
    } catch (err) {
      failed += 1;
      console.error(`  [skip] chunk ${chunk.chunk_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[backfill] DONE project=${PROJECT} summarized=${ok} failed=${failed} of ${pending.length}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("\nFATAL — backfill aborted:");
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Dry run (no writes, no Ollama calls)**

Run: `SCM_BACKFILL_PROJECT=claude-memory tsx scripts/backfill-trajectory-summaries.ts`
(env: `SUPABASE_DB_URL`/`SUPABASE_POOLER_URL` = local :5433)
Expected: `pending=` ~76 (minus any already summarized), a few `would summarize chunk …` lines, then the `DRY RUN` line. No rows written.

- [ ] **Step 4: Confirmed run (requires Ollama up with `gemma3:e2b` + `nomic-embed-text`)**

Run: `SCM_BACKFILL_PROJECT=claude-memory SCM_BACKFILL_CONFIRM=1 tsx scripts/backfill-trajectory-summaries.ts`
Expected: progress lines, then `DONE … summarized=~76 failed=0`. Re-running it immediately prints `pending=0` (idempotent).

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-trajectory-summaries.ts
git commit -m "feat(scripts): trajectory_summaries backfill for successful chunks (SCM-S58)"
```

---

### Task 5: End-to-end loop verification (manual)

**Files:** none (verification only).

- [ ] **Step 1: Confirm summaries landed**

Run (psql via docker):
`docker exec -e PGPASSWORD=postgres scm_plain_pg psql -h 127.0.0.1 -U postgres -d postgres -tAc "select count(*) from trajectory_summaries where project_id='claude-memory'"`
Expected: > 0 (~76).

- [ ] **Step 2: Mine + confirm candidates**

Invoke the miner for the project (via the MCP `trigger_clustering`/sleep-learner path, or a one-off `mineClusters({ projectId: 'claude-memory' })` harness). Then:
`docker exec … psql … -tAc "select count(*) from skill_candidates where state='mined'"`
Expected: ≥ 1 (subject to ≥`minFreq` similar summaries existing; if 0, that is a *data* outcome — the surface was too sparse to cluster — not a code failure; record it).

- [ ] **Step 3: Cluster + retrieve**

Run `trigger_clustering({ force: true })`, then `request_skill({ query: "<a topic the mined skill covers>" })`.
Expected: at least one skill retrievable, or a documented note that the cluster surface was below threshold.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/scm-s58-organic-learning-backfill
gh pr create --base main --title "feat: organic-learning backfill — metadata-driven success (SCM-S58)" --body "<summary of tasks 1-5 + verification results>"
```

---

## Self-review notes

- **Spec coverage:** success rule → Task 1; honest success gate → Task 2; summaries backfill → Task 4 (+ mapper Task 3); verification → Task 5. The spec's deferred items (5.A curriculum TTL, multi-project) are intentionally **not** tasks here.
- **Known data caveat (Task 5 Step 2):** mining needs ≥`minFreq` (default 3) similar summaries among 76 successful chunks. If the surface is too sparse/diverse to cluster, zero candidates is a legitimate data outcome, not a bug — recorded, not forced.
- **`source_backlog_ids` becomes `[]`** by design (Task 2) — a deliberate, documented behavior change.
