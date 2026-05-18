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
import { composeGlobalRationale } from "../src/tools/graduation.js";

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
