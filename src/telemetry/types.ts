export type DaemonName =
  | "sleep_learner"
  | "curriculum_scanner"
  | "trajectory_compactor"
  | "telemetry_pruner"
  | "graduation_scanner"
  | "clustering_scanner"
  | "file_watcher";
export type EventType =
  | "run_started"
  | "run_ended"
  | "run_errored"
  | "task_outcome"
  // SCM-S39-D1 (v2.2.2): emitted by a daemon tick that aborted early
  // because checkDaemonBudget returned decision='block'. Carries the
  // RunSkippedBudgetPayload shape.
  | "run_skipped_budget";

export type SleepEndedPayload = {
  mined: number;
  skipped: number;
  errored: number;
  duration_ms: number;
  [extra: string]: unknown;
};

export type CurriculumEndedPayload = {
  queued: number;
  skipped: number;
  errored: number;
  duration_ms: number;
  [extra: string]: unknown;
};

export type CurriculumDeltaPayload = {
  verified?: number;
  rejected?: number;
  auto_promoted?: number;
};

export type TrajectoryEndedPayload = {
  compacted: number;
  skipped: number;
  errored: number;
  duration_ms: number;
  [extra: string]: unknown;
};

export type TelemetryPrunerEndedPayload = {
  deleted: number;
  retention_days: number;
  duration_ms: number;
  [extra: string]: unknown;
};

// M7 graduation_scanner: proposed = new skill_graduations rows inserted this
// tick (state='proposed'). skipped = candidates the scanner returned but the
// daemon could not insert (race on partial UNIQUE, etc).
export type GraduationEndedPayload = {
  proposed: number;
  skipped: number;
  errored: number;
  duration_ms: number;
  [extra: string]: unknown;
};

// M8.3 (SCM-S41-D5) clustering_scanner: tick-level rollup for system_dashboard.
// `clustered` = rows UPSERTed into kg_node_clusters this tick; `skipped` =
// not_dirty / no_embeddings paths; `errored` = pipeline exception count.
// `project_id` is null on idle ticks (no projects discovered yet).
export type ClusteringEndedPayload = {
  project_id: string | null;
  clustered: number;
  skipped: number;
  errored: number;
  duration_ms: number;
  [extra: string]: unknown;
};

// Epic G (Session 43 Phase 2) file_watcher: tick-level rollup. files_queued is
// the count of distinct paths that fired change events inside the debounce
// window; duration_ms is the wall-clock cost of the syncLocalMemory call the
// flush triggered.
export type FileWatcherEndedPayload = {
  files_queued: number;
  duration_ms: number;
  [extra: string]: unknown;
};

export type RunErroredPayload = {
  error_message: string;
  duration_ms: number;
};

// SCM-S39-D1 (v2.2.2). Emitted when checkDaemonBudget returns 'block'
// and the tick aborts before doing any LLM-touching work. The fields
// are sufficient to attribute the skip in system_dashboard rollups.
export type RunSkippedBudgetPayload = {
  axis: "ollama_calls" | "embed_calls";
  delta: number;
  total_in_hour: number;
  cap: number;
  hour_bucket: string;
  duration_ms: number;
  [extra: string]: unknown;
};

export type MetricEvent =
  | { daemon: DaemonName;              event: "run_started";  payload?: Record<string, unknown> }
  | { daemon: "sleep_learner";         event: "run_ended";    payload: SleepEndedPayload }
  | { daemon: "curriculum_scanner";    event: "run_ended";    payload: CurriculumEndedPayload }
  | { daemon: "trajectory_compactor";  event: "run_ended";    payload: TrajectoryEndedPayload }
  | { daemon: "telemetry_pruner";      event: "run_ended";    payload: TelemetryPrunerEndedPayload }
  | { daemon: "graduation_scanner";    event: "run_ended";    payload: GraduationEndedPayload }
  | { daemon: "clustering_scanner";    event: "run_ended";    payload: ClusteringEndedPayload }
  | { daemon: "file_watcher";          event: "run_ended";    payload: FileWatcherEndedPayload }
  | { daemon: "curriculum_scanner";    event: "task_outcome"; payload: CurriculumDeltaPayload }
  | { daemon: DaemonName;              event: "run_errored";  payload: RunErroredPayload }
  | { daemon: DaemonName;              event: "run_skipped_budget"; payload: RunSkippedBudgetPayload };
