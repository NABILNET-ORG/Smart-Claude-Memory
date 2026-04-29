-- 006_smoke.sql
-- Functional smoke test for 006_security_hardening.sql.
-- Proves the moved pgvector + 3 functions still work end-to-end against the
-- live (multi-project) schema. Self-cleaning: deletes its own test rows.
-- Run in Supabase SQL Editor or via psql.
--
-- Note: signatures differ from 001_schema.sql because 002_multi_project.sql
-- added p_project_id to upsert_memory_rule and match_memory_chunks. This
-- script targets the CURRENT signatures shown in pg_proc.

do $$
declare
  test_project  constant text := '__verify_006__';
  test_origin   constant text := '__verify_006__/smoke.md';
  zero_vec      vector(768) := array(
                  select 0.1::real from generate_series(1, 768)
                )::vector(768);
  upserted_id   bigint;
  match_count   int;
  task_id       bigint;
  archived_n    int;
  archive_seen  int;
begin
  -- 1. upsert_memory_rule: round-trip through pgvector (now in extensions schema).
  upserted_id := upsert_memory_rule(
    test_project,
    test_origin,
    0,
    'security smoke test row - safe to delete'::text,
    zero_vec,
    jsonb_build_object('source','006_smoke')
  );
  if upserted_id is null then
    raise exception '[006_smoke] upsert_memory_rule returned NULL';
  end if;
  raise notice '[006_smoke] upsert_memory_rule OK (id=%)', upserted_id;

  -- 2. match_memory_chunks: cosine-search must find the upserted row.
  --    With identical embeddings, similarity = 1.0 (>= 0.99 threshold).
  select count(*) into match_count
  from match_memory_chunks(zero_vec, test_project, 5, 0.99)
  where file_origin = test_origin;
  if match_count < 1 then
    raise exception '[006_smoke] match_memory_chunks did not return the upserted row (got %)', match_count;
  end if;
  raise notice '[006_smoke] match_memory_chunks OK (% match)', match_count;

  -- 3. archive_done_backlog: must move done rows from cloud_backlog -> archive_backlog.
  insert into cloud_backlog (project_id, title, status, priority, notes)
  values (test_project, 'smoke task', 'done', 3, '006_smoke')
  returning id into task_id;

  archived_n := archive_done_backlog(test_project);
  if archived_n < 1 then
    raise exception '[006_smoke] archive_done_backlog reported 0 moves; expected >=1';
  end if;

  if exists (select 1 from cloud_backlog where id = task_id) then
    raise exception '[006_smoke] archive_done_backlog left the row in cloud_backlog (id=%)', task_id;
  end if;

  select count(*) into archive_seen
  from archive_backlog where cloud_backlog_id = task_id;
  if archive_seen <> 1 then
    raise exception '[006_smoke] archive_backlog row missing for cloud_backlog_id=% (count=%)', task_id, archive_seen;
  end if;
  raise notice '[006_smoke] archive_done_backlog OK (% moved)', archived_n;

  -- 4. Cleanup. The connecting role bypasses RLS, so direct DELETE works.
  delete from archive_backlog where project_id = test_project;
  delete from cloud_backlog   where project_id = test_project;
  delete from memory_chunks   where project_id = test_project
                                 and file_origin = test_origin;

  raise notice '[006_smoke] PASSED - all 3 functions work, pgvector resolves from extensions schema';
end $$;
