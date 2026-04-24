import { syncLocalMemory } from "../src/tools/sync.js";

const SAMIA_RULES = "C:/Users/saeee/Downloads/Samia-Tarot - Cowork/.claude/rules";
const PROJECT_ID = "samia-tarot-cowork";

const mode = process.argv[2] ?? "dry";

if (mode !== "dry" && mode !== "commit") {
  console.error("Usage: purge-samia-rules.ts [dry|commit]");
  process.exit(1);
}

const result = await syncLocalMemory({
  roots: [SAMIA_RULES],
  project_id: PROJECT_ID,
  auto_purge: true,
  confirm: mode === "commit",
});

console.log(JSON.stringify(result, null, 2));
