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
import { currentProjectId } from "./project.js";

const server = new McpServer({
  name: "claude-memory-mcp",
  version: "0.7.0",
});

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
  "Atomic task backlog stored in Supabase. Done tasks are ARCHIVED (moved to archive_backlog) rather than deleted. Actions: add, list, update, prune_done (archive done rows), archive_list (view archived), session_end (Progress Report + archive + next-task + resume prompt). Resume prompt format: 'search_memory({ query: \"Active Backlog\", project_id: \"<id>\" }) -> Reviewing pending tasks. Next up: <title>.'",
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
  "Clear or re-assert the Hard Stop / Manual Test Gate. Call with success:true after manually validating the most recent code change. The gate is enforced by the md-policy.py hook — without the hook installed, the gate is advisory only.",
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
  "Manually raise the verification gate (typically after a risky edit or a tool called that the user must confirm).",
  {
    tool: z.string(),
    file: z.string(),
    reason: z.string().optional(),
  },
  async (args) => {
    await raisePendingVerification({
      tool: args.tool,
      file: args.file,
      reason: args.reason,
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
  "System diagnostics: Supabase reachability (memory_chunks count), Ollama reachability, and required-model presence (moondream + nomic-embed-text). Returns overall='healthy'|'degraded'|'down' with per-check latency.",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await checkSystemHealth(), null, 2) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
