// batch_freeze_patterns — hydrate frozen-patterns.json from explicit globs
// AND/OR a markdown rule-file in a single MCP call. v1.1.3.
//
// Each on-disk entry is { pattern, source, added_at }. NO eager glob
// expansion: patterns are stored as-given. Dedup key is the trimmed,
// case-sensitive pattern string. First writer wins (an existing entry is
// skipped, not overwritten). Atomic write is delegated to writeFrozenCache
// (.tmp + rename).

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { addFrozenPattern } from "../supabase.js";
import { currentProjectId, slugify } from "../project.js";
import {
  loadFrozenCache,
  writeFrozenCache,
  type FrozenEntry,
} from "./frozen-cache.js";

export type BatchFreezeArgs = {
  paths?: string[];
  from_rule_file?: string;
  section?: string;
  dry_run?: boolean;
  source_tag?: string;
  project_id?: string;
};

export type BatchFreezeResult = {
  action: "batch_freeze_patterns";
  project_id: string;
  added: number;
  deduped: number;
  skipped: number;
  source: string;
  dry_run: boolean;
  patterns?: string[];
  error?: string;
};

const DEFAULT_SECTION = "## Frozen Patterns";

/**
 * Pull pattern strings out of a markdown section. Strict, no NLP:
 *   - locate the first line that exactly matches `section` (after rstrip)
 *   - read until the next markdown heading (line starting with `#`) or EOF
 *   - strip leading list markers (`-`, `*`, `+`, or `1.`/`2.`/...) + space
 *   - strip surrounding backticks (single or triple)
 *   - reject empty results and lines containing an unescaped space
 */
function extractFromMarkdown(
  body: string,
  section: string,
): { found: boolean; raw: string[]; skipped: number } {
  const lines = body.split(/\r?\n/);
  const target = section.trimEnd();
  let i = 0;
  let found = false;
  for (; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, "") === target) {
      found = true;
      i++;
      break;
    }
  }
  if (!found) return { found: false, raw: [], skipped: 0 };
  const raw: string[] = [];
  let skipped = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next markdown heading.
    if (/^#/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("<!--")) continue;
    // Strip leading list markers: `-`, `*`, `+`, or numeric `1.` / `2.`.
    let candidate = trimmed.replace(/^([-*+]|\d+\.)\s+/, "");
    // Strip surrounding triple or single backticks.
    candidate = candidate.replace(/^```+|```+$/g, "").replace(/^`+|`+$/g, "");
    candidate = candidate.trim();
    if (!candidate) {
      skipped++;
      continue;
    }
    // Reject obvious non-paths: contains an unescaped space (anything that
    // looks like a sentence, not a glob/path).
    if (/(?<!\\)\s/.test(candidate)) {
      skipped++;
      continue;
    }
    raw.push(candidate);
  }
  return { found: true, raw, skipped };
}

/**
 * Validate one already-extracted pattern. Returns the cleaned string if it
 * passes, or null if it should be skipped. (extractFromMarkdown already
 * applies these checks; this is the same gate for `paths` array entries so
 * inline callers can't bypass them.)
 */
function validatePattern(p: string): string | null {
  const trimmed = p.replace(/^`+|`+$/g, "").trim();
  if (!trimmed) return null;
  if (/(?<!\\)\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve a workspace-relative path for the `source` field of a rule-file
 * provenance. Falls back to the as-given string if the relative form would
 * escape the workspace (i.e. starts with `..`).
 */
function workspaceRelative(filePath: string): string {
  try {
    const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
    const rel = relative(process.cwd(), abs).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) return rel;
    return filePath.replace(/\\/g, "/");
  } catch {
    return filePath;
  }
}

export async function batchFreezePatterns(args: BatchFreezeArgs): Promise<BatchFreezeResult> {
  const projectId = args.project_id ?? currentProjectId;
  const dryRun = args.dry_run ?? false;
  const section = args.section ?? DEFAULT_SECTION;

  if ((!args.paths || args.paths.length === 0) && !args.from_rule_file) {
    return {
      action: "batch_freeze_patterns",
      project_id: projectId,
      added: 0,
      deduped: 0,
      skipped: 0,
      source: "none",
      dry_run: dryRun,
      error: "At least one of `paths` or `from_rule_file` must be provided.",
    };
  }

  // Build the candidate pool: { pattern, source } for each accepted line.
  // Inline `paths` come first so their `source_tag` (or "inline") wins if
  // the same pattern shows up in both the array AND the rule file.
  type Candidate = { pattern: string; source: string };
  const candidates: Candidate[] = [];
  let skipped = 0;
  let resolvedSource = "";
  let sectionMissing = false;

  if (args.paths && args.paths.length > 0) {
    const inlineSource = args.source_tag ?? "inline";
    for (const raw of args.paths) {
      const ok = validatePattern(raw);
      if (!ok) {
        skipped++;
        continue;
      }
      candidates.push({ pattern: ok, source: inlineSource });
    }
    resolvedSource = inlineSource;
  }

  if (args.from_rule_file) {
    const rulePath = args.from_rule_file;
    const ruleSource = args.source_tag ?? workspaceRelative(rulePath);
    let body: string;
    try {
      body = await readFile(rulePath, "utf8");
    } catch (e) {
      return {
        action: "batch_freeze_patterns",
        project_id: projectId,
        added: 0,
        deduped: 0,
        skipped: 0,
        source: ruleSource,
        dry_run: dryRun,
        error: `Failed to read rule file: ${(e as Error).message}`,
      };
    }
    const ext = extractFromMarkdown(body, section);
    if (!ext.found) {
      sectionMissing = true;
      resolvedSource = ruleSource;
    } else {
      for (const pat of ext.raw) {
        candidates.push({ pattern: pat, source: ruleSource });
      }
      skipped += ext.skipped;
      // Rule file source label trumps inline if both supplied (more
      // descriptive). Inline source is still attached per-candidate above.
      resolvedSource = ruleSource;
    }
  }

  if (sectionMissing && candidates.length === 0) {
    return {
      action: "batch_freeze_patterns",
      project_id: projectId,
      added: 0,
      deduped: 0,
      skipped: 0,
      source: resolvedSource,
      dry_run: dryRun,
      error: "section not found",
    };
  }

  // Compute the prospective new cache.
  const cache = await loadFrozenCache();
  const key = slugify(projectId);
  const bucket = (cache.projects[key] ??= []);
  const existingPatterns = new Set(bucket.map((e) => e.pattern));

  let added = 0;
  let deduped = 0;
  const newPatterns: string[] = [];
  const newEntries: FrozenEntry[] = [];
  const now = Date.now();
  // Track patterns staged in *this* batch so the second occurrence in the
  // same call counts as a dedup, not a second add.
  const batchSeen = new Set<string>();

  for (const c of candidates) {
    if (existingPatterns.has(c.pattern) || batchSeen.has(c.pattern)) {
      deduped++;
      continue;
    }
    batchSeen.add(c.pattern);
    const entry: FrozenEntry = {
      pattern: c.pattern,
      source: c.source,
      added_at: now,
    };
    newEntries.push(entry);
    newPatterns.push(c.pattern);
    added++;
  }

  if (dryRun) {
    return {
      action: "batch_freeze_patterns",
      project_id: projectId,
      added,
      deduped,
      skipped,
      source: resolvedSource || "none",
      dry_run: true,
      patterns: newPatterns,
    };
  }

  // Persist: append new entries to the cache, atomic-write, and mirror to
  // Supabase so the existing freeze_file/unfreeze_file flow stays consistent.
  if (newEntries.length > 0) {
    bucket.push(...newEntries);
    await writeFrozenCache(cache);
    for (const e of newEntries) {
      try {
        await addFrozenPattern(projectId, e.pattern, `batch_freeze_patterns: ${e.source}`);
      } catch {
        // Supabase mirror is best-effort. Cache (read by the hook) is
        // authoritative for blocking; if the network is down the freeze
        // still takes effect on disk.
      }
    }
  }

  return {
    action: "batch_freeze_patterns",
    project_id: projectId,
    added,
    deduped,
    skipped,
    source: resolvedSource || "none",
    dry_run: false,
  };
}
