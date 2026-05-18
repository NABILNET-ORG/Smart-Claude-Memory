// M7 Skill Graduation — MCP handler surface.
//
// Phase A scope (this file): four handlers EXPORTED only — Phase B will wire
// them into src/index.ts:
//
//   - composeGlobalRationale  (Task 5) — persists Orchestrator-LLM-drafted
//     compose output. The handler NEVER calls an LLM; the Orchestrator does
//     the generative call upstream and feeds the output in. Mirrors S22-D1
//     compose_skill_candidate. This is intentionally OUTSIDE the Boundary
//     Invariant #1 fence (which only covers src/graduation/**) — tools are
//     the Orchestrator's domain.
//
//   - confirmPromotion        (Task 6) — calls the apply_graduation RPC.
//     The sole path that mints an is_global=true row (project_id='GLOBAL').
//
//   - rejectGraduation        (Task 7) — TS-only UPDATE; no RPC (single-table
//     state flip, no atomicity-critical multi-write). Locked by S33 directive.
//
//   - listGraduationCandidates (Task 8) — enumeration for the human curator
//     UI / Orchestrator audit.

import { z } from "zod";
import { supabase } from "../supabase.js";

// ─── composeGlobalRationale ───────────────────────────────────────────────

export type ComposeGlobalRationaleInput = {
  graduation_id: number;
  verdict: "pass" | "fail";
  evidence: string;
  global_rationale: string | null;
  model: string;
};

export type ComposeGlobalRationaleOutput =
  | { ok: true; graduation_id: number; state: "composed"; composed_at: string }
  | { ok: false; reason: string; state_unchanged: true };

export async function composeGlobalRationale(
  input: ComposeGlobalRationaleInput,
): Promise<ComposeGlobalRationaleOutput> {
  // Step 1: Input validation (client-side; cheap, no DB round-trip on bad shapes).
  if (input.verdict !== "pass" && input.verdict !== "fail") {
    return {
      ok: false,
      reason: "compose_invalid_verdict",
      state_unchanged: true,
    };
  }
  if (!input.evidence || input.evidence.trim().length === 0) {
    return {
      ok: false,
      reason: "compose_evidence_required",
      state_unchanged: true,
    };
  }
  if (!input.model || input.model.trim().length === 0) {
    return {
      ok: false,
      reason: "compose_model_required",
      state_unchanged: true,
    };
  }
  if (input.verdict === "pass") {
    const r = input.global_rationale;
    if (r === null || r.trim().length < 10) {
      return {
        ok: false,
        reason: "compose_rationale_too_short",
        state_unchanged: true,
      };
    }
  }

  // verdict='fail' coerces rationale to NULL — the human gate (confirm_promotion)
  // requires verdict='pass' AND non-empty rationale, so storing 'fail' rationales
  // would only confuse the audit trail.
  const rationale = input.verdict === "pass" ? input.global_rationale : null;
  const composedAt = new Date().toISOString();

  // Step 2: Race-safe UPDATE. WHERE id=? AND state='proposed' makes a concurrent
  // double-compose impossible — only the first one finds state='proposed'.
  const { data: updated, error: updateErr } = await supabase
    .from("skill_graduations")
    .update({
      proposed_global_rationale: rationale,
      cross_project_verdict: input.verdict,
      cross_project_evidence: input.evidence,
      model: input.model,
      composed_at: composedAt,
      state: "composed",
    })
    .eq("id", input.graduation_id)
    .eq("state", "proposed")
    .select("id, state, composed_at")
    .maybeSingle();

  if (updateErr) {
    return {
      ok: false,
      reason: `compose_db_error: ${updateErr.message}`,
      state_unchanged: true,
    };
  }

  if (updated) {
    return {
      ok: true,
      graduation_id: Number(updated.id),
      state: "composed",
      composed_at: updated.composed_at as string,
    };
  }

  // Step 3: UPDATE matched zero rows. Two paths: row doesn't exist OR row is
  // not at state='proposed'. Probe to distinguish so the caller's error
  // message points at the actual cause.
  const { data: probe, error: probeErr } = await supabase
    .from("skill_graduations")
    .select("id, state")
    .eq("id", input.graduation_id)
    .maybeSingle();
  if (probeErr) {
    return {
      ok: false,
      reason: `compose_db_error: ${probeErr.message}`,
      state_unchanged: true,
    };
  }
  if (!probe) {
    return {
      ok: false,
      reason: "graduation_not_found",
      state_unchanged: true,
    };
  }
  return {
    ok: false,
    reason: `graduation state must be proposed, got ${probe.state}`,
    state_unchanged: true,
  };
}

// ─── confirmPromotion ─────────────────────────────────────────────────────
// The sole TS call site that drives is_global=true row creation. Thin
// wrapper around the apply_graduation SQL RPC — correctness lives in SQL
// (atomic INSERT GLOBAL + UPDATE graduation in one tx). The RPC returns
// jsonb in the shape this function's discriminated union represents.

export type ConfirmPromotionInput = {
  graduation_id: number;
};

export type ConfirmPromotionOutput =
  | {
      ok: true;
      graduation_id: number;
      promoted_global_skill_id: number;
      decided_at: string;
    }
  | { ok: false; reason: string };

export async function confirmPromotion(
  input: ConfirmPromotionInput,
): Promise<ConfirmPromotionOutput> {
  if (input.graduation_id === undefined || input.graduation_id === null) {
    return { ok: false, reason: "graduation_id_required" };
  }
  const { data, error } = await supabase.rpc("apply_graduation", {
    p_graduation_id: input.graduation_id,
  });
  if (error) {
    return { ok: false, reason: `confirm_db_error: ${error.message}` };
  }
  // The RPC always returns a non-null jsonb. Defensive parse in case the
  // wire shape ever drifts.
  if (!data || typeof data !== "object" || !("ok" in data)) {
    return { ok: false, reason: "confirm_invalid_rpc_response" };
  }
  const rpcResult = data as {
    ok: boolean;
    reason?: string;
    graduation_id?: number;
    promoted_global_skill_id?: number;
    decided_at?: string;
  };
  if (rpcResult.ok === true) {
    return {
      ok: true,
      graduation_id: Number(rpcResult.graduation_id),
      promoted_global_skill_id: Number(rpcResult.promoted_global_skill_id),
      decided_at: String(rpcResult.decided_at),
    };
  }
  return {
    ok: false,
    reason: rpcResult.reason ?? "confirm_unknown_error",
  };
}

// ─── rejectGraduation ─────────────────────────────────────────────────────
// TS-only UPDATE per S33 user lock — no RPC for a single-table state flip.
// State guard: rejects only allowed when current state IN ('proposed','composed').
// Diverges from M5's rejectCurriculumTask: M7 REFUSES a second reject on an
// already-rejected row (returns invalid_state_transition) rather than
// silently overwriting the rejection_reason. Suite D3 locks this contract.

export type RejectGraduationInput = {
  graduation_id: number;
  reason: string;
};

export type RejectGraduationOutput =
  | { ok: true; graduation_id: number; state: "rejected"; decided_at: string }
  | { ok: false; reason: string };

export async function rejectGraduation(
  input: RejectGraduationInput,
): Promise<RejectGraduationOutput> {
  if (input.graduation_id === undefined || input.graduation_id === null) {
    return { ok: false, reason: "graduation_id_required" };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { ok: false, reason: "rejection_reason_required" };
  }

  const decidedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("skill_graduations")
    .update({
      state: "rejected",
      rejection_reason: input.reason,
      decided_at: decidedAt,
    })
    .eq("id", input.graduation_id)
    .in("state", ["proposed", "composed"])
    .select("id, decided_at")
    .maybeSingle();

  if (error) {
    return { ok: false, reason: `reject_db_error: ${error.message}` };
  }

  if (data) {
    return {
      ok: true,
      graduation_id: Number(data.id),
      state: "rejected",
      decided_at: data.decided_at as string,
    };
  }

  // UPDATE matched zero rows. Probe to distinguish not-found from wrong-state.
  const { data: probe, error: probeErr } = await supabase
    .from("skill_graduations")
    .select("state")
    .eq("id", input.graduation_id)
    .maybeSingle();
  if (probeErr) {
    return { ok: false, reason: `reject_db_error: ${probeErr.message}` };
  }
  if (!probe) {
    return { ok: false, reason: "graduation_not_found" };
  }
  return { ok: false, reason: "invalid_state_transition" };
}

// ─── listGraduationCandidates ─────────────────────────────────────────────
// Enumeration surface for human curators / Orchestrator audit. Filterable by
// state and project_id with offset/limit pagination. Phase A omits the
// source_skill_name join (deferred to Phase B — the human UI surface that
// will consume this handler hasn't shipped yet, so embedding the name now
// adds a JOIN cost without a consumer).

export type ListGraduationCandidatesInput = {
  project_id?: string;
  state?: "proposed" | "composed" | "approved" | "rejected";
  k?: number;
  offset?: number;
};

export type GraduationListRow = {
  id: number;
  project_id: string;
  source_skill_id: number;
  state: "proposed" | "composed" | "approved" | "rejected";
  frequency_at_propose: number;
  success_rate_at_propose: number;
  age_days_at_propose: number;
  proposed_global_rationale: string | null;
  cross_project_verdict: "pass" | "fail" | null;
  decided_at: string | null;
  created_at: string;
};

export type ListGraduationCandidatesOutput = {
  count: number;
  results: GraduationListRow[];
};

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;

export async function listGraduationCandidates(
  input: ListGraduationCandidatesInput = {},
): Promise<ListGraduationCandidatesOutput> {
  const limit = Math.min(Math.max(input.k ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  let query = supabase
    .from("skill_graduations")
    .select(
      "id, project_id, source_skill_id, state, frequency_at_propose, success_rate_at_propose, age_days_at_propose, proposed_global_rationale, cross_project_verdict, decided_at, created_at",
    )
    .order("created_at", { ascending: false });

  if (input.project_id !== undefined) {
    query = query.eq("project_id", input.project_id);
  }
  if (input.state !== undefined) {
    query = query.eq("state", input.state);
  }
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    throw new Error(`listGraduationCandidates: ${error.message}`);
  }

  const results = (data ?? []).map((r) => ({
    id: Number(r.id),
    project_id: r.project_id as string,
    source_skill_id: Number(r.source_skill_id),
    state: r.state as GraduationListRow["state"],
    frequency_at_propose: Number(r.frequency_at_propose),
    success_rate_at_propose: Number(r.success_rate_at_propose),
    age_days_at_propose: Number(r.age_days_at_propose),
    proposed_global_rationale: (r.proposed_global_rationale as string | null) ?? null,
    cross_project_verdict: (r.cross_project_verdict as GraduationListRow["cross_project_verdict"]) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    created_at: r.created_at as string,
  }));

  return { count: results.length, results };
}

// ─── MCP InputShape exports (used by src/index.ts) ────────────────────────
// Same pattern as src/tools/curriculum.ts — Zod `.shape` style so the MCP
// server.tool() registration call can consume them directly. Single source
// of truth — no Zod inlined in index.ts.

export const listGraduationCandidatesInputShape = {
  project_id: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict to a single project namespace. Omit to scan all projects (multi-tenant)."),
  state: z
    .enum(["proposed", "composed", "approved", "rejected"])
    .optional()
    .describe("Filter by lifecycle state. Omit for all states."),
  k: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max rows to return. Default 10, hard cap 50."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Pagination offset. Default 0."),
};

export const composeGlobalRationaleInputShape = {
  graduation_id: z.number().int().positive().describe("skill_graduations.id under review."),
  verdict: z
    .enum(["pass", "fail"])
    .describe("Cross-Project Test verdict from the Orchestrator's LLM compose call."),
  evidence: z
    .string()
    .min(1)
    .describe("LLM's evidence body (≤120 words) — what is universal vs project-specific."),
  global_rationale: z
    .string()
    .nullable()
    .describe("If verdict='pass', the Sovereign-Vetting-grade rationale string (>=10 chars). Coerced to null when verdict='fail'."),
  model: z
    .string()
    .min(1)
    .describe("Compose-time model identifier (e.g., 'orchestrator:claude-opus-4-7'). Recorded for audit."),
};

export const confirmPromotionInputShape = {
  graduation_id: z
    .number()
    .int()
    .positive()
    .describe("skill_graduations.id to promote. Must be at state='composed' with rationale length >=10."),
};

export const rejectGraduationInputShape = {
  graduation_id: z
    .number()
    .int()
    .positive()
    .describe("skill_graduations.id to reject. Must be at state='proposed' or 'composed'."),
  reason: z
    .string()
    .min(1)
    .describe("Human-curator rejection reason. Persisted to rejection_reason for audit."),
};
