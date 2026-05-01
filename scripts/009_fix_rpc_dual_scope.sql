-- 009_fix_rpc_dual_scope.sql
-- v2.0.0-rc1 hotfix: dual-scope WHERE clause planner pathology. Idempotent.
--
-- Date: 2026-05-01
--
-- What this fixes
-- ---------------
-- Migration 008 introduced match_memory_chunks (6-arg) with the dual-scope
-- predicate written as an OR-form:
--
--   where (m.project_id = p_project_id
--          or (p_include_global and m.project_id = 'GLOBAL'))
--
-- Empirically, even with `p_include_global := true` and
-- `min_similarity := 0`, GLOBAL-scope rows (e.g. id 9562) fail to surface in
-- pure semantic search. Reproduced with two separate queries
-- ("v2.0.0-rc1 typed retrieval global knowledge vault" and
-- "Architectural Decisions") returning only the caller's project rows.
--
-- Root cause (per Orchestrator analysis): the boolean `p_include_global` is a
-- runtime parameter, not a literal. The PostgreSQL planner cannot reliably
-- prove the OR branch is selectable via the project_id b-tree index, falls
-- back to a strategy that prunes 'GLOBAL' before the vector ORDER BY can rank
-- it, and the row never enters the candidate set.
--
-- Fix
-- ---
-- Rewrite the project-scope gate as an IN-list whose second element is
-- conditioned by CASE on p_include_global:
--
--   where m.project_id IN (p_project_id,
--                          CASE WHEN p_include_global THEN 'GLOBAL' END)
--
-- Semantics are equivalent to the OR-form:
--   * p_include_global = true  -> IN (p_project_id, 'GLOBAL')   — both surface
--   * p_include_global = false -> IN (p_project_id, NULL)       — only project
--     (NULL in IN never matches; 'GLOBAL' is excluded as intended)
--
-- The IN-form lets the planner use the project_id index for a clean two-key
-- lookup before the metadata GIN filter and the pgvector rank, restoring the
-- dual-scope behavior described in 008's header.
--
-- Scope of change
-- ---------------
--   * Function-only patch: CREATE OR REPLACE FUNCTION match_memory_chunks
--     with the IDENTICAL 6-arg signature, return type, language/stable
--     markers, and `set search_path = public, extensions, pg_temp` as 008.
--   * No schema changes. No re-embedding. No data migration.
--   * Migration 008 is left intact; this migration supersedes the function
--     body via OR REPLACE on the same signature.
--
-- Cost: $0. Pure PostgreSQL/Supabase features.

-- Recreate match_memory_chunks with the planner-friendly IN-form WHERE clause.
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
  where m.project_id in (p_project_id,
                         case when p_include_global then 'GLOBAL' end)          -- dual-scope tenancy guard (IN-form)
    and (p_metadata_filter is null or m.metadata @> p_metadata_filter)          -- typed retrieval (uses GIN)
    and 1 - (m.embedding <=> query_embedding) >= min_similarity                 -- similarity floor
  order by m.embedding <=> query_embedding                                      -- vector rank LAST
  limit match_count;
$$;
