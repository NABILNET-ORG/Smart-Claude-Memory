// scripts/smoke-m4.ts — live end-to-end round-trip for M4 checkpoints.
// Mirrors scripts/smoke-m5.ts structure. Run via `npm run smoke:m4`.
//
// Exercises the create→commit→rollback→list lifecycle against live Supabase
// under a unique throwaway project_id namespace. Prints [M4-SMOKE] PASS on
// success or [M4-SMOKE] FAIL: <reason> on any divergence. Always cleans up.

import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import {
  checkpointCreateHandler,
  checkpointCommitHandler,
  checkpointRollbackHandler,
  checkpointListHandler,
} from "../src/tools/checkpoint.js";

const projectId = `__smoke_m4_${randomUUID().slice(0, 8)}__`;

// memory_chunks NOT NULL columns: embedding vector(768), content_hash text.
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

async function insertChunk(): Promise<number> {
  const content = `smoke-${projectId}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__smoke_m4__",
      chunk_index: 0,
      content,
      content_hash: contentHash,
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insertChunk: ${error?.message}`);
  return data.id;
}

async function cleanup(): Promise<void> {
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M4-SMOKE] start project=${projectId}`);
  const chunkId = await insertChunk();

  const root = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "smoke-root",
  });
  console.log(`[M4-SMOKE] created root=${root.checkpoint_id}`);

  await checkpointCommitHandler({
    project_id: projectId,
    checkpoint_id: root.checkpoint_id,
    source_chunk_id: chunkId,
  });
  console.log(`[M4-SMOKE] committed root=${root.checkpoint_id}`);

  const leaf = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "smoke-leaf",
    parent_id: root.checkpoint_id,
    step_index: 1,
  });
  const rb = await checkpointRollbackHandler({
    project_id: projectId,
    checkpoint_id: leaf.checkpoint_id,
    reason: "smoke-test",
  });
  if (rb.restored_from?.checkpoint_id !== root.checkpoint_id) {
    throw new Error(
      `[M4-SMOKE] FAIL: restored_from expected ${root.checkpoint_id}, got ${rb.restored_from?.checkpoint_id ?? "null"}`,
    );
  }
  console.log(`[M4-SMOKE] rollback walked to root=${rb.restored_from.checkpoint_id}`);

  const listed = await checkpointListHandler({ project_id: projectId });
  if (listed.count !== 2) {
    throw new Error(`[M4-SMOKE] FAIL: expected 2 rows, got ${listed.count}`);
  }

  console.log("[M4-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M4-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
