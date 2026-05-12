// Curriculum Scanner (Agentic OS 2026 / Mission 5 / SCM-S21-D1).
//
// Deterministic queuer. Reads file-system + Supabase signals and enqueues
// curriculum_tasks rows. CONTAINS ZERO GENERATIVE AI — no Ollama import,
// no LLM HTTP client, no name/steps/code generation. The Orchestrator
// (Claude) authors all downstream content.
//
// Boundary Invariant #1 (ARCHITECTURE.md §4.7): this module must remain
// pure SQL aggregates + filesystem reads. The CI lint fence asserts no
// imports from ollama / @anthropic-ai / openai / any /generate endpoint.
//
// Three signal sources:
//   * scanTestGaps()         — reads coverage-summary.json (optional file)
//                              and enqueues files with low coverage + size.
//   * scanRollbackHotspots() — SQL aggregate over workflow_checkpoints
//                              with status='rolledback' in the last 30 days.
//   * scanStaleCandidates()  — SQL select over skill_candidates with
//                              state='mined' AND frequency >= N AND aged.
//                              ONLY this source sets linked_candidate_id,
//                              i.e. only this source can trigger M3
//                              auto-promote on a verified apply.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { supabase } from "../supabase.js";

// ─── types ────────────────────────────────────────────────────────────────

export type CurriculumKind = "test_gap" | "refactor" | "rollback_repro";

export type EnqueueResult = {
  source: "test_gap" | "rollback_repro" | "stale_candidate";
  scanned: number;
  enqueued: number;
  skipped: number;
  errored: number;
};

export type ScanRunResult = {
  total_enqueued: number;
  total_skipped: number;
  total_errored: number;
  per_source: EnqueueResult[];
  duration_ms: number;
};

export type ScannerConfig = {
  projectId: string;
  workspace: string;
  minFreq: number;
  ttlDays: number;
  testGapCoveragePctCeiling: number;
  testGapMinLines: number;
  rollbackThreshold: number;
  rollbackWindowDays: number;
  staleCandidateMinAgeDays: number;
};

// ─── shared: enqueue helper wrapping the SQL RPC ──────────────────────────

async function enqueue(
  projectId: string,
  kind: CurriculumKind,
  targetPath: string,
  rationale: string,
  signalSource: Record<string, unknown>,
  linkedCandidateId: number | null,
  expiresAt: string | null,
): Promise<{ task_id: number; is_new: boolean }> {
  const { data, error } = await supabase.rpc("enqueue_curriculum_task", {
    p_project_id: projectId,
    p_kind: kind,
    p_target_path: targetPath,
    p_rationale: rationale,
    p_signal_source: signalSource,
    p_linked_candidate_id: linkedCandidateId,
    p_expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`enqueue_curriculum_task failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{ task_id: number; is_new: boolean }>;
  if (rows.length === 0) {
    throw new Error("enqueue_curriculum_task returned no rows");
  }
  return rows[0];
}

function computeExpiresAt(ttlDays: number): string | null {
  if (ttlDays <= 0) return null;
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

// ─── source 1: test_gap (reads coverage-summary.json) ─────────────────────

type CoverageFileSummary = {
  lines?: { pct?: number; total?: number };
};

type CoverageReport = Record<string, CoverageFileSummary | undefined> & {
  total?: CoverageFileSummary;
};

export async function scanTestGaps(cfg: ScannerConfig): Promise<EnqueueResult> {
  const result: EnqueueResult = {
    source: "test_gap",
    scanned: 0,
    enqueued: 0,
    skipped: 0,
    errored: 0,
  };

  const coveragePath = resolve(cfg.workspace, "coverage", "coverage-summary.json");
  let raw: string;
  try {
    raw = await readFile(coveragePath, "utf8");
  } catch {
    // No coverage file present → no test_gap signals this cycle. Not an error.
    return result;
  }

  let report: CoverageReport;
  try {
    report = JSON.parse(raw) as CoverageReport;
  } catch (e) {
    result.errored++;
    return result;
  }

  const expiresAt = computeExpiresAt(cfg.ttlDays);

  for (const [filePath, summary] of Object.entries(report)) {
    if (filePath === "total" || summary === undefined) continue;
    result.scanned++;

    const pct = summary.lines?.pct;
    const total = summary.lines?.total;
    if (typeof pct !== "number" || typeof total !== "number") {
      result.skipped++;
      continue;
    }
    if (pct >= cfg.testGapCoveragePctCeiling) {
      result.skipped++;
      continue;
    }
    if (total < cfg.testGapMinLines) {
      result.skipped++;
      continue;
    }

    try {
      const r = await enqueue(
        cfg.projectId,
        "test_gap",
        filePath,
        `coverage ${pct.toFixed(1)}%, ${total} lines (ceiling ${cfg.testGapCoveragePctCeiling}%, min ${cfg.testGapMinLines})`,
        {
          coverage_pct: pct,
          line_total: total,
          scanned_at: new Date().toISOString(),
        },
        null,
        expiresAt,
      );
      if (r.is_new) result.enqueued++;
      else result.skipped++;
    } catch {
      result.errored++;
    }
  }

  return result;
}

// ─── source 2: rollback_repro (SQL aggregate over workflow_checkpoints) ───

type RollbackHotspotRow = {
  target_path: string;
  rollback_count: number;
};

export async function scanRollbackHotspots(cfg: ScannerConfig): Promise<EnqueueResult> {
  const result: EnqueueResult = {
    source: "rollback_repro",
    scanned: 0,
    enqueued: 0,
    skipped: 0,
    errored: 0,
  };

  // The PostgREST query: GROUP BY step_label, HAVING count >= threshold,
  // within rollbackWindowDays. step_label is the orchestrator's free-text
  // anchor — it is what carries the file/module reference inside a workflow.
  // We treat step_label as target_path. No LLM interpretation needed.
  const since = new Date(Date.now() - cfg.rollbackWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .select("step_label, created_at")
    .eq("project_id", cfg.projectId)
    .eq("status", "rolledback")
    .gte("created_at", since);

  if (error) {
    result.errored++;
    return result;
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ step_label: string }>) {
    result.scanned++;
    const label = (row.step_label ?? "").trim();
    if (!label) {
      result.skipped++;
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const expiresAt = computeExpiresAt(cfg.ttlDays);

  for (const [label, count] of counts.entries()) {
    if (count < cfg.rollbackThreshold) {
      result.skipped++;
      continue;
    }
    try {
      const r = await enqueue(
        cfg.projectId,
        "rollback_repro",
        label,
        `${count} rollback(s) in last ${cfg.rollbackWindowDays} days (threshold ${cfg.rollbackThreshold})`,
        {
          rollback_count: count,
          window_days: cfg.rollbackWindowDays,
          scanned_at: new Date().toISOString(),
        },
        null,
        expiresAt,
      );
      if (r.is_new) result.enqueued++;
      else result.skipped++;
    } catch {
      result.errored++;
    }
  }

  return result;
}

// ─── source 3: stale_candidate (M3 auto-promote bridge) ───────────────────

type StaleCandidateRow = {
  id: number;
  project_id: string;
  pattern_hash: string;
  proposed_name: string | null;
  frequency: number;
  success_count: number;
  created_at: string;
};

export async function scanStaleCandidates(cfg: ScannerConfig): Promise<EnqueueResult> {
  const result: EnqueueResult = {
    source: "stale_candidate",
    scanned: 0,
    enqueued: 0,
    skipped: 0,
    errored: 0,
  };

  const ageCutoff = new Date(Date.now() - cfg.staleCandidateMinAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("skill_candidates")
    .select("id, project_id, pattern_hash, proposed_name, frequency, success_count, created_at")
    .eq("project_id", cfg.projectId)
    .eq("state", "mined")
    .gte("frequency", cfg.minFreq)
    .lte("created_at", ageCutoff);

  if (error) {
    result.errored++;
    return result;
  }

  const expiresAt = computeExpiresAt(cfg.ttlDays);
  const rows = (data ?? []) as StaleCandidateRow[];

  for (const row of rows) {
    result.scanned++;
    // target_path here is the candidate's pattern_hash — a stable
    // identifier the orchestrator can resolve back to the candidate
    // via signal_source.candidate_id. We do NOT invent a filesystem
    // path; this is the deterministic-queue contract.
    const targetPath = `skill_candidate:${row.pattern_hash}`;
    const rationale = `mined candidate freq=${row.frequency}, success=${row.success_count}, age>${cfg.staleCandidateMinAgeDays}d`;
    try {
      const r = await enqueue(
        cfg.projectId,
        "refactor",
        targetPath,
        rationale,
        {
          candidate_id: row.id,
          frequency: row.frequency,
          success_count: row.success_count,
          proposed_name: row.proposed_name,
          scanned_at: new Date().toISOString(),
        },
        row.id,
        expiresAt,
      );
      if (r.is_new) result.enqueued++;
      else result.skipped++;
    } catch {
      result.errored++;
    }
  }

  return result;
}

// ─── orchestration: runScanOnce ───────────────────────────────────────────

export async function runScanOnce(cfg: ScannerConfig): Promise<ScanRunResult> {
  const t0 = Date.now();
  const perSource: EnqueueResult[] = [];

  // Three sources run sequentially — Supabase HTTPS pool is small and the
  // scanner is idle-time work; no need to parallelize.
  perSource.push(await scanTestGaps(cfg));
  perSource.push(await scanRollbackHotspots(cfg));
  perSource.push(await scanStaleCandidates(cfg));

  const total_enqueued = perSource.reduce((s, r) => s + r.enqueued, 0);
  const total_skipped = perSource.reduce((s, r) => s + r.skipped, 0);
  const total_errored = perSource.reduce((s, r) => s + r.errored, 0);

  return {
    total_enqueued,
    total_skipped,
    total_errored,
    per_source: perSource,
    duration_ms: Date.now() - t0,
  };
}
