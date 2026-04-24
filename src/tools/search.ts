import { embed } from "../ollama.js";
import { searchChunks, listBacklog, type BacklogRow } from "../supabase.js";
import { currentProjectId } from "../project.js";

/**
 * Tight patterns that unambiguously ask for the backlog rather than prose.
 * Kept narrow on purpose — we don't want a query like "frontend backlog work"
 * to short-circuit the semantic search.
 */
const BACKLOG_PATTERNS: RegExp[] = [
  /\b(active|pending|current|my|open)\s+backlog\b/i,
  /\bbacklog\s+(tasks?|items?|list|snapshot)\b/i,
  /^\s*backlog\s*$/i,
  /^\s*pending\s+tasks?\s*$/i,
  /^\s*what'?s?\s+next\??\s*$/i,
];

function isBacklogQuery(q: string): boolean {
  return BACKLOG_PATTERNS.some((re) => re.test(q));
}

function sortByPriorityThenAge(rows: BacklogRow[]): BacklogRow[] {
  return [...rows].sort(
    (a, b) => a.priority - b.priority || Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

export async function searchMemory(args: {
  query: string;
  limit?: number;
  min_similarity?: number;
  project_id?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const limit = args.limit ?? 5;

  // Backlog-intent fast path — skip vector search, return the active task list.
  if (isBacklogQuery(args.query)) {
    const [inProg, todo, blocked] = await Promise.all([
      listBacklog(projectId, { status: "in_progress" }),
      listBacklog(projectId, { status: "todo" }),
      listBacklog(projectId, { status: "blocked" }),
    ]);
    const active = sortByPriorityThenAge([...inProg, ...todo, ...blocked]);
    const top = active.slice(0, Math.max(limit, 20));
    const head = active[0];
    const summary =
      active.length === 0
        ? "Backlog is empty for this project."
        : `${active.length} active task${active.length === 1 ? "" : "s"}. ` +
          `Next: [P${head.priority}] ${head.title} (${head.status}).`;

    return {
      project_id: projectId,
      query: args.query,
      mode: "backlog" as const,
      count: top.length,
      results: [],
      backlog: top.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
      })),
      summary,
    };
  }

  // Default semantic path.
  const [queryVec] = await embed([args.query]);
  const results = await searchChunks(projectId, queryVec, limit, args.min_similarity ?? 0.0);
  return {
    project_id: projectId,
    query: args.query,
    mode: "semantic" as const,
    count: results.length,
    results,
  };
}
