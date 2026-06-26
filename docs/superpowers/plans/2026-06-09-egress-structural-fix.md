# Egress Structural Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Supabase egress leak by moving embedding-heavy compute server-side so 768-dim vectors never cross the wire — (A) clustering K-Means, (B) graph-extractor chunk→node embedding copy.

**Architecture:** Push compute to the data. (A) A new PL/pgSQL RPC `kg_kmeans_assign` computes supernode assignments inside Postgres and returns only `(node_id, supernode_id)` scalars; the daemon stops pulling `kg_nodes.embedding`. `kg_knn_pairs` (already server-side) + TS Louvain stay unchanged. (B) A new RPC `kg_upsert_node_from_chunk` copies `memory_chunks.embedding → kg_nodes.embedding` inside Postgres by `chunk_id`; the graph daemon stops selecting `embedding`.

**Tech Stack:** TypeScript (Node `node:test` via `tsx`), Supabase Postgres + pgvector, PL/pgSQL RPCs, supabase-js.

**Branch:** `fix/scm-s55-egress-leak` (already created; audit doc committed `b7544ec`).

---

## ⚠️ PIVOT — Commit A re-architected (2026-06-13)

**Server-side K-Means (the original Commit A) is ABORTED.** Applying + running migration `029`'s PL/pgSQL Lloyd's loop (`CREATE TEMP TABLE` + per-iteration `UPDATE`) thrashed WAL/Disk-IO and **depleted the Supabase Free-Tier Disk-IO budget**, taking the DB offline — the "outage" we hit mid-build was self-inflicted. Postgres on a constrained tier is the wrong engine for heavy iterative vector math.

**Replacement (shipped, commit `d46f595`):** keep K-Means **client-side** in `src/clustering/kmeans.ts` (in-RAM, zero DB IO) and add a **delta-gate** to `isDirty()` — re-cluster only if no clusters exist yet, OR `|embedded-node − cluster| delta > SCM_CLUSTERING_DELTA_THRESHOLD` (default 100), OR `SCM_CLUSTERING_COOLDOWN_MS` (default 24h) has elapsed. Running rarely drops the embedding-pull egress to near-zero **and** adds no IO. (This is the delta-gate the audit doc first proposed and we wrongly dropped as "YAGNI" when we chased the server-side approach.)

**Status:** delta-gate committed + spec/quality-reviewed + offline-unit-verified (5/5 mocked). Live integration verify, and dropping the now-dead deployed `kg_kmeans_assign` function, are **deferred until the Supabase Disk-IO budget recovers**. Commits B (graph server-side copy — IO-safe, no temp-tables/loops) and C still stand.

**Tasks A1–A7 below (server-side K-Means) are SUPERSEDED** — retained for history/context only.

## Risks & Decisions (read first)

- **Determinism:** the server-side K-Means will NOT be bit-identical to the TS `kmeans.ts` (no mulberry32 in Postgres). **Tests assert invariants** (every node assigned exactly once; `k = ceil(sqrt(n))`; same seed → same output within a session), NOT golden vectors.
- **Performance:** assign step is O(N·√N)/iteration with seq scans over transient centroids (no HNSW). Plan includes a **timing assertion (<10s for ~2k nodes)**. If it blows the budget at scale, reduce `p_max_iters` or early-stop — the `.env` throttle stays as the safety net until this ships verified.
- **pgvector version:** uses `l2_normalize(vector)` and `avg(vector)` (pgvector ≥ 0.5.0). Task A4 verifies; fallback noted inline.
- **`.env` throttle stays until Commit C** confirms zero-egress, then is reverted to restore normal daemon cadence.

---

## File Structure

- **Create** `scripts/029_kg_kmeans_server.sql` — `kg_kmeans_assign` RPC (server-side K-Means).
- **Create** `scripts/030_kg_upsert_node_from_chunk.sql` — `kg_upsert_node_from_chunk` RPC.
- **Create** `tests/clustering-kmeans-rpc.test.ts` — RPC invariant tests (DB-integration).
- **Create** `tests/kg-upsert-from-chunk.test.ts` — RPC test (DB-integration).
- **Modify** `src/clustering/daemon.ts:~270-282` — replace `fetchEmbeddings()` + `kmeans()` with one `kg_kmeans_assign` RPC call.
- **Modify** `src/tools/kg.ts` — add `upsertKgNodeFromChunk()` wrapper.
- **Modify** `src/graph/daemon.ts:128-129,199` — drop `embedding` from the `memory_chunks` select; write nodes via the new RPC.
- **Modify** `package.json` — register both new test files in the `test` script file-list.
- **Possibly remove** `src/clustering/kmeans.ts` + `tests/clustering-kmeans.test.ts` — only if Task A8 confirms they are orphaned (constitution: clean orphans you cause).

---

# COMMIT A — Server-side K-Means (PRIMARY, the ~12 GB driver)

### Task A1: Write the failing RPC invariant test

**Files:**
- Create: `tests/clustering-kmeans-rpc.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `tests/clustering-daemon.test.ts` setup conventions)

```ts
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { upsertKgNode } from "../src/tools/kg.js";

const createdProjectIds: string[] = [];
function newProject(tag: string): string {
  const pid = `__test_kmeans_${tag}_${randomUUID()}__`;
  createdProjectIds.push(pid);
  return pid;
}
// Deterministic 768-d unit-ish vector seeded by n (sin-based), matches existing helper style.
function vec(seed: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < 768; i++) v.push(Math.sin(seed * 0.13 + i * 0.017));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
async function seedNodes(pid: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await upsertKgNode({
      project_id: pid, type: "SYMBOL", label: `n${i}`,
      properties: {}, embedding: vec(i), source_chunk_id: null,
    });
  }
}
after(async () => {
  for (const pid of createdProjectIds) await supabase.from("kg_nodes").delete().eq("project_id", pid);
});

test("KM1: every embedded node is assigned exactly one supernode", async () => {
  const pid = newProject("km1");
  await seedNodes(pid, 16);
  const { data, error } = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  assert.equal(error, null, error?.message);
  const rows = (data ?? []) as { node_id: number; supernode_id: number }[];
  assert.equal(rows.length, 16, "one assignment per node");
  const ids = new Set(rows.map((r) => r.node_id));
  assert.equal(ids.size, 16, "no duplicate node assignments");
});

test("KM2: cluster count == ceil(sqrt(n)) and supernode ids are dense 0..k-1", async () => {
  const pid = newProject("km2");
  await seedNodes(pid, 25); // sqrt -> 5
  const { data } = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  const rows = (data ?? []) as { node_id: number; supernode_id: number }[];
  const k = Math.ceil(Math.sqrt(25));
  const sns = new Set(rows.map((r) => r.supernode_id));
  assert.ok(sns.size <= k, `<= ${k} supernodes, got ${sns.size}`);
  for (const sn of sns) assert.ok(sn >= 0 && sn < k, `supernode ${sn} in range`);
});

test("KM3: deterministic within a session (same seed -> same assignments)", async () => {
  const pid = newProject("km3");
  await seedNodes(pid, 20);
  const a = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  const b = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  assert.deepEqual(a.data, b.data, "identical seed -> identical output");
});

test("KM4: empty project returns zero rows (no error)", async () => {
  const pid = newProject("km4");
  const { data, error } = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  assert.equal(error, null, error?.message);
  assert.equal((data ?? []).length, 0);
});

test("KM5: completes in <10s for ~2000 nodes", async () => {
  const pid = newProject("km5");
  await seedNodes(pid, 2000);
  const t0 = Date.now();
  const { error } = await supabase.rpc("kg_kmeans_assign", { p_project_id: pid, p_max_iters: 50, p_seed: 0.42 });
  assert.equal(error, null, error?.message);
  assert.ok(Date.now() - t0 < 10_000, "kmeans RPC under 10s for 2k nodes");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/clustering-kmeans-rpc.test.ts`
Expected: FAIL — `could not find function kg_kmeans_assign` (RPC not yet created).

### Task A2: Write migration 029 (the RPC)

**Files:**
- Create: `scripts/029_kg_kmeans_server.sql`
- Reference: `scripts/023_kg_clustering.sql` (conventions, `kg_node_clusters`), `scripts/006_security_hardening.sql` (RLS pattern)

- [ ] **Step 1: Write the migration** (mirror conventions exactly: header block, `security definer`, `set search_path = public, extensions, pg_catalog`, idempotent, `comment on`)

```sql
-- 029_kg_kmeans_server.sql
-- SCM-S55 egress fix: move clustering K-Means SERVER-SIDE so kg_nodes.embedding
-- never egresses to the MCP client. Returns only (node_id, supernode_id) scalars.
-- Replaces the client-side fetchEmbeddings()+kmeans() pull in src/clustering/daemon.ts.
-- Conventions match 023_kg_clustering.sql. Idempotent: CREATE OR REPLACE.

create or replace function public.kg_kmeans_assign(
  p_project_id text,
  p_max_iters  int default 50,
  p_seed       double precision default 0.42
) returns table (node_id bigint, supernode_id int)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_n int;
  v_k int;
  v_iter int := 0;
  v_changed bigint := 1;
begin
  perform setseed(p_seed);

  -- 1. Normalized points (cosine == L2 ranking on unit vectors).
  create temp table _km_pts on commit drop as
    select id as nid, extensions.l2_normalize(embedding)::extensions.vector(768) as vec
      from public.kg_nodes
     where project_id = p_project_id and embedding is not null;

  select count(*) into v_n from _km_pts;
  if v_n = 0 then return; end if;

  v_k := greatest(1, ceil(sqrt(v_n))::int);
  if v_k > v_n then v_k := v_n; end if;

  -- 2. Seed centroids: deterministic random distinct points (setseed makes random() reproducible).
  create temp table _km_cent on commit drop as
    select (row_number() over () - 1)::int as cid, vec
      from (select vec from _km_pts order by random() limit v_k) s;

  create temp table _km_asg on commit drop as
    select nid, -1::int as cid from _km_pts;

  -- 3. Lloyd iterations.
  while v_iter < p_max_iters and v_changed > 0 loop
    with nearest as (
      select p.nid,
             (select c.cid from _km_cent c order by c.vec <=> p.vec limit 1) as cid
        from _km_pts p
    )
    update _km_asg a set cid = n.cid
      from nearest n
     where a.nid = n.nid and a.cid is distinct from n.cid;
    get diagnostics v_changed = row_count;

    update _km_cent c
       set vec = sub.mvec
      from (
        select a.cid, extensions.l2_normalize(avg(p.vec))::extensions.vector(768) as mvec
          from _km_asg a join _km_pts p on p.nid = a.nid
         group by a.cid
      ) sub
     where c.cid = sub.cid;  -- empty clusters keep their old centroid (no row in sub)

    v_iter := v_iter + 1;
  end loop;

  return query select nid, cid from _km_asg order by nid;
end;
$$;

comment on function public.kg_kmeans_assign(text, int, double precision) is
  'SCM-S55 server-side K-Means. Computes supernode assignments inside Postgres so '
  'kg_nodes.embedding never egresses. k = ceil(sqrt(N)) internally. Returns (node_id, supernode_id).';

-- service_role-only (functions are EXECUTE-public by default; revoke from anon/authenticated)
revoke all on function public.kg_kmeans_assign(text, int, double precision) from public;
grant execute on function public.kg_kmeans_assign(text, int, double precision) to service_role;
```

### Task A3: Apply migration + iterate test to green

- [ ] **Step 1: Apply to the dev DB**

Run: `npm run schema`
Expected: migration `029_kg_kmeans_server.sql` applied, no error.

- [ ] **Step 2: Run the RPC test**

Run: `node --import tsx --test tests/clustering-kmeans-rpc.test.ts`
Expected: PASS (KM1–KM5). If `avg(vector)`/`l2_normalize` errors → pgvector < 0.5.0: replace `avg(vec)` with an `unnest`/`array_agg` mean over `vector_dims`, re-run.

### Task A4: Register the new test + migration

**Files:**
- Modify: `package.json` (the `test` script file-list)

- [ ] **Step 1: Add the test file** to the `test` script's explicit file list (next to `clustering-daemon.test.ts`).
- [ ] **Step 2: Run the migration test**

Run: `node --import tsx --test tests/migrations.test.ts`
Expected: PASS — `029_kg_kmeans_server.sql` matches `/^0\d{2}_.+\.sql$/` and is picked up by the runner.

### Task A5: Swap the daemon to the RPC

**Files:**
- Modify: `src/clustering/daemon.ts` (the `runClusteringForProject` body, ~`:270-282`, where `fetchEmbeddings()` + `kmeans()` run)

- [ ] **Step 1: Write/extend the daemon test (mock-based, asserts no embedding pull)**

```ts
// tests/clustering-daemon.test.ts — add:
test("C-egress: daemon assigns supernodes via RPC and never selects kg_nodes.embedding", async () => {
  const calls: string[] = [];
  // mock supabase: record .rpc names and .select args; ensure no select("id, embedding")
  // (mirror the existing graph-daemon mock pattern in tests/graph-daemon.test.ts)
  // assert calls.includes("kg_kmeans_assign") === true
  // assert no recorded select arg contains "embedding"
});
```

- [ ] **Step 2: Run → fails** (daemon still calls `fetchEmbeddings`). Run: `node --import tsx --test tests/clustering-daemon.test.ts`

- [ ] **Step 3: Replace the client pull with the RPC**

Before (`:270-282`, approx):
```ts
const n = await countEmbeddedNodes(projectId);          // or derived from fetch
const { ids, embeddings } = await fetchEmbeddings(projectId, cfg.pageSize);
const k = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
const km = kmeans(embeddings, { k, maxIters: 50, seed: 0 });
const supernodeOf = (i: number) => km.assignments[i];   // by index
```
After:
```ts
const { data: asg, error: kmErr } = await supabase.rpc("kg_kmeans_assign", {
  p_project_id: projectId, p_max_iters: 50, p_seed: 0.42,
});
if (kmErr) throw new Error(`kg_kmeans_assign: ${kmErr.message}`);
const rows = (asg ?? []) as { node_id: number; supernode_id: number }[];
if (rows.length === 0) { /* nothing to cluster — existing empty-path behavior */ return earlyResult; }
const ids = rows.map((r) => r.node_id);
const supernodeById = new Map<number, number>(rows.map((r) => [r.node_id, r.supernode_id]));
// downstream kg_knn_pairs + per-supernode Louvain now key off supernodeById.get(nodeId)
```
Update the edge-bucketing loop (the `srcSN !== tgtSN` check) to read supernodes from `supernodeById` instead of the old index-based `km.assignments`. `kg_knn_pairs` RPC + Louvain stay unchanged.

- [ ] **Step 4: Run → passes.** `node --import tsx --test tests/clustering-daemon.test.ts`

### Task A6: Clean the orphan (kmeans.ts)

- [ ] **Step 1: Check for other importers**

Run: `grep -rn "from \"../clustering/kmeans" src tests; grep -rn "clustering/kmeans" src tests`
Expected: only the now-removed daemon call site (+ `tests/clustering-kmeans.test.ts`).

- [ ] **Step 2:** If orphaned, remove `src/clustering/kmeans.ts` and `tests/clustering-kmeans.test.ts`, and de-register the test in `package.json`. If still imported elsewhere, leave it and note why in the commit. (Constitution: clean orphans you cause.)

### Task A7: Build, full test, commit A

- [ ] **Step 1:** `npm run build` → expected: `lint:boundaries` + `tsc` + `copy:gui` all clean.
- [ ] **Step 2:** `npm test` → expected: all green.
- [ ] **Step 3: Commit**

```bash
git add scripts/029_kg_kmeans_server.sql src/clustering/daemon.ts tests/clustering-kmeans-rpc.test.ts tests/clustering-daemon.test.ts package.json
# plus kmeans.ts removal if applicable
git commit -m "feat(clustering): server-side K-Means RPC — stop egressing kg_nodes embeddings (SCM-S55)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# COMMIT B — Server-side chunk→node embedding copy (SECONDARY, ~2 GB/mo)

### Task B1: Failing test for `kg_upsert_node_from_chunk`

**Files:**
- Create: `tests/kg-upsert-from-chunk.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";

const pids: string[] = [];
after(async () => {
  for (const pid of pids) {
    await supabase.from("kg_nodes").delete().eq("project_id", pid);
    await supabase.from("memory_chunks").delete().eq("project_id", pid);
  }
});

test("UC1: node inherits the chunk embedding without the client sending a vector", async () => {
  const pid = `__test_ucfc_${randomUUID()}__`; pids.push(pid);
  const emb = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01));
  const { data: chunk } = await supabase.from("memory_chunks")
    .insert({ project_id: pid, content: "x", file_origin: "t", chunk_index: 0, metadata: {}, embedding: emb })
    .select("id").single();
  const { data: nodeId, error } = await supabase.rpc("kg_upsert_node_from_chunk", {
    p_project_id: pid, p_type: "SYMBOL", p_label: "from-chunk", p_properties: {}, p_source_chunk_id: chunk!.id,
  });
  assert.equal(error, null, error?.message);
  const { data: node } = await supabase.from("kg_nodes")
    .select("source_chunk_id, embedding").eq("id", nodeId as number).single();
  assert.equal(node!.source_chunk_id, chunk!.id);
  assert.ok(node!.embedding != null, "embedding copied server-side");
});
```

- [ ] **Step 2: Run → fails** (`could not find function kg_upsert_node_from_chunk`).
Run: `node --import tsx --test tests/kg-upsert-from-chunk.test.ts`

### Task B2: Migration 030 (the RPC, mirroring `kg_upsert_node`)

**Files:**
- Create: `scripts/030_kg_upsert_node_from_chunk.sql`
- Reference: `scripts/020_knowledge_graph.sql:118-148` (mirror `kg_upsert_node` conflict/merge semantics exactly)

- [ ] **Step 1: Write the migration**

```sql
-- 030_kg_upsert_node_from_chunk.sql
-- SCM-S55 egress fix: upsert a kg_node copying its embedding from memory_chunks
-- SERVER-SIDE by chunk_id, so the graph_extractor daemon stops egressing
-- memory_chunks.embedding to the MCP client every tick. Mirrors kg_upsert_node (020).
create or replace function public.kg_upsert_node_from_chunk(
  p_project_id text,
  p_type text,
  p_label text,
  p_properties jsonb default '{}'::jsonb,
  p_source_chunk_id bigint default null
) returns bigint
language plpgsql volatile security definer
set search_path = public, extensions, pg_catalog
as $$
declare v_id bigint; v_emb extensions.vector(768);
begin
  if p_source_chunk_id is not null then
    select embedding into v_emb from public.memory_chunks where id = p_source_chunk_id;
  end if;
  insert into public.kg_nodes (project_id, type, label, properties, embedding, source_chunk_id)
  values (p_project_id, p_type, p_label, coalesce(p_properties, '{}'::jsonb), v_emb, p_source_chunk_id)
  on conflict (project_id, type, label) do update
     set properties = public.kg_nodes.properties || excluded.properties,
         embedding = coalesce(excluded.embedding, public.kg_nodes.embedding),
         source_chunk_id = coalesce(excluded.source_chunk_id, public.kg_nodes.source_chunk_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint) is
  'SCM-S55: like kg_upsert_node but copies embedding from memory_chunks(p_source_chunk_id) in-DB. Zero vector egress.';
revoke all on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint) from public;
grant execute on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint) to service_role;
```

- [ ] **Step 2: Apply + run test → green.** `npm run schema && node --import tsx --test tests/kg-upsert-from-chunk.test.ts`
- [ ] **Step 3:** Register `tests/kg-upsert-from-chunk.test.ts` in `package.json` test list; run `tests/migrations.test.ts` → PASS.

### Task B3: Add the TS wrapper

**Files:**
- Modify: `src/tools/kg.ts` (add next to `upsertKgNode`, ~`:61-93`)

- [ ] **Step 1: Implement**

```ts
export async function upsertKgNodeFromChunk(args: {
  project_id: string; type: string; label: string;
  properties?: Record<string, unknown>; source_chunk_id: number | null;
}): Promise<number> {
  const { data, error } = await supabase.rpc("kg_upsert_node_from_chunk", {
    p_project_id: args.project_id, p_type: args.type, p_label: args.label,
    p_properties: args.properties ?? {}, p_source_chunk_id: args.source_chunk_id,
  });
  if (error) throw new Error(`kg_upsert_node_from_chunk: ${error.message}`);
  return data as number;
}
```

### Task B4: Stop selecting the embedding in the graph daemon

**Files:**
- Modify: `src/graph/daemon.ts:128-129` (select), `:199` (node write); `src/graph/extractor.ts:144` if it threads `embedding`.

- [ ] **Step 1: Extend the graph-daemon mock test** to assert the `memory_chunks` select no longer contains `"embedding"` and that `kg_upsert_node_from_chunk` is called.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Edit**

Before (`:128-129`): `.from("memory_chunks").select("id, project_id, content, metadata, embedding")`
After: `.from("memory_chunks").select("id, project_id, content, metadata")`

Before (`:199`, via `upsertKgNode({ ..., embedding: primary.embedding ?? null })`)
After: `upsertKgNodeFromChunk({ project_id, type, label, properties, source_chunk_id: primary.id })`
Remove the now-unused `embedding` field from `extractor.ts`'s assembled node object.

- [ ] **Step 4: Run → passes.**

### Task B5: Build, full test, commit B

- [ ] `npm run build` → clean.
- [ ] `npm test` → green.
- [ ] **Commit**

```bash
git add scripts/030_kg_upsert_node_from_chunk.sql src/tools/kg.ts src/graph/daemon.ts src/graph/extractor.ts tests/kg-upsert-from-chunk.test.ts tests/graph-daemon.test.ts package.json
git commit -m "feat(graph): server-side embedding copy for kg_nodes — stop egressing memory_chunks vectors (SCM-S55)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# COMMIT C — Restore daemon cadence + verify zero-egress

### Task C1: Revert the `.env` throttle

- [ ] **Step 1:** Remove the SCM-S55 block from `.env` (or set `SCM_CLUSTERING_INTERVAL_MS` / `SCM_GRAPH_EXTRACTOR_INTERVAL_MS` back to defaults). `.env` is gitignored — operational only, nothing to commit.

### Task C2: Verify zero-egress behavior

- [ ] **Step 1:** Confirm via the daemon mock tests (A5/B4) that no code path selects `embedding` from `kg_nodes`/`memory_chunks`.
- [ ] **Step 2 (optional, egress-free):** compute `count(kg_nodes WHERE embedding NOT NULL)` and confirm a clustering run now transfers only `(node_id, supernode_id)` scalars (≈ count × ~12 bytes) vs the old count × ~9 KB.

### Task C3: Restart + observe

- [ ] **Step 1:** Restart the MCP server. Run `check_system_health` → clustering + graph daemons healthy at normal cadence.
- [ ] **Step 2:** Open a PR for `fix/scm-s55-egress-leak` (audit doc + plan + Commits A/B).

---

## Self-Review

- **Spec coverage:** §4.1 clustering server-side ✓ (Commit A); §4.2 graph server-side copy ✓ (Commit B); §4.0 mitigation already applied + reverted in C1 ✓. Delta-gate intentionally dropped (YAGNI — server-side K-Means removes the egress motivation; documented in Risks).
- **Placeholder scan:** none — all SQL/TS/commands are concrete. The daemon mock-test bodies reference the existing `tests/graph-daemon.test.ts` mock pattern (a real, in-repo template) rather than inventing one.
- **Type consistency:** RPC returns `(node_id, supernode_id)`; daemon reads `r.node_id`/`r.supernode_id` and builds `supernodeById` used by the Louvain bucketing. `upsertKgNodeFromChunk` arg shape matches the RPC params. `kg_upsert_node_from_chunk` mirrors `kg_upsert_node` conflict keys `(project_id, type, label)`.
