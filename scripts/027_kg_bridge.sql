-- 027_kg_bridge.sql — SCM-S50 concept-bridge re-rank support.
--
-- kg_bridge_chunks(p_concept_ids, p_project_id): given concept node ids
-- (FILE / SYMBOL / DECISION), return every chunk that MENTIONS them, via the
-- chunk-anchoring primary node edged to each concept. The chunk id is read with
-- COALESCE(column, properties->>'source_chunk_id') because the column is only
-- partially populated (SCM-S50 verification: 206/381 column vs 356/381 props;
-- column is a strict subset, 0 disagreements). Bidirectional edge match handles
-- DECISION's dual role (primary AND concept). The chunk-anchor end is selected
-- by "has a chunk id", NOT by type, so DECISION primaries' edges are included.
--
-- Pure SELECT, STABLE, SECURITY DEFINER with a pinned search_path — mirrors
-- kg_hybrid_search (scripts/020_knowledge_graph.sql).

create or replace function public.kg_bridge_chunks(
  p_concept_ids bigint[],
  p_project_id  text
) returns table(concept_id bigint, chunk_id bigint, w_ck double precision)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select
    c.id as concept_id,
    coalesce(p.source_chunk_id, (p.properties->>'source_chunk_id')::bigint) as chunk_id,
    e.weight as w_ck
  from public.kg_nodes c
  join public.kg_edges e
    on (e.source_id = c.id or e.target_id = c.id)
   and e.project_id = p_project_id
  join public.kg_nodes p
    on p.id = case when e.source_id = c.id then e.target_id else e.source_id end
   and p.project_id = p_project_id
  where c.id = any(p_concept_ids)
    and c.type in ('FILE','DECISION','SYMBOL')
    and coalesce(p.source_chunk_id, (p.properties->>'source_chunk_id')::bigint) is not null;
$$;

comment on function public.kg_bridge_chunks(bigint[], text) is
  'SCM-S50 concept-bridge: concept node ids -> (concept_id, chunk_id, edge weight) for every chunk-anchoring primary edged to those concepts. Chunk id via COALESCE(column, properties).';
