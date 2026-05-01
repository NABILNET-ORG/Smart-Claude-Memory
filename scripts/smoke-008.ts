import { config } from "dotenv";
import pg from "pg";
import crypto from "node:crypto";

config();

const cs = process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
if (!cs) { console.error("no connection string"); process.exit(1); }

const c = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
await c.connect();

const TEST_ORIGIN = `smoke-008-${crypto.randomBytes(4).toString("hex")}`;
const TEST_CONTENT = "v2.0.0-rc1 dual-scope smoke test row — should appear when include_global=true, hidden when false";
const VEC = `[${Array(768).fill(0).map((_, i) => Math.sin(i / 100) * 0.01).join(",")}]`;

await c.query(
  `select upsert_memory_rule($1, $2, 0, $3, $4::vector(768), '{"smoke": true, "type": "LOG", "is_global": true}'::jsonb)`,
  ["GLOBAL", TEST_ORIGIN, TEST_CONTENT, VEC],
);

const otherProject = "no-such-project-xyz";

const r1 = await c.query(
  `select count(*)::int as n
   from match_memory_chunks($1::vector(768), $2, 50, 0.0, null, true)
   where file_origin = $3`,
  [VEC, otherProject, TEST_ORIGIN],
);

const r2 = await c.query(
  `select count(*)::int as n
   from match_memory_chunks($1::vector(768), $2, 50, 0.0, null, false)
   where file_origin = $3`,
  [VEC, otherProject, TEST_ORIGIN],
);

const r3 = await c.query(
  `select count(*)::int as n
   from match_memory_chunks($1::vector(768), $2, 50, 0.0, '{"smoke": true}'::jsonb, true)
   where file_origin = $3`,
  [VEC, otherProject, TEST_ORIGIN],
);

const del = await c.query(
  `delete from memory_chunks where project_id='GLOBAL' and file_origin=$1`,
  [TEST_ORIGIN],
);

const t = r1.rows[0].n;
const f = r2.rows[0].n;
const meta = r3.rows[0].n;

console.log("include_global=true   →", t, "(expect 1)");
console.log("include_global=false  →", f, "(expect 0)");
console.log("metadata_filter+global→", meta, "(expect 1)");
console.log("cleanup deleted        →", del.rowCount);

await c.end();

const ok = t === 1 && f === 0 && meta === 1;
if (!ok) {
  console.error("SMOKE FAILED");
  process.exit(2);
}
console.log("SMOKE PASS");
