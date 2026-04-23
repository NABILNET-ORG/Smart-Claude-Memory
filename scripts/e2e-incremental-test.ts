import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncLocalMemory } from "../src/tools/sync.js";
import { supabase } from "../src/supabase.js";

const PROJECT_ID = "__incremental_test__";

function sec(label: string) {
  console.log(`\n=== ${label} ===`);
}

const dir = await mkdtemp(join(tmpdir(), "claude-mem-inc-"));
const fA = join(dir, "a.md");
const fB = join(dir, "b.md");
const fC = join(dir, "c.md");

try {
  await writeFile(fA, "# Alpha\nInitial alpha content.\n", "utf8");
  await writeFile(fB, "# Bravo\nInitial bravo content.\n", "utf8");
  await writeFile(fC, "# Charlie\nInitial charlie content.\n", "utf8");

  sec("1. Cold sync (3 new files)");
  const r1 = await syncLocalMemory({ roots: [dir], project_id: PROJECT_ID });
  console.log(r1);
  if (r1.added !== 3 || r1.skipped !== 0 || r1.updated !== 0) throw new Error("cold sync counters wrong");

  sec("2. Rerun unchanged (everything should skip)");
  const r2 = await syncLocalMemory({ roots: [dir], project_id: PROJECT_ID });
  console.log(r2);
  if (r2.skipped !== 3 || r2.added !== 0 || r2.updated !== 0 || r2.chunks_upserted !== 0)
    throw new Error("idempotent rerun counters wrong");

  sec("3. Modify one file, add a new file, delete another");
  await writeFile(fA, "# Alpha\nCompletely new content for alpha.\n## Section\nMore text.\n", "utf8");
  const fD = join(dir, "d.md");
  await writeFile(fD, "# Delta\nBrand new file.\n", "utf8");
  await rm(fC);

  const r3 = await syncLocalMemory({ roots: [dir], project_id: PROJECT_ID });
  console.log(r3);
  if (r3.updated !== 1) throw new Error(`expected 1 updated, got ${r3.updated}`);
  if (r3.added !== 1) throw new Error(`expected 1 added, got ${r3.added}`);
  if (r3.skipped !== 1) throw new Error(`expected 1 skipped (b.md), got ${r3.skipped}`);
  if (r3.orphans !== 1 || !r3.orphan_files[0]?.endsWith("c.md"))
    throw new Error(`orphan detection failed: ${JSON.stringify(r3.orphan_files)}`);

  sec("4. Force flag re-embeds everything");
  const r4 = await syncLocalMemory({ roots: [dir], project_id: PROJECT_ID, force: true });
  console.log(r4);
  if (r4.force !== true) throw new Error("force flag not echoed");
  if (r4.updated + r4.added !== 3) throw new Error("force didn't re-embed all 3 current files");
  if (r4.skipped !== 0) throw new Error("force should skip nothing");
  // All 3 files already existed in DB, so force should classify them as updated, not added,
  // and must have deleted stale chunks before re-inserting.
  if (r4.updated !== 3) throw new Error(`force should mark pre-existing files as updated, got updated=${r4.updated}`);
  if (r4.chunks_deleted < 3) throw new Error(`force should delete prior chunks, got ${r4.chunks_deleted}`);

  sec("5. Verify row shape (file_hash populated, one hash per file)");
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("file_origin, file_hash, chunk_index")
    .eq("project_id", PROJECT_ID);
  if (error) throw error;
  console.log(`rows: ${data.length}`);
  const perFile = new Map<string, Set<string>>();
  for (const r of data) {
    if (!perFile.has(r.file_origin)) perFile.set(r.file_origin, new Set());
    perFile.get(r.file_origin)!.add(r.file_hash);
  }
  for (const [f, hashes] of perFile) {
    console.log(`  ${f.split(/[\\/]/).pop()} -> ${hashes.size} hash(es), ${data.filter(x => x.file_origin === f).length} chunk(s)`);
    if (hashes.size !== 1) throw new Error(`file ${f} has ${hashes.size} different file_hash values — should be 1`);
  }

  console.log("\nALL ASSERTIONS PASSED");
} finally {
  await supabase.from("memory_chunks").delete().eq("project_id", PROJECT_ID);
  await rm(dir, { recursive: true, force: true });
  console.log("cleaned.");
}
