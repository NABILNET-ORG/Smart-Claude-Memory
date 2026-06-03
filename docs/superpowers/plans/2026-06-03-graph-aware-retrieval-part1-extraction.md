# Graph-Aware Retrieval — Implementation Plan (Part 1 of 2: Deterministic Extraction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the garbage-producing graph extractor with a deterministic, pure-heuristic pipeline (sanitize → typed producers → denylist), and purge nodes already poisoned in the DB — the foundation the re-ranker (Part 2) depends on.

**Architecture:** Two chokepoints make the fix robust to whichever producers exist today: **sanitize at the INPUT** (strip code/mermaid/HTML/tables/blockquotes) and a **denylist at the OUTPUT** (drop structural fragments). A one-off `pg` script purges existing garbage (edges cascade via FK). No LLM, no embeddings inside the extractor (spec §3, Boundary Invariant #1).

**Tech Stack:** TypeScript (ESM — `type:"module"`, every relative import ends in `.js`), `node:test` + `node:assert/strict`, `tsx`, `pg` for the script, Supabase RPCs `kg_upsert_node`/`kg_upsert_edge`.

**Spec:** [2026-06-03-graph-aware-retrieval-design.md](../specs/2026-06-03-graph-aware-retrieval-design.md) (§4 Extraction, §3 BI-1).

---

## File Structure

- **Create** `src/graph/sanitize.ts` — pure `sanitizeForExtraction()` + `isGarbageLabel()` + shared SQL regex. Single responsibility: text hygiene. Imported by both the extractor and the purge script (DRY).
- **Modify** `src/graph/extractor.ts` — route producer input through sanitize; filter output through the denylist; add a `SYMBOL` producer for backticked identifiers.
- **Create** `scripts/purge-graph-nodes.ts` — one-off DB purge (dry-run by default), mirrors `scripts/backfill-ledger.ts`.
- **Create** `tests/graph-sanitize.test.ts`, `tests/graph-purge-predicate.test.ts`; **extend** `tests/graph-extractor.test.ts`.
- **Modify** `package.json` — append each new test file to the `test` script list (node:test only runs explicitly-listed files — CI greens without them otherwise).

---

### Task 1: Pure sanitizer + denylist

**Files:**
- Create: `src/graph/sanitize.ts`
- Test: `tests/graph-sanitize.test.ts`
- Modify: `package.json` (test list)

- [ ] **Step 1: Write the failing test**

```ts
// tests/graph-sanitize.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForExtraction, isGarbageLabel } from "../src/graph/sanitize.js";

describe("sanitizeForExtraction", () => {
  it("strips fenced/mermaid blocks and tables, keeps prose identifiers", () => {
    const input = [
      "See `gate.ts` for budgets.",
      "```mermaid",
      "graph TD; n161 --> n162",
      "```",
      "| col | col |",
      "|-----|-----|",
      "> quoted n999 --> x",
    ].join("\n");
    const out = sanitizeForExtraction(input);
    assert.ok(out.includes("gate.ts"), "keeps real file ref");
    assert.ok(!out.includes("n161"), "drops mermaid node id");
    assert.ok(!out.includes("-->"), "drops mermaid arrows");
    assert.ok(!out.includes("|-----|"), "drops table delimiter");
  });
});

describe("isGarbageLabel", () => {
  it("rejects structural fragments, accepts real entities", () => {
    for (const bad of ["n161", "-->", "s\"]", "TD", "x", "subgraph"]) {
      assert.equal(isGarbageLabel(bad), true, `should reject: ${bad}`);
    }
    for (const ok of ["gate.ts", "search_memory", "SCM-S16-D1", "Knowledge Graph"]) {
      assert.equal(isGarbageLabel(ok), false, `should accept: ${ok}`);
    }
  });
});
```

- [ ] **Step 2: Register the test file, run it, verify it fails**

Append `tests/graph-sanitize.test.ts` to the space-separated file list in the `"test"` script of `package.json`.
Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-sanitize.test.ts`
Expected: FAIL — `Cannot find module '../src/graph/sanitize.js'`.

- [ ] **Step 3: Implement `src/graph/sanitize.ts`**

```ts
// src/graph/sanitize.ts — pure, no I/O, no LLM (Boundary Invariant #1)
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const HTML_RE = /<[^>]+>/g;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{3,}/;
const MERMAID_LINE_RE = /-->|==>|\bgraph\s+(?:TD|LR|TB|RL|BT)\b|\bsubgraph\b/i;

/** Strip non-prose syntax so producers never see mermaid/code/table fragments. */
export function sanitizeForExtraction(content: string): string {
  const noBlocks = content.replace(FENCE_RE, " ").replace(HTML_RE, " ");
  return noBlocks
    .split("\n")
    .filter((l) => !TABLE_DELIM_RE.test(l))
    .filter((l) => !MERMAID_LINE_RE.test(l))
    .map((l) => l.replace(/^\s*>+\s?/, "")) // strip blockquote markers
    .join("\n");
}

// Shared by the TS extractor and the SQL purge script (kept in lockstep).
const STRUCTURAL_DENYLIST =
  /^(?:graph|subgraph|td|lr|tb|rl|bt|end|click|style|classdef|n\d+)$|-->|==>|["'\]\[]/i;

/** True when a produced label is a structural fragment, not a real entity. */
export function isGarbageLabel(label: string): boolean {
  const t = label.trim();
  return t.length < 3 || STRUCTURAL_DENYLIST.test(t);
}

// Postgres-flavored mirror of STRUCTURAL_DENYLIST for the purge script (Task 3).
export const GARBAGE_SQL_REGEX =
  "^(graph|subgraph|td|lr|tb|rl|bt|end|click|style|classdef|n[0-9]+)$|-->|==>|[\"'\\]\\[]";

/** JS-side parity check used by the purge predicate test. */
export function matchesGarbageSql(label: string): boolean {
  const t = label.trim();
  return t.length < 3 || new RegExp(GARBAGE_SQL_REGEX, "i").test(t);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-sanitize.test.ts`
Expected: PASS (both `describe` blocks).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc
git add src/graph/sanitize.ts tests/graph-sanitize.test.ts package.json
git commit -m "feat(graph): pure sanitizer + denylist for entity extraction"
```

---

### Task 2: Wire sanitize + denylist into the extractor

**Files:**
- Modify: `src/graph/extractor.ts` (`extractFromChunk`, ~L97–147)
- Test: extend `tests/graph-extractor.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/graph-extractor.test.ts`)

```ts
import { extractFromChunk } from "../src/graph/extractor.js";

describe("extractFromChunk — garbage rejection (SCM-S50-D1)", () => {
  it("emits real entities and zero mermaid/code fragments", () => {
    const chunk = {
      id: 4242,
      content: [
        "The `search_memory` tool reads `src/tools/search.ts`. See SCM-S16-D1.",
        "```mermaid",
        "graph TD; n161 --> n162",
        "```",
      ].join("\n"),
      metadata: { type: "DECISION" },
      embedding: null,
    };
    const { nodes } = extractFromChunk(chunk as any);
    const labels = nodes.map((n) => n.label);
    assert.ok(labels.includes("src/tools/search.ts"), "keeps file ref");
    assert.ok(labels.includes("SCM-S16-D1"), "keeps decision id");
    assert.ok(!labels.some((l) => /n161|-->|^TD$/.test(l)), "no fragments");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-extractor.test.ts --test-name-pattern="garbage rejection"`
Expected: FAIL — the current extractor emits `n161`/arrow fragments from inside the mermaid block.

- [ ] **Step 3: Implement the two chokepoints in `extractFromChunk`**

Read `src/graph/extractor.ts` first. Apply exactly these edits:

1. Add the import at the top of the file:
```ts
import { sanitizeForExtraction, isGarbageLabel } from "./sanitize.js";
```
2. Inside `extractFromChunk`, immediately after the existing skip checks (`metadata.type === "LOG"` / `content.length < 20`), derive a sanitized copy and make **every** producer scan it instead of `chunk.content`:
```ts
const text = sanitizeForExtraction(chunk.content);
// Replace each `chunk.content.matchAll(...)` / `chunk.content` read in the
// producer section with `text.matchAll(...)` / `text`.
```
3. Wherever a candidate `label` is pushed onto `nodes` (and in the edge loop), gate it through the denylist so no fragment survives and no edge references a dropped label:
```ts
if (isGarbageLabel(label)) continue;
```

The fix is robust regardless of how many producers exist: sanitize is the single INPUT chokepoint, `isGarbageLabel` the single OUTPUT chokepoint.

- [ ] **Step 4: Run, verify it passes**

Run the pattern test → PASS. Then the whole file: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-extractor.test.ts` → all PASS (no regressions in existing cases).

- [ ] **Step 5: Boundary check, typecheck, commit**

```bash
npx tsx scripts/lint-boundaries.ts   # BI-1: confirms no LLM import entered src/graph/**
npx tsc
git add src/graph/extractor.ts tests/graph-extractor.test.ts
git commit -m "fix(graph): sanitize input + denylist output in extractFromChunk"
```

---

### Task 3: Extract backticked code symbols (SYMBOL nodes)

**Files:**
- Modify: `src/graph/extractor.ts` (add a SYMBOL producer)
- Test: extend `tests/graph-extractor.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/graph-extractor.test.ts`)

```ts
describe("extractFromChunk — SYMBOL producer", () => {
  it("extracts backticked identifiers as SYMBOL nodes, defers files/decisions", () => {
    const chunk = {
      id: 7,
      content: "Call `search_memory` and `kgHybridSearch`; see `gate.ts` and `SCM-S16-D1`.",
      metadata: { type: "NOTE" },
      embedding: null,
    };
    const { nodes } = extractFromChunk(chunk as any);
    const symbols = nodes.filter((n) => n.type === "SYMBOL").map((n) => n.label);
    assert.ok(symbols.includes("search_memory"), "extracts snake_case symbol");
    assert.ok(symbols.includes("kgHybridSearch"), "extracts camelCase symbol");
    assert.ok(!symbols.includes("gate.ts"), "defers file ref to FILE producer");
    assert.ok(!symbols.includes("SCM-S16-D1"), "defers decision id to DECISION producer");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-extractor.test.ts --test-name-pattern="SYMBOL producer"`
Expected: FAIL — no SYMBOL nodes are produced yet.

- [ ] **Step 3: Add the SYMBOL producer to `extractFromChunk`**

After the sanitize step (`const text = sanitizeForExtraction(chunk.content)`), scan backticked spans on the sanitized text. Use the same `nodes.push({...})` object shape already used in the file (`ExtractedNode`):

```ts
const BACKTICK_RE = /`([^`]+)`/g;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?:\(\))?$/;
const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|sql|md|py|json)$/i;
const DECISION_LABEL_RE = /^SCM-S\d+-D\d+$/;

for (const m of text.matchAll(BACKTICK_RE)) {
  const label = m[1].trim().replace(/\(\)$/, "");
  if (!IDENTIFIER_RE.test(label)) continue;     // not identifier-shaped
  if (FILE_EXT_RE.test(label)) continue;        // defer to FILE producer
  if (DECISION_LABEL_RE.test(label)) continue;  // defer to DECISION producer
  if (isGarbageLabel(label)) continue;          // denylist guard
  nodes.push({ type: "SYMBOL", label, properties: {}, source_chunk_id: chunk.id });
}
```

- [ ] **Step 4: Run, verify it passes**

Run the pattern test → PASS. Then the whole file → PASS (no regression in Task 2's garbage-rejection test).

- [ ] **Step 5: Boundary check, typecheck, commit**

```bash
npx tsx scripts/lint-boundaries.ts
npx tsc
git add src/graph/extractor.ts tests/graph-extractor.test.ts
git commit -m "feat(graph): SYMBOL producer for backticked code identifiers"
```

---

### Task 4: One-off purge of poisoned nodes

**Files:**
- Create: `scripts/purge-graph-nodes.ts`
- Test: `tests/graph-purge-predicate.test.ts`
- Modify: `package.json` (test list)

- [ ] **Step 1: Write the failing test** (SQL regex must flag the same garbage as `isGarbageLabel`)

```ts
// tests/graph-purge-predicate.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesGarbageSql, isGarbageLabel } from "../src/graph/sanitize.js";

describe("purge predicate parity", () => {
  it("SQL mirror agrees with isGarbageLabel on representative cases", () => {
    for (const bad of ["n161", "-->", "TD", "ab"]) {
      assert.equal(matchesGarbageSql(bad), true, `garbage: ${bad}`);
      assert.equal(isGarbageLabel(bad), true, `garbage: ${bad}`);
    }
    for (const ok of ["gate.ts", "search_memory", "SCM-S16-D1"]) {
      assert.equal(matchesGarbageSql(ok), false, `entity: ${ok}`);
      assert.equal(isGarbageLabel(ok), false, `entity: ${ok}`);
    }
  });
});
```

- [ ] **Step 2: Register the test file, run, verify it passes immediately**

`matchesGarbageSql` already exists from Task 1. Append the file to the `test` list.
Run: `node --import tsx --experimental-test-module-mocks --no-warnings --test tests/graph-purge-predicate.test.ts`
Expected: PASS (this task's risk is the script, not the predicate — the test locks parity so the SQL can't drift from the TS).

- [ ] **Step 3: Implement `scripts/purge-graph-nodes.ts`** (mirror `scripts/backfill-ledger.ts`)

```ts
// scripts/purge-graph-nodes.ts — one-off; DRY-RUN unless --commit is passed.
import "dotenv/config";
import { Client } from "pg";
import { GARBAGE_SQL_REGEX } from "../src/graph/sanitize.js";

const COMMIT = process.argv.includes("--commit");
const WHERE = `length(label) < 3 OR label ~* $1`;

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_POOLER_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM kg_nodes WHERE ${WHERE}`,
      [GARBAGE_SQL_REGEX],
    );
    console.log(`[purge] ${rows[0].n} garbage node(s) match (edges cascade on delete).`);
    if (COMMIT) {
      const res = await client.query(`DELETE FROM kg_nodes WHERE ${WHERE}`, [GARBAGE_SQL_REGEX]);
      console.log(`[purge] deleted ${res.rowCount} node(s).`);
    } else {
      console.log("[purge] DRY RUN — re-run with --commit to delete.");
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Verify (dry-run) + commit**

```bash
npx tsc
npx tsx scripts/purge-graph-nodes.ts          # dry run: prints match count, deletes nothing
git add scripts/purge-graph-nodes.ts tests/graph-purge-predicate.test.ts package.json
git commit -m "feat(graph): one-off purge script for poisoned kg_nodes (dry-run default)"
```

> **Operational note (spec §9.2):** after Tasks 1–3 ship, run `npx tsx scripts/purge-graph-nodes.ts --commit` **once** against the live DB to clear historical garbage. The fixed daemon repopulates clean nodes on subsequent ticks.

---

**Part 1 complete →** clean extraction in place, DB purged. Proceed to **Part 2 (Re-rank + Eval)**, which consumes the now-trustworthy graph.
