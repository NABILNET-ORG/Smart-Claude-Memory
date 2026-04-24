-- 004_backlog_frozen.sql
-- Adds per-project task backlog and frozen-feature patterns. Idempotent.

create table if not exists cloud_backlog (
  id           bigserial primary key,
  project_id   text not null,
  title        text not null,
  status       text not null default 'todo'
               check (status in ('todo', 'in_progress', 'blocked', 'done')),
  priority     int  not null default 3 check (priority between 1 and 5),
  notes        text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists cloud_backlog_project_status_idx
  on cloud_backlog (project_id, status);

create index if not exists cloud_backlog_project_prio_idx
  on cloud_backlog (project_id, priority, created_at);

comment on table cloud_backlog is
  'Autonomous session-to-session task handover. Each row is one atomic task scoped to a project_id.';

create table if not exists frozen_features (
  id           bigserial primary key,
  project_id   text not null,
  pattern      text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  unique (project_id, pattern)
);

create index if not exists frozen_features_project_idx
  on frozen_features (project_id);

comment on table frozen_features is
  'Paths or glob-like patterns that must be modified line-by-line (Edit) only, never fully rewritten (Write). Checked by md-policy.py hook.';
