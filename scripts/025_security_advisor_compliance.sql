-- Migration 025: Security Compliance Sprint (Session 46, SCM-S46-F1)
--
-- Addresses the Supabase Security Advisor report. Four classes of finding:
--   1. RLS-disabled public tables                  → ENABLE ROW LEVEL SECURITY
--   2. SECURITY DEFINER views (Postgres default)   → SET (security_invoker = true)
--   3. Functions with mutable search_path          → pin search_path
--   4. Functions with PUBLIC EXECUTE grant         → REVOKE EXECUTE FROM PUBLIC
--
-- Pattern: every block is idempotent (uses IF EXISTS or DO-block lookup against
-- pg_proc / pg_class), so re-running is a no-op. Forward-only — never edit a
-- prior migration; future tightening lands in 026+.
--
-- Access model invariant for this project (per memory: project_supabase):
-- service_role-only. service_role has BYPASSRLS and explicit GRANTs, so:
--   * Enabling RLS with zero policies denies anon/authenticated, lets
--     service_role through unchanged.
--   * Revoking PUBLIC EXECUTE strips the implicit grant only; explicit
--     GRANTs to service_role / anon / authenticated are preserved.
-- Nothing in this migration should regress documented call paths.

-- =============================================================================
-- 1. RLS — enable row-level security on tables flagged by the advisor.
-- =============================================================================

alter table if exists public.workflow_checkpoints enable row level security;
alter table if exists public.schema_migrations    enable row level security;

-- =============================================================================
-- 2. SECURITY INVOKER views — Postgres defaults views to SECURITY DEFINER,
-- which executes with the view owner's privileges and silently bypasses RLS
-- of the underlying tables for the caller. Flipping to security_invoker
-- makes the view honour the caller's role, restoring RLS containment.
-- Requires Postgres 15+ (Supabase is on PG15+).
-- =============================================================================

alter view if exists public.kg_supernodes          set (security_invoker = true);
alter view if exists public.v_daemon_budget_health set (security_invoker = true);
alter view if exists public.v_task_budget_health   set (security_invoker = true);

-- =============================================================================
-- 3. search_path pin — CVE-2018-1058 family attack surface. A function with
-- mutable search_path can be tricked into resolving an unqualified identifier
-- (e.g. `tablename`) against an attacker-controlled schema injected ahead of
-- public. Pinning search_path to (public, extensions, pg_catalog) closes
-- that path while keeping pg_catalog last so built-ins still resolve.
--
-- We discover the actual function signature(s) from pg_proc at apply time so
-- the migration tolerates overloads and parameter-list drift without churn.
-- =============================================================================

do $$
declare
  fn record;
  target_names text[] := array[
    'skill_graduations_touch_updated_at',
    'match_chunks',
    'kg_nodes_touch_updated_at',
    'increment_daemon_bucket'
  ];
begin
  for fn in
    select n.nspname                                 as schema_name,
           p.proname                                 as func_name,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(target_names)
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = public, extensions, pg_catalog',
      fn.schema_name, fn.func_name, fn.args
    );
  end loop;
end$$;

-- =============================================================================
-- 4. REVOKE EXECUTE FROM PUBLIC — Postgres grants EXECUTE on every new
-- function to PUBLIC by default. The advisor flagged the named RPCs, but
-- the safe sweep is to strip the implicit PUBLIC grant from every
-- user-defined function and procedure in the public schema. Explicit
-- GRANTs to service_role / anon / authenticated (created by the
-- application or by Supabase auto-grants) are preserved.
--
-- prokind filter: 'f' = function, 'p' = procedure. Aggregates ('a') and
-- window functions ('w') are excluded — they have different grant semantics.
-- =============================================================================

do $$
declare
  fn record;
begin
  for fn in
    select n.nspname                                 as schema_name,
           p.proname                                 as func_name,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
  loop
    execute format(
      'revoke execute on function %I.%I(%s) from public',
      fn.schema_name, fn.func_name, fn.args
    );
  end loop;
end$$;
