import {
  addBacklog,
  listBacklog,
  updateBacklog,
  archiveDoneBacklog,
  listArchive,
  type BacklogRow,
  type BacklogStatus,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

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
      // Archives rather than deletes. Row data is preserved in archive_backlog;
      // the action name stays for backward compat with existing callers.
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
      // 1. Snapshot every bucket BEFORE archiving so the Progress Report is complete.
      const [todo, inProg, blocked, done] = await Promise.all([
        listBacklog(projectId, { status: "todo" }),
        listBacklog(projectId, { status: "in_progress" }),
        listBacklog(projectId, { status: "blocked" }),
        listBacklog(projectId, { status: "done" }),
      ]);

      // 2. Archive (don't delete) completed tasks — single SQL transaction.
      const archived = await archiveDoneBacklog(projectId);

      // 3. Pick the highest-priority remaining task across todo/in_progress/blocked.
      const next = pickNextTask([...todo, ...inProg, ...blocked]);

      // 4. The agreed 1-line resume prompt.
      const nextTitle = next?.title ?? "backlog is empty — pick a new task";
      const resumePrompt =
        `search_memory({ query: "Active Backlog", project_id: "${projectId}" }) ` +
        `-> Reviewing pending tasks. Next up: ${nextTitle}.`;

      // 5. Human-readable summary.
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
      };
    }
  }
}
