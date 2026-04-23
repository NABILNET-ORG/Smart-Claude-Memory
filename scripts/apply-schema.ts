import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const migrationArg = process.argv[2];
const migrationFile = migrationArg ?? "001_schema.sql";
const sql = readFileSync(join(here, migrationFile), "utf8");
console.log(`applying ${migrationFile}...`);

// Prefer the IPv4 pooler URL when present (direct db.*.supabase.co is IPv6-only on newer projects)
const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_POOLER_URL or SUPABASE_DB_URL missing from environment");
  process.exit(1);
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
await client.query(sql);
await client.end();
console.log("Schema applied.");
