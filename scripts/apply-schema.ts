// scripts/apply-schema.ts — Marketplace-Packaging Task 2.
//
// Two modes:
//   1. Default (no args): scan scripts/*.sql, diff against schema_migrations
//      ledger, apply all pending migrations transactionally per-file.
//      Re-running is a no-op.
//   2. Legacy single-file (one positional arg): apply a single file without
//      consulting / updating the ledger. Retained for emergency fix-forwards
//      and manual reruns. Example: `npm run schema 016_daemon_telemetry.sql`.
//
// Connection: SUPABASE_POOLER_URL (preferred, IPv4) || SUPABASE_DB_URL.
//   IPv6-only `db.*.supabase.co` URLs fail on most networks — pooler wins.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import {
  applyPendingMigrations,
  listPendingMigrations,
  loadMigrationFiles,
  MIGRATIONS_DIR,
} from "../src/lib/migrations.js";

const { Client } = pg;

async function main(): Promise<void> {
  const arg = process.argv[2];

  const connectionString =
    process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error("SUPABASE_POOLER_URL or SUPABASE_DB_URL missing from environment");
    process.exit(1);
  }

  // Local Postgres (supabase start / Docker) does not support SSL; cloud Supabase requires it.
  const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);
  const client = new Client({
    connectionString,
    ssl: isLocalDb ? false : { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    if (arg) {
      // Legacy single-file mode — no ledger touch.
      const sql = readFileSync(resolve(MIGRATIONS_DIR, arg), "utf8");
      console.log(`applying ${arg} (legacy single-file mode)...`);
      await client.query(sql);
      console.log(`Schema applied: ${arg}`);
      return;
    }

    // Default mode — idempotent apply-all.
    const all = loadMigrationFiles();
    const pending = await listPendingMigrations(client);

    if (pending.length === 0) {
      console.log(
        `No pending migrations. ${all.length} already applied (ledger up to date).`,
      );
      return;
    }

    console.log(
      `Pending: ${pending.length} of ${all.length} migrations. Applying...`,
    );
    for (const p of pending) {
      console.log(`  - ${p.filename}`);
    }

    const result = await applyPendingMigrations(client);
    console.log("");
    console.log(
      `Summary: applied=${result.applied}, skipped=${result.skipped}, total=${result.total}`,
    );
    if (result.appliedFiles.length > 0) {
      console.log("Applied:");
      for (const f of result.appliedFiles) console.log(`  + ${f}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
