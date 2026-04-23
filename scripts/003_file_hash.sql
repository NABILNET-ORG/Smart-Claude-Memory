-- 003_file_hash.sql
-- Adds per-file hash for incremental sync (hash-gating). Idempotent.

alter table memory_chunks add column if not exists file_hash text;

-- Composite lookup for listFileHashes({project_id}) queries
create index if not exists memory_chunks_project_file_hash_idx
  on memory_chunks (project_id, file_origin);

comment on column memory_chunks.file_hash is
  'MD5 of the entire source file at last sync. Shared across all chunks from the same file. Used by sync_local_memory to skip unchanged files.';
