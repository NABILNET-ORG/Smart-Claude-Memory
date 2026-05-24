import { stat, readFile, mkdir, rename, copyFile, rm } from "node:fs/promises";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname, basename, relative, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// glob v13 serves a minified ESM bundle to the `import` condition which mangles
// named exports → static `import { glob } from "glob"` fails at runtime.
// Force the unminified CJS resolution via createRequire (types come through fine).
const { glob } = require("glob") as typeof import("glob");
import { Client } from "pg";
import { loadFrozenCache } from "./frozen-cache.js";
import { currentProjectId, slugify } from "../project.js";
import { GLOBAL_PROJECT_ID } from "./save.js";
import {
  applyPendingMigrations,
  listPendingMigrations,
  loadMigrationFiles,
} from "../lib/migrations.js";
import {
  ensureSovereignConstitution,
  upgradeConstitutionBlock,
  type SovereignConstitutionResult,
  type UpgradeConstitutionResult,
} from "./sovereign-constitution.js";
import {
  startGuiServer,
  computeProjectPort,
  type StartedGuiServer,
} from "../gui/server.js";
import { spawn } from "node:child_process";
import net from "node:net";
import {
  auditBloat,
  type BloatAudit,
  type SovereignPurgeRecommendation,
} from "./bloat-audit.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpEntryPoint = resolve(packageRoot, "dist", "index.js").replace(/\\/g, "/");

// ─── v2.1.9 GUI Auto-Start ────────────────────────────────────────────────
// init_project lights up a deterministic per-project GUI on a port hashed
// from the project_id. Idempotent: if the port is already bound (this MCP
// process OR an external one), we skip the spawn AND skip the browser open
// so the operator doesn't get a popup every boot. Universal — works for any
// workspace; never assumes a specific project name.

let _guiInstance: StartedGuiServer | null = null;

function probePort(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = new net.Socket();
    let done = false;
    const settle = (v: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(v);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.connect(port, host);
  });
}

function openBrowserDetached(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      // `start "" "<url>"` opens the default browser; first quoted arg is the
      // window title (required when the URL itself is quoted on Windows).
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* best-effort — browser open never blocks init_project */
  }
}

export type GuiAutoStartResult = {
  status: "started" | "already_running_internal" | "already_running_external" | "error" | "disabled";
  url: string;
  port: number;
  project_id: string;
  browser_opened: boolean;
  message: string;
  error?: string;
};

export async function maybeAutoStartGui(projectId: string): Promise<GuiAutoStartResult> {
  if (process.env.SCM_GUI_AUTOSTART === "off") {
    const port = computeProjectPort(projectId);
    return {
      status: "disabled",
      url: `http://127.0.0.1:${port}/`,
      port,
      project_id: projectId,
      browser_opened: false,
      message: "Auto-start disabled via SCM_GUI_AUTOSTART=off",
    };
  }

  const port = computeProjectPort(projectId);
  const url = `http://127.0.0.1:${port}/`;

  // (a) Already started in this MCP process → reuse, no popup.
  if (_guiInstance && _guiInstance.port === port) {
    return {
      status: "already_running_internal",
      url: _guiInstance.url,
      port: _guiInstance.port,
      project_id: projectId,
      browser_opened: false,
      message: `Already serving on ${_guiInstance.url} (this process).`,
    };
  }

  // (b) Another process owns the port → reuse, no popup (anti-fatigue).
  const externalAlive = await probePort(port);
  if (externalAlive) {
    return {
      status: "already_running_external",
      url,
      port,
      project_id: projectId,
      browser_opened: false,
      message: `Already serving on ${url} (external process). Skipping browser open.`,
    };
  }

  // (c) Bind in-process + open browser exactly once.
  try {
    _guiInstance = await startGuiServer({
      port,
      projectId,
      token: process.env.SCM_GUI_TOKEN ?? null,
    });
    openBrowserDetached(_guiInstance.url);
    return {
      status: "started",
      url: _guiInstance.url,
      port: _guiInstance.port,
      project_id: projectId,
      browser_opened: true,
      message: `Started on ${_guiInstance.url} for project '${projectId}'.`,
    };
  } catch (err) {
    return {
      status: "error",
      url,
      port,
      project_id: projectId,
      browser_opened: false,
      message: `Failed to start GUI on port ${port}.`,
      error: (err as Error).message,
    };
  }
}

type CheckStatus = "ok" | "warn" | "missing" | "partial" | "not_ready";

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

export type Capabilities = {
  protocol: "smart-claude-memory/v2.1.0";
  project_id: string;
  global_scope: {
    available: true;
    project_id: typeof GLOBAL_PROJECT_ID;
    browse_tool: string | null;
    browse_args: readonly string[];
  };
  taxonomy: ["DECISION", "PATTERN", "ERROR", "LOG"];
  context_gathering_hints: string[];
  delegate_task_threshold: string;
};

const CAPABILITIES_HINTS: readonly string[] = [
  "On boot: search_memory({ query: 'Active Backlog' })",
  "Before non-trivial edits: search_memory({ query: '<topic>', metadata_filter: { type: 'PATTERN' } })",
  "After architectural choice: save_memory({ content, metadata: { type: 'DECISION' } })",
  "After bug fix: save_memory({ content, metadata: { type: 'ERROR', status: 'fixed' } })",
  "For universal patterns (MUST pass Sovereign Vetting + Cross-Project Test): save_memory({ content, metadata: { type: 'PATTERN', is_global: true, global_rationale: '<why this is a universal truth>' } })",
  "Browse GLOBAL: list_global_patterns({ metadata_filter: { type: 'PATTERN' }, limit: 10 })",
] as const;

/**
 * Pure capabilities-header builder.
 *
 * Extracted from runInitProject so the shape contract (protocol version,
 * global_scope, taxonomy, hints) is unit-testable in isolation — no
 * Supabase, no Ollama, no filesystem.
 *
 * Reused by: runInitProject (the live boot path) and
 * tests/capabilities.test.ts (the shape contract tests).
 */
export function buildCapabilities(
  projectIdSlug: string,
): Capabilities {
  return {
    protocol: "smart-claude-memory/v2.1.0",
    project_id: projectIdSlug,
    global_scope: {
      available: true,
      project_id: GLOBAL_PROJECT_ID,
      browse_tool: "list_global_patterns",
      browse_args: ["metadata_filter", "limit", "offset", "include_content"],
    },
    taxonomy: ["DECISION", "PATTERN", "ERROR", "LOG"],
    context_gathering_hints: [...CAPABILITIES_HINTS],
    delegate_task_threshold: ">3 files OR >100 lines raw output",
  };
}

type MigrationsCheck = {
  name: "migrations";
  status: "ok" | "partial" | "not_ready";
  detail: string;
};
type MigrationsBlock = { applied: number; skipped: number; total: number } | null;

type OllamaModelsCheck = {
  name: "ollama_models";
  status: "ok" | "partial" | "not_ready";
  detail: string;
};

const REQUIRED_OLLAMA_MODELS = ["moondream", "nomic-embed-text"] as const;

/**
 * Preflight: verify required Ollama models are pulled. Queries
 * `${OLLAMA_HOST}/api/tags` (default http://localhost:11434) and checks that
 * `moondream` and `nomic-embed-text` are both present (base name match,
 * `:tag` suffix stripped). Failure modes:
 *   - Ollama reachable, models missing → `partial` with `ollama pull` hint.
 *   - Ollama unreachable (network / HTTP error) → `not_ready`.
 * Exceptions never escape — `init_project` must not crash on this check.
 * 5-second timeout via AbortController. No new dependencies.
 */
async function runOllamaModelsCheck(): Promise<OllamaModelsCheck> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${host}/api/tags`, { signal: controller.signal });
    if (!r.ok) {
      return {
        name: "ollama_models",
        status: "not_ready",
        detail: `Ollama unreachable at ${host} (HTTP ${r.status})`,
      };
    }
    const data = (await r.json()) as { models?: Array<{ name: string }> };
    const present = (data.models ?? []).map((m) => m.name.split(":")[0]);
    const missing = REQUIRED_OLLAMA_MODELS.filter((req) => !present.includes(req));
    if (missing.length === 0) {
      return {
        name: "ollama_models",
        status: "ok",
        detail: `required models present: ${REQUIRED_OLLAMA_MODELS.join(", ")}`,
      };
    }
    return {
      name: "ollama_models",
      status: "partial",
      detail: `Missing Ollama models: ${missing.join(", ")}. Run: ollama pull ${missing.join(" ")}`,
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      name: "ollama_models",
      status: "not_ready",
      detail: `Ollama unreachable at ${host}: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BYO-Supabase bootstrap: open a fresh pg.Client against SUPABASE_POOLER_URL
 * (or SUPABASE_DB_URL fallback) and apply any pending migrations idempotently.
 *
 * Failure modes (DB unreachable, missing env, migration error) ALL collapse to
 * a single `{ status: "not_ready" }` Check. Exceptions never propagate — the
 * MCP server must not crash on first-call DB issues.
 */
async function runMigrationsCheck(): Promise<{
  check: MigrationsCheck;
  block: MigrationsBlock;
}> {
  const cs = process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DB_URL;
  if (!cs) {
    return {
      check: {
        name: "migrations",
        status: "not_ready",
        detail: "SUPABASE_POOLER_URL (or SUPABASE_DB_URL) not set; cannot apply migrations",
      },
      block: null,
    };
  }
  const client = new Client({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
  });
  const total = loadMigrationFiles().length;
  try {
    await client.connect();
    const pending = await listPendingMigrations(client);
    if (pending.length === 0) {
      return {
        check: {
          name: "migrations",
          status: "ok",
          detail: "schema up to date (0 pending)",
        },
        block: { applied: 0, skipped: total, total },
      };
    }
    const result = await applyPendingMigrations(client);
    return {
      check: {
        name: "migrations",
        status: "ok",
        detail: `applied ${result.applied} pending migration(s)`,
      },
      block: { applied: result.applied, skipped: result.skipped, total: result.total },
    };
  } catch (err) {
    return {
      check: {
        name: "migrations",
        status: "not_ready",
        detail: `migration apply failed: ${(err as Error).message}`,
      },
      block: null,
    };
  } finally {
    try {
      await client.end();
    } catch {
      /* swallow */
    }
  }
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
  capabilities: Capabilities;
  sovereign_constitution: SovereignConstitutionResult;
  bloat_audit: BloatAudit;
  migrations: MigrationsBlock;
  gui_auto_start: GuiAutoStartResult;
  recommendations?: Array<HydrateRecommendation | SovereignPurgeRecommendation>;
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

  // 6. Constitutional Enforcer — bind workspace to Sovereign Memory Protocol.
  // Runs BEFORE the Core 3 audit so a freshly-created CLAUDE.md is visible to
  // the audit step. Failures here demote `overall` to `partial` (not
  // `not_ready`) — the rest of the system can still function.
  const sovereignConstitution = await ensureSovereignConstitution(ws);
  if (sovereignConstitution.action === "error") {
    checks.push({
      name: "constitution:sovereign",
      status: "warn",
      detail: `Could not bind workspace to Sovereign Memory Protocol: ${sovereignConstitution.error}`,
    });
  } else {
    checks.push({
      name: "constitution:sovereign",
      status: "ok",
      detail: `${sovereignConstitution.action}: ${sovereignConstitution.path}`,
    });
  }

  // 6b. Deterministic constitution version sync. Probe in dry-run mode; auto-
  // apply ONLY when the existing block hash matches a previously-canonical
  // entry in KNOWN_CANONICAL_HASHES (no user customization). Drift with local
  // customizations surfaces as a directive — recommend, never overwrite
  // silently. Eliminates the LLM-edit hallucination path entirely.
  let constitutionUpgrade: UpgradeConstitutionResult | null = null;
  if (sovereignConstitution.action !== "error") {
    constitutionUpgrade = await upgradeConstitutionBlock(ws, { dry_run: true });
    if (
      constitutionUpgrade.action === "synced" &&
      constitutionUpgrade.mode === "auto_safe"
    ) {
      constitutionUpgrade = await upgradeConstitutionBlock(ws, { dry_run: false });
    }
    if (constitutionUpgrade.action === "synced") {
      checks.push({
        name: "constitution:upgrade",
        status: "ok",
        detail: `Auto-synced ${constitutionUpgrade.from_version} → ${constitutionUpgrade.to_version} (${constitutionUpgrade.mode}, dry_run=${constitutionUpgrade.dry_run})`,
      });
    } else if (constitutionUpgrade.action === "drift_detected") {
      checks.push({
        name: "constitution:upgrade",
        status: "warn",
        detail: `Drift ${constitutionUpgrade.from_version} → ${constitutionUpgrade.to_version}: ${constitutionUpgrade.reason}`,
        fix: `Run upgrade_constitution({ force: true }) to overwrite, or keep customizations and ignore.`,
      });
    } else if (constitutionUpgrade.action === "error") {
      checks.push({
        name: "constitution:upgrade",
        status: "warn",
        detail: `Upgrade probe failed: ${constitutionUpgrade.error}`,
      });
    }
  }

  // 7. Architecture Guard — Core 3 audit (CLAUDE.md, README.md, ARCHITECTURE.md).
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

  // 8. Migrations — auto-apply pending SQL migrations on every init so a fresh
  // BYO-Supabase database bootstraps transparently on first call. All paths
  // (missing connection string, unreachable DB, mid-apply failure) collapse
  // to `{ status: "not_ready" }` — never throws.
  const migrationsResult = await runMigrationsCheck();
  checks.push(migrationsResult.check);

  // 9. Ollama models preflight — verify required models are pulled. Surfaces an
  // actionable `ollama pull <names>` command instead of a cryptic embedding
  // failure deeper in the call chain. Never throws; unreachable Ollama
  // collapses to `not_ready` with the host in the detail.
  const ollamaModelsCheck = await runOllamaModelsCheck();
  checks.push(ollamaModelsCheck);

  const anyNotReady = checks.some(
    (c) => c.status === "missing" || c.status === "not_ready",
  );
  const anyWarn = checks.some(
    (c) => c.status === "warn" || c.status === "partial",
  );
  const overall: "ready" | "partial" | "not_ready" = anyNotReady
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
  let recommendations: Array<HydrateRecommendation | SovereignPurgeRecommendation> = [];
  try {
    recommendations = await detectHydrateRecommendations(ws);
  } catch {
    recommendations = [];
  }

  // Sovereign Purge auto-hygiene — token-count audit on CLAUDE.md and the
  // hidden Claude project-memory file. Best-effort: a failure here never
  // breaks init_project; we just emit a zero-value bloat_audit and skip
  // the recommendation.
  let bloatAudit: BloatAudit = {
    threshold: 3000,
    claude_md: { path: null, tokens: 0, bloated: false },
    hidden_memory: { path: null, tokens: 0, bloated: false, found: false },
  };
  try {
    const audit = await auditBloat(ws);
    bloatAudit = audit.bloat_audit;
    if (audit.sovereign_purge_recommendation) {
      recommendations.push(audit.sovereign_purge_recommendation);
    }
  } catch {
    /* keep default bloatAudit */
  }

  // Top-level imperatives the agent MUST act on before doing anything else.
  // Today only the Core 3 audit emits one; future Architecture Guard checks
  // can append to this array.
  const directives: string[] = [];
  if (core3.required_action === "delegate_audit") {
    directives.push(core3.directive);
  }
  if (constitutionUpgrade && constitutionUpgrade.action === "drift_detected") {
    directives.push(
      `Constitution drift detected (${constitutionUpgrade.from_version} → ${constitutionUpgrade.to_version}). ${constitutionUpgrade.recommendation}`,
    );
  }

  // v2.0.0-rc1 Capabilities Header — surfaces the protocol contract the agent should
  // adhere to during the session: dual-scope search, GLOBAL Knowledge Vault,
  // Sovereign Taxonomy, and the delegation threshold from CLAUDE.md.
  const capabilities: Capabilities = buildCapabilities(slugify(currentProjectId));

  // v2.1.9 GUI Auto-Start — deterministic port hashed from project_id.
  // Universal: same workspace → same port across MCP restarts; different
  // workspaces → different ports automatically. Never spawns a duplicate
  // browser tab when the port is already bound.
  const guiAutoStart = await maybeAutoStartGui(slugify(currentProjectId));
  // Print a clickable link to stderr so the operator sees it in the terminal.
  // stderr (not stdout) — stdout is the MCP JSON-RPC channel.
  try {
    process.stderr.write(
      `[scm-gui] ${guiAutoStart.status}: ${guiAutoStart.url} (project: ${guiAutoStart.project_id})\n`,
    );
  } catch {
    /* never block init_project on a stderr write */
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
    capabilities: Capabilities;
    sovereign_constitution: SovereignConstitutionResult;
    bloat_audit: BloatAudit;
    migrations: MigrationsBlock;
    gui_auto_start: GuiAutoStartResult;
    recommendations?: Array<HydrateRecommendation | SovereignPurgeRecommendation>;
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
    capabilities,
    sovereign_constitution: sovereignConstitution,
    bloat_audit: bloatAudit,
    migrations: migrationsResult.block,
    gui_auto_start: guiAutoStart,
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
