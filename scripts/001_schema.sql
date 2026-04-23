-- Enable pgvector
create extension if not exists vector;

-- Main table
create table if not exists memory_chunks (
  id           bigserial primary key,
  content      text not null,
  embedding    vector(768) not null,
  file_origin  text not null,
  chunk_index  int  not null default 0,
  content_hash text not null,
  metadata     jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  unique (file_origin, chunk_index)
);

-- HNSW index for cosine similarity
create index if not exists memory_chunks_embedding_idx
  on memory_chunks
  using hnsw (embedding vector_cosine_ops);

create index if not exists memory_chunks_file_origin_idx
  on memory_chunks (file_origin);

-- Similarity search RPC
create or replace function match_memory_chunks(
  query_embedding vector(768),
  match_count int default 5,
  min_similarity float default 0.0
)
returns table (
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
  where 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- Upsert helper for single-rule updates
create or replace function upsert_memory_rule(
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
  insert into memory_chunks (file_origin, chunk_index, content, embedding, content_hash, metadata, updated_at)
  values (p_file_origin, p_chunk_index, p_content, p_embedding, md5(p_content), p_metadata, now())
  on conflict (file_origin, chunk_index) do update
    set content      = excluded.content,
        embedding    = excluded.embedding,
        content_hash = excluded.content_hash,
        metadata     = excluded.metadata,
        updated_at   = now()
  returning id into r_id;
  return r_id;
end;
$$;
