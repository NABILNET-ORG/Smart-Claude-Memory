// M7 Skill Graduation — deterministic candidate scanner.
//
// Pure SQL via the Supabase JS client. Boundary Invariant #1 applies to this
// file (and the rest of src/graduation/**): zero generative AI imports. The
// scanner audits `agent_skills` for production-validated rows that pass the
// graduation thresholds and have no active proposal in-flight. It does NOT
// mint graduation rows itself — that responsibility belongs to the Phase B
// daemon (the Orchestrator OR the future cron tick decides whether to enqueue
// each surfaced candidate).
//
// Algorithm:
//   1. Collect source_skill_ids of every graduation row currently in
//      state IN ('proposed','composed','approved'). These IDs are blocked
//      from re-surfacing (the partial UNIQUE index on skill_graduations
//      enforces this at INSERT time too — the scanner's pre-filter is the
//      cheaper read-time companion).
//   2. SELECT eligible agent_skills:
//        project_id != 'GLOBAL'
//        AND frequency_used >= minFrequency
//        AND success_rate   >= minSuccessRate
//        AND created_at     <= now() - minAgeDays
//        AND id NOT IN <blocked>
//      ORDER BY frequency_used DESC, success_rate DESC, created_at ASC
//      LIMIT batch.
//   3. Materialise GraduationCandidate snapshots — frozen telemetry at
//      propose-time so the graduation row can carry an audit-stable history
//      even when the source skill's frequency_used continues to bump.

import { supabase } from "../supabase.js";

// Sovereign defaults, locked 2026-05-18 by user directive.
const DEFAULT_MIN_FREQUENCY = 10;
const DEFAULT_MIN_SUCCESS_RATE = 0.9;
const DEFAULT_MIN_AGE_DAYS = 14;
const DEFAULT_BATCH = 10;

const MS_PER_DAY = 86_400_000;

export type GraduationCandidate = {
  source_skill_id: number;
  project_id: string;
  name: string;
  frequency_at_propose: number;
  success_rate_at_propose: number;
  age_days_at_propose: number;
};

export type FindCandidatesOpts = {
  // When set, restricts the scan to a single project namespace. When omitted,
  // every non-GLOBAL project is in scope (multi-tenant scan).
  projectId?: string;
  minFrequency?: number;
  minSuccessRate?: number;
  minAgeDays?: number;
  batch?: number;
};

export async function findGraduationCandidates(
  opts: FindCandidatesOpts = {},
): Promise<GraduationCandidate[]> {
  const minFrequency = opts.minFrequency ?? DEFAULT_MIN_FREQUENCY;
  const minSuccessRate = opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
  const minAgeDays = opts.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const batch = opts.batch ?? DEFAULT_BATCH;

  // Step 1: collect blocked source_skill_ids (active graduations).
  let blockedQuery = supabase
    .from("skill_graduations")
    .select("source_skill_id")
    .in("state", ["proposed", "composed", "approved"]);
  if (opts.projectId !== undefined) {
    blockedQuery = blockedQuery.eq("project_id", opts.projectId);
  }
  const { data: blockedRows, error: blockedErr } = await blockedQuery;
  if (blockedErr) {
    throw new Error(`findGraduationCandidates(active scan): ${blockedErr.message}`);
  }
  const blocked = new Set<number>(
    (blockedRows ?? []).map((r) => Number(r.source_skill_id)),
  );

  // Step 2: select eligible agent_skills.
  const cutoffIso = new Date(Date.now() - minAgeDays * MS_PER_DAY).toISOString();
  let query = supabase
    .from("agent_skills")
    .select("id, project_id, name, frequency_used, success_rate, created_at")
    .neq("project_id", "GLOBAL")
    .gte("frequency_used", minFrequency)
    .gte("success_rate", minSuccessRate)
    .lte("created_at", cutoffIso)
    .order("frequency_used", { ascending: false })
    .order("success_rate", { ascending: false })
    .order("created_at", { ascending: true });
  if (opts.projectId !== undefined) {
    query = query.eq("project_id", opts.projectId);
  }
  if (blocked.size > 0) {
    // PostgREST NOT IN syntax: not('col', 'in', '(v1,v2,...)').
    query = query.not("id", "in", `(${Array.from(blocked).join(",")})`);
  }
  query = query.limit(batch);

  const { data, error } = await query;
  if (error) {
    throw new Error(`findGraduationCandidates(eligible): ${error.message}`);
  }

  const now = Date.now();
  return (data ?? []).map((row) => {
    const ageMs = now - new Date(row.created_at as string).getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / MS_PER_DAY));
    return {
      source_skill_id: Number(row.id),
      project_id: row.project_id as string,
      name: row.name as string,
      frequency_at_propose: Number(row.frequency_used),
      success_rate_at_propose: Number(row.success_rate),
      age_days_at_propose: ageDays,
    };
  });
}
