// Unit tests for src/tools/orchestrator.ts — delegate_task worker-prompt contract.
// Runtime: node:test + node:assert/strict (Node 22+, loaded via tsx).
//
// Phase 3 of the Agentic Superpowers Integration (Session 29): the orchestrator
// must nudge spawned workers to call `request_skill` BEFORE tackling the task,
// and require them to report `skill_applied` in paragraph 2 of the synthesis.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { delegateTask } from "../src/tools/orchestrator.js";

describe("delegateTask worker prompt — Phase 3 skill-discovery contract", () => {
  test("prompt contains a skill-discovery prelude that names request_skill", async () => {
    const result = await delegateTask({
      title: "fix the failing auth test",
      instructions: "auth.test.ts is red because AUTH_SECRET isn't read; trace + fix.",
    });
    assert.match(result.prompt, /request_skill/);
    assert.match(result.prompt, /Skill Discovery/i);
  });

  test("prompt synthesis contract requires worker to report skill_applied", async () => {
    const result = await delegateTask({
      title: "refactor logging module",
      instructions: "consolidate the three logger entry points into one.",
    });
    assert.match(result.prompt, /skill_applied/);
  });

  test("prompt still includes existing mandate/task/workflow sections (regression guard)", async () => {
    const result = await delegateTask({
      title: "smoke test",
      instructions: "do nothing of substance — just check sections survive.",
    });
    assert.match(result.prompt, /## Mandate/);
    assert.match(result.prompt, /## Task/);
    assert.match(result.prompt, /## Required workflow/);
    assert.match(result.prompt, /## Hard constraints/);
  });

  test("skill-discovery prelude appears BEFORE the numbered workflow", async () => {
    const result = await delegateTask({
      title: "ordering check",
      instructions: "verify the skill-discovery section comes first.",
    });
    // Anchor both matches to section headers on their own line to avoid false
    // matches inside user-supplied instruction text.
    const preludeIdx = result.prompt.indexOf("\n## Skill Discovery");
    const workflowIdx = result.prompt.indexOf("\n## Required workflow");
    assert.ok(preludeIdx >= 0, "skill-discovery section must exist");
    assert.ok(workflowIdx >= 0, "workflow section must exist");
    assert.ok(preludeIdx < workflowIdx, `skill-discovery (${preludeIdx}) must precede workflow (${workflowIdx})`);
  });
});
