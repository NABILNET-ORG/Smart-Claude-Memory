import { stat, readFile, mkdir, rename, copyFile, rm } from "node:fs/promises";
import { resolve, dirname, basename, relative, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { glob } from "glob";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpEntryPoint = resolve(packageRoot, "dist", "index.js").replace(/\\/g, "/");

type CheckStatus = "ok" | "warn" | "missing";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

const REQUIRED_ENV = [
  { key: "SUPABASE_URL", desc: "Supabase project URL" },
  { key: "SUPABASE_SECRET_KEY", desc: "Supabase service-role key" },
  { key: "OLLAMA_HOST", desc: "Ollama endpoint (default http://localhost:11434)" },
  { key: "OLLAMA_EMBED_MODEL", desc: "Embedding model name (default nomic-embed-text)" },
  { key: "MEMORY_ROOTS", desc: "Semicolon-separated folders to sync" },
] as const;

const RECOMMENDED_ENV = [
  { key: "SUPABASE_POOLER_URL", desc: "IPv4-reachable pooler URL (required for apply-schema)" },
  { key: "EMBED_DIM", desc: "Embedding vector dimension (defaults to 768)" },
] as const;

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findHookScript(workspace: string): Promise<string | null> {
  const candidates = [
    resolve(workspace, ".claude", "hooks", "md-policy.py"),
    resolve(workspace, "hooks", "md-policy.py"),
    resolve(homedir(), ".claude", "hooks", "md-policy.py"),
    resolve(packageRoot, "hooks", "md-policy.py"),
  ];
  for (const p of candidates) if (await fileExists(p)) return p;
  return null;
}

async function settingsRegistration(workspace: string): Promise<{
  registered: boolean;
  matches: string[];
}> {
  const candidates = [
    resolve(workspace, ".mcp.json"),
    resolve(workspace, ".claude", "settings.json"),
    resolve(workspace, ".claude", "settings.local.json"),
    resolve(homedir(), ".claude.json"),
    resolve(homedir(), ".claude", "settings.json"),
  ];
  const matches: string[] = [];
  for (const p of candidates) {
    try {
      const content = await readFile(p, "utf8");
      // Path separator is already forward-slashed in our comparison string.
      // Normalize the file content the same way for the match.
      if (content.replace(/\\\\/g, "/").replace(/\\/g, "/").includes(mcpEntryPoint)) {
        matches.push(p);
      }
    } catch {
      /* ignore missing config files */
    }
  }
  return { registered: matches.length > 0, matches };
}

export async function initProject(args: {
  workspace?: string;
  sweep_legacy?: "dry" | "commit" | "off";
  arch?: boolean;
} = {}): Promise<{
  action: "init_project";
  workspace: string;
  expected_mcp_entry: string;
  overall: "ready" | "partial" | "not_ready";
  checks: Check[];
  architecture_synced: { path: string; written: boolean } | null;
  legacy_sweep: unknown;
}> {
  const ws = resolve(args.workspace ?? process.cwd());
  const checks: Check[] = [];

  // 1. Required env vars
  for (const { key, desc } of REQUIRED_ENV) {
    const val = process.env[key];
    checks.push({
      name: `env:${key}`,
      status: val ? "ok" : "missing",
      detail: val ? `${desc} — set` : `${desc} — MISSING in .env`,
      fix: val ? undefined : `Add ${key}=... to ${resolve(packageRoot, ".env")} (see .env.example).`,
    });
  }

  // 2. Recommended env vars
  for (const { key, desc } of RECOMMENDED_ENV) {
    const val = process.env[key];
    checks.push({
      name: `env:${key}`,
      status: val ? "ok" : "warn",
      detail: val ? `${desc} — set` : `${desc} — not set (falls back to default)`,
      fix: val ? undefined : `Recommended: add ${key} to .env.`,
    });
  }

  // 3. md-policy.py hook presence
  const hook = await findHookScript(ws);
  checks.push({
    name: "hook:md-policy.py",
    status: hook ? "ok" : "warn",
    detail: hook
      ? `Hook script present at ${hook}`
      : "Hook script not located — Guardian rules (750-line, frozen features, Manual Test Gate) will be advisory only.",
    fix: hook
      ? undefined
      : `Copy ${resolve(packageRoot, "hooks", "md-policy.py")} into ${ws}/.claude/hooks/ and add a PreToolUse entry in .claude/settings.json (see hooks/README.md).`,
  });

  // 4. MCP server registration
  const reg = await settingsRegistration(ws);
  checks.push({
    name: "mcp:registration",
    status: reg.registered ? "ok" : "missing",
    detail: reg.registered
      ? `smart-claude-memory MCP server registered in: ${reg.matches.join(", ")}`
      : `smart-claude-memory MCP server is not registered in any known settings file. Expected the path ${mcpEntryPoint} to appear in one of them.`,
    fix: reg.registered
      ? undefined
      : `Add to ~/.claude.json under "mcpServers":\n  "smart-claude-memory": { "type":"stdio", "command":"node", "args":["${mcpEntryPoint}"] }\nThen restart Claude Code.`,
  });

  // 5. Compiled dist present?
  const distOk = await fileExists(resolve(packageRoot, "dist", "index.js"));
  checks.push({
    name: "build:dist",
    status: distOk ? "ok" : "missing",
    detail: distOk ? `Compiled dist/ found` : `dist/index.js does not exist`,
    fix: distOk ? undefined : `Run: npm install && npm run build`,
  });

  const anyMissing = checks.some((c) => c.status === "missing");
  const anyWarn = checks.some((c) => c.status === "warn");
  const overall: "ready" | "partial" | "not_ready" = anyMissing
    ? "not_ready"
    : anyWarn
      ? "partial"
      : "ready";

  // Auto-artefacts: generate the architecture doc on every init so new
  // projects get a diagram without having to run session_end first.
  let architectureSynced: { path: string; written: boolean } | null = null;
  if (args?.arch !== false) {
    try {
      architectureSynced = await writeProjectArchitectureOnInit(ws);
    } catch (e) {
      architectureSynced = { path: "", written: false };
    }
  }

  // Optional: first-init legacy sweep. 'dry' (default) previews only; 'commit'
  // moves HIGH-confidence matches; 'off' skips the scan entirely.
  let legacySweep: unknown = null;
  const sweepMode = args?.sweep_legacy ?? "dry";
  if (sweepMode !== "off") {
    legacySweep = await sweepLegacyBackups({
      workspace: ws,
      confirm: sweepMode === "commit",
    });
  }

  return {
    action: "init_project",
    workspace: ws,
    expected_mcp_entry: mcpEntryPoint,
    overall,
    checks,
    architecture_synced: architectureSynced,
    legacy_sweep: legacySweep,
  };
}

async function writeProjectArchitectureOnInit(
  workspace: string,
): Promise<{ path: string; written: boolean }> {
  const docPath = resolve(workspace, "project_file_architecture.md");
  // The backlog tool already owns the Mermaid renderer; calling a dedicated
  // small helper here would duplicate logic. We simply touch the file with a
  // pointer so session_end (which handles the real generation) knows to
  // overwrite the mermaid block. If the file is already present we leave it.
  try {
    await stat(docPath);
    return { path: docPath, written: false };
  } catch {
    const seed = [
      `# Project File Architecture`,
      "",
      `> Auto-created by smart-claude-memory init_project. The Mermaid block is `,
      `> populated by manage_backlog({ action: "session_end" }).`,
      "",
      "## Tree",
      "",
      "```mermaid",
      "flowchart TD",
      '  n0["(run session_end to populate)"]',
      "```",
    ].join("\n");
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(docPath, seed, "utf8");
      return { path: docPath, written: true };
    } catch {
      return { path: docPath, written: false };
    }
  }
}

// ─── Legacy backup sweep ──────────────────────────────────────────────────

export type LegacyBackupConfidence = "high" | "medium" | "low";

export type LegacyBackupCandidate = {
  path: string;
  relative_path: string;
  confidence: LegacyBackupConfidence;
  reason: string;
  proposed_dest?: string;
  moved?: boolean;
  move_error?: string;
};

const LEGACY_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/backups/**", // the destination itself
];

/**
 * Classify a filename as a legacy backup. Returns null if nothing matches.
 *
 * HIGH-confidence rules are conservative enough to auto-move:
 *   - *.bak / *.backup / *.old extensions
 *   - Explicit `_backup` / `-backup` / `.backup` separator suffixes
 *   - `old_backup_*` or `backup_*` prefix
 *   - Timestamped `backup[_.-]\d{4,}` patterns
 *
 * MEDIUM: filename contains "backup" but doesn't match strict patterns.
 * Examples of things that END UP MEDIUM and therefore are NOT moved without
 * --aggressive: backup-service.ts, backup_restore.py, my-backup-utils.js.
 */
/**
 * Tokens that flag a file as probable production code even if its name
 * contains "backup". A file called `backup-service.ts` is a service that
 * DOES backups, not a backup OF a file. Files matching this pattern are
 * downgraded from HIGH to MEDIUM so they never get auto-moved.
 */
const PRODUCTION_QUALIFIER = new RegExp(
  "\\b(" +
    [
      "service", "services",
      "util", "utils", "helper", "helpers",
      "restore", "restorer",
      "manager", "handler", "controller",
      "tool", "tools",
      "provider", "factory", "gateway", "adapter", "client",
      "store", "registry", "router", "middleware",
      "config", "schema", "type", "types", "model", "models",
      "validator", "loader", "parser", "formatter", "serializer",
      // Operational-script vocabulary (caught scripts/backup-and-remove.ts in v0.9.1)
      "remove", "delete", "purge", "cleanup", "clean",
      "sync", "runner", "worker", "job",
      "init", "setup", "bootstrap", "install",
      "cli", "script", "entry", "main", "index",
      "archive", "archiver",
    ].join("|") +
    ")\\b",
  "i",
);

function hasProductionQualifier(base: string): boolean {
  // Treat hyphens/underscores/dots as word boundaries so 'backup-service.ts'
  // is seen as ['backup', 'service', 'ts'] when testing for qualifiers.
  const tokenized = base.replace(/[_\-.]/g, " ");
  return PRODUCTION_QUALIFIER.test(tokenized);
}

export function classifyLegacyBackup(
  filename: string,
): { confidence: LegacyBackupConfidence; reason: string } | null {
  const base = basename(filename);
  const lower = base.toLowerCase();

  const downgrade = hasProductionQualifier(base);

  // Extension is the strongest signal — .bak / .backup / .old almost never
  // belong to a live build artifact path. Still downgrade if the filename
  // otherwise looks production-y.
  if (/\.(bak|backup|old)$/i.test(base)) {
    return {
      confidence: downgrade ? "medium" : "high",
      reason: downgrade
        ? "backup-file extension but production qualifier in name"
        : "backup-file extension (.bak/.backup/.old)",
    };
  }

  if (/[_.-]backup\.[a-z0-9]+$/i.test(base)) {
    return {
      confidence: downgrade ? "medium" : "high",
      reason: downgrade
        ? "_backup suffix but production qualifier in name — likely production code"
        : "explicit _backup/-backup/.backup suffix before extension",
    };
  }

  if (/^(old[_-])?backup[_-][^/]+\.[a-z0-9]+$/i.test(base)) {
    return {
      confidence: downgrade ? "medium" : "high",
      reason: downgrade
        ? "backup- prefix but production qualifier in name"
        : "backup-prefixed filename",
    };
  }

  if (/backup[_.-]\d{4,}/i.test(base)) {
    return { confidence: "high", reason: "timestamped backup filename" };
  }

  if (lower.includes("backup")) {
    return { confidence: "medium", reason: "filename contains 'backup' but no strict pattern match" };
  }
  return null;
}

async function scanLegacyCandidates(workspace: string): Promise<LegacyBackupCandidate[]> {
  const hits = await glob("**/*", {
    cwd: workspace,
    absolute: true,
    nodir: true,
    ignore: LEGACY_IGNORE,
    dot: false,
  });
  const out: LegacyBackupCandidate[] = [];
  for (const p of hits) {
    const cls = classifyLegacyBackup(p);
    if (!cls) continue;
    out.push({
      path: p,
      relative_path: relative(workspace, p),
      confidence: cls.confidence,
      reason: cls.reason,
    });
  }
  // Sort HIGH first, then MEDIUM, then alpha.
  const order = { high: 0, medium: 1, low: 2 };
  out.sort(
    (a, b) =>
      order[a.confidence] - order[b.confidence] ||
      a.relative_path.localeCompare(b.relative_path),
  );
  return out;
}

/**
 * Non-blocking, write-free summary of legacy backups in a workspace.
 * Used by the server's startup probe and also exposed as a tool for
 * ad-hoc inspection.
 */
export async function legacyBackupSummary(workspace: string): Promise<{
  workspace: string;
  total: number;
  high: number;
  medium: number;
  top_examples: string[];
}> {
  const candidates = await scanLegacyCandidates(workspace);
  return {
    workspace,
    total: candidates.length,
    high: candidates.filter((c) => c.confidence === "high").length,
    medium: candidates.filter((c) => c.confidence === "medium").length,
    top_examples: candidates.slice(0, 5).map((c) => `[${c.confidence}] ${c.relative_path}`),
  };
}

async function moveWithFallback(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (e) {
    // Cross-device rename isn't allowed; fall back to copy+delete.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM") {
      await copyFile(src, dest);
      await rm(src, { force: true });
    } else {
      throw e;
    }
  }
}

export async function sweepLegacyBackups(args: {
  workspace?: string;
  confirm?: boolean;
  aggressive?: boolean;
  dest?: string;
} = {}): Promise<{
  action: "sweep_legacy_backups";
  workspace: string;
  dest: string;
  mode: "dry_run" | "committed";
  tier_moved: "high_only" | "high_and_medium";
  candidates: LegacyBackupCandidate[];
  moved: number;
  skipped: number;
  notes: string[];
}> {
  const workspace = resolve(args.workspace ?? process.cwd());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = resolve(args.dest ?? join(workspace, "backups", `legacy-sweep-${stamp}`));
  const candidates = await scanLegacyCandidates(workspace);

  // Compute proposed_dest for every candidate so dry-run previews are useful.
  for (const c of candidates) {
    c.proposed_dest = join(dest, c.relative_path);
  }

  const wantTier: "high_only" | "high_and_medium" = args.aggressive
    ? "high_and_medium"
    : "high_only";

  if (!args.confirm) {
    return {
      action: "sweep_legacy_backups",
      workspace,
      dest,
      mode: "dry_run",
      tier_moved: wantTier,
      candidates,
      moved: 0,
      skipped: candidates.length,
      notes: [
        "DRY RUN — no files moved.",
        `Would move ${candidates.filter((c) => c.confidence === "high").length} HIGH-confidence file(s) with confirm:true.`,
        `Set aggressive:true to also move ${candidates.filter((c) => c.confidence === "medium").length} MEDIUM-confidence file(s) (filenames that contain 'backup' without a strict pattern — may include production code like backup-service.ts).`,
        "Re-run with confirm:true (and optionally aggressive:true) to commit.",
      ],
    };
  }

  let moved = 0;
  let skipped = 0;
  const notes: string[] = [];

  for (const c of candidates) {
    const shouldMove =
      c.confidence === "high" || (wantTier === "high_and_medium" && c.confidence === "medium");
    if (!shouldMove) {
      skipped++;
      continue;
    }
    try {
      await moveWithFallback(c.path, c.proposed_dest!);
      c.moved = true;
      moved++;
    } catch (e) {
      c.move_error = (e as Error).message;
      skipped++;
    }
  }

  if (moved > 0) notes.push(`Moved ${moved} file(s) into ${dest}.`);
  if (skipped > 0)
    notes.push(`Skipped ${skipped} candidate(s) — lower confidence or move error (see candidates[].move_error).`);
  notes.push("Originals are gone. If the sweep picked up production code by mistake, restore from git or the new backups/ subdir.");

  return {
    action: "sweep_legacy_backups",
    workspace,
    dest,
    mode: "committed",
    tier_moved: wantTier,
    candidates,
    moved,
    skipped,
    notes,
  };
}
