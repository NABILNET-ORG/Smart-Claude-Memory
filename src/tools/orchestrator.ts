import { resolve } from "node:path";
import { currentProjectId } from "../project.js";
import { updateLocalReadme, updateProjectArchitecture } from "./backlog.js";

// ─── delegate_task: canonical sub-agent prompt builder (v1.1.0) ──────────
//
// The Orchestrator pattern: the main Claude session never writes code
// directly — it spawns a worker sub-agent via the Agent tool, the worker
// performs the edit AND runs refactor_guard's compile gate, then returns a
// short synthesis. Keeps the main context "lean" for high-level decisions.
//
// v1.1.0 — Autonomous Self-Healing: when the gate fails the worker now
// diagnoses the regression with `analyze_regression` (comparing the broken
// file against recent backups), attempts a local fix informed by the
// closest prior snapshot, re-runs the gate, and only falls back to
// rollback after `max_healing_attempts` exhausted. The main session never
// sees the failed-compile churn — it gets a single synthesis describing
// the healing path (or the documented surrender).
//
// This tool doesn't spawn the sub-agent itself (that's the Agent tool's
// job). It just produces the standardized prompt text so every delegation
// carries the same contract: do the work → gate → self-heal on failure →
// rollback only if healing fails → return 2-paragraph synthesis.

type DelegateArgs = {
  title: string;
  instructions: string;
  target_files?: string[];
  workspace?: string;
  run_gate?: boolean;
  allow_rollback?: boolean;
  synthesis_word_limit?: number;
  self_heal?: boolean;
  max_healing_attempts?: number;
};

function buildWorkerPrompt(args: DelegateArgs): string {
  const runGate = args.run_gate !== false; // default true
  const allowRollback = args.allow_rollback !== false;
  const selfHeal = args.self_heal !== false; // default true in v1.1.0
  const maxAttempts = Math.max(1, Math.min(args.max_healing_attempts ?? 3, 5));
  const synthLimit = args.synthesis_word_limit ?? 220;
  const workspace = args.workspace ? resolve(args.workspace) : process.cwd();
  const workspaceForPrompt = workspace.replace(/\\/g, "/");
  const targetFiles = args.target_files ?? [];

  const steps: string[] = [
    "## Mandate",
    `You are a worker sub-agent spawned by the Orchestrator (main Claude session). Your context is yours alone — the main session has asked you to handle this task end-to-end so its context stays clean. Resolve compile failures locally; do NOT bounce red gates back to the Orchestrator.`,
    "",
    "## Task",
    args.title.trim(),
    "",
    "## Instructions",
    args.instructions.trim(),
    "",
  ];

  if (targetFiles.length > 0) {
    steps.push("## Target files");
    for (const f of targetFiles) steps.push(`- ${f}`);
    steps.push("");
  }

  steps.push("## Required workflow");
  steps.push("1. Perform the edits/research/commands as instructed. Track the absolute path of every file you touched — you will need this list for steps 3 and 4.");
  if (runGate) {
    steps.push(
      `2. Immediately after the work is done, call \`refactor_guard({ action: "gate", workspace: "${workspaceForPrompt}" })\` to run the compiler/analyzer for this stack.`,
    );
  } else {
    steps.push("2. (Gate skipped — Orchestrator requested no compile check.)");
  }

  if (runGate && selfHeal) {
    steps.push("");
    steps.push(`### 3. Autonomous Self-Healing Loop (max ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"})`);
    steps.push(
      "If the gate in step 2 **fails**, you MUST NOT report failure yet. Execute the healing loop below. The goal is to diagnose the regression against the last known-good snapshot and fix it locally before escalating.",
    );
    steps.push("");
    steps.push("For each attempt (up to the cap above):");
    steps.push(
      "  a. For EACH file you edited in step 1, call `analyze_regression({ file: <abs-path>, backups_to_compare: 3 })`. The response contains `comparisons[]` (diff vs each recent backup) and `closest_prior` (the backup with the smallest edit distance — the most likely stable baseline).",
    );
    steps.push(
      "  b. Read the broken file and the `closest_prior` backup side-by-side. Use the `diff.sample_changes` entries (+ added / - removed lines) plus the compiler error from step 2 to localize the defect. Typical causes: dropped import, renamed symbol, mismatched signature, stale type, missing null-check that the prior version had.",
    );
    steps.push(
      "  c. Apply a **minimal local fix** — re-add the missing piece, reconcile the signature, etc. Do NOT wholesale-restore from the backup (that would erase the feature work). Preserve the intent of the original edit.",
    );
    steps.push(
      `  d. Re-run \`refactor_guard({ action: "gate", workspace: "${workspaceForPrompt}" })\`. If it passes, exit the loop and proceed to step 5.`,
    );
    steps.push(
      "  e. If it still fails, record the attempt (error signature + what you tried) and loop back to (a) with the new compiler output. Do not repeat a fix that already failed — change hypothesis.",
    );
    steps.push("");
    steps.push(
      `If all ${maxAttempts} healing attempt${maxAttempts === 1 ? "" : "s"} fail, proceed to step 4 (rollback). The fact that healing was attempted — and which hypotheses you tested — MUST appear in paragraph 2 of the synthesis.`,
    );
  } else if (runGate) {
    steps.push("3. (Self-healing disabled for this delegation — proceed straight to rollback on gate failure.)");
  }

  if (allowRollback) {
    const prefix = runGate && selfHeal ? "4." : "3.";
    steps.push("");
    steps.push(
      `${prefix} **Rollback (last resort).** Only if the gate is still red after the self-healing loop: for every file you edited, call \`refactor_guard({ action: "rollback", file: <abs-path> })\` to restore the pre-edit backup. Record the rollback in the synthesis together with the specific compiler error healing could not resolve.`,
    );
  }

  const synthStep = runGate && selfHeal ? "5." : allowRollback ? "4." : "3.";
  steps.push("");
  steps.push(
    `${synthStep} Return ONLY a 2-paragraph synthesis (≤ ${synthLimit} words total). Paragraph 1: what changed, why, and which files. Paragraph 2: gate result (pass on first try / passed after N healing attempts / rolled back), key healing hypotheses you tested, remaining risks or follow-ups.`,
  );
  steps.push("");

  steps.push("## Hard constraints");
  steps.push(
    "- DO NOT paste raw file contents, long log excerpts, or full stack traces into the synthesis. Summarize each compiler error as ≤ 1 sentence (error code + what symbol/line it points at).",
  );
  steps.push(
    "- Keep the synthesis under the word limit. The Orchestrator will reject output that leaks raw context back into the main session.",
  );
  steps.push(
    "- Self-healing is strictly LOCAL. Never ask the Orchestrator for more context to fix a compile error while healing attempts remain — the backups and compiler output are sufficient.",
  );
  steps.push(
    "- If the task is ambiguous or the gate failure reflects a genuinely missing requirement (not a regression you introduced), say so in the synthesis with a specific next question for the Orchestrator — do not invent requirements.",
  );

  return steps.join("\n");
}

export async function delegateTask(args: DelegateArgs) {
  if (!args.title || !args.title.trim()) {
    throw new Error("delegate_task requires a non-empty 'title'.");
  }
  if (!args.instructions || !args.instructions.trim()) {
    throw new Error("delegate_task requires non-empty 'instructions'.");
  }
  const prompt = buildWorkerPrompt(args);
  const description = args.title.length <= 40 ? args.title : args.title.slice(0, 37) + "...";
  const runGate = args.run_gate !== false;
  const selfHeal = args.self_heal !== false;
  const maxHealingAttempts = Math.max(1, Math.min(args.max_healing_attempts ?? 3, 5));
  return {
    action: "delegate_task",
    version: "1.1.0",
    title: args.title,
    description_for_agent_tool: description,
    workspace: args.workspace ? resolve(args.workspace) : process.cwd(),
    run_gate: runGate,
    self_heal: runGate && selfHeal,
    max_healing_attempts: runGate && selfHeal ? maxHealingAttempts : 0,
    allow_rollback: args.allow_rollback !== false,
    synthesis_word_limit: args.synthesis_word_limit ?? 220,
    prompt,
    usage_hint:
      "Copy the 'prompt' field into the Agent tool call as the 'prompt' parameter. Use subagent_type: 'general-purpose' unless a specialized agent fits better. The worker will self-heal compile failures locally (analyze_regression → minimal fix → re-gate, up to max_healing_attempts) before falling back to rollback. After the sub-agent returns its synthesis, call sync_artefacts to refresh README + project_file_architecture.md.",
  };
}

// ─── sync_artefacts: lean post-delegation doc refresh ────────────────────
//
// Same underlying helpers as session_end's README + architecture path, but
// without the backlog archive / resume-prompt machinery. Intended to be
// called by the Orchestrator after a worker sub-agent reports success.

type SyncArtefactsArgs = { project_id?: string };

export async function syncArtefacts(args: SyncArtefactsArgs = {}) {
  const projectId = args.project_id ?? currentProjectId;
  const [readmeSync, architectureSync] = await Promise.all([
    updateLocalReadme(projectId),
    updateProjectArchitecture(projectId),
  ]);
  return {
    action: "sync_artefacts",
    project_id: projectId,
    readme_sync: readmeSync,
    architecture_sync: architectureSync,
    note:
      "Orchestrator doc-only sync (subset of session_end). Call this after a worker sub-agent reports success; call manage_backlog({action:'session_end'}) at the actual end of the session to also archive done tasks and emit the resume prompt.",
  };
}
