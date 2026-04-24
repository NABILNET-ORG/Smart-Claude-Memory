import { resolve, dirname, join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { glob } from "glob";
import { classifyLegacyBackup } from "./setup.js";
import {
  setPending,
  clearPending,
  getPending,
  FLAG_PATH,
  type PendingFlag,
} from "../verification-gate.js";
import { addFrozenPattern, writeFrozenPatternsCache } from "../supabase.js";
import { currentProjectId } from "../project.js";

const GATE_DIR = process.env.CLAUDE_MEMORY_GATE_DIR ?? join(homedir(), ".claude-memory");
const BACKUP_INDEX_PATH = join(GATE_DIR, "backup-index.json");

type BackupRecord = { backup: string; tool: string; timestamp: string };

async function getLatestBackup(filePath: string): Promise<BackupRecord | null> {
  try {
    const raw = await readFile(BACKUP_INDEX_PATH, "utf8");
    const data = JSON.parse(raw) as { entries?: Record<string, BackupRecord> };
    const abs = resolve(filePath);
    return (
      data.entries?.[abs] ??
      data.entries?.[filePath] ??
      data.entries?.[abs.replace(/\\/g, "/")] ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * When the hook-managed backup-index has no entry for a broken file (e.g.,
 * the break predates this plugin, or the backup was done manually by a
 * previous workflow), scan the project for legacy backups whose filenames
 * match the broken file's stem. Recognizes patterns like:
 *   logic_backup.ts, old_backup_auth.js, auth.ts.bak, payments.backup.ts
 */
async function findLegacyBackups(brokenFile: string): Promise<
  Array<{ path: string; confidence: "high" | "medium" | "low"; reason: string }>
> {
  const abs = resolve(brokenFile);
  const name = basename(abs);
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase();

  // Determine workspace root — walk up until we find a package.json or git dir.
  // If that fails, fall back to the broken file's directory.
  let workspace = dirname(abs);
  for (let i = 0; i < 8; i++) {
    try {
      await readFile(join(workspace, "package.json"));
      break;
    } catch {
      const parent = dirname(workspace);
      if (parent === workspace) break;
      workspace = parent;
    }
  }

  let hits: string[] = [];
  try {
    hits = await glob("**/*", {
      cwd: workspace,
      absolute: true,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
      ],
    });
  } catch {
    return [];
  }

  const out: Array<{ path: string; confidence: "high" | "medium" | "low"; reason: string }> = [];
  for (const p of hits) {
    if (resolve(p) === abs) continue;
    const cls = classifyLegacyBackup(p);
    if (!cls) continue;
    // Require the filename to mention the stem — otherwise we'd surface
    // every backup file in the project when only the ones matching the
    // broken file are relevant.
    const candidateBase = basename(p).toLowerCase();
    if (!candidateBase.includes(stem)) continue;
    out.push({
      path: p,
      confidence: cls.confidence,
      reason: `${cls.reason}; filename references '${stem}'`,
    });
  }
  // Sort HIGH first, then by relative path for stable ordering.
  const order = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => {
    if (a.confidence !== b.confidence) return order[a.confidence] - order[b.confidence];
    return relative(workspace, a.path).localeCompare(relative(workspace, b.path));
  });
  return out.slice(0, 20);
}

// Resolve the package root so auto-freeze can skip files inside this plugin —
// we don't want verification-success on our own source to start blocking our
// own Write calls.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function isClaudeMemorySource(filePath: string): boolean {
  try {
    const abs = resolve(filePath);
    // Normalize drive-letter casing on Windows so the startsWith check holds.
    return abs.toLowerCase().startsWith(packageRoot.toLowerCase());
  } catch {
    return false;
  }
}

export async function confirmVerification(args: { success: boolean; notes?: string }) {
  const existing = await getPending();

  if (args.success) {
    const cleared = await clearPending();

    // Auto-freeze: if the gate was raised for a file, that file is now
    // verified — add a frozen_features row so subsequent Writes to the same
    // path are blocked by the hook. Edits remain allowed.
    let autoFreeze:
      | { added: true; pattern: string; project_id: string; reason: string; cache_path: string }
      | { added: false; skipped_reason: string }
      | null = null;

    if (existing?.file) {
      if (isClaudeMemorySource(existing.file)) {
        autoFreeze = {
          added: false,
          skipped_reason:
            "System filter: file is inside the claude-memory package — not auto-freezing its own engine source.",
        };
      } else {
        const projectId = existing.project_id ?? currentProjectId;
        const reason = `Auto-frozen after successful manual verification. ${existing.reason ?? ""}`.trim();
        try {
          await addFrozenPattern(projectId, existing.file, reason);
          const cache = await writeFrozenPatternsCache();
          autoFreeze = {
            added: true,
            pattern: existing.file,
            project_id: projectId,
            reason,
            cache_path: cache.path,
          };
        } catch (e) {
          autoFreeze = {
            added: false,
            skipped_reason: `addFrozenPattern failed: ${(e as Error).message}`,
          };
        }
      }
    }

    const latestBackup = existing?.file ? await getLatestBackup(existing.file) : null;
    const legacyBackups = existing?.file && !latestBackup
      ? await findLegacyBackups(existing.file)
      : [];

    return {
      action: "confirm_verification",
      success: true,
      previously_pending: existing,
      cleared,
      auto_freeze: autoFreeze,
      latest_backup: latestBackup,
      legacy_backups: legacyBackups,
      flag_path: FLAG_PATH,
      message: cleared
        ? "Gate cleared. You may proceed with further tool calls."
        : "No pending verification was active. Nothing to clear.",
    };
  }

  // success:false → keep the gate closed, annotate with notes, and surface
  // both the hook-managed backup AND any legacy "*backup*" files that
  // reference the broken file's stem — so the AI has every restore option
  // in one response.
  if (existing) {
    await setPending({ ...existing, reason: args.notes ?? "Verification failed" });
  }
  const latestBackup = existing?.file ? await getLatestBackup(existing.file) : null;
  const legacyBackups = existing?.file ? await findLegacyBackups(existing.file) : [];

  const parts: string[] = [];
  parts.push(`Verification FAILED${existing?.file ? ` for ${existing.file}` : ""}.`);
  if (latestBackup) {
    parts.push(
      `PRIMARY RECOVERY: pre-edit snapshot at ${latestBackup.backup} ` +
        `(created by ${latestBackup.tool} at ${latestBackup.timestamp}).`,
    );
  }
  if (legacyBackups.length > 0) {
    const top = legacyBackups.slice(0, 3);
    parts.push(
      `LEGACY CANDIDATES: ${top.length} file${top.length === 1 ? "" : "s"} in the project whose name references '${basename(existing?.file ?? "").replace(/\.[^.]+$/, "")}' — e.g., ${top
        .map((b) => b.path)
        .join("; ")}. Treat these as additional restoration sources (they predate the plugin or came from prior workflows).`,
    );
  }
  if (!latestBackup && legacyBackups.length === 0) {
    parts.push("No backup was recorded and no legacy backup files match this file's stem. Restore from git or ask the user for the prior implementation.");
  }
  parts.push("Once fixed, call confirm_verification again with success:true.");

  return {
    action: "confirm_verification",
    success: false,
    still_pending: existing,
    latest_backup: latestBackup,
    legacy_backups: legacyBackups,
    flag_path: FLAG_PATH,
    message: parts.join(" "),
  };
}

export async function raisePendingVerification(payload: PendingFlag) {
  await setPending(payload);
}
