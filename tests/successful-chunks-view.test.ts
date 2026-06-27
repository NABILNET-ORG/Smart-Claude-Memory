// Integration test for the successful_chunks view (scripts/031). Seeds its own
// fixtures under a unique throwaway project, so it is robust on ANY database —
// including a schema-only CI database with no pre-existing rows. Asserts the view
// exactly implements the agreed metadata success rule, includes a qualifying
// chunk, and excludes a non-qualifying one. Cleans up at teardown.
//
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
import "dotenv/config";
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import pg from "pg";

const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
const RUN = !!connectionString && process.env.SKIP_DB_TESTS !== "1";
let client: pg.Client | null = null;

// Unique project id so fixtures never collide with real data or a parallel run.
const TEST_PROJECT = `__scm_test_successful_chunks_${process.pid}__`;
// memory_chunks.embedding is NOT NULL (extensions.vector(768)) — supply a zero vector.
const ZERO_VEC = `[${new Array(768).fill(0).join(",")}]`;

let qualifyingId = 0; // metadata.type=DECISION → must be IN the view
let nonQualifyingId = 0; // metadata.type=ERROR (no success status, not global) → must be OUT

const RULE_WHERE = `
     metadata->>'type' in ('DECISION','PATTERN')
  or metadata->>'status' in ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed')
  or metadata->>'is_global' = 'true'`;

async function insertChunk(
  c: pg.Client,
  tag: string,
  metadata: Record<string, unknown>,
): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `insert into public.memory_chunks
       (content, embedding, file_origin, chunk_index, content_hash, metadata, project_id)
     values ($1, $2::extensions.vector, $3, 0, $4, $5::jsonb, $6)
     returning id`,
    [
      `fixture ${tag}`,
      ZERO_VEC,
      `${TEST_PROJECT}/${tag}`,
      `${TEST_PROJECT}-${tag}`,
      JSON.stringify(metadata),
      TEST_PROJECT,
    ],
  );
  return rows[0]!.id;
}

describe("successful_chunks view — metadata-driven success rule", () => {
  before(async () => {
    if (!RUN) return;
    client = new pg.Client({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString ?? "")
        ? false
        : { rejectUnauthorized: true },
    });
    await client.connect();
    await client.query(`delete from public.memory_chunks where project_id = $1`, [TEST_PROJECT]);
    qualifyingId = await insertChunk(client, "decision", { type: "DECISION" });
    nonQualifyingId = await insertChunk(client, "error", { type: "ERROR" });
  });

  after(async () => {
    if (!client) return;
    try {
      await client.query(`delete from public.memory_chunks where project_id = $1`, [TEST_PROJECT]);
    } finally {
      await client.end();
      client = null;
    }
  });

  test("view row set exactly equals the metadata rule", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const view = await client.query<{ n: number }>(
      `select count(*)::int as n from public.successful_chunks`,
    );
    const direct = await client.query<{ n: number }>(
      `select count(*)::int as n from public.memory_chunks where ${RULE_WHERE}`,
    );
    assert.equal(view.rows[0]!.n, direct.rows[0]!.n, "view count must equal direct rule count");
  });

  test("includes a qualifying DECISION chunk, excludes a non-qualifying ERROR chunk", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const inc = await client.query(
      `select 1 from public.successful_chunks where chunk_id = $1`,
      [qualifyingId],
    );
    assert.equal(inc.rowCount, 1, "DECISION fixture must be IN the view");
    const exc = await client.query(
      `select 1 from public.successful_chunks where chunk_id = $1`,
      [nonQualifyingId],
    );
    assert.equal(exc.rowCount, 0, "unqualified ERROR fixture must NOT be in the view");
  });
});
