-- 031_successful_chunks_view.sql
-- SCM-S58 — Organic-learning backfill: metadata-driven "successful work" signal.
--
-- Problem: the skill miner (src/sleep/miner.ts) inner-joins trajectory summaries
-- against a "successful trajectory" set previously sourced from archive_backlog
-- rows carrying a chunk_id. In reality archive_backlog holds release milestones
-- with no chunk linkage, so the success set is always empty and zero skills mine.
--
-- Fix: define "successful, learnable work" as a property of the memory itself,
-- exposed as a single-source-of-truth view the miner reads. A chunk qualifies
-- when its metadata marks canonical knowledge (type DECISION/PATTERN), a finished
-- status, or global promotion. ERROR/LOG/untyped/in-flight chunks are excluded.
--
-- Idempotent: CREATE OR REPLACE VIEW + idempotent GRANT.

create or replace view public.successful_chunks as
select
  id          as chunk_id,
  project_id,
  metadata
from public.memory_chunks
where metadata->>'type' in ('DECISION', 'PATTERN')
   or metadata->>'status' in (
        'shipped', 'applied', 'implemented', 'verified',
        'deployed', 'fixed', 'verified-live', 'session-closed'
      )
   or metadata->>'is_global' = 'true';

grant select on public.successful_chunks to service_role;
