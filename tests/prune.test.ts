import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { listFileOriginsForProject, deleteChunksForFile } from "../src/supabase.js";
import { pruneMemory } from "../src/tools/prune.js";
import { insertThrowawayChunkForFile, tmpRepoFile, uniqueProjectId } from "./fixtures/prune.js";

describe("listFileOriginsForProject", () => {
  const projectId = uniqueProjectId();
  const fileA = "/tmp/prune-list-a.md";
  const fileB = "/tmp/prune-list-b.md";

  after(async () => {
    await deleteChunksForFile(projectId, fileA);
    await deleteChunksForFile(projectId, fileB);
  });

  test("returns distinct file_origins scoped to the project", async () => {
    await insertThrowawayChunkForFile(projectId, fileA, "alpha-chunk-1", 0);
    await insertThrowawayChunkForFile(projectId, fileA, "alpha-chunk-2", 1);
    await insertThrowawayChunkForFile(projectId, fileB, "beta-chunk", 0);

    const origins = await listFileOriginsForProject(projectId);

    assert.deepEqual(origins.sort(), [fileA, fileB].sort());
  });

  test("returns empty array for project with no rows", async () => {
    const empty = uniqueProjectId();
    const origins = await listFileOriginsForProject(empty);
    assert.deepEqual(origins, []);
  });
});

describe("pruneMemory — input validation", () => {
  test("T2: rejects empty explicit_paths", async () => {
    await assert.rejects(
      () => pruneMemory({ explicit_paths: [], project_id: uniqueProjectId() }),
      /explicit_paths/,
    );
  });

  test("T2b: rejects non-array explicit_paths", async () => {
    await assert.rejects(
      // @ts-expect-error — runtime guard must reject malformed input
      () => pruneMemory({ project_id: uniqueProjectId() }),
      /explicit_paths/,
    );
  });

  test("T4: refuses project_id='GLOBAL'", async () => {
    await assert.rejects(
      () => pruneMemory({ explicit_paths: ["/tmp/whatever"], project_id: "GLOBAL" }),
      /GLOBAL/,
    );
  });
});

describe("pruneMemory — dry-run", () => {
  const projectId = uniqueProjectId();
  const orphanFile = `/tmp/prune-dry-${randomUUID()}.md`;

  after(async () => {
    await deleteChunksForFile(projectId, orphanFile);
  });

  test("T1: dry_run returns mode='dry_run' and deletes nothing", async () => {
    await insertThrowawayChunkForFile(projectId, orphanFile, "orphan-content");

    const result = await pruneMemory({
      explicit_paths: [orphanFile],
      project_id: projectId,
    });

    assert.equal(result.mode, "dry_run");
    assert.equal(result.deleted_total, 0);
    assert.equal(result.project_id, projectId);
    assert.equal(result.candidates.length, 1);

    const survivors = await listFileOriginsForProject(projectId);
    assert.ok(survivors.includes(orphanFile), "orphan row must survive dry_run");
  });
});

describe("pruneMemory — inline:* filter (regression-killer)", () => {
  const projectId = uniqueProjectId();
  const inlineOrigin = `inline:${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  after(async () => {
    await deleteChunksForFile(projectId, inlineOrigin);
  });

  test("T3: skips inline:* origins even when explicit_paths names one with confirm:true", async () => {
    await insertThrowawayChunkForFile(projectId, inlineOrigin, "ghost-row-must-survive");

    const result = await pruneMemory({
      explicit_paths: [inlineOrigin],
      project_id: projectId,
      confirm: true,
    });

    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.file_origin, inlineOrigin);
    assert.equal(c.skipped_reason, "inline_origin");
    assert.equal(c.chunk_count, 0);
    assert.equal(c.exists_on_disk, false);

    const survivors = await listFileOriginsForProject(projectId);
    assert.ok(
      survivors.includes(inlineOrigin),
      "inline:* row MUST survive — silent wipe would lose save_memory state",
    );
  });
});

describe("pruneMemory — skipped reasons", () => {
  test("T5: file still on disk is skipped as still_on_disk", async () => {
    const projectId = uniqueProjectId();
    const tmp = await tmpRepoFile("alive-content");
    after(async () => {
      await deleteChunksForFile(projectId, tmp.path);
      await tmp.cleanup();
    });
    await insertThrowawayChunkForFile(projectId, tmp.path, "alive-chunk");

    const result = await pruneMemory({
      explicit_paths: [tmp.path],
      project_id: projectId,
      confirm: true,
    });

    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.skipped_reason, "still_on_disk");
    assert.equal(c.exists_on_disk, true);

    const survivors = await listFileOriginsForProject(projectId);
    assert.ok(survivors.includes(tmp.path), "still-on-disk row must NOT be deleted");
  });

  test("T6: file_origin with no DB rows is skipped as not_in_db", async () => {
    const projectId = uniqueProjectId();
    const ghost = `/tmp/never-stored-${randomUUID()}.md`;

    const result = await pruneMemory({
      explicit_paths: [ghost],
      project_id: projectId,
      confirm: true,
    });

    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.skipped_reason, "not_in_db");
    assert.equal(c.chunk_count, 0);
  });
});
