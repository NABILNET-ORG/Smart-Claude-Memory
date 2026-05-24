// scripts/smoke-m8.3-clustering.mjs
// SCM-S41-D7 / SCM-S42 — Live E2E smoke for the M8.3 Semantic Clustering arc.
//
// Why this exists: tests/clustering-{kmeans,louvain,daemon,routes}.test.ts
// cover the unit + integration surface (Suites A-D 29/29 GREEN), but they
// stub at module boundaries. This script proves the *end-to-end* pipeline:
//   seed kg_nodes + kg_edges          (raw data layer)
//       ↓
//   runClusteringForProject(force)    (K-Means + Louvain via the real daemon)
//       ↓
//   kg_supernodes + kg_node_clusters  (Supabase persistence)
//       ↓
//   list_supernodes / list_cluster_members + getClusterGraph{Super,Drill}
//                                     (the 5 MCP / GUI-helper APIs)
//       ↓
//   GET /api/graph/clusters?level=…   (the live HTTP route on :7814)
//       ↓
//   check_system_health.clustering_scanner block
//
// Safety: every read AND every write is scoped to a hard-coded fixture
// project_id (FIXTURE_PROJECT_ID) so this script CANNOT mutate the
// production "claude-memory" data — even if it crashes mid-flight. A
// `finally` cleanup removes the fixture rows from every relevant table.
//
// Usage:
//   node scripts/smoke-m8.3-clustering.mjs
//   node scripts/smoke-m8.3-clustering.mjs --keep   (skip cleanup — debug)
//
// Exit 0 = every contract holds; exit 1 = first failure printed to stderr.

import "dotenv/config";

const FIXTURE_PROJECT_ID = "smoke-clustering-temp";
const N_PER_CLUSTER = 10;     // 3 clusters × 10 = 30 nodes total
const N_CLUSTERS_SEED = 3;
const EDGES_PER_NODE = 3;      // ~90 edges, all intra-cluster
const EMBED_DIM = 768;
const KEEP_FIXTURE = process.argv.includes("--keep");
const GUI_BASE = process.env.SCM_SMOKE_GUI_BASE ?? "http://127.0.0.1:7814";

// ── deterministic RNG (mulberry32, same family used by Louvain) ────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  // Box-Muller — one draw per call (the other half is thrown away; cheap)
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function unitVector(rng) {
  const v = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    v[i] = gaussian(rng);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

function noisyAround(center, rng, scale) {
  const v = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    v[i] = center[i] + gaussian(rng) * scale;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

// ── tiny assertion helpers ─────────────────────────────────────────────────
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? "" });
  const tag = ok ? "PASS" : "FAIL";
  console.error(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) throw new Error(`smoke check failed: ${name} — ${detail ?? ""}`);
}

// ── main flow ──────────────────────────────────────────────────────────────
const { supabase } = await import("../dist/supabase.js");
const { upsertKgNode, upsertKgEdge } = await import("../dist/tools/kg.js");
const {
  triggerClustering,
  listSupernodes,
  listClusterMembers,
  getClusterGraphSuper,
  getClusterGraphDrill,
} = await import("../dist/clustering/clusters.js");
const { checkSystemHealth } = await import("../dist/tools/health.js");

let summary = {
  fixture_project_id: FIXTURE_PROJECT_ID,
  seeded_nodes: 0,
  seeded_edges: 0,
  daemon_result: null,
  list_supernodes: null,
  list_cluster_members: null,
  cluster_graph_super: null,
  cluster_graph_drill: null,
  http_route: null,
  health_block: null,
  duration_ms: 0,
  cleanup: null,
};

const T0 = Date.now();

async function deleteFixtureRows(reason) {
  // Order matters: clear children before parents (FK-friendly even though
  // 023_kg_clustering.sql uses cascade — defensive belt + suspenders).
  // NOTE: kg_supernodes is a VIEW over kg_node_clusters (aggregation by
  // supernode_id) — purging kg_node_clusters empties the view transitively;
  // attempting a DELETE against the view errors. Daemon budget tables
  // (daemon_budget_buckets / daemon_budget_events) are per-daemon-name,
  // NOT per-project — no project_id column — so they are not fixture-
  // specific and can't be (and don't need to be) cleaned by project.
  const out = {};
  for (const table of [
    "kg_node_clusters",
    "kg_edges",
    "kg_nodes",
    "daemon_telemetry",
  ]) {
    try {
      const { error, count } = await supabase
        .from(table)
        .delete({ count: "exact" })
        .eq("project_id", FIXTURE_PROJECT_ID);
      out[table] = error ? `ERR ${error.message}` : `del ${count ?? "?"}`;
    } catch (e) {
      out[table] = `THREW ${e?.message ?? e}`;
    }
  }
  return { reason, tables: out };
}

try {
  // ── 0. Pre-flight cleanup (idempotent: prior failed run leaves no debris)
  summary.cleanup = { pre: await deleteFixtureRows("pre-flight") };

  // ── 1. Seed kg_nodes ────────────────────────────────────────────────────
  const rng = mulberry32(0x5cce5c0e); // SCM-CE5C — deterministic
  const centers = Array.from({ length: N_CLUSTERS_SEED }, () => unitVector(rng));
  const nodeIds = []; // flat list
  const idsByCluster = Array.from({ length: N_CLUSTERS_SEED }, () => []);
  for (let c = 0; c < N_CLUSTERS_SEED; c++) {
    for (let i = 0; i < N_PER_CLUSTER; i++) {
      const emb = noisyAround(centers[c], rng, 0.06);
      const r = await upsertKgNode({
        project_id: FIXTURE_PROJECT_ID,
        type: "NOTE",
        label: `smoke-c${c}-n${i}`,
        properties: { cluster_seed: c, smoke: true },
        embedding: emb,
      });
      if (!r.ok) throw new Error(`upsertKgNode failed: ${r.reason}`);
      nodeIds.push(r.node_id);
      idsByCluster[c].push(r.node_id);
    }
  }
  summary.seeded_nodes = nodeIds.length;
  check("seed 30 nodes", nodeIds.length === 30, `got ${nodeIds.length}`);

  // ── 2. Seed kg_edges (intra-cluster only — Louvain finds these) ─────────
  let edgesSeeded = 0;
  for (let c = 0; c < N_CLUSTERS_SEED; c++) {
    const ids = idsByCluster[c];
    for (let i = 0; i < ids.length; i++) {
      // Connect to next-EDGES_PER_NODE ids in the ring (intra-cluster ring).
      for (let k = 1; k <= EDGES_PER_NODE; k++) {
        const src = ids[i];
        const tgt = ids[(i + k) % ids.length];
        const r = await upsertKgEdge({
          project_id: FIXTURE_PROJECT_ID,
          source_id: src,
          target_id: tgt,
          relation: "smoke_ring",
          weight: 1,
        });
        if (r.ok) edgesSeeded++;
      }
    }
  }
  summary.seeded_edges = edgesSeeded;
  check("seed >=60 edges", edgesSeeded >= 60, `got ${edgesSeeded}`);

  // ── 3. Run the clustering daemon (force=true, bypass dirty check) ──────
  const t1 = Date.now();
  const r = await triggerClustering({ project_id: FIXTURE_PROJECT_ID, force: true });
  summary.daemon_result = { ...r, duration_ms: Date.now() - t1 };
  check("daemon ok", r.ok === true, JSON.stringify({ status: r.status }));
  check(
    "kmeans produced supernodes",
    (r.supernodes_created ?? 0) >= 2,
    `supernodes_created=${r.supernodes_created} kmeans_k=${r.kmeans_k}`,
  );
  check(
    "louvain produced communities",
    (r.louvain_communities ?? 0) >= 2,
    `louvain_communities=${r.louvain_communities}`,
  );
  check(
    "rows_upserted == nodes",
    (r.rows_upserted ?? 0) === summary.seeded_nodes,
    `rows_upserted=${r.rows_upserted} expected=${summary.seeded_nodes}`,
  );

  // ── 4. list_supernodes ─────────────────────────────────────────────────
  const supers = await listSupernodes({ project_id: FIXTURE_PROJECT_ID, limit: 50 });
  summary.list_supernodes = { ok: supers.ok, count: supers.ok ? supers.rows.length : 0 };
  check("list_supernodes ok", supers.ok === true);
  check(
    "supers >= 2",
    supers.ok && supers.rows.length >= 2,
    `count=${supers.ok ? supers.rows.length : "n/a"}`,
  );
  const firstSnId = supers.ok ? supers.rows[0].supernode_id : -1;

  // ── 5. list_cluster_members ────────────────────────────────────────────
  const members = await listClusterMembers({
    project_id: FIXTURE_PROJECT_ID,
    supernode_id: firstSnId,
    limit: 50,
  });
  summary.list_cluster_members = {
    ok: members.ok,
    count: members.ok ? members.rows.length : 0,
    supernode_id: firstSnId,
  };
  check("list_cluster_members ok", members.ok === true);
  check(
    "members >= 1",
    members.ok && members.rows.length >= 1,
    `count=${members.ok ? members.rows.length : "n/a"}`,
  );
  // listClusterMembers' server-side filter on supernode_id is what scopes the
  // page (clusters.ts lines 117-121); the per-row shape (ClusterMemberRow) is
  // {node_id, label, type, community_id} and does NOT echo supernode_id, so we
  // assert the filter applied by checking the envelope's supernode_id field +
  // a sanity bound on row count (≤ N_PER_CLUSTER × N_CLUSTERS_SEED).
  check(
    "members payload echoes the queried supernode_id",
    members.ok && members.supernode_id === firstSnId,
    `envelope.supernode_id=${members.ok ? members.supernode_id : "n/a"} expected=${firstSnId}`,
  );
  check(
    "members count is bounded by seed size",
    members.ok && members.rows.length <= N_PER_CLUSTER * N_CLUSTERS_SEED,
    `count=${members.ok ? members.rows.length : "n/a"}`,
  );

  // ── 6. getClusterGraphSuper (GUI helper) ───────────────────────────────
  const cgSuper = await getClusterGraphSuper(FIXTURE_PROJECT_ID);
  summary.cluster_graph_super = {
    ok: cgSuper.ok,
    nodes: cgSuper.ok ? cgSuper.nodes.length : 0,
    edges: cgSuper.ok ? cgSuper.edges.length : 0,
  };
  check("getClusterGraphSuper ok", cgSuper.ok === true);
  check(
    "super graph node count == supernodes",
    cgSuper.ok && cgSuper.nodes.length === supers.rows.length,
    `gNodes=${cgSuper.ok ? cgSuper.nodes.length : 0} supers=${supers.rows.length}`,
  );
  check(
    "super graph node ids prefixed 'S:'",
    cgSuper.ok && cgSuper.nodes.every((n) => typeof n.id === "string" && n.id.startsWith("S:")),
    "id prefix mismatch",
  );

  // ── 7. getClusterGraphDrill on the first supernode ─────────────────────
  const cgDrill = await getClusterGraphDrill(FIXTURE_PROJECT_ID, firstSnId);
  summary.cluster_graph_drill = {
    ok: cgDrill.ok,
    mode: cgDrill.ok ? cgDrill.mode : null,
    nodes: cgDrill.ok ? cgDrill.nodes.length : 0,
    supernode_id: firstSnId,
  };
  check("getClusterGraphDrill ok", cgDrill.ok === true);
  check(
    "drill mode == members (<200 members)",
    cgDrill.ok && cgDrill.mode === "members",
    `mode=${cgDrill.ok ? cgDrill.mode : "n/a"}`,
  );
  check(
    "drill node count matches members",
    cgDrill.ok && cgDrill.nodes.length === members.rows.length,
    `drillNodes=${cgDrill.ok ? cgDrill.nodes.length : 0} members=${members.rows.length}`,
  );

  // ── 8. Live HTTP route on the running GUI ──────────────────────────────
  // The GUI server auto-started by init_project may be an older dist snapshot
  // — surface that as a soft check (warn but do not fail) if unreachable,
  // since the route contract is already verified by Suite D against the new
  // dist via createGuiServer().
  let httpOk = false;
  try {
    const resp = await fetch(
      `${GUI_BASE}/api/graph/clusters?level=super&project_id=${encodeURIComponent(
        FIXTURE_PROJECT_ID,
      )}`,
    );
    const body = await resp.json();
    summary.http_route = {
      status: resp.status,
      ok: body && body.ok,
      level: body && body.level,
      nodes: body && Array.isArray(body.nodes) ? body.nodes.length : 0,
    };
    httpOk =
      resp.status === 200 &&
      body.ok === true &&
      body.level === "super" &&
      Array.isArray(body.nodes) &&
      body.nodes.length === supers.rows.length;
    check("live HTTP /api/graph/clusters?level=super 200+ok", httpOk, JSON.stringify(summary.http_route));
  } catch (e) {
    summary.http_route = { reachable: false, error: e?.message ?? String(e) };
    console.error(
      `[WARN] live GUI at ${GUI_BASE} unreachable — HTTP contract proven by Suite D instead. ${summary.http_route.error}`,
    );
  }

  // ── 9. check_system_health surfaces the clustering_scanner block ───────
  const health = await checkSystemHealth();
  summary.health_block = {
    present: !!health.clustering_scanner,
    derived_status: health.clustering_scanner?.derived?.status ?? null,
    derived_reason: health.clustering_scanner?.derived?.reason ?? null,
  };
  check(
    "health.clustering_scanner present",
    !!health.clustering_scanner,
    "block missing from checkSystemHealth() output",
  );
  check(
    "health.clustering_scanner.derived.status set",
    typeof health.clustering_scanner?.derived?.status === "string",
    `derived=${JSON.stringify(health.clustering_scanner?.derived ?? null)}`,
  );
} catch (e) {
  console.error(`\n[smoke] FAIL — ${e?.message ?? e}`);
  summary.error = e?.message ?? String(e);
} finally {
  if (KEEP_FIXTURE) {
    console.error("[smoke] --keep flag set — leaving fixture rows in place for inspection");
    summary.cleanup = { ...(summary.cleanup ?? {}), post: { skipped: "--keep" } };
  } else {
    summary.cleanup = { ...(summary.cleanup ?? {}), post: await deleteFixtureRows("post-run") };
  }
  summary.duration_ms = Date.now() - T0;
}

const allPass = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok: allPass, checks, summary }, null, 2));
process.exit(allPass ? 0 : 1);
