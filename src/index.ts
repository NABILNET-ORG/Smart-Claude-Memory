#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { syncLocalMemory } from "./tools/sync.js";
import { searchMemory } from "./tools/search.js";
import { saveMemory } from "./tools/save.js";
import { manageBacklog } from "./tools/backlog.js";
import { checkCodeHygiene } from "./tools/hygiene.js";
import { confirmVerification, raisePendingVerification } from "./tools/verification.js";
import { checkRuleConflicts } from "./tools/conflict.js";
import { summarizeMemoryFile } from "./tools/summarize.js";
import { indexImage } from "./tools/image.js";
import { checkSystemHealth } from "./tools/health.js";
import { initProject, sweepLegacyBackups, legacyBackupSummary } from "./tools/setup.js";
import { listFrozen, freezeFile, unfreezeFile } from "./tools/policy.js";
import { batchFreezePatterns } from "./tools/batch-freeze-patterns.js";
import { refactorGuard } from "./tools/refactor.js";
import { analyzeRegression } from "./tools/verification.js";
import { delegateTask, syncArtefacts } from "./tools/orchestrator.js";
import { upgradeConstitutionBlock } from "./tools/sovereign-constitution.js";
import {
  packageSkill,
  packageSkillInputShape,
  requestSkill,
  requestSkillInputShape,
} from "./tools/skills.js";
import {
  compactTrajectoryHandler,
  compactTrajectoryInputShape,
  getTrajectorySummaryHandler,
  getTrajectorySummaryInputShape,
} from "./tools/compact.js";
import { startCompactor } from "./trajectory/daemon.js";
import { ensureSchema, startKeepAlive, writeFrozenPatternsCache } from "./supabase.js";
import { currentProjectId } from "./project.js";
import { VERSION } from "./version.js";

const server = new McpServer({
  name: "smart-claude-memory-mcp",
  version: VERSION,
});

// Startup diagnostics (stderr — never stdout, which is reserved for JSON-RPC).
// Missing schema is reported loudly with the exact fix command but does not
// block the server from starting: tools that don't touch the missing tables
// (e.g. check_system_health, init_project) still work.
try {
  const report = await ensureSchema();
  if (!report.ok) {
    console.error(`[smart-claude-memory] ${report.message}`);
    console.error(`[smart-claude-memory] Fix: ${report.fix_command}`);
  }
} catch (e) {
  console.error(`[smart-claude-memory] ensureSchema failed: ${(e as Error).message}`);
}

// Keep the Supabase HTTPS pool warm so the first call after idle doesn't
// pay 1-2s of cold-start.
startKeepAlive();

// Start the trajectory compaction daemon (Agentic OS 2026 / AgentDiet).
// Idle compactor: every TRAJECTORY_COMPACTOR_INTERVAL_MS, pulls the next
// batch of bloated memory_chunks rows and compresses them into
// trajectory_summaries. .unref()'d so it never blocks process exit.
startCompactor();

// Export the current frozen_features snapshot to the shared cache file so
// hooks/md-policy.py can read it without hitting Supabase per tool call.
try {
  const c = await writeFrozenPatternsCache();
  if (!c.ok && c.warning) console.error(`[smart-claude-memory] ${c.warning}`);
} catch (e) {
  console.error(`[smart-claude-memory] frozen-pattern cache init failed: ${(e as Error).message}`);
}

// Read-only legacy-backup summary — runs asynchronously so it never blocks
// startup. Logs count + examples on stderr; actual moves require the
// sweep_legacy_backups tool with confirm:true.
void (async () => {
  try {
    const summary = await legacyBackupSummary(process.cwd());
    if (summary.total > 0) {
      console.error(
        `[smart-claude-memory] Legacy backup scan: ${summary.total} candidate(s) — ` +
          `${summary.high} high-confidence, ${summary.medium} medium. ` +
          `Run sweep_legacy_backups to preview; pass confirm:true to move.`,
      );
      for (const ex of summary.top_examples) console.error(`  ${ex}`);
    }
  } catch (e) {
    console.error(`[smart-claude-memory] legacy backup scan failed: ${(e as Error).message}`);
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
  "Dual-scope semantic search over the current project's chunks AND the reserved 'GLOBAL' Knowledge Vault. Intent routing: 'archive'/'completed tasks'/'done tasks' → archive_backlog rows (mode:'archive'); 'Active Backlog'/'pending tasks'/'what's next' → active cloud_backlog rows (mode:'backlog'); everything else → vector search over memory_chunks (mode:'semantic'). Default behavior dual-scopes the search across the current project_id and the reserved 'GLOBAL' scope; pass `include_global: false` to restrict to the current project only. Archived tasks are NEVER mixed into semantic results unless 'archive' is in the query. Optional metadata_filter (JSONB containment, e.g. {\"type\":\"DECISION\"}) is applied via the GIN(jsonb_path_ops) index BEFORE vector ranking; project_id (plus the opt-in 'GLOBAL' fan-out) remains the structural tenancy guard.",
  {
    query: z.string(),
    limit: z.number().int().positive().max(20).optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    project_id: projectIdSchema,
    metadata_filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "JSONB containment filter against memory_chunks.metadata. Common shape: {type:'DECISION'|'PATTERN'|'ERROR'|'LOG'} or {type:'ERROR', status:'fixed'}. Matches Postgres `@>`.",
      ),
    include_global: z
      .boolean()
      .optional()
      .describe(
        "Default true. When true, the search dual-scopes across the current project_id AND the reserved 'GLOBAL' bucket (universal patterns / lessons-learned visible to every project). Pass false to restrict to project_id only.",
      ),
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchMemory(args), null, 2) }] }),
);

server.tool(
  "save_memory",
  "Persist a single typed memory into the current project's namespace. Categorize the memory via metadata.type: DECISION (architectural choices + rationale), PATTERN (code standards / Rule 5–8 enforcement), ERROR (bug post-mortems + fixes), LOG (general session progress). Always provide metadata.type unless the memory is genuinely uncategorizable. Optional metadata.status / metadata.context_id and any additional pass-through keys are stored verbatim and become filterable via search_memory's metadata_filter (GIN-indexed JSONB containment). Set metadata.is_global=true ONLY for universal Arch-Patterns that apply to ALL projects (e.g., universal architectural decisions, multi-project bug fixes); NEVER for project-specific logic. When is_global=true, you MUST also set metadata.global_rationale (one- or two-sentence justification of the universal truth) — this is the Sovereign Vetting gate. Apply the Cross-Project Test: if the current project were deleted tomorrow, would this memory still be a gold-standard reference for others? If no, keep it local. Global rows are stored under project_id='GLOBAL' (override regardless of explicit project_id arg) and surface in dual-scope search across all projects. The is_global flag and global_rationale are preserved inside the persisted metadata jsonb for audit/traceability.",
  {
    content: z.string().min(1),
    project_id: projectIdSchema,
    file_origin: z
      .string()
      .optional()
      .describe(
        "Source key for upsert dedup. Defaults to 'inline:<sha256(content).slice(0,12)>' so callers can omit it for one-off saves.",
      ),
    chunk_index: z.number().int().nonnegative().optional(),
    metadata: z
      .object({
        type: z.enum(["DECISION", "PATTERN", "ERROR", "LOG"]).optional(),
        status: z.string().optional(),
        context_id: z.string().optional(),
        is_global: z
          .boolean()
          .optional()
          .describe(
            "If true, the memory is saved to the GLOBAL vault. STRICT RULE: Only use this for Arch-Patterns that apply to ALL projects (e.g., universal architectural decisions, multi-project bug fixes). NEVER use for project-specific logic. When true, you MUST include a 'global_rationale' field in the metadata explaining why this is a universal truth. Cross-Project Test: if the current project were deleted tomorrow, would this memory still be a gold-standard reference for others? If no, keep it local.",
          ),
        global_rationale: z
          .string()
          .optional()
          .describe(
            "REQUIRED when is_global=true. One- or two-sentence justification of why this memory is a universal truth — not project-specific. Persisted in metadata jsonb for audit.",
          ),
      })
      .catchall(z.unknown())
      .optional()
      .describe(
        "Sovereign Taxonomy: type ∈ {DECISION, PATTERN, ERROR, LOG}. Set is_global:true ONLY for universal Arch-Patterns that apply to ALL projects, and you MUST also supply metadata.global_rationale explaining the universal truth (Sovereign Vetting). Pass-through keys are preserved.",
      ),
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await saveMemory(args), null, 2) }] }),
);

server.tool(
  "upgrade_constitution",
  "Deterministically upgrade the workspace CLAUDE.md to the canonical Sovereign Memory Protocol template via regex-anchored block replacement. Pre/post project-specific content is preserved byte-for-byte. dry_run:true returns the analysis without writing. force:true overwrites even when the existing block has local customizations (block hash differs from the registered canonical hash). Returns a discriminated union with `action`: already_synced | synced | drift_detected | block_not_found | not_found | error.",
  {
    workspace: z
      .string()
      .optional()
      .describe(
        "Absolute path to the workspace whose CLAUDE.md should be upgraded. Defaults to process.cwd().",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "When true, return what the upgrade would do without modifying any files.",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "When true, overwrite the constitution block even if its hash does not match a registered canonical hash. Use only when you have reviewed the local customizations and intend to discard them.",
      ),
  },
  async (args) => {
    const ws = args.workspace ?? process.cwd();
    const result = await upgradeConstitutionBlock(ws, {
      dry_run: args.dry_run,
      force: args.force,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Agentic OS 2026 — JIT Skill Retrieval (SCM-S17-D1) ────────────────────

server.tool(
  "package_skill",
  "Persist an executable Skill — an ordered list of steps the agent can follow when a matching task arrives — into the dedicated agent_skills relation (NOT memory_chunks; skills are executable artefacts, not retrieval notes). Identity key is (project_id, name); re-packaging the same name bumps the version while preserving telemetry (frequency_used, success_rate, last_invoked_at). The description is embedded for semantic retrieval by request_skill; the steps array is stored verbatim and returned as-is at request time. Set is_global=true ONLY for procedures that apply to ALL projects (e.g., 'create a git commit', 'open a PR'); the row routes to project_id='GLOBAL' regardless of any explicit project_id. Cross-Project Test: if the current project were deleted tomorrow, would this skill still be a gold-standard reference for others? If no, keep it local. Skills are NEVER preloaded into the LLM context — they are injected on demand by request_skill.",
  packageSkillInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await packageSkill(args), null, 2) }],
  }),
);

server.tool(
  "request_skill",
  "Just-In-Time Skill Retrieval. Semantic search over the agent_skills relation, dual-scoped across the current project_id AND the reserved 'GLOBAL' skill vault by default. Returns up to k skills ranked by a weighted blend of cosine similarity (0.85) and recency decay (0.15) over last_invoked_at — a stale-but-relevant skill still beats a recent-but-irrelevant one. Returning the full `steps` payload is INTENTIONAL: this is the JIT injection. Skills are NEVER preloaded into the system prompt; the agent calls request_skill exactly when it needs the procedure for the current task, gets the executable steps verbatim, and follows them. Pass include_global=false to restrict to the current project. record_telemetry=true (default) fire-and-forget bumps frequency_used / last_invoked_at / success_rate for every hit so the ranking surface adapts to actual usage; pass false for read-only probes.",
  requestSkillInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await requestSkill(args), null, 2) }],
  }),
);

// ─── Agentic OS 2026 — Trajectory Compaction (SCM-S18-D1) ──────────────────

server.tool(
  "compact_trajectory",
  "Compact a bloated memory_chunks row into a ~50-token semantic summary via the heuristic+LLM pipeline. With chunk_id: targets one row. Without chunk_id: runs one daemon tick over the next batch. dry_run skips persistence.",
  compactTrajectoryInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await compactTrajectoryHandler(args), null, 2) },
    ],
  }),
);

server.tool(
  "get_trajectory_summary",
  "Read back the compressed summary for a given memory_chunks row id, with original/compressed token counts and compression ratio. Returns {found:false} if no summary exists.",
  getTrajectorySummaryInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await getTrajectorySummaryHandler(args), null, 2) },
    ],
  }),
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
  "batch_freeze_patterns",
  "Hydrate frozen-patterns.json from explicit globs and/or a markdown rule-file in a single call. Natural-language triggers: 'batch freeze', 'hydrate frozen patterns', 'freeze from rules file', 'onboard policies', 'bulk freeze patterns'. Pass `paths` for inline globs/paths, `from_rule_file` to extract patterns from a markdown section (default '## Frozen Patterns'), or both. Each cache entry stores { pattern, source, added_at } — patterns are not eagerly expanded; the same dedup key (trimmed pattern string) is used as freeze_file. First writer wins. Set `dry_run:true` to preview the new patterns without touching disk.",
  {
    paths: z.array(z.string().min(1)).optional().describe("Explicit globs or paths to freeze. Stored as-given (no eager expansion)."),
    from_rule_file: z.string().optional().describe("Markdown file to extract patterns from. Reads under the `section` heading until the next markdown heading."),
    section: z.string().optional().describe("Markdown heading that begins the pattern list. Default: '## Frozen Patterns'. Comparison is exact-string after rstrip."),
    dry_run: z.boolean().optional().describe("Default false. When true, returns prospective patterns + counts without writing to disk or Supabase."),
    source_tag: z.string().optional().describe("Override the `source` field stored on each new entry. Defaults to the rule-file path or 'inline' for `paths`."),
    project_id: projectIdSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await batchFreezePatterns(args), null, 2) }],
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
  "Readiness report for a workspace: validates required .env vars, locates the md-policy.py hook, checks if the Smart Claude Memory MCP server is registered in Claude Code settings, and confirms dist/ is built. Returns overall='ready'|'partial'|'not_ready' with per-check fix instructions. On boot, init_project may return a recommendation with id 'sovereign_purge'. When present, the Agent MUST ask the user for explicit YES/NO permission before acting. On YES, execute the steps in order: create docs/scm-memory/, move bloated CLAUDE.md to docs/scm-memory/legacy_claude.md, copy the hidden MEMORY.md to docs/scm-memory/legacy_memory.md if found, call sync_local_memory({ force: true }) to vectorize, then call ensureSovereignConstitution({ force: true }) to regenerate a clean v2.1 CLAUDE.md. Never act without user consent.",
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
  "Orchestrator pattern (v1.1.0 — Autonomous Self-Healing): emit a canonical worker sub-agent prompt for a task. Natural-language triggers: 'delegate this', 'spawn a worker', 'send to sub-agent', 'offload this task'. The returned 'prompt' field plugs into the Agent tool — every delegation carries the contract: do the work → refactor_guard({action:'gate'}) → if red, diagnose via analyze_regression against backups and fix locally (up to max_healing_attempts), re-gate → rollback only if healing exhausts → return a 2-paragraph synthesis with strict no-raw-content caps. Keeps the Orchestrator's context clean of failed-compile churn.",
  {
    title: z.string().min(1),
    instructions: z.string().min(1),
    target_files: z.array(z.string()).optional(),
    workspace: z.string().optional(),
    run_gate: z.boolean().optional(),
    allow_rollback: z.boolean().optional(),
    self_heal: z.boolean().optional(),
    max_healing_attempts: z.number().int().positive().max(5).optional(),
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
