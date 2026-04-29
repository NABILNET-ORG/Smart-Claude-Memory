-- 006_verify.sql
-- Catalog-level verification for 006_security_hardening.sql.
-- Read-only: returns one row per assertion. All `pass` columns must be true.
-- Run in Supabase SQL Editor (uses an admin role).

with checks as (
  -- ── 1. RLS enabled on every public table ──
  select 'rls_enabled' as check_name, c.relname as target,
         't' as expected, c.relrowsecurity::text as actual,
         c.relrowsecurity as pass
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'cloud_backlog','frozen_features','archive_backlog','memory_chunks'
    )

  union all
  -- ── 2. deny_anon_authenticated policy exists on every public table ──
  select 'policy_exists' as check_name, t.relname as target,
         'deny_anon_authenticated' as expected,
         coalesce(p.polname, '<missing>') as actual,
         p.polname is not null as pass
  from (values
    ('cloud_backlog'),('frozen_features'),('archive_backlog'),('memory_chunks')
  ) as v(relname)
  join pg_class t on t.relname = v.relname
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  left join pg_policy p
    on p.polrelid = t.oid
   and p.polname = 'deny_anon_authenticated'

  union all
  -- ── 3. Policy targets anon + authenticated only ──
  select 'policy_roles' as check_name, t.relname as target,
         'anon,authenticated' as expected,
         array_to_string(array(
           select rolname from pg_roles where oid = any(p.polroles) order by 1
         ), ',') as actual,
         array(select rolname from pg_roles where oid = any(p.polroles) order by 1)
           = array['anon','authenticated']::name[] as pass
  from pg_policy p
  join pg_class t on t.oid = p.polrelid
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  where p.polname = 'deny_anon_authenticated'

  union all
  -- ── 4. Policy uses USING (false) WITH CHECK (false) ──
  select 'policy_denies_all' as check_name, t.relname as target,
         'using=false,check=false' as expected,
         format('using=%s,check=%s',
                coalesce(pg_get_expr(p.polqual,  p.polrelid), '<null>'),
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '<null>')) as actual,
         pg_get_expr(p.polqual,  p.polrelid) = 'false'
         and pg_get_expr(p.polwithcheck, p.polrelid) = 'false' as pass
  from pg_policy p
  join pg_class t on t.oid = p.polrelid
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  where p.polname = 'deny_anon_authenticated'

  union all
  -- ── 5. Function search_path is pinned (no longer NULL = mutable) ──
  select 'function_search_path' as check_name, p.proname as target,
         case p.proname
           when 'archive_done_backlog' then 'search_path=public, pg_temp'
           else 'search_path=public, extensions, pg_temp'
         end as expected,
         coalesce(
           (select cfg from unnest(p.proconfig) cfg where cfg like 'search_path=%'),
           '<unset>'
         ) as actual,
         (select cfg from unnest(p.proconfig) cfg where cfg like 'search_path=%')
         = case p.proname
             when 'archive_done_backlog' then 'search_path=public, pg_temp'
             else 'search_path=public, extensions, pg_temp'
           end as pass
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.proname in (
    'match_memory_chunks','upsert_memory_rule','archive_done_backlog'
  )

  union all
  -- ── 6. pgvector extension lives in `extensions`, not `public` ──
  select 'extension_schema' as check_name, e.extname as target,
         'extensions' as expected,
         n.nspname as actual,
         n.nspname = 'extensions' as pass
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector'
)
select check_name, target, expected, actual, pass
from checks
order by pass, check_name, target;
