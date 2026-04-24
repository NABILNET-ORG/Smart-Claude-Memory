import {
  addBacklog,
  listBacklog,
  updateBacklog,
  pruneDoneBacklog,
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
      const [todo, inProg, blocked, done] = await Promise.all([
        listBacklog(projectId, { status: "todo" }),
        listBacklog(projectId, { status: "in_progress" }),
        listBacklog(projectId, { status: "blocked" }),
        listBacklog(projectId, { status: "done" }),
      ]);
      const pruned = await pruneDoneBacklog(projectId);

      const lines: string[] = [];
      if (inProg.length) lines.push(`in-progress: ${inProg.map((t) => t.title).join("; ")}`);
      if (blocked.length) lines.push(`blocked: ${blocked.map((t) => t.title).join("; ")}`);
      if (todo.length) lines.push(`next: ${todo.slice(0, 3).map((t) => t.title).join("; ")}`);

      const resumePrompt =
        `Continue project "${projectId}". ` +
        (lines.length ? lines.join(" | ") : "backlog empty — choose next step.") +
        ` Call manage_backlog({action:"list", project_id:"${projectId}"}) for the full board.`;

      return {
        action: "session_end",
        project_id: projectId,
        totals: {
          todo: todo.length,
          in_progress: inProg.length,
          blocked: blocked.length,
          done_pruned: pruned,
        },
        done_titles_pruned: done.map((t) => t.title),
        resume_prompt: resumePrompt,
      };
    }
  }
}
