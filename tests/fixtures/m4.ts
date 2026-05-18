// Per-test setup/teardown for M4 checkpoint tests.
// Every test creates rows under a unique project_id namespace so cleanup is
// exhaustive: a single DELETE on that project_id wipes ALL test artefacts.

import { createHash, randomUUID } from "node:crypto";
import { supabase } from "../../src/supabase.js";

export function uniqueProjectId(): string {
  return `__test_m4_${randomUUID().slice(0, 8)}__`;
}

// memory_chunks NOT NULL columns we have to satisfy:
//   * embedding   vector(768)  → zero vector
//   * content_hash text         → sha256(content) hex
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

export async function insertThrowawayChunk(projectId: string): Promise<number> {
  // Use the project_id in the content so each test's chunk hashes uniquely,
  // dodging any (file_origin, content_hash) uniqueness constraint between runs.
  const content = `m4-test-chunk-${projectId}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__m4_test__",
      chunk_index: 0,
      content,
      content_hash: contentHash,
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

export type ThrowawayCheckpointOpts = {
  stepLabel: string;
  status?: "open" | "committed" | "rolledback";
  skillId?: number | null;
  parentId?: number | null;
  sourceChunkId?: number | null;
  rollbackReason?: string | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the rollback_repro 30-day window: pass an old timestamp
  // to verify out-of-window rows are excluded from the aggregate.
  createdAt?: string;
};

export async function insertThrowawayCheckpoint(
  projectId: string,
  opts: ThrowawayCheckpointOpts,
): Promise<number> {
  const row: Record<string, unknown> = {
    project_id: projectId,
    step_label: opts.stepLabel,
    status: opts.status ?? "open",
    skill_id: opts.skillId ?? null,
    parent_id: opts.parentId ?? null,
    source_chunk_id: opts.sourceChunkId ?? null,
    rollback_reason: opts.rollbackReason ?? null,
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayCheckpoint failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

export type ThrowawaySkillCandidateOpts = {
  // pattern_hash defaults to a uuid-derived value so tests don't collide
  // on the (project_id, pattern_hash) unique constraint. Pass explicitly
  // when a test asserts on the derived target_path = `skill_candidate:${pattern_hash}`.
  patternHash?: string;
  state?: "mined" | "promoted" | "rejected";
  frequency?: number;
  successCount?: number;
  proposedName?: string | null;
  // promote_candidate_to_skill (012_sleep_learning.sql:295) raises on NULL
  // proposed_name OR proposed_steps. Tests that drive apply_curriculum_task
  // through the success+linked_candidate atomic-promote path MUST set both.
  // Pass `null` explicitly to characterize the NULL-aborts path (S32 C4).
  proposedSteps?: unknown[] | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the staleCandidateMinAgeDays window.
  createdAt?: string;
};

export async function insertThrowawaySkillCandidate(
  projectId: string,
  opts: ThrowawaySkillCandidateOpts = {},
): Promise<number> {
  const patternHash = opts.patternHash ?? `m5_test_${randomUUID().slice(0, 12)}`;
  const row: Record<string, unknown> = {
    project_id: projectId,
    pattern_hash: patternHash,
    source_summary_ids: [],
    source_backlog_ids: [],
    state: opts.state ?? "mined",
    frequency: opts.frequency ?? 1,
    success_count: opts.successCount ?? 0,
    proposed_name:
      opts.proposedName === null ? null : (opts.proposedName ?? `__m5_test_${patternHash.slice(-8)}`),
    proposed_steps:
      opts.proposedSteps === null ? null : (opts.proposedSteps ?? null),
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("skill_candidates")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawaySkillCandidate failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

// ─── insertThrowawayCurriculumTask ────────────────────────────────────────
// M5 Consumer (S32) fixture. Inserts a single curriculum_tasks row under the
// test's project_id namespace. Default kind='refactor' + status='queued' so
// the row is immediately pullable. Pass linkedCandidateId to exercise the
// auto-promote bridge in apply_curriculum_task.

export type ThrowawayCurriculumTaskOpts = {
  kind?: "test_gap" | "refactor" | "rollback_repro";
  targetPath?: string;
  rationale?: string;
  signalSource?: Record<string, unknown>;
  linkedCandidateId?: number | null;
  status?: "queued" | "pulled" | "attempted" | "verified" | "rejected" | "expired";
  createdAt?: string;
};

export async function insertThrowawayCurriculumTask(
  projectId: string,
  opts: ThrowawayCurriculumTaskOpts = {},
): Promise<number> {
  const kind = opts.kind ?? "refactor";
  // target_path must be unique per (project, target, kind) WHEN status='queued'
  // (partial unique index curriculum_tasks_queued_target_kind_uniq).
  // Random suffix dodges this when tests stack multiple queued rows.
  const targetPath = opts.targetPath ?? `__m5_test_${randomUUID().slice(0, 8)}`;
  const row: Record<string, unknown> = {
    project_id: projectId,
    kind,
    target_path: targetPath,
    rationale: opts.rationale ?? `__m5_consumer_test:${kind}`,
    signal_source: opts.signalSource ?? {},
    linked_candidate_id: opts.linkedCandidateId ?? null,
    status: opts.status ?? "queued",
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("curriculum_tasks")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayCurriculumTask failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: curriculum_tasks first (FKs to workflow_checkpoints via
  // linked_checkpoint_id AND skill_candidates via linked_candidate_id),
  // then skill_candidates (FKs agent_skills via promoted_skill_id ON DELETE
  // SET NULL — safe to delete candidates first; agent_skills follow), then
  // agent_skills (S32: M5 consumer atomic-promote tests mint real skill rows
  // via promote_candidate_to_skill — they MUST be cleaned by project_id or
  // they leak into the live agent_skills vault), then workflow_checkpoints
  // (FKs to memory_chunks via source_chunk_id), then cloud_backlog, then
  // memory_chunks.
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("skill_candidates").delete().eq("project_id", projectId);
  await supabase.from("agent_skills").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
