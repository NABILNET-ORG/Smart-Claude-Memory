// M7 Skill Graduation — handler-layer characterization tests.
//
// Suites B (composeGlobalRationale) + C (confirmPromotion + apply_graduation RPC)
// + D (rejectGraduation) + E (listGraduationCandidates) land here as Tasks 5-8.
// S0 ships first and only checks that migration 017 is applied (schema exists).

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { supabase } from "../src/supabase.js";
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawaySkill,
  insertThrowawayGraduation,
} from "./fixtures/m4.js";
import {
  composeGlobalRationale,
  confirmPromotion,
  rejectGraduation,
  listGraduationCandidates,
} from "../src/tools/graduation.js";

const createdProjectIds: string[] = [];

function newProject(): string {
  const id = uniqueProjectId();
  createdProjectIds.push(id);
  return id;
}

after(async () => {
  for (const pid of createdProjectIds) {
    await cleanupProject(pid);
  }
});

// ─── S0: migration 017 sanity ─────────────────────────────────────────────
// Probes the full column list with limit(0) so PostgREST validates the schema
// without reading rows. Any column missing from the table → error from the
// API layer. This is the failing test that drives Task 1's migration.

test("S0: skill_graduations table exists with the expected column shape", async () => {
  const columns = [
    "id",
    "project_id",
    "source_skill_id",
    "state",
    "frequency_at_propose",
    "success_rate_at_propose",
    "age_days_at_propose",
    "proposed_global_rationale",
    "cross_project_verdict",
    "cross_project_evidence",
    "model",
    "composed_at",
    "promoted_global_skill_id",
    "rejection_reason",
    "decided_at",
    "created_at",
    "updated_at",
  ].join(",");

  const { error } = await supabase.from("skill_graduations").select(columns).limit(0);
  assert.equal(
    error,
    null,
    `S0 schema check failed — migration 017 not applied or column shape drifted: ${
      error?.message ?? "(no message)"
    }`,
  );
});

// ─── Suite B: composeGlobalRationale handler ─────────────────────────────
// Persists Orchestrator-LLM-drafted compose output to a graduation row.
// The handler itself NEVER calls an LLM — the Orchestrator is the LLM and
// passes its output here verbatim (mirrors S22-D1 compose_skill_candidate).

test("B1: graduation_id not found → ok:false, reason:graduation_not_found", async () => {
  const result = await composeGlobalRationale({
    graduation_id: 9_999_999_999,
    verdict: "pass",
    evidence: "Universal pattern for connection pooling across stacks.",
    global_rationale: "Connection pool sizing is a universal optimization.",
    model: "orchestrator:claude-opus-4-7",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "graduation_not_found");
  }
});

test("B2: state already 'composed' → ok:false + row unchanged", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Original rationale from a prior compose.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Original evidence body",
    model: "orchestrator:prior-model",
    composedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const result = await composeGlobalRationale({
    graduation_id: gradId,
    verdict: "fail", // try to overwrite
    evidence: "Should not persist — row already composed",
    global_rationale: null,
    model: "orchestrator:fresh-attempt",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /state must be proposed/);
  }
  // Verify the row was NOT mutated.
  const { data: row } = await supabase
    .from("skill_graduations")
    .select(
      "state, proposed_global_rationale, cross_project_verdict, model",
    )
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "composed");
  assert.equal(row?.proposed_global_rationale, "Original rationale from a prior compose.");
  assert.equal(row?.cross_project_verdict, "pass");
  assert.equal(row?.model, "orchestrator:prior-model");
});

test("B3: verdict='pass' + valid rationale → state='composed', all columns populated", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const result = await composeGlobalRationale({
    graduation_id: gradId,
    verdict: "pass",
    evidence: "Pattern is language-agnostic and load-bearing across stacks.",
    global_rationale: "Idempotent UNIQUE-index-driven enqueue is universal.",
    model: "orchestrator:claude-opus-4-7",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "composed");
  assert.ok(typeof result.composed_at === "string" && result.composed_at.length > 0);

  const { data: row } = await supabase
    .from("skill_graduations")
    .select(
      "state, proposed_global_rationale, cross_project_verdict, cross_project_evidence, model, composed_at",
    )
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "composed");
  assert.equal(row?.proposed_global_rationale, "Idempotent UNIQUE-index-driven enqueue is universal.");
  assert.equal(row?.cross_project_verdict, "pass");
  assert.equal(row?.cross_project_evidence, "Pattern is language-agnostic and load-bearing across stacks.");
  assert.equal(row?.model, "orchestrator:claude-opus-4-7");
  assert.ok(row?.composed_at !== null);
});

test("B4: verdict='pass' + global_rationale too short → ok:false + state unchanged", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const result = await composeGlobalRationale({
    graduation_id: gradId,
    verdict: "pass",
    evidence: "Some evidence text",
    global_rationale: "", // empty fails the >=10 chars gate
    model: "orchestrator:claude-opus-4-7",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "compose_rationale_too_short");
  }
  // Verify state stays 'proposed', no compose-output columns written.
  const { data: row } = await supabase
    .from("skill_graduations")
    .select("state, proposed_global_rationale, cross_project_verdict, model, composed_at")
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "proposed");
  assert.equal(row?.proposed_global_rationale, null);
  assert.equal(row?.cross_project_verdict, null);
  assert.equal(row?.model, null);
  assert.equal(row?.composed_at, null);
});

test("B5: verdict='fail' + rationale='anything' → state='composed', rationale coerced to null", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const result = await composeGlobalRationale({
    graduation_id: gradId,
    verdict: "fail",
    evidence: "Skill is framework-specific (uses Express middleware shape).",
    global_rationale: "this should be coerced to null because verdict=fail",
    model: "orchestrator:claude-opus-4-7",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "composed");

  const { data: row } = await supabase
    .from("skill_graduations")
    .select(
      "state, proposed_global_rationale, cross_project_verdict, cross_project_evidence, model",
    )
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "composed");
  assert.equal(row?.proposed_global_rationale, null, "rationale must be coerced to null on verdict=fail");
  assert.equal(row?.cross_project_verdict, "fail");
  assert.equal(row?.cross_project_evidence, "Skill is framework-specific (uses Express middleware shape).");
  assert.equal(row?.model, "orchestrator:claude-opus-4-7");
});

// ─── Suite C: confirmPromotion + apply_graduation RPC ────────────────────
// The sole path that mints an is_global=true row. Wraps the atomic SQL RPC.
// C4 is LOAD-BEARING: characterizes that PostgreSQL now() collapses to one
// microsecond inside the RPC's transaction (mirrors S32-D1 C2 finding).

test("C1: state='proposed' (not yet composed) → ok:false, wrong state", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /state must be composed/);
  }
});

test("C2: state='composed' + empty rationale → RPC defense-in-depth blocks promotion", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  // Seed a malformed composed row directly via fixture (bypasses the
  // composeGlobalRationale gate). The RPC's secondary guard must catch it.
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "evidence body",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /rationale missing or under 10 chars/i);
  }
});

test("C3: source skill deleted before confirm → ok:false (CASCADE drops the graduation, RPC reports not-found)", async () => {
  // FK skill_graduations.source_skill_id → agent_skills(id) ON DELETE CASCADE.
  // Deleting the source skill also drops the graduation, so the RPC's
  // 'source_skill_deleted' guard is defensive only (e.g., a future SET NULL
  // FK swap would reach it). Either error path is acceptable — both block
  // the promotion, which is the safety invariant we care about.
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal pattern for cross-stack applicability.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Evidence",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });
  await supabase.from("agent_skills").delete().eq("id", skillId);
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.reason === "graduation_not_found" ||
        result.reason === "source_skill_deleted",
      `Expected graduation_not_found or source_skill_deleted, got: ${result.reason}`,
    );
  }
});

test("C4: ATOMIC-TX PROOF — graduation.decided_at === new_skill.created_at === RPC.decided_at", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 15,
    successRate: 0.92,
    ageDaysOverride: 21,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal pattern: idempotent UNIQUE-index enqueue across stacks.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Pattern recurs in Postgres, Mongo, Dynamo — universal.",
    model: "orchestrator:claude-opus-4-7",
    composedAt: new Date(Date.now() - 30_000).toISOString(),
  });

  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof result.promoted_global_skill_id, "number");
  assert.ok(result.promoted_global_skill_id > 0);
  assert.equal(typeof result.decided_at, "string");

  const { data: grad } = await supabase
    .from("skill_graduations")
    .select("decided_at, promoted_global_skill_id, state")
    .eq("id", gradId)
    .single();
  const { data: newSkill } = await supabase
    .from("agent_skills")
    .select("created_at")
    .eq("id", result.promoted_global_skill_id)
    .single();

  // The load-bearing assertion — microsecond-equal across three sources.
  assert.equal(
    grad?.decided_at,
    newSkill?.created_at,
    "graduation.decided_at must equal new_skill.created_at to the microsecond",
  );
  assert.equal(
    grad?.decided_at,
    result.decided_at,
    "RPC.decided_at must equal graduation.decided_at to the microsecond",
  );
  console.log(
    `[C4 atomic-tx proof] grad.decided_at = new_skill.created_at = RPC.decided_at = ${result.decided_at}`,
  );
});

test("C5: post-confirm, the GLOBAL clone copies name/description/steps/trigger_keywords + resets telemetry", async () => {
  const pid = newProject();
  const sourceSteps = [{ step: "do_a" }, { step: "do_b" }];
  const sourceTriggers = ["alpha", "beta"];
  const skillId = await insertThrowawaySkill(pid, {
    name: `${pid}__m7_test_C5_${Date.now()}`,
    description: "Source skill description for C5 clone-fields characterization.",
    steps: sourceSteps,
    triggerKeywords: sourceTriggers,
    frequencyUsed: 50, // intentionally non-zero — clone must reset
    successRate: 0.97, // intentionally non-1.0 — clone must reset
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal step sequence with cross-stack relevance.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Recurs across project A, B, C.",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { data: source } = await supabase
    .from("agent_skills")
    .select("name, description, steps, trigger_keywords")
    .eq("id", skillId)
    .single();
  const { data: clone } = await supabase
    .from("agent_skills")
    .select(
      "project_id, name, description, steps, trigger_keywords, frequency_used, success_rate, last_invoked_at, version",
    )
    .eq("id", result.promoted_global_skill_id)
    .single();

  assert.equal(clone?.project_id, "GLOBAL");
  assert.equal(clone?.name, source?.name);
  assert.equal(clone?.description, source?.description);
  assert.deepEqual(clone?.steps, source?.steps);
  assert.deepEqual(clone?.trigger_keywords, source?.trigger_keywords);
  // Telemetry reset on the clone.
  assert.equal(clone?.frequency_used, 0);
  assert.equal(clone?.success_rate, 1.0);
  assert.equal(clone?.last_invoked_at, null);
  assert.equal(clone?.version, 1);
});

test("C6: graduation row post-confirm → state='approved', promoted_global_skill_id wired, decided_at non-null", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal rationale of sufficient length.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Evidence",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { data: row } = await supabase
    .from("skill_graduations")
    .select("state, promoted_global_skill_id, decided_at")
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "approved");
  assert.equal(row?.promoted_global_skill_id, result.promoted_global_skill_id);
  assert.ok(row?.decided_at !== null && row?.decided_at !== undefined);
});

test("C7: source skill UNTOUCHED — we clone, never mutate", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    name: `${pid}__m7_test_C7_${Date.now()}`,
    description: "Original description that must survive promotion.",
    frequencyUsed: 42,
    successRate: 0.93,
    ageDaysOverride: 30,
  });
  const before = await supabase
    .from("agent_skills")
    .select("project_id, name, description, frequency_used, success_rate")
    .eq("id", skillId)
    .single();

  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal rationale that justifies promotion.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Evidence",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });
  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const after = await supabase
    .from("agent_skills")
    .select("project_id, name, description, frequency_used, success_rate")
    .eq("id", skillId)
    .single();
  assert.deepEqual(after.data, before.data, "source skill must be untouched after promotion");
});

// ─── Suite D: rejectGraduation handler ──────────────────────────────────
// TS-only UPDATE per S33 user lock — no RPC for single-table state flip.
// D3 explicitly characterizes the divergence from M5's rejectCurriculumTask
// idempotent overwrite (S32-D1 finding #8): M7's reject REFUSES second
// rejection and preserves the original rejection_reason.

test("D1: reject state='proposed' → state='rejected', reason recorded, decided_at populated", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const result = await rejectGraduation({
    graduation_id: gradId,
    reason: "Project-specific naming — does not generalize.",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "rejected");
  assert.ok(typeof result.decided_at === "string");

  const { data: row } = await supabase
    .from("skill_graduations")
    .select("state, rejection_reason, decided_at")
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "rejected");
  assert.equal(row?.rejection_reason, "Project-specific naming — does not generalize.");
  assert.ok(row?.decided_at !== null);
});

test("D2: reject state='composed' → same — both source states valid for reject", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, {
    state: "composed",
    proposedGlobalRationale: "Universal rationale draft.",
    crossProjectVerdict: "pass",
    crossProjectEvidence: "Evidence body",
    model: "orchestrator:test",
    composedAt: new Date().toISOString(),
  });

  const result = await rejectGraduation({
    graduation_id: gradId,
    reason: "On reflection, this couples to a specific stack.",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { data: row } = await supabase
    .from("skill_graduations")
    .select("state, rejection_reason")
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "rejected");
  assert.equal(row?.rejection_reason, "On reflection, this couples to a specific stack.");
});

test("D3: IDEMPOTENCY — second reject on rejected row → ok:false, original reason preserved (diverges from M5)", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const gradId = await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const first = await rejectGraduation({ graduation_id: gradId, reason: "first rejection reason" });
  assert.equal(first.ok, true);

  // Second attempt — M7 refuses, unlike M5's rejectCurriculumTask which overwrites.
  const second = await rejectGraduation({ graduation_id: gradId, reason: "second rejection reason" });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "invalid_state_transition");
  }

  const { data: row } = await supabase
    .from("skill_graduations")
    .select("state, rejection_reason")
    .eq("id", gradId)
    .single();
  assert.equal(row?.state, "rejected");
  assert.equal(
    row?.rejection_reason,
    "first rejection reason",
    "first reason must be preserved — M7 does NOT overwrite (diverges from M5)",
  );
});

// ─── Suite E: listGraduationCandidates enumeration ───────────────────────

test("E1: empty project → {count:0, results:[]}", async () => {
  const pid = newProject();
  const result = await listGraduationCandidates({ project_id: pid });
  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
});

test("E2: state filter returns only matching rows", async () => {
  const pid = newProject();
  const sk1 = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const sk2 = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  await insertThrowawayGraduation(pid, sk1, { state: "proposed" });
  const g2 = await insertThrowawayGraduation(pid, sk2, {
    state: "rejected",
    rejectionReason: "test",
  });

  const proposed = await listGraduationCandidates({ project_id: pid, state: "proposed" });
  assert.equal(proposed.count, 1);
  assert.equal(proposed.results[0]?.state, "proposed");

  const rejected = await listGraduationCandidates({ project_id: pid, state: "rejected" });
  assert.equal(rejected.count, 1);
  assert.equal(rejected.results[0]?.id, g2);
  assert.equal(rejected.results[0]?.state, "rejected");
});

test("E3: project isolation — graduations from project P1 don't surface for P2", async () => {
  const p1 = newProject();
  const p2 = newProject();
  const sk1 = await insertThrowawaySkill(p1, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  await insertThrowawayGraduation(p1, sk1, { state: "proposed" });

  const result = await listGraduationCandidates({ project_id: p2 });
  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
});
