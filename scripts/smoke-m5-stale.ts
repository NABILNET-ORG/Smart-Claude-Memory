// scripts/smoke-m5-stale.ts — live end-to-end smoke for the M3→M5 binding.
// Seed 1 stale skill_candidates row (state=mined, freq>=minFreq, age>=7d),
// run scanStaleCandidates, verify a curriculum_tasks row of kind='refactor'
// materialises with linked_candidate_id set + target_path = `skill_candidate:${pattern_hash}`
// (smoke-confirmed contract — scanner deliberately does NOT use proposed_name
// as target_path; see src/curriculum/scanner.ts:295-298). Always-run cleanup.
//
// SAFETY: does NOT call apply_curriculum_task. The M3 auto-promote into
// agent_skills (GLOBAL skill vault) fires only on apply, which is outside
// the scanner-only surface this smoke exercises.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { scanStaleCandidates } from "../src/curriculum/scanner.js";

const projectId = `__smoke_m5st_${randomUUID().slice(0, 8)}__`;
const proposedName = `src/__smoke_m5st__/${randomUUID().slice(0, 6)}.ts`;
const patternHash = `smoke_m5st_${randomUUID().slice(0, 12)}`;

async function seedStaleCandidate(): Promise<number> {
  const stale = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("skill_candidates")
    .insert({
      project_id: projectId,
      pattern_hash: patternHash,
      source_summary_ids: [],
      source_backlog_ids: [],
      state: "mined",
      frequency: 7,
      proposed_name: proposedName,
      created_at: stale,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedStaleCandidate: ${error?.message}`);
  return data.id;
}

async function cleanup(): Promise<void> {
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("skill_candidates").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M5-ST-SMOKE] start project=${projectId} patternHash=${patternHash}`);
  const candidateId = await seedStaleCandidate();
  console.log(`[M5-ST-SMOKE] seeded candidate id=${candidateId} proposedName=${proposedName}`);

  // ScannerConfig has 9 required fields. minFreq=3 + staleCandidateMinAgeDays=7
  // are the production daemon defaults.
  const r = await scanStaleCandidates({
    projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: 3,
    rollbackWindowDays: 30,
    staleCandidateMinAgeDays: 7,
  });
  console.log(`[M5-ST-SMOKE] scan result:`, r);
  if (r.source !== "stale_candidate") {
    throw new Error(`[M5-ST-SMOKE] FAIL: source expected 'stale_candidate', got '${r.source}'`);
  }
  if (r.enqueued !== 1) {
    throw new Error(`[M5-ST-SMOKE] FAIL: expected enqueued=1, got ${r.enqueued}`);
  }

  const { data, error } = await supabase
    .from("curriculum_tasks")
    .select("kind, target_path, status, linked_candidate_id, signal_source")
    .eq("project_id", projectId)
    .eq("kind", "refactor")
    .single();
  if (error || !data) {
    throw new Error(
      `[M5-ST-SMOKE] FAIL: curriculum_tasks lookup: ${error?.message ?? "no row"}`,
    );
  }

  const expectedTargetPath = `skill_candidate:${patternHash}`;
  if (data.target_path !== expectedTargetPath) {
    throw new Error(
      `[M5-ST-SMOKE] FAIL: target_path expected '${expectedTargetPath}', got '${data.target_path}'`,
    );
  }
  if (data.linked_candidate_id !== candidateId) {
    throw new Error(
      `[M5-ST-SMOKE] FAIL: linked_candidate_id expected ${candidateId}, got ${data.linked_candidate_id}`,
    );
  }
  if (data.status !== "queued") {
    throw new Error(`[M5-ST-SMOKE] FAIL: status expected 'queued', got '${data.status}'`);
  }
  const signalSource = data.signal_source as { proposed_name?: string } | null;
  if (signalSource?.proposed_name !== proposedName) {
    throw new Error(
      `[M5-ST-SMOKE] FAIL: signal_source.proposed_name expected '${proposedName}', got '${signalSource?.proposed_name}'`,
    );
  }

  console.log("[M5-ST-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M5-ST-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
