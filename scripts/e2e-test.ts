import "dotenv/config";
import { embed } from "../src/ollama.js";
import { upsertChunks, searchChunks, supabase } from "../src/supabase.js";

console.log("1. Verifying memory_chunks table is reachable...");
const { count, error: countErr } = await supabase
  .from("memory_chunks")
  .select("*", { count: "exact", head: true });
if (countErr) {
  console.error("REST access failed:", countErr.message);
  process.exit(1);
}
console.log("   rows before test:", count);

console.log("2. Embedding sample content...");
const samples = [
  "User prefers TypeScript strict mode and refuses `any`.",
  "Always run migrations via scripts/apply-schema.ts, never manually.",
  "Backups live in the backups/ folder and are gitignored.",
];
const vectors = await embed(samples);
console.log("   vectors:", vectors.length, "dim:", vectors[0].length);

console.log("3. Upserting 3 test chunks...");
const { count: inserted } = await upsertChunks(
  samples.map((content, i) => ({
    content,
    file_origin: "__e2e_test__.md",
    chunk_index: i,
    embedding: vectors[i],
    metadata: { test: true },
  })),
);
console.log("   upserted:", inserted);

console.log("4. Semantic search for 'what language style does the user want?'...");
const [q] = await embed(["what language style does the user want?"]);
const results = await searchChunks(q, 3);
for (const r of results) {
  console.log(`   [sim=${r.similarity.toFixed(3)}] ${r.content.slice(0, 70)}...`);
}

console.log("5. Cleaning up test rows...");
const { error: delErr } = await supabase
  .from("memory_chunks")
  .delete()
  .eq("file_origin", "__e2e_test__.md");
if (delErr) console.error("   cleanup failed:", delErr.message);
else console.log("   cleaned.");

console.log("ALL GOOD");
