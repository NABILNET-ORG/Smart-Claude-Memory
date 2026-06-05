import { embed } from "../ollama.js";
import {
  supabase,
  searchChunks,
  listBacklog,
  listArchive,
  fetchConceptChunks,
  fetchChunksByIds,
  type BacklogRow,
  type ArchiveRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";
import { kgHybridSearch, type KgSeed, type KgNeighbor } from "./kg.js";
import { config } from "../config.js";
import { conceptWeights } from "./bridge.js";
import { rerank } from "./rerank.js";

/** Pure-number queries (e.g. "11468") -> direct SQL fetch by id. Bypasses
 *  vector ranking, which can fail to surface a known row when its embedding
 *  is squeezed out of top-K by stronger lexical neighbors in a 7k+ row set.
 *  Dual-scope is enforced at the app layer: project_id IN (current, GLOBAL?). */
const ID_PATTERN = /^\s*(\d{1,12})\s*$/;

/** Sovereign Decision-ID handles like SCM-S15-D1 or SCM-S15-D1-GLOBAL.
 *  Routed through metadata.context_id @> match (no vector embedding). */
const CONTEXT_ID_PATTERN = /^\s*(SCM-S\d+-D\d+(?:-GLOBAL)?)\s*$/i;

/** Narrow patterns for queries that unambiguously ask for the ARCHIVE. */
const ARCHIVE_PATTERNS: RegExp[] = [
  /\barchive[sd]?\b/i,
  /\bcompleted\s+tasks?\b/i,
  /\bdone\s+tasks?\b/i,
  /\bfinished\s+tasks?\b/i,
  /\bpast\s+tasks?\b/i,
];

/** Narrow patterns for queries that ask for the ACTIVE backlog. */
const BACKLOG_PATTERNS: RegExp[] = [
  /\b(active|pending|current|my|open)\s+backlog\b/i,
  /\bbacklog\s+(tasks?|items?|list|snapshot)\b/i,
  /^\s*backlog\s*$/i,
  /^\s*pending\s+tasks?\s*$/i,
  /^\s*what'?s?\s+next\??\s*$/i,
];

function matches(patterns: RegExp[], q: string): boolean {
  return patterns.some((re) => re.test(q));
}

function sortByPriorityThenAge(rows: BacklogRow[]): BacklogRow[] {
  return [...rows].sort(
    (a, b) => a.priority - b.priority || Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

/** Reject if `p` doesn't settle within `ms` — bounds the graph re-rank queries. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("rerank_timeout")), ms)),
  ]);
}

export async function searchMemory(args: {
  query: string;
  limit?: number;
  min_similarity?: number;
  project_id?: string;
  metadata_filter?: Record<string, unknown>;
  include_global?: boolean;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const limit = args.limit ?? 5;
  // Default behavior: dual-scope across the current project AND the reserved
  // 'GLOBAL' bucket. Pass include_global:false to restrict to project_id only.
  const includeGlobal = args.include_global ?? true;

  // Precedence: id > context_id > archive > backlog > semantic.
  //
  // ID fallthrough — a query that is JUST a number is almost certainly a
  // direct lookup ("show me row 11468"), not a semantic ask. Vector ranking
  // on numeric tokens is meaningless and can hide rows whose neighbors won
  // the cosine race. Direct SQL fetch is exact and respects dual-scope
  // (current project_id OR 'GLOBAL' when include_global is true).
  const idMatch = args.query.match(ID_PATTERN);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const projectFilter = includeGlobal
      ? `project_id.eq.${projectId},project_id.eq.GLOBAL`
      : `project_id.eq.${projectId}`;
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, content, file_origin, chunk_index, metadata, project_id")
      .eq("id", id)
      .or(projectFilter)
      .limit(1);
    if (error) {
      throw new Error(`Supabase id-lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      id: number;
      content: string;
      file_origin: string;
      chunk_index: number;
      metadata: Record<string, unknown>;
      project_id: string;
    }>;
    return {
      project_id: projectId,
      query: args.query,
      mode: "id" as const,
      include_global: includeGlobal,
      count: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        content: r.content,
        file_origin: r.file_origin,
        chunk_index: r.chunk_index,
        metadata: r.metadata,
        similarity: 1.0,
        project_id: r.project_id,
      })),
    };
  }

  // Context-ID fallthrough — Sovereign Decision IDs like "SCM-S15-D1" or
  // "SCM-S15-D1-GLOBAL". Use metadata.context_id @> containment (uses GIN)
  // so the lookup is exact, dual-scope-aware, and never embedding-bottlenecked.
  const ctxMatch = args.query.match(CONTEXT_ID_PATTERN);
  if (ctxMatch) {
    const contextId = ctxMatch[1];
    const projectFilter = includeGlobal
      ? `project_id.eq.${projectId},project_id.eq.GLOBAL`
      : `project_id.eq.${projectId}`;
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, content, file_origin, chunk_index, metadata, project_id")
      .contains("metadata", { context_id: contextId })
      .or(projectFilter)
      .limit(Math.max(limit, 5));
    if (error) {
      throw new Error(`Supabase context_id-lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      id: number;
      content: string;
      file_origin: string;
      chunk_index: number;
      metadata: Record<string, unknown>;
      project_id: string;
    }>;
    return {
      project_id: projectId,
      query: args.query,
      mode: "context_id" as const,
      include_global: includeGlobal,
      count: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        content: r.content,
        file_origin: r.file_origin,
        chunk_index: r.chunk_index,
        metadata: r.metadata,
        similarity: 1.0,
        project_id: r.project_id,
      })),
    };
  }

  if (matches(ARCHIVE_PATTERNS, args.query)) {
    const rows: ArchiveRow[] = await listArchive(projectId, { limit: Math.max(limit, 20) });
    const summary =
      rows.length === 0
        ? "Archive is empty for this project."
        : `${rows.length} archived task${rows.length === 1 ? "" : "s"}. Most recent: "${rows[0].title}" (archived ${rows[0].archived_at}).`;
    return {
      project_id: projectId,
      query: args.query,
      mode: "archive" as const,
      count: rows.length,
      results: [],
      archive: rows.map((t) => ({
        id: t.id,
        cloud_backlog_id: t.cloud_backlog_id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
        archived_at: t.archived_at,
      })),
      summary,
    };
  }

  if (matches(BACKLOG_PATTERNS, args.query)) {
    const [inProg, todo, blocked] = await Promise.all([
      listBacklog(projectId, { status: "in_progress" }),
      listBacklog(projectId, { status: "todo" }),
      listBacklog(projectId, { status: "blocked" }),
    ]);
    const active = sortByPriorityThenAge([...inProg, ...todo, ...blocked]);
    const top = active.slice(0, Math.max(limit, 20));
    const head = active[0];
    const summary =
      active.length === 0
        ? "Backlog is empty for this project."
        : `${active.length} active task${active.length === 1 ? "" : "s"}. ` +
          `Next: [P${head.priority}] ${head.title} (${head.status}).`;
    return {
      project_id: projectId,
      query: args.query,
      mode: "backlog" as const,
      count: top.length,
      results: [],
      backlog: top.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
      })),
      summary,
    };
  }

  // Default semantic path. Archived backlog rows are NEVER mixed into
  // semantic results — they live in a different table and only surface via
  // the archive-intent fast path above.
  //
  // `metadata_filter` (when present) flows through to match_memory_chunks's
  // `p_metadata_filter` arg — the GIN(jsonb_path_ops) index narrows the
  // candidate set BEFORE pgvector ranks. Project-id filtering is structural
  // at the SQL level (first WHERE predicate) and is never relaxed.
  const [queryVec] = await embed([args.query]);

  // M8.1 Phase 1 — Graph-RAG splice: in parallel with the vector lookup,
  // ask the knowledge graph for seeds + 1-hop neighbors keyed on the same
  // embedding. Failures are silent: graph_context is OPTIONAL and never
  // blocks or pollutes the semantic response.
  const graphDisabled = (process.env.SCM_GRAPH_RAG_DISABLED ?? "0") === "1";
  const graphPromise = graphDisabled
    ? Promise.resolve({ ok: false, reason: "graph_rag_disabled" } as const)
    : kgHybridSearch({ project_id: projectId, query_embedding: queryVec }).catch((e) => ({
        ok: false as const,
        reason: e instanceof Error ? e.message : String(e),
      }));

  const [resultsSettled, graphSettled] = await Promise.allSettled([
    searchChunks(
      projectId,
      queryVec,
      config.SCM_GRAPH_RERANK_ENABLED ? config.SCM_GRAPH_RERANK_POOL : limit,
      args.min_similarity ?? 0.0,
      args.metadata_filter ?? null,
      includeGlobal,
    ),
    graphPromise,
  ]);

  if (resultsSettled.status === "rejected") throw resultsSettled.reason;
  const candidates = resultsSettled.value;

  let graphContext: { seeds: KgSeed[]; neighbors: KgNeighbor[] } | undefined;
  if (graphSettled.status === "fulfilled") {
    const v = graphSettled.value;
    if (v && (v as { ok?: boolean }).ok === true) {
      const ok = v as { ok: true; seeds: KgSeed[]; neighbors: KgNeighbor[] };
      graphContext = { seeds: ok.seeds, neighbors: ok.neighbors };
    }
  }

  // M8.2 — concept-bridge re-rank (SCM-S50): fuse vector similarity with shared
  // graph concepts and recover graph-connected chunks the vector pool missed.
  // Flag-gated; alpha=1 ≡ pure vector. Extra queries are timeout-guarded with a
  // pure-vector fallback so the graph layer can never block a search.
  let results = candidates;
  if (config.SCM_GRAPH_RERANK_ENABLED && graphContext && candidates.length) {
    const W = conceptWeights(graphContext.seeds, graphContext.neighbors);
    const conceptIds = [...W.keys()];
    if (conceptIds.length) {
      try {
        const bridge = await withTimeout(
          fetchConceptChunks(projectId, conceptIds),
          config.SCM_GRAPH_RERANK_TIMEOUT_MS,
        );
        const candidateIds = new Set(candidates.map((c) => c.id));
        const gRaw = new Map<number, number>();
        for (const b of bridge) {
          const wk = W.get(b.concept_id);
          if (wk !== undefined) gRaw.set(b.chunk_id, (gRaw.get(b.chunk_id) ?? 0) + wk * b.w_ck);
        }
        const expandIds = [...gRaw.entries()]
          .filter(([id]) => !candidateIds.has(id))
          .sort((a, b) => b[1] - a[1])
          .slice(0, config.SCM_GRAPH_RERANK_EXPAND)
          .map(([id]) => id);
        const expansion = expandIds.length
          ? await withTimeout(
              fetchChunksByIds(projectId, expandIds, queryVec),
              config.SCM_GRAPH_RERANK_TIMEOUT_MS,
            )
          : [];
        results = rerank({
          candidates,
          expansion,
          conceptWeights: W,
          bridge,
          params: { alpha: config.SCM_GRAPH_RERANK_ALPHA },
        });
      } catch {
        // §7: never silent — log to stderr (MCP protocol is on stdout) and fall back.
        console.warn("graph_rerank_skipped: bridge/expansion failed; using pure-vector results");
      }
    }
  }
  results = results.slice(0, limit);

  return {
    project_id: projectId,
    query: args.query,
    mode: "semantic" as const,
    include_global: includeGlobal,
    count: results.length,
    results,
    ...(graphContext ? { graph_context: graphContext } : {}),
  };
}
