// Sleep Learning tool handlers (Agentic OS 2026 / Mission 3 / SCM-S19-D1,
// extended SCM-S22-D1 for M3 Proposer Remediation).
// Four handlers — review queue interaction for skill_candidates:
//   * list_skill_candidates    → SELECT from skill_candidates (filterable)
//   * compose_skill_candidate  → UPDATE proposed_name/proposed_steps (Single
//                                Brain entry point — Orchestrator-only
//                                generative step; daemon stubs with NULLs)
//   * promote_skill_candidate  → promote_candidate_to_skill RPC
//   * reject_skill_candidate   → UPDATE state='rejected' + notes
//
// Parameter validation + error envelope mirror src/tools/skills.ts.

import { z } from "zod";
import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { checkTaskBudget } from "../budget/gate.js";
import { BudgetExceededError } from "../budget/types.js";

// ─── list_skill_candidates ────────────────────────────────────────────────

export const listSkillCandidatesInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace filter. Defaults to the slugified current working directory ('${currentProjectId}'). ` +
        "Pass 'GLOBAL' to surface promoted-to-global candidates (mining itself is per-project).",
    ),
  state: z
    .enum(["mined", "promoted", "rejected"])
    .optional()
    .describe(
      "Lifecycle filter. Omit to surface all states. Default review queue is state='mined'.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(50)
    .describe("Hard cap on rows returned. Default 50."),
};

const listSkillCandidatesSchema = z.object(listSkillCandidatesInputShape);
export type ListSkillCandidatesInput = z.infer<typeof listSkillCandidatesSchema>;

export type SkillCandidateRow = {
  id: number;
  project_id: string;
  pattern_hash: string;
  source_summary_ids: number[];
  source_backlog_ids: number[];
  frequency: number;
  success_count: number;
  proposed_name: string | null;
  proposed_steps: unknown;
  state: "mined" | "promoted" | "rejected";
  promoted_skill_id: number | null;
  rejection_reason: string | null;
  model: string | null;
  strategy: string;
  created_at: string;
  updated_at: string;
};

export type ListSkillCandidatesResult = {
  count: number;
  candidates: SkillCandidateRow[];
};

export async function listSkillCandidates(
  args: ListSkillCandidatesInput,
): Promise<ListSkillCandidatesResult> {
  const parsed = listSkillCandidatesSchema.parse(args);
  const projectId = parsed.project_id ?? currentProjectId;
  const limit = parsed.limit ?? 50;

  let q = supabase
    .from("skill_candidates")
    .select(
      "id, project_id, pattern_hash, source_summary_ids, source_backlog_ids, " +
        "frequency, success_count, proposed_name, proposed_steps, state, " +
        "promoted_skill_id, rejection_reason, model, strategy, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .order("frequency", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (parsed.state) q = q.eq("state", parsed.state);

  const { data, error } = await q;
  if (error) {
    throw new Error(`list_skill_candidates failed: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as SkillCandidateRow[];
  return { count: rows.length, candidates: rows };
}

// ─── compose_skill_candidate ──────────────────────────────────────────────

// SCM-S22-D1 (M3 Proposer Remediation). The sleep daemon stubs candidates
// with NULL proposed_name / proposed_steps / model (Single Brain mandate).
// The Orchestrator (Claude) calls this tool to inject the generative output
// — a kebab-case name and an ordered, executable step list — before the
// candidate is eligible for promote_candidate_to_skill (which enforces
// NOT-NULL on both fields).
//
// M5 crash-catch: when a curriculum_tasks row has linked_candidate_id set,
// the Orchestrator MUST call compose_skill_candidate FIRST. The atomic
// apply_curriculum_task RPC calls promote_candidate_to_skill in the same
// transaction; a NULL name/steps will raise and abort the whole flow.

const PROPOSED_STEP_SHAPE = z.object({
  step: z.number().int().positive(),
  action: z.string().min(1),
});

export const composeSkillCandidateInputShape = {
  candidate_id: z
    .number()
    .int()
    .positive()
    .describe("skill_candidates.id of the row to compose. Must currently be in state='mined'."),
  proposed_name: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "Kebab-case skill name, ≤ 60 chars. Becomes agent_skills.name on promotion. " +
        "Should capture the recurring pattern in a single noun phrase " +
        "(e.g. 'commit-with-conventional-message', 'apply-bug-fix-with-test').",
    ),
  proposed_steps: z
    .array(PROPOSED_STEP_SHAPE)
    .min(1)
    .describe(
      "Ordered, concrete, executable steps. Each step is {step: int, action: string}. " +
        "Actions must be verbatim-executable by an agent — no abstractions, no commentary. " +
        "Derived from the cluster_summaries of the mined candidate.",
    ),
  // SCM-S39-D1: optional Agentic Resource Manager hooks. The persistence
  // itself doesn't touch an LLM, but the upstream Orchestrator just drafted
  // the proposed_name + proposed_steps via its own Anthropic call — so
  // this is the audit point where those tokens get accounted. Caller can
  // pass an estimate; default is 1000.
  task_id: z
    .string()
    .uuid()
    .optional()
    .describe("Optional Agentic Resource Manager task_id from start_task. Omit for legacy ungated behavior."),
  anthropic_tokens_used: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1000)
    .describe("Caller's estimate of Orchestrator tokens spent drafting proposed_name + proposed_steps. Default 1000."),
};

const composeSkillCandidateSchema = z.object(composeSkillCandidateInputShape);
export type ComposeSkillCandidateInput = z.infer<typeof composeSkillCandidateSchema>;

export type ComposeSkillCandidateResult = {
  candidate_id: number;
  proposed_name: string;
  step_count: number;
  state: "mined";
  updated_at: string;
};

export async function composeSkillCandidate(
  args: ComposeSkillCandidateInput,
): Promise<ComposeSkillCandidateResult> {
  const parsed = composeSkillCandidateSchema.parse(args);

  // SCM-S39-D1: gate anthropic_tokens against the active task. No-op
  // when task_id omitted or SCM_BUDGET_ENFORCEMENT_MODE=off.
  if (parsed.task_id) {
    try {
      await checkTaskBudget(
        parsed.task_id,
        "anthropic_tokens",
        parsed.anthropic_tokens_used ?? 1000,
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        throw new Error(
          `compose_skill_candidate refused: budget exceeded (${e.decision.axis} ` +
            `total=${e.decision.total} cap=${e.decision.cap})`,
        );
      }
      throw e;
    }
  }

  const { data, error } = await supabase
    .from("skill_candidates")
    .update({
      proposed_name: parsed.proposed_name,
      proposed_steps: parsed.proposed_steps,
      model: "orchestrator:claude",
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.candidate_id)
    .eq("state", "mined")
    .select("id, proposed_name, proposed_steps, state, updated_at")
    .maybeSingle();

  if (error) {
    throw new Error(`compose_skill_candidate failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `compose_skill_candidate: candidate ${parsed.candidate_id} not found OR not in state='mined' ` +
        "(promoted/rejected candidates are immutable).",
    );
  }
  const steps = Array.isArray(data.proposed_steps) ? data.proposed_steps : [];
  return {
    candidate_id: data.id as number,
    proposed_name: data.proposed_name as string,
    step_count: steps.length,
    state: "mined",
    updated_at: data.updated_at as string,
  };
}

// ─── promote_skill_candidate ──────────────────────────────────────────────

export const promoteSkillCandidateInputShape = {
  candidate_id: z
    .number()
    .int()
    .positive()
    .describe("skill_candidates.id of the row to promote."),
  description: z
    .string()
    .optional()
    .describe(
      "Optional override for the agent_skills.description. Defaults to the candidate's " +
        "proposed_name + first 200 chars of joined steps so the M1 retrieval surface has " +
        "something to embed.",
    ),
  trigger_keywords: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "Optional lexical hints for the M1 detector (mirror packageSkill). Stored verbatim.",
    ),
};

const promoteSkillCandidateSchema = z.object(promoteSkillCandidateInputShape);
export type PromoteSkillCandidateInput = z.infer<typeof promoteSkillCandidateSchema>;

export type PromoteSkillCandidateResult = {
  candidate_id: number;
  skill_id: number;
  skill_version: number;
  promoted_at: string;
};

export async function promoteSkillCandidate(
  args: PromoteSkillCandidateInput,
): Promise<PromoteSkillCandidateResult> {
  const parsed = promoteSkillCandidateSchema.parse(args);

  // Fetch the candidate so we can synthesize a description if the caller
  // didn't supply one. The RPC will re-validate state/eligibility — this
  // round-trip just provides good defaults.
  const description = await resolveDescription(parsed);

  const { data, error } = await supabase.rpc("promote_candidate_to_skill", {
    p_candidate_id: parsed.candidate_id,
    p_description: description,
    p_trigger_keywords: parsed.trigger_keywords,
  });

  if (error) {
    throw new Error(`promote_candidate_to_skill failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    candidate_id: number;
    skill_id: number;
    skill_version: number;
    promoted_at: string;
  }>;
  if (rows.length === 0) {
    throw new Error("promote_candidate_to_skill returned no rows");
  }
  const head = rows[0];
  return {
    candidate_id: head.candidate_id,
    skill_id: head.skill_id,
    skill_version: head.skill_version,
    promoted_at: head.promoted_at,
  };
}

async function resolveDescription(
  parsed: PromoteSkillCandidateInput,
): Promise<string> {
  if (parsed.description && parsed.description.trim().length > 0) {
    return parsed.description.trim();
  }
  const { data, error } = await supabase
    .from("skill_candidates")
    .select("proposed_name, proposed_steps")
    .eq("id", parsed.candidate_id)
    .maybeSingle();
  if (error) {
    throw new Error(`resolve_description failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`candidate ${parsed.candidate_id} not found`);
  }
  const name = (data.proposed_name as string | null) ?? `candidate-${parsed.candidate_id}`;
  let stepsBlurb = "";
  const steps = data.proposed_steps;
  if (Array.isArray(steps)) {
    const actions: string[] = [];
    for (const s of steps) {
      if (s && typeof s === "object" && "action" in s && typeof (s as { action: unknown }).action === "string") {
        actions.push((s as { action: string }).action);
      }
    }
    stepsBlurb = actions.join("; ").slice(0, 200);
  }
  return `${name}: ${stepsBlurb}`.slice(0, 500);
}

// ─── reject_skill_candidate ───────────────────────────────────────────────

export const rejectSkillCandidateInputShape = {
  candidate_id: z
    .number()
    .int()
    .positive()
    .describe("skill_candidates.id of the row to reject."),
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this candidate is not skill-worthy. Persisted in rejection_reason for audit; " +
        "future re-mining of the same (project_id, pattern_hash) preserves the rejection.",
    ),
};

const rejectSkillCandidateSchema = z.object(rejectSkillCandidateInputShape);
export type RejectSkillCandidateInput = z.infer<typeof rejectSkillCandidateSchema>;

export type RejectSkillCandidateResult = {
  candidate_id: number;
  state: "rejected";
  rejection_reason: string;
  updated_at: string;
};

export async function rejectSkillCandidate(
  args: RejectSkillCandidateInput,
): Promise<RejectSkillCandidateResult> {
  const parsed = rejectSkillCandidateSchema.parse(args);

  const { data, error } = await supabase
    .from("skill_candidates")
    .update({
      state: "rejected",
      rejection_reason: parsed.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.candidate_id)
    .select("id, state, rejection_reason, updated_at")
    .maybeSingle();

  if (error) {
    throw new Error(`reject_skill_candidate failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`candidate ${parsed.candidate_id} not found`);
  }
  return {
    candidate_id: data.id as number,
    state: "rejected",
    rejection_reason: (data.rejection_reason as string) ?? parsed.reason,
    updated_at: data.updated_at as string,
  };
}
