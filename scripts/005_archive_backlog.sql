-- 005_archive_backlog.sql
-- Replaces delete-based pruning with a persistent archive. Idempotent.

create table if not exists archive_backlog (
  id                bigserial primary key,
  cloud_backlog_id  bigint,
  project_id        text not null,
  title             text not null,
  status            text not null
                    check (status in ('todo','in_progress','blocked','done')),
  priority          int  not null check (priority between 1 and 5),
  notes             text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  archived_at       timestamptz not null default now()
);

create index if not exists archive_backlog_project_archived_idx
  on archive_backlog (project_id, archived_at desc);

comment on table archive_backlog is
  'Completed tasks moved out of cloud_backlog. One row per archived task. cloud_backlog_id references the original id for traceability.';

-- Transactional archive — DELETE ... RETURNING feeds INSERT in one statement,
-- so either both succeed or neither takes effect.
create or replace function archive_done_backlog(p_project_id text)
returns int
language plpgsql
as $$
declare
  n int;
begin
  with moved as (
    delete from cloud_backlog
    where project_id = p_project_id and status = 'done'
    returning id, project_id, title, status, priority, notes, metadata, created_at, updated_at
  )
  insert into archive_backlog (
    cloud_backlog_id, project_id, title, status, priority, notes, metadata, created_at, updated_at
  )
  select id, project_id, title, status, priority, notes, metadata, created_at, updated_at
  from moved;

  get diagnostics n = row_count;
  return n;
end;
$$;
