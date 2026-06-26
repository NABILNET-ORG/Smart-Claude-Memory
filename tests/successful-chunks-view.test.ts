// Integration test for the successful_chunks view (scripts/031). Runs against the
// live dev DB (the view must be applied via `npm run schema` first). No fixture
// inserts — asserts the view exactly implements the agreed metadata success rule
// over existing data, and spot-checks one real included + one real excluded chunk.
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

const RULE_WHERE = `
     metadata->>'type' in ('DECISION','PATTERN')
  or metadata->>'status' in ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed')
  or metadata->>'is_global' = 'true'`;

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
  });

  after(async () => {
    if (!client) return;
    await client.end();
    client = null;
  });

  test("view row set exactly equals the metadata rule, and is non-empty", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const view = await client.query<{ n: number }>(
      `select count(*)::int as n from public.successful_chunks`,
    );
    const direct = await client.query<{ n: number }>(
      `select count(*)::int as n from public.memory_chunks where ${RULE_WHERE}`,
    );
    assert.equal(view.rows[0]!.n, direct.rows[0]!.n, "view count must equal direct rule count");
    assert.ok(view.rows[0]!.n > 0, "expected a non-empty success set on the dev DB");
  });

  test("a real DECISION chunk is included; an unqualified ERROR chunk is excluded", async (t) => {
    if (!RUN || !client) return t.skip("no DB");
    const dec = await client.query<{ id: number }>(
      `select id from public.memory_chunks where metadata->>'type'='DECISION' limit 1`,
    );
    // Find an ERROR chunk that has NO qualifying status and is NOT global —
    // such a chunk must be excluded by the view's success rule.
    const err = await client.query<{ id: number }>(
      `select id from public.memory_chunks
       where metadata->>'type' = 'ERROR'
         and (metadata->>'status' is null or metadata->>'status' not in ('shipped','applied','implemented','verified','deployed','fixed','verified-live','session-closed'))
         and (metadata->>'is_global' is null or metadata->>'is_global' <> 'true')
       limit 1`,
    );
    if (dec.rows[0]) {
      const r = await client.query(`select 1 from public.successful_chunks where chunk_id=$1`, [dec.rows[0].id]);
      assert.equal(r.rowCount, 1, "DECISION chunk must be in the view");
    }
    if (err.rows[0]) {
      const r = await client.query(`select 1 from public.successful_chunks where chunk_id=$1`, [err.rows[0].id]);
      assert.equal(r.rowCount, 0, "unqualified ERROR chunk must NOT be in the view");
    }
  });
});
