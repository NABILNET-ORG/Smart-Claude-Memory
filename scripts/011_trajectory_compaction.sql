-- 011_trajectory_compaction.sql
-- Agentic OS 2026 — Mission 2: Trajectory Compression (AgentDiet). Idempotent.
--
-- Architecture (DECISION SCM-S18-D1 / ARCHITECTURE.md §4.5):
--   Long LOG / verbose DECISION rows in memory_chunks accumulate token weight
--   the LLM never benefits from at retrieval time. AgentDiet compresses those
--   chunks into a heuristic+LLM trajectory_summary while PRESERVING the source
--   row (and its embedding) for full-fidelity recall on demand. The cost
--   surface — both storage and retrieval — drops by the compression_ratio
--   without sacrificing recoverability.
--
--   Summaries live in a DEDICATED relation `public.trajectory_summaries`, NOT
--   as a mutation of memory_chunks.content. Rationale:
--     * memory_chunks is the source of truth; rewriting content would erase
--       the original trajectory and break re-embedding workflows.
--     * The compression ratio + model + token counts are telemetry that must
--       NEVER feed the LLM at retrieval time — they support eviction policy.
--     * (project_id, source_chunk_id) is the natural identity; one summary
--       per source chunk per scope, ON DELETE CASCADE keyed to the source.
--
-- Tenancy contract:
--   * project_id mirrors the source chunk's project_id; the CASCADE on
--     source_chunk_id keeps the two in lockstep without an FK on project_id.
--   * RLS enabled + deny_anon_authenticated — same posture as migration 006
--     and 010. service_role bypasses; anon/authenticated denied unconditionally.
--
-- Retrieval rewrite (match_memory_chunks):
--   The 6-arg match_memory_chunks (009_fix_rpc_dual_scope.sql) is recreated
--   with an identical signature. The body adds a LEFT JOIN against
--   trajectory_summaries and PROJECTS the summary in place of the raw content
--   when a summary exists, prefixed with an actionable marker so the LLM
--   knows it can request the raw via get_trajectory_summary. Ranking stays on
--   the original embedding — the compressed text only changes the projected
--   content column, never the candidate set or the order.
--
-- Cost: $0. Pure PostgreSQL/Supabase features.

-- ============ 1. Table ============
create table if not exists public.trajectory_summaries (
  id                bigserial primary key,
  project_id        text     not null,
  source_chunk_id   bigint   not null references public.memory_chunks(id) on delete cascade,
  summary           text     not null,
  summary_embedding extensions.vector(768),
  source_tokens     int      not null check (source_tokens >= 0),
  summary_tokens    int      not null check (summary_tokens >= 0),
  compression_ratio real     generated always as
                       (summary_tokens::real / nullif(source_tokens, 0)) stored,
  strategy          text     not null default 'heuristic+llm',
  model             text     not null,
  created_at        timestamptz not null default now()
);

comment on table public.trajectory_summaries is
  'Trajectory Compression (Agentic OS 2026 / SCM-S18-D1). One compressed '
  'summary per source memory_chunks row. match_memory_chunks substitutes '
  'summary for content at retrieval time; raw is recoverable via '
  'get_trajectory_summary({chunk_id}). CASCADE on source ensures no orphans.';

comment on column public.trajectory_summaries.compression_ratio is
  'summary_tokens / source_tokens, computed STORED. NULLIF guards against '
  'zero-token sources (no division by zero). Lower is better.';

comment on column public.trajectory_summaries.strategy is
  'Compression strategy label. Default ''heuristic+llm'' = deterministic '
  'heuristic shortening followed by an LLM rewrite pass. Free-form text so '
  'future strategies (pure-heuristic, pure-llm, distillation) need no schema change.';

-- ============ 2. Indexes ============
-- UNIQUE (project_id, source_chunk_id) — one summary per source row per scope.
-- This is the upsert identity key for the compaction worker.
create unique index if not exists trajectory_summaries_project_source_uniq
  on public.trajectory_summaries (project_id, source_chunk_id);

-- Recency-sorted scans (eviction policy, compaction telemetry dashboards).
create index if not exists trajectory_summaries_created_at_idx
  on public.trajectory_summaries (created_at desc);

-- HNSW on summary_embedding — mirrors the memory_chunks_embedding_idx posture
-- in 001_schema.sql (defaults) and agent_skills_embedding_idx in 010 (defaults).
-- No explicit m / ef_construction overrides anywhere else in the schema; keep
-- the same defaults so the planner cost model is consistent across HNSW scans.
create index if not exists trajectory_summaries_summary_embedding_idx
  on public.trajectory_summaries
  using hnsw (summary_embedding extensions.vector_cosine_ops);

-- Tenancy scan helper.
create index if not exists trajectory_summaries_project_id_idx
  on public.trajectory_summaries (project_id);

-- ============ 3. Row-Level Security ============
-- Same posture as migration 006 and 010: service_role bypasses RLS; anon and
-- authenticated are denied unconditionally. Idempotent via DROP IF EXISTS.
alter table public.trajectory_summaries enable row level security;

drop policy if exists deny_anon_authenticated on public.trajectory_summaries;
create policy deny_anon_authenticated on public.trajectory_summaries
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. Rewrite match_memory_chunks (content substitution) ============
-- The 6-arg signature from 009_fix_rpc_dual_scope.sql is preserved verbatim:
-- same parameter list, same return columns, same language/stable markers,
-- same search_path. Only the SELECT list and FROM clause change.
--
-- Substitution rule:
--   When a trajectory_summaries row exists for memory_chunks.id, project the
--   summary (prefixed with a marker that tells the LLM how to fetch the raw
--   via get_trajectory_summary) in place of mc.content. Otherwise, project
--   mc.content unchanged.
--
-- Ranking invariant:
--   The ORDER BY operates on `mc.embedding <=> query_embedding` — i.e. the
--   ORIGINAL chunk embedding, never the summary embedding. This keeps recall
--   identical to pre-compaction. Only the projected text is rewritten; the
--   candidate set and the order are not.
--
-- Dual-scope + metadata_filter semantics are preserved exactly as 009.
create or replace function match_memory_chunks(
  query_embedding   vector(768),
  p_project_id      text,
  match_count       int     default 5,
  min_similarity    float   default 0.0,
  p_metadata_filter jsonb   default null,
  p_include_global  boolean default true
) returns table (
  id          bigint,
  content     text,
  file_origin text,
  chunk_index int,
  metadata    jsonb,
  similarity  float
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select
    mc.id,
    coalesce(
      '[Compressed trajectory — call get_trajectory_summary({chunk_id: '
        || mc.id || '}) for raw.] ' || ts.summary,
      mc.content
    )                                                                       as content,
    mc.file_origin,
    mc.chunk_index,
    mc.metadata,
    1 - (mc.embedding <=> query_embedding)                                  as similarity
  from memory_chunks mc
  left join trajectory_summaries ts
    on ts.source_chunk_id = mc.id
   and ts.project_id      = mc.project_id
  where mc.project_id in (p_project_id,
                          case when p_include_global then 'GLOBAL' end)        -- dual-scope tenancy guard (IN-form)
    and (p_metadata_filter is null or mc.metadata @> p_metadata_filter)        -- typed retrieval (uses GIN)
    and 1 - (mc.embedding <=> query_embedding) >= min_similarity               -- similarity floor
  order by mc.embedding <=> query_embedding                                    -- vector rank LAST (original embedding)
  limit match_count;
$$;

-- ============ 5. RPC: get_trajectory_summary ============
-- Caller passes the source memory_chunks.id and gets the full summary row
-- back (no embedding — that's internal). SECURITY DEFINER + STABLE so the
-- function executes with service_role privileges regardless of how the
-- supabase-js client is wired; deny_anon_authenticated still applies to
-- direct table reads, so the only path in is via this RPC.
drop function if exists public.get_trajectory_summary(bigint);

create function public.get_trajectory_summary(
  p_chunk_id bigint
) returns table (
  summary           text,
  source_tokens     int,
  summary_tokens    int,
  compression_ratio real,
  model             text,
  created_at        timestamptz
)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select
    ts.summary,
    ts.source_tokens,
    ts.summary_tokens,
    ts.compression_ratio,
    ts.model,
    ts.created_at
  from public.trajectory_summaries ts
  where ts.source_chunk_id = p_chunk_id
  order by ts.created_at desc
  limit 1;
$$;

-- ============ 6. Grants ============
-- Mirror migration 010 posture: service_role gets execute; anon and
-- authenticated remain denied at the RLS layer (and have no execute grant
-- here either). Grants are idempotent — re-running is a no-op.
revoke all on function public.get_trajectory_summary(bigint) from public;
grant execute on function public.get_trajectory_summary(bigint) to service_role;

grant select, insert, update, delete on public.trajectory_summaries to service_role;
grant usage, select on sequence public.trajectory_summaries_id_seq to service_role;
