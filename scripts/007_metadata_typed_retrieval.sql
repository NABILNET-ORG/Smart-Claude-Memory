-- 007_metadata_typed_retrieval.sql
-- v2 Typed Retrieval + Strict Project Isolation. Idempotent.
--
-- The `metadata jsonb not null default '{}'::jsonb` column already exists on
-- memory_chunks since 001_schema.sql. This migration adds:
--   1. A GIN index on metadata (jsonb_path_ops) so containment lookups stay
--      O(log n) on the Supabase Free Tier.
--   2. A new match_memory_chunks signature with an optional p_metadata_filter
--      jsonb argument. The filter is evaluated AFTER the strict project_id
--      filter and BEFORE the vector ORDER BY, so cross-project leakage is
--      structurally impossible and the metadata filter narrows the candidate
--      set the planner has to score.
--   3. A column comment recording the Sovereign Taxonomy contract used by the
--      MCP server (type ∈ {DECISION, PATTERN, ERROR, LOG}; optional status,
--      context_id). The taxonomy is intentionally enforced in application
--      code, not via a CHECK constraint — keeps the schema flexible and
--      avoids paid services.
--
-- Multi-tenancy guard:
--   * project_id is the FIRST predicate in match_memory_chunks; the GIN
--     metadata filter is the SECOND. Vector similarity comes LAST.
--   * Existing memory_chunks_project_id_idx + memory_chunks_project_file_chunk_uniq
--     already make project_id lookups index-driven; the new GIN composes via
--     bitmap-AND with those.
--   * RLS (006_security_hardening.sql) and deny_anon_authenticated remain in
--     force; this migration does not touch row-level security.
--
-- Cost: $0. Pure PostgreSQL/Supabase features (GIN, JSONB, pgvector).

-- 1. GIN index on metadata for fast `@>` containment.
--    jsonb_path_ops is ~2-3x smaller and faster than default jsonb_ops for
--    containment queries, and that is the only operator the server emits.
create index if not exists memory_chunks_metadata_gin_idx
  on memory_chunks using gin (metadata jsonb_path_ops);

-- 2. Drop every prior match_memory_chunks overload so the new typed-retrieval
--    signature is the ONLY callable form. The pre-002 3-arg overload had no
--    project_id parameter — leaving it installed would be a multi-tenancy
--    leak (callers could bypass the project filter). Both signatures are
--    dropped defensively so re-running 001_schema.sql out of order cannot
--    re-introduce the unsafe form silently.
drop function if exists match_memory_chunks(vector, int, float);
drop function if exists match_memory_chunks(vector, text, int, float);

-- 3. New match function with typed retrieval.
--    NOTE: search_path is pinned to `public, extensions, pg_temp` to match
--    006_security_hardening exactly. `extensions` is required because the
--    pgvector `<=>` operator lives in the extensions schema on Supabase.
create or replace function match_memory_chunks(
  query_embedding   vector(768),
  p_project_id      text,
  match_count       int     default 5,
  min_similarity    float   default 0.0,
  p_metadata_filter jsonb   default null
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
    m.id,
    m.content,
    m.file_origin,
    m.chunk_index,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from memory_chunks m
  where m.project_id = p_project_id                                    -- tenancy guard #1
    and (p_metadata_filter is null or m.metadata @> p_metadata_filter) -- typed retrieval (uses GIN)
    and 1 - (m.embedding <=> query_embedding) >= min_similarity        -- similarity floor
  order by m.embedding <=> query_embedding                             -- vector rank LAST
  limit match_count;
$$;

-- 4. Sovereign Taxonomy contract (documentation only — enforced in TS).
comment on column memory_chunks.metadata is
  'Sovereign Taxonomy (v2): {type: DECISION|PATTERN|ERROR|LOG, status?: text, context_id?: text, ...}. '
  'Filterable via match_memory_chunks(p_metadata_filter:=...). The project_id predicate is ALWAYS '
  'applied before the metadata filter — multi-tenant isolation is structural, not advisory.';
