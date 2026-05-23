import { stat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { config } from "../config.js";
import { supabase, getKeepAliveStatus, FROZEN_CACHE_PATH } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { getCompactorStatus } from "../trajectory/daemon.js";
import { getSleepLearnerStatus } from "../sleep/daemon.js";
import { getCurriculumStatus } from "../curriculum/daemon.js";
import { getTelemetryPrunerStatus } from "../telemetry/pruner.js";
import { getGraduationStatus } from "../graduation/daemon.js";
import { getGraphExtractorStatus } from "../graph/daemon.js";
import { VERSION } from "../version.js";

// Per-daemon health derivation thresholds. Names use the user-mandated
// `_DEFAULT` suffix; reads are once-at-module-load with safe fallback.
const envNum = (k: string, def: number): number => {
  const raw = process.env[k];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};
const OBS_ERR_RATE_DEGRADED = envNum("OBS_ERR_RATE_DEGRADED_DEFAULT", 0.2);
const OBS_ERR_RATE_DOWN = envNum("OBS_ERR_RATE_DOWN_DEFAULT", 0.5);
const OBS_STALENESS_MULTIPLIER = envNum("OBS_STALENESS_MULTIPLIER_DEFAULT", 2.0);
// Cold-boot grace window: daemons without `run_ended` events within this many
// milliseconds of MCP server start report `pending` rather than `down`. This
// prevents the FTUX from showing a false `overall: down` on a healthy boot.
const GRACE_MS = 15 * 60 * 1000;

export type DerivedStatus = "healthy" | "pending" | "degraded" | "down";

type DerivedBlock = {
  status: DerivedStatus;
  reason: string;
  error_rate_1h: number;
  staleness_ms: number | null;
  last_run_ended_at: string | null;
};

type TelemetryRow = { event_type: string; created_at: string };

// Worst-of severity. `pending` sits BELOW `degraded` so a cold-boot daemon
// can never poison `overall` past `degraded`.
const SEVERITY: Record<string, number> = {
  healthy: 0,
  ok: 0,
  pending: 0.5,
  degraded: 1,
  down: 2,
  unhealthy: 2,
};

/**
 * Worst-of rollup across an arbitrary set of statuses using {@link SEVERITY}.
 * Used to combine supabase/ollama check statuses with per-daemon derivations
 * into a single top-level `overall` for the health report. Pure / no side effects.
 */
export function rollupOverall(statuses: DerivedStatus[]): DerivedStatus {
  return statuses.reduce<DerivedStatus>(
    (a, b) => ((SEVERITY[b] ?? 0) > (SEVERITY[a] ?? 0) ? b : a),
    "healthy",
  );
}

/**
 * Input for the pure per-daemon status derivation. Testable in isolation.
 * `uptimeSec` lets callers inject `process.uptime()` so tests stay deterministic.
 * `graceMs` defaults to {@link GRACE_MS} but is overridable per-test.
 * `now` defaults to `Date.now()` but is overridable per-test to eliminate
 * sub-millisecond timing races between event creation and staleness comparison.
 */
export type DeriveDaemonStatusInput = {
  enabled: boolean;
  events: TelemetryRow[];
  uptimeSec: number;
  intervalMs?: number;
  lastRunAtIso?: string | null;
  graceMs?: number;
  now?: number;
};

export function deriveDaemonStatus(input: DeriveDaemonStatusInput): DerivedBlock {
  const {
    enabled,
    events: rows,
    uptimeSec,
    intervalMs = 0,
    lastRunAtIso = null,
    graceMs = GRACE_MS,
    now = Date.now(),
  } = input;
  // `enabled=false` short-circuit MUST come first — a disabled daemon
  // is out of scope for liveness and cannot be "down" or "pending".
  if (!enabled) {
    return {
      status: "healthy",
      reason: "daemon disabled (out of scope)",
      error_rate_1h: 0,
      staleness_ms: null,
      last_run_ended_at: null,
    };
  }
  const mostRecentRunEnded =
    rows.find((r) => r.event_type === "run_ended")?.created_at ?? null;
  const effectiveLast = lastRunAtIso ?? mostRecentRunEnded;
  if (effectiveLast === null) {
    // Cold-boot grace: within the grace window, no `run_ended` events yet is
    // expected (the daemon may simply not have ticked once). Past the window,
    // this becomes a real `down` signal as before.
    //
    // Long-interval daemons (e.g. telemetry_pruner with a 6h tick) need the
    // grace to scale with their cadence — otherwise the static 15-min floor
    // expires hours before the first scheduled run and the daemon reports
    // `down` despite running correctly. Effective grace is the larger of the
    // static floor and `intervalMs * 1.1` (10% headroom above one full tick).
    const uptimeMs = uptimeSec * 1000;
    const effectiveGraceMs = Math.max(graceMs, Math.round(intervalMs * 1.1));
    if (uptimeMs < effectiveGraceMs) {
      return {
        status: "pending",
        reason: `within ${Math.round(effectiveGraceMs / 60_000)}min grace window (uptime=${Math.round(uptimeMs / 1000)}s); awaiting first run_ended`,
        error_rate_1h: 0,
        staleness_ms: null,
        last_run_ended_at: null,
      };
    }
    return {
      status: "down",
      reason: "no run_ended events on record",
      error_rate_1h: 0,
      staleness_ms: null,
      last_run_ended_at: null,
    };
  }
  const stalenessMs = Math.max(0, now - Date.parse(effectiveLast));
  const staleThreshold = intervalMs * OBS_STALENESS_MULTIPLIER;
  if (stalenessMs > staleThreshold) {
    return {
      status: "down",
      reason: `stale (${stalenessMs}ms since last run; threshold=${staleThreshold}ms = interval_ms*${OBS_STALENESS_MULTIPLIER})`,
      error_rate_1h: 0,
      staleness_ms: stalenessMs,
      last_run_ended_at: effectiveLast,
    };
  }
  let runs = 0;
  let errors = 0;
  for (const r of rows) {
    if (r.event_type === "run_ended") runs++;
    else if (r.event_type === "run_errored") errors++;
  }
  const denom = runs + errors;
  const errRate = denom === 0 ? 0 : errors / denom;
  if (errRate > OBS_ERR_RATE_DOWN) {
    return {
      status: "down",
      reason: `error_rate_1h=${errRate.toFixed(3)} > ${OBS_ERR_RATE_DOWN}`,
      error_rate_1h: errRate,
      staleness_ms: stalenessMs,
      last_run_ended_at: effectiveLast,
    };
  }
  if (errRate > OBS_ERR_RATE_DEGRADED) {
    return {
      status: "degraded",
      reason: `error_rate_1h=${errRate.toFixed(3)} > ${OBS_ERR_RATE_DEGRADED}`,
      error_rate_1h: errRate,
      staleness_ms: stalenessMs,
      last_run_ended_at: effectiveLast,
    };
  }
  return {
    status: "healthy",
    reason: "within thresholds",
    error_rate_1h: errRate,
    staleness_ms: stalenessMs,
    last_run_ended_at: effectiveLast,
  };
}

// Sovereign Orchestrator defaults (mirrored from delegateTask/buildWorkerPrompt).
// Version is sourced from package.json via src/version.ts so health reports
// can never drift from the actual server version.
const ORCHESTRATOR_VERSION = VERSION;
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
  overall: DerivedStatus;
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
  trajectory_compactor: ReturnType<typeof getCompactorStatus> & { derived: DerivedBlock };
  sleep_learner: ReturnType<typeof getSleepLearnerStatus> & { derived: DerivedBlock };
  curriculum_scanner: ReturnType<typeof getCurriculumStatus> & { derived: DerivedBlock };
  telemetry_pruner: ReturnType<typeof getTelemetryPrunerStatus> & { derived: DerivedBlock };
  graduation_scanner: ReturnType<typeof getGraduationStatus> & { derived: DerivedBlock };
  graph_extractor: ReturnType<typeof getGraphExtractorStatus>;
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
    version: string;
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

  let overall: HealthReport["overall"] =
    Object.values(checks).some((c) => c.status === "down")
      ? "down"
      : Object.values(checks).every((c) => c.status === "ok")
        ? "healthy"
        : "degraded";

  // Query 1h of daemon telemetry in a single round-trip; group by daemon in JS.
  // A query failure must NOT crash the health check — derive with empty rows
  // so each derived block still respects enabled / last_run_at fallbacks.
  const oneHourAgoIso = new Date(Date.now() - 3600_000).toISOString();
  const byDaemon: Record<string, TelemetryRow[]> = {
    sleep_learner: [],
    curriculum_scanner: [],
    trajectory_compactor: [],
    telemetry_pruner: [],
    graduation_scanner: [],
  };
  try {
    const { data: telemetryRows, error: telemetryErr } = await supabase
      .from("daemon_telemetry")
      .select("daemon, event_type, created_at")
      .eq("project_id", currentProjectId)
      .gte("created_at", oneHourAgoIso)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (telemetryErr) {
      console.error(`[health] telemetry query failed: ${telemetryErr.message}`);
    } else {
      for (const r of (telemetryRows ?? []) as Array<
        TelemetryRow & { daemon: string }
      >) {
        if (r.daemon in byDaemon) {
          byDaemon[r.daemon].push({
            event_type: r.event_type,
            created_at: r.created_at,
          });
        }
      }
    }
  } catch (e) {
    console.error(`[health] telemetry query threw: ${(e as Error).message}`);
  }

  const sleepSnap = getSleepLearnerStatus();
  const currSnap = getCurriculumStatus();
  const trajSnap = getCompactorStatus();
  const prunerSnap = getTelemetryPrunerStatus();
  const graduSnap = getGraduationStatus();

  const uptimeSec = process.uptime();
  const sleepDerived = deriveDaemonStatus({
    enabled: sleepSnap.enabled,
    events: byDaemon.sleep_learner,
    uptimeSec,
    intervalMs: sleepSnap.interval_ms,
    lastRunAtIso: sleepSnap.last_run_at ?? null,
  });
  const currDerived = deriveDaemonStatus({
    enabled: currSnap.enabled,
    events: byDaemon.curriculum_scanner,
    uptimeSec,
    intervalMs: currSnap.interval_ms,
    lastRunAtIso: currSnap.last_run_at ?? null,
  });
  const trajDerived = deriveDaemonStatus({
    enabled: trajSnap.enabled,
    events: byDaemon.trajectory_compactor,
    uptimeSec,
    intervalMs: trajSnap.interval_ms,
    lastRunAtIso: trajSnap.last_run_at ?? null,
  });
  const prunerDerived = deriveDaemonStatus({
    enabled: prunerSnap.enabled,
    events: byDaemon.telemetry_pruner,
    uptimeSec,
    intervalMs: prunerSnap.interval_ms,
    lastRunAtIso: prunerSnap.last_run_at ?? null,
  });
  const graduDerived = deriveDaemonStatus({
    enabled: graduSnap.enabled,
    events: byDaemon.graduation_scanner,
    uptimeSec,
    intervalMs: graduSnap.interval_ms,
    lastRunAtIso: graduSnap.last_run_at ?? null,
  });

  // Worst-of rollup: daemon derivation can only WORSEN overall, never improve it.
  // Preserves any degraded/down already set by supabase/ollama checks above.
  overall = rollupOverall([
    overall,
    sleepDerived.status,
    currDerived.status,
    trajDerived.status,
    prunerDerived.status,
    graduDerived.status,
  ]);

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
    trajectory_compactor: { ...trajSnap, derived: trajDerived },
    sleep_learner: { ...sleepSnap, derived: sleepDerived },
    curriculum_scanner: { ...currSnap, derived: currDerived },
    telemetry_pruner: { ...prunerSnap, derived: prunerDerived },
    graduation_scanner: { ...graduSnap, derived: graduDerived },
    graph_extractor: getGraphExtractorStatus(),
    policy_enforcement: policy,
    orchestrator,
    summary,
  };
}
