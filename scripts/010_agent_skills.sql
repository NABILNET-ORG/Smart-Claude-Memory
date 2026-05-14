-- 010_agent_skills.sql
-- Agentic OS 2026 — Mission 1: JIT Skill Retrieval. Idempotent.
--
-- Architecture (DECISION SCM-S17-D1 / ARCHITECTURE.md §4.4):
--   Skills live in a DEDICATED relation `public.agent_skills`, NOT as a
--   metadata.type extension of memory_chunks. Rationale:
--     * Skills are EXECUTABLE artefacts (steps jsonb), not retrieval notes;
--       conflating them with chunks pollutes the semantic search surface.
--     * Skills carry telemetry (frequency_used, success_rate, last_invoked_at)
--       that must NEVER feed the LLM at retrieval time — it ranks them.
--     * (project_id, name) is the natural identity; chunks key on
--       (project_id, file_origin, chunk_index) which has no skill meaning.
--
-- Tenancy contract:
--   * project_id is the FIRST predicate in match_agent_skills' WHERE clause.
--   * The reserved project_id 'GLOBAL' is the universal skill vault; surfaces
--     in dual-scope search only when p_include_global=true (the default).
--   * RLS enabled + deny_anon_authenticated. service_role only — same
--     posture as migration 006_security_hardening.sql.
--
-- Ranking (match_agent_skills):
--   Weighted score = 0.85 * semantic_similarity
--                  + 0.15 * recency_decay
--   where recency_decay = 1 / (1 + days_since_last_invoked).
--   Cold skills (last_invoked_at IS NULL) get recency 0; rank purely on
--   semantic similarity. This keeps the JIT bar honest: a stale-but-relevant
--   skill beats a recent-but-irrelevant one.
--
-- Cost: $0. Pure PostgreSQL/Supabase features.

-- ============ 1. Table ============
create table if not exists public.agent_skills (
  id                          bigserial primary key,
  project_id                  text not null,
  name                        text not null,
  version                     int not null default 1,
  description                 text not null,
  steps                       jsonb not null,
  trigger_keywords            text[] not null default '{}',
  embedding                   extensions.vector(768),
  frequency_used              int not null default 0,
  success_rate                real not null default 1.0,
  last_invoked_at             timestamptz,
  packaged_from_archive_id    bigint,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.agent_skills is
  'JIT Skill Retrieval (Agentic OS 2026 / SCM-S17-D1). Executable steps + '
  'semantic embedding + telemetry. NEVER preloaded — request_skill returns '
  'full steps payload at the moment the LLM needs the procedure.';

comment on column public.agent_skills.steps is
  'Ordered jsonb array of executable steps. Returned verbatim by request_skill '
  'so the LLM can follow the procedure without re-deriving it.';

comment on column public.agent_skills.trigger_keywords is
  'Lexical hint set for the agent''s natural-language detector. Not used in '
  'the ranking score directly — match_agent_skills ranks purely on semantic + '
  'recency. The keywords are surfaced in tool output so callers can short-circuit.';

-- ============ 2. Indexes ============
-- UNIQUE (project_id, name) — identity key for upsert; one row per skill per scope.
create unique index if not exists agent_skills_project_name_uniq
  on public.agent_skills (project_id, name);

-- HNSW on embedding — sub-millisecond ANN over the cosine surface.
create index if not exists agent_skills_embedding_idx
  on public.agent_skills using hnsw (embedding extensions.vector_cosine_ops);

-- GIN on trigger_keywords — supports `&&` / `@>` array containment lookups.
create index if not exists agent_skills_trigger_keywords_idx
  on public.agent_skills using gin (trigger_keywords);

-- Recency-sorted scans (LRU eviction studies, telemetry dashboards).
create index if not exists agent_skills_last_invoked_idx
  on public.agent_skills (last_invoked_at desc);

-- Tenancy scan — used by match_agent_skills before the HNSW lookup.
create index if not exists agent_skills_project_id_idx
  on public.agent_skills (project_id);

-- ============ 3. Row-Level Security ============
-- Same posture as migration 006: service_role bypasses RLS; anon and
-- authenticated are denied unconditionally. Idempotent via DROP IF EXISTS.
alter table public.agent_skills enable row level security;

drop policy if exists deny_anon_authenticated on public.agent_skills;
create policy deny_anon_authenticated on public.agent_skills
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. RPC: match_agent_skills ============
-- Dual-scope tenancy guard via IN-form (see 009_fix_rpc_dual_scope.sql for
-- the planner rationale). Similarity floor + weighted ranking. SECURITY
-- DEFINER + STABLE + pinned search_path = public, pg_catalog (extensions is
-- not needed in the search_path because the vector operator is referenced
-- via the fully-qualified `extensions.vector` cast on the column type and
-- the `<=>` operator is in pg_catalog after the 006 schema move).
--
-- Recency decay floor uses COALESCE(..., 0) so cold skills don't get penalized
-- with a NaN; they fall back to pure semantic ranking.
--
-- search_path includes `extensions` because the pgvector `<=>` operator lives
-- there after the 006_security_hardening.sql schema move. Same posture as
-- migrations 008/009.
drop function if exists public.match_agent_skills(extensions.vector, text, int, real, boolean);
drop function if exists public.match_agent_skills(extensions.vector, text, int, float, boolean);

create or replace function public.match_agent_skills(
  query_embedding  extensions.vector(768),
  p_project_id     text,
  match_count      int     default 5,
  min_similarity   real    default 0.5,
  p_include_global boolean default true
) returns table (
  id                       bigint,
  project_id               text,
  name                     text,
  version                  int,
  description              text,
  steps                    jsonb,
  trigger_keywords         text[],
  frequency_used           int,
  success_rate             real,
  last_invoked_at          timestamptz,
  packaged_from_archive_id bigint,
  similarity               real,
  rank_score               real
)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select
    s.id,
    s.project_id,
    s.name,
    s.version,
    s.description,
    s.steps,
    s.trigger_keywords,
    s.frequency_used,
    s.success_rate,
    s.last_invoked_at,
    s.packaged_from_archive_id,
    (1 - (s.embedding <=> query_embedding))::real                  as similarity,
    (
      0.85 * (1 - (s.embedding <=> query_embedding))
      + 0.15 * coalesce(
          1.0 / (1 + extract(epoch from (now() - s.last_invoked_at)) / 86400.0),
          0
        )
    )::real                                                         as rank_score
  from public.agent_skills s
  where s.project_id in (p_project_id,
                         case when p_include_global then 'GLOBAL' end)
    and s.embedding is not null
    and 1 - (s.embedding <=> query_embedding) >= min_similarity
  order by rank_score desc
  limit match_count;
$$;

-- ============ 5. RPC: upsert_agent_skill ============
-- INSERT ... ON CONFLICT (project_id, name) DO UPDATE.
-- On conflict: bump version, refresh description/steps/keywords/embedding,
-- PRESERVE telemetry (frequency_used, success_rate, last_invoked_at).
drop function if exists public.upsert_agent_skill(text, text, text, jsonb, text[], extensions.vector, bigint);

create or replace function public.upsert_agent_skill(
  p_project_id                text,
  p_name                      text,
  p_description               text,
  p_steps                     jsonb,
  p_trigger_keywords          text[],
  p_embedding                 extensions.vector(768),
  p_packaged_from_archive_id  bigint
) returns table (
  id      bigint,
  version int
)
language sql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
  insert into public.agent_skills (
    project_id, name, version, description, steps, trigger_keywords,
    embedding, packaged_from_archive_id, updated_at
  )
  values (
    p_project_id, p_name, 1, p_description, p_steps,
    coalesce(p_trigger_keywords, '{}'::text[]),
    p_embedding, p_packaged_from_archive_id, now()
  )
  on conflict (project_id, name) do update set
    version                  = public.agent_skills.version + 1,
    description              = excluded.description,
    steps                    = excluded.steps,
    trigger_keywords         = excluded.trigger_keywords,
    embedding                = excluded.embedding,
    packaged_from_archive_id = coalesce(excluded.packaged_from_archive_id,
                                        public.agent_skills.packaged_from_archive_id),
    updated_at               = now()
    -- frequency_used, success_rate, last_invoked_at intentionally preserved.
  returning public.agent_skills.id, public.agent_skills.version;
$$;

-- ============ 6. RPC: bump_skill_telemetry ============
-- Increment frequency, refresh last_invoked_at, and exponentially-smooth the
-- success_rate at alpha=0.1 (so a single failure can't wipe a battle-tested
-- skill, but persistent failures drag the score down within ~10 invocations).
drop function if exists public.bump_skill_telemetry(bigint, boolean);

create or replace function public.bump_skill_telemetry(
  p_id      bigint,
  p_success boolean
) returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
  update public.agent_skills
     set frequency_used   = frequency_used + 1,
         last_invoked_at  = now(),
         success_rate     = 0.9 * success_rate
                          + 0.1 * (case when p_success then 1.0 else 0.0 end)
   where id = p_id;
$$;
