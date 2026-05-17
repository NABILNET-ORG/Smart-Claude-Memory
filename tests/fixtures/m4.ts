// Per-test setup/teardown for M4 checkpoint tests.
// Every test creates rows under a unique project_id namespace so cleanup is
// exhaustive: a single DELETE on that project_id wipes ALL test artefacts.

import { randomUUID } from "node:crypto";
import { supabase } from "../../src/supabase.js";

export function uniqueProjectId(): string {
  return `__test_m4_${randomUUID().slice(0, 8)}__`;
}

// memory_chunks.embedding is vector(768) NOT NULL (scripts/001_schema.sql:8).
// We don't need a real embedding for these tests — use a zero vector.
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

export async function insertThrowawayChunk(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__m4_test__",
      chunk_index: 0,
      content: "m4-test-chunk",
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayChunk failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export async function insertThrowawayBacklogRow(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .insert({
      project_id: projectId,
      title: "__m4_test_task__",
      status: "todo",
      metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayBacklogRow failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: workflow_checkpoints first (it FKs to memory_chunks via
  // source_chunk_id), then cloud_backlog, then memory_chunks.
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
