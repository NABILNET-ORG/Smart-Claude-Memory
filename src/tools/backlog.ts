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
  type BacklogRow,
  type BacklogStatus,
} from "../supabase.js";
import { currentProjectId, slugify } from "../project.js";
import { basename } from "node:path";

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
  | { action: "session_end"; project_id?: string };

/** Lowest priority number wins (1 = highest). Ties broken by oldest-first. */
function pickNextTask(rows: BacklogRow[]): BacklogRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) => a.priority - b.priority || Date.parse(a.created_at) - Date.parse(b.created_at),
  )[0];
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
]);

const ARCH_HIDDEN_ALLOWLIST = new Set([
  ".env.example",
  ".gitignore",
  ".mcp.json",
  ".github",
  ".claude",
]);

const ARCH_MAX_DEPTH = 3;
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
    if (archived.length === 0) {
      return {
        ok: true,
        path: readmePath,
        updated: false,
        warning: "No archived tasks yet; nothing to write.",
      };
    }

    const bullets = archived
      .map((t) => `* [DONE] ${t.title} (archived at ${t.archived_at.slice(0, 10)}).`)
      .join("\n");
    const newSection = `${PROGRESS_HEADER}\n\n${bullets}`;

    let current = "";
    try {
      current = await readFile(readmePath, "utf8");
    } catch {
      // README may not exist yet; we'll create one.
    }

    let updated: string;
    const start = current.indexOf(PROGRESS_HEADER);
    if (start >= 0) {
      // Find the next markdown heading at level 1-3 after our section, or EOF.
      const tail = current.slice(start + PROGRESS_HEADER.length);
      const nextHeading = tail.match(/\n#{1,3}\s+\S/);
      const sectionEnd =
        nextHeading && nextHeading.index !== undefined
          ? start + PROGRESS_HEADER.length + nextHeading.index
          : current.length;
      updated = current.slice(0, start) + newSection + current.slice(sectionEnd);
    } else if (current.trim()) {
      updated = current.trimEnd() + "\n\n" + newSection + "\n";
    } else {
      updated = newSection + "\n";
    }

    // Inject or refresh the architecture Mermaid block in README too.
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
      `_Auto-synced at ${new Date().toISOString()} for \`${projectId}\`._`,
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

    case "session_end": {
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
        readme_sync: readmeSync,
        architecture_sync: architectureSync,
        memory_summary: memorySummary,
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
