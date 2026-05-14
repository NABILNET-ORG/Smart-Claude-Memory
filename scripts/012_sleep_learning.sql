-- 012_sleep_learning.sql
-- Agentic OS 2026 — Mission 3: Sleep Learning (Idle Skill Mining). Idempotent.
--
-- Architecture (DECISION SCM-S19-D1 / ARCHITECTURE.md §4.6):
--   During idle cycles, mine the archive of completed successful tasks for
--   recurring patterns and auto-propose them as reusable skills. The agent
--   stays the curator: candidates are surfaced for review, never silently
--   merged into the JIT skill vault (agent_skills).
--
--   Candidates live in a DEDICATED relation `public.skill_candidates`, NOT a
--   column on `agent_skills`. Rationale:
--     * Candidates are unpromoted, high-churn mining state with provenance
--       arrays back to source summaries/archive rows; agent_skills is the
--       clean, promoted, retrieval-facing surface. Mixing them would pollute
--       JIT recall in M1 (the request_skill ranking surface).
--     * (project_id, pattern_hash) is the natural identity for idempotent
--       re-mining: bumping frequency/success_count instead of duplicating.
--     * Promotion is a curated event — `promote_candidate_to_skill` wraps
--       `upsert_agent_skill` so the canonical agent_skills upsert path stays
--       the single source of truth for promoted skills.
--
-- Tenancy contract:
--   * project_id is the FIRST predicate in match_skill_candidates' WHERE clause.
--   * GLOBAL is permitted on promotion (Rule 10 — Sovereign Vetting at the
--     promotion gate, NOT at candidate creation; mining is per-project).
--   * RLS enabled + deny_anon_authenticated — same posture as migrations 006,
--     010, and 011. service_role bypasses; anon/authenticated denied.
--
-- Cost: $0. Pure PostgreSQL/Supabase features.

-- ============ 1. Table ============
create table if not exists public.skill_candidates (
  id                   bigserial primary key,
  project_id           text     not null,
  pattern_hash         text     not null,
  source_summary_ids   bigint[] not null default '{}',
  source_backlog_ids   bigint[] not null default '{}',
  frequency            int      not null default 1 check (frequency >= 0),
  success_count        int      not null default 0 check (success_count >= 0),
  candidate_embedding  extensions.vector(768),
  proposed_name        text,
  proposed_steps       jsonb,
  promoted_skill_id    bigint references public.agent_skills(id) on delete set null,
  state                text     not null default 'mined'
                       check (state in ('mined','promoted','rejected')),
  rejection_reason     text,
  model                text,
  strategy             text     not null default 'centroid+ngram',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.skill_candidates is
  'Sleep Learning (Agentic OS 2026 / SCM-S19-D1). Idle daemon mines successful '
  'trajectory_summaries × archive_backlog clusters and proposes skill stubs. '
  'Candidates are reviewed (list/promote/reject) — promotion writes a clean '
  'row to agent_skills via promote_candidate_to_skill. (project_id, '
  'pattern_hash) is the upsert identity for idempotent re-mining.';

comment on column public.skill_candidates.source_summary_ids is
  'Provenance — bigint[] of trajectory_summaries.id rows that fed the cluster. '
  'Not a true FK array (Postgres does not enforce FKs on array elements); '
  'on_delete clean-up is handled by the daemon.';

comment on column public.skill_candidates.source_backlog_ids is
  'Provenance — bigint[] of archive_backlog.id rows with status=''success'' '
  'that fed the cluster. Same FK-array caveat as source_summary_ids.';

comment on column public.skill_candidates.state is
  'Lifecycle: mined (default, awaiting review) → promoted (written to '
  'agent_skills) or rejected (audit-retained with rejection_reason).';

comment on column public.skill_candidates.strategy is
  'Mining strategy label. Default ''centroid+ngram'' = cosine ≥ 0.85 over the '
  'embedding centroid + 3-gram content hash. Free-form so future strategies '
  '(pure-graph, learned-cluster) need no schema change.';

-- ============ 2. Indexes ============
-- UNIQUE (project_id, pattern_hash) — identity key for upsert_skill_candidate.
-- Re-mining the same cluster bumps frequency/success_count, never duplicates.
create unique index if not exists skill_candidates_project_hash_uniq
  on public.skill_candidates (project_id, pattern_hash);

-- HNSW on candidate_embedding — sub-millisecond ANN for dedupe/recall.
-- Mirrors agent_skills_embedding_idx (010) and trajectory_summaries (011)
-- defaults so the planner cost model is consistent across HNSW scans.
create index if not exists skill_candidates_embedding_idx
  on public.skill_candidates
  using hnsw (candidate_embedding extensions.vector_cosine_ops);

-- (state, frequency DESC) btree — list_skill_candidates' review-queue scan.
-- "state" first because the queue is always filtered by lifecycle stage.
create index if not exists skill_candidates_state_frequency_idx
  on public.skill_candidates (state, frequency desc);

-- Tenancy scan — used by match_skill_candidates before the HNSW lookup.
create index if not exists skill_candidates_project_id_idx
  on public.skill_candidates (project_id);

-- Recency-sorted scans (mining telemetry dashboards, eviction studies).
create index if not exists skill_candidates_created_at_idx
  on public.skill_candidates (created_at desc);

-- ============ 3. Row-Level Security ============
-- Same posture as migrations 006, 010, and 011: service_role bypasses RLS;
-- anon and authenticated are denied unconditionally. Idempotent via
-- DROP IF EXISTS.
alter table public.skill_candidates enable row level security;

drop policy if exists deny_anon_authenticated on public.skill_candidates;
create policy deny_anon_authenticated on public.skill_candidates
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. RPC: match_skill_candidates ============
-- Dual-scope tenancy guard via IN-form (009 planner rationale). Similarity
-- floor; ranked by semantic similarity DESC then frequency DESC. The daemon
-- uses this to dedupe a newly-clustered centroid against existing
-- candidates before deciding to upsert vs propose-fresh.
--
-- search_path includes `extensions` because the pgvector `<=>` operator
-- lives there after the 006_security_hardening.sql schema move — ERROR-11507
-- lesson. Same posture as migrations 008/009/010/011.
drop function if exists public.match_skill_candidates(extensions.vector, text, int, real, boolean);
drop function if exists public.match_skill_candidates(extensions.vector, text, int, float, boolean);

create or replace function public.match_skill_candidates(
  query_embedding  extensions.vector(768),
  p_project_id     text,
  match_count      int     default 5,
  min_similarity   real    default 0.5,
  p_include_global boolean default false
) returns table (
  id                   bigint,
  project_id           text,
  pattern_hash         text,
  frequency            int,
  success_count        int,
  proposed_name        text,
  proposed_steps       jsonb,
  state                text,
  similarity           real
)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select
    c.id,
    c.project_id,
    c.pattern_hash,
    c.frequency,
    c.success_count,
    c.proposed_name,
    c.proposed_steps,
    c.state,
    (1 - (c.candidate_embedding <=> query_embedding))::real as similarity
  from public.skill_candidates c
  where c.project_id in (p_project_id,
                         case when p_include_global then 'GLOBAL' end)
    and c.candidate_embedding is not null
    and 1 - (c.candidate_embedding <=> query_embedding) >= min_similarity
  order by similarity desc, c.frequency desc
  limit match_count;
$$;

-- ============ 5. RPC: upsert_skill_candidate ============
-- INSERT ... ON CONFLICT (project_id, pattern_hash) DO UPDATE.
-- On conflict: bump frequency/success_count, union the provenance arrays,
-- refresh the embedding and proposed_name/steps if the new mining run
-- produced fresh values, but PRESERVE the candidate's lifecycle state
-- (a 'promoted' or 'rejected' candidate must not silently revert to 'mined').
drop function if exists public.upsert_skill_candidate(text, text, bigint[], bigint[], int, int, extensions.vector, text, jsonb, text, text);

create or replace function public.upsert_skill_candidate(
  p_project_id          text,
  p_pattern_hash        text,
  p_source_summary_ids  bigint[],
  p_source_backlog_ids  bigint[],
  p_frequency           int,
  p_success_count       int,
  p_candidate_embedding extensions.vector(768),
  p_proposed_name       text,
  p_proposed_steps      jsonb,
  p_model               text,
  p_strategy            text
) returns table (
  id            bigint,
  state         text,
  frequency     int,
  success_count int,
  is_new        boolean
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_id            bigint;
  v_state         text;
  v_frequency     int;
  v_success_count int;
  v_is_new        boolean;
begin
  insert into public.skill_candidates (
    project_id, pattern_hash, source_summary_ids, source_backlog_ids,
    frequency, success_count, candidate_embedding, proposed_name,
    proposed_steps, model, strategy, updated_at
  )
  values (
    p_project_id, p_pattern_hash,
    coalesce(p_source_summary_ids, '{}'::bigint[]),
    coalesce(p_source_backlog_ids, '{}'::bigint[]),
    greatest(p_frequency, 1),
    greatest(p_success_count, 0),
    p_candidate_embedding, p_proposed_name, p_proposed_steps,
    p_model, coalesce(p_strategy, 'centroid+ngram'), now()
  )
  on conflict (project_id, pattern_hash) do update set
    -- Union the provenance arrays — duplicates are fine and de-duped on read.
    source_summary_ids = (
      select array_agg(distinct e)
      from unnest(public.skill_candidates.source_summary_ids
                  || coalesce(excluded.source_summary_ids, '{}'::bigint[])) e
    ),
    source_backlog_ids = (
      select array_agg(distinct e)
      from unnest(public.skill_candidates.source_backlog_ids
                  || coalesce(excluded.source_backlog_ids, '{}'::bigint[])) e
    ),
    frequency           = public.skill_candidates.frequency + greatest(excluded.frequency, 1),
    success_count       = public.skill_candidates.success_count + greatest(excluded.success_count, 0),
    candidate_embedding = coalesce(excluded.candidate_embedding,
                                   public.skill_candidates.candidate_embedding),
    proposed_name       = coalesce(excluded.proposed_name,
                                   public.skill_candidates.proposed_name),
    proposed_steps      = coalesce(excluded.proposed_steps,
                                   public.skill_candidates.proposed_steps),
    model               = coalesce(excluded.model, public.skill_candidates.model),
    updated_at          = now()
    -- state intentionally preserved (promoted/rejected sticks).
  returning
    public.skill_candidates.id,
    public.skill_candidates.state,
    public.skill_candidates.frequency,
    public.skill_candidates.success_count,
    (public.skill_candidates.created_at = public.skill_candidates.updated_at)
  into v_id, v_state, v_frequency, v_success_count, v_is_new;

  id            := v_id;
  state         := v_state;
  frequency     := v_frequency;
  success_count := v_success_count;
  is_new        := v_is_new;
  return next;
end;
$$;

-- ============ 6. RPC: promote_candidate_to_skill ============
-- Wraps upsert_agent_skill (010) so the canonical skill upsert path stays
-- the single source of truth. Promotion is atomic from the caller's POV:
--   1. Look up the candidate.
--   2. Write/refresh agent_skills via upsert_agent_skill.
--   3. Mark the candidate state='promoted' and stash promoted_skill_id.
-- The candidate row is preserved (audit trail of what produced the skill).
drop function if exists public.promote_candidate_to_skill(bigint, text, text[]);

create or replace function public.promote_candidate_to_skill(
  p_candidate_id      bigint,
  p_description       text,
  p_trigger_keywords  text[]
) returns table (
  candidate_id     bigint,
  skill_id         bigint,
  skill_version    int,
  promoted_at      timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_cand   public.skill_candidates%rowtype;
  v_skill  record;
begin
  select * into v_cand from public.skill_candidates where id = p_candidate_id;
  if not found then
    raise exception 'promote_candidate_to_skill: candidate % not found', p_candidate_id;
  end if;
  if v_cand.state = 'rejected' then
    raise exception 'promote_candidate_to_skill: candidate % is rejected', p_candidate_id;
  end if;
  if v_cand.proposed_name is null or v_cand.proposed_steps is null then
    raise exception 'promote_candidate_to_skill: candidate % missing proposed_name/steps', p_candidate_id;
  end if;

  -- Hand off to the canonical M1 upsert. archive_backlog provenance is
  -- preserved by picking the first source_backlog_id (audit pointer only).
  select s.id as id, s.version as version
    into v_skill
    from public.upsert_agent_skill(
      v_cand.project_id,
      v_cand.proposed_name,
      p_description,
      v_cand.proposed_steps,
      coalesce(p_trigger_keywords, '{}'::text[]),
      v_cand.candidate_embedding,
      (case when array_length(v_cand.source_backlog_ids, 1) > 0
            then v_cand.source_backlog_ids[1]
            else null end)
    ) s;

  update public.skill_candidates
     set state             = 'promoted',
         promoted_skill_id = v_skill.id,
         updated_at        = now()
   where id = p_candidate_id;

  candidate_id  := p_candidate_id;
  skill_id      := v_skill.id;
  skill_version := v_skill.version;
  promoted_at   := now();
  return next;
end;
$$;

-- ============ 7. Grants ============
-- Mirror migrations 010 and 011 posture: service_role gets execute; anon and
-- authenticated remain denied at the RLS layer and have no execute grant
-- here either. Grants are idempotent — re-running is a no-op.
revoke all on function public.match_skill_candidates(extensions.vector, text, int, real, boolean) from public;
grant execute on function public.match_skill_candidates(extensions.vector, text, int, real, boolean) to service_role;

revoke all on function public.upsert_skill_candidate(text, text, bigint[], bigint[], int, int, extensions.vector, text, jsonb, text, text) from public;
grant execute on function public.upsert_skill_candidate(text, text, bigint[], bigint[], int, int, extensions.vector, text, jsonb, text, text) to service_role;

revoke all on function public.promote_candidate_to_skill(bigint, text, text[]) from public;
grant execute on function public.promote_candidate_to_skill(bigint, text, text[]) to service_role;

grant select, insert, update, delete on public.skill_candidates to service_role;
grant usage, select on sequence public.skill_candidates_id_seq to service_role;
