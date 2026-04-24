import { stat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { config } from "../config.js";
import { supabase, getKeepAliveStatus, FROZEN_CACHE_PATH } from "../supabase.js";

// v1.1.0 Sovereign Orchestrator defaults (mirrored from delegateTask/buildWorkerPrompt).
const ORCHESTRATOR_VERSION = "1.1.0" as const;
const SELF_HEAL_DEFAULT = true;
const MAX_HEALING_ATTEMPTS_DEFAULT = 3;

/**
 * Models Smart Claude Memory relies on at runtime. The check is prefix-based because
 * Ollama names models with a ":tag" suffix (e.g. "moondream:latest").
 */
const REQUIRED_MODELS = ["moondream", "nomic-embed-text"] as const;

type CheckStatus = "ok" | "degraded" | "down";

type Check = {
  status: CheckStatus;
  detail: string;
  latency_ms: number;
};

type HealthReport = {
  overall: "healthy" | "degraded" | "down";
  timestamp: string;
  checks: {
    supabase: Check;
    ollama: Check;
  };
  models: {
    required: string[];
    present: string[];
    missing: string[];
  };
  keep_alive: ReturnType<typeof getKeepAliveStatus>;
  policy_enforcement: {
    cache_path: string;
    cache_present: boolean;
    cache_updated_at: string | null;
    total_projects: number;
    total_patterns: number;
    active: boolean;
    note: string;
  };
  orchestrator: {
    version: "1.1.0";
    mode_active: boolean;
    self_heal_default: boolean;
    max_healing_attempts_default: number;
    advisory_hook: "hard-block" | "advisory" | "unknown";
    line_limit: number;
  };
  summary?: string;
};

async function detectAdvisoryHookMode(): Promise<"hard-block" | "advisory" | "unknown"> {
  try {
    // hooks/md-policy.py lives two levels up from dist/tools/ at runtime, or
    // two levels up from src/tools/ at source time — resolve relative to cwd.
    const hookPath = path.resolve(process.cwd(), "hooks", "md-policy.py");
    const text = await readFile(hookPath, "utf8");
    // Locate the check_orchestrator_advisory function body.
    const fnMatch = text.match(/def check_orchestrator_advisory[\s\S]*?(?=\ndef |\Z)/);
    if (!fnMatch) return "unknown";
    const body = fnMatch[0];
    if (/"decision"\s*:\s*"block"/.test(body)) return "hard-block";
    if (/"decision"\s*:\s*"allow"/.test(body)) return "advisory";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function buildOrchestratorSnapshot(
  advisoryHook: "hard-block" | "advisory" | "unknown",
): HealthReport["orchestrator"] {
  return {
    version: ORCHESTRATOR_VERSION,
    // TODO(v1.2.0): drop the legacy CLAUDE_MEMORY_* fallback after the Smart Claude Memory rebrand has settled.
    mode_active:
      (process.env.SMART_CLAUDE_MEMORY_ORCHESTRATOR_MODE ??
        process.env.CLAUDE_MEMORY_ORCHESTRATOR_MODE) === "1",
    self_heal_default: SELF_HEAL_DEFAULT,
    max_healing_attempts_default: MAX_HEALING_ATTEMPTS_DEFAULT,
    advisory_hook: advisoryHook,
    line_limit: Number(
      process.env.SMART_CLAUDE_MEMORY_LINE_LIMIT ?? process.env.CLAUDE_MEMORY_LINE_LIMIT ?? 750,
    ),
  };
}

async function readPolicyCache(): Promise<HealthReport["policy_enforcement"]> {
  const snapshot: HealthReport["policy_enforcement"] = {
    cache_path: FROZEN_CACHE_PATH,
    cache_present: false,
    cache_updated_at: null,
    total_projects: 0,
    total_patterns: 0,
    active: false,
    note: "",
  };
  try {
    await stat(FROZEN_CACHE_PATH);
    snapshot.cache_present = true;
    const json = JSON.parse(await readFile(FROZEN_CACHE_PATH, "utf8")) as {
      updated_at?: string;
      projects?: Record<string, unknown[]>;
    };
    snapshot.cache_updated_at = json.updated_at ?? null;
    const projects = json.projects ?? {};
    snapshot.total_projects = Object.keys(projects).length;
    snapshot.total_patterns = Object.values(projects).reduce(
      (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
      0,
    );
    snapshot.active = snapshot.total_patterns > 0;
    snapshot.note = snapshot.active
      ? `Policy enforcement is ACTIVE — ${snapshot.total_patterns} frozen pattern(s) across ${snapshot.total_projects} project(s). Hook will block Write on matches.`
      : "Policy cache present but empty — no frozen patterns; all Writes pass through the frozen check.";
  } catch {
    snapshot.note =
      "Policy cache not yet written. First server start with Supabase connectivity will create it.";
  }
  return snapshot;
}

async function checkSupabase(): Promise<Check> {
  const t0 = Date.now();
  try {
    const { count, error } = await supabase
      .from("memory_chunks")
      .select("*", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    return {
      status: "ok",
      detail: `memory_chunks reachable (${count ?? 0} rows total across all projects)`,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      status: "down",
      detail: `${(e as Error).message}`,
      latency_ms: Date.now() - t0,
    };
  }
}

async function checkOllama(): Promise<{ check: Check; present: string[]; missing: string[] }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${config.OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const present = (json.models ?? []).map((m) => m.name);
    const missing = REQUIRED_MODELS.filter(
      (req) => !present.some((p) => p === req || p.startsWith(`${req}:`)),
    );
    const status: CheckStatus = missing.length === 0 ? "ok" : "degraded";
    const detail =
      missing.length === 0
        ? `reachable; required models present (${REQUIRED_MODELS.join(", ")})`
        : `reachable; missing models: ${missing.join(", ")}. Run 'ollama pull <model>'.`;
    return {
      check: { status, detail, latency_ms: Date.now() - t0 },
      present,
      missing: [...missing],
    };
  } catch (e) {
    return {
      check: { status: "down", detail: (e as Error).message, latency_ms: Date.now() - t0 },
      present: [],
      missing: [...REQUIRED_MODELS],
    };
  }
}

export async function checkSystemHealth(): Promise<HealthReport> {
  const [supabaseCheck, ollamaResult, policy, advisoryHook] = await Promise.all([
    checkSupabase(),
    checkOllama(),
    readPolicyCache(),
    detectAdvisoryHookMode(),
  ]);
  const checks = { supabase: supabaseCheck, ollama: ollamaResult.check };

  const overall: HealthReport["overall"] =
    Object.values(checks).some((c) => c.status === "down")
      ? "down"
      : Object.values(checks).every((c) => c.status === "ok")
        ? "healthy"
        : "degraded";

  const orchestrator = buildOrchestratorSnapshot(advisoryHook);
  const summary =
    `Orchestrator: v${orchestrator.version} | ` +
    `mode=${orchestrator.mode_active ? "active" : "inactive"} | ` +
    `self_heal=${orchestrator.self_heal_default ? "on" : "off"} | ` +
    `healing_attempts=${orchestrator.max_healing_attempts_default} | ` +
    `hook=${orchestrator.advisory_hook}`;

  return {
    overall,
    timestamp: new Date().toISOString(),
    checks,
    models: {
      required: [...REQUIRED_MODELS],
      present: ollamaResult.present,
      missing: ollamaResult.missing,
    },
    keep_alive: getKeepAliveStatus(),
    policy_enforcement: policy,
    orchestrator,
    summary,
  };
}
