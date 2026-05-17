// Characterization tests for M4 checkpoint MCP tool handlers
// (src/tools/checkpoint.ts). The handlers wrap the pure service layer in
// src/transactions/checkpoint.ts and add the MCP-shaped envelope, the
// cloud_backlog.metadata.checkpoint_root_id stamp, and a structured
// [M4] rollback_signal log line.
//
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).
// All tests hit live Supabase under a unique project_id namespace per
// describe block — `after` deletes every row in that namespace.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointCreateHandler,
  checkpointCommitHandler,
  checkpointRollbackHandler,
  checkpointListHandler,
} from "../src/tools/checkpoint.js";
import { supabase } from "../src/supabase.js";
import {
  uniqueProjectId,
  insertThrowawayChunk,
  insertThrowawayBacklogRow,
  cleanupProject,
} from "./fixtures/m4.js";

describe("M4 checkpoint_create handler", () => {
  const projectId = uniqueProjectId();
  after(async () => {
    await cleanupProject(projectId);
  });

  test("root checkpoint returns {checkpoint_id, status:'open', backlog_stamped:false}", async () => {
    const r = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "root-step",
    });
    assert.equal(typeof r.checkpoint_id, "number");
    assert.ok(r.checkpoint_id > 0);
    assert.equal(r.status, "open");
    assert.equal(r.backlog_stamped, false);
  });

  test("child checkpoint chains via parent_id and stays unstamped", async () => {
    const root = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "root-for-chain",
    });
    const child = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "child-step",
      step_index: 1,
      parent_id: root.checkpoint_id,
    });
    assert.notEqual(child.checkpoint_id, root.checkpoint_id);
    assert.equal(child.status, "open");
    assert.equal(child.backlog_stamped, false);
  });

  test("root + backlog_task_id stamps cloud_backlog.metadata.checkpoint_root_id", async () => {
    const backlogId = await insertThrowawayBacklogRow(projectId);
    const r = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "root-with-backlog",
      backlog_task_id: backlogId,
    });
    assert.equal(r.backlog_stamped, true);

    // Verify metadata.checkpoint_root_id was actually written.
    const { data, error } = await supabase
      .from("cloud_backlog")
      .select("metadata")
      .eq("id", backlogId)
      .single();
    assert.equal(error, null);
    const metadata = data?.metadata as { checkpoint_root_id?: number } | null;
    assert.equal(metadata?.checkpoint_root_id, r.checkpoint_id);
  });

  test("child + backlog_task_id does NOT stamp (would break the join)", async () => {
    const backlogId = await insertThrowawayBacklogRow(projectId);
    const root = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "root-for-defensive",
    });
    const child = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "child-with-backlog",
      parent_id: root.checkpoint_id,
      backlog_task_id: backlogId,
    });
    assert.equal(child.backlog_stamped, false);
  });

  test("empty step_label is rejected by zod", async () => {
    await assert.rejects(
      () =>
        checkpointCreateHandler({
          project_id: projectId,
          step_label: "",
        }),
      /step_label|at least 1/i,
    );
  });
});

describe("M4 checkpoint_commit handler", () => {
  // body filled in by Tasks 9–10
});

describe("M4 checkpoint_rollback handler", () => {
  // body filled in by Tasks 11–12
});

describe("M4 checkpoint_list handler", () => {
  // body filled in by Tasks 13–15
});
