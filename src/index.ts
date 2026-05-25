#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { syncLocalMemory } from "./tools/sync.js";
import { pruneMemory } from "./tools/prune.js";
import { searchMemory } from "./tools/search.js";
import {
  listGlobalPatterns,
  listGlobalPatternsInputShape,
} from "./tools/list-global-patterns.js";
import { saveMemory } from "./tools/save.js";
import { manageBacklog } from "./tools/backlog.js";
import { checkCodeHygiene } from "./tools/hygiene.js";
import { confirmVerification, raisePendingVerification } from "./tools/verification.js";
import { checkRuleConflicts } from "./tools/conflict.js";
import { summarizeMemoryFile } from "./tools/summarize.js";
import { indexImage } from "./tools/image.js";
import { checkSystemHealth } from "./tools/health.js";
import { systemDashboardHandler, renderDashboardMarkdown } from "./tools/system_dashboard.js";
import { initProject, sweepLegacyBackups, legacyBackupSummary } from "./tools/setup.js";
import { listFrozen, freezeFile, unfreezeFile } from "./tools/policy.js";
import { batchFreezePatterns } from "./tools/batch-freeze-patterns.js";
import { refactorGuard } from "./tools/refactor.js";
import { analyzeRegression } from "./tools/verification.js";
import { delegateTask, syncArtefacts } from "./tools/orchestrator.js";
import { upgradeConstitutionBlock } from "./tools/sovereign-constitution.js";
import { metadataFilterSchema } from "./tools/shared-schemas.js";
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
import {
  listSkillCandidates,
  listSkillCandidatesInputShape,
  composeSkillCandidate,
  composeSkillCandidateInputShape,
  promoteSkillCandidate,
  promoteSkillCandidateInputShape,
  rejectSkillCandidate,
  rejectSkillCandidateInputShape,
} from "./tools/sleep.js";
import {
  checkpointCreateHandler,
  checkpointCreateInputShape,
  checkpointCommitHandler,
  checkpointCommitInputShape,
  checkpointRollbackHandler,
  checkpointRollbackInputShape,
  checkpointListHandler,
  checkpointListInputShape,
} from "./tools/checkpoint.js";
import {
  listCurriculumTasks,
  listCurriculumTasksInputShape,
  pullCurriculumTask,
  pullCurriculumTaskInputShape,
  applyCurriculumTask,
  applyCurriculumTaskInputShape,
  rejectCurriculumTask,
  rejectCurriculumTaskInputShape,
} from "./tools/curriculum.js";
import {
  listGraduationCandidates,
  listGraduationCandidatesInputShape,
  composeGlobalRationale,
  composeGlobalRationaleInputShape,
  confirmPromotion,
  confirmPromotionInputShape,
  rejectGraduation,
  rejectGraduationInputShape,
} from "./tools/graduation.js";
import {
  upsertKgNode,
  upsertKgNodeInputShape,
  upsertKgEdge,
  upsertKgEdgeInputShape,
  kgHybridSearch,
  kgHybridSearchInputShape,
  listKgNodes,
  listKgNodesInputShape,
  listKgEdges,
  listKgEdgesInputShape,
} from "./tools/kg.js";
import {
  startTask,
  startTaskInputShape,
  endTask,
  endTaskInputShape,
  getTaskBudget,
  getTaskBudgetInputShape,
  getDaemonBudget,
  getDaemonBudgetInputShape,
  resetDaemonBudgetTool,
  resetDaemonBudgetInputShape,
} from "./tools/budget.js";
import { startCompactor } from "./trajectory/daemon.js";
import { startSleepLearner } from "./sleep/daemon.js";
import { startCurriculumDaemon } from "./curriculum/daemon.js";
import { startGraduationDaemon } from "./graduation/daemon.js";
import { startTelemetryPruner } from "./telemetry/pruner.js";
import { startGraphExtractor } from "./graph/daemon.js";
// M8.3 Task 4 — clustering daemon + tool surface (SCM-S41-D7).
import { startClusteringScanner } from "./clustering/daemon.js";
// Epic G (Session 43 Phase 2) — KG Auto-Sync file watcher daemon.
import { startFileWatcher } from "./sync/file-watcher-daemon.js";
import {
  listSupernodes,
  listSupernodesInputShape,
  listClusterMembers,
  listClusterMembersInputShape,
  triggerClustering,
  triggerClusteringInputShape,
} from "./clustering/clusters.js";
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

// Start the sleep learning daemon (Agentic OS 2026 / Mission 3).
// Idle miner: every SLEEP_LEARNER_INTERVAL_MS, mines clusters from
// trajectory_summaries ⋈ archive_backlog and emits skill_candidates.
// .unref()'d so it never blocks process exit.
startSleepLearner();

// Start the curriculum daemon (Agentic OS 2026 / Mission 5 / SCM-S21-D1).
// Deterministic queuer: every CURRICULUM_INTERVAL_MS, scans coverage,
// rollback hotspots, and stale skill_candidates and enqueues
// curriculum_tasks rows. Contains ZERO generative AI — Boundary Invariant #1
// (ARCHITECTURE.md §4.7). .unref()'d so it never blocks process exit.
startCurriculumDaemon();

// Start the graduation daemon (Agentic OS 2026 / Mission 7 / SCM-S33-D1).
// Deterministic propose-only queuer: every GRADUATION_INTERVAL_MS, scans
// agent_skills for production-validated rows (frequency_used >= 10,
// success_rate >= 0.90, age >= 14 days) and INSERTs skill_graduations
// at state='proposed' with frozen telemetry snapshot. Contains ZERO
// generative AI and NEVER calls apply_graduation — Boundary Invariant #1
// (ARCHITECTURE.md §4.9). Sovereign Vetting is enforced structurally: the
// daemon can NEVER mint is_global=true; that's the human-gated
// confirm_promotion → apply_graduation RPC path only.
startGraduationDaemon();

// Start the telemetry retention pruner (Backlog #124 / ARCHITECTURE.md §4.8).
// Rolling DELETE: every TELEMETRY_PRUNER_INTERVAL_MS, prunes daemon_telemetry
// rows older than TELEMETRY_PRUNER_RETENTION_DAYS. .unref()'d so it never
// blocks process exit.
startTelemetryPruner();

// Start the knowledge-graph extractor daemon (M8.1 Phase 1).
// Idle miner: every SCM_GRAPH_EXTRACTOR_INTERVAL_MS, pulls memory_chunks
// rows not yet anchored in kg_nodes and mines primary + FILE/DECISION
// reference nodes/edges via src/graph/extractor.ts. Pure deterministic
// extractor — ZERO generative AI. .unref()'d so it never blocks process exit.
startGraphExtractor();

// M8.3 clustering_scanner (SCM-S41-D5/D7). Per-project round-robin:
// kg_nodes.embedding → k-means → kg_knn_pairs → per-supernode Louvain →
// bulk UPSERT into kg_node_clusters. ARM-gated (delta=0 registers the
// daemon in daemon_budget_buckets). .unref()'d. Universal — discovers
// projects via SELECT DISTINCT project_id FROM kg_nodes; never hardcoded.
startClusteringScanner();

// Epic G — KG Auto-Sync (Session 43 Phase 2). fs.watch over MEMORY_ROOTS
// debounces local file changes and fires syncLocalMemory automatically;
// the existing graph_extractor daemon then folds the new chunks into
// kg_nodes on its own tick. Opt out with SCM_FILE_WATCHER_ENABLED=false.
// No-ops cleanly when MEMORY_ROOTS is empty.
startFileWatcher();

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
  "prune_memory",
  "Delete memory_chunks rows for explicit on-disk file paths whose source files have been removed locally. Pays off the README:489 deferral. Safety: explicit_paths is REQUIRED (no wildcard scans), confirm:false is the default and returns a dry-run preview, inline:* file_origins are always skipped (they have no disk file), project_id='GLOBAL' is rejected. Every confirmed delete is mirrored to a manifest under ~/.claude-memory/prune-backups/<stamp>-<project>/manifest.json for forensic reversal via re-sync.",
  {
    explicit_paths: z.array(z.string()).min(1).describe("Required. File paths whose memory_chunks rows should be considered for deletion. No wildcards — every path must be supplied explicitly."),
    project_id: projectIdSchema,
    confirm: z.boolean().optional().describe("Default false (dry-run). Set true to actually delete confirmed-orphan rows."),
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await pruneMemory(args), null, 2) }] }),
);

server.tool(
  "search_memory",
  "Dual-scope semantic search over the current project's chunks AND the reserved 'GLOBAL' Knowledge Vault. Intent routing: 'archive'/'completed tasks'/'done tasks' → archive_backlog rows (mode:'archive'); 'Active Backlog'/'pending tasks'/'what's next' → active cloud_backlog rows (mode:'backlog'); everything else → vector search over memory_chunks (mode:'semantic'). Default behavior dual-scopes the search across the current project_id and the reserved 'GLOBAL' scope; pass `include_global: false` to restrict to the current project only. Archived tasks are NEVER mixed into semantic results unless 'archive' is in the query. Optional metadata_filter (JSONB containment, e.g. {\"type\":\"DECISION\"}) is applied via the GIN(jsonb_path_ops) index BEFORE vector ranking; project_id (plus the opt-in 'GLOBAL' fan-out) remains the structural tenancy guard.",
  {
    query: z.string(),
    limit: z.number().int().positive().max(20).optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    project_id: projectIdSchema,
    metadata_filter: metadataFilterSchema,
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
  "list_global_patterns",
  "Browse-only enumeration of the reserved 'GLOBAL' Knowledge Vault — universal patterns / decisions / errors / logs visible to every project. Deterministic SQL read (no embedding cost). Filter via metadata_filter (same JSONB-containment shape as search_memory). Pagination: offset + limit (default 10, max 50), sorted by created_at DESC. Tiered output: default returns a content_preview (≤120 chars); pass include_content:true for the full content field. Distinct from search_memory({ include_global: true }) — that's 'find by meaning' (semantic), this is 'enumerate by attribute' (deterministic).",
  listGlobalPatternsInputShape,
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await listGlobalPatterns(args), null, 2),
      },
    ],
  }),
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

// ─── Agentic OS 2026 — Sleep Learning (SCM-S19-D1) ─────────────────────────

server.tool(
  "list_skill_candidates",
  "Review queue for the Sleep Learning miner. SELECT from skill_candidates filtered by project_id and optional lifecycle state ('mined' = pending review, 'promoted' = already minted into agent_skills, 'rejected' = vetoed). Ordered by frequency DESC so the highest-signal patterns surface first. Pass state='mined' to inspect what the idle daemon proposed; pass no state to audit the full history.",
  listSkillCandidatesInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listSkillCandidates(args), null, 2) }],
  }),
);

server.tool(
  "compose_skill_candidate",
  "SINGLE BRAIN entry point. SCM-S22-D1 (M3 Proposer Remediation): the sleep daemon now stubs candidates with NULL proposed_name / proposed_steps / model — generative naming and step extraction are exclusively Orchestrator (Claude) work. UPDATEs skill_candidates SET proposed_name, proposed_steps WHERE id=? AND state='mined' (promoted/rejected rows are immutable). model is stamped 'orchestrator:claude' for audit. MUST be called before promote_skill_candidate — promote_candidate_to_skill RPC enforces NOT-NULL and will raise otherwise. ⚠ M5 CRASH-CATCH: when a curriculum_tasks row has linked_candidate_id set, the Orchestrator MUST call compose_skill_candidate BEFORE apply_curriculum_task — the atomic apply RPC fires promote_candidate_to_skill in the same transaction, so a null name/steps aborts the whole flow.",
  composeSkillCandidateInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await composeSkillCandidate(args), null, 2) }],
  }),
);

server.tool(
  "promote_skill_candidate",
  "Mint a composed skill_candidate into agent_skills via the promote_candidate_to_skill RPC. Identity (project_id, proposed_name) reuses package_skill's upsert path: re-promoting the same name bumps the version while preserving telemetry. Description defaults to proposed_name + a digest of proposed_steps; pass description to override. trigger_keywords mirrors package_skill for the M1 detector. PRECONDITION: candidate must have non-null proposed_name AND proposed_steps — call compose_skill_candidate first (the daemon stubs with NULLs under the Single Brain mandate).",
  promoteSkillCandidateInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await promoteSkillCandidate(args), null, 2) }],
  }),
);

server.tool(
  "reject_skill_candidate",
  "Veto a mined skill_candidate. Sets state='rejected' and persists rejection_reason for audit. The (project_id, pattern_hash) pair stays rejected across future mining runs — re-mining the same cluster will not resurrect it.",
  rejectSkillCandidateInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await rejectSkillCandidate(args), null, 2) }],
  }),
);

// ─── Agentic OS 2026 — Transactional Workflow Checkpoints (M4 / Phase B) ───

server.tool(
  "checkpoint_create",
  "Open a workflow_checkpoints row (status='open') anchoring one step of a (possibly skill-mediated) multi-step task. parent_id null = root step; pass parent_id to chain steps into an ordered tree whose terminal-committed source_chunk_id is the replay anchor. When parent_id is null AND backlog_task_id is supplied, the new checkpoint's id is stamped into cloud_backlog.metadata.checkpoint_root_id so archive_done_backlog can populate archive_backlog.chunk_id at archive time — completing the M2→M3 provenance link.",
  checkpointCreateInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await checkpointCreateHandler(args), null, 2) },
    ],
  }),
);

server.tool(
  "checkpoint_commit",
  "Mark a checkpoint committed and pin source_chunk_id (the memory_chunks row whose trajectory_summaries entry is the replay anchor). Only rows currently in status='open' transition — re-committing is a no-op error so concurrent paths fail fast. The pinned chunk powers restoreFrom() / get_trajectory_summary replay surfaces and feeds archive_backlog.chunk_id at archive time.",
  checkpointCommitInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await checkpointCommitHandler(args), null, 2) },
    ],
  }),
);

server.tool(
  "checkpoint_rollback",
  "Mark a checkpoint rolledback with a non-empty reason. Walks the parent_id chain via terminal_committed_checkpoint to surface the deepest committed ancestor's source_chunk_id (the replay anchor) so the caller can drive restoreFrom() at the application layer. Rolledback rows are read directly by the M3 Sleep Learner miner as negative signals — no separate signals table is needed.",
  checkpointRollbackInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await checkpointRollbackHandler(args), null, 2) },
    ],
  }),
);

server.tool(
  "checkpoint_list",
  "List workflow_checkpoints rows scoped to the current project_id (or an explicit override). Optional filters: status ∈ {open, committed, rolledback}, skill_id (agent_skills.id). Ordered by id DESC (newest first). Default limit 20, max 100. Use to inspect mid-flight workflows, audit rollback churn, or surface terminal-committed anchors for ad-hoc replay.",
  checkpointListInputShape,
  async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await checkpointListHandler(args), null, 2) },
    ],
  }),
);

// ─── Agentic OS 2026 — M5 Autonomous Curriculum (SCM-S21-D1) ──────────────

server.tool(
  "list_curriculum_tasks",
  "Inspect the M5 curriculum queue. SELECT from curriculum_tasks scoped to project_id (default: current). Optional filters: status ∈ {queued, pulled, attempted, verified, rejected, expired}, kind ∈ {test_gap, refactor, rollback_repro}. Ordered by created_at DESC. Default limit 20, max 100. Read-only — never mutates the queue.",
  listCurriculumTasksInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listCurriculumTasks(args), null, 2) }],
  }),
);

server.tool(
  "pull_curriculum_task",
  "Atomic claim of the next queued curriculum task. Wraps pull_next_curriculum_task RPC (FOR UPDATE SKIP LOCKED) — multi-session safe; two orchestrators never receive the same row. Prioritizes auto-promote-eligible tasks (linked_candidate_id IS NOT NULL) FIFO. Stamps pulled_by_session_id + pulled_at and flips status='pulled'. Returns {claimed:false, task:null} when the queue is empty. ORCHESTRATOR-ONLY entry point — the daemon never calls this.",
  pullCurriculumTaskInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await pullCurriculumTask(args), null, 2) }],
  }),
);

server.tool(
  "apply_curriculum_task",
  "Verification-gated finalize. On success=true: asserts (1) ~/.claude-memory/verification-pending.json is CLEAR (override with bypass_verification_gate:true for tooling); (2) checkpoint_id references a workflow_checkpoints row with status='committed' in the same project. Atomic SQL transaction flips the task to 'verified' AND — if linked_candidate_id was set by the scanner (stale-candidate signal) — fires promote_candidate_to_skill in the same transaction. This is the ONLY M5-permitted auto-promote call site. On success=false: flips status='rejected'; no checkpoint or gate validation required. ⚠ M5 CRASH-CATCH (SCM-S22-D1): if linked_candidate_id is set on the task, the Orchestrator MUST call compose_skill_candidate(candidate_id, proposed_name, proposed_steps) BEFORE invoking this tool. The sleep daemon now stubs candidates with NULL proposed_name/proposed_steps (Single Brain mandate); promote_candidate_to_skill enforces NOT-NULL inside the same SQL transaction and will abort the entire apply otherwise.",
  applyCurriculumTaskInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await applyCurriculumTask(args), null, 2) }],
  }),
);

server.tool(
  "reject_curriculum_task",
  "Manual veto. Update curriculum_tasks SET status='rejected', rejection_reason=<reason>. Use when the orchestrator decides the queued stub is not worth executing (e.g. heuristic false-positive, scope changed, file deprecated). Soft-delete: the row stays for audit.",
  rejectCurriculumTaskInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await rejectCurriculumTask(args), null, 2) }],
  }),
);

// ─── Agentic OS 2026 — M7 Skill Graduation (SCM-S33-D1) ───────────────────
// Promotion pipeline: M3 mints local agent_skills. M7 graduates
// production-validated local skills to the GLOBAL vault. Strict separation:
// the graduation_scanner daemon proposes (state='proposed'); the
// Orchestrator drafts global_rationale via compose; a human gates promotion
// via confirm. Apply is a single atomic SQL RPC (apply_graduation) — the
// SOLE call site that mints is_global=true.

server.tool(
  "list_graduation_candidates",
  "Inspect the M7 graduation queue. SELECT from skill_graduations with optional state ∈ {proposed, composed, approved, rejected} and project_id filters. Ordered by created_at DESC. Default limit 10, hard cap 50. Read-only — never mutates. Use to find graduations awaiting compose (state='proposed') or confirm (state='composed').",
  listGraduationCandidatesInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listGraduationCandidates(args), null, 2) }],
  }),
);

server.tool(
  "compose_global_rationale",
  "Persist the Orchestrator-drafted Sovereign Vetting compose output to a 'proposed' graduation row. The Orchestrator (Claude) performs the actual LLM Cross-Project Test reasoning OUTSIDE this handler and passes the verdict ('pass' | 'fail'), evidence (≤120 words on universal vs project-specific), global_rationale (≥10 chars when verdict='pass', null otherwise), and model identifier. Server-side gates: row must be at state='proposed'; verdict='pass' requires global_rationale.trim().length >= 10; race-safe via WHERE state='proposed' guard. On success flips state→'composed'. The Orchestrator MUST follow this with confirm_promotion or reject_graduation — composing does NOT itself promote.",
  composeGlobalRationaleInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await composeGlobalRationale(args), null, 2) }],
  }),
);

server.tool(
  "confirm_promotion",
  "HUMAN-GATED PROMOTION TO GLOBAL. Calls the apply_graduation SQL RPC: atomic clone of the source agent_skill into a new GLOBAL row + UPDATE graduation→state='approved' in ONE transaction. PostgreSQL now() collapses graduation.decided_at and new_skill.created_at to the same microsecond (the C4 atomic-tx proof). Preconditions enforced by the RPC: graduation must be at state='composed' AND proposed_global_rationale length >= 10 AND source skill not already GLOBAL. Telemetry on the GLOBAL clone resets (frequency_used=0, success_rate=1.0); the local source skill is UNTOUCHED. This is the ONLY call site that mints is_global=true outside of save_memory({is_global:true}).",
  confirmPromotionInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await confirmPromotion(args), null, 2) }],
  }),
);

server.tool(
  "reject_graduation",
  "Veto a graduation proposal. TS-only UPDATE: skill_graduations SET state='rejected', rejection_reason=<reason>, decided_at=now() WHERE id=$1 AND state IN ('proposed','composed'). DIVERGES from reject_curriculum_task: a second reject on an already-rejected row returns ok:false (reason='invalid_state_transition') instead of silently overwriting. Rationale: GLOBAL rejection reasons carry audit weight for 'why didn't we promote X' — overwrites would erase that history.",
  rejectGraduationInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await rejectGraduation(args), null, 2) }],
  }),
);

// ─── M8 Phase 3 — Knowledge Graph (Hybrid RAG) ────────────────────────────
// Five tools backed by migration 020_knowledge_graph.sql. The graph layer is
// orthogonal to the vector store: kg_nodes carry their own embedding column,
// kg_edges describe relations, and kg_hybrid_search blends ANN seeds with a
// 1-hop graph expansion. All writes go through SECURITY DEFINER RPCs so the
// idempotency contract lives in SQL, not TS.

server.tool(
  "kg_upsert_node",
  "Insert or update a Knowledge Graph node (M8 Phase 3). Natural key is (project_id, type, label) — re-calling with the same triple updates properties; embedding and source_chunk_id are only overwritten when the caller passes non-null values so existing semantic anchors are preserved. The embedding (if supplied) MUST be a 768-dim float array — the same dim as memory_chunks.embedding. Returns ok:true with the node_id on success.",
  upsertKgNodeInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await upsertKgNode(args), null, 2) }],
  }),
);

server.tool(
  "kg_upsert_edge",
  "Insert or update a Knowledge Graph edge between two nodes (M8 Phase 3). Edges are DIRECTED — source_id → target_id under the named relation. Idempotent on (project_id, source_id, target_id, relation). Self-loops are rejected. Re-calling with the same key updates weight + properties. Returns ok:true with the edge_id on success.",
  upsertKgEdgeInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await upsertKgEdge(args), null, 2) }],
  }),
);

server.tool(
  "kg_hybrid_search",
  "Hybrid RAG retrieval over the M8 Knowledge Graph: (1) ANN nearest-K over kg_nodes.embedding inside the given project_id, (2) 1-hop neighbour expansion through kg_edges (0 hops = seeds only, max 2). Returns { seeds, neighbors } with similarity scores on seeds and edge weights on neighbours so the Orchestrator can blend signals when re-ranking. Use the SAME embedding model as kg_upsert_node — dim is fixed at 768.",
  kgHybridSearchInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await kgHybridSearch(args), null, 2) }],
  }),
);

server.tool(
  "list_kg_nodes",
  "Enumerate Knowledge Graph nodes for a project. Filterable by type or label prefix (ILIKE). Default limit 20, hard cap 200. Ordered by updated_at DESC so the most-recently-touched nodes surface first.",
  listKgNodesInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listKgNodes(args), null, 2) }],
  }),
);

server.tool(
  "list_kg_edges",
  "Enumerate Knowledge Graph edges for a project. Filterable by source_id, target_id, and/or relation. Default limit 20, hard cap 200. Ordered by created_at DESC.",
  listKgEdgesInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listKgEdges(args), null, 2) }],
  }),
);

// ─── v0.5.0 tools ─────────────────────────────────────────────────────────

server.tool(
  "manage_backlog",
  "Atomic task backlog in Supabase. Natural-language triggers: 'add to backlog' / 'add task' → add; 'what's on my backlog' / 'list tasks' → list; 'mark done' / 'mark complete' → update with status:done; 'clean up done' → prune_done (archives, not deletes); 'show archive' / 'what did I finish' → archive_list; 'end session' / 'wrap up' / 'handover' → session_end (writes Progress Report to README.md, writes file-tree to project_file_architecture.md, and returns a 1-line resume prompt); 'backfill chunks' / 'backfill archive' → backfill_archive_chunks (M4 Phase B: populate archive_backlog.chunk_id for legacy rows via terminal_committed_checkpoint or a title+timestamp heuristic; dry_run=true is a pure read). Done tasks are ARCHIVED (moved to archive_backlog), never deleted.\n\n[ZERO-AUTONOMY SESSION TERMINATION RULE — v2.1.11] The Agent is STRICTLY FORBIDDEN from calling manage_backlog({action:'session_end'}) on its own initiative — not after completing a task, not after a 'logical stopping point', not in response to its own perception of context utilization, not ever. session_end is reserved exclusively for explicit human commands such as 'end session', 'wrap up', 'handover', 'session_end now', 'close it out'. Until such a literal command arrives, the Agent leaves the session OPEN and stands ready for the next instruction. No context-percentage heuristic, prompt-cache argument, or '50% window' rationalization overrides this rule. Violation = silent loss of user agency and was the documented anti-pattern that motivated this rule.",
  {
    action: z.enum([
      "add",
      "list",
      "update",
      "prune_done",
      "archive_list",
      "session_end",
      "backfill_archive_chunks",
    ]),
    title: z.string().optional(),
    id: z.number().int().positive().optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    notes: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    dry_run: z.boolean().optional(),
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
  "system_dashboard",
  "Unified read API for daemon telemetry. Returns per-daemon live status (get*Status snapshot), 1h and 24h rollups (runs, errors, items_processed, outcomes={verified,rejected,auto_promoted}), 24h error_rate, last error event, and the last 20 recent run events. Backed by the append-only daemon_telemetry table (migration 016). Inputs: optional window_hours (default 24, max 168), optional daemon filter ('sleep_learner' | 'curriculum_scanner' | 'trajectory_compactor').",
  {
    window_hours: z.number().int().positive().max(168).optional(),
    daemon: z.enum(["sleep_learner", "curriculum_scanner", "trajectory_compactor"]).optional(),
  },
  async (args) => ({
    content: [{ type: "text", text: renderDashboardMarkdown(await systemDashboardHandler(args)) }],
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
  "Orchestrator pattern (v1.1.0 — Autonomous Self-Healing): emit a canonical worker sub-agent prompt for a task. Natural-language triggers: 'delegate this', 'spawn a worker', 'send to sub-agent', 'offload this task'. The returned 'prompt' field plugs into the Agent tool — every delegation carries the contract: do the work → refactor_guard({action:'gate'}) → if red, diagnose via analyze_regression against backups and fix locally (up to max_healing_attempts), re-gate → rollback only if healing exhausts → return a 2-paragraph synthesis with strict no-raw-content caps. Keeps the Orchestrator's context clean of failed-compile churn. Pass optional task_id (from start_task) to gate subagent_depth via the Agentic Resource Manager.",
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
    task_id: z.string().uuid().optional(),
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

// ─── Agentic Resource Manager (SCM-S39-D1, v2.2.2) ────────────────────────

server.tool(
  "start_task",
  "Open a budget task for the Agentic Resource Manager. Returns task_id + frozen_caps (immutable for the task's lifetime). Pass the task_id to delegate_task, compose_skill_candidate, compose_global_rationale, and index_image to gate their LLM-touching paths. Caps default to env (SCM_TASK_CAP_*) or hard-coded fallbacks (100000 anthropic_tokens / 50 ollama_calls / 2 subagent_depth). Enforcement scales with SCM_BUDGET_ENFORCEMENT_MODE (off|warn|enforce).",
  startTaskInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await startTask(args), null, 2) }],
  }),
);

server.tool(
  "end_task",
  "Close a budget task. Returns the task's final usage counters and per-axis burn ratios. Call at the natural end of an Orchestrator workflow (typically as part of manage_backlog({action:'session_end'})) so the burn metrics flow into the system_dashboard rollup.",
  endTaskInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await endTask(args), null, 2) }],
  }),
);

server.tool(
  "get_task_budget",
  "Inspect a budget task's current state — frozen caps, counters, burn ratios. Read-only; safe to call any time. Returns {ok:false, reason:'not_found'} when the task_id is unknown.",
  getTaskBudgetInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getTaskBudget(args), null, 2) }],
  }),
);

server.tool(
  "get_daemon_budget",
  "Inspect current-hour daemon budget buckets. Returns rows per (daemon, axis) with total_in_hour, cap, and burn_ratio. Omit `daemon` to enumerate all daemons under the contract. Useful for the GUI ticker and for diagnostics when a daemon stops processing (system_dashboard's run_skipped_budget events corroborate).",
  getDaemonBudgetInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getDaemonBudget(args), null, 2) }],
  }),
);

server.tool(
  "reset_daemon_budget",
  "Operator-only escape hatch. Zeroes the current-hour bucket for one (daemon, axis). Requires confirm:true. The reset is audited in daemon_budget_events. Use sparingly — the rolling-hour design naturally rotates within an hour, so resets are appropriate only when an operator has manually retuned a daemon's behavior mid-hour.",
  resetDaemonBudgetInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await resetDaemonBudgetTool(args), null, 2) }],
  }),
);

// ─── M8.3 Task 4 — Clustering tool surface (SCM-S41-D7) ────────────────

server.tool(
  "list_supernodes",
  "Operator-facing browse of M8.3 Super Nodes (coarse K-Means clusters over kg_nodes.embedding). One row per (project, supernode_id) with node_count + the 3 most-frequent labels for display + computed_at. Reads the kg_supernodes view. Natural-language triggers: 'list clusters', 'show super nodes', 'what clusters exist'. Pagination via limit (<=500) + offset.",
  listSupernodesInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listSupernodes(args), null, 2) }],
  }),
);

server.tool(
  "list_cluster_members",
  "Drill into one Super Node: list the kg_nodes inside it, each with its Louvain community_id. Pass community_id to narrow further to a single fine cluster. Powers the GUI 'drill' view. Pagination via limit (<=500) + offset.",
  listClusterMembersInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await listClusterMembers(args), null, 2) }],
  }),
);

server.tool(
  "trigger_clustering",
  "Manually run the clustering scanner for one project right now (bypasses the 30-min daemon interval). Useful after a bulk import. Pass force:true to bypass the dirty-check (re-cluster even if no changes detected). Returns the same RunProjectResult shape as the daemon emits, plus a triggered_at timestamp.",
  triggerClusteringInputShape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await triggerClustering(args), null, 2) }],
  }),
);

// Optional: Sovereign Command Center (M8 Phase 2). Disabled by default —
// the MCP stdio server is the only ON-by-default surface. Operators opt in
// via SCM_GUI_ENABLED=1 to get the local-loopback dashboard alongside MCP.
if (
  process.env.SCM_GUI_ENABLED === "1" ||
  (process.env.SCM_GUI_ENABLED ?? "").toLowerCase() === "true"
) {
  try {
    const { startGuiServer } = await import("./gui/server.js");
    const started = await startGuiServer({
      token: process.env.SCM_GUI_TOKEN ?? null,
    });
    process.stderr.write(`[scm-gui] listening on ${started.url}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[scm-gui] failed to start: ${msg}\n`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
