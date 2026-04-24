#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { syncLocalMemory } from "./tools/sync.js";
import { searchMemory } from "./tools/search.js";
import { updateRule } from "./tools/update-rule.js";
import { manageBacklog } from "./tools/backlog.js";
import { checkCodeHygiene } from "./tools/hygiene.js";
import { confirmVerification, raisePendingVerification } from "./tools/verification.js";
import { checkRuleConflicts } from "./tools/conflict.js";
import { summarizeMemoryFile } from "./tools/summarize.js";
import { indexImage } from "./tools/image.js";
import { checkSystemHealth } from "./tools/health.js";
import { initProject, sweepLegacyBackups, legacyBackupSummary } from "./tools/setup.js";
import { listFrozen, freezeFile, unfreezeFile } from "./tools/policy.js";
import { refactorGuard } from "./tools/refactor.js";
import { analyzeRegression } from "./tools/verification.js";
import { delegateTask, syncArtefacts } from "./tools/orchestrator.js";
import { ensureSchema, startKeepAlive, writeFrozenPatternsCache } from "./supabase.js";
import { currentProjectId } from "./project.js";

const server = new McpServer({
  name: "claude-memory-mcp",
  version: "1.0.0",
});

// Startup diagnostics (stderr — never stdout, which is reserved for JSON-RPC).
// Missing schema is reported loudly with the exact fix command but does not
// block the server from starting: tools that don't touch the missing tables
// (e.g. check_system_health, init_project) still work.
try {
  const report = await ensureSchema();
  if (!report.ok) {
    console.error(`[claude-memory] ${report.message}`);
    console.error(`[claude-memory] Fix: ${report.fix_command}`);
  }
} catch (e) {
  console.error(`[claude-memory] ensureSchema failed: ${(e as Error).message}`);
}

// Keep the Supabase HTTPS pool warm so the first call after idle doesn't
// pay 1-2s of cold-start.
startKeepAlive();

// Export the current frozen_features snapshot to the shared cache file so
// hooks/md-policy.py can read it without hitting Supabase per tool call.
try {
  const c = await writeFrozenPatternsCache();
  if (!c.ok && c.warning) console.error(`[claude-memory] ${c.warning}`);
} catch (e) {
  console.error(`[claude-memory] frozen-pattern cache init failed: ${(e as Error).message}`);
}

// Read-only legacy-backup summary — runs asynchronously so it never blocks
// startup. Logs count + examples on stderr; actual moves require the
// sweep_legacy_backups tool with confirm:true.
void (async () => {
  try {
    const summary = await legacyBackupSummary(process.cwd());
    if (summary.total > 0) {
      console.error(
        `[claude-memory] Legacy backup scan: ${summary.total} candidate(s) — ` +
          `${summary.high} high-confidence, ${summary.medium} medium. ` +
          `Run sweep_legacy_backups to preview; pass confirm:true to move.`,
      );
      for (const ex of summary.top_examples) console.error(`  ${ex}`);
    }
  } catch (e) {
    console.error(`[claude-memory] legacy backup scan failed: ${(e as Error).message}`);
  }
})();

// High-precision vision default — OCR-first, zero-guessing, explicit symbol inventory.
// Callers can override per-call via the caption_prompt arg.
const DEFAULT_VISION_PROMPT = [
  "Analyze this image under STRICT rules:",
  "",
  "1. OCR — Transcribe ALL text verbatim. Prioritize Arabic calligraphy, Arabic handwriting, and English labels. Quote each transcription in double quotes and preserve the original script (do not translate).",
  "2. Zero-Guessing — If a symbol, glyph, or object is ambiguous, describe its shape, color, and position INSTEAD of naming it. Examples: say 'bright orb with radiating rays' not 'crystal ball'; say 'eight-pointed star' not 'compass rose'. Never invent content. Never infer intent.",
  "3. Symbol Inventory — List every mystical or technical symbol as an individual bullet (moon, star, zodiac sign, eye, triangle, hand, etc.). Mark uncertain items as 'unknown: <shape/color description>'.",
  "",
  "Return exactly this structure (Markdown):",
  "",
  "TEXT (OCR):",
  "- \"<verbatim transcription>\" (script: arabic|english|mixed|other)",
  "",
  "SYMBOLS:",
  "- <symbol name or 'unknown: <shape>'>: <location> / <color>",
  "",
  "SCENE:",
  "- <≤ 2 sentences, factual only>",
].join("\n");

const projectIdSchema = z
  .string()
  .optional()
  .describe(
    `Project namespace override. Defaults to the slugified current working directory ('${currentProjectId}'). ` +
      `Memory is strictly isolated per project_id.`,
  );

// ─── existing tools ───────────────────────────────────────────────────────

server.tool(
  "sync_local_memory",
  "Scan MEMORY_ROOTS for .md files, hash-gate, chunk, embed via Ollama, bulk-upsert to Supabase (100/batch). Supports incremental sync, force re-embed, and auto_purge with a mandatory dry-run preview and all-or-nothing verify-before-delete. Protected: CLAUDE.md, MEMORY.md, README.md, LICENSE*, CHANGELOG*.",
  {
    roots: z.array(z.string()).optional(),
    project_id: projectIdSchema,
    force: z.boolean().optional(),
    auto_purge: z.boolean().optional(),
    confirm: z.boolean().optional(),
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await syncLocalMemory(args), null, 2) }] }),
);

server.tool(
  "search_memory",
  "Semantic search over the current project's chunks (strictly isolated). Intent routing: 'archive'/'completed tasks'/'done tasks' → archive_backlog rows (mode:'archive'); 'Active Backlog'/'pending tasks'/'what's next' → active cloud_backlog rows (mode:'backlog'); everything else → vector search over memory_chunks (mode:'semantic'). Archived tasks are NEVER mixed into semantic results unless 'archive' is in the query.",
  {
    query: z.string(),
    limit: z.number().int().positive().max(20).optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    project_id: projectIdSchema,
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchMemory(args), null, 2) }] }),
);

server.tool(
  "update_rule",
  "Upsert a single rule/chunk into the current project's namespace.",
  {
    file_origin: z.string(),
    chunk_index: z.number().int().nonnegative(),
    content: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    project_id: projectIdSchema,
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await updateRule(args), null, 2) }] }),
);

// ─── v0.5.0 tools ─────────────────────────────────────────────────────────

server.tool(
  "manage_backlog",
  "Atomic task backlog in Supabase. Natural-language triggers: 'add to backlog' / 'add task' → add; 'what's on my backlog' / 'list tasks' → list; 'mark done' / 'mark complete' → update with status:done; 'clean up done' → prune_done (archives, not deletes); 'show archive' / 'what did I finish' → archive_list; 'end session' / 'wrap up' / 'handover' → session_end (writes Progress Report to README.md, writes file-tree to project_file_architecture.md, and returns a 1-line resume prompt). Done tasks are ARCHIVED (moved to archive_backlog), never deleted.",
  {
    action: z.enum(["add", "list", "update", "prune_done", "archive_list", "session_end"]),
    title: z.string().optional(),
    id: z.number().int().positive().optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    notes: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    project_id: projectIdSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await manageBacklog(args as never), null, 2) }],
  }),
);

server.tool(
  "check_code_hygiene",
  "Report line counts against the 750-line hard limit. Files already over the limit are flagged 'grandfathered' (edits allowed with warning); the md-policy.py hook blocks brand-new writes that push a file past the limit.",
  {
    paths: z.array(z.string()).min(1),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await checkCodeHygiene(args), null, 2) }],
  }),
);

server.tool(
  "confirm_verification",
  "Close the Hard Stop / Manual Test Gate after a manual check. Natural-language triggers the user might say and that should route to this tool: 'verified', 'test passed', 'it works', 'confirmed', 'all good', 'done testing' → call with success:true; 'broken', 'still failing', 'test failed', 'reverting' → call with success:false. On success:true the file that was under the gate is auto-added to frozen_features (Write blocked going forward, Edit still allowed). On success:false the response surfaces the most recent backup path so the AI can restore the prior state from it.",
  {
    success: z.boolean(),
    notes: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await confirmVerification(args), null, 2) }],
  }),
);

server.tool(
  "raise_verification_gate",
  "Arm the Hard Stop gate after a risky or exploratory edit. Natural-language triggers: 'wait for me to test', 'let me verify', 'stop before committing', 'hold up until I check'. While the gate is raised, the hook blocks every further Write/Edit/Bash until confirm_verification clears it. A backup of the edited file is already on disk thanks to the md-policy.py hook; the path is surfaced in confirm_verification's response for recovery on failure.",
  {
    tool: z.string(),
    file: z.string(),
    reason: z.string().optional(),
    project_id: projectIdSchema,
  },
  async (args) => {
    await raisePendingVerification({
      tool: args.tool,
      file: args.file,
      reason: args.reason,
      project_id: args.project_id,
      created_at: new Date().toISOString(),
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ raised: true, ...args }, null, 2) }],
    };
  },
);

server.tool(
  "check_rule_conflicts",
  "Intent-based rule conflict detection. Retrieves top-K chunks for a proposed change, re-ranks with an LLM, then runs pairwise (change vs rule) conflict analysis on the top 3. Opt-in; latency is 1–3s per call.",
  {
    proposed_change: z.string().min(1),
    project_id: projectIdSchema,
    top_k: z.number().int().positive().max(10).optional(),
    rerank: z.boolean().optional(),
    llm_model: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await checkRuleConflicts(args), null, 2) }],
  }),
);

server.tool(
  "summarize_memory_file",
  "LLM-driven compression of CLAUDE.md or MEMORY.md toward a token target (default 3000). Preserves every actionable rule; drops verbosity. Supports dry_run to preview.",
  {
    file_path: z.string(),
    target_tokens: z.number().int().positive().optional(),
    dry_run: z.boolean().optional(),
    llm_model: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await summarizeMemoryFile(args), null, 2) }],
  }),
);

server.tool(
  "index_image",
  "Caption an image with a local vision model (default: moondream) then embed the caption via nomic-embed-text and upsert into cloud memory. Non-PNG/JPEG inputs (WebP, GIF, BMP) are auto-converted to PNG via ffmpeg. Default prompt enforces OCR-first transcription, zero-guessing for ambiguous symbols, and an explicit symbol inventory.",
  {
    image_path: z.string(),
    caption_prompt: z.string().optional().default(DEFAULT_VISION_PROMPT),
    project_id: projectIdSchema,
    vision_model: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await indexImage(args), null, 2) }],
  }),
);

server.tool(
  "check_system_health",
  "System diagnostics: Supabase reachability (memory_chunks count), Ollama reachability, required-model presence (moondream + nomic-embed-text), and keep-alive status (interval, last ping latency, last ping result). Returns overall='healthy'|'degraded'|'down'.",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await checkSystemHealth(), null, 2) }],
  }),
);

server.tool(
  "list_frozen",
  "List the frozen_features patterns for a project. Patterns here are files that the md-policy.py hook will block Writes on (Edits still allowed).",
  { project_id: projectIdSchema },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listFrozen(args), null, 2) }],
  }),
);

server.tool(
  "freeze_file",
  "Manually mark a file or pattern as frozen. Natural-language triggers: 'freeze this file', 'lock this file', 'protect X from rewrites', 'make this surgical-only'. Once frozen, the md-policy.py hook blocks Write calls on any path containing the pattern; Edit (surgical line-level changes) remains allowed. Every Edit on a frozen file also produces a timestamped backup.",
  {
    pattern: z.string().min(1),
    project_id: projectIdSchema,
    reason: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await freezeFile(args), null, 2) }],
  }),
);

server.tool(
  "unfreeze_file",
  "Request to lift the frozen-file guardrail for a pattern. Natural-language triggers: 'unfreeze X', 'I give permission to refactor X', 'you can rewrite X', 'remove the lock on X'. REQUIRES an explicit 'justification' (≥ 4 chars) — this is the Request for Unfreeze dialog: the agent must present a justification to the user, and the user's acknowledgement is what unlocks the tool call. Without the string the call is refused with a warning.",
  {
    pattern: z.string().min(1),
    project_id: projectIdSchema,
    justification: z.string().describe("Explain why the full-rewrite guardrail can be lifted. Surfaced in tool logs."),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await unfreezeFile(args), null, 2) }],
  }),
);

server.tool(
  "sweep_legacy_backups",
  "One-time migration/cleanup that consolidates scattered 'backup' files into the project's backups/ folder. Natural-language triggers: 'organize backups', 'consolidate backup files', 'clean up backup clutter', 'migrate legacy backups'. Dry-run by default; set confirm:true to move. Only HIGH-confidence matches are moved unless aggressive:true (MEDIUM matches like backup-service.ts may be production code — opt-in required). Recognizes: *.bak / *.backup / *.old extensions, _backup or -backup suffixes, backup- or old_backup_ prefixes, and backup_<timestamp> filenames.",
  {
    workspace: z.string().optional().describe("Absolute path. Defaults to the MCP server's cwd."),
    confirm: z.boolean().optional().describe("Required to actually move files. Default false → dry-run preview."),
    aggressive: z.boolean().optional().describe("Also move MEDIUM-confidence matches (filenames containing 'backup' without strict pattern). Default false."),
    dest: z.string().optional().describe("Destination directory. Defaults to <workspace>/backups/legacy-sweep-<timestamp>."),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await sweepLegacyBackups(args), null, 2) }],
  }),
);

server.tool(
  "init_project",
  "Readiness report for a workspace: validates required .env vars, locates the md-policy.py hook, checks if the claude-memory MCP server is registered in Claude Code settings, and confirms dist/ is built. Returns overall='ready'|'partial'|'not_ready' with per-check fix instructions.",
  {
    workspace: z.string().optional().describe("Absolute path. Defaults to the MCP server's cwd (typically the current Claude Code project)."),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await initProject(args), null, 2) }],
  }),
);

server.tool(
  "refactor_guard",
  "Multi-stack refactor safety net. Actions: plan (scan imports/exports/parts for TS/JS/Dart/Py via language-specific regex — heuristic, not a full parser); gate (run the project's compiler check — flutter analyze / tsc --noEmit / cargo check / go vet / py_compile — auto-selected from project type markers); rollback (restore a file from the hook-managed backup-index). Natural-language triggers: 'run the build check', 'does it still compile?', 'check for regressions', 'rollback that edit', 'restore from backup'. After any destructive refactor, run action:gate; if it fails, run action:rollback to restore.",
  {
    action: z.enum(["plan", "gate", "rollback"]),
    paths: z.array(z.string()).optional(),
    workspace: z.string().optional(),
    file: z.string().optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await refactorGuard(args as never), null, 2) }],
  }),
);

server.tool(
  "analyze_regression",
  "Compare a broken file against its most recent N backups and surface the closest-matching prior snapshot. Natural-language triggers: 'what did I break?', 'diff against the last good version', 'find the regression', 'which backup should I restore?'. Returns an edit-distance summary per backup and identifies the smallest-delta candidate as 'closest_prior' — usually the right restore target.",
  {
    file: z.string(),
    backups_to_compare: z.number().int().positive().max(10).optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await analyzeRegression(args), null, 2) }],
  }),
);

server.tool(
  "delegate_task",
  "Orchestrator pattern: emit a canonical worker sub-agent prompt for a task. Natural-language triggers: 'delegate this', 'spawn a worker', 'send to sub-agent', 'offload this task'. The returned 'prompt' field plugs into the Agent tool — every delegation carries the same contract: do the work → refactor_guard({action:'gate'}) → rollback on failure → return a 2-paragraph synthesis with strict no-raw-content caps. Use this when the Orchestrator is running the session and should keep its context clean by delegating edits/research/bash to workers.",
  {
    title: z.string().min(1),
    instructions: z.string().min(1),
    target_files: z.array(z.string()).optional(),
    workspace: z.string().optional(),
    run_gate: z.boolean().optional(),
    allow_rollback: z.boolean().optional(),
    synthesis_word_limit: z.number().int().positive().max(1000).optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await delegateTask(args), null, 2) }],
  }),
);

server.tool(
  "sync_artefacts",
  "Refresh the project's README 'Recent Progress' + '🗺️ File Architecture' sections AND project_file_architecture.md — without the archive / resume-prompt side effects of session_end. Natural-language triggers: 'sync docs', 'refresh architecture', 'update the readme tree', 'after-worker sync'. Orchestrator calls this after a worker sub-agent reports success so the Mermaid diagram stays the source of truth for planning. Use manage_backlog({action:'session_end'}) instead at the actual end of a working session.",
  {
    project_id: projectIdSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await syncArtefacts(args), null, 2) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
