// tests/pg-adapter.test.ts — live plain-PostgreSQL adapter contract tests.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx). These
// run against the real plain PG + pgvector instance on 127.0.0.1:5433 and are
// gated on SKIP_DB_TESTS — set SKIP_DB_TESTS=1 to skip in CI without a DB.
//
// Isolation: every row this suite writes uses a throwaway project_id
// (`scm_pgadapter_test_<ts>`). before()/after() purge that project_id from the
// three tables touched so re-runs are idempotent and no production data is
// implicated. The DB starts empty; the suite seeds exactly what it asserts on.

// Point the adapter at the live plain DB BEFORE importing it (module reads env
// lazily on first query, but we set both vars up front for determinism).
process.env.SUPABASE_POOLER_URL =
  process.env.SUPABASE_POOLER_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
process.env.SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.SUPABASE_POOLER_URL;

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPgClient, closePgPool } from "../src/db/pg-adapter.js";

const RUN_DB_TESTS = process.env.SKIP_DB_TESTS !== "1";

const db = createPgClient();
const PID = `scm_pgadapter_test_${Date.now()}`;

// A deterministic 768-d unit vector (pointing along axis 0). pgvector columns
// in this schema are vector(768); we must bind exactly 768 dims.
function vec(seed: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[0] = seed;
  return v;
}

async function purge(): Promise<void> {
  await db.from("memory_chunks").delete().eq("project_id", PID);
  await db.from("cloud_backlog").delete().eq("project_id", PID);
  await db.from("archive_backlog").delete().eq("project_id", PID);
  await db.from("frozen_features").delete().eq("project_id", PID);
  await db.from("daemon_budget_buckets").delete().eq("daemon", PID);
}

before(async () => {
  if (!RUN_DB_TESTS) return;
  await purge();
});

after(async () => {
  if (RUN_DB_TESTS) await purge();
  await closePgPool();
});

// Helper: seed one memory_chunks row with a given vector + metadata.
async function seedChunk(
  fileOrigin: string,
  chunkIndex: number,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown> = {},
  fileHash = "hash0",
): Promise<void> {
  const { error } = await db.from("memory_chunks").insert({
    project_id: PID,
    content,
    file_origin: fileOrigin,
    chunk_index: chunkIndex,
    embedding,
    content_hash: `c_${fileOrigin}_${chunkIndex}`,
    file_hash: fileHash,
    metadata,
  });
  assert.equal(error, null, `seedChunk insert error: ${error?.message}`);
}

describe("pg-adapter — insert / select / shapes", () => {
  test("bare insert returns {data:null,error:null}", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const res = await db.from("cloud_backlog").insert({
      project_id: PID,
      title: "bare-insert",
      priority: 3,
    });
    assert.equal(res.error, null);
    assert.equal(res.data, null);
  });

  test("insert(...).select().single() returns the inserted row object", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db
      .from("cloud_backlog")
      .insert({ project_id: PID, title: "single-insert", priority: 2, notes: "n" })
      .select()
      .single();
    assert.equal(error, null);
    assert.ok(data && typeof data === "object" && !Array.isArray(data));
    assert.equal((data as { title: string }).title, "single-insert");
    assert.equal((data as { priority: number }).priority, 2);
    assert.ok(typeof (data as { id: number }).id === "number");
  });

  test("insert array of rows + select() returns array", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db
      .from("cloud_backlog")
      .insert([
        { project_id: PID, title: "multi-a", priority: 5 },
        { project_id: PID, title: "multi-b", priority: 5 },
      ])
      .select();
    assert.equal(error, null);
    assert.ok(Array.isArray(data));
    assert.equal((data as unknown[]).length, 2);
  });

  test("select with no rows → data is [] (not null), error null", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db
      .from("cloud_backlog")
      .select("*")
      .eq("project_id", `${PID}_nonexistent`);
    assert.equal(error, null);
    assert.deepEqual(data, []);
  });
});

describe("pg-adapter — count / head", () => {
  test("select('*', {count:'exact', head:true}) returns count, data null", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await seedChunk("count_head.md", 0, "x", vec(1));
    await seedChunk("count_head.md", 1, "y", vec(1));
    const { data, error, count } = await db
      .from("memory_chunks")
      .select("*", { count: "exact", head: true })
      .eq("project_id", PID)
      .eq("file_origin", "count_head.md");
    assert.equal(error, null);
    assert.equal(data, null);
    assert.equal(count, 2);
  });

  test("select(cols, {count:'exact'}) returns rows AND count", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error, count } = await db
      .from("memory_chunks")
      .select("file_origin, chunk_index", { count: "exact" })
      .eq("project_id", PID)
      .eq("file_origin", "count_head.md");
    assert.equal(error, null);
    assert.ok(Array.isArray(data));
    assert.equal((data as unknown[]).length, 2);
    assert.equal(count, 2);
  });
});

describe("pg-adapter — comparison + null + list operators", () => {
  before(async () => {
    if (!RUN_DB_TESTS) return;
    // statuses + priorities for ordering/filter tests
    await db.from("cloud_backlog").insert([
      { project_id: PID, title: "op-todo-1", status: "todo", priority: 1 },
      { project_id: PID, title: "op-done-5", status: "done", priority: 5 },
      { project_id: PID, title: "op-prog-3", status: "in_progress", priority: 3 },
    ]);
  });

  test("eq + neq", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    // eq narrows on the exact controlled row (title is unique within PID).
    const eqRes = await db
      .from("cloud_backlog")
      .select("title, status")
      .eq("project_id", PID)
      .eq("title", "op-todo-1");
    assert.equal(eqRes.error, null);
    assert.equal((eqRes.data as unknown[]).length, 1);
    assert.equal((eqRes.data as { status: string }[])[0].status, "todo");

    // neq excludes that status: none of the returned rows may be 'todo'.
    const neqRes = await db
      .from("cloud_backlog")
      .select("status")
      .eq("project_id", PID)
      .neq("status", "todo");
    assert.equal(neqRes.error, null);
    assert.ok((neqRes.data as { status: string }[]).every((r) => r.status !== "todo"));
  });

  test("gte / lt / lte on priority", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const gte = await db
      .from("cloud_backlog")
      .select("priority")
      .eq("project_id", PID)
      .gte("priority", 5);
    assert.equal(gte.error, null);
    assert.ok((gte.data as { priority: number }[]).every((r) => r.priority >= 5));

    const lt = await db
      .from("cloud_backlog")
      .select("priority")
      .eq("project_id", PID)
      .lt("priority", 5);
    assert.equal(lt.error, null);
    assert.ok((lt.data as { priority: number }[]).every((r) => r.priority < 5));

    const lte = await db
      .from("cloud_backlog")
      .select("priority")
      .eq("project_id", PID)
      .lte("priority", 5);
    assert.equal(lte.error, null);
    assert.ok((lte.data as { priority: number }[]).every((r) => r.priority <= 5));
  });

  test("in (array) + in (empty array → no match)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const inRes = await db
      .from("cloud_backlog")
      .select("status")
      .eq("project_id", PID)
      .in("status", ["todo", "done"]);
    assert.equal(inRes.error, null);
    assert.ok((inRes.data as { status: string }[]).every((r) => ["todo", "done"].includes(r.status)));

    const emptyRes = await db
      .from("cloud_backlog")
      .select("status")
      .eq("project_id", PID)
      .in("status", []);
    assert.equal(emptyRes.error, null);
    assert.deepEqual(emptyRes.data, []);
  });

  test("is(col, null) + not(col,'is',null)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    // notes is null for the op-* rows above; seed one with notes set.
    await db.from("cloud_backlog").insert({ project_id: PID, title: "has-notes", notes: "present" });

    const nullRes = await db
      .from("cloud_backlog")
      .select("notes")
      .eq("project_id", PID)
      .is("notes", null);
    assert.equal(nullRes.error, null);
    assert.ok((nullRes.data as { notes: string | null }[]).every((r) => r.notes === null));

    const notNullRes = await db
      .from("cloud_backlog")
      .select("notes")
      .eq("project_id", PID)
      .not("notes", "is", null);
    assert.equal(notNullRes.error, null);
    assert.ok((notNullRes.data as { notes: string | null }[]).every((r) => r.notes !== null));
  });

  test("not(col,'in','(...)') raw-string form → NOT IN", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    // mirrors src/graduation/scanner.ts usage: .not("id","in","(1,2,3)")
    const all = await db.from("cloud_backlog").select("id").eq("project_id", PID);
    const ids = (all.data as { id: number }[]).map((r) => r.id);
    const exclude = ids.slice(0, 1);
    const res = await db
      .from("cloud_backlog")
      .select("id")
      .eq("project_id", PID)
      .not("id", "in", `(${exclude.join(",")})`);
    assert.equal(res.error, null);
    assert.ok((res.data as { id: number }[]).every((r) => !exclude.includes(r.id)));
  });

  test("ilike pattern match (case-insensitive)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const res = await db
      .from("cloud_backlog")
      .select("title")
      .eq("project_id", PID)
      .ilike("title", "%PROG%");
    assert.equal(res.error, null);
    assert.ok((res.data as { title: string }[]).some((r) => r.title === "op-prog-3"));
  });

  test("like pattern match (case-sensitive)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    // lowercase 'prog' matches; uppercase 'PROG' must NOT (LIKE is case-sensitive).
    const hit = await db
      .from("cloud_backlog")
      .select("title")
      .eq("project_id", PID)
      .like("title", "%prog%");
    assert.equal(hit.error, null);
    assert.ok((hit.data as { title: string }[]).some((r) => r.title === "op-prog-3"));

    const miss = await db
      .from("cloud_backlog")
      .select("title")
      .eq("project_id", PID)
      .like("title", "%PROG%");
    assert.equal(miss.error, null);
    assert.ok((miss.data as { title: string }[]).every((r) => r.title !== "op-prog-3"));
  });

  test("order + limit + range", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const ordered = await db
      .from("cloud_backlog")
      .select("priority")
      .eq("project_id", PID)
      .in("priority", [1, 3, 5])
      .order("priority", { ascending: false });
    assert.equal(ordered.error, null);
    const prios = (ordered.data as { priority: number }[]).map((r) => r.priority);
    assert.deepEqual([...prios].sort((a, b) => b - a), prios, "must be DESC");

    const limited = await db
      .from("cloud_backlog")
      .select("id")
      .eq("project_id", PID)
      .order("id", { ascending: true })
      .limit(1);
    assert.equal((limited.data as unknown[]).length, 1);

    // range(0,1) inclusive → 2 rows
    const ranged = await db
      .from("cloud_backlog")
      .select("id")
      .eq("project_id", PID)
      .order("id", { ascending: true })
      .range(0, 1);
    assert.equal(ranged.error, null);
    assert.equal((ranged.data as unknown[]).length, 2);
  });
});

describe("pg-adapter — or / contains (jsonb)", () => {
  test("or('project_id.eq.X,project_id.eq.GLOBAL') parses to OR group", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await seedChunk("or_test.md", 0, "scoped", vec(1), { kind: "scoped" });
    const res = await db
      .from("memory_chunks")
      .select("project_id")
      .eq("file_origin", "or_test.md")
      .or(`project_id.eq.${PID},project_id.eq.GLOBAL`);
    assert.equal(res.error, null);
    assert.ok((res.data as { project_id: string }[]).every((r) => r.project_id === PID || r.project_id === "GLOBAL"));
    assert.ok((res.data as unknown[]).length >= 1);
  });

  test("contains(col, obj) → @> jsonb containment", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await seedChunk("contains.md", 0, "c", vec(1), { type: "DECISION", tag: "x" });
    await seedChunk("contains.md", 1, "c", vec(1), { type: "PATTERN" });
    const res = await db
      .from("memory_chunks")
      .select("metadata")
      .eq("project_id", PID)
      .eq("file_origin", "contains.md")
      .contains("metadata", { type: "DECISION" });
    assert.equal(res.error, null);
    assert.equal((res.data as unknown[]).length, 1);
    assert.equal((res.data as { metadata: { type: string } }[])[0].metadata.type, "DECISION");
  });
});

describe("pg-adapter — update / delete", () => {
  test("update(patch).eq().select().single()", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const inserted = await db
      .from("cloud_backlog")
      .insert({ project_id: PID, title: "to-update", priority: 3 })
      .select()
      .single();
    const id = (inserted.data as { id: number }).id;

    const { data, error } = await db
      .from("cloud_backlog")
      .update({ status: "done", priority: 5 })
      .eq("id", id)
      .select()
      .single();
    assert.equal(error, null);
    assert.equal((data as { status: string }).status, "done");
    assert.equal((data as { priority: number }).priority, 5);
  });

  test("delete() bare + delete({count:'exact'}) returns count", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await db.from("frozen_features").insert([
      { project_id: PID, pattern: "del-a" },
      { project_id: PID, pattern: "del-b" },
    ]);
    const counted = await db
      .from("frozen_features")
      .delete({ count: "exact" })
      .eq("project_id", PID)
      .eq("pattern", "del-a");
    assert.equal(counted.error, null);
    assert.equal(counted.count, 1);

    const bare = await db.from("frozen_features").delete().eq("project_id", PID).eq("pattern", "del-b");
    assert.equal(bare.error, null);
    assert.equal(bare.data, null);
  });
});

describe("pg-adapter — upsert (onConflict)", () => {
  test("upsert with onConflict updates the non-key columns", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const payload = {
      project_id: PID,
      content: "v1",
      file_origin: "upsert.md",
      chunk_index: 0,
      embedding: vec(1),
      content_hash: "h_v1",
      file_hash: "fh1",
      metadata: { v: 1 },
    };
    const first = await db.from("memory_chunks").upsert(payload, {
      onConflict: "project_id,file_origin,chunk_index",
    });
    assert.equal(first.error, null);

    // same conflict key, new content → should UPDATE not duplicate
    const second = await db.from("memory_chunks").upsert(
      { ...payload, content: "v2", content_hash: "h_v2", metadata: { v: 2 } },
      { onConflict: "project_id,file_origin,chunk_index" },
    );
    assert.equal(second.error, null);

    const rows = await db
      .from("memory_chunks")
      .select("content, metadata")
      .eq("project_id", PID)
      .eq("file_origin", "upsert.md");
    assert.equal((rows.data as unknown[]).length, 1, "must not duplicate on conflict");
    assert.equal((rows.data as { content: string }[])[0].content, "v2");
  });
});

describe("pg-adapter — maybeSingle", () => {
  test("maybeSingle: 0 rows → {data:null,error:null}", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const res = await db
      .from("cloud_backlog")
      .select("*")
      .eq("project_id", PID)
      .eq("title", "does-not-exist-xyz")
      .maybeSingle();
    assert.equal(res.error, null);
    assert.equal(res.data, null);
  });

  test("maybeSingle: 1 row → object", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await db.from("cloud_backlog").insert({ project_id: PID, title: "maybe-one-unique", priority: 4 });
    const res = await db
      .from("cloud_backlog")
      .select("title")
      .eq("project_id", PID)
      .eq("title", "maybe-one-unique")
      .maybeSingle();
    assert.equal(res.error, null);
    assert.equal((res.data as { title: string }).title, "maybe-one-unique");
  });
});

describe("pg-adapter — rpc result shapes", () => {
  test("match_memory_chunks → ARRAY of row objects", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    await seedChunk("rpc_match.md", 0, "alpha", vec(1), { type: "DECISION" });
    await seedChunk("rpc_match.md", 1, "beta", vec(1), { type: "DECISION" });
    const { data, error } = await db.rpc("match_memory_chunks", {
      query_embedding: vec(1),
      p_project_id: PID,
      match_count: 10,
      min_similarity: -1, // accept everything (cosine ∈ [-1,1])
      p_include_global: false,
    });
    assert.equal(error, null);
    assert.ok(Array.isArray(data), "match_memory_chunks must return an array");
    const arr = data as { id: number; content: string; similarity: number }[];
    assert.ok(arr.length >= 2);
    for (const row of arr) {
      assert.ok(typeof row.id === "number");
      assert.ok(typeof row.content === "string");
      assert.ok(typeof row.similarity === "number");
    }
  });

  test("increment_daemon_bucket → NUMBER (scalar)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const first = await db.rpc("increment_daemon_bucket", {
      p_daemon: PID,
      p_axis: "ollama_calls",
      p_delta: 3,
    });
    assert.equal(first.error, null);
    assert.equal(typeof first.data, "number", "must be a scalar number");
    assert.equal(first.data, 3);

    const second = await db.rpc("increment_daemon_bucket", {
      p_daemon: PID,
      p_axis: "ollama_calls",
      p_delta: 2,
    });
    assert.equal(second.error, null);
    assert.equal(second.data, 5, "accumulates within the hour bucket");
  });

  test("kg_hybrid_search → single OBJECT (jsonb)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db.rpc("kg_hybrid_search", {
      p_project_id: PID,
      p_query_embedding: vec(1),
      p_seed_limit: 5,
      p_neighbor_hops: 1,
      p_min_similarity: 0.0,
    });
    assert.equal(error, null);
    assert.ok(data && typeof data === "object" && !Array.isArray(data), "kg_hybrid_search returns a jsonb object");
    // Shape from migration 020: { seeds: [...], neighbors: [...] }
    const obj = data as Record<string, unknown>;
    assert.ok("seeds" in obj || "neighbors" in obj, `unexpected kg shape: ${JSON.stringify(obj)}`);
  });
});

describe("pg-adapter — error codes", () => {
  test("42P01 on a missing relation (data null, error.code set)", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db
      .from("this_relation_does_not_exist_scm")
      .select("*");
    assert.equal(data, null);
    assert.ok(error, "must surface an error");
    assert.equal(error?.code, "42P01");
  });

  test("PGRST116 on .single() over zero rows", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    const { data, error } = await db
      .from("cloud_backlog")
      .select("*")
      .eq("project_id", PID)
      .eq("title", "definitely-absent-row-123")
      .single();
    assert.equal(data, null);
    assert.ok(error, "must surface an error");
    assert.equal(error?.code, "PGRST116");
  });

  test("error envelope never throws — DB error is returned not raised", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("SKIP_DB_TESTS=1");
    // A type-mismatch (text into int column) must come back as {error}, not throw.
    let threw = false;
    let result: Awaited<ReturnType<ReturnType<typeof db.from>["select"]>> | null = null;
    try {
      result = await db
        .from("cloud_backlog")
        .insert({ project_id: PID, title: "bad", priority: "not-a-number" as unknown as number })
        .select();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "adapter must not throw on DB error");
    assert.ok(result && result.error, "must surface error in envelope");
  });
});
