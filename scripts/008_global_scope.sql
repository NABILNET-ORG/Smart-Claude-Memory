-- 008_global_scope.sql
-- v2.0.0-rc1 Dual-Scope Search + GLOBAL Knowledge Vault. Idempotent.
--
-- The "GLOBAL Knowledge Vault" architectural intent: every search call should
-- structurally dual-scope across the caller's project_id AND the reserved
-- project_id 'GLOBAL'. Rows under 'GLOBAL' are universal patterns / lessons
-- learned that should be visible to every project. Application-side, save_memory
-- routes a row to project_id='GLOBAL' when metadata.is_global is true.
--
-- This migration:
--   1. Drops the v2 5-arg match_memory_chunks signature so the new 6-arg form is
--      the ONLY callable overload (preserving the multi-tenancy guard intent).
--   2. Recreates match_memory_chunks with `p_include_global boolean default
--      true` as the 6th parameter. The WHERE clause becomes:
--        (m.project_id = p_project_id
--         OR (p_include_global AND m.project_id = 'GLOBAL'))
--      followed by the existing metadata filter + similarity floor, then ORDER
--      BY embedding distance LIMIT match_count.
--   3. Pins `set search_path = public, extensions, pg_temp` to match the
--      006/007 hardening posture (extensions is required for the pgvector
--      `<=>` operator).
--   4. Updates the Sovereign Taxonomy column comment to mention 'GLOBAL'.
--
-- Multi-tenancy guard:
--   * project_id is STILL the FIRST predicate; 'GLOBAL' is a structurally-named
--     opt-in scope. There is no implicit cross-project leakage between regular
--     project_ids — only the reserved 'GLOBAL' bucket fans out, and only when
--     p_include_global is true (the application default).
--   * RLS (006_security_hardening.sql) and deny_anon_authenticated remain in
--     force; this migration does not touch row-level security.
--   * GIN(jsonb_path_ops) on metadata (007) still narrows the candidate set
--     before pgvector ranks.
--
-- Cost: $0. Pure PostgreSQL/Supabase features.

-- 1. Drop the v2 5-arg overload so only the new 6-arg form survives. If 007
--    has been applied this is the matching signature; if not, the IF EXISTS
--    guard turns the statement into a no-op.
drop function if exists match_memory_chunks(vector, text, int, float, jsonb);

-- Defensive: also drop earlier overloads in case someone re-applies 001 or 002
-- out of order. Keeping them around would be a multi-tenancy leak.
drop function if exists match_memory_chunks(vector, int, float);
drop function if exists match_memory_chunks(vector, text, int, float);

-- 2. Recreate match_memory_chunks with dual-scope GLOBAL support.
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
    m.id,
    m.content,
    m.file_origin,
    m.chunk_index,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from memory_chunks m
  where (m.project_id = p_project_id
         or (p_include_global and m.project_id = 'GLOBAL'))                  -- dual-scope tenancy guard
    and (p_metadata_filter is null or m.metadata @> p_metadata_filter)        -- typed retrieval (uses GIN)
    and 1 - (m.embedding <=> query_embedding) >= min_similarity               -- similarity floor
  order by m.embedding <=> query_embedding                                    -- vector rank LAST
  limit match_count;
$$;

-- 3. Sovereign Taxonomy contract — refreshed to mention the GLOBAL scope.
comment on column memory_chunks.metadata is
  'Sovereign Taxonomy (v2.0.0-rc1): {type: DECISION|PATTERN|ERROR|LOG, status?: text, context_id?: text, is_global?: bool, ...}. '
  'Filterable via match_memory_chunks(p_metadata_filter:=...). The reserved project_id ''GLOBAL'' is the universal '
  'knowledge vault: rows saved with metadata.is_global=true are routed there and surface in dual-scope search across '
  'every project (toggle via p_include_global). Per-project tenancy isolation remains structural — only ''GLOBAL'' '
  'fans out across projects.';
