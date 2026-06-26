// Characterization tests for M4 checkpoint MCP tool handlers
// (src/tools/checkpoint.ts). The handlers wrap the pure service layer in
// src/transactions/checkpoint.ts and add the MCP-shaped envelope, the
// cloud_backlog.metadata.checkpoint_root_id stamp, and a structured
// [M4] rollback_signal log line.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
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
  const projectId = uniqueProjectId();
  let chunkId: number;
  before(async () => {
    chunkId = await insertThrowawayChunk(projectId);
  });
  after(async () => {
    await cleanupProject(projectId);
  });

  test("open → committed pins source_chunk_id", async () => {
    const opened = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "to-commit",
    });
    const r = await checkpointCommitHandler({
      project_id: projectId,
      checkpoint_id: opened.checkpoint_id,
      source_chunk_id: chunkId,
    });
    assert.equal(r.checkpoint_id, opened.checkpoint_id);
    assert.equal(r.status, "committed");
    assert.equal(r.source_chunk_id, chunkId);
  });

  test("re-committing an already-committed checkpoint throws [M4]", async () => {
    const opened = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "to-double-commit",
    });
    await checkpointCommitHandler({
      project_id: projectId,
      checkpoint_id: opened.checkpoint_id,
      source_chunk_id: chunkId,
    });
    await assert.rejects(
      () =>
        checkpointCommitHandler({
          project_id: projectId,
          checkpoint_id: opened.checkpoint_id,
          source_chunk_id: chunkId,
        }),
      /\[M4\]/,
    );
  });
});

describe("M4 checkpoint_rollback handler", () => {
  const projectId = uniqueProjectId();
  let chunkId: number;
  before(async () => {
    chunkId = await insertThrowawayChunk(projectId);
  });
  after(async () => {
    await cleanupProject(projectId);
  });

  test("rolling back an orphan returns restored_from:null", async () => {
    const opened = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "orphan-to-rollback",
    });
    const r = await checkpointRollbackHandler({
      project_id: projectId,
      checkpoint_id: opened.checkpoint_id,
      reason: "test orphan rollback",
    });
    assert.equal(r.checkpoint_id, opened.checkpoint_id);
    assert.equal(r.status, "rolledback");
    assert.equal(r.restored_from, null);
  });

  test("walks parent chain to deepest committed ancestor", async () => {
    // root (committed) → mid (committed) → leaf (open, then rolledback)
    const root = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "root",
    });
    await checkpointCommitHandler({
      project_id: projectId,
      checkpoint_id: root.checkpoint_id,
      source_chunk_id: chunkId,
    });
    const mid = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "mid",
      parent_id: root.checkpoint_id,
      step_index: 1,
    });
    await checkpointCommitHandler({
      project_id: projectId,
      checkpoint_id: mid.checkpoint_id,
      source_chunk_id: chunkId,
    });
    const leaf = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "leaf",
      parent_id: mid.checkpoint_id,
      step_index: 2,
    });

    const r = await checkpointRollbackHandler({
      project_id: projectId,
      checkpoint_id: leaf.checkpoint_id,
      reason: "test chain walk",
    });
    assert.equal(r.status, "rolledback");
    assert.notEqual(r.restored_from, null);
    // Deepest committed ancestor is `mid`, not `root`.
    assert.equal(r.restored_from?.checkpoint_id, mid.checkpoint_id);
    assert.equal(r.restored_from?.source_chunk_id, chunkId);
  });
});

describe("M4 checkpoint_list handler", () => {
  const projectId = uniqueProjectId();
  const otherProjectId = uniqueProjectId();
  after(async () => {
    await cleanupProject(projectId);
    await cleanupProject(otherProjectId);
  });

  test("returns only rows scoped to the given project_id", async () => {
    await checkpointCreateHandler({ project_id: projectId, step_label: "mine-1" });
    await checkpointCreateHandler({ project_id: projectId, step_label: "mine-2" });
    await checkpointCreateHandler({ project_id: otherProjectId, step_label: "other" });

    const mine = await checkpointListHandler({ project_id: projectId });
    assert.equal(mine.count, 2);
    assert.ok(mine.checkpoints.every((r) => r.project_id === projectId));

    const other = await checkpointListHandler({ project_id: otherProjectId });
    assert.equal(other.count, 1);
    assert.equal(other.checkpoints[0].project_id, otherProjectId);
  });

  test("status filter narrows results", async () => {
    const filterProjectId = uniqueProjectId();
    try {
      const chunkId = await insertThrowawayChunk(filterProjectId);
      const a = await checkpointCreateHandler({
        project_id: filterProjectId,
        step_label: "stay-open",
      });
      const b = await checkpointCreateHandler({
        project_id: filterProjectId,
        step_label: "to-commit",
      });
      await checkpointCommitHandler({
        project_id: filterProjectId,
        checkpoint_id: b.checkpoint_id,
        source_chunk_id: chunkId,
      });

      const openOnly = await checkpointListHandler({
        project_id: filterProjectId,
        status: "open",
      });
      const committedOnly = await checkpointListHandler({
        project_id: filterProjectId,
        status: "committed",
      });
      assert.equal(openOnly.count, 1);
      assert.equal(committedOnly.count, 1);
      assert.equal(openOnly.checkpoints[0].id, a.checkpoint_id);
      assert.equal(committedOnly.checkpoints[0].id, b.checkpoint_id);
    } finally {
      await cleanupProject(filterProjectId);
    }
  });

  test("limit defaults to 20 and caps at 100", async () => {
    const capProjectId = uniqueProjectId();
    try {
      // Insert 25 rows; default limit should clamp to 20.
      for (let i = 0; i < 25; i++) {
        await checkpointCreateHandler({ project_id: capProjectId, step_label: `n${i}` });
      }
      const def = await checkpointListHandler({ project_id: capProjectId });
      assert.equal(def.count, 20);

      const capped = await checkpointListHandler({ project_id: capProjectId, limit: 100 });
      assert.equal(capped.count, 25);

      // limit > 100 should be rejected by zod.
      await assert.rejects(
        () => checkpointListHandler({ project_id: capProjectId, limit: 101 }),
        /less than or equal to 100|max/i,
      );
    } finally {
      await cleanupProject(capProjectId);
    }
  });
});
