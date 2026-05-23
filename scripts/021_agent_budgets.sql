-- 021_agent_budgets.sql
-- Agentic Resource Manager (SCM-S39-D1, v2.2.2).
--
-- Two structurally decoupled budget surfaces share nothing but a common
-- gate API in src/budget/gate.ts and the same off/warn/enforce mode switch:
--
--   1. PER-TASK surface  — bounds an Orchestrator session's LLM calls.
--      Lifecycle:   start_task → ... → end_task.
--      Counters:    anthropic_tokens, ollama_calls, subagent_depth.
--      Tables:      budget_tasks, budget_task_events.
--      View:        v_task_budget_health.
--
--   2. PER-DAEMON surface — bounds setInterval-driven daemons' Ollama
--      generate calls per ROLLING HOUR per daemon. Has NO task_id —
--      daemons have no parent Orchestrator session.
--      Counters:    ollama_calls, embed_calls.
--      Tables:      daemon_budget_buckets (atomic UPSERT per hour),
--                   daemon_budget_events  (append-only audit log).
--      View:        v_daemon_budget_health.
--
-- Hardening mirrors migration 006 + 017: RLS deny-all + explicit
-- service-role GRANTs. Telemetry pruner retention is extended in
-- application code (src/telemetry/pruner.ts), not in this migration.
--
-- Idempotent. Safe to re-apply.

-- ──────────────────────────────────────────────────────────────────────
-- 1A — Per-Task Surface
-- ──────────────────────────────────────────────────────────────────────

create table if not exists budget_tasks (
  task_id               uuid primary key default gen_random_uuid(),
  project_id            text not null,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  mode                  text not null check (mode in ('off','warn','enforce')),
  frozen_caps           jsonb not null,
  anthropic_tokens_used int  not null default 0,
  ollama_calls_used     int  not null default 0,
  subagent_depth_max    int  not null default 0
);
create index if not exists budget_tasks_project_started_idx
  on budget_tasks(project_id, started_at desc);
create index if not exists budget_tasks_open_idx
  on budget_tasks(project_id)
  where ended_at is null;

create table if not exists budget_task_events (
  id          bigserial primary key,
  task_id     uuid not null references budget_tasks(task_id) on delete cascade,
  ts          timestamptz not null default now(),
  axis        text not null check (axis in ('anthropic_tokens','ollama_calls','subagent_depth')),
  delta       int  not null,
  total_after int  not null,
  decision    text not null check (decision in ('allow','warn','block')),
  payload     jsonb
);
create index if not exists budget_task_events_task_ts_idx
  on budget_task_events(task_id, ts desc);

create or replace view v_task_budget_health as
  select task_id,
         project_id,
         started_at,
         ended_at,
         mode,
         anthropic_tokens_used,
         ollama_calls_used,
         subagent_depth_max,
         frozen_caps,
         case
           when (frozen_caps->>'anthropic_tokens')::int > 0
           then anthropic_tokens_used::float / (frozen_caps->>'anthropic_tokens')::int
           else null
         end as anthropic_burn_ratio,
         case
           when (frozen_caps->>'ollama_calls')::int > 0
           then ollama_calls_used::float / (frozen_caps->>'ollama_calls')::int
           else null
         end as ollama_burn_ratio
  from budget_tasks;

-- ──────────────────────────────────────────────────────────────────────
-- 1B — Per-Daemon Surface (Rolling-Hour Buckets)
-- ──────────────────────────────────────────────────────────────────────

create table if not exists daemon_budget_buckets (
  id           bigserial primary key,
  daemon       text not null,
  axis         text not null check (axis in ('ollama_calls','embed_calls')),
  hour_bucket  timestamptz not null,
  count        int not null default 0,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  unique (daemon, axis, hour_bucket)
);
create index if not exists daemon_budget_buckets_daemon_hour_idx
  on daemon_budget_buckets(daemon, hour_bucket desc);

create table if not exists daemon_budget_events (
  id            bigserial primary key,
  daemon        text not null,
  ts            timestamptz not null default now(),
  axis          text not null check (axis in ('ollama_calls','embed_calls')),
  delta         int not null,
  total_in_hour int not null,
  cap           int not null,
  decision      text not null check (decision in ('allow','warn','block')),
  mode          text not null check (mode in ('off','warn','enforce')),
  payload       jsonb
);
create index if not exists daemon_budget_events_daemon_ts_idx
  on daemon_budget_events(daemon, ts desc);

create or replace view v_daemon_budget_health as
  select daemon,
         axis,
         hour_bucket,
         count,
         first_seen,
         last_seen
  from daemon_budget_buckets
  where hour_bucket = date_trunc('hour', now());

-- ──────────────────────────────────────────────────────────────────────
-- 1C — Atomic Daemon Bucket Upsert RPC
-- ──────────────────────────────────────────────────────────────────────
-- Single round-trip increment with read-after-write. Daemon ticks call
-- this once per `delta` (typically batch size) — no race against
-- concurrent ticks because the (daemon, axis, hour_bucket) UNIQUE forces
-- ON CONFLICT serialization at the row-lock level.

create or replace function increment_daemon_bucket(
  p_daemon      text,
  p_axis        text,
  p_delta       int
) returns int
language plpgsql
security definer
as $$
declare
  v_total int;
begin
  insert into daemon_budget_buckets (daemon, axis, hour_bucket, count, first_seen, last_seen)
  values (p_daemon, p_axis, date_trunc('hour', now()), p_delta, now(), now())
  on conflict (daemon, axis, hour_bucket)
  do update set
    count     = daemon_budget_buckets.count + p_delta,
    last_seen = now()
  returning count into v_total;
  return v_total;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 1D — Hardening (mirrors 006_security_hardening + 017_explicit_service_role_grants)
-- ──────────────────────────────────────────────────────────────────────

alter table budget_tasks            enable row level security;
alter table budget_task_events      enable row level security;
alter table daemon_budget_buckets   enable row level security;
alter table daemon_budget_events    enable row level security;

-- Deny-all policies (idempotent via drop/create).
drop policy if exists "deny_all_budget_tasks"           on budget_tasks;
drop policy if exists "deny_all_budget_task_events"     on budget_task_events;
drop policy if exists "deny_all_daemon_budget_buckets"  on daemon_budget_buckets;
drop policy if exists "deny_all_daemon_budget_events"   on daemon_budget_events;

create policy "deny_all_budget_tasks"           on budget_tasks           for all using (false) with check (false);
create policy "deny_all_budget_task_events"     on budget_task_events     for all using (false) with check (false);
create policy "deny_all_daemon_budget_buckets"  on daemon_budget_buckets  for all using (false) with check (false);
create policy "deny_all_daemon_budget_events"   on daemon_budget_events   for all using (false) with check (false);

-- Explicit service-role grants — anon/authenticated have zero access.
grant select, insert, update, delete on budget_tasks            to service_role;
grant select, insert, update, delete on budget_task_events      to service_role;
grant select, insert, update, delete on daemon_budget_buckets   to service_role;
grant select, insert, update, delete on daemon_budget_events    to service_role;
grant usage,  select                  on sequence budget_task_events_id_seq      to service_role;
grant usage,  select                  on sequence daemon_budget_buckets_id_seq   to service_role;
grant usage,  select                  on sequence daemon_budget_events_id_seq    to service_role;
grant execute on function increment_daemon_bucket(text, text, int) to service_role;

-- Default privileges for any future tables/sequences in this migration.
alter default privileges for role service_role in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges for role service_role in schema public
  grant usage, select on sequences to service_role;
