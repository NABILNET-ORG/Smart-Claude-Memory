// M7 Skill Graduation — Suite A: `findGraduationCandidates` scanner.
//
// Tests run against live Supabase via service-role. Each test uses
// `uniqueProjectId()` for isolation; cleanup at end-of-suite wipes both the
// per-project rows AND the GLOBAL `__m7_test_%` clones via the m4 fixture.
//
// Coverage:
//   A1  empty agent_skills → []
//   A2  frequency below minFrequency → excluded
//   A3  success_rate below minSuccessRate → excluded
//   A4  created_at within minAgeDays → excluded
//   A5  project_id='GLOBAL' → excluded from any scan
//   A6  active 'proposed' graduation exists → excluded (idempotency)
//   A7  only 'rejected' graduations exist → INCLUDED (re-graduation allowed)
//   A8  result order: frequency_used DESC, success_rate DESC
//   A9  batch limit honored
//   A10 tunable thresholds (low-bar args admit otherwise-excluded skills)

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawaySkill,
  insertThrowawayGraduation,
} from "./fixtures/m4.js";
import { findGraduationCandidates } from "../src/graduation/scanner.js";

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

// ─── A1 ─────────────────────────────────────────────────────────────────

test("A1: empty agent_skills under the project → []", async () => {
  const pid = newProject();
  const result = await findGraduationCandidates({ projectId: pid });
  assert.deepEqual(result, []);
});

// ─── A2 ─────────────────────────────────────────────────────────────────

test("A2: frequency_used below minFrequency → excluded", async () => {
  const pid = newProject();
  await insertThrowawaySkill(pid, {
    frequencyUsed: 5, // < 10
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(result.length, 0);
});

// ─── A3 ─────────────────────────────────────────────────────────────────

test("A3: success_rate below minSuccessRate → excluded", async () => {
  const pid = newProject();
  await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.5, // < 0.90
    ageDaysOverride: 30,
  });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(result.length, 0);
});

// ─── A4 ─────────────────────────────────────────────────────────────────

test("A4: skill younger than minAgeDays → excluded", async () => {
  const pid = newProject();
  // Default created_at = now() → age = 0 days, fails minAgeDays=14.
  await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
  });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(result.length, 0);
});

// ─── A5 ─────────────────────────────────────────────────────────────────

test("A5: skill at project_id='GLOBAL' → never surfaces", async () => {
  // Track a fresh pid so the after-hook triggers GLOBAL cleanup sweep
  // (the cleanupProject __m7_test_ name-prefix sweep clears the row below).
  const pid = newProject();
  const globalSkillId = await insertThrowawaySkill("GLOBAL", {
    frequencyUsed: 50,
    successRate: 0.99,
    ageDaysOverride: 30,
  });
  // Unfiltered scan with permissive thresholds. GLOBAL row must NOT appear.
  const results = await findGraduationCandidates({
    minFrequency: 1,
    minSuccessRate: 0.5,
    minAgeDays: 1,
    batch: 50,
  });
  const found = results.find((r) => r.source_skill_id === globalSkillId);
  assert.equal(found, undefined, "GLOBAL skill leaked into candidate set");
  // Touch pid so the after-hook reaches the GLOBAL cleanup sweep for this run.
  await insertThrowawaySkill(pid, { frequencyUsed: 1 });
});

// ─── A6 ─────────────────────────────────────────────────────────────────

test("A6: skill with active 'proposed' graduation → excluded (idempotency)", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  await insertThrowawayGraduation(pid, skillId, { state: "proposed" });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(
    result.length,
    0,
    "skill with active proposed graduation must not re-surface",
  );
});

// ─── A7 ─────────────────────────────────────────────────────────────────

test("A7: skill with only 'rejected' graduation → INCLUDED (re-graduation allowed)", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  await insertThrowawayGraduation(pid, skillId, {
    state: "rejected",
    rejectionReason: "previously rejected — test A7",
  });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(result.length, 1, "rejected graduation must not block re-proposal");
  assert.equal(result[0].source_skill_id, skillId);
});

// ─── A8 ─────────────────────────────────────────────────────────────────

test("A8: result order = frequency_used DESC, success_rate DESC", async () => {
  const pid = newProject();
  // Insert three skills in deliberately scrambled order to defeat insert-order ranking.
  const skidC = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.9, // ties on freq with B, lower success
    ageDaysOverride: 30,
  });
  const skidA = await insertThrowawaySkill(pid, {
    frequencyUsed: 30, // highest freq
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  const skidB = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.99, // ties on freq with C, higher success
    ageDaysOverride: 30,
  });
  const result = await findGraduationCandidates({ projectId: pid });
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((r) => r.source_skill_id),
    [skidA, skidB, skidC],
    "order must be freq DESC then success DESC",
  );
});

// ─── A9 ─────────────────────────────────────────────────────────────────

test("A9: batch limit honored", async () => {
  const pid = newProject();
  for (let i = 0; i < 12; i++) {
    await insertThrowawaySkill(pid, {
      frequencyUsed: 10 + i,
      successRate: 0.95,
      ageDaysOverride: 30,
    });
  }
  const result = await findGraduationCandidates({ projectId: pid, batch: 5 });
  assert.equal(result.length, 5);
});

// ─── A10 ────────────────────────────────────────────────────────────────

test("A10: tunable thresholds admit low-bar skills", async () => {
  const pid = newProject();
  await insertThrowawaySkill(pid, {
    frequencyUsed: 2, // below default 10
    successRate: 0.55, // below default 0.90
    ageDaysOverride: 2, // below default 14
  });
  // Default thresholds → 0 candidates.
  const strict = await findGraduationCandidates({ projectId: pid });
  assert.equal(strict.length, 0);
  // Low-bar overrides → 1 candidate.
  const loose = await findGraduationCandidates({
    projectId: pid,
    minFrequency: 1,
    minSuccessRate: 0.5,
    minAgeDays: 1,
  });
  assert.equal(loose.length, 1);
  assert.equal(loose[0].frequency_at_propose, 2);
  assert.equal(loose[0].success_rate_at_propose, 0.55);
  assert.ok(loose[0].age_days_at_propose >= 1);
});
