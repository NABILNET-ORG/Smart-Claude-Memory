# M5 Curriculum Scanner — `rollback_repro` Verification & Doc-Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (chosen by user for tight feedback loops) or `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the already-shipped `scanRollbackHotspots()` curriculum source with characterization tests + a live smoke + fix two real doc bugs in ARCHITECTURE.md that would silently break any reader's copy-paste implementation.

**Architecture:** Black-box tests at the scanner function boundary (`scanRollbackHotspots(cfg)` in `src/curriculum/scanner.ts`), hitting live Supabase under unique per-test `project_id` namespaces. A new `insertThrowawayCheckpoint()` fixture lets tests seed `workflow_checkpoints` rows with arbitrary `status`, `step_label`, and back-dated `created_at` — the inputs the scanner aggregates over. We close the autonomous learning loop by proving the M4→M5 binding: a rolledback checkpoint produced by M4 deterministically materialises a `curriculum_tasks` row of kind `rollback_repro` once the threshold + window are met.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict` (Node 24+, loaded via tsx), Supabase JS client (service-role), existing `EnqueueResult` shape `{source, scanned, enqueued, skipped, errored}`.

---

## ⚠ Mission Scope Pivot (read before starting)

The original Session 30 mission framed this Epic as **wire up** the rollback_repro miner. Discovery during planning proved it's already wired:

| Artifact | Status | Evidence |
|---|---|---|
| `scanRollbackHotspots(cfg)` | **Production code, lines 185-249** | `src/curriculum/scanner.ts` — returns `EnqueueResult` with `source: "rollback_repro"`. Query at `:201-204` correctly uses `.eq("status", "rolledback")` (matches the CHECK constraint, not the doc). |
| Daemon wiring | **Live in scan loop** | `src/curriculum/scanner.ts:336` calls `scanRollbackHotspots` after `scanTestGaps`, before `scanStaleCandidates`. `src/curriculum/daemon.ts:119-141` runs the scanner on a configurable interval. |
| Thresholds | **Env-overridable** | `daemon.ts:25-27` — `DEFAULT_ROLLBACK_THRESHOLD=3`, `DEFAULT_ROLLBACK_WINDOW_DAYS=30`. Env vars: `CURRICULUM_ROLLBACK_THRESHOLD`, `CURRICULUM_ROLLBACK_WINDOW_DAYS`. Matches ARCHITECTURE.md spec. |
| `tests/curriculum-scanner.test.ts` | **DOES NOT EXIST** | `ls tests/` — no scanner test file. |
| `scripts/smoke-m5-rollback.ts` | **DOES NOT EXIST** | `ls scripts/` — `smoke-m5.ts` covers the curriculum lifecycle but not the rollback_repro source specifically. |

**Two real doc bugs surfaced — they belong in this Epic** (a future developer reading ARCHITECTURE.md would copy them and silently break their query):

| Location | Wrong | Correct | Why dangerous |
|---|---|---|---|
| `ARCHITECTURE.md:556` | `status='rolled_back'` | `status='rolledback'` | CHECK constraint at `scripts/014_workflow_checkpoints.sql:34` allows only `'rolledback'`. The underscore spelling matches no row → silent zero results. |
| `ARCHITECTURE.md:576` (mermaid) | `status=rolled_back` | `status=rolledback` | Same as above; mermaid diagram propagates the typo. |
| `ARCHITECTURE.md:556` (semantic) | "derived from skill `steps[].path`" | "the orchestrator's free-text `workflow_checkpoints.step_label` (no LLM interpretation needed)" | Code does NOT traverse `agent_skills.steps`. It uses `step_label` directly. Documented inline at `scanner.ts:195-198`. |

**Therefore this Epic = verify the source + add the missing fixture + write 7 characterization tests + 1 smoke + fix 2 doc bugs.** Same playbook as M4 Phase B. If anything in the tests surfaces a real production bug, that's a separate fix commit (Foundation First).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `tests/fixtures/m4.ts` | **MODIFY** | Add `insertThrowawayCheckpoint(projectId, opts)` helper. (Naming kept under `m4` because that's where the workflow_checkpoints schema lives; we don't need a parallel `m5.ts`.) Update `cleanupProject` if needed for `curriculum_tasks`. ~40 lines added. |
| `tests/curriculum-scanner.test.ts` | **CREATE** | 7 characterization tests in one `describe("scanRollbackHotspots — rollback_repro source", ...)` block. Sole test file for M5 scanner sources (future sources can add more describe blocks). ~200 lines. |
| `scripts/smoke-m5-rollback.ts` | **CREATE** | Live end-to-end: insert 3 rolledback checkpoints with the same step_label → call `scanRollbackHotspots` → assert a `curriculum_tasks` row of kind `rollback_repro` materialises with `target_path === step_label`. Cleans up always. ~100 lines. |
| `package.json` | **MODIFY** | Add `"smoke:m5-rollback": "tsx scripts/smoke-m5-rollback.ts"`. Add `tests/curriculum-scanner.test.ts` to the enumerated test list. |
| `ARCHITECTURE.md` | **MODIFY** | Two surgical Edits: line 556 status spelling + target_path semantics, line 576 mermaid status spelling. |
| `src/curriculum/scanner.ts` | **DO NOT TOUCH** | Read-only reference. Any bug found = separate fix commit. |
| `src/curriculum/daemon.ts` | **DO NOT TOUCH** | Same. |
| `scripts/015_curriculum_tasks.sql` | **DO NOT TOUCH** | Same. |

---

## Read-First References (per all tasks)

Read once before Task 1:
- `src/curriculum/scanner.ts` (full file — the contract under test; pay attention to lines 185-249 + 330+ scan loop wrapper)
- `src/curriculum/daemon.ts` (env vars + interval; how the scanner runs in production)
- `scripts/015_curriculum_tasks.sql` (curriculum_tasks schema + enqueue/pull/apply RPCs)
- `scripts/014_workflow_checkpoints.sql` (rolledback row shape)
- `tests/checkpoint.test.ts` (Session 30 — canonical live-Supabase test pattern)
- `tests/fixtures/m4.ts` (the helpers we extend)

---

## Task 1: Audit `scanRollbackHotspots` body vs ARCHITECTURE.md spec (read-only)

**Files:**
- Read: `src/curriculum/scanner.ts:185-249` + `:330+`
- Read: `src/curriculum/daemon.ts:25-141`
- Read: `scripts/015_curriculum_tasks.sql:24-110`

- [ ] **Step 1: Read `scanner.ts:185-249`** — confirm the function signature is `export async function scanRollbackHotspots(cfg: ScannerConfig): Promise<EnqueueResult>` and the body queries `workflow_checkpoints` filtered by `status='rolledback'` + `created_at >= now() - interval '<window> days'` + non-null `step_label`. Note exactly how it computes `target_path` (should be `row.step_label`).

- [ ] **Step 2: Read the GROUP BY + threshold filter** — confirm it groups by `(project_id, step_label)` and only enqueues when the per-group count `>= threshold`. Note the SQL function call (likely an RPC) OR client-side aggregation pattern.

- [ ] **Step 3: Read the enqueue path** — confirm rows go through `enqueue_curriculum_task` RPC OR direct `.insert(...)` into `curriculum_tasks`. Identify how the partial unique constraint `(project_id, target_path, kind) WHERE status='queued'` is handled — does the code catch the unique violation and increment `skipped`, or does it pre-check existence?

- [ ] **Step 4: Read `daemon.ts:25-141`** — confirm the env vars `CURRICULUM_ROLLBACK_THRESHOLD` / `_WINDOW_DAYS` exist with defaults 3 / 30, and that `runCurriculumScanOnce()` calls `scanRollbackHotspots` exactly once per tick.

- [ ] **Step 5: Read `015_curriculum_tasks.sql:24-110`** — verify the column list, enum constraints (`kind`, `status`), and the partial unique index. Confirm there is NO unique index on `(project_id, target_path, kind)` without the `WHERE status='queued'` clause — that distinction is what lets the same hotspot re-enqueue once a previous task transitions to `verified` / `rejected`.

- [ ] **Step 6: Scratch audit note (no commit)** — one paragraph: "Implementation matches ARCHITECTURE.md spec except for `target_path` source (uses `step_label`, not `steps[].path`) and `status` spelling (`'rolledback'`, not `'rolled_back'`). Both divergences are corrections, not regressions — the code is right, the doc is wrong. Test surface = (rolledback row count) × (step_label group) × (created_at age) × (dedup state) × (empty step_label edge case)."

> **If reading surfaces an actual bug** (e.g. wrong window in the query, wrong status spelling — unlikely given the worker confirmed but worth verifying): STOP and surface to the Orchestrator. Do not write tests around buggy code.

---

## Task 2: Extend `tests/fixtures/m4.ts` with `insertThrowawayCheckpoint`

**Files:**
- Modify: `tests/fixtures/m4.ts` (add helper + update cleanup)

- [ ] **Step 1: Add the new helper at the end of the file**

```typescript
export type ThrowawayCheckpointOpts = {
  stepLabel: string;
  status?: "open" | "committed" | "rolledback";
  skillId?: number | null;
  parentId?: number | null;
  sourceChunkId?: number | null;
  rollbackReason?: string | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the rollback_repro 30-day window: pass an old timestamp
  // to verify out-of-window rows are excluded from the aggregate.
  createdAt?: string;
};

export async function insertThrowawayCheckpoint(
  projectId: string,
  opts: ThrowawayCheckpointOpts,
): Promise<number> {
  const row: Record<string, unknown> = {
    project_id: projectId,
    step_label: opts.stepLabel,
    status: opts.status ?? "open",
    skill_id: opts.skillId ?? null,
    parent_id: opts.parentId ?? null,
    source_chunk_id: opts.sourceChunkId ?? null,
    rollback_reason: opts.rollbackReason ?? null,
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayCheckpoint failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}
```

- [ ] **Step 2: Extend `cleanupProject` to also wipe `curriculum_tasks`**

Find the existing `cleanupProject` function. Add a `curriculum_tasks` delete BEFORE the `workflow_checkpoints` delete (curriculum_tasks FKs to workflow_checkpoints via `linked_checkpoint_id ON DELETE SET NULL`, so order is technically flexible, but explicit cleanup is safer than relying on SET NULL semantics for orphans):

Replace:

```typescript
export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: workflow_checkpoints first (it FKs to memory_chunks via
  // source_chunk_id), then cloud_backlog, then memory_chunks.
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
```

With:

```typescript
export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: curriculum_tasks first (FKs to workflow_checkpoints
  // via linked_checkpoint_id), then workflow_checkpoints (FKs to
  // memory_chunks via source_chunk_id), then cloud_backlog, then memory_chunks.
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the existing M4 suite to confirm no regression**

Run: `node --import tsx --no-warnings --test tests/checkpoint.test.ts`
Expected: 12/12 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/m4.ts
git commit -m "test(m5): extend m4 fixtures with insertThrowawayCheckpoint + curriculum_tasks cleanup"
```

> **If `npx tsc --noEmit` errors** with anything about the row type accepting unknown columns (Supabase JS strict typing): the project's Supabase client may use loosely-typed `Record<string, any>` already — if not, switch the helper to two-step (build typed row literal without `created_at`, then conditionally add via separate insert path). Stay surgical.

---

## Task 3: Scaffold `tests/curriculum-scanner.test.ts` + add to npm test list

**Files:**
- Create: `tests/curriculum-scanner.test.ts`
- Modify: `package.json` (add to test enumeration)

- [ ] **Step 1: Create the test file**

```typescript
// Characterization tests for src/curriculum/scanner.ts —
// scanRollbackHotspots (rollback_repro source). Closes the autonomous
// learning loop: M4 produces rolledback checkpoints → M5 mines them into
// curriculum_tasks of kind 'rollback_repro' once threshold + window are met.
//
// Runtime: node:test + node:assert/strict via tsx. Live Supabase under
// unique per-test project_id namespaces.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { scanRollbackHotspots } from "../src/curriculum/scanner.js";
import { supabase } from "../src/supabase.js";
import {
  uniqueProjectId,
  insertThrowawayCheckpoint,
  cleanupProject,
} from "./fixtures/m4.js";

describe("scanRollbackHotspots — rollback_repro source", () => {
  // body filled in by Tasks 4–10
});
```

- [ ] **Step 2: Add the file to `package.json` test script**

Locate the `"test"` line in `package.json` (it ends with `tests/checkpoint.test.ts` after Session 30). Add `tests/curriculum-scanner.test.ts` at the end:

```diff
- "test": "node --import tsx ... tests/checkpoint.test.ts",
+ "test": "node --import tsx ... tests/checkpoint.test.ts tests/curriculum-scanner.test.ts",
```

- [ ] **Step 3: Compile-check + run the empty suite**

```bash
npx tsc --noEmit
node --import tsx --no-warnings --test tests/curriculum-scanner.test.ts
```

Expected: exit 0 for both; empty describe block reported, no failures.

- [ ] **Step 4: Do NOT commit yet** — batch with Tasks 4-10 in one M5 tests commit.

---

## Task 4: Test — empty corpus → 0 enqueued

**Files:**
- Modify: `tests/curriculum-scanner.test.ts` (fill the describe)

- [ ] **Step 1: Add the per-describe setup + a `makeCfg` helper + first test**

`ScannerConfig` has **9 required fields** (verified via Session 30 smoke):
`projectId`, `workspace`, `minFreq`, `ttlDays`, `testGapCoveragePctCeiling`,
`testGapMinLines`, `rollbackThreshold`, `rollbackWindowDays`, `staleCandidateMinAgeDays`.
For rollback_repro tests, only the rollback knobs matter — the test_gap and
stale_candidate knobs are passed at production-default values so the scanner
doesn't trip on undefined access. Use a `makeCfg` helper so each test reads
cleanly.

```typescript
const projectId = uniqueProjectId();
after(async () => {
  await cleanupProject(projectId);
});

// All ScannerConfig fields required by the type. Only rollback knobs vary
// per test; the rest are production-default no-op values for this Epic.
function makeCfg(overrides: {
  projectId?: string;
  rollbackThreshold?: number;
  rollbackWindowDays?: number;
} = {}) {
  return {
    projectId: overrides.projectId ?? projectId,
    workspace: "c:/Users/saeee/OneDrive/Documents/My Projects/Claude-Memory",
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: overrides.rollbackThreshold ?? 3,
    rollbackWindowDays: overrides.rollbackWindowDays ?? 30,
    staleCandidateMinAgeDays: 30,
  };
}

test("empty corpus → 0 enqueued", async () => {
  const r = await scanRollbackHotspots(makeCfg());
  assert.equal(r.source, "rollback_repro");
  assert.equal(r.enqueued, 0);
});
```

> **Note on `cfg` shape:** Field names verified via the M5 smoke worker — they match the type. If `ScannerConfig` adds/renames fields between Session 30 and execution, Task 1 audit will catch it; update `makeCfg` defaults accordingly. The `workspace` field accepts any absolute path string; the scanner uses it only for the test_gap source (irrelevant here).

- [ ] **Step 2: Run** — `node --import tsx --no-warnings --test tests/curriculum-scanner.test.ts` → Expected: PASS.

---

## Task 5: Test — below threshold (2 rolledbacks, threshold=3) → 0 enqueued

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("2 rolledbacks (threshold=3) → 0 enqueued", async () => {
  await insertThrowawayCheckpoint(projectId, {
    stepLabel: "src/below-threshold.ts",
    status: "rolledback",
    rollbackReason: "test-1",
  });
  await insertThrowawayCheckpoint(projectId, {
    stepLabel: "src/below-threshold.ts",
    status: "rolledback",
    rollbackReason: "test-2",
  });

  const r = await scanRollbackHotspots(makeCfg());
  assert.equal(r.enqueued, 0);

  // Defensive: no curriculum_tasks row materialised.
  const { count } = await supabase
    .from("curriculum_tasks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("kind", "rollback_repro");
  assert.equal(count, 0);
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 6: Test — at threshold (3 rolledbacks, same step_label) → 1 enqueued

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("3 rolledbacks at threshold → 1 enqueued with target_path=step_label", async () => {
  const stepLabel = "src/at-threshold.ts";
  for (let i = 0; i < 3; i++) {
    await insertThrowawayCheckpoint(projectId, {
      stepLabel,
      status: "rolledback",
      rollbackReason: `test-${i}`,
    });
  }

  const r = await scanRollbackHotspots(makeCfg());
  assert.equal(r.enqueued, 1);

  const { data, error } = await supabase
    .from("curriculum_tasks")
    .select("kind, target_path, status, rationale")
    .eq("project_id", projectId)
    .eq("kind", "rollback_repro")
    .eq("target_path", stepLabel)
    .single();
  assert.equal(error, null);
  assert.equal(data?.kind, "rollback_repro");
  assert.equal(data?.target_path, stepLabel);
  assert.equal(data?.status, "queued");
  assert.ok((data?.rationale ?? "").length > 0, "rationale should be non-empty");
});
```

- [ ] **Step 2: Run** → Expected: PASS. **If FAIL on target_path mismatch: real bug — the scanner is NOT using step_label as target_path.** Stop and surface.

---

## Task 7: Test — multiple distinct step_labels above threshold → multiple enqueued

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("two distinct step_labels both >= threshold → 2 enqueued", async () => {
  const subProjectId = uniqueProjectId();
  try {
    for (const label of ["src/groupA.ts", "src/groupB.ts"]) {
      for (let i = 0; i < 3; i++) {
        await insertThrowawayCheckpoint(subProjectId, {
          stepLabel: label,
          status: "rolledback",
          rollbackReason: `test-${label}-${i}`,
        });
      }
    }

    const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
    assert.equal(r.enqueued, 2);

    const { count } = await supabase
      .from("curriculum_tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", subProjectId)
      .eq("kind", "rollback_repro");
    assert.equal(count, 2);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

- [ ] **Step 2: Run** → Expected: PASS.

---

## Task 8: Test — outside window (old rolledbacks) → 0 enqueued

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("3 rolledbacks older than window → 0 enqueued", async () => {
  const subProjectId = uniqueProjectId();
  try {
    // 60 days ago = well outside the default 30-day window.
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i++) {
      await insertThrowawayCheckpoint(subProjectId, {
        stepLabel: "src/old-rolledback.ts",
        status: "rolledback",
        rollbackReason: `test-old-${i}`,
        createdAt: oldTimestamp,
      });
    }

    const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
    assert.equal(r.enqueued, 0);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

- [ ] **Step 2: Run** → Expected: PASS. **If FAIL: window filter is broken — real bug.** Surface.

---

## Task 9: Test — empty/whitespace step_label is skipped

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("rolledbacks with empty step_label are skipped from aggregation", async () => {
  const subProjectId = uniqueProjectId();
  try {
    // The fixture validates non-empty step_label at the M4 layer (zod), so
    // we insert directly via supabase to bypass that guard and test the
    // scanner's defensive skip. Use whitespace which is technically a valid
    // string but semantically meaningless as a target_path.
    for (let i = 0; i < 3; i++) {
      const { error } = await supabase.from("workflow_checkpoints").insert({
        project_id: subProjectId,
        step_label: "   ", // whitespace only
        status: "rolledback",
        rollback_reason: `test-empty-${i}`,
      });
      assert.equal(error, null);
    }

    const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
    assert.equal(r.enqueued, 0);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

> **Note:** If the scanner does NOT trim/skip whitespace-only labels (Task 1 audit will confirm), this test may fail with `r.enqueued === 1` and a curriculum_tasks row with `target_path = "   "`. That's a defensible behavior — the test then needs to flip its assertion to match reality + we file a separate hardening commit. Bias for matching reality first; don't force-fix the scanner from a test.

- [ ] **Step 2: Run** → If FAIL with `enqueued=1`: adjust assertion to current behavior and add a TODO comment for a hardening pass.

---

## Task 10: Test — dedup (re-running on same hotspot doesn't double-enqueue)

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test("re-running scan on same hotspot does not double-enqueue (partial unique constraint)", async () => {
  const subProjectId = uniqueProjectId();
  try {
    const stepLabel = "src/dedup.ts";
    for (let i = 0; i < 3; i++) {
      await insertThrowawayCheckpoint(subProjectId, {
        stepLabel,
        status: "rolledback",
        rollbackReason: `test-dedup-${i}`,
      });
    }

    const r1 = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
    assert.equal(r1.enqueued, 1);

    // Second run on identical state — partial unique constraint should
    // prevent a second `queued` row for the same (project_id, target_path, kind).
    const r2 = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
    // Either: enqueued=0 (pre-check) or enqueued=0 + skipped=1 (post-violation).
    // Both are correct behaviors — assert the OBSERVABLE invariant: only 1 task exists.
    assert.equal(r2.enqueued, 0);

    const { count } = await supabase
      .from("curriculum_tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", subProjectId)
      .eq("kind", "rollback_repro")
      .eq("target_path", stepLabel);
    assert.equal(count, 1);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

- [ ] **Step 2: Run** → Expected: PASS.

- [ ] **Step 3: Commit all 7 rollback_repro tests + scaffolding + package.json**

```bash
git add tests/curriculum-scanner.test.ts package.json
git commit -m "test(m5): characterize scanRollbackHotspots — empty, below/at/above threshold, window, empty-label, dedup"
```

---

## Task 11: Live smoke `scripts/smoke-m5-rollback.ts` + npm script

**Files:**
- Create: `scripts/smoke-m5-rollback.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Create the smoke script**

```typescript
// scripts/smoke-m5-rollback.ts — live end-to-end smoke for the M4→M5 binding.
// Insert 3 rolledback checkpoints with the same step_label, run
// scanRollbackHotspots, verify a curriculum_tasks row of kind 'rollback_repro'
// materialises with target_path === step_label. Always-run cleanup.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { scanRollbackHotspots } from "../src/curriculum/scanner.js";

const projectId = `__smoke_m5rb_${randomUUID().slice(0, 8)}__`;
const stepLabel = `src/__smoke_m5rb__/${randomUUID().slice(0, 6)}.ts`;

async function seedRolledback(): Promise<void> {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    project_id: projectId,
    step_label: stepLabel,
    status: "rolledback",
    rollback_reason: `smoke-${i}`,
  }));
  const { error } = await supabase.from("workflow_checkpoints").insert(rows);
  if (error) throw new Error(`seedRolledback: ${error.message}`);
}

async function cleanup(): Promise<void> {
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M5-RB-SMOKE] start project=${projectId} stepLabel=${stepLabel}`);
  await seedRolledback();
  console.log(`[M5-RB-SMOKE] seeded 3 rolledback checkpoints`);

  // ScannerConfig has 9 required fields — all 9 must be set even though
  // this smoke only exercises the rollback knobs.
  const r = await scanRollbackHotspots({
    projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: 3,
    rollbackWindowDays: 30,
    staleCandidateMinAgeDays: 30,
  });
  console.log(`[M5-RB-SMOKE] scan result:`, r);
  if (r.enqueued !== 1) {
    throw new Error(`[M5-RB-SMOKE] FAIL: expected enqueued=1, got ${r.enqueued}`);
  }

  const { data, error } = await supabase
    .from("curriculum_tasks")
    .select("kind, target_path, status")
    .eq("project_id", projectId)
    .eq("kind", "rollback_repro")
    .single();
  if (error || !data) {
    throw new Error(`[M5-RB-SMOKE] FAIL: curriculum_tasks lookup: ${error?.message ?? "no row"}`);
  }
  if (data.target_path !== stepLabel) {
    throw new Error(
      `[M5-RB-SMOKE] FAIL: target_path expected '${stepLabel}', got '${data.target_path}'`,
    );
  }
  if (data.status !== "queued") {
    throw new Error(`[M5-RB-SMOKE] FAIL: status expected 'queued', got '${data.status}'`);
  }

  console.log("[M5-RB-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M5-RB-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
```

- [ ] **Step 2: Add npm script to `package.json`**

Add next to the existing `smoke:m4` entry:

```diff
    "smoke:m4": "tsx scripts/smoke-m4.ts",
+   "smoke:m5-rollback": "tsx scripts/smoke-m5-rollback.ts",
```

- [ ] **Step 3: Compile-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the smoke**

Run: `npm run smoke:m5-rollback`
Expected: `[M5-RB-SMOKE] PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-m5-rollback.ts package.json
git commit -m "test(m5): live smoke for rollback_repro — 3 rolledback → curriculum_tasks row"
```

---

## Task 12: Fix two ARCHITECTURE.md doc bugs

**Files:**
- Modify: `ARCHITECTURE.md` (lines 556 + 576 + the target_path semantics)

- [ ] **Step 1: Find both wrong-spelling lines**

Run: `grep -n "rolled_back\|steps\[\].path\|steps\\[].path" ARCHITECTURE.md`

Confirm 2-3 hits around lines 556 + 576. If more hits exist anywhere in the doc, fix them too (don't restructure adjacent prose).

- [ ] **Step 2: Edit line 556's status spelling + target_path semantics**

Use Edit to replace the line that contains the `rolled_back` text + the `steps[].path` text. The replacement should:

- Change `status='rolled_back'` → `status='rolledback'`
- Change `target_path` derivation from `skill steps[].path` to `workflow_checkpoints.step_label` (cite that scanner.ts:195-198 explicitly documents this — no LLM interpretation needed)

Exact old/new strings depend on the current prose at that line. Read 5 lines of context first; keep the surrounding sentence structure intact.

- [ ] **Step 3: Edit line 576's mermaid spelling**

Use Edit to replace `rolled_back` → `rolledback` inside the mermaid diagram. Surrounding mermaid syntax must remain unchanged (mermaid is whitespace-sensitive).

- [ ] **Step 4: Verify no remaining bad spellings**

Run: `grep -n "rolled_back" ARCHITECTURE.md`
Expected: no output (no matches).

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(m5): correct status='rolledback' spelling + target_path source for rollback_repro

Two real bugs that would silently break any reader's copy-paste implementation:
- status='rolled_back' (with underscore) matches no row — CHECK constraint is 'rolledback'
- target_path is derived from workflow_checkpoints.step_label, not agent_skills.steps[].path
  (scanner.ts:195-198 documents this design choice — no LLM interpretation needed)"
```

---

## Task 13: Full suite + gate

**Files:** none new.

- [ ] **Step 1: Full npm test**

Run: `npm test`
Expected: 91 (M4 baseline) + 7 (new M5 tests) = **98/98 pass**.

- [ ] **Step 2: refactor_guard gate**

Call: `refactor_guard({ action: "gate", workspace: "c:/Users/saeee/OneDrive/Documents/My Projects/Claude-Memory" })`
Expected: `ok: true`, exit 0.

- [ ] **Step 3: Re-run both smoke scripts**

```bash
npm run smoke:m4
npm run smoke:m5-rollback
```

Expected: both PASS, exit 0.

- [ ] **Step 4: If anything is red, STOP** — use `superpowers:systematic-debugging`. Don't paper over.

---

## Task 14: DECISION memory + final wrap

**Files:** none new.

- [ ] **Step 1: `git status`** — expected clean.

- [ ] **Step 2: `git log --oneline -6`** — expected: 4 new commits (`test(m5): extend fixtures`, `test(m5): characterize scanRollbackHotspots`, `test(m5): live smoke for rollback_repro`, `docs(m5): correct status spelling + target_path source`).

- [ ] **Step 3: Save DECISION memory via `save_memory`**

```
Content: SCM-S30-D5: M5 rollback_repro (curriculum scanner source for the M4→M5 binding) verified end-to-end. Production code at src/curriculum/scanner.ts:185-249 was already shipped + wired into the daemon scan loop — Session 30 added 7 characterization tests (tests/curriculum-scanner.test.ts) + 1 live smoke (scripts/smoke-m5-rollback.ts, npm run smoke:m5-rollback). Two real ARCHITECTURE.md doc bugs corrected: status='rolled_back' → 'rolledback' (lines 556 + 576) and target_path source from agent_skills.steps[].path → workflow_checkpoints.step_label. Full npm test 98/98 pass; tsc gate clean. Closes the autonomous learning loop: a rolledback checkpoint produced by M4 (validated Session 30) now deterministically materialises a curriculum_tasks row of kind 'rollback_repro' once 3 rolledbacks for the same step_label land within 30 days. Reuses tests/fixtures/m4.ts (extended with insertThrowawayCheckpoint + curriculum_tasks cleanup).

Metadata: { type: "DECISION", status: "verified", session: 30, mission: "M5-rollback_repro" }
```

- [ ] **Step 4: Synthesis to Orchestrator** — 2 paragraphs: (1) what shipped (commits + test count + bugs fixed), (2) anything surfaced unexpectedly during testing (state "none" if true). End with `skill_applied:` per Phase 3 contract.

---

## Test Strategy Summary

| Test | Inputs | Expected | Why |
|---|---|---|---|
| empty corpus | 0 rolledbacks | `enqueued=0` | baseline / no-op safety |
| below threshold | 2 rolledbacks (threshold=3) | `enqueued=0` | threshold inclusive boundary |
| at threshold | 3 rolledbacks, same step_label | `enqueued=1`, target_path=step_label | happy path + target_path contract |
| multi-group | 3+3 rolledbacks for 2 distinct step_labels | `enqueued=2` | GROUP BY is real |
| outside window | 3 rolledbacks at 60 days ago | `enqueued=0` | window filter is real |
| empty step_label | 3 rolledbacks with whitespace label | `enqueued=0` OR matches current behavior | defensive skip surface |
| dedup | scan twice on same hotspot | exactly 1 curriculum_tasks row | partial unique constraint enforces idempotency |

**Total: 7 tests, ~200 lines. Expected wall-clock: ~15-25 seconds (no insert loops > 6 rows).**

**Isolation guarantee:** Tests use per-describe shared `projectId` for the simple cases and per-test `subProjectId` for cases that need a clean slate (window/dedup). All cleanup via `cleanupProject` which now includes `curriculum_tasks`.

---

## Self-Review

**1. Spec coverage** — every ARCHITECTURE.md heuristic clause has a corresponding test:
- threshold ≥ 3 → Task 5 (below) + Task 6 (at) + Task 7 (above)
- 30-day window → Task 8
- group by step_label → Task 7
- target_path = step_label → Task 6
- dedup via partial unique constraint → Task 10
- empty label edge case → Task 9
- doc bugs corrected → Task 12

**2. Placeholder scan** — no "TODO", no "similar to Task N", no "add appropriate validation". Every step that says "add this" has the actual code. ✓

**3. Type consistency** — `EnqueueResult` shape `{source, scanned, enqueued, skipped, errored}` referenced in Tasks 4, 5, 7, 8, 9, 10, 11 matches the worker synthesis. `ScannerConfig` field names (`projectId`, `rollbackThreshold`, `rollbackWindowDays`) assumed — Task 1 verifies, Task 4 adjusts if needed. `ThrowawayCheckpointOpts` (Task 2) defines `stepLabel`, `status`, `rollbackReason`, `createdAt` — all used consistently in Tasks 5-10. ✓

---

## Execution Handoff

**Recommended execution mode:** `superpowers:executing-plans` inline (user preference from M4: tight control between commits). Live-Supabase round-trips are fast for this Epic (no 25-row insert loops).

**Alternative:** `superpowers:subagent-driven-development` if you want each test in an isolated subagent — useful for parallelism but the dedup test depends on a previous scan, so at least Tasks 4-10 must run sequentially.

**Estimated wall-clock:** 30-50 minutes including live Supabase + 2 smoke runs + doc edits.

**Estimated commits:** 4
1. `test(m5): extend m4 fixtures with insertThrowawayCheckpoint + curriculum_tasks cleanup`
2. `test(m5): characterize scanRollbackHotspots — empty, below/at/above threshold, window, empty-label, dedup`
3. `test(m5): live smoke for rollback_repro — 3 rolledback → curriculum_tasks row`
4. `docs(m5): correct status='rolledback' spelling + target_path source for rollback_repro`

**Hard blocker before kickoff:** user approval of the scope pivot — original mission framing implied unbuilt scanner; reality is built + needs test surface + doc fix.

**Phase 3 contract:** any subagent dispatched for these tasks must follow the `request_skill` + `skill_applied:` synthesis contract. Inline execution by the Orchestrator does not need the contract (orchestrator is not a subagent).
