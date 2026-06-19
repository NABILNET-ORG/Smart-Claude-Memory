-- 029_kg_upsert_node_from_chunk.sql
-- SCM-S55 Commit B — Server-side chunk→node embedding copy.
--
-- Problem: the graph-extractor daemon was selecting memory_chunks.embedding
-- into Node.js on every tick just to write it back into kg_nodes.embedding —
-- a wasteful 768-dim round-trip / egress for every chunk processed.
--
-- Solution: a new RPC that copies the embedding server-side by chunk_id via a
-- single INSERT…ON CONFLICT. No temp tables, no loops, zero vector egress.
--
-- Mirrors kg_upsert_node's exact conflict/merge semantics (020_knowledge_graph.sql).

create or replace function public.kg_upsert_node_from_chunk(
  p_project_id      text,
  p_type            text,
  p_label           text,
  p_properties      jsonb    default '{}'::jsonb,
  p_source_chunk_id bigint   default null
) returns bigint
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_emb extensions.vector(768);
  r_id  bigint;
begin
  -- Pull the embedding server-side so the vector never crosses the wire.
  if p_source_chunk_id is not null then
    select embedding
      into v_emb
      from public.memory_chunks
     where id = p_source_chunk_id;
    -- If chunk not found or embedding is null, v_emb stays null — safe.
  end if;

  insert into public.kg_nodes (
    project_id, type, label, properties, embedding, source_chunk_id
  ) values (
    p_project_id, p_type, p_label, p_properties, v_emb, p_source_chunk_id
  )
  on conflict (project_id, type, label) do update
    set properties      = excluded.properties,
        embedding       = coalesce(excluded.embedding, public.kg_nodes.embedding),
        source_chunk_id = coalesce(excluded.source_chunk_id, public.kg_nodes.source_chunk_id),
        updated_at      = now()
  returning id into r_id;

  return r_id;
end;
$$;

comment on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint) is
  'SCM-S55 — Idempotent node insert keyed by (project_id, type, label). '
  'Copies embedding from memory_chunks server-side when p_source_chunk_id is '
  'provided — eliminates 768-dim egress from the graph-extractor daemon. '
  'On conflict, embedding and source_chunk_id are only overwritten when the '
  'incoming values are non-null — protects existing semantic anchors.';

-- Revoke public access, grant only to the service role.
revoke all on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint)
  from public;

grant execute on function public.kg_upsert_node_from_chunk(text, text, text, jsonb, bigint)
  to service_role;
