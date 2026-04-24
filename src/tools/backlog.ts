import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

/**
 * Self-documenting session handover: rewrite or append the "Recent Progress"
 * section of the project's local README.md with the last 5 archived tasks.
 * Never throws — failures are returned as a warning so session_end still
 * completes the archive.
 */
async function updateLocalReadme(projectId: string): Promise<{
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
      const [todo, inProg, blocked, done] = await Promise.all([
        listBacklog(projectId, { status: "todo" }),
        listBacklog(projectId, { status: "in_progress" }),
        listBacklog(projectId, { status: "blocked" }),
        listBacklog(projectId, { status: "done" }),
      ]);

      const archived = await archiveDoneBacklog(projectId);

      // Living-Documentation sync. Never throws; worst case returns a warning.
      const readmeSync = await updateLocalReadme(projectId);

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
      };
    }
  }
}
