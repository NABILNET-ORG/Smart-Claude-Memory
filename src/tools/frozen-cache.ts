// Shared loader + atomic writer for the per-project frozen-patterns cache
// snapshot at ~/.claude-memory/frozen-patterns.json.
//
// v1.1.3 schema migration: per-project entries are now
//   { pattern: string, source: string, added_at: number /* unix ms */ }
// instead of bare strings. The loader transparently migrates legacy string
// entries in-memory so older caches keep working until the next write.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// TODO(v1.2.0): drop the legacy CLAUDE_MEMORY_GATE_DIR fallback after the
// Smart Claude Memory rebrand has settled.
const GATE_DIR =
  process.env.SMART_CLAUDE_MEMORY_GATE_DIR ??
  process.env.CLAUDE_MEMORY_GATE_DIR ??
  join(homedir(), ".claude-memory");

export const FROZEN_CACHE_PATH = join(GATE_DIR, "frozen-patterns.json");

export type FrozenEntry = {
  pattern: string;
  source: string;
  added_at: number;
};

export type FrozenCache = {
  updated_at: string;
  projects: Record<string, FrozenEntry[]>;
};

function emptyCache(): FrozenCache {
  return { updated_at: new Date(0).toISOString(), projects: {} };
}

// Coerce one raw JSON value (legacy string OR new object) into a FrozenEntry.
// Returns null if the value can't be salvaged at all.
function coerceEntry(raw: unknown): FrozenEntry | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { pattern: trimmed, source: "legacy", added_at: 0 };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const pattern = typeof o.pattern === "string" ? o.pattern.trim() : "";
    if (!pattern) return null;
    const source = typeof o.source === "string" && o.source ? o.source : "legacy";
    const added_at = typeof o.added_at === "number" && Number.isFinite(o.added_at)
      ? o.added_at
      : 0;
    return { pattern, source, added_at };
  }
  return null;
}

/**
 * Read the frozen-patterns cache from disk. Missing file → empty cache.
 * Legacy string entries are migrated in-memory (not persisted here — the
 * next write will lay down the new shape).
 */
export async function loadFrozenCache(): Promise<FrozenCache> {
  let raw: string;
  try {
    raw = await readFile(FROZEN_CACHE_PATH, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") return emptyCache();
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCache();
  }
  if (!parsed || typeof parsed !== "object") return emptyCache();
  const obj = parsed as Record<string, unknown>;
  const updated_at = typeof obj.updated_at === "string" ? obj.updated_at : new Date(0).toISOString();
  const projectsRaw = (obj.projects ?? {}) as Record<string, unknown>;
  const projects: Record<string, FrozenEntry[]> = {};
  for (const [pid, list] of Object.entries(projectsRaw)) {
    if (!Array.isArray(list)) continue;
    const out: FrozenEntry[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const entry = coerceEntry(item);
      if (!entry) continue;
      if (seen.has(entry.pattern)) continue;
      seen.add(entry.pattern);
      out.push(entry);
    }
    projects[pid] = out;
  }
  return { updated_at, projects };
}

/**
 * Atomically write the cache: serialize → write to `.tmp` sibling → rename.
 * `rename` is atomic on POSIX and on NTFS (Node's fs.rename uses MoveFileEx
 * with replace) so a concurrent reader never sees a half-written file.
 */
export async function writeFrozenCache(cache: FrozenCache): Promise<string> {
  const dir = dirname(FROZEN_CACHE_PATH);
  await mkdir(dir, { recursive: true });
  const tmp = `${FROZEN_CACHE_PATH}.tmp`;
  const payload: FrozenCache = {
    updated_at: new Date().toISOString(),
    projects: cache.projects,
  };
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, FROZEN_CACHE_PATH);
  return FROZEN_CACHE_PATH;
}
