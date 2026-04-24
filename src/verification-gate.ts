// Shared pending-verification flag used by the Hard Stop / Manual Test Gate.
// The MCP server writes this file after any code-producing tool call; the hook
// reads it to block subsequent destructive tool calls; confirm_verification
// clears it.
import { writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

export const FLAG_DIR = process.env.CLAUDE_MEMORY_GATE_DIR ?? join(homedir(), ".claude-memory");
export const FLAG_PATH = join(FLAG_DIR, "verification-pending.json");

export type PendingFlag = {
  tool: string;
  file: string;
  project_id?: string;
  created_at: string;
  reason?: string;
};

export async function setPending(payload: PendingFlag): Promise<void> {
  await writeFile(FLAG_PATH, JSON.stringify(payload, null, 2), { flag: "w" }).catch(async () => {
    // If the dir doesn't exist, create it via os.tmpdir fallback then retry at FLAG_DIR.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(FLAG_DIR, { recursive: true });
    await writeFile(FLAG_PATH, JSON.stringify(payload, null, 2));
  });
}

export async function clearPending(): Promise<boolean> {
  try {
    await rm(FLAG_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function getPending(): Promise<PendingFlag | null> {
  try {
    await stat(FLAG_PATH);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(FLAG_PATH, "utf8");
    return JSON.parse(raw) as PendingFlag;
  } catch {
    return null;
  }
}

void tmpdir; // satisfy ts lint; kept for future fallback
