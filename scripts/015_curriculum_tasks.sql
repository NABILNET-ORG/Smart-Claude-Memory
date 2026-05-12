-- Migration 015: M5 Autonomous Curriculum — Single-Brain Closure.
--
-- Agentic OS 2026 / Mission 5 / SCM-S21-D1. Implements the deterministic
-- queue layer described in ARCHITECTURE.md §4.7. The daemon enqueues raw
-- stubs via heuristics ONLY — no LLM generation. The Orchestrator (Claude)
-- pulls a stub, writes code under an M4 checkpoint, clears the verification
-- gate, then calls apply_curriculum_task to atomically:
--   * mark the task verified,
--   * pin the linked checkpoint id,
--   * if linked_candidate_id is set, fire promote_candidate_to_skill
--     (M5 is the ONLY caller permitted this side effect — auto-promote
--     lives inside this one transaction, NOT as a global flag flip).
--
-- Design rules honored:
--   * NEVER edit prior migrations — this file is additive only.
--   * NO new generative surface — the schema has no name/steps columns to
--     hold proposed content. Content authorship belongs to the Orchestrator
--     downstream, not to the daemon.
--   * Idempotent: every CREATE uses IF NOT EXISTS or DROP IF EXISTS first.
--   * RLS posture mirrors 006/010/011/012 — service_role only.

-- ============ 1. curriculum_tasks relation ============

create table if not exists public.curriculum_tasks (
  id                    bigserial primary key,
  project_id            text   not null,
  kind                  text   not null
                        check (kind in ('test_gap','refactor','rollback_repro')),
  target_path           text   not null,
  rationale             text   not null,
  signal_source         jsonb  not null default '{}'::jsonb,
  linked_candidate_id   bigint null
                        references public.skill_candidates(id) on delete set null,
  linked_checkpoint_id  bigint null
                        references public.workflow_checkpoints(id) on delete set null,
  status                text   not null default 'queued'
                        check (status in ('queued','pulled','attempted','verified','rejected','expired')),
  rejection_reason      text   null,
  pulled_by_session_id  text   null,
  pulled_at             timestamptz null,
  verified_at           timestamptz null,
  expires_at            timestamptz null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.curriculum_tasks is
  'M5 Autonomous Curriculum (Agentic OS 2026 / SCM-S21-D1). Deterministic '
  'queue of test-gap / refactor / rollback-repro stubs enqueued by the '
  'curriculum_daemon. The daemon writes only this table — no code, no '
  'LLM-generated content. The Orchestrator (Claude) pulls via '
  'pull_next_curriculum_task, executes inside an M4 checkpoint, then calls '
  'apply_curriculum_task which atomically verifies + (if linked) fires '
  'promote_candidate_to_skill. M5 is the ONLY auto-promote caller.';

comment on column public.curriculum_tasks.linked_candidate_id is
  'When set, a successful apply_curriculum_task fires '
  'promote_candidate_to_skill(linked_candidate_id, ...) inside the same '
  'transaction. This is the M3 auto-promote bridge — only stale-candidate '
  'curriculum tasks carry this link.';

comment on column public.curriculum_tasks.signal_source is
  'Deterministic signal payload: {coverage_pct?, rollback_count?, '
  'candidate_id?, embedding_centroid?, scanned_at}. Reproducible — the same '
  'inputs to scanner.ts produce the same payload.';

-- ============ 2. Indexes ============

-- Idempotency: at most one queued task per (project, target, kind).
-- Once status leaves 'queued' (pulled/verified/etc), a new stub for the same
-- target can be enqueued — this lets the daemon re-flag a file after a
-- previous attempt was rejected or expired.
create unique index if not exists curriculum_tasks_queued_target_kind_uniq
  on public.curriculum_tasks (project_id, target_path, kind)
  where status = 'queued';

-- Status-window scans (the daemon pulls 'queued', the orchestrator lists 'pulled',
-- audit reads 'verified'/'rejected').
create index if not exists curriculum_tasks_status_created_idx
  on public.curriculum_tasks (status, created_at desc);

-- Auto-promote lookups: which tasks carry an M3 candidate link.
create index if not exists curriculum_tasks_linked_candidate_idx
  on public.curriculum_tasks (linked_candidate_id)
  where linked_candidate_id is not null;

-- Per-project scans (multi-tenant listing).
create index if not exists curriculum_tasks_project_status_idx
  on public.curriculum_tasks (project_id, status);

-- ============ 3. Row-Level Security ============
-- Same posture as migrations 006, 010, 011, 012, 014: service_role bypasses;
-- anon and authenticated are denied unconditionally.

alter table public.curriculum_tasks enable row level security;

drop policy if exists deny_anon_authenticated on public.curriculum_tasks;
create policy deny_anon_authenticated on public.curriculum_tasks
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. RPC: enqueue_curriculum_task ============
-- Idempotent insert. ON CONFLICT (project_id, target_path, kind) WHERE
-- status='queued' DO NOTHING — re-running the scanner over an unchanged
-- workspace is a no-op. Returns the row id (existing or newly inserted)
-- so the daemon can keep accurate counts.
--
-- search_path includes 'extensions' to follow the ERROR-11507 lesson
-- (006_security_hardening), even though this function does not use
-- pgvector — uniform posture across all M-series RPCs.

drop function if exists public.enqueue_curriculum_task(text, text, text, text, jsonb, bigint, timestamptz);

create function public.enqueue_curriculum_task(
  p_project_id           text,
  p_kind                 text,
  p_target_path          text,
  p_rationale            text,
  p_signal_source        jsonb,
  p_linked_candidate_id  bigint,
  p_expires_at           timestamptz
) returns table (
  task_id     bigint,
  is_new      boolean
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_id      bigint;
  v_existing bigint;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'enqueue_curriculum_task: project_id required';
  end if;
  if p_kind not in ('test_gap','refactor','rollback_repro') then
    raise exception 'enqueue_curriculum_task: invalid kind %', p_kind;
  end if;
  if p_target_path is null or length(btrim(p_target_path)) = 0 then
    raise exception 'enqueue_curriculum_task: target_path required';
  end if;

  -- Probe for an existing queued row first; the partial unique index makes
  -- this an index scan (cheap). Returning is_new=false on hit keeps the
  -- caller's counters honest.
  select id into v_existing
    from public.curriculum_tasks
   where project_id  = p_project_id
     and target_path = p_target_path
     and kind        = p_kind
     and status      = 'queued'
   limit 1;

  if v_existing is not null then
    task_id := v_existing;
    is_new  := false;
    return next;
    return;
  end if;

  insert into public.curriculum_tasks (
    project_id, kind, target_path, rationale, signal_source,
    linked_candidate_id, expires_at
  ) values (
    p_project_id, p_kind, p_target_path,
    coalesce(p_rationale, ''),
    coalesce(p_signal_source, '{}'::jsonb),
    p_linked_candidate_id,
    p_expires_at
  )
  returning id into v_id;

  task_id := v_id;
  is_new  := true;
  return next;
end;
$$;

comment on function public.enqueue_curriculum_task(text, text, text, text, jsonb, bigint, timestamptz) is
  'M5 daemon entry point. Idempotent insert keyed by the (project,target,kind) '
  'partial unique index where status=queued. Returns (task_id, is_new) so '
  'the caller can track daemon throughput.';

-- ============ 5. RPC: pull_next_curriculum_task ============
-- Atomic claim. FOR UPDATE SKIP LOCKED → multi-session safe; two concurrent
-- orchestrators never receive the same row. Stamps pulled_by_session_id +
-- pulled_at and flips status to 'pulled'.

drop function if exists public.pull_next_curriculum_task(text, text, text);

create function public.pull_next_curriculum_task(
  p_project_id   text,
  p_kind         text,
  p_session_id   text
) returns table (
  id                   bigint,
  project_id           text,
  kind                 text,
  target_path          text,
  rationale            text,
  signal_source        jsonb,
  linked_candidate_id  bigint,
  status               text,
  pulled_by_session_id text,
  pulled_at            timestamptz,
  expires_at           timestamptz,
  created_at           timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_row public.curriculum_tasks%rowtype;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'pull_next_curriculum_task: project_id required';
  end if;
  if p_kind is not null and p_kind not in ('test_gap','refactor','rollback_repro') then
    raise exception 'pull_next_curriculum_task: invalid kind %', p_kind;
  end if;

  -- Single-row claim with SKIP LOCKED. Order by priority signals:
  --   * linked_candidate_id first (these can auto-promote — high value)
  --   * then oldest queued (FIFO fairness)
  -- Table alias ct avoids ambiguity with the OUT parameter names declared
  -- in RETURNS TABLE (id, project_id, kind, ...) which shadow column names.
  select ct.* into v_row
    from public.curriculum_tasks ct
   where ct.project_id = p_project_id
     and ct.status     = 'queued'
     and (p_kind is null or ct.kind = p_kind)
     and (ct.expires_at is null or ct.expires_at > now())
   order by (ct.linked_candidate_id is not null) desc, ct.created_at asc
   for update skip locked
   limit 1;

  if v_row.id is null then
    return;
  end if;

  update public.curriculum_tasks ct
     set status               = 'pulled',
         pulled_by_session_id = p_session_id,
         pulled_at            = now(),
         updated_at           = now()
   where ct.id = v_row.id
   returning ct.* into v_row;

  id                   := v_row.id;
  project_id           := v_row.project_id;
  kind                 := v_row.kind;
  target_path          := v_row.target_path;
  rationale            := v_row.rationale;
  signal_source        := v_row.signal_source;
  linked_candidate_id  := v_row.linked_candidate_id;
  status               := v_row.status;
  pulled_by_session_id := v_row.pulled_by_session_id;
  pulled_at            := v_row.pulled_at;
  expires_at           := v_row.expires_at;
  created_at           := v_row.created_at;
  return next;
end;
$$;

comment on function public.pull_next_curriculum_task(text, text, text) is
  'M5 Orchestrator claim. FOR UPDATE SKIP LOCKED ensures two concurrent '
  'sessions never grab the same row. Status flips to pulled and stamps '
  'pulled_by_session_id + pulled_at. Returns the full row or empty set when '
  'the queue is empty. Auto-promote-eligible tasks (linked_candidate_id IS NOT NULL) '
  'are prioritized FIFO within their group.';

-- ============ 6. RPC: apply_curriculum_task ============
-- The atomic finalize. M5 is the ONLY caller of promote_candidate_to_skill
-- outside of the M3 manual promote_skill_candidate tool — and the guard rail
-- is that the auto-promote only fires inside THIS function's transaction,
-- only when (a) p_success=true, (b) the checkpoint is committed, and (c)
-- linked_candidate_id is set on the task row.
--
-- All four state mutations (status flip, linked_checkpoint_id pin,
-- verified_at stamp, promote_candidate_to_skill side effect) live in ONE
-- SQL transaction. There is no out-of-band promotion path. The boundary
-- invariant from ARCHITECTURE.md §4.7 ("grep promote_candidate_to_skill →
-- one call site") holds.

drop function if exists public.apply_curriculum_task(bigint, boolean, bigint, text, text[]);

create function public.apply_curriculum_task(
  p_task_id            bigint,
  p_success            boolean,
  p_checkpoint_id      bigint,
  p_description        text,
  p_trigger_keywords   text[]
) returns table (
  task_id              bigint,
  applied_status       text,
  linked_checkpoint_id bigint,
  promoted_candidate_id bigint,
  promoted_skill_id    bigint,
  promoted_at          timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_task   public.curriculum_tasks%rowtype;
  v_cp     public.workflow_checkpoints%rowtype;
  v_promo  record;
begin
  if p_task_id is null then
    raise exception 'apply_curriculum_task: task_id required';
  end if;

  -- Load + lock the curriculum task row. SELECT FOR UPDATE prevents racing
  -- applies from two orchestrator sessions on the same task.
  select * into v_task
    from public.curriculum_tasks
   where id = p_task_id
   for update;

  if not found then
    raise exception 'apply_curriculum_task: task % not found', p_task_id;
  end if;

  if v_task.status not in ('pulled','attempted') then
    raise exception 'apply_curriculum_task: task % in state % (must be pulled or attempted)',
      p_task_id, v_task.status;
  end if;

  -- Failure path: short-circuit. No checkpoint validation, no promote.
  if not coalesce(p_success, false) then
    update public.curriculum_tasks
       set status           = 'rejected',
           rejection_reason = coalesce(p_description, 'apply: success=false'),
           linked_checkpoint_id = p_checkpoint_id,
           updated_at       = now()
     where id = p_task_id;

    task_id               := p_task_id;
    applied_status        := 'rejected';
    linked_checkpoint_id  := p_checkpoint_id;
    promoted_candidate_id := null;
    promoted_skill_id     := null;
    promoted_at           := null;
    return next;
    return;
  end if;

  -- Success path: REQUIRE a committed checkpoint. This is the M4 binding
  -- contract from ARCHITECTURE.md §4.7 — the orchestrator must have wrapped
  -- the work in a workflow_checkpoint and committed it before applying.
  if p_checkpoint_id is null then
    raise exception 'apply_curriculum_task: success requires checkpoint_id';
  end if;

  select * into v_cp
    from public.workflow_checkpoints
   where id = p_checkpoint_id
     and project_id = v_task.project_id;

  if not found then
    raise exception 'apply_curriculum_task: checkpoint % not found in project %',
      p_checkpoint_id, v_task.project_id;
  end if;

  if v_cp.status <> 'committed' then
    raise exception 'apply_curriculum_task: checkpoint % status=% (must be committed)',
      p_checkpoint_id, v_cp.status;
  end if;

  -- All preconditions met. Flip the task to verified.
  update public.curriculum_tasks
     set status               = 'verified',
         linked_checkpoint_id = p_checkpoint_id,
         verified_at          = now(),
         updated_at           = now()
   where id = p_task_id;

  -- Auto-promote bridge (the ONLY M5-permitted call to promote_candidate_to_skill).
  -- Only fires when linked_candidate_id was set by the scanner (i.e. this
  -- curriculum task originated from a stale skill_candidate).
  if v_task.linked_candidate_id is not null then
    select * into v_promo
      from public.promote_candidate_to_skill(
        v_task.linked_candidate_id,
        coalesce(
          p_description,
          format('Auto-promoted via M5 curriculum task #%s', p_task_id)
        ),
        coalesce(p_trigger_keywords, '{}'::text[])
      );

    task_id               := p_task_id;
    applied_status        := 'verified';
    linked_checkpoint_id  := p_checkpoint_id;
    promoted_candidate_id := v_task.linked_candidate_id;
    promoted_skill_id     := v_promo.skill_id;
    promoted_at           := v_promo.promoted_at;
    return next;
    return;
  end if;

  -- Verified without auto-promote (test_gap / rollback_repro path).
  task_id               := p_task_id;
  applied_status        := 'verified';
  linked_checkpoint_id  := p_checkpoint_id;
  promoted_candidate_id := null;
  promoted_skill_id     := null;
  promoted_at           := null;
  return next;
end;
$$;

comment on function public.apply_curriculum_task(bigint, boolean, bigint, text, text[]) is
  'M5 atomic finalize — the ONE call site permitted to fire promote_candidate_to_skill '
  'outside of the M3 manual promote_skill_candidate path. Validates that the '
  'M4 checkpoint is committed and the task is in pulled/attempted state. On '
  'success+linked_candidate_id, auto-promotes within the same SQL transaction. '
  'On failure, transitions to rejected with rationale.';

-- ============ 7. Grants ============
-- service_role only — same posture as 006/010/011/012/014.

revoke all on function public.enqueue_curriculum_task(text, text, text, text, jsonb, bigint, timestamptz) from public;
grant execute on function public.enqueue_curriculum_task(text, text, text, text, jsonb, bigint, timestamptz) to service_role;

revoke all on function public.pull_next_curriculum_task(text, text, text) from public;
grant execute on function public.pull_next_curriculum_task(text, text, text) to service_role;

revoke all on function public.apply_curriculum_task(bigint, boolean, bigint, text, text[]) from public;
grant execute on function public.apply_curriculum_task(bigint, boolean, bigint, text, text[]) to service_role;

grant select, insert, update, delete on public.curriculum_tasks to service_role;
grant usage, select on sequence public.curriculum_tasks_id_seq to service_role;
