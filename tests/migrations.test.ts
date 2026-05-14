// Integration tests for src/lib/migrations.ts — schema_migrations ledger helpers.
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).
//
// Test isolation:
//   The dev DB already has all 18 migrations applied to the public schema
//   but no rows in schema_migrations. These tests MUST NOT touch public —
//   they create a temporary throwaway schema (scm_test_<ts>) at setup,
//   run all `CREATE TABLE` / `SELECT` / `INSERT` against it via
//   `SET search_path`, and drop the schema at teardown.
//
// Coverage gap (intentional):
//   We do NOT call `applyPendingMigrations()` end-to-end because the 18
//   bundled migrations reference real objects (memory_chunks, RPCs, RLS
//   policies, etc.) that already live in `public` and would conflict on a
//   second apply attempt. Applying them inside an isolated temp schema
//   would also fail because qualified `public.*` references inside the
//   SQL bodies cannot be redirected via search_path. The transaction-
//   per-file apply loop is exercised manually via `npm run schema` on
//   the live dev DB (see Step 9 smoke).

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  applyPendingMigrations,
  ensureLedger,
  loadMigrationFiles,
  listPendingMigrations,
  MIGRATIONS_DIR,
} from "../src/lib/migrations.js";

const { Client } = pg;

const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;

const RUN_DB_TESTS =
  !!connectionString && process.env.SKIP_DB_TESTS !== "1";

const TEST_SCHEMA = `scm_test_${Date.now()}`;
let client: pg.Client | null = null;

describe("loadMigrationFiles — pure FS helper (no DB)", () => {
  test("returns >=18 migration files matching /^0\\d{2}_.+\\.sql$/", () => {
    const files = loadMigrationFiles();
    assert.ok(files.length >= 18, `expected >=18 migrations, got ${files.length}`);
    for (const f of files) {
      assert.match(f.filename, /^0\d{2}_.+\.sql$/, `bad filename: ${f.filename}`);
    }
  });

  test("returned files are sorted lexically by filename", () => {
    const files = loadMigrationFiles();
    const filenames = files.map((f) => f.filename);
    const sorted = [...filenames].sort();
    assert.deepEqual(filenames, sorted, "migrations must be lex-sorted");
  });

  test("each file has a valid 64-char hex sha256 matching its body", () => {
    const files = loadMigrationFiles();
    for (const f of files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `bad sha256 for ${f.filename}`);
      const body = readFileSync(join(MIGRATIONS_DIR, f.filename), "utf8");
      const expected = createHash("sha256").update(body).digest("hex");
      assert.equal(f.sha256, expected, `sha256 mismatch for ${f.filename}`);
    }
  });

  test("excludes non-SQL helpers that share the scripts/ directory", () => {
    // Smoke/verify fixtures now live under tests/sql_fixtures/ and cannot
    // appear here. The remaining guard is that TS helpers in scripts/
    // (e.g. apply-schema.ts) never match the migration regex.
    const files = loadMigrationFiles();
    const names = new Set(files.map((f) => f.filename));
    assert.ok(!names.has("apply-schema.ts"));
  });

  test("includes the canonical 001_schema.sql entry point", () => {
    const files = loadMigrationFiles();
    const names = files.map((f) => f.filename);
    assert.ok(names.includes("001_schema.sql"));
  });
});

describe("DB-backed: ensureLedger + listPendingMigrations (temp schema)", () => {
  before(async () => {
    if (!RUN_DB_TESTS) return;
    client = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
  });

  after(async () => {
    if (!client) return;
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    } finally {
      await client.end();
      client = null;
    }
  });

  test("ensureLedger creates schema_migrations table (idempotent)", async (t) => {
    if (!RUN_DB_TESTS || !client) return t.skip("no SUPABASE_POOLER_URL");

    await ensureLedger(client);
    await ensureLedger(client); // idempotent — second call must not throw

    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'schema_migrations'
       ) AS exists`,
      [TEST_SCHEMA],
    );
    assert.equal(rows[0]?.exists, true, "schema_migrations must exist in temp schema");
  });

  test("ledger row shape matches contract (filename PK, sha256, applied_at)", async (t) => {
    if (!RUN_DB_TESTS || !client) return t.skip("no SUPABASE_POOLER_URL");

    const { rows } = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'schema_migrations'
        ORDER BY ordinal_position`,
      [TEST_SCHEMA],
    );
    const cols = new Map(rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(cols.get("filename"), "text");
    assert.equal(cols.get("sha256"), "text");
    assert.ok(
      (cols.get("applied_at") ?? "").startsWith("timestamp"),
      `applied_at must be timestamptz, got ${cols.get("applied_at")}`,
    );
  });

  test("listPendingMigrations returns all files when ledger is empty", async (t) => {
    if (!RUN_DB_TESTS || !client) return t.skip("no SUPABASE_POOLER_URL");

    // Confirm ledger is empty in this temp schema.
    await client.query(`TRUNCATE TABLE "${TEST_SCHEMA}".schema_migrations`);
    const pending = await listPendingMigrations(client);
    const all = loadMigrationFiles();
    assert.equal(
      pending.length,
      all.length,
      `empty ledger → all ${all.length} migrations pending, got ${pending.length}`,
    );
    assert.deepEqual(
      pending.map((p) => p.filename),
      all.map((a) => a.filename),
    );
  });

  test("listPendingMigrations excludes filenames already in the ledger", async (t) => {
    if (!RUN_DB_TESTS || !client) return t.skip("no SUPABASE_POOLER_URL");

    const all = loadMigrationFiles();
    const fake = all[0]!;
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}".schema_migrations (filename, sha256)
       VALUES ($1, $2)
       ON CONFLICT (filename) DO NOTHING`,
      [fake.filename, fake.sha256],
    );

    const pending = await listPendingMigrations(client);
    assert.equal(pending.length, all.length - 1);
    assert.ok(!pending.some((p) => p.filename === fake.filename));
  });
});

// Opt-in via RUN_IDEMPOTENCY_TEST=1 — destructively truncates+restores
// public.schema_migrations to prove every migration body is re-runnable
// against a DB that already has all schema objects in place.
describe("Idempotency proof — re-applying over an already-migrated DB", () => {
  let idemClient: pg.Client | null = null;
  const RUN_IDEMPOTENCY = RUN_DB_TESTS && process.env.RUN_IDEMPOTENCY_TEST === "1";

  before(async () => {
    if (!RUN_IDEMPOTENCY) return;
    idemClient = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await idemClient.connect();
    // Pin search_path so unqualified DDL inside migration bodies
    // (and ensureLedger's CREATE TABLE IF NOT EXISTS schema_migrations)
    // resolves to public. The pooler role does not always inherit this.
    // Include `extensions` so pgvector operator classes (vector_cosine_ops
    // etc.) resolve — Supabase installs extensions to that schema, not public.
    await idemClient.query("SET search_path TO public, extensions");
  });

  after(async () => {
    if (!idemClient) return;
    await idemClient.end();
    idemClient = null;
  });

  test("applyPendingMigrations succeeds a second time over a fully-applied schema", async (t) => {
    if (!RUN_IDEMPOTENCY || !idemClient) {
      return t.skip("opt-in: set RUN_IDEMPOTENCY_TEST=1 + SUPABASE_POOLER_URL");
    }

    // 1. Snapshot the existing ledger so we can restore it in `finally`,
    //    even if the assertions below throw. The dev DB must not be left
    //    in a half-broken state for the next contributor.
    const snapshot = await idemClient.query<{
      filename: string;
      sha256: string;
      applied_at: Date;
    }>(
      "SELECT filename, sha256, applied_at FROM public.schema_migrations ORDER BY applied_at",
    );

    try {
      // 2. Wipe the ledger but leave every public.* object intact. This
      //    is the exact "re-apply" scenario: the DB already has all 18
      //    migrations' worth of tables/functions/policies, but the ledger
      //    is empty so applyPendingMigrations will attempt every file.
      await idemClient.query("TRUNCATE TABLE public.schema_migrations");

      // 3. Re-apply. Every file must succeed — that is the proof that
      //    each migration body is strictly idempotent.
      const result = await applyPendingMigrations(idemClient);
      assert.equal(
        result.applied,
        18,
        `expected 18 re-applied, got ${result.applied} (skipped=${result.skipped})`,
      );
      assert.equal(result.skipped, 0, "ledger was truncated → nothing should be skipped");
    } finally {
      // 4. ALWAYS restore the snapshot — even on assertion failure. UPSERT
      //    by filename so a partial re-apply (from a failed test attempt)
      //    is reconciled cleanly.
      for (const row of snapshot.rows) {
        await idemClient.query(
          `INSERT INTO public.schema_migrations (filename, sha256, applied_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (filename) DO UPDATE
             SET sha256 = EXCLUDED.sha256,
                 applied_at = EXCLUDED.applied_at`,
          [row.filename, row.sha256, row.applied_at],
        );
      }
    }
  });
});
