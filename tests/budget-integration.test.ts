// Integration tests for src/budget/gate.ts — checkTaskBudget / checkDaemonBudget
// END-TO-END against the live dev Supabase. The unit suite
// (tests/budget-gate.test.ts) mocks Supabase and only exercises pure logic;
// this lane drives the real supabase-js code path the gate uses in production.
//
// ISOLATION CONTRACT (double-gated — see Phase 1 design SCM-S49-D1):
//   1. EXCLUDED from `npm test`'s explicit file list → never runs in the unit
//      lane. Reachable ONLY via `npm run test:integration`.
//   2. SELF-SKIPS unless RUN_DB_TESTS=1 (set by .env.test, injected through
//      `--env-file=.env.test`). Unset → the suite logs and touches no DB.
//
// NAMESPACE + CLEANUP:
//   Every row this suite creates is tagged with a disposable per-run namespace
//   (NS). budget_tasks.project_id = NS and daemon_budget_* rows use daemon = NS.
//   budget_tasks.task_id is a uuid column (schema 021), so the parent task is
//   inserted with a real randomUUID and located in teardown via project_id=NS;
//   its child events are deleted via that captured uuid FK. after() runs in a
//   finally so cleanup ALWAYS executes even on assertion failure, then re-queries
//   all four tables and logs the residual counts (must be 0).
//
// Runtime: node:test + node:assert/strict (Node 20+, loaded via tsx).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import {
  checkTaskBudget,
  checkDaemonBudget,
} from "../src/budget/gate.js";
import type { TaskCaps } from "../src/budget/types.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

// Unique per run — used as project_id (task surface) and as the daemon name
// (daemon surface). pid keeps parallel CI runners from colliding.
const NS = `test-int-${Date.now()}-${process.pid}`;

// Small cap so the refuse (block) path is reachable in two cheap calls:
// delta 60 → total 60 (allow, 0.6 ratio) → total 120 (>100 → block).
const TASK_TOKEN_CAP = 100;
const TASK_DELTA = 60;

// Daemon deltas — assert the rolling-hour bucket accumulates across calls.
const DAEMON_DELTA = 5;

// budget_tasks.task_id is uuid PK; NS is not a valid uuid, so the parent task
// carries a real uuid (located in teardown via project_id=NS). Captured here so
// child budget_task_events (task_id FK) can be queried/deleted precisely.
let taskUuid = "";

// resolveMode() reads SCM_BUDGET_ENFORCEMENT_MODE dynamically per call, so the
// suite forces a deterministic mode at runtime and restores it afterward.
const priorMode = process.env.SCM_BUDGET_ENFORCEMENT_MODE;

describe("budget gate — real-DB integration (NS-isolated)", () => {
  before(async () => {
    if (!RUN_DB_TESTS) {
      console.log(
        "[budget-integration] RUN_DB_TESTS!=1 — skipping real-DB lane",
      );
      return;
    }
    // Force enforce so the block decision (and BudgetExceededError throw on the
    // task surface) is deterministic regardless of ambient env.
    process.env.SCM_BUDGET_ENFORCEMENT_MODE = "enforce";

    taskUuid = randomUUID();
    const frozen_caps: TaskCaps = {
      anthropic_tokens: TASK_TOKEN_CAP,
      ollama_calls: 50,
      subagent_depth: 2,
    };
    const { error } = await supabase.from("budget_tasks").insert({
      task_id: taskUuid,
      project_id: NS,
      mode: "enforce",
      frozen_caps,
    });
    if (error) {
      throw new Error(`[budget-integration] seed budget_tasks failed: ${error.message}`);
    }
  });

  after(async () => {
    if (!RUN_DB_TESTS) return;
    // Restore the ambient enforcement mode no matter what happened above.
    if (priorMode === undefined) delete process.env.SCM_BUDGET_ENFORCEMENT_MODE;
    else process.env.SCM_BUDGET_ENFORCEMENT_MODE = priorMode;

    try {
      // FK-safe delete: children before parents.
      //   budget_task_events.task_id → budget_tasks(task_id) ON DELETE CASCADE,
      // but we delete events explicitly first so the residual audit below is
      // an independent proof (not relying on the cascade).
      if (taskUuid) {
        await supabase.from("budget_task_events").delete().eq("task_id", taskUuid);
        await supabase.from("budget_tasks").delete().eq("task_id", taskUuid);
      }
      // daemon surface has no FK between events and buckets — delete both by NS.
      await supabase.from("daemon_budget_events").delete().eq("daemon", NS);
      await supabase.from("daemon_budget_buckets").delete().eq("daemon", NS);
    } finally {
      // Residual audit — MUST be 0 across all four tables for this NS.
      const taskEvents = taskUuid
        ? await supabase
            .from("budget_task_events")
            .select("id", { count: "exact", head: true })
            .eq("task_id", taskUuid)
        : { count: 0 };
      const tasks = await supabase
        .from("budget_tasks")
        .select("task_id", { count: "exact", head: true })
        .eq("project_id", NS);
      const daemonEvents = await supabase
        .from("daemon_budget_events")
        .select("id", { count: "exact", head: true })
        .eq("daemon", NS);
      const daemonBuckets = await supabase
        .from("daemon_budget_buckets")
        .select("id", { count: "exact", head: true })
        .eq("daemon", NS);
      console.log(
        `[budget-integration] residual rows for NS=${NS} — ` +
          `budget_task_events=${taskEvents.count ?? 0}, ` +
          `budget_tasks=${tasks.count ?? 0}, ` +
          `daemon_budget_events=${daemonEvents.count ?? 0}, ` +
          `daemon_budget_buckets=${daemonBuckets.count ?? 0}`,
      );
    }
  });

  test("Test A — task axis: accumulates, records events, flips allow→block at cap", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("RUN_DB_TESTS!=1");

    // First call: total = 60 ≤ cap (100) → allow (0.6 ratio < 0.8 warn band).
    const first = await checkTaskBudget(taskUuid, "anthropic_tokens", TASK_DELTA);
    assert.equal(first.mode, "enforce", "mode must be enforce for this assertion");
    assert.equal(first.total, TASK_DELTA, "running total accumulates from 0");
    assert.equal(first.cap, TASK_TOKEN_CAP, "cap reflects seeded frozen_caps");
    assert.equal(first.decision, "allow", "60/100 is below the warn band → allow");

    // Second call would push total to 120 > cap → block. In enforce mode the
    // gate THROWS BudgetExceededError, but only AFTER it has written the event
    // and incremented the counter, so the running total is observable.
    await assert.rejects(
      () => checkTaskBudget(taskUuid, "anthropic_tokens", TASK_DELTA),
      (err: Error) => {
        assert.equal(err.name, "BudgetExceededError", "enforce mode throws on block");
        return true;
      },
      "exceeding the cap in enforce mode must throw BudgetExceededError",
    );

    // The running total must be monotonic and reflect both deltas (60 + 60).
    const { data: taskRow, error: taskErr } = await supabase
      .from("budget_tasks")
      .select("anthropic_tokens_used")
      .eq("task_id", taskUuid)
      .single();
    assert.ifError(taskErr);
    assert.equal(
      (taskRow as { anthropic_tokens_used: number }).anthropic_tokens_used,
      TASK_DELTA * 2,
      "counter accumulated both deltas (monotonic running total)",
    );

    // Both gate calls must have appended an audit row; the second must be block.
    const { data: events, error: evErr } = await supabase
      .from("budget_task_events")
      .select("axis, delta, total_after, decision")
      .eq("task_id", taskUuid)
      .order("id", { ascending: true });
    assert.ifError(evErr);
    const rows = (events ?? []) as Array<{
      axis: string;
      delta: number;
      total_after: number;
      decision: string;
    }>;
    assert.equal(rows.length, 2, "two checkTaskBudget calls → two event rows");
    assert.equal(rows[0]?.decision, "allow", "first event recorded allow");
    assert.equal(rows[0]?.total_after, TASK_DELTA, "first event total_after=60");
    assert.equal(rows[1]?.decision, "block", "second event recorded block");
    assert.equal(rows[1]?.total_after, TASK_DELTA * 2, "second event total_after=120");
  });

  test("Test B — daemon axis: increments the hour bucket and records events", async (t) => {
    if (!RUN_DB_TESTS) return t.skip("RUN_DB_TESTS!=1");

    // First tick: bucket count for the current hour becomes DAEMON_DELTA.
    const first = await checkDaemonBudget(NS, "ollama_calls", DAEMON_DELTA);
    assert.equal(first.daemon, NS, "decision echoes the daemon name");
    assert.equal(first.axis, "ollama_calls", "axis echoed");
    assert.equal(first.total, DAEMON_DELTA, "first tick → bucket count = delta");
    assert.ok(first.hour_bucket, "daemon decision carries the hour_bucket label");

    // Second tick: same hour bucket accumulates to 2× delta.
    const second = await checkDaemonBudget(NS, "ollama_calls", DAEMON_DELTA);
    assert.equal(
      second.total,
      DAEMON_DELTA * 2,
      "second tick in the same hour accumulates the bucket count",
    );

    // Verify the persisted bucket row matches the accumulated count.
    const hourStart = new Date(Date.now() - (Date.now() % 3_600_000)).toISOString();
    const { data: bucket, error: bkErr } = await supabase
      .from("daemon_budget_buckets")
      .select("count")
      .eq("daemon", NS)
      .eq("axis", "ollama_calls")
      .gte("hour_bucket", hourStart)
      .single();
    assert.ifError(bkErr);
    assert.equal(
      (bucket as { count: number }).count,
      DAEMON_DELTA * 2,
      "persisted bucket count reflects both ticks",
    );

    // Both ticks must have appended audit rows.
    const { count: evCount, error: evErr } = await supabase
      .from("daemon_budget_events")
      .select("id", { count: "exact", head: true })
      .eq("daemon", NS)
      .eq("axis", "ollama_calls");
    assert.ifError(evErr);
    assert.equal(evCount, 2, "two checkDaemonBudget calls → two event rows");
  });
});
