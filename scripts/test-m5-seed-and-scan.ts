// scripts/test-m5-seed-and-scan.ts — Live M5 lifecycle smoke (backlog #118).
//
// Step 1: idempotently seed a stale skill_candidate (frequency=10, age=10d,
//         state='mined', NULL proposed_name/steps — matches SCM-S22-D1
//         daemon behavior).
// Step 2: invoke runScanOnce() — the scanner should classify the seed as a
//         stale candidate and enqueue a curriculum_tasks row of kind='refactor'
//         with linked_candidate_id set.
// Step 3: emit JSON: { candidate_id, task_id, source_chunk_id_hint } so the
//         MCP-driven steps (pull → compose → checkpoint → gate → apply) can
//         chain off concrete IDs.
//
// The MCP tools take over from here. This script is the only piece that
// touches raw SQL — the rest of the loop runs through the tool surface as
// intended.
//
// Run via: tsx scripts/test-m5-seed-and-scan.ts

import { supabase } from "../src/supabase.js";
import { runScanOnce } from "../src/curriculum/scanner.js";
import { currentProjectId } from "../src/project.js";

const SEED_PATTERN_HASH = "s22-m5-livetest-stale-001";
const SEED_FREQUENCY = 10;
const SEED_SUCCESS = 8;
const SEED_AGE_DAYS = 10;

type Outcome = {
  step: string;
  ok: boolean;
  detail: unknown;
};

const trail: Outcome[] = [];

function push(step: string, ok: boolean, detail: unknown): void {
  trail.push({ step, ok, detail });
}

async function seedStaleCandidate(projectId: string): Promise<number> {
  // Idempotent: if the seed already exists, reuse it.
  const { data: existing, error: lookupErr } = await supabase
    .from("skill_candidates")
    .select("id, state, frequency, created_at")
    .eq("project_id", projectId)
    .eq("pattern_hash", SEED_PATTERN_HASH)
    .maybeSingle();
  if (lookupErr) throw new Error(`seed lookup failed: ${lookupErr.message}`);

  if (existing) {
    push("seed_reused", true, existing);
    return existing.id as number;
  }

  const createdAt = new Date(
    Date.now() - SEED_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("skill_candidates")
    .insert({
      project_id: projectId,
      pattern_hash: SEED_PATTERN_HASH,
      source_summary_ids: [],
      source_backlog_ids: [],
      frequency: SEED_FREQUENCY,
      success_count: SEED_SUCCESS,
      candidate_embedding: null,
      proposed_name: null,
      proposed_steps: null,
      model: null,
      state: "mined",
      strategy: "centroid+ngram",
      created_at: createdAt,
      updated_at: createdAt,
    })
    .select("id, state, frequency, created_at")
    .single();

  if (error) throw new Error(`seed insert failed: ${error.message}`);
  push("seed_inserted", true, data);
  return data.id as number;
}

async function findSourceChunkHint(projectId: string): Promise<number | null> {
  // checkpoint_commit needs a memory_chunks.id whose trajectory_summaries row
  // is the replay anchor. Pick the most recent eligible row in this project.
  const { data, error } = await supabase
    .from("trajectory_summaries")
    .select("source_chunk_id")
    .eq("project_id", projectId)
    .not("source_chunk_id", "is", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    push("source_chunk_hint", false, error.message);
    return null;
  }
  if (!data) {
    push("source_chunk_hint", false, "no trajectory_summaries rows in project");
    return null;
  }
  return data.source_chunk_id as number;
}

async function main(): Promise<void> {
  const projectId = currentProjectId;
  push("project_id", true, projectId);

  const candidateId = await seedStaleCandidate(projectId);

  // Workspace required by ScannerConfig but only used by test_gap source —
  // refactor + rollback don't read it. Pass cwd for correctness anyway.
  const scanResult = await runScanOnce({
    projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 50,
    testGapMinLines: 100,
    rollbackThreshold: 3,
    rollbackWindowDays: 30,
    staleCandidateMinAgeDays: 7,
  });
  push("scan_result", true, scanResult);

  // Find the refactor task the scanner just enqueued for this candidate.
  const { data: task, error: taskErr } = await supabase
    .from("curriculum_tasks")
    .select("id, kind, status, target_path, linked_candidate_id, rationale, created_at")
    .eq("project_id", projectId)
    .eq("kind", "refactor")
    .eq("linked_candidate_id", candidateId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (taskErr) throw new Error(`task lookup failed: ${taskErr.message}`);

  if (!task) {
    push("task_lookup", false, `no refactor task found for candidate ${candidateId}`);
  } else {
    push("task_lookup", true, task);
  }

  const sourceChunkHint = await findSourceChunkHint(projectId);
  if (sourceChunkHint !== null) push("source_chunk_hint", true, sourceChunkHint);

  console.log("");
  console.log("=== M5 LIVE TEST — SEED + SCAN COMPLETE ===");
  console.log(
    JSON.stringify(
      {
        project_id: projectId,
        seed_candidate_id: candidateId,
        scan_result: scanResult,
        enqueued_task: task,
        source_chunk_id_hint: sourceChunkHint,
        trail,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("[test-m5-seed-and-scan] failed:", e);
  process.exit(1);
});
