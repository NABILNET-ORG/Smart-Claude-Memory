import { embed } from "../src/ollama.js";
import { upsertChunks, searchChunks, supabase } from "../src/supabase.js";

const PROJ_A = "__test_proj_a__";
const PROJ_B = "__test_proj_b__";

const aContent = [
  "Project A secret: the squid is purple.",
  "Project A uses Python and postgres.",
];
const bContent = [
  "Project B secret: the falcon is silver.",
  "Project B uses Rust and sqlite.",
];

const vecsA = await embed(aContent);
const vecsB = await embed(bContent);

await upsertChunks(
  PROJ_A,
  aContent.map((content, i) => ({
    content,
    file_origin: "notes.md",
    chunk_index: i,
    embedding: vecsA[i],
  })),
);
await upsertChunks(
  PROJ_B,
  bContent.map((content, i) => ({
    content,
    file_origin: "notes.md",
    chunk_index: i,
    embedding: vecsB[i],
  })),
);
console.log("seeded A and B");

const [qAnimal] = await embed(["what animal is mentioned?"]);
const [qLang] = await embed(["what programming language?"]);

const inA_animal = await searchChunks(PROJ_A, qAnimal, 5);
const inB_animal = await searchChunks(PROJ_B, qAnimal, 5);
const inA_lang = await searchChunks(PROJ_A, qLang, 5);
const inB_lang = await searchChunks(PROJ_B, qLang, 5);

const aLeakedToB = inB_animal.some((r) => r.content.includes("squid") || r.content.includes("Python"));
const bLeakedToA = inA_animal.some((r) => r.content.includes("falcon") || r.content.includes("Rust"));

console.log("\nA.animal top:", inA_animal[0]?.content);
console.log("B.animal top:", inB_animal[0]?.content);
console.log("A.lang   top:", inA_lang[0]?.content);
console.log("B.lang   top:", inB_lang[0]?.content);
console.log("\nA leaked into B?", aLeakedToB);
console.log("B leaked into A?", bLeakedToA);

await supabase.from("memory_chunks").delete().in("project_id", [PROJ_A, PROJ_B]);
console.log("cleaned up.");

if (aLeakedToB || bLeakedToA) {
  console.error("ISOLATION FAILED");
  process.exit(1);
}
console.log("\nISOLATION PASSED ✓");
