import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { slugify as slugifyProject } from "./project.js";

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// ─── schema presence + keep-alive ────────────────────────────────────────

const REQUIRED_TABLES = [
  "memory_chunks",
  "cloud_backlog",
  "archive_backlog",
  "frozen_features",
] as const;

const MIGRATION_COMMAND_SEQUENCE =
  "npm run schema && " +
  "npm run schema -- 002_multi_project.sql && " +
  "npm run schema -- 003_file_hash.sql && " +
  "npm run schema -- 004_backlog_frozen.sql && " +
  "npm run schema -- 005_archive_backlog.sql";

export type SchemaReport = {
  ok: boolean;
  missing: string[];
  present: string[];
  message?: string;
  fix_command?: string;
};

/**
 * Checks that every required table is reachable via PostgREST. Missing tables
 * surface as Postgres code 42P01. Never throws — the caller decides what to do
 * when the schema is incomplete (we log+continue from index.ts).
 */
export async function ensureSchema(): Promise<SchemaReport> {
  const missing: string[] = [];
  const present: string[] = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (!error) {
      present.push(table);
      continue;
    }
    if (error.code === "42P01" || /does not exist|could not find/i.test(error.message)) {
      missing.push(table);
    } else {
      // Some other error (auth, network). Report it as missing with context so
      // the operator can see it, but don't classify as non-existent.
      missing.push(`${table} (check failed: ${error.message})`);
    }
  }
  if (missing.length === 0) return { ok: true, missing: [], present };
  return {
    ok: false,
    missing,
    present,
    message: `Critical Missing Schema — the following tables are unreachable or missing: ${missing.join(", ")}.`,
    fix_command: MIGRATION_COMMAND_SEQUENCE,
  };
}

type KeepAliveSnapshot = {
  enabled: boolean;
  interval_ms: number;
  last_ping_at: string | null;
  last_ping_latency_ms: number | null;
  last_ping_ok: boolean | null;
};

const keepAlive: {
  enabled: boolean;
  intervalMs: number;
  lastPingAt: string | null;
  lastPingLatencyMs: number | null;
  lastPingOk: boolean | null;
  timer: NodeJS.Timeout | null;
} = {
  enabled: false,
  intervalMs: 300_000,
  lastPingAt: null,
  lastPingLatencyMs: null,
  lastPingOk: null,
  timer: null,
};

async function ping(): Promise<void> {
  const t0 = Date.now();
  try {
    await supabase.from("memory_chunks").select("*", { count: "exact", head: true });
    keepAlive.lastPingOk = true;
  } catch {
    keepAlive.lastPingOk = false;
  }
  keepAlive.lastPingAt = new Date().toISOString();
  keepAlive.lastPingLatencyMs = Date.now() - t0;
}

/**
 * Start a background HEAD ping against memory_chunks to keep the Supabase
 * HTTPS pool warm. Without this, the first request after ~5 min idle pays
 * 1–2 s of TLS/DNS reconnect cost. Idempotent; .unref()-ed so it never
 * prevents process exit.
 */
export function startKeepAlive(intervalMs?: number): void {
  if (keepAlive.timer) return;
  const envOverride = process.env.CLAUDE_MEMORY_KEEPALIVE_MS;
  const resolved =
    intervalMs ?? (envOverride ? Number.parseInt(envOverride, 10) : 300_000);
  keepAlive.intervalMs = Number.isFinite(resolved) && resolved > 0 ? resolved : 300_000;
  keepAlive.enabled = true;
  // Fire once immediately to warm the pool.
  void ping();
  keepAlive.timer = setInterval(() => void ping(), keepAlive.intervalMs);
  keepAlive.timer.unref();
}

export function stopKeepAlive(): void {
  if (keepAlive.timer) clearInterval(keepAlive.timer);
  keepAlive.timer = null;
  keepAlive.enabled = false;
}

export function getKeepAliveStatus(): KeepAliveSnapshot {
  return {
    enabled: keepAlive.enabled,
    interval_ms: keepAlive.intervalMs,
    last_ping_at: keepAlive.lastPingAt,
    last_ping_latency_ms: keepAlive.lastPingLatencyMs,
    last_ping_ok: keepAlive.lastPingOk,
  };
}

export type Chunk = {
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata?: Record<string, unknown>;
};

export type ChunkRow = Chunk & {
  embedding: number[];
  file_hash: string;
};

export type MatchRow = {
  id: number;
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  similarity: number;
};

export function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/**
 * Returns a Map<file_origin, file_hash> for every file already indexed under projectId.
 * Used by sync_local_memory to skip files whose content hasn't changed.
 */
export async function listFileHashes(projectId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("file_origin, file_hash")
      .eq("project_id", projectId)
      .not("file_hash", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`listFileHashes failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.file_origin && row.file_hash && !map.has(row.file_origin)) {
        map.set(row.file_origin, row.file_hash);
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

/**
 * Remove every chunk belonging to a given (project, file). Used before re-embedding
 * a changed file so stale chunk_indexes don't linger.
 */
export async function deleteChunksForFile(
  projectId: string,
  fileOrigin: string,
): Promise<number> {
  const { error, count } = await supabase
    .from("memory_chunks")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin);
  if (error) throw new Error(`deleteChunksForFile failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Confirm a file is fully resident in Supabase before it's safe to delete locally.
 * Returns the chunk count, or 0 if nothing matches (project_id, file_origin, file_hash).
 */
export async function verifyFileSynced(
  projectId: string,
  fileOrigin: string,
  fileHash: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin)
    .eq("file_hash", fileHash);
  if (error) throw new Error(`verifyFileSynced failed: ${error.message}`);
  return count ?? 0;
}

export async function upsertChunks(
  projectId: string,
  rows: ChunkRow[],
): Promise<{ count: number }> {
  if (rows.length === 0) return { count: 0 };

  const payload = rows.map((r) => ({
    project_id: projectId,
    content: r.content,
    file_origin: r.file_origin,
    chunk_index: r.chunk_index,
    embedding: r.embedding,
    content_hash: md5(r.content),
    file_hash: r.file_hash,
    metadata: r.metadata ?? {},
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("memory_chunks")
    .upsert(payload, { onConflict: "project_id,file_origin,chunk_index" });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return { count: rows.length };
}

export async function searchChunks(
  projectId: string,
  queryEmbedding: number[],
  matchCount = 5,
  minSimilarity = 0.0,
): Promise<MatchRow[]> {
  const { data, error } = await supabase.rpc("match_memory_chunks", {
    query_embedding: queryEmbedding,
    p_project_id: projectId,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return (data ?? []) as MatchRow[];
}

// ─── cloud_backlog ────────────────────────────────────────────────────────

export type BacklogStatus = "todo" | "in_progress" | "blocked" | "done";

export type BacklogRow = {
  id: number;
  project_id: string;
  title: string;
  status: BacklogStatus;
  priority: number;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function addBacklog(
  projectId: string,
  title: string,
  opts: { priority?: number; notes?: string; metadata?: Record<string, unknown> } = {},
): Promise<BacklogRow> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .insert({
      project_id: projectId,
      title,
      priority: opts.priority ?? 3,
      notes: opts.notes ?? null,
      metadata: opts.metadata ?? {},
    })
    .select()
    .single();
  if (error) throw new Error(`addBacklog failed: ${error.message}`);
  return data as BacklogRow;
}

export async function listBacklog(
  projectId: string,
  opts: { status?: BacklogStatus | BacklogStatus[] } = {},
): Promise<BacklogRow[]> {
  let q = supabase.from("cloud_backlog").select("*").eq("project_id", projectId);
  if (opts.status) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    q = q.in("status", arr);
  }
  const { data, error } = await q.order("priority", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw new Error(`listBacklog failed: ${error.message}`);
  return (data ?? []) as BacklogRow[];
}

export async function updateBacklog(
  id: number,
  patch: Partial<Pick<BacklogRow, "title" | "status" | "priority" | "notes" | "metadata">>,
): Promise<BacklogRow> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`updateBacklog failed: ${error.message}`);
  return data as BacklogRow;
}

export type ArchiveRow = {
  id: number;
  cloud_backlog_id: number | null;
  project_id: string;
  title: string;
  status: BacklogStatus;
  priority: number;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string;
};

/**
 * Transactionally moves every `status='done'` row for a project from
 * cloud_backlog into archive_backlog. The heavy lifting is the SQL function
 * archive_done_backlog() — a CTE with DELETE ... RETURNING feeding INSERT
 * runs as a single atomic statement. If the insert fails, the delete rolls
 * back automatically; there is no window where rows can be lost or doubled.
 */
export async function archiveDoneBacklog(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc("archive_done_backlog", {
    p_project_id: projectId,
  });
  if (error) throw new Error(`archiveDoneBacklog failed: ${error.message}`);
  return (data as number) ?? 0;
}

export async function listArchive(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ArchiveRow[]> {
  let q = supabase
    .from("archive_backlog")
    .select("*")
    .eq("project_id", projectId)
    .order("archived_at", { ascending: false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`listArchive failed: ${error.message}`);
  return (data ?? []) as ArchiveRow[];
}

// ─── frozen_features ──────────────────────────────────────────────────────

export async function listFrozenPatterns(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("frozen_features")
    .select("pattern")
    .eq("project_id", projectId);
  if (error) throw new Error(`listFrozenPatterns failed: ${error.message}`);
  return (data ?? []).map((r) => r.pattern as string);
}

export async function addFrozenPattern(
  projectId: string,
  pattern: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase
    .from("frozen_features")
    .upsert({ project_id: projectId, pattern, reason: reason ?? null }, {
      onConflict: "project_id,pattern",
    });
  if (error) throw new Error(`addFrozenPattern failed: ${error.message}`);
}

export async function removeFrozenPattern(
  projectId: string,
  pattern: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("frozen_features")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("pattern", pattern);
  if (error) throw new Error(`removeFrozenPattern failed: ${error.message}`);
  return count ?? 0;
}

export async function listFrozenByProject(): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from("frozen_features")
    .select("project_id, pattern");
  if (error) throw new Error(`listFrozenByProject failed: ${error.message}`);
  const out: Record<string, string[]> = {};
  for (const row of data ?? []) {
    const pid = row.project_id as string;
    const pat = row.pattern as string;
    (out[pid] ??= []).push(pat);
  }
  return out;
}

// ─── shared frozen-patterns cache for the PreToolUse hook ────────────────
//
// The md-policy.py hook runs as a fresh subprocess per tool call and cannot
// hit Supabase directly without paying 1-2s of network latency per Write/Edit.
// Instead, the MCP server writes a snapshot of `frozen_features` to this
// file on startup and after any mutation; the hook reads it in microseconds.

const GATE_DIR = process.env.CLAUDE_MEMORY_GATE_DIR ?? join(homedir(), ".claude-memory");
export const FROZEN_CACHE_PATH = join(GATE_DIR, "frozen-patterns.json");

export async function writeFrozenPatternsCache(): Promise<{
  ok: boolean;
  path: string;
  project_count: number;
  pattern_count: number;
  warning?: string;
}> {
  try {
    const raw = await listFrozenByProject();
    // Normalize keys to the slug form the hook uses when looking up the cache
    // (slugify(basename(CLAUDE_MD_POLICY_WORKSPACE))). Without this, a
    // caller that passes a non-slug project_id to freeze_file would silently
    // fail to block because the hook's lookup key wouldn't match.
    const projects: Record<string, string[]> = {};
    for (const [pid, patterns] of Object.entries(raw)) {
      const key = slugifyProject(pid);
      (projects[key] ??= []).push(...patterns);
    }
    const projectCount = Object.keys(projects).length;
    const patternCount = Object.values(projects).reduce((n, arr) => n + arr.length, 0);
    await mkdir(GATE_DIR, { recursive: true });
    await writeFile(
      FROZEN_CACHE_PATH,
      JSON.stringify(
        { updated_at: new Date().toISOString(), projects },
        null,
        2,
      ),
    );
    return { ok: true, path: FROZEN_CACHE_PATH, project_count: projectCount, pattern_count: patternCount };
  } catch (e) {
    return {
      ok: false,
      path: FROZEN_CACHE_PATH,
      project_count: 0,
      pattern_count: 0,
      warning: `writeFrozenPatternsCache failed: ${(e as Error).message}`,
    };
  }
}

export async function upsertRule(
  projectId: string,
  fileOrigin: string,
  chunkIndex: number,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const { data, error } = await supabase.rpc("upsert_memory_rule", {
    p_project_id: projectId,
    p_file_origin: fileOrigin,
    p_chunk_index: chunkIndex,
    p_content: content,
    p_embedding: embedding,
    p_metadata: metadata,
  });
  if (error) throw new Error(`Supabase upsertRule failed: ${error.message}`);
  return data as number;
}
