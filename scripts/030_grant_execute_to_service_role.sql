-- 030_grant_execute_to_service_role.sql
-- SCM-S55 local-parity fix.
--
-- Problem: on the local Supabase (Docker) stack, RPCs created by migrations AFTER
-- 017 (kg_upsert_node @020, match_memory_chunks recreations, kg_knn_pairs @023,
-- kg_bridge @027, ...) are NOT callable via the supabase-js service key — they lack
-- an EXECUTE grant for `service_role`. 017's ALTER DEFAULT PRIVILEGES did not
-- propagate to those later-created functions on this stack. (Table DML via the
-- service key already works — only FUNCTION execute is missing.)
--
-- Fix: grant EXECUTE on all existing public functions to the trusted backend role
-- `service_role`, and set the default for functions created by future migrations.
-- This is the role the supabase-js SECRET_KEY maps to; anon/authenticated remain
-- revoked (migration 026) for security — we deliberately do NOT grant to them.
--
-- Idempotent: GRANT and ALTER DEFAULT PRIVILEGES are safely re-runnable.
-- Safe on cloud too (restores the intended 017 grant; no-op where already present).

grant execute on all functions in schema public to service_role;

alter default privileges in schema public
  grant execute on functions to service_role;
