import { config } from "dotenv";
import pg from "pg";

config();

const { Client } = pg;
const cs = process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
if (!cs) { console.error("no connection string"); process.exit(1); }

const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
await c.connect();

const idx = await c.query(
  `select indexname, indexdef from pg_indexes
   where tablename='memory_chunks' and indexname='memory_chunks_metadata_gin_idx'`
);
console.log("GIN index rows:", idx.rowCount);
if (idx.rowCount) console.log("  def:", idx.rows[0].indexdef);

const fn = await c.query(
  `select pg_get_function_identity_arguments(p.oid) as args,
          array_to_string(p.proconfig, ' | ') as cfg
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='match_memory_chunks'`
);
console.log("match_memory_chunks rows:", fn.rowCount);
for (const r of fn.rows) console.log("  args:", r.args, "| cfg:", r.cfg);

const com = await c.query(
  `select col_description('public.memory_chunks'::regclass, attnum) as d
   from pg_attribute where attrelid='public.memory_chunks'::regclass and attname='metadata'`
);
console.log("comment present:", !!com.rows[0]?.d, "| len:", com.rows[0]?.d?.length ?? 0);

await c.end();
