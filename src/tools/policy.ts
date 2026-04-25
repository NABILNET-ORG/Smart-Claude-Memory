import {
  addFrozenPattern,
  removeFrozenPattern,
  writeFrozenPatternsCache,
} from "../supabase.js";
import { currentProjectId, slugify } from "../project.js";
import {
  loadFrozenCache,
  writeFrozenCache,
  type FrozenEntry,
} from "./frozen-cache.js";

/**
 * v1.1.3: read frozen patterns from the on-disk cache so the response shape
 * matches the persisted schema ({ pattern, source, added_at }). The cache is
 * the source of truth for provenance — Supabase only stores `pattern` and
 * `reason`. The hook keys cache lookups by slugified workspace basename, so
 * we mirror that here.
 */
export async function listFrozen(args: { project_id?: string } = {}) {
  const projectId = args.project_id ?? currentProjectId;
  const cache = await loadFrozenCache();
  const key = slugify(projectId);
  const patterns = cache.projects[key] ?? [];
  return {
    action: "list_frozen",
    project_id: projectId,
    count: patterns.length,
    patterns,
  };
}

/**
 * Stage a `{ pattern, source, added_at }` entry into the cache *before* we
 * call writeFrozenPatternsCache, so the cache merger keeps our provenance
 * instead of defaulting to source="supabase". Returns the freshly written
 * entry. First-writer-wins: existing entries with the same pattern are kept.
 */
async function stageEntry(
  projectId: string,
  pattern: string,
  source: string,
): Promise<FrozenEntry> {
  const key = slugify(projectId);
  const cache = await loadFrozenCache();
  const bucket = (cache.projects[key] ??= []);
  const existing = bucket.find((e) => e.pattern === pattern);
  if (existing) return existing;
  const entry: FrozenEntry = { pattern, source, added_at: Date.now() };
  bucket.push(entry);
  await writeFrozenCache(cache);
  return entry;
}

export async function freezeFile(args: {
  pattern: string;
  project_id?: string;
  reason?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  await addFrozenPattern(projectId, args.pattern, args.reason);
  // Stage provenance first, then resync from Supabase. The merger preserves
  // our staged source/added_at because the entry is now "already on disk".
  const entry = await stageEntry(projectId, args.pattern, "freeze_file");
  const cache = await writeFrozenPatternsCache();
  return {
    action: "freeze_file",
    project_id: projectId,
    pattern: args.pattern,
    reason: args.reason ?? null,
    entry,
    cache,
  };
}

export async function unfreezeFile(args: {
  pattern: string;
  project_id?: string;
  confirm?: boolean;
  justification?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  // Require an explicit justification so an agent can't silently disarm the
  // policy. The user's original spec: "allow Claude (or the user) to manually
  // remove a pattern from frozen_features after getting permission."
  if (!args.justification || args.justification.trim().length < 4) {
    return {
      action: "unfreeze_file",
      project_id: projectId,
      pattern: args.pattern,
      removed: 0,
      warning:
        "Refused: unfreeze requires a 'justification' string (≥ 4 chars) explaining why the full-rewrite guardrail can be lifted for this file. Ask the user for permission first.",
    };
  }
  const removed = await removeFrozenPattern(projectId, args.pattern);
  // Drop the entry from the on-disk cache too — match by entry.pattern.
  const key = slugify(projectId);
  const cache = await loadFrozenCache();
  const bucket = cache.projects[key];
  if (bucket) {
    cache.projects[key] = bucket.filter((e) => e.pattern !== args.pattern);
    await writeFrozenCache(cache);
  }
  const cacheRefresh = await writeFrozenPatternsCache();
  return {
    action: "unfreeze_file",
    project_id: projectId,
    pattern: args.pattern,
    justification: args.justification,
    removed,
    cache: cacheRefresh,
  };
}
