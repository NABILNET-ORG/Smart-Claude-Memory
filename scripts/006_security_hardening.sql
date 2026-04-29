-- 006_security_hardening.sql
-- Addresses Supabase Security Advisor findings (snapshot 27 Apr 2026):
--   3 ERRORS:    rls_disabled_in_public on cloud_backlog, frozen_features, archive_backlog
--   4 WARNINGS:  function_search_path_mutable on archive_done_backlog,
--                match_memory_chunks, upsert_memory_rule; extension_in_public for vector
--   1 INFO:      rls_enabled_no_policy on memory_chunks
--
-- Threat model: this DB is single-tenant and only ever accessed via the
-- service_role key from the local Python client. service_role bypasses RLS,
-- so the correct posture is "deny anon + authenticated, allow nothing else".
-- Idempotent: safe to re-run.

-- ============ 1. Move pgvector out of the public schema ============
-- Supabase recommends keeping extensions in their own schema. Existing
-- column types (memory_chunks.embedding) and operator classes are stored
-- by OID, so the move is non-breaking; only name-resolution at parse time
-- is affected, which we cover via function search_path below.
create schema if not exists extensions;
alter extension vector set schema extensions;

-- ============ 2. Enable RLS on every public table ============
alter table public.cloud_backlog    enable row level security;
alter table public.frozen_features  enable row level security;
alter table public.archive_backlog  enable row level security;
alter table public.memory_chunks    enable row level security;

-- ============ 3. Deny anon + authenticated on every table ============
-- service_role bypasses RLS automatically, so the Python client keeps working.
do $$
declare
  t text;
begin
  foreach t in array array[
    'cloud_backlog','frozen_features','archive_backlog','memory_chunks'
  ]
  loop
    execute format(
      'drop policy if exists deny_anon_authenticated on public.%I', t
    );
    execute format(
      'create policy deny_anon_authenticated on public.%I '
      'for all to anon, authenticated using (false) with check (false)',
      t
    );
  end loop;
end $$;

-- ============ 4. Pin function search_path ============
-- Functions that touch vector operators (<=>) must include the extensions
-- schema; archive_done_backlog uses only built-ins + public tables.
do $$
declare
  fn record;
  fpath text;
begin
  for fn in
    select n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'match_memory_chunks','upsert_memory_rule','archive_done_backlog'
      )
  loop
    fpath := case fn.proname
               when 'archive_done_backlog' then 'public, pg_temp'
               else 'public, extensions, pg_temp'
             end;
    execute format(
      'alter function %I.%I(%s) set search_path = %s',
      fn.nspname, fn.proname, fn.args, fpath
    );
  end loop;
end $$;
