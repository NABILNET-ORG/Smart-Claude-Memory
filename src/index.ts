#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { syncLocalMemory } from "./tools/sync.js";
import { searchMemory } from "./tools/search.js";
import { updateRule } from "./tools/update-rule.js";
import { currentProjectId } from "./project.js";

const server = new McpServer({
  name: "claude-memory-mcp",
  version: "0.4.0",
});

const projectIdSchema = z
  .string()
  .optional()
  .describe(
    `Project namespace override. Defaults to the slugified current working directory ('${currentProjectId}'). ` +
      `Memory is strictly isolated per project_id.`,
  );

server.tool(
  "sync_local_memory",
  "Scan MEMORY_ROOTS for .md files, hash-gate, chunk, embed via Ollama, bulk-upsert to Supabase (100/batch). Supports incremental sync (skip unchanged), force re-embed, and optional auto_purge with a mandatory dry-run preview and an all-or-nothing verify-before-delete contract. CLAUDE.md, MEMORY.md, README.md, LICENSE* and CHANGELOG* are never deleted.",
  {
    roots: z
      .array(z.string())
      .optional()
      .describe("Override MEMORY_ROOTS from .env with an explicit list of folders."),
    project_id: projectIdSchema,
    force: z
      .boolean()
      .optional()
      .describe("Re-embed every file regardless of hash. Default false."),
    auto_purge: z
      .boolean()
      .optional()
      .describe(
        "After sync: if true AND confirm is false (default), return a dry-run preview of which files would be deleted. If true AND confirm is true, verify every file's (project_id, file_origin, file_hash) in Supabase, write a backup ZIP, then delete. Default false.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required alongside auto_purge: true to actually delete. Safety belt — without it, auto_purge runs as a dry-run preview only. Default false.",
      ),
  },
  async (args) => {
    const result = await syncLocalMemory(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "search_memory",
  "Semantic search over memory chunks belonging to the current project ONLY. Other projects' memory is never returned.",
  {
    query: z.string().describe("Natural language query"),
    limit: z.number().int().positive().max(20).optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    project_id: projectIdSchema,
  },
  async (args) => {
    const result = await searchMemory(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "update_rule",
  "Upsert a single rule/chunk in the current project's namespace without re-syncing files.",
  {
    file_origin: z.string().describe("Logical source identifier, e.g. 'rules.md' or a full path."),
    chunk_index: z.number().int().nonnegative(),
    content: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    project_id: projectIdSchema,
  },
  async (args) => {
    const result = await updateRule(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
