// M8 Phase 3 — Knowledge Graph access layer.
//
// Thin async wrappers around the SQL RPCs introduced in migrations
// 020_knowledge_graph.sql and 029_kg_upsert_node_from_chunk.sql:
//
//   - kg_upsert_node             → upsertKgNode
//   - kg_upsert_node_from_chunk  → upsertKgNodeFromChunk  (SCM-S55)
//   - kg_upsert_edge             → upsertKgEdge
//   - kg_hybrid_search           → kgHybridSearch
//
// Plus two enumeration helpers (listKgNodes / listKgEdges) for the
// Sovereign Command Center and downstream audit. The handlers follow the
// same shape contract as src/tools/graduation.ts — discriminated unions
// for write paths, plain rows for reads — so wiring into src/index.ts
// mirrors the M7 pattern.
//
// Boundary Invariant #1: this file imports zero LLM endpoints. Embeddings
// arrive pre-computed from the Orchestrator; the layer is pure DB.

import { z } from "zod";
import { supabase } from "../supabase.js";

// ─── Shared types ────────────────────────────────────────────────────────

export type KgNodeRow = {
  id: number;
  project_id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  source_chunk_id: number | null;
  created_at: string;
  updated_at: string;
};

export type KgEdgeRow = {
  id: number;
  project_id: string;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  properties: Record<string, unknown>;
  created_at: string;
};

// ─── upsertKgNode ────────────────────────────────────────────────────────

export type UpsertKgNodeInput = {
  project_id: string;
  type: string;
  label: string;
  properties?: Record<string, unknown>;
  embedding?: number[] | null;
  source_chunk_id?: number | null;
};

export type UpsertKgNodeOutput =
  | { ok: true; node_id: number }
  | { ok: false; reason: string };

export async function upsertKgNode(input: UpsertKgNodeInput): Promise<UpsertKgNodeOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { ok: false, reason: "project_id_required" };
  }
  if (!input.type || input.type.trim().length === 0) {
    return { ok: false, reason: "type_required" };
  }
  if (!input.label || input.label.trim().length === 0) {
    return { ok: false, reason: "label_required" };
  }
  if (input.embedding != null && input.embedding.length !== 768) {
    return {
      ok: false,
      reason: `embedding_dim_mismatch: expected 768, got ${input.embedding.length}`,
    };
  }

  const { data, error } = await supabase.rpc("kg_upsert_node", {
    p_project_id: input.project_id,
    p_type: input.type,
    p_label: input.label,
    p_properties: input.properties ?? {},
    p_embedding: input.embedding ?? null,
    p_source_chunk_id: input.source_chunk_id ?? null,
  });

  if (error) return { ok: false, reason: `kg_upsert_node_db_error: ${error.message}` };
  const nodeId = Number(data);
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return { ok: false, reason: "kg_upsert_node_invalid_response" };
  }
  return { ok: true, node_id: nodeId };
}

// ─── upsertKgNodeFromChunk ───────────────────────────────────────────────
// SCM-S55 — Server-side embedding copy. Calls kg_upsert_node_from_chunk RPC
// which reads memory_chunks.embedding inside Postgres, so the 768-dim vector
// never crosses the wire. Use this from the graph-extractor daemon instead of
// upsertKgNode when a source_chunk_id is available.

export type UpsertKgNodeFromChunkInput = {
  project_id: string;
  type: string;
  label: string;
  properties?: Record<string, unknown>;
  source_chunk_id: number;
};

export async function upsertKgNodeFromChunk(
  input: UpsertKgNodeFromChunkInput,
): Promise<UpsertKgNodeOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { ok: false, reason: "project_id_required" };
  }
  if (!input.type || input.type.trim().length === 0) {
    return { ok: false, reason: "type_required" };
  }
  if (!input.label || input.label.trim().length === 0) {
    return { ok: false, reason: "label_required" };
  }

  const { data, error } = await supabase.rpc("kg_upsert_node_from_chunk", {
    p_project_id: input.project_id,
    p_type: input.type,
    p_label: input.label,
    p_properties: input.properties ?? {},
    p_source_chunk_id: input.source_chunk_id,
  });

  if (error) {
    return { ok: false, reason: `kg_upsert_node_from_chunk_db_error: ${error.message}` };
  }
  const nodeId = Number(data);
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return { ok: false, reason: "kg_upsert_node_from_chunk_invalid_response" };
  }
  return { ok: true, node_id: nodeId };
}

// ─── upsertKgEdge ────────────────────────────────────────────────────────

export type UpsertKgEdgeInput = {
  project_id: string;
  source_id: number;
  target_id: number;
  relation: string;
  weight?: number;
  properties?: Record<string, unknown>;
};

export type UpsertKgEdgeOutput =
  | { ok: true; edge_id: number }
  | { ok: false; reason: string };

export async function upsertKgEdge(input: UpsertKgEdgeInput): Promise<UpsertKgEdgeOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { ok: false, reason: "project_id_required" };
  }
  if (!input.source_id || !input.target_id) {
    return { ok: false, reason: "endpoint_ids_required" };
  }
  if (input.source_id === input.target_id) {
    return { ok: false, reason: "self_loop_forbidden" };
  }
  if (!input.relation || input.relation.trim().length === 0) {
    return { ok: false, reason: "relation_required" };
  }

  const { data, error } = await supabase.rpc("kg_upsert_edge", {
    p_project_id: input.project_id,
    p_source_id: input.source_id,
    p_target_id: input.target_id,
    p_relation: input.relation,
    p_weight: input.weight ?? 1.0,
    p_properties: input.properties ?? {},
  });

  if (error) return { ok: false, reason: `kg_upsert_edge_db_error: ${error.message}` };
  const edgeId = Number(data);
  if (!Number.isFinite(edgeId) || edgeId <= 0) {
    return { ok: false, reason: "kg_upsert_edge_invalid_response" };
  }
  return { ok: true, edge_id: edgeId };
}

// ─── kgHybridSearch ──────────────────────────────────────────────────────

export type KgHybridSearchInput = {
  project_id: string;
  query_embedding: number[];
  seed_limit?: number;
  neighbor_hops?: number;
  min_similarity?: number;
};

export type KgSeed = {
  id: number;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  source_chunk_id: number | null;
  similarity: number;
};

export type KgNeighbor = {
  id: number;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  relation: string;
  weight: number;
  direction: "incoming" | "outgoing";
  via_node_id: number;
};

export type KgHybridSearchOutput =
  | { ok: true; seeds: KgSeed[]; neighbors: KgNeighbor[] }
  | { ok: false; reason: string };

const HYBRID_DEFAULT_SEED_LIMIT = 5;
const HYBRID_MAX_SEED_LIMIT = 50;
const HYBRID_DEFAULT_HOPS = 1;
const HYBRID_MAX_HOPS = 2;

export async function kgHybridSearch(
  input: KgHybridSearchInput,
): Promise<KgHybridSearchOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { ok: false, reason: "project_id_required" };
  }
  if (!Array.isArray(input.query_embedding) || input.query_embedding.length !== 768) {
    return {
      ok: false,
      reason: `query_embedding_dim_mismatch: expected 768, got ${
        Array.isArray(input.query_embedding) ? input.query_embedding.length : "non-array"
      }`,
    };
  }
  const seedLimit = Math.min(
    Math.max(input.seed_limit ?? HYBRID_DEFAULT_SEED_LIMIT, 1),
    HYBRID_MAX_SEED_LIMIT,
  );
  const hops = Math.min(
    Math.max(input.neighbor_hops ?? HYBRID_DEFAULT_HOPS, 0),
    HYBRID_MAX_HOPS,
  );
  const minSim = Math.min(Math.max(input.min_similarity ?? 0.0, 0), 1);

  const { data, error } = await supabase.rpc("kg_hybrid_search", {
    p_project_id: input.project_id,
    p_query_embedding: input.query_embedding,
    p_seed_limit: seedLimit,
    p_neighbor_hops: hops,
    p_min_similarity: minSim,
  });

  if (error) return { ok: false, reason: `kg_hybrid_search_db_error: ${error.message}` };
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "kg_hybrid_search_invalid_response" };
  }

  const payload = data as { seeds?: unknown; neighbors?: unknown };
  const seeds = Array.isArray(payload.seeds)
    ? (payload.seeds as KgSeed[]).map(normalizeSeed)
    : [];
  const neighbors = Array.isArray(payload.neighbors)
    ? (payload.neighbors as KgNeighbor[]).map(normalizeNeighbor)
    : [];

  return { ok: true, seeds, neighbors };
}

function normalizeSeed(row: KgSeed): KgSeed {
  return {
    id: Number(row.id),
    type: String(row.type),
    label: String(row.label),
    properties: (row.properties ?? {}) as Record<string, unknown>,
    source_chunk_id: row.source_chunk_id == null ? null : Number(row.source_chunk_id),
    similarity: Number(row.similarity),
  };
}

function normalizeNeighbor(row: KgNeighbor): KgNeighbor {
  return {
    id: Number(row.id),
    type: String(row.type),
    label: String(row.label),
    properties: (row.properties ?? {}) as Record<string, unknown>,
    relation: String(row.relation),
    weight: Number(row.weight),
    direction: row.direction === "outgoing" ? "outgoing" : "incoming",
    via_node_id: Number(row.via_node_id),
  };
}

// ─── listKgNodes ─────────────────────────────────────────────────────────

export type ListKgNodesInput = {
  project_id: string;
  type?: string;
  label_prefix?: string;
  k?: number;
  offset?: number;
};

export type ListKgNodesOutput = {
  count: number;
  results: KgNodeRow[];
};

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 200;

export async function listKgNodes(input: ListKgNodesInput): Promise<ListKgNodesOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { count: 0, results: [] };
  }
  const limit = Math.min(Math.max(input.k ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  let query = supabase
    .from("kg_nodes")
    .select("id, project_id, type, label, properties, source_chunk_id, created_at, updated_at")
    .eq("project_id", input.project_id)
    .order("updated_at", { ascending: false });

  if (input.type !== undefined) query = query.eq("type", input.type);
  if (input.label_prefix !== undefined) query = query.ilike("label", `${input.label_prefix}%`);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) throw new Error(`listKgNodes: ${error.message}`);

  const results = (data ?? []).map((r) => ({
    id: Number(r.id),
    project_id: r.project_id as string,
    type: r.type as string,
    label: r.label as string,
    properties: (r.properties ?? {}) as Record<string, unknown>,
    source_chunk_id: r.source_chunk_id == null ? null : Number(r.source_chunk_id),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }));

  return { count: results.length, results };
}

// ─── listKgEdges ─────────────────────────────────────────────────────────

export type ListKgEdgesInput = {
  project_id: string;
  source_id?: number;
  target_id?: number;
  relation?: string;
  k?: number;
  offset?: number;
};

export type ListKgEdgesOutput = {
  count: number;
  results: KgEdgeRow[];
};

export async function listKgEdges(input: ListKgEdgesInput): Promise<ListKgEdgesOutput> {
  if (!input.project_id || input.project_id.trim().length === 0) {
    return { count: 0, results: [] };
  }
  const limit = Math.min(Math.max(input.k ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  let query = supabase
    .from("kg_edges")
    .select("id, project_id, source_id, target_id, relation, weight, properties, created_at")
    .eq("project_id", input.project_id)
    .order("created_at", { ascending: false });

  if (input.source_id !== undefined) query = query.eq("source_id", input.source_id);
  if (input.target_id !== undefined) query = query.eq("target_id", input.target_id);
  if (input.relation !== undefined) query = query.eq("relation", input.relation);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) throw new Error(`listKgEdges: ${error.message}`);

  const results = (data ?? []).map((r) => ({
    id: Number(r.id),
    project_id: r.project_id as string,
    source_id: Number(r.source_id),
    target_id: Number(r.target_id),
    relation: r.relation as string,
    weight: Number(r.weight),
    properties: (r.properties ?? {}) as Record<string, unknown>,
    created_at: r.created_at as string,
  }));

  return { count: results.length, results };
}

// ─── MCP InputShape exports ──────────────────────────────────────────────

export const upsertKgNodeInputShape = {
  project_id: z.string().min(1).describe("Project namespace; 'GLOBAL' for cross-project facts."),
  type: z.string().min(1).describe("Node category (e.g., 'session', 'decision', 'skill')."),
  label: z.string().min(1).describe("Human-readable identifier; unique within (project_id, type)."),
  properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Free-form JSONB metadata. GIN-indexed for containment search."),
  embedding: z
    .array(z.number())
    .length(768)
    .nullable()
    .optional()
    .describe("Optional 768-dim vector. Required for hybrid search seeds."),
  source_chunk_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Provenance pointer back to memory_chunks.id."),
};

export const upsertKgEdgeInputShape = {
  project_id: z.string().min(1).describe("Project namespace; matches both endpoints."),
  source_id: z.number().int().positive().describe("kg_nodes.id at the tail of the edge."),
  target_id: z.number().int().positive().describe("kg_nodes.id at the head of the edge."),
  relation: z.string().min(1).describe("Edge label (e.g., 'mentions', 'depends_on')."),
  weight: z.number().optional().describe("Default 1.0. Higher = stronger relation."),
  properties: z.record(z.string(), z.unknown()).optional().describe("Free-form JSONB metadata."),
};

export const kgHybridSearchInputShape = {
  project_id: z.string().min(1).describe("Project namespace to search inside."),
  query_embedding: z
    .array(z.number())
    .length(768)
    .describe("768-dim query vector. Use the same embed model as kg_nodes.embedding."),
  seed_limit: z
    .number()
    .int()
    .positive()
    .max(HYBRID_MAX_SEED_LIMIT)
    .optional()
    .describe("Max ANN seeds (default 5, max 50)."),
  neighbor_hops: z
    .number()
    .int()
    .min(0)
    .max(HYBRID_MAX_HOPS)
    .optional()
    .describe("Hops to expand. 0=seeds only. Default 1, max 2."),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Cosine cutoff for seeds. Default 0.0."),
};

export const listKgNodesInputShape = {
  project_id: z.string().min(1),
  type: z.string().min(1).optional(),
  label_prefix: z.string().min(1).optional(),
  k: z.number().int().positive().max(LIST_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
};

export const listKgEdgesInputShape = {
  project_id: z.string().min(1),
  source_id: z.number().int().positive().optional(),
  target_id: z.number().int().positive().optional(),
  relation: z.string().min(1).optional(),
  k: z.number().int().positive().max(LIST_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
};
