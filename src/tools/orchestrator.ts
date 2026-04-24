import { resolve } from "node:path";
import { currentProjectId } from "../project.js";
import { updateLocalReadme, updateProjectArchitecture } from "./backlog.js";

// ─── delegate_task: canonical sub-agent prompt builder ───────────────────
//
// The Orchestrator pattern: the main Claude session never writes code
// directly — it spawns a worker sub-agent via the Agent tool, the worker
// performs the edit AND runs refactor_guard's compile gate, then returns a
// short synthesis. Keeps the main context "lean" for high-level decisions.
//
// This tool doesn't spawn the sub-agent itself (that's the Agent tool's
// job). It just produces the standardized prompt text so every delegation
// carries the same contract: do the work → gate → rollback on failure →
// return 2-paragraph synthesis with hard caps on raw content.

type DelegateArgs = {
  title: string;
  instructions: string;
  target_files?: string[];
  workspace?: string;
  run_gate?: boolean;
  allow_rollback?: boolean;
  synthesis_word_limit?: number;
};

function buildWorkerPrompt(args: DelegateArgs): string {
  const runGate = args.run_gate !== false; // default true
  const allowRollback = args.allow_rollback !== false;
  const synthLimit = args.synthesis_word_limit ?? 200;
  const workspace = args.workspace ? resolve(args.workspace) : process.cwd();
  const targetFiles = args.target_files ?? [];

  const steps: string[] = [
    "## Mandate",
    `You are a worker sub-agent spawned by the Orchestrator (main Claude session). Your context is yours alone — the main session has asked you to handle this task end-to-end so its context stays clean.`,
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
  steps.push("1. Perform the edits/research/commands as instructed.");
  if (runGate) {
    steps.push(
      `2. Immediately after the work is done, call \`refactor_guard({ action: "gate", workspace: "${workspace.replace(/\\/g, "/")}" })\` to run the compiler/analyzer for this stack.`,
    );
  } else {
    steps.push("2. (Gate skipped — Orchestrator requested no compile check.)");
  }
  if (allowRollback) {
    steps.push(
      "3. If the gate fails, for every file you edited call `refactor_guard({ action: \"rollback\", file: <abs-path> })` to restore the pre-edit backup. Then explain why you rolled back in the synthesis.",
    );
  }
  steps.push(
    `4. Return ONLY a 2-paragraph synthesis (≤ ${synthLimit} words total). Paragraph 1: what changed, why, and which files. Paragraph 2: gate result (pass/fail), rollback actions taken, remaining risks or follow-ups.`,
  );
  steps.push("");

  steps.push("## Hard constraints");
  steps.push(
    "- DO NOT paste raw file contents, long log excerpts, or full stack traces into the synthesis. If you need to quote something, summarize it in ≤ 1 sentence per item.",
  );
  steps.push(
    "- Keep the synthesis under the word limit. The Orchestrator will reject output that leaks raw context back into the main session.",
  );
  steps.push(
    "- If the task is ambiguous or blocked, say so in the synthesis with a specific next question for the Orchestrator — do not invent requirements.",
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
  return {
    action: "delegate_task",
    title: args.title,
    description_for_agent_tool: description,
    workspace: args.workspace ? resolve(args.workspace) : process.cwd(),
    run_gate: args.run_gate !== false,
    synthesis_word_limit: args.synthesis_word_limit ?? 200,
    prompt,
    usage_hint:
      "Copy the 'prompt' field into the Agent tool call as the 'prompt' parameter. Use subagent_type: 'general-purpose' unless a specialized agent fits better. After the sub-agent returns its synthesis, call sync_artefacts to refresh README + project_file_architecture.md.",
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
