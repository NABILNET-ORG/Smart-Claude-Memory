import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    // Index may store raw or resolved forms — try a few.
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

    return {
      action: "confirm_verification",
      success: true,
      previously_pending: existing,
      cleared,
      auto_freeze: autoFreeze,
      latest_backup: latestBackup,
      flag_path: FLAG_PATH,
      message: cleared
        ? "Gate cleared. You may proceed with further tool calls."
        : "No pending verification was active. Nothing to clear.",
    };
  }

  // success:false → keep the gate closed, annotate with notes, and surface
  // the backup location prominently so the caller can restore from it.
  if (existing) {
    await setPending({ ...existing, reason: args.notes ?? "Verification failed" });
  }
  const latestBackup = existing?.file ? await getLatestBackup(existing.file) : null;
  const recoveryMessage = latestBackup
    ? `Verification FAILED for ${existing?.file}. RECOVERY: read the pre-edit snapshot at ${latestBackup.backup} (created by ${latestBackup.tool} at ${latestBackup.timestamp}) and either restore it verbatim or use it to patch the broken logic. Then re-verify manually before calling confirm_verification with success:true.`
    : `Verification FAILED${existing?.file ? ` for ${existing.file}` : ""}. No backup was recorded — fix the logic manually and re-verify, then call confirm_verification with success:true.`;

  return {
    action: "confirm_verification",
    success: false,
    still_pending: existing,
    latest_backup: latestBackup,
    flag_path: FLAG_PATH,
    message: recoveryMessage,
  };
}

export async function raisePendingVerification(payload: PendingFlag) {
  await setPending(payload);
}
