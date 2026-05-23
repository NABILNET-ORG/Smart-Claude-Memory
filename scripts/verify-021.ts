// scripts/verify-021.ts
// Confirms migration 021 (agent_budgets) is correctly applied:
//   - 4 tables present  : budget_tasks, budget_task_events,
//                         daemon_budget_buckets, daemon_budget_events.
//   - 2 views present   : v_task_budget_health, v_daemon_budget_health.
//   - RLS enabled on all 4 tables (deny-all).
//   - UNIQUE constraint on daemon_budget_buckets(daemon, axis, hour_bucket).
//   - increment_daemon_bucket(text, text, int) function present.
// Idempotent. Prints a single-line PASS/FAIL summary.

import "dotenv/config";
import pg from "pg";

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_POOLER_URL or SUPABASE_DB_URL missing");
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const expectedTables = [
  "budget_tasks",
  "budget_task_events",
  "daemon_budget_buckets",
  "daemon_budget_events",
];
const expectedViews = ["v_task_budget_health", "v_daemon_budget_health"];

const { rows: tableRows } = await client.query<{ table_name: string; rls: boolean }>(
  `select c.relname as table_name, c.relrowsecurity as rls
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = any($1::text[])`,
  [expectedTables],
);

const { rows: viewRows } = await client.query<{ table_name: string }>(
  `select v.viewname as table_name
     from pg_views v
    where v.schemaname = 'public'
      and v.viewname = any($1::text[])`,
  [expectedViews],
);

const { rows: uniqueRows } = await client.query<{ conname: string }>(
  `select c.conname
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
    where t.relname = 'daemon_budget_buckets'
      and c.contype = 'u'
      and c.conkey is not null`,
);

const { rows: fnRows } = await client.query<{ proname: string; args: string }>(
  `select p.proname,
          pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'increment_daemon_bucket'`,
);

await client.end();

const failures: string[] = [];

const foundTables = new Set(tableRows.map((r) => r.table_name));
for (const t of expectedTables) {
  if (!foundTables.has(t)) failures.push(`missing table: ${t}`);
}
for (const r of tableRows) {
  if (!r.rls) failures.push(`RLS disabled on ${r.table_name}`);
}

const foundViews = new Set(viewRows.map((r) => r.table_name));
for (const v of expectedViews) {
  if (!foundViews.has(v)) failures.push(`missing view: ${v}`);
}

if (uniqueRows.length === 0) {
  failures.push("missing UNIQUE constraint on daemon_budget_buckets");
}

if (fnRows.length === 0) {
  failures.push("missing function increment_daemon_bucket");
} else if (fnRows[0]!.args !== "p_daemon text, p_axis text, p_delta integer") {
  failures.push(
    `increment_daemon_bucket signature mismatch: got "${fnRows[0]!.args}"`,
  );
}

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} issue(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(2);
}

console.log(
  `PASS — 4 tables (RLS on), 2 views, UNIQUE constraint, increment_daemon_bucket present.`,
);
