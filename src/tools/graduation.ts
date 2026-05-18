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
