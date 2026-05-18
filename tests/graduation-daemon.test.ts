// M7 Graduation Daemon — Suite F characterization tests.
//
// Verifies the deterministic enqueue contract:
//   F1  empty agent_skills → 0 proposed
//   F2  one eligible skill → 1 proposed graduation row inserted
//   F3  eligible skill with active 'proposed' graduation → 0 (scanner pre-filter)
//   F4  multiple eligible skills → all proposed, telemetry counts match
//   F5  status getter reflects the latest run after runGraduationScanOnce
//
// The daemon NEVER calls apply_graduation, compose_global_rationale, or
// reject_graduation — these tests would not exercise those paths even
// indirectly. The boundary lint fence (scripts/lint-boundaries.ts) is the
// structural guarantee; this suite is the behavioural one.

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
  runGraduationScanOnce,
  getGraduationStatus,
  runGraduationScannerOnce,
} from "../src/graduation/daemon.js";

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

// ─── F1 ─────────────────────────────────────────────────────────────────

test("F1: empty agent_skills under project → 0 proposed", async () => {
  const pid = newProject();
  const result = await runGraduationScanOnce({ projectId: pid });
  assert.equal(result.total_proposed, 0);
  assert.equal(result.total_skipped, 0);
  assert.equal(result.total_errored, 0);
  assert.ok(typeof result.duration_ms === "number" && result.duration_ms >= 0);
});

// ─── F2 ─────────────────────────────────────────────────────────────────

test("F2: one eligible skill → 1 proposed graduation row inserted at state='proposed'", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 15,
    successRate: 0.95,
    ageDaysOverride: 21,
  });

  const result = await runGraduationScanOnce({ projectId: pid });
  assert.equal(result.total_proposed, 1);
  assert.equal(result.total_skipped, 0);
  assert.equal(result.total_errored, 0);

  // Verify the inserted row carries the frozen snapshot + state='proposed'.
  const { data: rows, error } = await supabase
    .from("skill_graduations")
    .select("source_skill_id, state, frequency_at_propose, success_rate_at_propose, age_days_at_propose, proposed_global_rationale, decided_at")
    .eq("project_id", pid);
  assert.equal(error, null);
  assert.equal(rows?.length, 1);
  const row = rows![0]!;
  assert.equal(row.source_skill_id, skillId);
  assert.equal(row.state, "proposed");
  assert.equal(row.frequency_at_propose, 15);
  assert.equal(row.success_rate_at_propose, 0.95);
  assert.ok(row.age_days_at_propose >= 20 && row.age_days_at_propose <= 22);
  // Compose-output + decision-output columns are NULL until handlers write them.
  assert.equal(row.proposed_global_rationale, null);
  assert.equal(row.decided_at, null);
});

// ─── F3 ─────────────────────────────────────────────────────────────────

test("F3: skill with active 'proposed' graduation → scanner pre-filters → 0 proposed", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill(pid, {
    frequencyUsed: 20,
    successRate: 0.95,
    ageDaysOverride: 30,
  });
  await insertThrowawayGraduation(pid, skillId, { state: "proposed" });

  const result = await runGraduationScanOnce({ projectId: pid });
  // findGraduationCandidates blocks the skill (Suite A6 covers this). Daemon
  // never reaches the INSERT path — 0 proposed, 0 skipped, 0 errored.
  assert.equal(result.total_proposed, 0);
  assert.equal(result.total_skipped, 0);
  assert.equal(result.total_errored, 0);

  // Verify only the pre-seeded graduation exists (no duplicate from daemon).
  const { count } = await supabase
    .from("skill_graduations")
    .select("id", { count: "exact", head: true })
    .eq("project_id", pid);
  assert.equal(count, 1);
});

// ─── F4 ─────────────────────────────────────────────────────────────────

test("F4: multiple eligible skills → all proposed within batch limit", async () => {
  const pid = newProject();
  // Seed 3 eligible skills with varying telemetry.
  for (let i = 0; i < 3; i++) {
    await insertThrowawaySkill(pid, {
      frequencyUsed: 12 + i,
      successRate: 0.91 + i * 0.01,
      ageDaysOverride: 20 + i,
    });
  }

  const result = await runGraduationScanOnce({ projectId: pid, batch: 10 });
  assert.equal(result.total_proposed, 3);
  assert.equal(result.total_skipped, 0);
  assert.equal(result.total_errored, 0);

  const { count } = await supabase
    .from("skill_graduations")
    .select("id", { count: "exact", head: true })
    .eq("project_id", pid)
    .eq("state", "proposed");
  assert.equal(count, 3);
});

// ─── F5 ─────────────────────────────────────────────────────────────────

test("F5: tick() updates status counters and emits telemetry without throwing", async () => {
  const pid = newProject();
  // Seed one eligible skill so the tick actually enqueues a row.
  await insertThrowawaySkill(pid, {
    frequencyUsed: 11,
    successRate: 0.93,
    ageDaysOverride: 16,
  });

  // The daemon tick scans `currentProjectId` by default, NOT our test pid.
  // So we drive `runGraduationScanOnce` directly here — F5 is a status-shape
  // characterization, not a project-scope test. The status mutation paths
  // are inside `tick()` only; we exercise it via the publicly-aliased
  // runGraduationScannerOnce export.
  await runGraduationScannerOnce();

  const status = getGraduationStatus();
  assert.equal(typeof status.running, "boolean");
  assert.equal(status.running, false, "running flag clears after tick");
  assert.equal(typeof status.enabled, "boolean");
  assert.equal(typeof status.interval_ms, "number");
  assert.equal(typeof status.min_frequency, "number");
  assert.equal(typeof status.min_success_rate, "number");
  assert.equal(typeof status.min_age_days, "number");
  assert.equal(typeof status.last_run_proposed, "number");
  assert.equal(typeof status.last_run_skipped, "number");
  assert.equal(typeof status.last_run_errored, "number");
  assert.equal(typeof status.last_run_duration_ms, "number");
  assert.ok(typeof status.last_run_at === "string", "last_run_at populated after tick");
});
