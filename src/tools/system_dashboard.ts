import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { getSleepLearnerStatus } from "../sleep/daemon.js";
import { getCurriculumStatus } from "../curriculum/daemon.js";
import { getCompactorStatus } from "../trajectory/daemon.js";
import { getTelemetryPrunerStatus } from "../telemetry/pruner.js";
import { getGraduationStatus } from "../graduation/daemon.js";

type DaemonName =
  | "sleep_learner"
  | "curriculum_scanner"
  | "trajectory_compactor"
  | "telemetry_pruner"
  | "graduation_scanner"
  | "clustering_scanner"
  | "file_watcher";

export type DashboardInput = {
  window_hours?: number;
  daemon?: DaemonName;
};

type Row = {
  daemon: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type Rollup = {
  runs: number;
  errors: number;
  items_processed: number;
  outcomes: { verified: number; rejected: number; auto_promoted: number };
};

function rollupFor(rows: Row[], sinceMs: number): Rollup {
  const filtered = rows.filter((r) => Date.parse(r.created_at) >= sinceMs);
  let runs = 0;
  let errors = 0;
  let itemsProcessed = 0;
  const outcomes = { verified: 0, rejected: 0, auto_promoted: 0 };
  for (const r of filtered) {
    const p = r.payload ?? {};
    if (r.event_type === "run_ended") {
      runs++;
      const compacted = typeof p.compacted === "number" ? p.compacted : 0;
      const mined = typeof p.mined === "number" ? p.mined : 0;
      const queued = typeof p.queued === "number" ? p.queued : 0;
      const deleted = typeof p.deleted === "number" ? p.deleted : 0;
      const proposed = typeof p.proposed === "number" ? p.proposed : 0;
      itemsProcessed += compacted + mined + queued + deleted + proposed;
    } else if (r.event_type === "run_errored") {
      errors++;
    } else if (r.event_type === "task_outcome") {
      if (typeof p.verified === "number") outcomes.verified += p.verified;
      if (typeof p.rejected === "number") outcomes.rejected += p.rejected;
      if (typeof p.auto_promoted === "number") outcomes.auto_promoted += p.auto_promoted;
    }
  }
  return { runs, errors, items_processed: itemsProcessed, outcomes };
}

export async function systemDashboardHandler(input: DashboardInput) {
  const windowHours = input.window_hours ?? 24;
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();

  let q = supabase
    .from("daemon_telemetry")
    .select("daemon, event_type, payload, created_at")
    .eq("project_id", currentProjectId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (input.daemon) q = q.eq("daemon", input.daemon);

  const { data, error } = await q;
  if (error) throw new Error(`system_dashboard query failed: ${error.message}`);
  const rows = (data ?? []) as Row[];

  const live = {
    sleep_learner: getSleepLearnerStatus(),
    curriculum_scanner: getCurriculumStatus(),
    trajectory_compactor: getCompactorStatus(),
    telemetry_pruner: getTelemetryPrunerStatus(),
    graduation_scanner: getGraduationStatus(),
  };

  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const windowStart = now - windowHours * 3600_000;
  const daemons: Record<string, unknown> = {};

  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor", "telemetry_pruner", "graduation_scanner"] as const) {
    if (input.daemon && input.daemon !== d) continue;
    const daemonRows = rows.filter((r) => r.daemon === d);
    const r1h = rollupFor(daemonRows, oneHourAgo);
    const r24h = rollupFor(daemonRows, windowStart);
    const lastError = daemonRows.find((r) => r.event_type === "run_errored");
    const errDenominator = r24h.runs + r24h.errors;
    daemons[d] = {
      live: live[d],
      rollup_1h: r1h,
      rollup_24h: r24h,
      error_rate_24h: errDenominator === 0 ? 0 : r24h.errors / errDenominator,
      last_error_at: lastError?.created_at ?? null,
      last_error_message:
        (lastError?.payload as { error_message?: string } | undefined)?.error_message ?? null,
      recent_runs: daemonRows.slice(0, 20).map((r) => ({
        event_type: r.event_type,
        created_at: r.created_at,
        payload: r.payload,
      })),
    };
  }

  return {
    project_id: currentProjectId,
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    daemons,
  };
}

type DashboardResult = Awaited<ReturnType<typeof systemDashboardHandler>>;

function relTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `T-${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `T-${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `T-${hr}h`;
  return `T-${Math.round(hr / 24)}d`;
}

function compactLive(snap: Record<string, unknown>): string {
  const pick = [
    "enabled", "running", "interval_ms", "retention_days", "last_run_at",
    "candidates_mined_total", "queued_total",
    "verified_total", "rejected_total", "auto_promotions_total",
    "last_run_deleted",
    "proposed_total", "last_run_proposed",
  ];
  const parts: string[] = [];
  for (const k of pick) {
    if (!(k in snap)) continue;
    const v = snap[k];
    const short =
      typeof v === "boolean" ? (v ? "t" : "f")
      : v === null ? "null"
      : typeof v === "number" ? String(v)
      : typeof v === "string" ? v
      : JSON.stringify(v);
    parts.push(`${k}=${short}`);
  }
  return parts.join(" ");
}

export function renderDashboardMarkdown(result: DashboardResult): string {
  const now = Date.now();
  const order = ["sleep_learner", "curriculum_scanner", "trajectory_compactor", "telemetry_pruner", "graduation_scanner"] as const;
  const D = result.daemons as Record<string, any>;
  const lines: string[] = [];

  lines.push(`# Dashboard \`${result.project_id}\` · ${result.window_hours}h · ${result.generated_at}`);
  lines.push("");
  lines.push("| Daemon | runs 1h/24h | err 1h/24h | items 24h | v/r/ap 24h | err_rate | last_err |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const d of order) {
    const b = D[d];
    if (!b) { lines.push(`| ${d} | — | — | — | — | — | — |`); continue; }
    const o = b.rollup_24h.outcomes;
    const lastErr = b.last_error_at
      ? `${relTime(b.last_error_at, now)} ${b.last_error_message ?? ""}`.trim()
      : "—";
    lines.push(
      `| ${d} | ${b.rollup_1h.runs}/${b.rollup_24h.runs} | ${b.rollup_1h.errors}/${b.rollup_24h.errors} | ${b.rollup_24h.items_processed} | ${o.verified}/${o.rejected}/${o.auto_promoted} | ${b.error_rate_24h.toFixed(3)} | ${lastErr} |`,
    );
  }

  lines.push("");
  lines.push("## Live");
  for (const d of order) {
    const b = D[d];
    if (!b) continue;
    lines.push(`- ${d}: ${compactLive((b.live as Record<string, unknown>) ?? {})}`);
  }

  lines.push("");
  lines.push("## Recent (max 5 per daemon)");
  for (const d of order) {
    const b = D[d];
    if (!b) continue;
    const recent = (b.recent_runs as any[]).slice(0, 5);
    if (recent.length === 0) { lines.push(`- ${d}: (no activity)`); continue; }
    const parts = recent.map((r) => {
      const p = (r.payload as Record<string, unknown>) ?? {};
      if (r.event_type === "task_outcome") {
        const keys = ["verified", "rejected", "auto_promoted"].filter((k) => k in p);
        const inner = keys.map((k) => `${k[0]}:${p[k]}`).join(",");
        return `task_outcome{${inner}}@${relTime(r.created_at, now)}`;
      }
      return `${r.event_type}@${relTime(r.created_at, now)}`;
    });
    lines.push(`- ${d}: ${parts.join(", ")}`);
  }

  return lines.join("\n");
}
