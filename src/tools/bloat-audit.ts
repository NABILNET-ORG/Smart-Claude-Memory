import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

export const BLOAT_THRESHOLD = 10000;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function resolveHiddenMemory(workspaceAbs: string): Promise<string | null> {
  try {
    const home = os.homedir();
    const isWin = process.platform === "win32";
    let encoded = workspaceAbs.replace(/[:\\/ ]/g, "-");
    if (isWin) encoded = encoded.toLowerCase();
    const primary = path.join(home, ".claude", "projects", encoded, "memory", "MEMORY.md");
    if (await fileExists(primary)) return primary;
    // Fallback scan
    const projectsDir = path.join(home, ".claude", "projects");
    const basename = path.basename(workspaceAbs).toLowerCase();
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!e.name.toLowerCase().includes(basename)) continue;
        const cand = path.join(projectsDir, e.name, "memory", "MEMORY.md");
        if (await fileExists(cand)) return cand;
      }
    } catch {
      /* ignore */
    }
    return null;
  } catch {
    return null;
  }
}

export interface BloatAuditFile {
  path: string | null;
  tokens: number;
  bloated: boolean;
  found?: boolean;
}

export interface BloatAudit {
  threshold: number;
  claude_md: BloatAuditFile;
  hidden_memory: BloatAuditFile;
}

export interface SovereignPurgeRecommendation {
  id: "sovereign_purge";
  description: string;
  bloat_audit: BloatAudit;
  agent_protocol: "ASK_USER_THEN_EXECUTE";
  steps: string[];
  legacy_targets: { claude_md: string; hidden_memory: string | null };
  destination: string;
}

export async function auditBloat(workspace: string): Promise<{
  bloat_audit: BloatAudit;
  sovereign_purge_recommendation: SovereignPurgeRecommendation | null;
}> {
  const claudeMdPath = path.join(workspace, "CLAUDE.md");
  const claudeMd = await readSafe(claudeMdPath);
  const claudeMdTokens = estimateTokens(claudeMd);
  const claudeMdBloated = claudeMdTokens > BLOAT_THRESHOLD;

  const hiddenMemoryPath = await resolveHiddenMemory(workspace);
  const hiddenMemory = hiddenMemoryPath ? await readSafe(hiddenMemoryPath) : "";
  const hiddenMemoryTokens = estimateTokens(hiddenMemory);
  const hiddenMemoryBloated = hiddenMemoryTokens > BLOAT_THRESHOLD;

  const bloat_audit: BloatAudit = {
    threshold: BLOAT_THRESHOLD,
    claude_md: { path: claudeMdPath, tokens: claudeMdTokens, bloated: claudeMdBloated },
    hidden_memory: {
      path: hiddenMemoryPath,
      tokens: hiddenMemoryTokens,
      bloated: hiddenMemoryBloated,
      found: hiddenMemoryPath !== null,
    },
  };

  const anyBloated = claudeMdBloated || hiddenMemoryBloated;
  if (!anyBloated) return { bloat_audit, sovereign_purge_recommendation: null };

  const recommendation: SovereignPurgeRecommendation = {
    id: "sovereign_purge",
    description: `Bloat detected (CLAUDE.md=${claudeMdTokens} tokens, hidden MEMORY.md=${hiddenMemoryTokens} tokens; threshold=${BLOAT_THRESHOLD}). Auto-purge will safely migrate legacy content to Supabase vectors and reset files to the clean DNA v2.1 baseline.`,
    bloat_audit,
    agent_protocol: "ASK_USER_THEN_EXECUTE",
    steps: [
      "Ask the user for explicit YES/NO permission before doing anything.",
      "On YES: (a) mkdir -p docs/scm-memory/  (b) move CLAUDE.md -> docs/scm-memory/legacy_claude.md  (c) if hidden MEMORY.md exists, copy it to docs/scm-memory/legacy_memory.md  (d) call sync_local_memory({ force: true }) so the legacy files are vectorized into Supabase  (e) call ensureSovereignConstitution({ force: true }) to regenerate a fresh v2.1 CLAUDE.md  (f) report a 2-line synthesis to the user.",
      "On NO: do nothing this session; the recommendation will resurface next init_project.",
    ],
    legacy_targets: {
      claude_md: claudeMdPath,
      hidden_memory: hiddenMemoryPath,
    },
    destination: path.join(workspace, "docs", "scm-memory"),
  };

  return { bloat_audit, sovereign_purge_recommendation: recommendation };
}
