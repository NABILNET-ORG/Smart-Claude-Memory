import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getPending } from "../verification-gate.js";
import { summarizeMemoryFile } from "./summarize.js";
import {
  addBacklog,
  listBacklog,
  updateBacklog,
  archiveDoneBacklog,
  listArchive,
  supabase,
  type BacklogRow,
  type BacklogStatus,
} from "../supabase.js";
import { currentProjectId, slugify, displayProjectName } from "../project.js";
import { basename } from "node:path";
import { auditBloat } from "./bloat-audit.js";

export type BacklogAction =
  | { action: "add"; title: string; priority?: number; notes?: string; project_id?: string }
  | { action: "list"; status?: BacklogStatus | BacklogStatus[]; project_id?: string }
  | {
      action: "update";
      id: number;
      title?: string;
      status?: BacklogStatus;
      priority?: number;
      notes?: string;
    }
  | { action: "prune_done"; project_id?: string }
  | { action: "archive_list"; project_id?: string; limit?: number }
  | {
      action: "session_end";
      project_id?: string;
    }
  | { action: "backfill_archive_chunks"; project_id?: string; dry_run?: boolean };

/** Lowest priority number wins (1 = highest). Ties broken by oldest-first. */
function pickNextTask(rows: BacklogRow[]): BacklogRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) => a.priority - b.priority || Date.parse(a.created_at) - Date.parse(b.created_at),
  )[0];
}

/**
 * Detect the highest SESSION-N-REPORT.md in docs/session-reports/ and return
 * N+1 for the next-session command block. Defaults to 1 if the directory is
 * missing or empty. Implements the v2.1 Sovereign DNA "Dynamic Numbering" rule.
 */
async function nextSessionNumber(workspace: string): Promise<number> {
  const reportsDir = join(workspace, "docs", "session-reports");
  try {
    const entries = await readdir(reportsDir);
    let maxN = 0;
    for (const name of entries) {
      const m = name.match(/^SESSION-(\d+)-REPORT\.md$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    return maxN + 1;
  } catch {
    return 1;
  }
}

const PROGRESS_HEADER = "### 🚀 Recent Progress";

// ─── Living architecture sync ────────────────────────────────────────────

const ARCH_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "backups",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  // Windows reserved-device leakage. `> nul` redirects occasionally drop a
  // literal `nul` file at the repo root — keep it out of the architecture
  // tree so Mermaid diagrams stay clean (paired with `.gitignore` entry).
  "nul",
]);

const ARCH_HIDDEN_ALLOWLIST = new Set([
  ".env.example",
  ".gitignore",
  ".mcp.json",
  ".github",
  ".claude",
]);

// Scanner depth — bumped from 3 to 5 so the auto-generated Mermaid tree
// reaches inside two-level nested subsystems (e.g. src/gui/public/{...},
// docs/session-reports/, scripts/sql-fixtures/). Depth 3 leaves the leaf
// files of any third-level directory invisible after they get added as
// flat nodes only when the parent is reached; depth 5 lets the renderer
// emit them with their own subtree node, which is what Living Docs needs.
const ARCH_MAX_DEPTH = 5;
const ARCH_MAX_CHILDREN = 25;

type ArchNode = {
  name: string;
  type: "dir" | "file";
  children?: ArchNode[];
  truncated?: number;
};

async function scanTree(dir: string, depth: number): Promise<ArchNode> {
  const entries = await readdir(dir, { withFileTypes: true });
  const filtered = entries.filter((e) => {
    if (ARCH_IGNORE.has(e.name)) return false;
    if (e.name.startsWith(".") && !ARCH_HIDDEN_ALLOWLIST.has(e.name)) return false;
    if (e.name.endsWith(".tgz")) return false;
    return true;
  });
  filtered.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const head = filtered.slice(0, ARCH_MAX_CHILDREN);
  const truncated = Math.max(0, filtered.length - ARCH_MAX_CHILDREN);

  const children: ArchNode[] = [];
  for (const e of head) {
    if (e.isDirectory() && depth < ARCH_MAX_DEPTH) {
      try {
        children.push(await scanTree(join(dir, e.name), depth + 1));
      } catch {
        children.push({ name: e.name, type: "dir" });
      }
    } else {
      children.push({ name: e.name, type: e.isDirectory() ? "dir" : "file" });
    }
  }
  return {
    name: basename(dir),
    type: "dir",
    children,
    truncated: truncated > 0 ? truncated : undefined,
  };
}

function mermaidSafeLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/[\[\]]/g, "");
}

function renderArchMermaid(root: ArchNode): string {
  const lines = ["flowchart TD"];
  let counter = 0;
  const nextId = () => `n${counter++}`;

  function walk(node: ArchNode, parentId: string | null): void {
    const id = nextId();
    const label = node.type === "dir" ? `${node.name}/` : node.name;
    lines.push(`  ${id}["${mermaidSafeLabel(label)}"]`);
    if (parentId) lines.push(`  ${parentId} --> ${id}`);
    if (node.children) {
      for (const child of node.children) walk(child, id);
      if (node.truncated) {
        const tId = nextId();
        lines.push(`  ${tId}["… (${node.truncated} more)"]`);
        lines.push(`  ${id} --> ${tId}`);
      }
    }
  }
  walk(root, null);
  return lines.join("\n");
}

const ARCH_MARKER_START = "<!-- MEMORY:ARCH:START -->";
const ARCH_MARKER_END = "<!-- MEMORY:ARCH:END -->";

export async function updateProjectArchitecture(projectId: string): Promise<{
  ok: boolean;
  path?: string;
  updated?: boolean;
  warning?: string;
}> {
  const docPath = resolve(process.cwd(), "ARCHITECTURE.md");
  try {
    const cwdSlug = slugify(basename(process.cwd()) || "default");
    if (cwdSlug !== projectId) {
      return {
        ok: true,
        path: docPath,
        updated: false,
        warning: `Architecture sync skipped — cwd project '${cwdSlug}' does not match session_end project_id '${projectId}'.`,
      };
    }

    const tree = await scanTree(process.cwd(), 0);
    const mermaid = renderArchMermaid(tree);
    const innerBlock =
      "\n\n```mermaid\n" +
      "%% Auto-generated. Do not edit between the MEMORY:ARCH markers.\n" +
      mermaid +
      "\n```\n\n";

    let current = "";
    try {
      current = await readFile(docPath, "utf8");
    } catch {
      // file absent — we'll create it below
    }

    const startIdx = current.indexOf(ARCH_MARKER_START);
    const endIdx = current.indexOf(ARCH_MARKER_END);

    let updated: string;
    if (startIdx >= 0 && endIdx > startIdx) {
      // Replace only the content between the markers (exclusive of the marker lines).
      const before = current.slice(0, startIdx + ARCH_MARKER_START.length);
      const after = current.slice(endIdx);
      updated = before + innerBlock + after;
    } else {
      // Markers not found — append a fresh auto-generated section at EOF.
      const appended =
        "\n\n## File Architecture (auto-generated)\n\n" +
        ARCH_MARKER_START +
        innerBlock +
        ARCH_MARKER_END +
        "\n";
      updated = current.trim() ? current.trimEnd() + appended : appended.trimStart();
    }

    await writeFile(docPath, updated, "utf8");
    return { ok: true, path: docPath, updated: true };
  } catch (e) {
    return {
      ok: false,
      path: docPath,
      warning: `Architecture sync failed: ${(e as Error).message}`,
    };
  }
}

/**
 * Self-documenting session handover: rewrite or append the "Recent Progress"
 * section of the project's local README.md with the last 5 archived tasks.
 * Never throws — failures are returned as a warning so session_end still
 * completes the archive.
 */
export async function updateLocalReadme(projectId: string): Promise<{
  ok: boolean;
  path?: string;
  updated?: boolean;
  warning?: string;
}> {
  const readmePath = resolve(process.cwd(), "README.md");
  try {
    // Safety: skip when the MCP server's cwd doesn't match the session_end
    // project — we'd otherwise overwrite the wrong repo's README.
    const cwdSlug = slugify(basename(process.cwd()) || "default");
    if (cwdSlug !== projectId) {
      return {
        ok: true,
        path: readmePath,
        updated: false,
        warning: `README sync skipped — cwd project '${cwdSlug}' does not match session_end project_id '${projectId}'.`,
      };
    }

    const archived = await listArchive(projectId, { limit: 5 });

    let current = "";
    try {
      current = await readFile(readmePath, "utf8");
    } catch {
      // README may not exist yet; we'll create one.
    }

    let updated = current;

    // Refresh the Recent-Progress block only when there are archived tasks
    // to report. Skipping this branch on empty archive prevents synthesising
    // an empty progress section — but the architecture Mermaid block below
    // ALWAYS runs so the file-tree stays in lock-step with the filesystem.
    if (archived.length > 0) {
      const bullets = archived
        .map((t) => `* [DONE] ${t.title} (archived at ${t.archived_at.slice(0, 10)}).`)
        .join("\n");
      const newSection = `${PROGRESS_HEADER}\n\n${bullets}`;

      const start = updated.indexOf(PROGRESS_HEADER);
      if (start >= 0) {
        // Find the next markdown heading at level 1-3 after our section, or EOF.
        const tail = updated.slice(start + PROGRESS_HEADER.length);
        const nextHeading = tail.match(/\n#{1,3}\s+\S/);
        const sectionEnd =
          nextHeading && nextHeading.index !== undefined
            ? start + PROGRESS_HEADER.length + nextHeading.index
            : updated.length;
        updated = updated.slice(0, start) + newSection + updated.slice(sectionEnd);
      } else if (updated.trim()) {
        updated = updated.trimEnd() + "\n\n" + newSection + "\n";
      } else {
        updated = newSection + "\n";
      }
    }

    // ALWAYS inject or refresh the architecture Mermaid block — Living-Docs
    // hygiene must reflect filesystem reality even when no tasks were
    // archived this session. Previously this call was unreachable on an
    // empty archive due to an early return, which let the README's file-tree
    // diagram drift away from the actual project shape.
    updated = await injectMermaidIntoReadme(updated, projectId);

    await writeFile(readmePath, updated, "utf8");
    return { ok: true, path: readmePath, updated: true };
  } catch (e) {
    return {
      ok: false,
      path: readmePath,
      warning: `README sync failed: ${(e as Error).message}`,
    };
  }
}

const README_ARCH_HEADER = "### 🗺️ File Architecture";

/** Generate a fresh Mermaid flowchart for cwd and splice it into README. */
async function injectMermaidIntoReadme(readmeText: string, projectId: string): Promise<string> {
  try {
    const tree = await scanTree(process.cwd(), 0);
    const mermaid = renderArchMermaid(tree);
    const block = [
      README_ARCH_HEADER,
      "",
      `_Auto-synced at ${new Date().toISOString()} for \`${displayProjectName(projectId)}\`._`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    const headerIdx = readmeText.indexOf(README_ARCH_HEADER);
    if (headerIdx >= 0) {
      // Replace from header until next ## / ### heading or EOF.
      const tail = readmeText.slice(headerIdx + README_ARCH_HEADER.length);
      const nextHeading = tail.match(/\n#{1,3}\s+\S/);
      const end =
        nextHeading && nextHeading.index !== undefined
          ? headerIdx + README_ARCH_HEADER.length + nextHeading.index
          : readmeText.length;
      return readmeText.slice(0, headerIdx) + block + readmeText.slice(end);
    }
    // Append if not present.
    return readmeText.trimEnd() + "\n\n" + block + "\n";
  } catch {
    // Never let an arch-block failure break the README write.
    return readmeText;
  }
}

// ─── M4 Phase B: backfill archive_backlog.chunk_id for legacy rows ───────
//
// Rationale: migration 014 patched archive_done_backlog so future archives
// auto-populate chunk_id from the terminal-committed checkpoint. Rows
// archived BEFORE 014 was applied have chunk_id = NULL even when they
// carry metadata.checkpoint_root_id (copied verbatim from cloud_backlog).
// This helper closes that gap.
//
// dry_run=true is a PURE READ — no UPDATEs hit the database. The caller
// runs dry_run first to inspect the impact, then re-runs with dry_run=false
// to commit. This is user-gated; the helper itself does not auto-execute.

export type BackfillArchiveChunksResult = {
  scanned: number;
  backfilled: number;
  ambiguous: number;
  skipped: number;
  dry_run: boolean;
};

type ArchiveBacklogRowForBackfill = {
  id: number;
  project_id: string;
  title: string;
  archived_at: string;
  metadata: Record<string, unknown> | null;
};

type MemoryChunkMatch = {
  id: number;
  created_at: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function backfillArchiveChunkIds(
  projectId: string,
  dryRun: boolean,
): Promise<BackfillArchiveChunksResult> {
  if (!projectId || typeof projectId !== "string") {
    throw new Error("backfillArchiveChunkIds: projectId is required");
  }

  // 1. Scan archive_backlog rows missing chunk_id.
  const { data: rows, error: scanErr } = await supabase
    .from("archive_backlog")
    .select("id, project_id, title, archived_at, metadata")
    .eq("project_id", projectId)
    .is("chunk_id", null)
    .order("archived_at", { ascending: false });

  if (scanErr) {
    throw new Error(
      `[M4] backfillArchiveChunkIds: archive_backlog scan failed: ${scanErr.message}`,
    );
  }

  const candidates = (rows ?? []) as ArchiveBacklogRowForBackfill[];
  let backfilled = 0;
  let ambiguous = 0;
  let skipped = 0;

  for (const row of candidates) {
    const metadata =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : null;
    const checkpointRootRaw =
      metadata && typeof metadata.checkpoint_root_id !== "undefined"
        ? metadata.checkpoint_root_id
        : null;
    let resolvedChunkId: number | null = null;

    // 2a. Primary path: metadata.checkpoint_root_id → terminal_committed_checkpoint.
    if (checkpointRootRaw !== null) {
      const rootId =
        typeof checkpointRootRaw === "number"
          ? checkpointRootRaw
          : typeof checkpointRootRaw === "string" && /^\d+$/.test(checkpointRootRaw)
            ? Number.parseInt(checkpointRootRaw, 10)
            : null;
      if (rootId !== null && rootId > 0) {
        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "terminal_committed_checkpoint",
          {
            p_project_id: projectId,
            p_skill_id: null,
            p_root_id: rootId,
          },
        );
        if (rpcErr) {
          // RPC missing (014 not applied) → skip this row, fall through to
          // heuristic which will also fail and bump skipped.
          console.log(
            `[M4] backfill: terminal_committed_checkpoint RPC failed for archive_backlog.id=${row.id}: ${rpcErr.message}`,
          );
        } else {
          const scid =
            typeof rpcData === "number"
              ? rpcData
              : Array.isArray(rpcData) && rpcData.length > 0 && typeof rpcData[0] === "number"
                ? (rpcData[0] as number)
                : null;
          if (scid !== null) resolvedChunkId = scid;
        }
      }
    }

    // 2b. Heuristic fallback: search memory_chunks by title + ±1d window.
    if (resolvedChunkId === null) {
      const archivedAt = Date.parse(row.archived_at);
      if (!Number.isFinite(archivedAt)) {
        skipped++;
        continue;
      }
      const windowStart = new Date(archivedAt - ONE_DAY_MS).toISOString();
      const windowEnd = new Date(archivedAt + ONE_DAY_MS).toISOString();
      // Defensive title trim — long titles can blow the textSearch path.
      const titleHint = row.title.slice(0, 120);
      const { data: chunkMatches, error: chunkErr } = await supabase
        .from("memory_chunks")
        .select("id, created_at")
        .eq("project_id", projectId)
        .gte("created_at", windowStart)
        .lte("created_at", windowEnd)
        .ilike("content", `%${titleHint}%`)
        .limit(3);
      if (chunkErr) {
        skipped++;
        continue;
      }
      const matches = (chunkMatches ?? []) as MemoryChunkMatch[];
      if (matches.length === 0) {
        skipped++;
        continue;
      }
      if (matches.length > 1) {
        ambiguous++;
        continue;
      }
      resolvedChunkId = matches[0].id;
    }

    if (resolvedChunkId === null) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(
        `[M4] backfill (dry_run): would set archive_backlog.id=${row.id}.chunk_id=${resolvedChunkId}`,
      );
      backfilled++;
      continue;
    }

    const { error: updErr } = await supabase
      .from("archive_backlog")
      .update({ chunk_id: resolvedChunkId })
      .eq("id", row.id)
      .eq("project_id", projectId)
      .is("chunk_id", null); // double-guard against races
    if (updErr) {
      console.log(
        `[M4] backfill: update failed for archive_backlog.id=${row.id}: ${updErr.message}`,
      );
      skipped++;
      continue;
    }
    console.log(
      `[M4] backfill: set archive_backlog.id=${row.id}.chunk_id=${resolvedChunkId}`,
    );
    backfilled++;
  }

  return {
    scanned: candidates.length,
    backfilled,
    ambiguous,
    skipped,
    dry_run: dryRun,
  };
}

export async function manageBacklog(args: BacklogAction) {
  const projectId = "project_id" in args && args.project_id ? args.project_id : currentProjectId;

  switch (args.action) {
    case "add": {
      const row = await addBacklog(projectId, args.title, {
        priority: args.priority,
        notes: args.notes,
      });
      return { action: "add", project_id: projectId, task: row };
    }

    case "list": {
      const rows = await listBacklog(projectId, { status: args.status });
      return { action: "list", project_id: projectId, count: rows.length, tasks: rows };
    }

    case "update": {
      const row = await updateBacklog(args.id, {
        title: args.title,
        status: args.status,
        priority: args.priority,
        notes: args.notes,
      });
      return { action: "update", task: row };
    }

    case "prune_done": {
      const archived = await archiveDoneBacklog(projectId);
      return { action: "prune_done", project_id: projectId, archived };
    }

    case "archive_list": {
      const rows = await listArchive(projectId, { limit: args.limit ?? 50 });
      return {
        action: "archive_list",
        project_id: projectId,
        count: rows.length,
        archived_tasks: rows,
      };
    }

    case "backfill_archive_chunks": {
      // M4 Phase B: populate archive_backlog.chunk_id for legacy rows whose
      // cloud_backlog carried metadata.checkpoint_root_id but predate the
      // 014 archive_done_backlog patch. dry_run=true is a pure read.
      const dryRun = args.dry_run ?? false;
      const result = await backfillArchiveChunkIds(projectId, dryRun);
      return {
        action: "backfill_archive_chunks",
        project_id: projectId,
        ...result,
      };
    }

    case "session_end": {
      // v2.1.11 Zero-Autonomy Session Termination Rule.
      // session_end carries NO context-percentage gate. It is reserved for
      // explicit human commands ('end session', 'wrap up', 'handover', etc.)
      // and the Agent is forbidden from invoking it autonomously. The prior
      // v2.1.9/2.1.10 SESSION_END_MIN_CONTEXT_PCT gate was removed because
      // LLM self-reports of context utilization proved unreliable and were
      // repeatedly used as a lazy-exit excuse. The only remaining structural
      // gate on session_end is the Manual Test verification (below).

      // BINDING GATE: refuse session_end when a manual-test verification is
      // still pending. Handover artefacts should only be written after the
      // user confirms the last edit is good.
      const pendingGate = await getPending();
      if (pendingGate) {
        return {
          action: "session_end",
          refused: true,
          reason:
            "Manual Test Gate is OPEN — session_end is blocked. Call confirm_verification({success:true}) after validating the last edit, then retry session_end.",
          pending_gate: pendingGate,
        };
      }

      const [todo, inProg, blocked, done] = await Promise.all([
        listBacklog(projectId, { status: "todo" }),
        listBacklog(projectId, { status: "in_progress" }),
        listBacklog(projectId, { status: "blocked" }),
        listBacklog(projectId, { status: "done" }),
      ]);

      const archived = await archiveDoneBacklog(projectId);

      // Living Documentation: README progress log + Mermaid file-tree +
      // optional MEMORY.md summarization. All run in parallel (different
      // files) so total session_end latency stays close to the slowest one.
      const [readmeSync, architectureSync, memorySummary] = await Promise.all([
        updateLocalReadme(projectId),
        updateProjectArchitecture(projectId),
        maybeSummarizeMemoryFile(),
      ]);

      const next = pickNextTask([...todo, ...inProg, ...blocked]);
      const nextTitle = next?.title ?? "backlog is empty — pick a new task";
      const resumePrompt =
        `search_memory({ query: "Active Backlog", project_id: "${projectId}" }) ` +
        `-> Reviewing pending tasks. Next up: ${nextTitle}.`;

      // v1.1.4 Architecture Guard / Automatic Session Handoff:
      // Build a copy-paste-ready Markdown block the agent posts verbatim as
      // its final message. Keep the body minimal (3 lines) so it survives a
      // copy through any terminal. Triple-backticks inside the JSON string
      // are emitted as-is; the agent's renderer interprets them when posted.
      const nextN = await nextSessionNumber(process.cwd());

      // Sovereign Purge audit — surface the recommendation BEFORE the
      // copy-paste block so the next agent boot sees the warning first.
      let bloatAuditResult: Awaited<ReturnType<typeof auditBloat>> = {
        bloat_audit: {
          threshold: 3000,
          claude_md: { path: null, tokens: 0, bloated: false },
          hidden_memory: { path: null, tokens: 0, bloated: false, found: false },
        },
        sovereign_purge_recommendation: null,
      };
      try {
        bloatAuditResult = await auditBloat(process.cwd());
      } catch {
        /* keep defaults */
      }
      const purgeWarning = bloatAuditResult.sovereign_purge_recommendation
        ? "> ⚠️ Sovereign Purge recommended at next boot — see init_project response.\n\n"
        : "";

      const nextSessionCommandMarkdown = purgeWarning + [
        "## 🚀 NEXT SESSION START COMMAND (Copy-Paste)",
        "",
        "```text",
        "init_project()",
        "check_system_health()",
        `search_memory({ query: "Active Backlog", project_id: "${projectId}", k: 10 })`,
        `# Then read docs/NEXT-SESSION-PROMPT.md for the full Session ${nextN} plan.`,
        "```",
      ].join("\n");

      const humanSummary = [
        `Session ended.`,
        `${done.length} task${done.length === 1 ? "" : "s"} archived.`,
        `Remaining: ${todo.length} todo · ${inProg.length} in-progress · ${blocked.length} blocked.`,
        next ? `Next up: [P${next.priority}] ${next.title}` : `Backlog is empty.`,
      ].join(" ");

      return {
        action: "session_end",
        project_id: projectId,
        human_summary: humanSummary,
        progress_report: {
          completed_count: done.length,
          completed_titles: done.map((t) => t.title),
          remaining: {
            todo: todo.length,
            in_progress: inProg.length,
            blocked: blocked.length,
          },
        },
        archived,
        next_task: next
          ? {
              id: next.id,
              title: next.title,
              priority: next.priority,
              status: next.status,
              notes: next.notes,
            }
          : null,
        resume_prompt: resumePrompt,
        next_session_command_markdown: nextSessionCommandMarkdown,
        readme_sync: readmeSync,
        architecture_sync: architectureSync,
        memory_summary: memorySummary,
        bloat_audit: bloatAuditResult.bloat_audit,
        sovereign_purge_recommendation: bloatAuditResult.sovereign_purge_recommendation,
      };
    }
  }
}

const BYTES_PER_TOKEN = 4;
const MEMORY_SOFT_LIMIT_TOKENS = 3000;

/** If MEMORY.md exists in cwd and exceeds the soft token limit, run the LLM
 * summarizer on it so the next session starts with a lean context. Never
 * throws — the session_end call path is resilient to this helper's failure. */
async function maybeSummarizeMemoryFile(): Promise<
  | { action: "skipped"; reason: string }
  | { action: "summarized"; original_tokens: number; compressed_tokens: number; reduction_pct: number }
  | { action: "error"; error: string }
> {
  const path = resolve(process.cwd(), "MEMORY.md");
  try {
    const st = await stat(path);
    const estTokens = Math.ceil(st.size / BYTES_PER_TOKEN);
    if (estTokens <= MEMORY_SOFT_LIMIT_TOKENS) {
      return {
        action: "skipped",
        reason: `MEMORY.md is ${estTokens} tokens (under ${MEMORY_SOFT_LIMIT_TOKENS} limit).`,
      };
    }
    const r = await summarizeMemoryFile({
      file_path: path,
      target_tokens: MEMORY_SOFT_LIMIT_TOKENS,
    });
    if (r.action === "written") {
      return {
        action: "summarized",
        original_tokens: r.original_tokens_estimated ?? 0,
        compressed_tokens: r.compressed_tokens_estimated ?? 0,
        reduction_pct: r.reduction_pct ?? 0,
      };
    }
    return { action: "skipped", reason: `summarizer returned '${r.action}'` };
  } catch (e) {
    // The common case here is "no MEMORY.md in cwd" — that's a skip, not an error.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { action: "skipped", reason: "No MEMORY.md in current working directory." };
    }
    return { action: "error", error: (e as Error).message };
  }
}
