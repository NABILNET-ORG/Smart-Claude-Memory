-- 028_clustering_discover_projects.sql
-- SCM-S51 Foundation Fix (#371) — server-side DISTINCT for clustering project
-- discovery.
--
-- Root cause: src/clustering/daemon.ts discoverProjects() pulled up to 5000
-- kg_nodes rows over the wire (UNORDERED) and de-duplicated project_id in Node.
-- Once the global embedded-node count exceeds 5000, that arbitrary window can
-- omit a live project — the round-robin scanner silently skips it, and the C8
-- smoke test ("discoverProjects must surface the test project_id") flakes.
-- Transferring 5000 rows to dedup in JS is also a data-transfer anti-pattern;
-- the database does set-dedup natively and far more cheaply.
--
-- Fix: a tiny RPC that returns one row per distinct project. Never truncated.
--
-- Conventions: service_role-only (anon/authenticated denied per 026); idempotent
-- (create or replace). This is NOT a vector-operator RPC (only `embedding IS NOT
-- NULL`, a null-check — no vector operator invoked), so the 023 SECURITY DEFINER
-- + extensions search_path rule does not apply; plain STABLE SQL suffices
-- (service_role bypasses RLS on public.kg_nodes).

create or replace function public.clustering_discover_projects()
returns table (project_id text)
language sql
stable
as $$
  select distinct kn.project_id
  from public.kg_nodes kn
  where kn.embedding is not null
  order by kn.project_id
$$;

comment on function public.clustering_discover_projects() is
  'SCM-S51 (#371): server-side DISTINCT of project_ids that own at least one '
  'embedded kg_node. Replaces the daemon''s unordered limit(5000)+JS-dedup, '
  'which could silently skip projects once the global embedded-node count '
  'exceeded 5000 (round-robin gap + flaky C8 smoke).';

-- service-role-only execution (mirrors 026_revoke_anon_authenticated posture).
-- Revoking from PUBLIC also drops the grant inherited by anon/authenticated.
revoke all on function public.clustering_discover_projects() from public;
grant execute on function public.clustering_discover_projects() to service_role;
