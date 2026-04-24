import { readFile, copyFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { detectProjectType, type ProjectType } from "../project-detect.js";

// TODO(v1.2.0): drop the legacy CLAUDE_MEMORY_GATE_DIR fallback after the Smart Claude Memory rebrand has settled.
// The on-disk dir `~/.claude-memory` is intentionally preserved to keep existing backups discoverable.
const GATE_DIR =
  process.env.SMART_CLAUDE_MEMORY_GATE_DIR ??
  process.env.CLAUDE_MEMORY_GATE_DIR ??
  join(homedir(), ".claude-memory");
const BACKUP_INDEX_PATH = join(GATE_DIR, "backup-index.json");

// ─── Import scanner (regex-based, heuristic) ─────────────────────────────

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*export\s+(?:\*\s+)?from\s+['"]([^'"]+)['"]/gm,
  ],
  js: [
    /^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*export\s+(?:\*\s+)?from\s+['"]([^'"]+)['"]/gm,
  ],
  dart: [
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+['"]([^'"]+)['"]/gm,
    /^\s*part\s+['"]([^'"]+)['"]/gm,
    /^\s*part\s+of\s+['"]([^'"]+)['"]/gm,
  ],
  py: [
    /^\s*from\s+(\S+)\s+import\b/gm,
    /^\s*import\s+([\w.,\s]+)$/gm,
  ],
};

function extForPatterns(p: string): keyof typeof IMPORT_PATTERNS | null {
  const e = p.toLowerCase();
  if (e.endsWith(".ts") || e.endsWith(".tsx")) return "ts";
  if (e.endsWith(".js") || e.endsWith(".jsx") || e.endsWith(".mjs") || e.endsWith(".cjs")) return "js";
  if (e.endsWith(".dart")) return "dart";
  if (e.endsWith(".py")) return "py";
  return null;
}

export async function scanImports(filePath: string): Promise<string[]> {
  const lang = extForPatterns(filePath);
  if (!lang) return [];
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const re of IMPORT_PATTERNS[lang]) {
    let m: RegExpExecArray | null;
    const src = new RegExp(re.source, re.flags);
    while ((m = src.exec(text)) !== null) {
      const raw = m[1]?.trim();
      if (!raw) continue;
      if (lang === "py" && raw.includes(",")) {
        for (const name of raw.split(",")) {
          const t = name.trim();
          if (t) found.add(t);
        }
      } else {
        found.add(raw);
      }
    }
  }
  return [...found].sort();
}

// ─── Compiler gate ────────────────────────────────────────────────────────

type GateResult = {
  workspace: string;
  project_type: ProjectType;
  command: string | null;
  ran: boolean;
  exit_code: number | null;
  ok: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  note: string;
};

/**
 * Run a native binary via spawn WITHOUT shell:true. All inputs come from the
 * compile-time project-type lookup, not from user input — but we still avoid
 * the shell path so no interpolation can ever reach /bin/sh or cmd.exe.
 * On Windows, .cmd shims (npm, npx) need an explicit extension.
 */
function runBin(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const winBin = process.platform === "win32" && /^(npm|npx|yarn|pnpm)$/i.test(bin) ? `${bin}.cmd` : bin;
    // Windows: shell:true is required to launch .cmd/.bat shims; args are internal (no user input).
    const child = process.platform === "win32"
      ? spawn(winBin, args, { cwd, shell: true })
      : spawn(winBin, args, { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      resolveResult({ code: null, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  });
}

export async function compilerGate(workspace?: string): Promise<GateResult> {
  const ws = resolve(workspace ?? process.cwd());
  const det = await detectProjectType(ws);
  const t0 = Date.now();

  if (!det.compiler_gate_command) {
    return {
      workspace: ws,
      project_type: det.type,
      command: null,
      ran: false,
      exit_code: null,
      ok: false,
      duration_ms: 0,
      stdout_tail: "",
      stderr_tail: "",
      note: `No compiler-gate command for project type '${det.type}'. Configure one manually or skip.`,
    };
  }

  const { bin, args } = det.compiler_gate_command;
  const { code, stdout, stderr } = await runBin(bin, args, ws);
  const duration = Date.now() - t0;
  const ok = code === 0;

  return {
    workspace: ws,
    project_type: det.type,
    command: `${bin} ${args.join(" ")}`,
    ran: true,
    exit_code: code,
    ok,
    duration_ms: duration,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-2000),
    note: ok
      ? `Compiler check passed (${duration} ms).`
      : `Compiler check FAILED (exit ${code}). If this follows a recent refactor, call refactor_guard with action:"rollback" to restore the pre-edit backup.`,
  };
}

// ─── Rollback from hook backup-index ──────────────────────────────────────

type BackupRecord = { backup: string; tool: string; timestamp: string };

async function readBackupIndex(): Promise<Record<string, BackupRecord>> {
  try {
    const raw = await readFile(BACKUP_INDEX_PATH, "utf8");
    const data = JSON.parse(raw) as { entries?: Record<string, BackupRecord> };
    return data.entries ?? {};
  } catch {
    return {};
  }
}

export async function rollbackFile(file: string): Promise<{
  file: string;
  restored: boolean;
  from?: string;
  tool?: string;
  timestamp?: string;
  warning?: string;
}> {
  const abs = resolve(file);
  const entries = await readBackupIndex();
  const record =
    entries[abs] ??
    entries[file] ??
    entries[abs.replace(/\\/g, "/")];
  if (!record) {
    return {
      file: abs,
      restored: false,
      warning: `No hook-managed backup found for ${abs}. Check backup-index.json or restore manually.`,
    };
  }
  try {
    await stat(record.backup);
  } catch {
    return {
      file: abs,
      restored: false,
      from: record.backup,
      warning: `Backup file referenced in the index no longer exists at ${record.backup}.`,
    };
  }
  try {
    await copyFile(record.backup, abs);
  } catch (e) {
    return {
      file: abs,
      restored: false,
      from: record.backup,
      warning: `Restore failed: ${(e as Error).message}`,
    };
  }
  return {
    file: abs,
    restored: true,
    from: record.backup,
    tool: record.tool,
    timestamp: record.timestamp,
  };
}

// ─── Public tool surface ──────────────────────────────────────────────────

export type RefactorGuardArgs =
  | { action: "plan"; paths: string[] }
  | { action: "gate"; workspace?: string }
  | { action: "rollback"; file: string };

export async function refactorGuard(args: RefactorGuardArgs) {
  switch (args.action) {
    case "plan": {
      const out: Array<{ file: string; imports: string[] }> = [];
      for (const p of args.paths) {
        const abs = resolve(p);
        out.push({ file: abs, imports: await scanImports(abs) });
      }
      return {
        action: "plan",
        files: out,
        note:
          "Imports are extracted with language-specific regexes, not a full parser. Use these as a coupling signal; verify cross-file dependencies manually before splitting.",
      };
    }
    case "gate":
      return { action: "gate", ...(await compilerGate(args.workspace)) };
    case "rollback":
      return { action: "rollback", ...(await rollbackFile(args.file)) };
  }
}
