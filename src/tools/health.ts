import { config } from "../config.js";
import { supabase, getKeepAliveStatus } from "../supabase.js";

/**
 * Models claude-memory relies on at runtime. The check is prefix-based because
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
};

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
  const [supabaseCheck, ollamaResult] = await Promise.all([checkSupabase(), checkOllama()]);
  const checks = { supabase: supabaseCheck, ollama: ollamaResult.check };

  const overall: HealthReport["overall"] =
    Object.values(checks).some((c) => c.status === "down")
      ? "down"
      : Object.values(checks).every((c) => c.status === "ok")
        ? "healthy"
        : "degraded";

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
  };
}
