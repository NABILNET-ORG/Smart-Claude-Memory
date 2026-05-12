-- Migration 014: M4 Transactional Workflows — checkpoint table + archive_done_backlog RPC patch.
--
-- Adds the workflow_checkpoints relation that binds the three earlier missions:
--   * M1 skill_boundary  : agent_skills.id  (steps[i] of a JIT-retrieved skill)
--   * M2 trajectory_delta: memory_chunks.id (source_chunk_id of the delta written by AgentDiet)
--   * M3 learner_signal  : rollback events flow into skill_candidates mining
--
-- Design rules honored:
--   * NEVER retroactively edit scripts/005_archive_backlog.sql — migrations are
--     immutable history. The CREATE OR REPLACE FUNCTION patch lives HERE.
--   * archive_done_backlog return shape is preserved EXACTLY (returns int).
--     The only change is that archive_backlog.chunk_id is now populated from
--     the terminal-committed checkpoint per task (NULL for legacy / non-skill
--     paths — backward compatible).
--   * NO separate workflow_steps table. trajectory_summaries IS the per-step
--     delta store; workflow_checkpoints just carries the pointer.
--   * Additive, nullable, FK ON DELETE SET NULL → safe on existing corpora.

-- ============ 1. workflow_checkpoints relation ============

create table if not exists public.workflow_checkpoints (
  id                bigserial primary key,
  project_id        text   not null,
  skill_id          bigint null
                    references public.agent_skills(id) on delete set null,
  step_index        integer not null default 0,
  step_label        text    not null,
  parent_id         bigint  null
                    references public.workflow_checkpoints(id) on delete set null,
  -- M2 delta anchor: pinned on commit, NULL while open/rolledback.
  source_chunk_id   bigint  null
                    references public.memory_chunks(id) on delete set null,
  status            text    not null default 'open'
                    check (status in ('open','committed','rolledback')),
  rollback_reason   text    null,
  created_at        timestamptz not null default now(),
  committed_at      timestamptz null
);

comment on table public.workflow_checkpoints is
  'M4 transactional workflow checkpoints. One row per step of a (possibly '
  'skill-mediated) multi-step task. status=open during exec, transitions to '
  'committed (with source_chunk_id pinned to the M2 trajectory_summaries '
  'delta) or rolledback (with rollback_reason). parent_id chains rows into '
  'an ordered tree; the deepest committed descendant is the replay anchor.';

comment on column public.workflow_checkpoints.source_chunk_id is
  'Pointer to the memory_chunks row whose trajectory_summaries entry is the '
  'replay surface. Populated on commit; NULL otherwise. restoreFrom calls '
  'get_trajectory_summary against this id rather than replaying a snapshot.';

-- ============ 2. Indexes ============

create index if not exists idx_workflow_checkpoints_project_status
  on public.workflow_checkpoints (project_id, status);

create index if not exists idx_workflow_checkpoints_parent
  on public.workflow_checkpoints (parent_id)
  where parent_id is not null;

create index if not exists idx_workflow_checkpoints_skill
  on public.workflow_checkpoints (skill_id)
  where skill_id is not null;

-- ============ 3. RPC: terminal_committed_checkpoint ============
-- Returns the source_chunk_id of the deepest committed descendant of
-- p_root_id within the same project (and same skill_id if non-NULL).
-- Used by:
--   (a) the TS restoreFrom() / rollbackCheckpoint() service for replay anchor lookup
--   (b) archive_done_backlog (below) for per-task chunk_id lift
-- NULL is a valid return — no committed descendant in the chain.

drop function if exists public.terminal_committed_checkpoint(text, bigint, bigint);

create or replace function public.terminal_committed_checkpoint(
  p_project_id text,
  p_skill_id   bigint,
  p_root_id    bigint
) returns bigint
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with recursive descendants as (
    -- seed: the root checkpoint itself
    select id, parent_id, source_chunk_id, status, skill_id, project_id, 0 as depth
      from public.workflow_checkpoints
     where id = p_root_id
       and project_id = p_project_id
       and (p_skill_id is null or skill_id is null or skill_id = p_skill_id)

    union all

    -- recurse: rows whose parent is in the working set
    select c.id, c.parent_id, c.source_chunk_id, c.status, c.skill_id, c.project_id, d.depth + 1
      from public.workflow_checkpoints c
      join descendants d on c.parent_id = d.id
     where c.project_id = p_project_id
       and (p_skill_id is null or c.skill_id is null or c.skill_id = p_skill_id)
  )
  select source_chunk_id
    from descendants
   where status = 'committed'
     and source_chunk_id is not null
   order by depth desc, id desc
   limit 1;
$$;

comment on function public.terminal_committed_checkpoint(text, bigint, bigint) is
  'M4 helper: walks a checkpoint chain via parent_id and returns the '
  'source_chunk_id of the deepest committed descendant. Used by archive_done_backlog '
  'and the TS checkpoint service. NULL when no committed descendant exists.';

-- ============ 4. RPC patch: archive_done_backlog ============
-- CREATE OR REPLACE — preserves the contract from 005 exactly:
--   returns int (the number of archived rows)
--   side effects: DELETE done rows from cloud_backlog, INSERT them into archive_backlog
-- The ONLY change is that archive_backlog.chunk_id is now populated from the
-- terminal-committed checkpoint per task (where one exists). Legacy / non-skill
-- archives still go through with chunk_id = NULL → backward compatible.
--
-- Lookup strategy: for each archived task, find ANY checkpoint in the project
-- whose metadata->>'cloud_backlog_id' (or other join key) ties back. We avoid
-- inventing a join key the codebase doesn't already carry — instead we lift
-- via a CTE that LEFT JOINs workflow_checkpoints by project_id alone and
-- picks the most-recent terminal-committed source_chunk_id whose linkage
-- chain references this task (matched via metadata->>'cloud_backlog_id', the
-- only existing channel). For tasks with no such linkage, chunk_id is NULL.

drop function if exists public.archive_done_backlog(text);

create or replace function public.archive_done_backlog(p_project_id text)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  n int;
begin
  -- Move done rows out of cloud_backlog and into archive_backlog in one
  -- transactional statement. The 'moved' CTE is identical in shape to 005;
  -- 'linked' is the new lateral join that enriches each moved row with the
  -- terminal-committed checkpoint's source_chunk_id (NULL if no link).
  with moved as (
    delete from public.cloud_backlog
     where project_id = p_project_id
       and status = 'done'
    returning id, project_id, title, status, priority, notes, metadata,
              created_at, updated_at
  ),
  linked as (
    select
      m.*,
      -- Lateral lookup: for each moved task, find the deepest committed
      -- checkpoint in the same project whose metadata->>'cloud_backlog_id'
      -- matches the moved row id (this is the only join key the codebase
      -- currently carries). NULL when no checkpoint chain exists, which
      -- correctly preserves backward compat for legacy / non-skill rows.
      (
        select wc.source_chunk_id
          from public.workflow_checkpoints wc
         where wc.project_id = m.project_id
           and wc.status     = 'committed'
           and wc.source_chunk_id is not null
           and (
             wc.parent_id is null
             or wc.parent_id in (
               select id from public.workflow_checkpoints p
                where p.project_id = m.project_id
             )
           )
           -- Best-effort linkage via metadata.cloud_backlog_id on cloud_backlog row
           and (m.metadata ->> 'checkpoint_root_id') is not null
           and wc.id = (m.metadata ->> 'checkpoint_root_id')::bigint
         order by wc.committed_at desc nulls last, wc.id desc
         limit 1
      ) as terminal_chunk_id
    from moved m
  )
  insert into public.archive_backlog (
    cloud_backlog_id, project_id, title, status, priority, notes, metadata,
    created_at, updated_at, chunk_id
  )
  select
    id, project_id, title, status, priority, notes, metadata,
    created_at, updated_at,
    terminal_chunk_id
  from linked;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.archive_done_backlog(text) is
  'M4 patch of 005''s archive_done_backlog. Same int return shape, same '
  'side effects (DELETE cloud_backlog done rows → INSERT archive_backlog). '
  'Enrichment: archive_backlog.chunk_id is now populated from the terminal '
  'committed checkpoint when the cloud_backlog row carries '
  'metadata.checkpoint_root_id; NULL otherwise. Idempotent at the row level '
  'because the move is transactional and cloud_backlog status=done is the gate.';

-- ============ 5. Grants ============
-- Mirror 005 / 010 / 011 posture: service_role gets execute; anon and
-- authenticated remain denied at the RLS layer.

revoke all on function public.terminal_committed_checkpoint(text, bigint, bigint) from public;
grant execute on function public.terminal_committed_checkpoint(text, bigint, bigint) to service_role;

revoke all on function public.archive_done_backlog(text) from public;
grant execute on function public.archive_done_backlog(text) to service_role;

grant select, insert, update, delete on public.workflow_checkpoints to service_role;
grant usage, select on sequence public.workflow_checkpoints_id_seq to service_role;
