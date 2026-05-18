// M5 Curriculum CONSUMER characterization tests (S32).
//
// Mirrors the producer suite at tests/curriculum-scanner.test.ts: node:test +
// node:assert/strict against a LIVE Supabase, FK-safe cleanup via fixtures.
//
// Five describe blocks (one per tool, with apply split success/failure):
//   A. list_curriculum_tasks     — 3 tests
//   B. pull_curriculum_task      — 4 tests
//   C. apply_curriculum_task     — 4 tests (success path)
//   D. apply_curriculum_task     — 1 test  (failure path)
//   E. reject_curriculum_task    — 3 tests
//
// Total: 15 characterization tests against existing (S21) handler code in
// src/tools/curriculum.ts. Tests must PASS against unchanged production code;
// a failure surfaces either a real regression or a documentation drift.

import { describe, test, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawayCurriculumTask,
  insertThrowawaySkillCandidate,
  insertThrowawayCheckpoint,
} from "./fixtures/m4.js";
import {
  listCurriculumTasks,
  pullCurriculumTask,
  applyCurriculumTask,
  rejectCurriculumTask,
} from "../src/tools/curriculum.js";
import { supabase } from "../src/supabase.js";
import { setPending, clearPending } from "../src/verification-gate.js";

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

// ─── Suite A: list_curriculum_tasks ──────────────────────────────────────

describe("list_curriculum_tasks", () => {
  test("A1: empty queue returns count=0, tasks=[]", async () => {
    const projectId = newProject();
    const result = await listCurriculumTasks({ project_id: projectId });
    assert.equal(result.count, 0);
    assert.ok(Array.isArray(result.tasks));
    assert.equal(result.tasks.length, 0);
  });

  test("A2: status + kind filters compose correctly", async () => {
    const projectId = newProject();
    // Three rows: matching, kind-mismatch, status-mismatch.
    await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "a2-match",
      status: "queued",
    });
    await insertThrowawayCurriculumTask(projectId, {
      kind: "rollback_repro",
      targetPath: "a2-wrong-kind",
      status: "queued",
    });
    await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "a2-wrong-status",
      status: "verified",
    });

    const result = await listCurriculumTasks({
      project_id: projectId,
      status: "queued",
      kind: "refactor",
    });
    assert.equal(result.count, 1, "only the row matching BOTH filters");
    assert.equal(result.tasks[0].target_path, "a2-match");
    assert.equal(result.tasks[0].status, "queued");
    assert.equal(result.tasks[0].kind, "refactor");
  });

  test("A3: project_id isolation — rows in project A invisible from project B", async () => {
    const projectA = newProject();
    const projectB = newProject();
    await insertThrowawayCurriculumTask(projectA, {
      kind: "refactor",
      targetPath: "a3-only-in-A",
    });

    const fromB = await listCurriculumTasks({ project_id: projectB });
    assert.equal(fromB.count, 0, "project B sees zero rows from project A");

    const fromA = await listCurriculumTasks({ project_id: projectA });
    assert.equal(fromA.count, 1, "project A sees its own row");
    assert.equal(fromA.tasks[0].target_path, "a3-only-in-A");
  });
});

// ─── Suite B: pull_curriculum_task ────────────────────────────────────────

describe("pull_curriculum_task", () => {
  test("B1: empty queue returns claimed=false, task=null", async () => {
    const projectId = newProject();
    const result = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b1",
    });
    assert.equal(result.claimed, false);
    assert.equal(result.task, null);
  });

  test("B2: single queued row → status flips to pulled, pulled_at + session stamped", async () => {
    const projectId = newProject();
    const id = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b2",
    });

    const beforeMs = Date.now();
    const result = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b2",
    });
    const afterMs = Date.now();

    assert.equal(result.claimed, true);
    assert.ok(result.task, "task must be present when claimed=true");
    assert.equal(result.task!.id, id);
    assert.equal(result.task!.status, "pulled");
    assert.equal(result.task!.pulled_by_session_id, "s32-b2");
    const pulledAtMs = new Date(result.task!.pulled_at).getTime();
    assert.ok(
      pulledAtMs >= beforeMs - 2000 && pulledAtMs <= afterMs + 2000,
      `pulled_at ${result.task!.pulled_at} within request window [${beforeMs}, ${afterMs}]`,
    );
  });

  test("B3: linked_candidate_id rows pulled before unlinked (priority signal)", async () => {
    const projectId = newProject();
    // Seed an unlinked row FIRST so it has the older created_at — FIFO would
    // claim it first if the priority signal were absent. The linked row is
    // inserted SECOND but must still be pulled FIRST.
    const unlinkedId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b3-unlinked",
    });
    // Small sleep to guarantee distinct created_at timestamps.
    await new Promise((r) => setTimeout(r, 50));
    const candId = await insertThrowawaySkillCandidate(projectId, {
      frequency: 5,
      state: "mined",
    });
    const linkedId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b3-linked",
      linkedCandidateId: candId,
    });

    const first = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b3-1",
    });
    assert.equal(first.claimed, true);
    assert.equal(first.task!.id, linkedId, "linked task pulled first despite being newer");

    const second = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b3-2",
    });
    assert.equal(second.claimed, true);
    assert.equal(second.task!.id, unlinkedId, "unlinked task pulled second");
  });

  test("B4: kind filter restricts claim to matching rows", async () => {
    const projectId = newProject();
    const rollbackId = await insertThrowawayCurriculumTask(projectId, {
      kind: "rollback_repro",
      targetPath: "b4-rb",
    });
    const refactorId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b4-rf",
    });

    const first = await pullCurriculumTask({
      project_id: projectId,
      kind: "rollback_repro",
      session_id: "s32-b4-1",
    });
    assert.equal(first.claimed, true);
    assert.equal(first.task!.id, rollbackId);
    assert.equal(first.task!.kind, "rollback_repro");

    const second = await pullCurriculumTask({
      project_id: projectId,
      kind: "rollback_repro",
      session_id: "s32-b4-2",
    });
    assert.equal(second.claimed, false, "no more rollback_repro rows");
    assert.equal(second.task, null);

    const third = await pullCurriculumTask({
      project_id: projectId,
      kind: "refactor",
      session_id: "s32-b4-3",
    });
    assert.equal(third.claimed, true);
    assert.equal(third.task!.id, refactorId, "refactor row still claimable under kind filter");
  });
});

// ─── Suite C: apply_curriculum_task — success path ───────────────────────

describe("apply_curriculum_task — success path", () => {
  test("C1: success=true, no linked candidate → verified, no promote", async () => {
    const projectId = newProject();
    const cpId = await insertThrowawayCheckpoint(projectId, {
      stepLabel: "c1-cp",
      status: "committed",
    });
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "c1",
    });

    const pulled = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-c1",
    });
    assert.equal(pulled.claimed, true);
    assert.equal(pulled.task!.id, taskId);

    const result = await applyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      bypass_verification_gate: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.gate_clear, true);
    assert.ok(result.result, "result payload present on success");
    assert.equal(result.result!.applied_status, "verified");
    assert.equal(result.result!.linked_checkpoint_id, cpId);
    assert.equal(result.result!.promoted_candidate_id, null, "no candidate link → no promote");
    assert.equal(result.result!.promoted_skill_id, null);
    assert.equal(result.result!.promoted_at, null);
  });

  test("C2: success=true with linked candidate → atomic promote (verified_at === promoted_at === skill.created_at)", async () => {
    const projectId = newProject();
    const candId = await insertThrowawaySkillCandidate(projectId, {
      frequency: 5,
      state: "mined",
      proposedName: `c2-skill-${Date.now()}`,
      proposedSteps: [
        { step: 1, action: "noop", purpose: "atomic-tx proof seed" },
      ],
    });
    const cpId = await insertThrowawayCheckpoint(projectId, {
      stepLabel: "c2-cp",
      status: "committed",
    });
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: `skill_candidate:c2-${candId}`,
      linkedCandidateId: candId,
    });

    await pullCurriculumTask({ project_id: projectId, session_id: "s32-c2" });

    const result = await applyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      description: "S32 C2 atomic-tx proof",
      bypass_verification_gate: true,
    });

    assert.equal(result.ok, true);
    assert.ok(result.result, "result payload present");
    assert.equal(result.result!.applied_status, "verified");
    assert.equal(result.result!.promoted_candidate_id, candId);
    assert.ok(result.result!.promoted_skill_id, "skill row minted");
    assert.ok(result.result!.promoted_at, "promoted_at stamped");

    // ATOMIC-TX PROOF: all three timestamps must be IDENTICAL.
    // PostgreSQL's now() returns transaction-start time, constant within
    // a single SQL transaction. Inside apply_curriculum_task's tx:
    //   * curriculum_tasks.verified_at        = now()  (012:316)
    //   * skill_candidates.updated_at         = now()  (012:318 promote fn)
    //   * agent_skills.created_at             = now()  (table default)
    // All three evaluate the SAME now(), so equality is exact.
    // NOTE: skill_candidates has NO `promoted_at` column — only updated_at.
    const [{ data: task }, { data: cand }, { data: skill }] = await Promise.all([
      supabase
        .from("curriculum_tasks")
        .select("verified_at")
        .eq("id", taskId)
        .single(),
      supabase
        .from("skill_candidates")
        .select("updated_at, state, promoted_skill_id")
        .eq("id", candId)
        .single(),
      supabase
        .from("agent_skills")
        .select("created_at, name")
        .eq("id", result.result!.promoted_skill_id!)
        .single(),
    ]);

    assert.ok(task && cand && skill, "all three rows readable");
    assert.equal(cand!.state, "promoted", "candidate flipped to promoted");
    assert.equal(cand!.promoted_skill_id, result.result!.promoted_skill_id);
    assert.equal(
      task!.verified_at,
      cand!.updated_at,
      `task.verified_at (${task!.verified_at}) must equal candidate.updated_at (${cand!.updated_at})`,
    );
    assert.equal(
      cand!.updated_at,
      skill!.created_at,
      `candidate.updated_at (${cand!.updated_at}) must equal skill.created_at (${skill!.created_at})`,
    );
    // The RPC also returns promoted_at = now() — must equal the others.
    assert.equal(
      result.result!.promoted_at,
      task!.verified_at,
      `RPC-returned promoted_at (${result.result!.promoted_at}) must equal task.verified_at (${task!.verified_at})`,
    );
  });

  test("C3: verification gate present, bypass=false → handler returns ok:false (does NOT throw)", async () => {
    const projectId = newProject();
    const cpId = await insertThrowawayCheckpoint(projectId, {
      stepLabel: "c3-cp",
      status: "committed",
    });
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "c3",
    });
    await pullCurriculumTask({ project_id: projectId, session_id: "s32-c3" });

    await setPending({
      reason: "S32-C3 test gate",
      file: "tests/curriculum-consumer.test.ts",
      raised_at: new Date().toISOString(),
    });

    try {
      const result = await applyCurriculumTask({
        task_id: taskId,
        success: true,
        checkpoint_id: cpId,
        bypass_verification_gate: false,
      });
      assert.equal(result.ok, false, "gate-blocked apply returns ok:false");
      assert.equal(result.gate_clear, false);
      assert.match(result.reason ?? "", /verification gate/i);
      assert.equal(result.result, null, "no RPC result when gate blocked");
    } finally {
      await clearPending();
    }

    // Task must still be 'pulled' — no SQL mutation when gate blocks.
    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("status, verified_at")
      .eq("id", taskId)
      .single();
    assert.equal(row!.status, "pulled", "status unchanged when gate blocked");
    assert.equal(row!.verified_at, null, "verified_at NOT stamped");
  });

  test("C4: linked candidate with NULL proposed_steps → atomic rollback (no skill minted, task stays pulled)", async () => {
    const projectId = newProject();
    const candId = await insertThrowawaySkillCandidate(projectId, {
      frequency: 5,
      state: "mined",
      proposedName: `c4-name-set-${Date.now()}`,
      proposedSteps: null, // ← the abort trigger (012_sleep_learning.sql:295)
    });
    const cpId = await insertThrowawayCheckpoint(projectId, {
      stepLabel: "c4-cp",
      status: "committed",
    });
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: `skill_candidate:c4-${candId}`,
      linkedCandidateId: candId,
    });
    await pullCurriculumTask({ project_id: projectId, session_id: "s32-c4" });

    const result = await applyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      bypass_verification_gate: true,
    });

    // Handler catches the RPC error and surfaces it as ok:false with reason.
    assert.equal(result.ok, false, "RPC abort surfaces as ok:false");
    assert.equal(result.gate_clear, true, "gate was clear (this isn't a gate block)");
    assert.ok(result.reason, "abort reason present");
    assert.match(
      result.reason!,
      /proposed_name\/steps|missing/i,
      `reason should mention NULL proposed_name/steps; got: ${result.reason}`,
    );
    assert.equal(result.result, null);

    // ATOMIC ROLLBACK: task stays pulled, no skill row created, candidate stays mined.
    // (skill_candidates has no promoted_at column — just state + promoted_skill_id.)
    const [{ data: task }, { data: cand }] = await Promise.all([
      supabase
        .from("curriculum_tasks")
        .select("status, verified_at, linked_checkpoint_id")
        .eq("id", taskId)
        .single(),
      supabase
        .from("skill_candidates")
        .select("state, promoted_skill_id")
        .eq("id", candId)
        .single(),
    ]);
    assert.equal(task!.status, "pulled", "task stays pulled on aborted tx");
    assert.equal(task!.verified_at, null, "verified_at NOT stamped on aborted tx");
    assert.equal(cand!.state, "mined", "candidate stays mined on aborted tx");
    assert.equal(cand!.promoted_skill_id, null);

    const { data: skills } = await supabase
      .from("agent_skills")
      .select("id")
      .eq("project_id", projectId);
    assert.equal((skills ?? []).length, 0, "no agent_skills row created on aborted tx");
  });
});

// ─── Suite D: apply_curriculum_task — failure path ────────────────────────

describe("apply_curriculum_task — failure path", () => {
  test("D1: success=false → task flips to rejected, description persisted as rejection_reason, no promote", async () => {
    const projectId = newProject();
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "d1",
    });
    await pullCurriculumTask({ project_id: projectId, session_id: "s32-d1" });

    const result = await applyCurriculumTask({
      task_id: taskId,
      success: false,
      description: "regression observed in C2 — rolling back this attempt",
    });

    assert.equal(result.ok, true, "failure path returns ok:true (the apply did happen)");
    assert.equal(result.gate_clear, true, "gate check skipped on failure path");
    assert.ok(result.result);
    assert.equal(result.result!.applied_status, "rejected");
    assert.equal(result.result!.promoted_candidate_id, null);
    assert.equal(result.result!.promoted_skill_id, null);
    assert.equal(result.result!.promoted_at, null);

    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("status, rejection_reason, verified_at")
      .eq("id", taskId)
      .single();
    assert.equal(row!.status, "rejected");
    assert.equal(
      row!.rejection_reason,
      "regression observed in C2 — rolling back this attempt",
      "description input persisted into rejection_reason column",
    );
    assert.equal(row!.verified_at, null, "verified_at NOT stamped on failure path");
  });
});

// ─── Suite E: reject_curriculum_task ──────────────────────────────────────

describe("reject_curriculum_task", () => {
  test("E1: reject a queued task → status=rejected, reason persisted as rejection_reason", async () => {
    const projectId = newProject();
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "e1",
    });

    const result = await rejectCurriculumTask({
      task_id: taskId,
      reason: "out of scope for current sprint",
    });
    assert.equal(result.ok, true);
    assert.equal(result.task_id, taskId);
    assert.equal(result.status, "rejected");

    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("status, rejection_reason, verified_at")
      .eq("id", taskId)
      .single();
    assert.equal(row!.status, "rejected");
    assert.equal(row!.rejection_reason, "out of scope for current sprint");
    assert.equal(row!.verified_at, null, "reject path never stamps verified_at");
  });

  test("E2: reject a pulled task → status=rejected (no status precondition)", async () => {
    const projectId = newProject();
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "e2",
    });
    await pullCurriculumTask({ project_id: projectId, session_id: "s32-e2" });

    const result = await rejectCurriculumTask({
      task_id: taskId,
      reason: "mid-pull abort",
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "rejected");

    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("status, rejection_reason")
      .eq("id", taskId)
      .single();
    assert.equal(row!.status, "rejected");
    assert.equal(row!.rejection_reason, "mid-pull abort");
  });

  test("E3: reject an already-rejected task is idempotent — second reason OVERWRITES first (characterized)", async () => {
    const projectId = newProject();
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "e3",
    });

    const first = await rejectCurriculumTask({
      task_id: taskId,
      reason: "first reason",
    });
    assert.equal(first.status, "rejected");

    // Second reject — handler has NO status precondition (curriculum.ts:321-342).
    // It unconditionally UPDATEs the row, so the reason is overwritten.
    const second = await rejectCurriculumTask({
      task_id: taskId,
      reason: "second reason — overwrites first",
    });
    assert.equal(second.ok, true);
    assert.equal(second.status, "rejected");

    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("rejection_reason")
      .eq("id", taskId)
      .single();
    assert.equal(
      row!.rejection_reason,
      "second reason — overwrites first",
      "idempotent reject: second call overwrites rejection_reason",
    );
  });
});
