// scripts/purge-graph-nodes.ts — one-off; DRY-RUN unless --commit is passed.
// Deletes kg_nodes whose label is pre-SCM-S50 structural garbage, scoped to one
// project. Single source of truth: src/graph/sanitize.ts. kg_nodes is derived —
// a mistaken delete is recoverable by re-extraction.
import "dotenv/config";
import { Client } from "pg";
import { isGarbageLabel, sanitizeForExtraction } from "../src/graph/sanitize.js";

const COMMIT = process.argv.includes("--commit");
const PROJECT = process.env.SCM_PURGE_PROJECT ?? "claude-memory";

function isHistoricalGarbage(label: string): boolean {
  return isGarbageLabel(label) || isGarbageLabel(sanitizeForExtraction(label).trim());
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_POOLER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; label: string }>(
      "SELECT id, label FROM kg_nodes WHERE project_id = $1",
      [PROJECT],
    );
    const garbage = rows.filter((r) => isHistoricalGarbage(r.label));
    const ids = garbage.map((r) => r.id);
    console.log(`[purge] project=${PROJECT}  total_nodes=${rows.length}  garbage=${garbage.length}`);

    let edgeCount = 0;
    if (ids.length) {
      const e = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM kg_edges WHERE source_id = ANY($1::bigint[]) OR target_id = ANY($1::bigint[])",
        [ids],
      );
      edgeCount = e.rows[0].n;
    }
    console.log(`[purge] edges that will cascade-delete: ${edgeCount}`);
    console.log("[purge] sample garbage labels (up to 30):");
    for (const r of garbage.slice(0, 30)) console.log(`   #${r.id}  ${JSON.stringify(r.label)}`);

    if (!COMMIT) {
      console.log("[purge] DRY RUN — re-run with --commit to delete.");
      return;
    }
    if (!ids.length) {
      console.log("[purge] nothing to delete.");
      return;
    }
    const res = await client.query("DELETE FROM kg_nodes WHERE id = ANY($1::bigint[])", [ids]);
    console.log(`[purge] DELETED ${res.rowCount} node(s); ${edgeCount} edge(s) cascaded.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
