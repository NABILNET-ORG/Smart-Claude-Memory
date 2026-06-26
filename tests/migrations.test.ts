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
      ssl: /localhost|127\.0\.0\.1/.test(connectionString ?? "") ? false : { rejectUnauthorized: true },
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

// Static idempotency check — parses every migration body and flags any
// top-level CREATE statement that lacks its idempotency guard (OR REPLACE
// for functions; IF NOT EXISTS for tables / indexes / extensions /
// ADD COLUMN). Runs unconditionally — no DB, no env flag, no live state —
// so a non-idempotent statement added to any new migration is caught the
// moment `npm test` runs in CI or locally.
//
// Why static, not a runtime "apply twice" test? Two practical blockers:
//   (a) The 18 migration bodies use `public.*` qualifiers throughout, so
//       redirecting them into a throwaway schema via `SET search_path` is
//       infeasible without a parser-level rewrite (see the "Coverage gap"
//       note at the top of this file).
//   (b) The only schema with the required objects to even attempt a
//       second apply is the live dev DB itself; truncating its
//       schema_migrations ledger to force a re-apply is destructive to
//       shared infrastructure and rightly blocked by our safeguards.
// Static analysis catches the exact regression class the v2.0.1 audit
// identified (bare CREATE FUNCTION) and generalizes to every other
// idempotency-guarded DDL form. A failure prints the offending file +
// line + statement type so the fix is obvious.
describe("Idempotency proof — static analysis of migration bodies", () => {
  const NON_IDEMPOTENT_PATTERNS: Array<[RegExp, string]> = [
    [/^\s*create\s+function\b/i, "CREATE FUNCTION without OR REPLACE"],
    [
      /^\s*create\s+(unique\s+)?index\s+(?!if\s+not\s+exists|concurrently\s+if\s+not\s+exists)/i,
      "CREATE INDEX without IF NOT EXISTS",
    ],
    [/^\s*create\s+table\s+(?!if\s+not\s+exists)/i, "CREATE TABLE without IF NOT EXISTS"],
    [/^\s*create\s+extension\s+(?!if\s+not\s+exists)/i, "CREATE EXTENSION without IF NOT EXISTS"],
    [
      /^\s*alter\s+table\s+\S+\s+add\s+column\s+(?!if\s+not\s+exists)/i,
      "ALTER TABLE ADD COLUMN without IF NOT EXISTS",
    ],
  ];

  test("every CREATE statement at top level carries its idempotency guard", () => {
    const files = loadMigrationFiles();
    const violations: string[] = [];

    for (const f of files) {
      const lines = f.body.split(/\r?\n/);
      // Toggle on `$$` so we skip statements inside plpgsql/sql function
      // bodies — only top-level (migration-apply-time) DDL matters here.
      let insideFunctionBody = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i] ?? "";
        const dollarCount = (raw.match(/\$\$/g) ?? []).length;
        if (dollarCount % 2 === 1) {
          insideFunctionBody = !insideFunctionBody;
          continue;
        }
        if (insideFunctionBody) continue;
        const line = raw.replace(/--.*$/, "").trim();
        if (!line) continue;
        for (const [pattern, label] of NON_IDEMPOTENT_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${f.filename}:${i + 1}: ${label}`);
            break;
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Non-idempotent statements found in migration bodies (would throw on re-apply):\n  ${violations.join("\n  ")}`,
    );
  });
});
