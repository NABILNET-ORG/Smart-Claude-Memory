-- 002_multi_project.sql
-- Adds strict per-project isolation. Idempotent.

-- 1. Add project_id column + backfill existing rows
alter table memory_chunks add column if not exists project_id text;
update memory_chunks set project_id = 'default' where project_id is null;
alter table memory_chunks alter column project_id set not null;
alter table memory_chunks alter column project_id set default 'default';

-- 2. Drop the old 2-col unique constraint so the same file can live in multiple projects
alter table memory_chunks drop constraint if exists memory_chunks_file_origin_chunk_index_key;

-- 3. New 3-col unique index (project_id scoped)
create unique index if not exists memory_chunks_project_file_chunk_uniq
  on memory_chunks (project_id, file_origin, chunk_index);

-- 4. Filter index for project_id lookups
create index if not exists memory_chunks_project_id_idx
  on memory_chunks (project_id);

-- 5. Drop old RPC signatures (new ones have different arg lists)
drop function if exists match_memory_chunks(vector, int, float);
drop function if exists upsert_memory_rule(text, int, text, vector, jsonb);

-- 6. New match function with STRICT project filter
create or replace function match_memory_chunks(
  query_embedding vector(768),
  p_project_id text,
  match_count int default 5,
  min_similarity float default 0.0
) returns table (
  id bigint,
  content text,
  file_origin text,
  chunk_index int,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.file_origin,
    m.chunk_index,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from memory_chunks m
  where m.project_id = p_project_id
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- 7. Project-aware upsert helper
create or replace function upsert_memory_rule(
  p_project_id text,
  p_file_origin text,
  p_chunk_index int,
  p_content text,
  p_embedding vector(768),
  p_metadata jsonb default '{}'::jsonb
) returns bigint
language plpgsql as $$
declare
  r_id bigint;
begin
  insert into memory_chunks (project_id, file_origin, chunk_index, content, embedding, content_hash, metadata, updated_at)
  values (p_project_id, p_file_origin, p_chunk_index, p_content, p_embedding, md5(p_content), p_metadata, now())
  on conflict (project_id, file_origin, chunk_index) do update
    set content      = excluded.content,
        embedding    = excluded.embedding,
        content_hash = excluded.content_hash,
        metadata     = excluded.metadata,
        updated_at   = now()
  returning id into r_id;
  return r_id;
end;
$$;
