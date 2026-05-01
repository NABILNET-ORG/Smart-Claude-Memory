// scripts/verify-008.ts
// Confirms exactly ONE match_memory_chunks survives migration 008 and that it
// has 6 arguments. Idempotent. Prints a single-line PASS/FAIL summary.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import pg from "pg";

const { Client } = pg;
const _here = dirname(fileURLToPath(import.meta.url));

const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_POOLER_URL or SUPABASE_DB_URL missing from environment");
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query<{ args: string; nargs: number }>(
  `select pg_get_function_identity_arguments(p.oid) as args,
          p.pronargs as nargs
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'match_memory_chunks'
    order by 1`,
);
await client.end();

if (rows.length !== 1) {
  console.error(`FAIL — expected 1 overload, found ${rows.length}`);
  for (const r of rows) console.error(`  ${r.args} (nargs=${r.nargs})`);
  process.exit(2);
}
const r = rows[0]!;
if (r.nargs !== 6) {
  console.error(`FAIL — expected 6 args, found ${r.nargs}: ${r.args}`);
  process.exit(3);
}
console.log(`PASS — exactly 1 match_memory_chunks with 6 args: ${r.args}`);
