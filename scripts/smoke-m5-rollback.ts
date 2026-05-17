// scripts/smoke-m5-rollback.ts — live end-to-end smoke for the M4→M5 binding.
// Insert 3 rolledback checkpoints with the same step_label, run
// scanRollbackHotspots, verify a curriculum_tasks row of kind 'rollback_repro'
// materialises with target_path === step_label. Always-run cleanup.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { scanRollbackHotspots } from "../src/curriculum/scanner.js";

const projectId = `__smoke_m5rb_${randomUUID().slice(0, 8)}__`;
const stepLabel = `src/__smoke_m5rb__/${randomUUID().slice(0, 6)}.ts`;

async function seedRolledback(): Promise<void> {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    project_id: projectId,
    step_label: stepLabel,
    status: "rolledback",
    rollback_reason: `smoke-${i}`,
  }));
  const { error } = await supabase.from("workflow_checkpoints").insert(rows);
  if (error) throw new Error(`seedRolledback: ${error.message}`);
}

async function cleanup(): Promise<void> {
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M5-RB-SMOKE] start project=${projectId} stepLabel=${stepLabel}`);
  await seedRolledback();
  console.log(`[M5-RB-SMOKE] seeded 3 rolledback checkpoints`);

  // ScannerConfig has 9 required fields — all 9 must be set even though
  // this smoke only exercises the rollback knobs.
  const r = await scanRollbackHotspots({
    projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: 3,
    rollbackWindowDays: 30,
    staleCandidateMinAgeDays: 30,
  });
  console.log(`[M5-RB-SMOKE] scan result:`, r);
  if (r.enqueued !== 1) {
    throw new Error(`[M5-RB-SMOKE] FAIL: expected enqueued=1, got ${r.enqueued}`);
  }

  const { data, error } = await supabase
    .from("curriculum_tasks")
    .select("kind, target_path, status")
    .eq("project_id", projectId)
    .eq("kind", "rollback_repro")
    .single();
  if (error || !data) {
    throw new Error(
      `[M5-RB-SMOKE] FAIL: curriculum_tasks lookup: ${error?.message ?? "no row"}`,
    );
  }
  if (data.target_path !== stepLabel) {
    throw new Error(
      `[M5-RB-SMOKE] FAIL: target_path expected '${stepLabel}', got '${data.target_path}'`,
    );
  }
  if (data.status !== "queued") {
    throw new Error(`[M5-RB-SMOKE] FAIL: status expected 'queued', got '${data.status}'`);
  }

  console.log("[M5-RB-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M5-RB-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
