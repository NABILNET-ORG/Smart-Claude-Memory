import { stat, readFile, mkdir, rename, copyFile, rm } from "node:fs/promises";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname, basename, relative, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import { loadFrozenCache } from "./frozen-cache.js";
import { currentProjectId, slugify } from "../project.js";

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

// ─── v1.1.3: hydration scout for .claude/rules/*.md ─────────────────────
// Detect un-hydrated policy rule files containing a `## Frozen Patterns`
// section that have NOT yet been registered in the per-project frozen cache.
// Detection only — never mutates the cache (consent-not-write).

export type HydrateRecommendation = {
  id: "hydrate_policies";
  tool: "batch_freeze_patterns";
  candidates: Array<{ file: string; section_found: true }>;
  suggested_first_call: { from_rule_file: string; dry_run: true };
};

/**
 * Normalize a path for symmetric comparison between cache `entry.source`
 * values and freshly-discovered rule file paths.
 *
 * Rules:
 *   1. Absolute paths become workspace-relative; relatives are left alone.
 *   2. All backslashes → forward slashes.
 *   3. Strip any leading "./".
 *   4. On Windows, lowercase for case-insensitive comparison; otherwise
 *      preserve case (Linux is case-sensitive at the filesystem layer).
 */
function normalizeSource(p: string, workspace: string): string {
  let out = p;
  if (isAbsolute(out)) {
    out = relative(workspace, out);
  }
  out = out.replace(/\\/g, "/");
  if (out.startsWith("./")) out = out.slice(2);
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

async function detectHydrateRecommendations(
  workspace: string,
): Promise<HydrateRecommendation[]> {
  // Step A — fast-path exit when the rules dir is missing.
  const rulesDir = join(workspace, ".claude", "rules");
  if (!existsSync(rulesDir)) return [];

  // Step B — bounded scan of immediate-child .md files.
  // `encoding: "utf8"` pins the Dirent generic to `string`; the no-encoding
  // overload resolves to `Dirent<NonSharedBuffer>` under newer @types/node.
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = readdirSync(rulesDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const sectionPositive: string[] = []; // absolute paths that have the header
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const abs = join(rulesDir, entry.name);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const head = body.split(/\r?\n/).slice(0, 200);
    const hit = head.some((line) => line.trimEnd() === "## Frozen Patterns");
    if (!hit) continue;
    sectionPositive.push(abs);
  }

  if (sectionPositive.length === 0) return [];

  // Step C — provenance suppression. Build a set of normalized cache
  // sources for the *current* project bucket and drop already-hydrated
  // candidates.
  const hydrated = new Set<string>();
  try {
    const cache = await loadFrozenCache();
    const key = slugify(currentProjectId);
    const bucket = cache.projects[key] ?? [];
    for (const e of bucket) {
      if (!e.source || e.source === "legacy") continue;
      hydrated.add(normalizeSource(e.source, workspace));
    }
  } catch {
    // Best-effort accessory: if we can't read the cache, fall through
    // and include every candidate. The user can re-run later.
  }

  const actionable: string[] = [];
  for (const abs of sectionPositive) {
    const norm = normalizeSource(abs, workspace);
    if (hydrated.has(norm)) continue;
    actionable.push(norm);
  }

  if (actionable.length === 0) return [];

  // Determinism: sort alphabetically before picking the first call.
  actionable.sort((a, b) => a.localeCompare(b));

  return [
    {
      id: "hydrate_policies",
      tool: "batch_freeze_patterns",
      candidates: actionable.map((file) => ({ file, section_found: true as const })),
      suggested_first_call: {
        from_rule_file: actionable[0]!,
        dry_run: true as const,
      },
    },
  ];
}

// ─── Architecture Guard: Core 3 audit ──────────────────────────────────
// CLAUDE.md, README.md, ARCHITECTURE.md are treated as the project's
// three architectural sources of truth. init_project must surface their
// existence and rough sync state so the agent can delegate an audit
// before doing anything else.

export type Core3Name = "CLAUDE.md" | "README.md" | "ARCHITECTURE.md";

export type Core3File = {
  name: Core3Name;
  exists: boolean;
  mtime_iso: string | null;
  size_bytes: number;
};

export type Core3Audit = {
  files: Core3File[];
  in_sync: boolean;
  reason: string;
  required_action: "none" | "delegate_audit";
  directive: string;
};

const CORE3_NAMES: readonly Core3Name[] = ["CLAUDE.md", "README.md", "ARCHITECTURE.md"];
// mtime drift heuristic: if one of the Core 3 was edited >30 days after the
// others, assume someone updated one without propagating to the rest.
const CORE3_MTIME_DRIFT_DAYS = 30;

async function auditCore3(workspace: string): Promise<Core3Audit> {
  const files: Core3File[] = [];
  for (const name of CORE3_NAMES) {
    const p = resolve(workspace, name);
    try {
      const s = await stat(p);
      files.push({
        name,
        exists: true,
        mtime_iso: s.mtime.toISOString(),
        size_bytes: s.size,
      });
    } catch {
      files.push({ name, exists: false, mtime_iso: null, size_bytes: 0 });
    }
  }

  const missing = files.filter((f) => !f.exists).map((f) => f.name);
  if (missing.length > 0) {
    return {
      files,
      in_sync: false,
      reason: `Missing Core 3 file(s): ${missing.join(", ")}`,
      required_action: "delegate_audit",
      directive:
        `STOP. The Architecture Guard requires CLAUDE.md, README.md, and ARCHITECTURE.md ` +
        `to all exist at the project root. Missing: ${missing.join(", ")}. ` +
        `Before any other work, call delegate_task with: ` +
        `"Audit and reconcile the Core 3 (CLAUDE.md, README.md, ARCHITECTURE.md). ` +
        `Read the existing files and the codebase, then propose content for the missing ` +
        `${missing.length === 1 ? "file" : "files"}: ${missing.join(", ")}. ` +
        `Return a 2-paragraph synthesis only — do not write the files yourself."`,
    };
  }

  const mtimes = files.map((f) => Date.parse(f.mtime_iso!));
  const driftMs = Math.max(...mtimes) - Math.min(...mtimes);
  const driftDays = driftMs / (1000 * 60 * 60 * 24);
  if (driftDays > CORE3_MTIME_DRIFT_DAYS) {
    return {
      files,
      in_sync: false,
      reason: `Core 3 mtime spread = ${driftDays.toFixed(1)} days (>${CORE3_MTIME_DRIFT_DAYS}d threshold)`,
      required_action: "delegate_audit",
      directive:
        `Core 3 audit recommended. CLAUDE.md, README.md, and ARCHITECTURE.md have a ` +
        `${driftDays.toFixed(1)}-day mtime spread, which suggests one was updated without ` +
        `propagating the change to the others. Before any other work, call delegate_task with: ` +
        `"Audit the Core 3 (CLAUDE.md, README.md, ARCHITECTURE.md) for cross-file consistency. ` +
        `Flag any architectural claims, file paths, schema descriptions, or tool inventories ` +
        `that appear in one file but contradict or are absent from the others. Return a ` +
        `2-paragraph synthesis only."`,
    };
  }

  return {
    files,
    in_sync: true,
    reason: `All three present; mtime spread ${driftDays.toFixed(1)} days (≤${CORE3_MTIME_DRIFT_DAYS}d)`,
    required_action: "none",
    directive: "Core 3 in sync — proceed with normal work.",
  };
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
  core3: Core3Audit;
  directives: string[];
  recommendations?: HydrateRecommendation[];
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

  // 6. Architecture Guard — Core 3 audit (CLAUDE.md, README.md, ARCHITECTURE.md).
  // The audit is read-only; the agent reacts to `core3.required_action` and to
  // the `directives` array on the result envelope.
  const core3 = await auditCore3(ws);
  const core3Status: CheckStatus = core3.files.some((f) => !f.exists)
    ? "missing"
    : core3.in_sync
      ? "ok"
      : "warn";
  checks.push({
    name: "core3:audit",
    status: core3Status,
    detail: core3.reason,
    fix: core3.required_action === "delegate_audit" ? core3.directive : undefined,
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

  // v1.1.3: smart-scout for un-hydrated policy rule files. Best-effort —
  // any failure inside the detector is swallowed and we simply omit the
  // `recommendations` key (init_project's primary job is unaffected).
  let recommendations: HydrateRecommendation[] = [];
  try {
    recommendations = await detectHydrateRecommendations(ws);
  } catch {
    recommendations = [];
  }

  // Top-level imperatives the agent MUST act on before doing anything else.
  // Today only the Core 3 audit emits one; future Architecture Guard checks
  // can append to this array.
  const directives: string[] = [];
  if (core3.required_action === "delegate_audit") {
    directives.push(core3.directive);
  }

  const result: {
    action: "init_project";
    workspace: string;
    expected_mcp_entry: string;
    overall: "ready" | "partial" | "not_ready";
    checks: Check[];
    architecture_synced: { path: string; written: boolean } | null;
    legacy_sweep: unknown;
    core3: Core3Audit;
    directives: string[];
    recommendations?: HydrateRecommendation[];
  } = {
    action: "init_project",
    workspace: ws,
    expected_mcp_entry: mcpEntryPoint,
    overall,
    checks,
    architecture_synced: architectureSynced,
    legacy_sweep: legacySweep,
    core3,
    directives,
  };
  if (recommendations.length > 0) {
    result.recommendations = recommendations;
  }
  return result;
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
