// M5 Smoke Test — Autonomous Curriculum end-to-end (SCM-S21-D1).
//
// Verifies the FULL deterministic path:
//   (a) seed a mock skill_candidate in 'mined' state (the M3 auto-promote bridge),
//   (b) enqueue a curriculum_task via enqueue_curriculum_task RPC with that
//       linked_candidate_id,
//   (c) pull_curriculum_task → status='pulled',
//   (d) open + commit an M4 workflow_checkpoint,
//   (e) apply_curriculum_task(success=true, checkpoint_id) → atomic SQL tx
//       fires promote_candidate_to_skill within the SAME transaction,
//   (f) assert curriculum_tasks.status='verified', skill_candidates.state='promoted',
//       a fresh agent_skills row was minted,
//   (g) cleanup all rows so the smoke is repeatable.
//
// Run: npx tsx scripts/smoke-m5.ts
//
// This script bypasses the verification-pending.json gate (no main-touching
// code is written by the smoke itself — it only exercises queue mechanics).

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL || !KEY) {
  console.error("SUPABASE_URL or SUPABASE_SECRET_KEY missing.");
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const PROJECT = "claude-memory";
const SESSION_ID = `smoke-m5-${Date.now()}`;
const PATTERN_HASH = `smoke-m5-${createHash("sha256")
  .update(`${SESSION_ID}`)
  .digest("hex")
  .slice(0, 16)}`;

let createdCandidate: number | null = null;
let createdTask: number | null = null;
let createdCheckpoint: number | null = null;
let createdSkill: number | null = null;

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}

async function cleanup(): Promise<void> {
  console.log("\n--- cleanup ---");
  if (createdSkill !== null) {
    await supabase.from("agent_skills").delete().eq("id", createdSkill);
    console.log(`  agent_skills.id=${createdSkill} deleted`);
  }
  if (createdTask !== null) {
    await supabase.from("curriculum_tasks").delete().eq("id", createdTask);
    console.log(`  curriculum_tasks.id=${createdTask} deleted`);
  }
  if (createdCheckpoint !== null) {
    await supabase.from("workflow_checkpoints").delete().eq("id", createdCheckpoint);
    console.log(`  workflow_checkpoints.id=${createdCheckpoint} deleted`);
  }
  if (createdCandidate !== null) {
    await supabase.from("skill_candidates").delete().eq("id", createdCandidate);
    console.log(`  skill_candidates.id=${createdCandidate} deleted`);
  }
}

async function main(): Promise<void> {
  console.log(`\n=== M5 Smoke (SCM-S21-D1) — project=${PROJECT}, session=${SESSION_ID} ===\n`);

  // ── (a) Seed mock skill_candidate ─────────────────────────────────────
  {
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("skill_candidates")
      .insert({
        project_id: PROJECT,
        pattern_hash: PATTERN_HASH,
        source_summary_ids: [],
        source_backlog_ids: [],
        frequency: 5,
        success_count: 5,
        candidate_embedding: null,
        proposed_name: `smoke-m5-${SESSION_ID}`,
        proposed_steps: [{ tool: "edit", path: "src/foo.ts", action: "refactor" }],
        state: "mined",
        strategy: "centroid+ngram",
        created_at: aged,
      })
      .select("id")
      .single();
    if (error) {
      console.error(`Seed candidate failed: ${error.message}`);
      process.exit(1);
    }
    createdCandidate = data.id;
    console.log(`(a) seeded skill_candidates.id=${createdCandidate} (aged 30d, freq=5, state=mined)`);
  }

  // ── (b) enqueue curriculum_task with linked_candidate_id ──────────────
  {
    const { data, error } = await supabase.rpc("enqueue_curriculum_task", {
      p_project_id: PROJECT,
      p_kind: "refactor",
      p_target_path: `skill_candidate:${PATTERN_HASH}`,
      p_rationale: `smoke: mined candidate freq=5, success=5, age>7d`,
      p_signal_source: {
        candidate_id: createdCandidate,
        frequency: 5,
        success_count: 5,
        scanned_at: new Date().toISOString(),
      },
      p_linked_candidate_id: createdCandidate,
      p_expires_at: null,
    });
    if (error) {
      console.error(`enqueue failed: ${error.message}`);
      await cleanup();
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ task_id: number; is_new: boolean }>;
    assert(rows.length === 1, "enqueue returns one row");
    assert(rows[0].is_new === true, "enqueue created a new task");
    createdTask = rows[0].task_id;
    console.log(`(b) enqueued curriculum_tasks.id=${createdTask}`);
  }

  // ── (c) pull_next_curriculum_task ──────────────────────────────────────
  {
    const { data, error } = await supabase.rpc("pull_next_curriculum_task", {
      p_project_id: PROJECT,
      p_kind: null,
      p_session_id: SESSION_ID,
    });
    if (error) {
      console.error(`pull failed: ${error.message}`);
      await cleanup();
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ id: number; status: string; linked_candidate_id: number | null }>;
    assert(rows.length === 1, "pull returns one row");
    assert(rows[0].id === createdTask, "pull claims the task we just enqueued");
    assert(rows[0].status === "pulled", "pull flips status to 'pulled'");
    assert(rows[0].linked_candidate_id === createdCandidate, "pull carries linked_candidate_id");
    console.log(`(c) pulled curriculum_tasks.id=${rows[0].id}, status=${rows[0].status}, linked_candidate_id=${rows[0].linked_candidate_id}`);
  }

  // ── (d) open + commit an M4 workflow_checkpoint ───────────────────────
  // The orchestrator (real flow) would write code here, raise the gate, etc.
  // For smoke we pin to any existing project chunk as the M2 anchor (the M4
  // binding requires source_chunk_id NOT NULL on commit). We do NOT insert
  // a synthetic chunk because memory_chunks.embedding is NOT NULL and we
  // refuse to fabricate a 768-dim zero vector that would pollute search.
  let chosenChunkId: number;
  {
    const { data: chunkRow, error: chunkErr } = await supabase
      .from("memory_chunks")
      .select("id")
      .eq("project_id", PROJECT)
      .order("id", { ascending: false })
      .limit(1)
      .single();
    if (chunkErr || chunkRow === null) {
      console.error(`no project chunk available to anchor checkpoint: ${chunkErr?.message}`);
      await cleanup();
      process.exit(1);
    }
    chosenChunkId = chunkRow.id;

    const { data, error } = await supabase
      .from("workflow_checkpoints")
      .insert({
        project_id: PROJECT,
        skill_id: null,
        step_index: 0,
        step_label: "smoke-m5-step",
        parent_id: null,
        source_chunk_id: chosenChunkId,
        status: "committed",
        committed_at: new Date().toISOString(),
      })
      .select("id, status")
      .single();
    if (error) {
      console.error(`checkpoint insert failed: ${error.message}`);
      await cleanup();
      process.exit(1);
    }
    createdCheckpoint = data.id;
    console.log(`(d) opened+committed workflow_checkpoints.id=${createdCheckpoint}, status=${data.status}, anchored on memory_chunks.id=${chosenChunkId}`);
  }

  // ── (e) apply_curriculum_task(success=true) — ATOMIC AUTO-PROMOTE ──────
  {
    const { data, error } = await supabase.rpc("apply_curriculum_task", {
      p_task_id: createdTask,
      p_success: true,
      p_checkpoint_id: createdCheckpoint,
      p_description: "smoke m5 promoted skill description",
      p_trigger_keywords: ["smoke", "m5"],
    });
    if (error) {
      console.error(`apply failed: ${error.message}`);
      await cleanup();
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{
      task_id: number;
      applied_status: string;
      linked_checkpoint_id: number | null;
      promoted_candidate_id: number | null;
      promoted_skill_id: number | null;
      promoted_at: string | null;
    }>;
    assert(rows.length === 1, "apply returns one row");
    assert(rows[0].applied_status === "verified", "apply flips status to 'verified'");
    assert(rows[0].linked_checkpoint_id === createdCheckpoint, "apply pins linked_checkpoint_id");
    assert(rows[0].promoted_candidate_id === createdCandidate, "apply fires auto-promote with our candidate id");
    assert(typeof rows[0].promoted_skill_id === "number" && rows[0].promoted_skill_id > 0, "auto-promote returns a skill_id");
    createdSkill = rows[0].promoted_skill_id;
    console.log(`(e) applied → status=${rows[0].applied_status}, promoted_skill_id=${createdSkill}, promoted_at=${rows[0].promoted_at}`);
  }

  // ── (f) verify side effects ───────────────────────────────────────────
  {
    const { data: task } = await supabase
      .from("curriculum_tasks")
      .select("status, linked_checkpoint_id, verified_at")
      .eq("id", createdTask)
      .single();
    assert(task?.status === "verified", "curriculum_tasks.status='verified' persisted");
    assert(task?.linked_checkpoint_id === createdCheckpoint, "linked_checkpoint_id persisted");
    assert(typeof task?.verified_at === "string", "verified_at stamped");

    const { data: cand } = await supabase
      .from("skill_candidates")
      .select("state, promoted_skill_id")
      .eq("id", createdCandidate)
      .single();
    assert(cand?.state === "promoted", "skill_candidates.state='promoted' (M3 auto-promote fired)");
    assert(cand?.promoted_skill_id === createdSkill, "skill_candidates.promoted_skill_id wired to agent_skills.id");

    const { data: skill } = await supabase
      .from("agent_skills")
      .select("id, name, version")
      .eq("id", createdSkill)
      .single();
    assert(typeof skill?.id === "number", "agent_skills row exists");
    assert(skill?.name === `smoke-m5-${SESSION_ID}`, "agent_skills.name carries the candidate's proposed_name");
    console.log(`(f) end-to-end consistent: curriculum verified, candidate promoted, skill #${skill?.id} v${skill?.version} minted (name=${skill?.name})`);
  }

  // ── (g) cleanup ───────────────────────────────────────────────────────
  await cleanup();

  console.log("\n=== ✅ M5 SMOKE GREEN ===\n");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("unhandled error:", e);
  await cleanup();
  process.exit(1);
});
