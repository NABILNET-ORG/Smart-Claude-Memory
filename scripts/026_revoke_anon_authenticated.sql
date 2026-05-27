-- Migration 026: Explicit REVOKE from anon + authenticated (Session 46, SCM-S46-F2)
--
-- Follow-up to Migration 025. The Supabase Security Advisor continued to flag
-- two finding classes after the PUBLIC revoke:
--   * anon_security_definer_function_executable
--   * authenticated_security_definer_function_executable
--
-- Why PUBLIC wasn't enough: PostgREST exposes RPCs through the `anon` and
-- `authenticated` roles. Supabase auto-grants EXECUTE on every new function
-- to these two roles (via the `public` schema GRANT chain that fires on
-- function creation). Stripping the implicit PUBLIC grant in 025 closed
-- the catch-all path but left the explicit role grants intact — so the
-- linter (correctly) still reports the functions as caller-reachable.
--
-- This migration strips those explicit role grants for every user-defined
-- function/procedure in the public schema. service_role is unaffected — it
-- retains its explicit GRANT (and BYPASSRLS for tables), so the documented
-- service_role-only call path keeps working unchanged.
--
-- Forward-only, idempotent: REVOKE on a role that holds no grant is a silent
-- no-op in Postgres, so re-applying is safe.

do $$
declare
  rec record;
  func_sig text;
begin
  for rec in
    select n.nspname                                 as schema_name,
           p.proname                                 as func_name,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f','p')
  loop
    func_sig := format('%I.%I(%s)', rec.schema_name, rec.func_name, rec.args);
    execute 'revoke execute on function ' || func_sig || ' from anon, authenticated';
  end loop;
end$$;
