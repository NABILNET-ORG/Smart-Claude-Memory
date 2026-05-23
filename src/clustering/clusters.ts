// M8.3 Task 4 — MCP tool surface for the clustering side-table.
//
// Three tools that read kg_node_clusters + the kg_supernodes view, plus one
// manual run trigger that delegates to runClusteringForProject (Task 3).
// All are project-id parameterised; never hardcoded.

import { z } from "zod";
import { supabase } from "../supabase.js";
import { currentProjectId, slugify } from "../project.js";
import {
  runClusteringForProject,
  type RunProjectResult,
} from "./daemon.js";

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

function resolvePid(pid?: string): string {
  if (typeof pid === "string" && pid.trim().length > 0) return pid;
  return slugify(currentProjectId);
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return LIST_DEFAULT_LIMIT;
  const i = Math.trunc(raw);
  if (i < 1) return 1;
  if (i > LIST_MAX_LIMIT) return LIST_MAX_LIMIT;
  return i;
}

function clampOffset(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const i = Math.trunc(raw);
  return i < 0 ? 0 : i;
}

// ─── list_supernodes ──────────────────────────────────────────────────────

export type ListSupernodesInput = {
  project_id?: string;
  limit?: number;
  offset?: number;
};

export type SupernodeRow = {
  supernode_id: number;
  node_count: number;
  top_labels: string[];
  computed_at: string;
};

export type ListSupernodesOutput =
  | { ok: true; project_id: string; rows: SupernodeRow[]; total: number }
  | { ok: false; reason: string };

export async function listSupernodes(input: ListSupernodesInput): Promise<ListSupernodesOutput> {
  const pid = resolvePid(input.project_id);
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);

  const [{ count, error: cErr }, { data, error: dErr }] = await Promise.all([
    supabase
      .from("kg_supernodes")
      .select("*", { count: "exact", head: true })
      .eq("project_id", pid),
    supabase
      .from("kg_supernodes")
      .select("supernode_id, node_count, top_labels, computed_at")
      .eq("project_id", pid)
      .order("supernode_id", { ascending: true })
      .range(offset, offset + limit - 1),
  ]);

  if (cErr || dErr) {
    return { ok: false, reason: `list_supernodes_db_error: ${(cErr ?? dErr)!.message}` };
  }
  const rows: SupernodeRow[] = (data ?? []).map((r) => ({
    supernode_id: Number(r.supernode_id),
    node_count: Number(r.node_count),
    top_labels: Array.isArray(r.top_labels) ? (r.top_labels as string[]) : [],
    computed_at: String(r.computed_at),
  }));
  return { ok: true, project_id: pid, rows, total: count ?? rows.length };
}

// ─── list_cluster_members ─────────────────────────────────────────────────

export type ListClusterMembersInput = {
  project_id?: string;
  supernode_id: number;
  community_id?: number;
  limit?: number;
  offset?: number;
};

export type ClusterMemberRow = {
  node_id: number;
  label: string;
  type: string;
  community_id: number;
};

export type ListClusterMembersOutput =
  | { ok: true; project_id: string; supernode_id: number; rows: ClusterMemberRow[]; total: number }
  | { ok: false; reason: string };

export async function listClusterMembers(
  input: ListClusterMembersInput,
): Promise<ListClusterMembersOutput> {
  if (!Number.isInteger(input.supernode_id) || input.supernode_id < 0) {
    return { ok: false, reason: "supernode_id must be a non-negative integer" };
  }
  const pid = resolvePid(input.project_id);
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);

  let countQuery = supabase
    .from("kg_node_clusters")
    .select("*", { count: "exact", head: true })
    .eq("project_id", pid)
    .eq("supernode_id", input.supernode_id);
  if (typeof input.community_id === "number") {
    countQuery = countQuery.eq("community_id", input.community_id);
  }
  const { count, error: cErr } = await countQuery;
  if (cErr) return { ok: false, reason: `list_cluster_members_count: ${cErr.message}` };

  // Page the cluster rows then enrich with kg_nodes label/type — done in two
  // round-trips because PostgREST doesn't materialise a SQL JOIN across the
  // two tables for an arbitrary supernode page.
  let memQuery = supabase
    .from("kg_node_clusters")
    .select("node_id, community_id")
    .eq("project_id", pid)
    .eq("supernode_id", input.supernode_id)
    .order("node_id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (typeof input.community_id === "number") {
    memQuery = memQuery.eq("community_id", input.community_id);
  }
  const { data: mems, error: mErr } = await memQuery;
  if (mErr) return { ok: false, reason: `list_cluster_members_rows: ${mErr.message}` };
  const memRows = (mems ?? []) as Array<{ node_id: number | string; community_id: number | string }>;
  if (memRows.length === 0) {
    return { ok: true, project_id: pid, supernode_id: input.supernode_id, rows: [], total: count ?? 0 };
  }
  const nodeIds = memRows.map((r) => Number(r.node_id));
  const { data: nodes, error: nErr } = await supabase
    .from("kg_nodes")
    .select("id, label, type")
    .in("id", nodeIds);
  if (nErr) return { ok: false, reason: `list_cluster_members_nodes: ${nErr.message}` };
  const meta = new Map<number, { label: string; type: string }>();
  for (const n of nodes ?? []) {
    meta.set(Number((n as { id: number | string }).id), {
      label: String((n as { label: string }).label),
      type: String((n as { type: string }).type),
    });
  }
  const rows: ClusterMemberRow[] = memRows.map((m) => {
    const md = meta.get(Number(m.node_id));
    return {
      node_id: Number(m.node_id),
      label: md?.label ?? "(unknown)",
      type: md?.type ?? "(unknown)",
      community_id: Number(m.community_id),
    };
  });
  return { ok: true, project_id: pid, supernode_id: input.supernode_id, rows, total: count ?? rows.length };
}

// ─── trigger_clustering ───────────────────────────────────────────────────

export type TriggerClusteringInput = {
  project_id?: string;
  force?: boolean;
};

export type TriggerClusteringOutput = RunProjectResult & { triggered_at: string };

export async function triggerClustering(
  input: TriggerClusteringInput,
): Promise<TriggerClusteringOutput> {
  const pid = resolvePid(input.project_id);
  const triggered_at = new Date().toISOString();
  const r = await runClusteringForProject(pid, { force: input.force === true });
  return { ...r, triggered_at };
}

// ─── GUI helper: cluster graph payload ────────────────────────────────────
// Powers the /api/graph/clusters HTTP route. Two modes:
//   level=super  → Super Node view (one node per supernode, edges aggregated
//                  by crossing-supernode count over kg_edges)
//   level=drill  → Members of one supernode + their in-cluster kg_edges; if
//                  >GRAPH_NODE_LIMIT, nest by community_id

export const CLUSTER_GRAPH_NODE_LIMIT = 200;
const CLUSTER_GRAPH_EDGE_FETCH_LIMIT = 5000;

export type ClusterGraphSuperPayload = {
  ok: true;
  level: "super";
  project_id: string;
  nodes: Array<{ id: string; supernode_id: number; label: string; node_count: number }>;
  edges: Array<{ source: string; target: string; weight: number }>;
  computed_at: string | null;
};

export type ClusterGraphDrillPayload = {
  ok: true;
  level: "drill";
  mode: "members" | "community-nested";
  project_id: string;
  supernode_id: number;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
};

export type ClusterGraphFailure = { ok: false; reason: string };

export async function getClusterGraphSuper(
  projectId: string,
): Promise<ClusterGraphSuperPayload | ClusterGraphFailure> {
  // Super Node summary (clamped — K=√N never exceeds CLUSTER_GRAPH_NODE_LIMIT).
  const supers = await listSupernodes({ project_id: projectId, limit: CLUSTER_GRAPH_NODE_LIMIT });
  if (!supers.ok) return { ok: false, reason: supers.reason };
  if (supers.rows.length === 0) {
    return {
      ok: true,
      level: "super",
      project_id: projectId,
      nodes: [],
      edges: [],
      computed_at: null,
    };
  }
  const nodes = supers.rows.map((s) => ({
    id: `S:${s.supernode_id}`,
    supernode_id: s.supernode_id,
    label: s.top_labels[0] ?? `Cluster ${s.supernode_id}`,
    node_count: s.node_count,
  }));

  // Aggregate cross-supernode kg_edges. Two fetches + JS aggregation keep
  // this migration-free; per spec section 4.3 the operator-facing layer is
  // small enough that client-side rollup is fine.
  const { data: memData, error: memErr } = await supabase
    .from("kg_node_clusters")
    .select("node_id, supernode_id")
    .eq("project_id", projectId);
  if (memErr) return { ok: false, reason: `cluster_graph_members: ${memErr.message}` };
  const nodeToSN = new Map<number, number>();
  for (const row of memData ?? []) {
    nodeToSN.set(Number((row as { node_id: number | string }).node_id), Number((row as { supernode_id: number | string }).supernode_id));
  }

  const { data: edgeData, error: edgeErr } = await supabase
    .from("kg_edges")
    .select("source_id, target_id, weight")
    .eq("project_id", projectId)
    .limit(CLUSTER_GRAPH_EDGE_FETCH_LIMIT);
  if (edgeErr) return { ok: false, reason: `cluster_graph_edges: ${edgeErr.message}` };

  const weights = new Map<string, number>();
  for (const e of edgeData ?? []) {
    const sId = Number((e as { source_id: number | string }).source_id);
    const tId = Number((e as { target_id: number | string }).target_id);
    const sSN = nodeToSN.get(sId);
    const tSN = nodeToSN.get(tId);
    if (sSN === undefined || tSN === undefined || sSN === tSN) continue;
    const lo = Math.min(sSN, tSN);
    const hi = Math.max(sSN, tSN);
    const key = `${lo}|${hi}`;
    const w = Number((e as { weight?: number }).weight ?? 1);
    weights.set(key, (weights.get(key) ?? 0) + w);
  }
  const edges = [...weights.entries()].map(([k, w]) => {
    const [src, tgt] = k.split("|").map((s) => Number(s));
    return { source: `S:${src}`, target: `S:${tgt}`, weight: w };
  });

  return {
    ok: true,
    level: "super",
    project_id: projectId,
    nodes,
    edges,
    computed_at: supers.rows[0]?.computed_at ?? null,
  };
}

export async function getClusterGraphDrill(
  projectId: string,
  supernodeId: number,
): Promise<ClusterGraphDrillPayload | ClusterGraphFailure> {
  const members = await listClusterMembers({
    project_id: projectId,
    supernode_id: supernodeId,
    limit: CLUSTER_GRAPH_NODE_LIMIT,
  });
  if (!members.ok) return { ok: false, reason: members.reason };

  // If the supernode is large, return a community-nested payload (one node
  // per community_id) rather than choking the renderer with raw members.
  if (members.total > CLUSTER_GRAPH_NODE_LIMIT) {
    const grouped = new Map<number, number>(); // community_id → count
    let pageOffset = 0;
    while (true) {
      const page = await listClusterMembers({
        project_id: projectId,
        supernode_id: supernodeId,
        limit: LIST_MAX_LIMIT,
        offset: pageOffset,
      });
      if (!page.ok) return { ok: false, reason: page.reason };
      if (page.rows.length === 0) break;
      for (const m of page.rows) grouped.set(m.community_id, (grouped.get(m.community_id) ?? 0) + 1);
      if (page.rows.length < LIST_MAX_LIMIT) break;
      pageOffset += LIST_MAX_LIMIT;
    }
    const nestedNodes = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CLUSTER_GRAPH_NODE_LIMIT)
      .map(([cid, count]) => ({
        id: `S:${supernodeId}:C:${cid}`,
        supernode_id: supernodeId,
        community_id: cid,
        label: `Community ${cid}`,
        node_count: count,
      }));
    return {
      ok: true,
      level: "drill",
      mode: "community-nested",
      project_id: projectId,
      supernode_id: supernodeId,
      nodes: nestedNodes,
      edges: [],
    };
  }

  const nodes = members.rows.map((m) => ({
    id: `N:${m.node_id}`,
    node_id: m.node_id,
    label: m.label,
    type: m.type,
    community_id: m.community_id,
  }));
  const nodeIds = members.rows.map((m) => m.node_id);
  if (nodeIds.length === 0) {
    return {
      ok: true,
      level: "drill",
      mode: "members",
      project_id: projectId,
      supernode_id: supernodeId,
      nodes,
      edges: [],
    };
  }
  const { data: edgeData, error: edgeErr } = await supabase
    .from("kg_edges")
    .select("source_id, target_id, weight, relation")
    .eq("project_id", projectId)
    .in("source_id", nodeIds)
    .in("target_id", nodeIds);
  if (edgeErr) return { ok: false, reason: `cluster_graph_drill_edges: ${edgeErr.message}` };
  const edges = (edgeData ?? []).map((e) => ({
    source: `N:${Number((e as { source_id: number | string }).source_id)}`,
    target: `N:${Number((e as { target_id: number | string }).target_id)}`,
    weight: Number((e as { weight?: number }).weight ?? 1),
    relation: String((e as { relation?: string }).relation ?? ""),
  }));
  return {
    ok: true,
    level: "drill",
    mode: "members",
    project_id: projectId,
    supernode_id: supernodeId,
    nodes,
    edges,
  };
}

// ─── MCP InputShape exports (Zod, matches src/tools/kg.ts pattern) ────────

export const listSupernodesInputShape = {
  project_id: z
    .string()
    .min(1)
    .optional()
    .describe("Project namespace. Defaults to the slugified cwd (universal — never hardcoded)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(LIST_MAX_LIMIT)
    .optional()
    .describe(`Page size (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
};

export const listClusterMembersInputShape = {
  project_id: z.string().min(1).optional().describe("Project namespace; defaults to slugified cwd."),
  supernode_id: z
    .number()
    .int()
    .min(0)
    .describe("Coarse K-Means cluster id from list_supernodes."),
  community_id: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Optional Louvain community filter within the supernode."),
  limit: z
    .number()
    .int()
    .positive()
    .max(LIST_MAX_LIMIT)
    .optional()
    .describe(`Page size (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
};

export const triggerClusteringInputShape = {
  project_id: z.string().min(1).optional().describe("Project namespace; defaults to slugified cwd."),
  force: z
    .boolean()
    .optional()
    .describe("Bypass the dirty-check and re-cluster even if no changes detected."),
};
