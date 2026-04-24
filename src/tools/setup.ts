import { stat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

export async function initProject(args: { workspace?: string } = {}): Promise<{
  action: "init_project";
  workspace: string;
  expected_mcp_entry: string;
  overall: "ready" | "partial" | "not_ready";
  checks: Check[];
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
      ? `claude-memory MCP server registered in: ${reg.matches.join(", ")}`
      : `claude-memory MCP server is not registered in any known settings file. Expected the path ${mcpEntryPoint} to appear in one of them.`,
    fix: reg.registered
      ? undefined
      : `Add to ~/.claude.json under "mcpServers":\n  "claude-memory": { "type":"stdio", "command":"node", "args":["${mcpEntryPoint}"] }\nThen restart Claude Code.`,
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

  return {
    action: "init_project",
    workspace: ws,
    expected_mcp_entry: mcpEntryPoint,
    overall,
    checks,
  };
}
