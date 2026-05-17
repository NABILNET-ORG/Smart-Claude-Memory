# M4 Checkpoints Phase B — Verification & Test Coverage Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the already-shipped M4 Phase B (Transactional Workflow Checkpoints) with a real test suite + live-Supabase smoke script, so the 4 MCP tools (`checkpoint_create` / `_commit` / `_rollback` / `_list`) ship with the confidence the agent needs to use them as Save Game / Rollback primitives without fear of silent data corruption.

**Architecture:** Black-box characterization tests at the handler boundary (`src/tools/checkpoint.ts`), hitting live Supabase under a unique per-suite `project_id` namespace so cleanup is exhaustive and deterministic. The handlers already wrap the pure service layer in `src/transactions/checkpoint.ts` — we test the wrappers (not the service) because the wrappers add the MCP-shaped envelope, the `cloud_backlog.metadata.checkpoint_root_id` stamp, the `[M4] rollback_signal` operational log, and the zod input validation surface that the LLM will actually call against. One end-to-end smoke script (`scripts/smoke-m4.ts`) exercises the full create→commit→rollback→list lifecycle against live infra and prints PASS/FAIL.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict` (loaded via `tsx --import` per `package.json` test script), Supabase JS client (service-role key, already configured in `src/supabase.ts`), zod for input validation.

---

## ⚠ Mission Scope Pivot (read before starting)

The original Session 30 mission framed this Epic as **build** the 4 MCP tools. Discovery during planning (Session 30, after the M4 research dispatch) proved the tools are **already shipped**:

| Artifact | Status | Evidence |
|---|---|---|
| `src/tools/checkpoint.ts` | **Production code, 385 lines** | Reads imports `openCheckpoint`/`commitCheckpoint`/`rollbackCheckpoint`/`listCheckpoints` from `../transactions/checkpoint.js`; all 4 `*Handler` + `*InputShape` symbols exported (lines 47–385); helper `stampCheckpointRootIdOnBacklog` at lines 116–168 implements the M2→M3 provenance link; header comment line 22 asserts "Zero `any`, zero TODO, zero placeholders". |
| `src/index.ts` MCP wiring | **All 4 `server.tool()` calls live** | Imports lines 51–59; `server.tool(...)` registrations lines 388–430, each with a rich human-readable description. |
| `scripts/014_workflow_checkpoints.sql` | **Migration applied** | `init_project.migrations` reports 0 pending, 18/18 applied. |
| `tests/checkpoint.test.ts` | **DOES NOT EXIST** | `ls tests/` shows: capabilities, health, list-global-patterns, migrations, orchestrator, trajectory-{daemon,stripper,summarizer} — no checkpoint test. |
| `scripts/smoke-m4.ts` | **DOES NOT EXIST** | `ls scripts/smoke-*.ts` shows: smoke-008, smoke-010, smoke-012, smoke-m5 — no M4 smoke. |

**Therefore Phase B does not need to be built — it needs to be _verified_.** This plan delivers the verification surface: a characterization test suite + a live smoke script + a one-line docs status flip. If any test surfaces a real bug in the handler bodies, that becomes a separate fix commit (No Entangled Commits — see CLAUDE.md "Foundation First").

If the user approves this scope pivot but ALSO wants e.g. a perf benchmark or a parent-chain depth limit, append those as additional Tasks 20+ before kickoff.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `tests/checkpoint.test.ts` | **CREATE** | Sole test file for all 4 handlers + the stamp helper. ~15 tests organized into 4 `describe` blocks (one per handler) + a 5th block for the stamp helper. ~350–450 lines including fixtures. |
| `tests/fixtures/m4.ts` | **CREATE** | Per-test setup/teardown helpers: `uniqueProjectId()`, `insertThrowawayChunk(projectId)`, `insertThrowawayBacklogRow(projectId)`, `cleanupProject(projectId)`. ~80 lines. Keeps `checkpoint.test.ts` free of plumbing. |
| `scripts/smoke-m4.ts` | **CREATE** | Live end-to-end create→commit→rollback→list round-trip. Prints `[M4-SMOKE] PASS` or `[M4-SMOKE] FAIL: <reason>` and exits 0/1. Mirrors structure of `scripts/smoke-m5.ts`. ~120 lines. |
| `package.json` | **MODIFY** | Add `"smoke:m4": "tsx scripts/smoke-m4.ts"` next to existing smoke scripts. |
| `ARCHITECTURE.md` | **MODIFY** | M4 section: flip Phase B status from "(planned)" / "(scaffold)" to **"production-validated (test coverage Session 30)"**. One line change. |
| `src/tools/checkpoint.ts` | **DO NOT TOUCH** | Read-only reference during testing. Any bug found = separate fix commit. |
| `src/transactions/checkpoint.ts` | **DO NOT TOUCH** | Same. |

---

## Read-First References (per task)

Every task below assumes the implementer has read or will read:
- `src/tools/checkpoint.ts` (full file — the contract under test)
- `src/transactions/checkpoint.ts` (full file — the service layer, knows the SQL)
- `scripts/014_workflow_checkpoints.sql` (table schema, constraints, RLS)
- `tests/orchestrator.test.ts` (existing test pattern with live Supabase)
- `scripts/smoke-m5.ts` (smoke script template)

Read those once before Task 1, not per-task.

---

## Task 1: Audit handler bodies against the service contract (read-only)

**Files:**
- Read: `src/tools/checkpoint.ts`
- Read: `src/transactions/checkpoint.ts`
- Read: `scripts/014_workflow_checkpoints.sql`

- [ ] **Step 1: Skim `src/tools/checkpoint.ts:170-207`** — confirm `checkpointCreateHandler` calls `openCheckpoint({projectId, skillId, stepIndex, stepLabel, parentId})` and conditionally calls `stampCheckpointRootIdOnBacklog(projectId, backlog_task_id, opened.id)` only when `parentId === null && parsed.backlog_task_id !== undefined`.

- [ ] **Step 2: Skim `src/tools/checkpoint.ts:241-258`** — confirm `checkpointCommitHandler` is a thin pass-through to `commitCheckpoint({projectId, checkpointId, sourceChunkId})` returning `{checkpoint_id, status:"committed", source_chunk_id}`.

- [ ] **Step 3: Skim `src/tools/checkpoint.ts:294-326`** — confirm `checkpointRollbackHandler` calls `rollbackCheckpoint`, emits `console.log("[M4] rollback_signal: ...")`, and returns `{checkpoint_id, status:"rolledback", restored_from: {checkpoint_id, source_chunk_id} | null}`.

- [ ] **Step 4: Skim `src/tools/checkpoint.ts:367-385`** — confirm `checkpointListHandler` clamps `limit` via zod (max 100, default 20) and passes `{projectId, status, skillId, limit}` to `listCheckpoints`.

- [ ] **Step 5: Read `scripts/014_workflow_checkpoints.sql` end-to-end** — note the `status CHECK (status IN ('open','committed','rolledback'))` constraint, the `source_chunk_id` FK to `memory_chunks(id) ON DELETE SET NULL`, and the `parent_id` self-FK. The test suite must respect these.

- [ ] **Step 6: Write an audit note to scratch (no commit)** — one paragraph in your scratchpad: "Handlers match the documented contract. No bug surfaced by reading. Test surface = inputs × DB state × side effects (cloud_backlog stamp + structured log)." If reading surfaces a real bug, STOP this plan and surface it to the Orchestrator instead of writing tests around buggy code.

---

## Task 2: Create fixture module `tests/fixtures/m4.ts`

**Files:**
- Create: `tests/fixtures/m4.ts`

- [ ] **Step 1: Create the file with this exact content**

```typescript
// Per-test setup/teardown for M4 checkpoint tests.
// Every test creates rows under a unique project_id namespace so cleanup is
// exhaustive: a single DELETE on that project_id wipes ALL test artefacts.

import { randomUUID } from "node:crypto";
import { supabase } from "../../src/supabase.js";

export function uniqueProjectId(): string {
  return `__test_m4_${randomUUID().slice(0, 8)}__`;
}

// memory_chunks.embedding is vector(768) NOT NULL (verified via Session 30
// smoke). We don't need a real embedding for these tests — use a zero vector.
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

export async function insertThrowawayChunk(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__m4_test__",
      chunk_index: 0,
      content: "m4-test-chunk",
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayChunk failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export async function insertThrowawayBacklogRow(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .insert({
      project_id: projectId,
      title: "__m4_test_task__",
      status: "todo",
      metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayBacklogRow failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: workflow_checkpoints first (it FKs to memory_chunks via
  // source_chunk_id), then cloud_backlog, then memory_chunks.
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit fixtures only**

```bash
git add tests/fixtures/m4.ts
git commit -m "test(m4): add fixtures for live-Supabase checkpoint tests"
```

> **Pre-commit gate:** If `memory_chunks` or `cloud_backlog` insert errors out due to a column you don't have permission for or that doesn't exist in this schema, STOP and surface — the fixture assumes the schemas observed in 014 + earlier migrations. Inspect the live table with `select column_name from information_schema.columns where table_name = '...'` if unsure.

---

## Task 3: Test scaffolding in `tests/checkpoint.test.ts`

**Files:**
- Create: `tests/checkpoint.test.ts`

- [ ] **Step 1: Create the skeleton**

```typescript
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointCreateHandler,
  checkpointCommitHandler,
  checkpointRollbackHandler,
  checkpointListHandler,
} from "../src/tools/checkpoint.js";
import {
  uniqueProjectId,
  insertThrowawayChunk,
  insertThrowawayBacklogRow,
  cleanupProject,
} from "./fixtures/m4.js";

// All tests share ONE project_id per `describe` block — cleanup runs once
// in `after`. This keeps fixture costs low (one chunk per block) while still
// guaranteeing zero cross-test bleed.

describe("M4 checkpoint_create handler", () => {
  // body filled in by Tasks 4–8
});

describe("M4 checkpoint_commit handler", () => {
  // Tasks 9–10
});

describe("M4 checkpoint_rollback handler", () => {
  // Tasks 11–12
});

describe("M4 checkpoint_list handler", () => {
  // Tasks 13–16
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run the test suite (empty blocks should pass)**

Run: `npm test -- tests/checkpoint.test.ts`
Expected: 4 empty `describe` blocks reported, 0 failures. If the test runner globs differently, fall back to `npx tsx --test tests/checkpoint.test.ts`.

- [ ] **Step 4: Commit scaffolding**

```bash
git add tests/checkpoint.test.ts
git commit -m "test(m4): scaffold checkpoint handler test suite"
```

---

## Task 4: `checkpoint_create` — root checkpoint, no parent, no backlog

**Files:**
- Modify: `tests/checkpoint.test.ts` (fill `describe("M4 checkpoint_create handler", ...)`)

- [ ] **Step 1: Add the per-block setup/teardown inside the describe**

```typescript
const projectId = uniqueProjectId();
after(async () => { await cleanupProject(projectId); });
```

- [ ] **Step 2: Add the failing test**

```typescript
test("root checkpoint returns {checkpoint_id, status:'open', backlog_stamped:false}", async () => {
  const r = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "root-step",
  });
  assert.equal(typeof r.checkpoint_id, "number");
  assert.ok(r.checkpoint_id > 0);
  assert.equal(r.status, "open");
  assert.equal(r.backlog_stamped, false);
});
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/checkpoint.test.ts`
Expected: PASS (handler exists). If FAIL, the failure surfaces either an env/permission problem or a real production bug — STOP and diagnose with `superpowers:systematic-debugging` before continuing.

- [ ] **Step 4: Do NOT commit yet** — batch with Tasks 5–8 in one create-handler commit.

---

## Task 5: `checkpoint_create` — child checkpoint with parent_id

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test (after Task 4's test, inside the same describe)**

```typescript
test("child checkpoint chains via parent_id and stays unstamped", async () => {
  const root = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "root-for-chain",
  });
  const child = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "child-step",
    step_index: 1,
    parent_id: root.checkpoint_id,
  });
  assert.notEqual(child.checkpoint_id, root.checkpoint_id);
  assert.equal(child.status, "open");
  assert.equal(child.backlog_stamped, false);
});
```

- [ ] **Step 2: Run** — `npm test -- tests/checkpoint.test.ts` → Expected: PASS.

---

## Task 6: `checkpoint_create` — root + backlog_task_id stamps cloud_backlog.metadata

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("root + backlog_task_id stamps cloud_backlog.metadata.checkpoint_root_id", async () => {
  const backlogId = await insertThrowawayBacklogRow(projectId);
  const r = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "root-with-backlog",
    backlog_task_id: backlogId,
  });
  assert.equal(r.backlog_stamped, true);

  // Verify the metadata was actually written.
  const { supabase } = await import("../src/supabase.js");
  const { data, error } = await supabase
    .from("cloud_backlog")
    .select("metadata")
    .eq("id", backlogId)
    .single();
  assert.equal(error, null);
  assert.equal((data?.metadata as { checkpoint_root_id?: number })?.checkpoint_root_id, r.checkpoint_id);
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 7: `checkpoint_create` — child + backlog_task_id is NOT stamped (defensive)

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("child + backlog_task_id does NOT stamp (would break the join)", async () => {
  const backlogId = await insertThrowawayBacklogRow(projectId);
  const root = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "root-for-defensive",
  });
  const child = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "child-with-backlog",
    parent_id: root.checkpoint_id,
    backlog_task_id: backlogId,
  });
  assert.equal(child.backlog_stamped, false);
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 8: `checkpoint_create` — invalid step_label rejected by zod

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("empty step_label is rejected by zod", async () => {
  await assert.rejects(
    () => checkpointCreateHandler({ project_id: projectId, step_label: "" }),
    /step_label|String must contain at least 1/,
  );
});
```

- [ ] **Step 2: Run** → Expected: PASS.

- [ ] **Step 3: Commit all 5 create-handler tests**

```bash
git add tests/checkpoint.test.ts
git commit -m "test(m4): characterize checkpoint_create — root, chain, stamp, defensive, validation"
```

---

## Task 9: `checkpoint_commit` — happy path open → committed

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add describe-block setup + happy-path test**

```typescript
describe("M4 checkpoint_commit handler", () => {
  const projectId = uniqueProjectId();
  let chunkId: number;
  before(async () => { chunkId = await insertThrowawayChunk(projectId); });
  after(async () => { await cleanupProject(projectId); });

  test("open → committed pins source_chunk_id", async () => {
    const opened = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "to-commit",
    });
    const r = await checkpointCommitHandler({
      project_id: projectId,
      checkpoint_id: opened.checkpoint_id,
      source_chunk_id: chunkId,
    });
    assert.equal(r.checkpoint_id, opened.checkpoint_id);
    assert.equal(r.status, "committed");
    assert.equal(r.source_chunk_id, chunkId);
  });
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 10: `checkpoint_commit` — re-commit rejects (status guard)

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test (inside the same commit describe)**

```typescript
test("re-committing an already-committed checkpoint throws [M4]", async () => {
  const opened = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "to-double-commit",
  });
  await checkpointCommitHandler({
    project_id: projectId,
    checkpoint_id: opened.checkpoint_id,
    source_chunk_id: chunkId,
  });
  await assert.rejects(
    () =>
      checkpointCommitHandler({
        project_id: projectId,
        checkpoint_id: opened.checkpoint_id,
        source_chunk_id: chunkId,
      }),
    /\[M4\]/,
  );
});
```

- [ ] **Step 2: Run** → Expected: PASS. If the service's error message doesn't include `[M4]`, the assertion's regex needs updating — but the assertion is the contract: every M4 error MUST be `[M4]`-prefixed for grep-ability.

- [ ] **Step 3: Commit commit-handler tests**

```bash
git add tests/checkpoint.test.ts
git commit -m "test(m4): characterize checkpoint_commit — happy path + status guard"
```

---

## Task 11: `checkpoint_rollback` — happy path, no committed ancestor → restored_from null

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add describe-block + first test**

```typescript
describe("M4 checkpoint_rollback handler", () => {
  const projectId = uniqueProjectId();
  let chunkId: number;
  before(async () => { chunkId = await insertThrowawayChunk(projectId); });
  after(async () => { await cleanupProject(projectId); });

  test("rolling back an orphan returns restored_from:null", async () => {
    const opened = await checkpointCreateHandler({
      project_id: projectId,
      step_label: "orphan-to-rollback",
    });
    const r = await checkpointRollbackHandler({
      project_id: projectId,
      checkpoint_id: opened.checkpoint_id,
      reason: "test orphan rollback",
    });
    assert.equal(r.checkpoint_id, opened.checkpoint_id);
    assert.equal(r.status, "rolledback");
    assert.equal(r.restored_from, null);
  });
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 12: `checkpoint_rollback` — walks parent chain to terminal-committed

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the chain-walk test**

```typescript
test("walks parent chain to deepest committed ancestor", async () => {
  // root (committed) → mid (committed) → leaf (open, then rolledback)
  const root = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "root",
  });
  await checkpointCommitHandler({
    project_id: projectId,
    checkpoint_id: root.checkpoint_id,
    source_chunk_id: chunkId,
  });
  const mid = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "mid",
    parent_id: root.checkpoint_id,
    step_index: 1,
  });
  await checkpointCommitHandler({
    project_id: projectId,
    checkpoint_id: mid.checkpoint_id,
    source_chunk_id: chunkId,
  });
  const leaf = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "leaf",
    parent_id: mid.checkpoint_id,
    step_index: 2,
  });

  const r = await checkpointRollbackHandler({
    project_id: projectId,
    checkpoint_id: leaf.checkpoint_id,
    reason: "test chain walk",
  });
  assert.equal(r.status, "rolledback");
  assert.notEqual(r.restored_from, null);
  // The deepest committed ancestor is `mid`, not `root`.
  assert.equal(r.restored_from?.checkpoint_id, mid.checkpoint_id);
  assert.equal(r.restored_from?.source_chunk_id, chunkId);
});
```

- [ ] **Step 2: Run** → Expected: PASS. **If FAIL: this is a real M4 bug** — the rollback's "terminal-committed ancestor" walk is broken. Stop, surface, file a fix commit before continuing.

- [ ] **Step 3: Commit rollback-handler tests**

```bash
git add tests/checkpoint.test.ts
git commit -m "test(m4): characterize checkpoint_rollback — orphan + parent-chain walk"
```

---

## Task 13: `checkpoint_list` — project scoping

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add describe-block + scoping test**

```typescript
describe("M4 checkpoint_list handler", () => {
  const projectId = uniqueProjectId();
  const otherProjectId = uniqueProjectId();
  after(async () => {
    await cleanupProject(projectId);
    await cleanupProject(otherProjectId);
  });

  test("returns only rows scoped to the given project_id", async () => {
    await checkpointCreateHandler({ project_id: projectId, step_label: "mine-1" });
    await checkpointCreateHandler({ project_id: projectId, step_label: "mine-2" });
    await checkpointCreateHandler({ project_id: otherProjectId, step_label: "other" });

    const mine = await checkpointListHandler({ project_id: projectId });
    assert.equal(mine.count, 2);
    assert.ok(mine.checkpoints.every((r) => r.projectId === projectId || (r as { project_id?: string }).project_id === projectId));

    const other = await checkpointListHandler({ project_id: otherProjectId });
    assert.equal(other.count, 1);
  });
});
```

> **Note:** The assertion handles both camelCase (`projectId`) and snake_case (`project_id`) variants because the service may return either shape — confirm against `CheckpointRow` in `src/transactions/checkpoint.ts` and tighten if needed.

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 14: `checkpoint_list` — status filter

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("status filter narrows results", async () => {
  const filterProjectId = uniqueProjectId();
  try {
    const chunkId = await insertThrowawayChunk(filterProjectId);
    const a = await checkpointCreateHandler({ project_id: filterProjectId, step_label: "stay-open" });
    const b = await checkpointCreateHandler({ project_id: filterProjectId, step_label: "to-commit" });
    await checkpointCommitHandler({
      project_id: filterProjectId,
      checkpoint_id: b.checkpoint_id,
      source_chunk_id: chunkId,
    });

    const openOnly = await checkpointListHandler({ project_id: filterProjectId, status: "open" });
    const committedOnly = await checkpointListHandler({ project_id: filterProjectId, status: "committed" });
    assert.equal(openOnly.count, 1);
    assert.equal(committedOnly.count, 1);
    assert.equal(openOnly.checkpoints[0].id, a.checkpoint_id);
    assert.equal(committedOnly.checkpoints[0].id, b.checkpoint_id);
  } finally {
    await cleanupProject(filterProjectId);
  }
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 15: `checkpoint_list` — limit cap + default

**Files:**
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("limit defaults to 20 and caps at 100", async () => {
  const capProjectId = uniqueProjectId();
  try {
    // Insert 25 rows; default limit should clamp to 20.
    for (let i = 0; i < 25; i++) {
      await checkpointCreateHandler({ project_id: capProjectId, step_label: `n${i}` });
    }
    const def = await checkpointListHandler({ project_id: capProjectId });
    assert.equal(def.count, 20);

    const capped = await checkpointListHandler({ project_id: capProjectId, limit: 100 });
    assert.equal(capped.count, 25);

    // limit > 100 should be rejected by zod.
    await assert.rejects(
      () => checkpointListHandler({ project_id: capProjectId, limit: 101 }),
      /less than or equal to 100|max/i,
    );
  } finally {
    await cleanupProject(capProjectId);
  }
});
```

- [ ] **Step 2: Run** → Expected: PASS.

- [ ] **Step 3: Commit list-handler tests**

```bash
git add tests/checkpoint.test.ts
git commit -m "test(m4): characterize checkpoint_list — scoping, status filter, limit clamp"
```

---

## Task 16: Live smoke script `scripts/smoke-m4.ts`

**Files:**
- Create: `scripts/smoke-m4.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Create the smoke script**

```typescript
// scripts/smoke-m4.ts — live end-to-end round-trip for M4 checkpoints.
// Mirrors scripts/smoke-m5.ts structure. Run via `npm run smoke:m4`.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import {
  checkpointCreateHandler,
  checkpointCommitHandler,
  checkpointRollbackHandler,
  checkpointListHandler,
} from "../src/tools/checkpoint.js";

const projectId = `__smoke_m4_${randomUUID().slice(0, 8)}__`;

// memory_chunks.embedding is vector(768) NOT NULL.
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

async function insertChunk(): Promise<number> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__smoke_m4__",
      chunk_index: 0,
      content: "smoke",
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insertChunk: ${error?.message}`);
  return data.id;
}

async function cleanup(): Promise<void> {
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M4-SMOKE] start project=${projectId}`);
  const chunkId = await insertChunk();

  const root = await checkpointCreateHandler({ project_id: projectId, step_label: "smoke-root" });
  console.log(`[M4-SMOKE] created root=${root.checkpoint_id}`);

  await checkpointCommitHandler({
    project_id: projectId,
    checkpoint_id: root.checkpoint_id,
    source_chunk_id: chunkId,
  });
  console.log(`[M4-SMOKE] committed root=${root.checkpoint_id}`);

  const leaf = await checkpointCreateHandler({
    project_id: projectId,
    step_label: "smoke-leaf",
    parent_id: root.checkpoint_id,
    step_index: 1,
  });
  const rb = await checkpointRollbackHandler({
    project_id: projectId,
    checkpoint_id: leaf.checkpoint_id,
    reason: "smoke-test",
  });
  if (rb.restored_from?.checkpoint_id !== root.checkpoint_id) {
    throw new Error(`[M4-SMOKE] FAIL: restored_from expected ${root.checkpoint_id}, got ${rb.restored_from?.checkpoint_id}`);
  }
  console.log(`[M4-SMOKE] rollback walked to root=${rb.restored_from.checkpoint_id}`);

  const listed = await checkpointListHandler({ project_id: projectId });
  if (listed.count !== 2) throw new Error(`[M4-SMOKE] FAIL: expected 2 rows, got ${listed.count}`);

  console.log("[M4-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M4-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
```

- [ ] **Step 2: Add npm script to `package.json`**

Locate the `"scripts"` block (near top of `package.json`) and add this line next to the existing smoke entries (don't touch other entries):

```json
    "smoke:m4": "tsx scripts/smoke-m4.ts",
```

- [ ] **Step 3: Compile-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the smoke script**

Run: `npm run smoke:m4`
Expected: prints `[M4-SMOKE] PASS` and exits 0. If FAIL, the message identifies what diverged.

- [ ] **Step 5: Commit smoke script**

```bash
git add scripts/smoke-m4.ts package.json
git commit -m "test(m4): add live-Supabase smoke script + npm run smoke:m4"
```

---

## Task 17: Full suite + gate

**Files:** None new.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all existing tests + new `tests/checkpoint.test.ts` block green.

- [ ] **Step 2: Run the refactor_guard gate via MCP**

Call: `refactor_guard({ action: "gate", workspace: "<workspace abs path>" })`
Expected: `ok: true`, no compiler errors.

- [ ] **Step 3: Re-run the smoke (fresh DB state)**

Run: `npm run smoke:m4`
Expected: PASS.

- [ ] **Step 4: If anything is red, STOP and diagnose with `superpowers:systematic-debugging`** — do not paper over a failure.

---

## Task 18: Document M4 status in ARCHITECTURE.md

**Files:**
- Modify: `ARCHITECTURE.md` (M4 section header line)

- [ ] **Step 1: Find the M4 section**

Run: `grep -n "M4\|Transactional Workflows\|Phase B" ARCHITECTURE.md | head -10`

Identify the heading line that marks M4 / Phase B status. It will read something like `## M4 — Transactional Workflows` followed by status text.

- [ ] **Step 2: Edit the status line**

Use Edit. Find the existing "Phase B" status text and replace with:

```
**Phase B — MCP tool surface — production-validated (test coverage Session 30: tests/checkpoint.test.ts + scripts/smoke-m4.ts).**
```

If no explicit Phase B status line exists in the M4 section, ADD one immediately under the M4 heading. Do not restructure the section.

- [ ] **Step 3: Commit the doc update**

```bash
git add ARCHITECTURE.md
git commit -m "docs(m4): mark Phase B production-validated"
```

---

## Task 19: Final wrap

**Files:** None new.

- [ ] **Step 1: Run `git status`** — expected: clean working tree.

- [ ] **Step 2: Run `git log --oneline -8`** — expected to see ~6 new commits with `test(m4):` / `docs(m4):` prefixes, no entangled changes.

- [ ] **Step 3: Save a DECISION memory via `save_memory`**

Content: `SCM-S<N>-D<i>: M4 Phase B verified end-to-end. Test coverage in tests/checkpoint.test.ts + scripts/smoke-m4.ts; ARCHITECTURE.md status flipped to production-validated. <N> new tests, all green. No bugs surfaced.`
Metadata: `{ type: "DECISION", status: "verified", session: <N> }`.

- [ ] **Step 4: Return synthesis to Orchestrator** — 2 paragraphs: (1) what shipped (files + commit count), (2) any test that surfaced unexpected behavior (state explicitly "none surfaced" if true). End with `skill_applied: <whatever-skill-you-used>` per the Phase 3 contract.

---

## Test Strategy Summary

| Tool | Tests | Lines (approx) | Live infra needed |
|---|---|---|---|
| `checkpoint_create` | 5 (root, chain, stamp, defensive, validation) | ~80 | workflow_checkpoints, cloud_backlog |
| `checkpoint_commit` | 2 (happy, re-commit guard) | ~50 | + memory_chunks |
| `checkpoint_rollback` | 2 (orphan, chain walk) | ~70 | same |
| `checkpoint_list` | 3 (scoping, status, limit) | ~90 | workflow_checkpoints |
| **Total** | **12** | **~290 + 80 fixture + 120 smoke** | — |

**Isolation guarantee:** every test runs under a unique `project_id` like `__test_m4_<8-hex>__`. `after`-hook deletes all rows in that namespace from `workflow_checkpoints`, `cloud_backlog`, `memory_chunks` in FK-safe order. Even if a test crashes mid-flight, the next run with a different UUID-derived project_id won't see the orphans.

**Live-Supabase rationale:** No DB mock exists in the repo (worker confirmed). Refactoring handlers to accept an injectable client is out-of-scope (user said no TS code yet). Live tests catch schema drift the mock would miss. Cost: ~3–5 seconds per test from network latency; acceptable for a one-time characterization suite.

---

## Self-Review

**1. Spec coverage** — every handler + the stamp helper has at least one test; every documented invariant (status monotonicity, source_chunk_id pinned on commit, parent-chain walk, project_id scoping, zod input clamps) has a corresponding assertion. ✓

**2. Placeholder scan** — no "TODO", "implement later", or "similar to Task N" patterns. Every step that says "add this" includes the actual code. ✓

**3. Type consistency** — `checkpoint_id`, `source_chunk_id`, `restored_from`, `backlog_stamped` names match `src/tools/checkpoint.ts` exactly (verified against lines 100–104, 235–239, 285–292, 362–365). One soft spot: `CheckpointRow` field naming (camel vs snake) is asserted defensively in Task 13 — tighten after running the test once and reading the live shape. ✓ (with note)

---

## Execution Handoff

**Recommended execution mode:** `superpowers:subagent-driven-development` — fresh subagent per task with two-stage review. Live Supabase tests are slow enough that batching wastes time on a single bad run.

**Alternative:** `superpowers:executing-plans` inline if you want tighter control over the test design between commits.

**Estimated wall-clock:** 60–90 minutes including the per-test Supabase round-trips and the final smoke.

**Estimated commits:** 6 (fixtures, scaffolding, create-tests, commit-tests, rollback-tests, list-tests + smoke + docs squashed).

**Hard blocker before kickoff:** user approval of the **scope pivot** (verify-not-build). The original mission framing implied unbuilt tools.
