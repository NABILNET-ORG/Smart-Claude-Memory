// M8.3 Suite C — integration tests for the clustering scanner daemon.
// Hits a live Supabase under unique `__test_clustering_*` project_ids so
// cleanup is one CASCADE per suite. The migration runner inside
// init_project applies 023_kg_clustering.sql before this runs.

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { upsertKgNode } from "../src/tools/kg.js";
import {
  runClusteringForProject,
  isDirty,
  discoverProjects,
} from "../src/clustering/daemon.js";

const createdProjectIds: string[] = [];

function newProject(tag = ""): string {
  const id = `__test_clustering_${tag}_${randomUUID().slice(0, 8)}__`;
  createdProjectIds.push(id);
  return id;
}

/** Deterministic ~unit-length 768-dim vector seeded on `seed`. */
function unitVector(seed: number): number[] {
  const v = new Array(768);
  let acc = 0;
  for (let i = 0; i < 768; i++) {
    const x = Math.sin((seed + 1) * (i + 1) * 0.013);
    v[i] = x;
    acc += x * x;
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

async function seedNodes(
  projectId: string,
  count: number,
  opts: { withEmbedding?: boolean; seedOffset?: number } = {},
): Promise<number[]> {
  const withEmb = opts.withEmbedding !== false;
  const seedOff = opts.seedOffset ?? 0;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = await upsertKgNode({
      project_id: projectId,
      type: "TEST",
      label: `node-${i}-${randomUUID().slice(0, 4)}`,
      embedding: withEmb ? unitVector(seedOff + i) : null,
    });
    if (r.ok) ids.push(r.node_id);
  }
  return ids;
}

after(async () => {
  // CASCADE on kg_node_clusters.node_id wipes the cluster rows too.
  for (const pid of createdProjectIds) {
    await supabase.from("kg_nodes").delete().eq("project_id", pid);
  }
});

// ─── C1: isDirty true on a fresh project (no clusters yet) ────────────────
test("C1: isDirty returns true when no kg_node_clusters rows exist for the project", async () => {
  const pid = newProject("c1");
  await seedNodes(pid, 5);
  const dirty = await isDirty(pid);
  assert.equal(dirty, true, "fresh project with embedded nodes but no clusters must be dirty");
});

// ─── C2: isDirty false immediately after a successful run ────────────────
test("C2: isDirty returns false right after a successful run", async () => {
  const pid = newProject("c2");
  await seedNodes(pid, 8);
  const r = await runClusteringForProject(pid);
  assert.equal(r.status, "clustered", `first run should cluster, got ${r.status}`);
  const dirty = await isDirty(pid);
  assert.equal(dirty, false, "post-run isDirty must be false (counts match, watermarks fresh)");
});

// ─── C3: First run populates kg_node_clusters for every embedded node ────
test("C3: first run inserts one kg_node_clusters row per embedded kg_node", async () => {
  const pid = newProject("c3");
  const seeded = await seedNodes(pid, 12);
  assert.equal(seeded.length, 12);
  const r = await runClusteringForProject(pid);
  assert.equal(r.status, "clustered");
  assert.equal(r.embeddings_loaded, 12);
  assert.equal(r.rows_upserted, 12);
  assert.ok(r.kmeans_k >= 1 && r.kmeans_k <= 12, `kmeans_k in [1,12], got ${r.kmeans_k}`);

  const { count, error } = await supabase
    .from("kg_node_clusters")
    .select("*", { count: "exact", head: true })
    .eq("project_id", pid);
  assert.equal(error, null);
  assert.equal(count, 12, "every embedded kg_node must have a kg_node_clusters row");
});

// ─── C4: NULL embeddings are skipped gracefully ──────────────────────────
test("C4: nodes with NULL embedding are skipped (no kg_node_clusters row)", async () => {
  const pid = newProject("c4");
  await seedNodes(pid, 6, { withEmbedding: true, seedOffset: 100 });
  await seedNodes(pid, 4, { withEmbedding: false }); // 4 NULL-embedding nodes
  const r = await runClusteringForProject(pid);
  assert.equal(r.status, "clustered");
  assert.equal(r.embeddings_loaded, 6, "only embedded nodes count");
  assert.equal(r.rows_upserted, 6);

  const { count } = await supabase
    .from("kg_node_clusters")
    .select("*", { count: "exact", head: true })
    .eq("project_id", pid);
  assert.equal(count, 6, "NULL-embedding nodes must NOT appear in kg_node_clusters");
});

// ─── C5: ARM gate registers clustering_scanner in daemon_budget_buckets ──
test("C5: ARM gate writes a daemon_budget_buckets row for clustering_scanner", async () => {
  const pid = newProject("c5");
  await seedNodes(pid, 4);
  // Force the budget gate to register (mode='off' short-circuits without an
  // increment write). Restore env immediately after.
  const prevMode = process.env.SCM_BUDGET_ENFORCEMENT_MODE;
  process.env.SCM_BUDGET_ENFORCEMENT_MODE = "warn";
  try {
    const r = await runClusteringForProject(pid);
    assert.equal(r.status, "clustered");
  } finally {
    if (prevMode === undefined) delete process.env.SCM_BUDGET_ENFORCEMENT_MODE;
    else process.env.SCM_BUDGET_ENFORCEMENT_MODE = prevMode;
  }

  const hourStartIso = new Date(Date.now() - (Date.now() % 3_600_000)).toISOString();
  const { data, error } = await supabase
    .from("daemon_budget_buckets")
    .select("daemon, axis, hour_bucket, count")
    .eq("daemon", "clustering_scanner")
    .eq("axis", "ollama_calls")
    .gte("hour_bucket", hourStartIso)
    .limit(1);
  assert.equal(error, null);
  assert.ok(
    Array.isArray(data) && data.length === 1,
    "clustering_scanner bucket row must exist for the current hour after the run",
  );
});

// ─── C6: Per-project isolation ───────────────────────────────────────────
test("C6: a clustering run on project A does NOT touch project B's clusters", async () => {
  const pidA = newProject("c6a");
  const pidB = newProject("c6b");
  await seedNodes(pidA, 5, { seedOffset: 200 });
  await seedNodes(pidB, 5, { seedOffset: 300 });

  const rA = await runClusteringForProject(pidA);
  assert.equal(rA.status, "clustered");

  const [{ count: cA }, { count: cB }] = await Promise.all([
    supabase
      .from("kg_node_clusters")
      .select("*", { count: "exact", head: true })
      .eq("project_id", pidA),
    supabase
      .from("kg_node_clusters")
      .select("*", { count: "exact", head: true })
      .eq("project_id", pidB),
  ]);
  assert.equal(cA, 5, "project A must have its 5 cluster rows");
  assert.equal(cB, 0, "project B must remain untouched (zero cluster rows)");
});

// ─── C7: Idempotent re-run returns not_dirty without doing work ──────────
test("C7: a second run with no changes returns status='not_dirty'", async () => {
  const pid = newProject("c7");
  await seedNodes(pid, 6);
  const r1 = await runClusteringForProject(pid);
  assert.equal(r1.status, "clustered");

  const r2 = await runClusteringForProject(pid);
  assert.equal(r2.status, "not_dirty", `second run should short-circuit, got ${r2.status}`);
  assert.equal(r2.rows_upserted, 0, "no UPSERTs on a no-op tick");
});

// ─── C8: Smoke — 50-node project completes the full pipeline ─────────────
test("C8: smoke — 50 embedded nodes cluster end-to-end with full coverage", async () => {
  const pid = newProject("c8");
  await seedNodes(pid, 50, { seedOffset: 1000 });

  // Also assert discoverProjects can find this project's id (proves the
  // round-robin selector is universal — no hardcoded names).
  const found = await discoverProjects();
  assert.ok(found.includes(pid), "discoverProjects must surface the test project_id");

  const r = await runClusteringForProject(pid);
  assert.equal(r.status, "clustered");
  assert.equal(r.embeddings_loaded, 50);
  assert.equal(r.rows_upserted, 50);
  // K = ceil(sqrt(50)) = 8
  assert.equal(r.kmeans_k, 8, `expected K=ceil(sqrt(50))=8, got ${r.kmeans_k}`);
  assert.ok(r.duration_ms < 10_000, `50-node smoke should be < 10s, got ${r.duration_ms}ms`);

  // Every supernode_id must be in [0, kmeans_k) and every community_id >= 0.
  const { data, error } = await supabase
    .from("kg_node_clusters")
    .select("supernode_id, community_id")
    .eq("project_id", pid);
  assert.equal(error, null);
  assert.equal(data?.length, 50);
  for (const row of data!) {
    assert.ok(
      row.supernode_id >= 0 && row.supernode_id < r.kmeans_k,
      `supernode_id out of range: ${row.supernode_id}`,
    );
    assert.ok(row.community_id >= 0, `community_id must be >= 0, got ${row.community_id}`);
  }
});
