import { embed } from "../ollama.js";
import {
  searchChunks,
  listBacklog,
  listArchive,
  type BacklogRow,
  type ArchiveRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

/** Narrow patterns for queries that unambiguously ask for the ARCHIVE. */
const ARCHIVE_PATTERNS: RegExp[] = [
  /\barchive[sd]?\b/i,
  /\bcompleted\s+tasks?\b/i,
  /\bdone\s+tasks?\b/i,
  /\bfinished\s+tasks?\b/i,
  /\bpast\s+tasks?\b/i,
];

/** Narrow patterns for queries that ask for the ACTIVE backlog. */
const BACKLOG_PATTERNS: RegExp[] = [
  /\b(active|pending|current|my|open)\s+backlog\b/i,
  /\bbacklog\s+(tasks?|items?|list|snapshot)\b/i,
  /^\s*backlog\s*$/i,
  /^\s*pending\s+tasks?\s*$/i,
  /^\s*what'?s?\s+next\??\s*$/i,
];

function matches(patterns: RegExp[], q: string): boolean {
  return patterns.some((re) => re.test(q));
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

  // Precedence: archive > backlog > semantic. Archive beats backlog because
  // 'archive' is the more specific signal — without it we'd route generic
  // queries containing 'archive' into the semantic path by mistake.
  if (matches(ARCHIVE_PATTERNS, args.query)) {
    const rows: ArchiveRow[] = await listArchive(projectId, { limit: Math.max(limit, 20) });
    const summary =
      rows.length === 0
        ? "Archive is empty for this project."
        : `${rows.length} archived task${rows.length === 1 ? "" : "s"}. Most recent: "${rows[0].title}" (archived ${rows[0].archived_at}).`;
    return {
      project_id: projectId,
      query: args.query,
      mode: "archive" as const,
      count: rows.length,
      results: [],
      archive: rows.map((t) => ({
        id: t.id,
        cloud_backlog_id: t.cloud_backlog_id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
        archived_at: t.archived_at,
      })),
      summary,
    };
  }

  if (matches(BACKLOG_PATTERNS, args.query)) {
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

  // Default semantic path. Archived backlog rows are NEVER mixed into
  // semantic results — they live in a different table and only surface via
  // the archive-intent fast path above.
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
