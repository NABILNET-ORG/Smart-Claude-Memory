// scripts/smoke-arm-enforce.mjs
// SCM-S40-D1 — Live smoke test of the Agentic Resource Manager hard-block.
//
// Why this exists: unit tests in tests/budget-gate.test.ts cover the pure
// decision matrix, but they don't prove that SCM_BUDGET_ENFORCEMENT_MODE=enforce
// actually wires through to a real throw against the live Supabase task row.
// This script bypasses the MCP server (which boots with whatever env it had
// at startup) and exercises dist/budget/gate.js directly with enforce mode set
// BEFORE any module load.
//
// Contract verified:
//   1. Mode resolves to "enforce" from process.env.
//   2. checkTaskBudget against a task with ollama_calls cap=1 returns
//      decision="warn" on first call (total=1, exactly at cap).
//   3. Second call (total=2, > cap) throws BudgetExceededError.
//   4. The thrown error carries the GateDecision payload for diagnosis.
//
// Usage: node scripts/smoke-arm-enforce.mjs <task_id>
// The task_id MUST be created beforehand via the MCP start_task tool with
// caps:{ ollama_calls: 1 } so the additive counter trips on the 2nd call.
//
// Axis note: ollama_calls + anthropic_tokens use additive (before + delta)
// semantics, but subagent_depth uses Math.max(before, delta) — high-water-
// mark, NOT additive. Use an additive axis for this smoke test.

import "dotenv/config";

// Set enforce mode BEFORE importing the gate — resolveMode() reads env at call time
// so order doesn't strictly matter, but doing it up-front mirrors how a fresh
// process would boot in production.
process.env.SCM_BUDGET_ENFORCEMENT_MODE = "enforce";

const { checkTaskBudget, resolveMode } = await import("../dist/budget/gate.js");
const { BudgetExceededError } = await import("../dist/budget/types.js");

const task_id = process.argv[2];
if (!task_id) {
  console.error("FAIL: pass task_id as argv[1]");
  process.exit(2);
}

const results = { mode: null, first: null, second: null, threw: false, error_payload: null };

results.mode = resolveMode();
if (results.mode !== "enforce") {
  console.error(`FAIL: mode did not resolve to enforce — got ${results.mode}`);
  process.exit(1);
}

try {
  results.first = await checkTaskBudget(task_id, "ollama_calls", 1);
} catch (e) {
  console.error(`FAIL: first call threw unexpectedly — ${e.constructor.name}: ${e.message}`);
  process.exit(1);
}

try {
  results.second = await checkTaskBudget(task_id, "ollama_calls", 1);
  console.error("FAIL: second call did NOT throw — hard-block is broken");
  console.error(JSON.stringify(results.second, null, 2));
  process.exit(1);
} catch (e) {
  results.threw = true;
  results.error_payload = {
    name: e.constructor.name,
    is_budget_exceeded: e instanceof BudgetExceededError,
    decision: e.decision ?? null,
    message: e.message,
  };
}

const ok =
  results.mode === "enforce" &&
  results.first?.decision === "warn" &&
  results.threw === true &&
  results.error_payload?.is_budget_exceeded === true &&
  results.error_payload?.decision?.decision === "block";

console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);
