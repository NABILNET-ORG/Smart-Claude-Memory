export type DaemonName = "sleep_learner" | "curriculum_scanner" | "trajectory_compactor";
export type EventType = "run_started" | "run_ended" | "run_errored" | "task_outcome";

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

export type RunErroredPayload = {
  error_message: string;
  duration_ms: number;
};

export type MetricEvent =
  | { daemon: DaemonName;              event: "run_started";  payload?: Record<string, unknown> }
  | { daemon: "sleep_learner";         event: "run_ended";    payload: SleepEndedPayload }
  | { daemon: "curriculum_scanner";    event: "run_ended";    payload: CurriculumEndedPayload }
  | { daemon: "trajectory_compactor";  event: "run_ended";    payload: TrajectoryEndedPayload }
  | { daemon: "curriculum_scanner";    event: "task_outcome"; payload: CurriculumDeltaPayload }
  | { daemon: DaemonName;              event: "run_errored";  payload: RunErroredPayload };
