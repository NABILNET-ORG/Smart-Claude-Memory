-- 023_kg_clustering.sql
-- M8.3 GUI Semantic Clustering — Super Nodes for the force-graph.
--
-- ADDITIVE only. kg_nodes / kg_edges are NEVER touched. Cluster
-- assignments live in a side-table; deleting a kg_node CASCADEs
-- its cluster row so there is no separate sweep daemon.
--
-- Two-level hybrid (locked SCM-S40-D1):
--   * supernode_id  — coarse, K-Means (K = ceil(sqrt(N)))   → zoom-0
--   * community_id  — fine, Louvain on HNSW kNN sub-graph    → drill
-- Both columns are populated by src/clustering/daemon.ts per project.
--
-- Conventions match 020_knowledge_graph.sql:
--   * project_id text NOT NULL tenancy.
--   * extensions.vector lives in the extensions schema since 007/010.
--   * SECURITY DEFINER + SET search_path = public, extensions, pg_catalog
--     on every RPC that touches the vector operator (ERROR-11507 lesson).
--   * RLS deny_anon_authenticated + explicit service_role grants.
--
-- Idempotent: re-running this migration is safe.

-- ============ 1. kg_node_clusters relation ============

create table if not exists public.kg_node_clusters (
  project_id    text   not null,
  node_id       bigint not null references public.kg_nodes(id) on delete cascade,
  supernode_id  int    not null,
  community_id  int    not null,
  computed_at   timestamptz not null default now(),
  primary key (project_id, node_id)
);

comment on table public.kg_node_clusters is
  'M8.3 semantic clustering side-table. One row per kg_node per project. '
  'supernode_id = coarse K-Means cluster (K=ceil(sqrt(N))); community_id = '
  'fine Louvain community inside the supernode. Recomputed by the '
  'clustering_scanner daemon; CASCADE on kg_nodes delete keeps it self-cleaning.';

create index if not exists kg_node_clusters_super_idx
  on public.kg_node_clusters (project_id, supernode_id);

create index if not exists kg_node_clusters_community_idx
  on public.kg_node_clusters (project_id, supernode_id, community_id);

-- ============ 2. Row-Level Security ============

alter table public.kg_node_clusters enable row level security;
drop policy if exists deny_anon_authenticated on public.kg_node_clusters;
create policy deny_anon_authenticated on public.kg_node_clusters
  for all to anon, authenticated using (false) with check (false);

-- Explicit service-role grants — anon/authenticated have zero access
-- (mirrors 017_explicit_service_role_grants + 021_agent_budgets).
grant select, insert, update, delete on public.kg_node_clusters to service_role;

-- ============ 3. kg_supernodes summary view ============
-- One row per (project_id, supernode_id) with node_count, top 3 labels by
-- frequency, and the most recent computed_at. Powers /api/graph/clusters?level=super
-- and the list_supernodes MCP tool.

create or replace view public.kg_supernodes as
select
  ps.project_id,
  ps.supernode_id,
  ps.node_count,
  ps.computed_at,
  coalesce(tl.top_labels, array[]::text[]) as top_labels
from (
  select
    project_id,
    supernode_id,
    count(*)::int      as node_count,
    max(computed_at)   as computed_at
  from public.kg_node_clusters
  group by project_id, supernode_id
) ps
left join lateral (
  select array_agg(label order by freq desc) as top_labels
  from (
    select n.label, count(*) as freq
    from public.kg_node_clusters c
    join public.kg_nodes n on n.id = c.node_id
    where c.project_id = ps.project_id
      and c.supernode_id = ps.supernode_id
    group by n.label
    order by count(*) desc
    limit 3
  ) t
) tl on true;

comment on view public.kg_supernodes is
  'M8.3 per-supernode summary: node_count + top 3 labels for display + '
  'computed_at. Reads kg_node_clusters joined to kg_nodes; the lateral '
  'caps label aggregation at 3 per supernode so per-row work is bounded.';

grant select on public.kg_supernodes to service_role;

-- ============ 4. RPC: kg_knn_pairs ============
-- Returns (source_id, target_id, similarity) triples for the top-k cosine
-- nearest neighbours of every kg_node in a project that has an embedding.
-- The daemon consumes this once per run to build the in-memory kNN graph
-- that Louvain runs on; the result is NEVER persisted.
--
-- Each lateral subquery hits the existing HNSW index on kg_nodes.embedding
-- (vector_cosine_ops). At N=50k, k=15 this returns <=750k rows in one
-- round-trip; bench target <10 s end-to-end.

create or replace function public.kg_knn_pairs(
  p_project_id text,
  p_k          int default 15,
  p_min_sim    double precision default 0.5
) returns table (
  source_id  bigint,
  target_id  bigint,
  similarity double precision
)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  with src as (
    select id, embedding
    from public.kg_nodes
    where project_id = p_project_id
      and embedding is not null
  )
  select
    s.id                                          as source_id,
    n.id                                          as target_id,
    (1 - (s.embedding <=> n.embedding))::double precision as similarity
  from src s
  cross join lateral (
    select id, embedding
    from public.kg_nodes
    where project_id = p_project_id
      and embedding is not null
      and id <> s.id
    order by s.embedding <=> embedding
    limit greatest(p_k, 1)
  ) n
  where (1 - (s.embedding <=> n.embedding)) >= p_min_sim;
$$;

comment on function public.kg_knn_pairs(text, int, double precision) is
  'M8.3 kNN edge generator. Returns (source_id, target_id, similarity) for '
  'the top-K cosine neighbours of every kg_node in p_project_id. Reuses the '
  'HNSW index on kg_nodes.embedding; result is consumed once by the '
  'clustering daemon and discarded (never persisted).';

grant execute on function public.kg_knn_pairs(text, int, double precision)
  to service_role;
