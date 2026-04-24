import {
  addBacklog,
  listBacklog,
  updateBacklog,
  pruneDoneBacklog,
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
      const removed = await pruneDoneBacklog(projectId);
      return { action: "prune_done", project_id: projectId, pruned: removed };
    }

    case "session_end": {
      // 1. Snapshot all statuses BEFORE pruning so the Progress Report is complete.
      const [todo, inProg, blocked, done] = await Promise.all([
        listBacklog(projectId, { status: "todo" }),
        listBacklog(projectId, { status: "in_progress" }),
        listBacklog(projectId, { status: "blocked" }),
        listBacklog(projectId, { status: "done" }),
      ]);

      // 2. Prune completed tasks (delete rows where status='done' for this project).
      const pruned = await pruneDoneBacklog(projectId);

      // 3. Determine the highest-priority task the next session should tackle.
      //    Look across todo, in_progress, and blocked so "what should I do next" is
      //    actionable (a blocked P1 is more useful context than a fresh P5).
      const next = pickNextTask([...todo, ...inProg, ...blocked]);

      // 4. Format the 1-line copy/paste resume prompt per the agreed contract.
      const nextTitle = next?.title ?? "backlog is empty — pick a new task";
      const resumePrompt =
        `search_memory({ query: "Active Backlog", project_id: "${projectId}" }) ` +
        `-> Reviewing pending tasks. Next up: ${nextTitle}.`;

      // 5. Human-readable line so the user can glance at the tool output.
      const humanSummary = [
        `Session ended.`,
        `${done.length} task${done.length === 1 ? "" : "s"} completed and pruned.`,
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
        pruned,
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
