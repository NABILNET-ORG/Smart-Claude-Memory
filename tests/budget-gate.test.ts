// Unit tests for src/budget/gate.ts — pure decision logic + env resolution.
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).
// Database-touching paths (checkTaskBudget / checkDaemonBudget end-to-end)
// are covered by the real-DB integration lane in tests/budget-integration.test.ts
// (run via `npm run test:integration`, gated on RUN_DB_TESTS=1).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  resolveDaemonCap,
  resolveMode,
  resolveTaskCaps,
  WARN_RATIO,
} from "../src/budget/gate.js";

describe("classify — pure decision matrix", () => {
  test("mode=off always allows, even past cap", () => {
    assert.equal(classify(1_000_000, 100, "off"), "allow");
    assert.equal(classify(0, 0, "off"), "allow");
  });

  test("cap<=0 always allows (no enforcement configured)", () => {
    assert.equal(classify(999, 0, "warn"), "allow");
    assert.equal(classify(999, -1, "enforce"), "allow");
  });

  test("below warn threshold returns allow", () => {
    // 79/100 = 0.79 < WARN_RATIO=0.8
    assert.equal(classify(79, 100, "warn"), "allow");
    assert.equal(classify(79, 100, "enforce"), "allow");
  });

  test("at warn threshold returns warn", () => {
    // 80/100 = 0.80 = WARN_RATIO
    assert.equal(classify(80, 100, "warn"), "warn");
    assert.equal(classify(80, 100, "enforce"), "warn");
  });

  test("over cap returns block in both warn and enforce", () => {
    assert.equal(classify(101, 100, "warn"), "block");
    assert.equal(classify(101, 100, "enforce"), "block");
  });

  test("exactly at cap returns warn (not block — block is strictly >)", () => {
    assert.equal(classify(100, 100, "warn"), "warn");
    assert.equal(classify(100, 100, "enforce"), "warn");
  });

  test("WARN_RATIO is the documented 0.8 contract", () => {
    assert.equal(WARN_RATIO, 0.8);
  });
});

describe("resolveMode — env parsing", () => {
  const original = process.env.SCM_BUDGET_ENFORCEMENT_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.SCM_BUDGET_ENFORCEMENT_MODE;
    else process.env.SCM_BUDGET_ENFORCEMENT_MODE = original;
  });

  test("unset env returns off (safe default)", () => {
    delete process.env.SCM_BUDGET_ENFORCEMENT_MODE;
    assert.equal(resolveMode(), "off");
  });

  test("explicit 'warn' parses", () => {
    process.env.SCM_BUDGET_ENFORCEMENT_MODE = "warn";
    assert.equal(resolveMode(), "warn");
  });

  test("explicit 'enforce' parses", () => {
    process.env.SCM_BUDGET_ENFORCEMENT_MODE = "enforce";
    assert.equal(resolveMode(), "enforce");
  });

  test("invalid value falls back to off", () => {
    process.env.SCM_BUDGET_ENFORCEMENT_MODE = "lenient";
    assert.equal(resolveMode(), "off");
  });

  test("case-insensitive parsing", () => {
    process.env.SCM_BUDGET_ENFORCEMENT_MODE = "ENFORCE";
    assert.equal(resolveMode(), "enforce");
  });
});

describe("resolveTaskCaps — defaults + env + overrides", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SCM_TASK_CAP_ANTHROPIC_TOKENS;
    delete process.env.SCM_TASK_CAP_OLLAMA_CALLS;
    delete process.env.SCM_TASK_CAP_SUBAGENT_DEPTH;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("unset env returns hard-coded fallbacks", () => {
    const caps = resolveTaskCaps();
    assert.equal(caps.anthropic_tokens, 100_000);
    assert.equal(caps.ollama_calls, 50);
    assert.equal(caps.subagent_depth, 2);
  });

  test("env vars are honored", () => {
    process.env.SCM_TASK_CAP_ANTHROPIC_TOKENS = "25000";
    process.env.SCM_TASK_CAP_OLLAMA_CALLS = "10";
    process.env.SCM_TASK_CAP_SUBAGENT_DEPTH = "3";
    const caps = resolveTaskCaps();
    assert.equal(caps.anthropic_tokens, 25000);
    assert.equal(caps.ollama_calls, 10);
    assert.equal(caps.subagent_depth, 3);
  });

  test("explicit overrides take precedence over env", () => {
    process.env.SCM_TASK_CAP_OLLAMA_CALLS = "99";
    const caps = resolveTaskCaps({ ollama_calls: 7 });
    assert.equal(caps.ollama_calls, 7);
    // Non-overridden axis still reads env.
    assert.equal(caps.anthropic_tokens, 100_000);
  });
});

describe("resolveDaemonCap — three-tier precedence", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SCM_") && k.includes("CAP")) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("no env → hard-coded fallback (ollama_calls=50)", () => {
    assert.equal(resolveDaemonCap("trajectory_compactor", "ollama_calls"), 50);
  });

  test("no env → hard-coded fallback (embed_calls=10000)", () => {
    assert.equal(resolveDaemonCap("graph_extractor", "embed_calls"), 10_000);
  });

  test("global env (SCM_DAEMON_CAP_OLLAMA_PER_HOUR) applied to any daemon", () => {
    process.env.SCM_DAEMON_CAP_OLLAMA_CALLS_PER_HOUR = "100";
    assert.equal(resolveDaemonCap("trajectory_compactor", "ollama_calls"), 100);
    assert.equal(resolveDaemonCap("any_other_daemon", "ollama_calls"), 100);
  });

  test("daemon-specific override wins over global env", () => {
    process.env.SCM_DAEMON_CAP_OLLAMA_CALLS_PER_HOUR = "100";
    process.env.SCM_TRAJECTORY_COMPACTOR_CAP_OLLAMA_CALLS_PER_HOUR = "20";
    assert.equal(resolveDaemonCap("trajectory_compactor", "ollama_calls"), 20);
    // Sibling daemon still gets global value.
    assert.equal(resolveDaemonCap("graph_extractor", "ollama_calls"), 100);
  });

  test("invalid env value (non-numeric) falls through to fallback", () => {
    process.env.SCM_DAEMON_CAP_OLLAMA_CALLS_PER_HOUR = "not-a-number";
    assert.equal(resolveDaemonCap("trajectory_compactor", "ollama_calls"), 50);
  });

  test("zero env value falls through (treated as unset)", () => {
    process.env.SCM_DAEMON_CAP_OLLAMA_CALLS_PER_HOUR = "0";
    assert.equal(resolveDaemonCap("trajectory_compactor", "ollama_calls"), 50);
  });
});
