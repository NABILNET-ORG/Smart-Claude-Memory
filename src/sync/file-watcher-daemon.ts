// File Watcher Daemon (Epic G — KG Auto-Sync, Session 43 Phase 2).
//
// Watches the MEMORY_ROOTS directories for content changes and auto-fires
// syncLocalMemory() on a debounced cadence. The existing graph_extractor
// daemon (src/graph/daemon.ts) then pulls the new/updated memory_chunks
// into kg_nodes / kg_edges on its own 2-minute tick. The user no longer
// has to remember to manually call sync_local_memory after every edit
// session — the watcher closes the loop end-to-end.
//
// Lifecycle (mirrors src/telemetry/pruner.ts conventions):
//   - module-level State object
//   - idempotent startFileWatcher() / stopFileWatcher()
//   - re-entrancy guard (state.syncing) prevents overlapping syncs
//   - emits run_started / run_ended / run_errored telemetry under
//     daemon="file_watcher" so the activity surfaces in system_dashboard
//   - .unref()'d timer so the daemon never holds the Node event loop open
//
// Self-trigger safety: after a sync completes, ignore events for
// quietAfterSyncMs (default 2s) so any write-side-effects of the sync
// itself (e.g. .tmp.zip artifacts) don't re-trigger a flush loop.
//
// Boundary Invariant #1: this module is in src/sync/ which is OUTSIDE
// the LLM-forbidden zones (src/sleep, src/curriculum, src/graduation).
// It calls into syncLocalMemory which is also LLM-free.

import * as fs from "node:fs";
import * as path from "node:path";
import { memoryRoots } from "../config.js";
import { syncLocalMemory } from "../tools/sync.js";
import { emit } from "../telemetry/emit.js";

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_MIN_INTERVAL_MS = 8000;
const DEFAULT_QUIET_AFTER_SYNC_MS = 2000;

// File extensions that are worth syncing. Anything else (binaries, lock
// files, dotfiles, build artifacts) is ignored at the watcher level so
// noisy file-systems don't cause sync churn.
const WATCH_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".sql",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

// Path fragments that should never trigger a sync (build artefacts,
// temp dirs, repo metadata, dependency trees, the sync's own backup zips).
const IGNORE_FRAGMENTS: readonly string[] = [
  "/node_modules/",
  "\\node_modules\\",
  "/.git/",
  "\\.git\\",
  "/dist/",
  "\\dist\\",
  "/.next/",
  "\\.next\\",
  "/.cache/",
  "\\.cache\\",
  "/coverage/",
  "\\coverage\\",
  "/backups/",
  "\\backups\\",
  ".tmp",
  ".log",
];

export type SyncFn = (args: {
  project_id?: string;
  roots?: string[];
}) => Promise<unknown>;

export type FileWatcherOptions = {
  /** Override the directories to watch. Defaults to memoryRoots from env. */
  paths?: string[];
  /** Coalesce-window for rapid saves. Default 1500ms. */
  debounceMs?: number;
  /** Hard floor between consecutive syncs. Default 8000ms. */
  minIntervalMs?: number;
  /** Ignore events for this many ms after a sync (self-trigger guard). Default 2000ms. */
  quietAfterSyncMs?: number;
  /** Master switch. Falls back to env var SCM_FILE_WATCHER_ENABLED. */
  enabled?: boolean;
  /** Injectable for tests. Defaults to syncLocalMemory. */
  syncFn?: SyncFn;
};

type State = {
  watchers: fs.FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  pendingPaths: Set<string>;
  syncing: boolean;
  enabled: boolean;
  ignoreEventsUntil: number;
  debounceMs: number;
  minIntervalMs: number;
  quietAfterSyncMs: number;
  syncFn: SyncFn;
  lastSyncStartedAt: number | null;
  lastSyncEndedAt: string | null;
  lastSyncFilesChanged: number;
  lastSyncDurationMs: number;
  lastSyncErrored: number;
  totalSyncs: number;
  totalFilesQueued: number;
};

const state: State = {
  watchers: [],
  debounceTimer: null,
  pendingPaths: new Set(),
  syncing: false,
  enabled: false,
  ignoreEventsUntil: 0,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  quietAfterSyncMs: DEFAULT_QUIET_AFTER_SYNC_MS,
  syncFn: (a) => syncLocalMemory(a),
  lastSyncStartedAt: null,
  lastSyncEndedAt: null,
  lastSyncFilesChanged: 0,
  lastSyncDurationMs: 0,
  lastSyncErrored: 0,
  totalSyncs: 0,
  totalFilesQueued: 0,
};

function shouldWatchPath(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  for (const frag of IGNORE_FRAGMENTS) {
    if (lower.includes(frag.toLowerCase())) return false;
  }
  const ext = path.extname(absPath).toLowerCase();
  if (!ext) return false;
  return WATCH_EXTENSIONS.has(ext);
}

function onChange(filename: string | null, watchedRoot: string): void {
  if (!state.enabled || state.syncing) return;
  if (filename === null) return;
  if (Date.now() < state.ignoreEventsUntil) return;
  const abs = path.resolve(watchedRoot, filename);
  if (!shouldWatchPath(abs)) return;
  state.pendingPaths.add(abs);
  state.totalFilesQueued++;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    void flush();
  }, state.debounceMs);
  state.debounceTimer.unref();
}

async function flush(): Promise<void> {
  state.debounceTimer = null;
  if (state.syncing) return;
  if (state.pendingPaths.size === 0) return;
  const since = state.lastSyncStartedAt === null ? Infinity : Date.now() - state.lastSyncStartedAt;
  if (since < state.minIntervalMs) {
    const wait = state.minIntervalMs - since;
    state.debounceTimer = setTimeout(() => {
      void flush();
    }, wait);
    state.debounceTimer.unref();
    return;
  }
  const filesChanged = state.pendingPaths.size;
  state.pendingPaths.clear();
  state.syncing = true;
  state.lastSyncStartedAt = Date.now();
  const tStart = state.lastSyncStartedAt;
  void emit({
    daemon: "file_watcher",
    event: "run_started",
    payload: { files_queued: filesChanged },
  });
  try {
    await state.syncFn({});
    state.lastSyncFilesChanged = filesChanged;
    state.lastSyncDurationMs = Date.now() - tStart;
    state.lastSyncEndedAt = new Date().toISOString();
    state.totalSyncs++;
    void emit({
      daemon: "file_watcher",
      event: "run_ended",
      payload: { files_queued: filesChanged, duration_ms: state.lastSyncDurationMs },
    });
  } catch (err) {
    state.lastSyncErrored++;
    state.lastSyncDurationMs = Date.now() - tStart;
    state.lastSyncEndedAt = new Date().toISOString();
    void emit({
      daemon: "file_watcher",
      event: "run_errored",
      payload: {
        // RunErroredPayload is strictly { error_message, duration_ms } —
        // files_queued is captured in state.totalFilesQueued instead.
        error_message: err instanceof Error ? err.message : String(err),
        duration_ms: state.lastSyncDurationMs,
      },
    });
  } finally {
    state.syncing = false;
    state.ignoreEventsUntil = Date.now() + state.quietAfterSyncMs;
  }
}

/**
 * Start the file watcher daemon. Idempotent — additional calls while the
 * daemon is already running are no-ops. Honors SCM_FILE_WATCHER_ENABLED env
 * var (set to "false" to disable). When memoryRoots is empty (no folders
 * configured) the daemon stays dormant.
 */
export function startFileWatcher(opts: FileWatcherOptions = {}): void {
  if (state.watchers.length > 0) return;
  const envOverride = process.env.SCM_FILE_WATCHER_ENABLED;
  const enabled = opts.enabled ?? (envOverride !== "false");
  if (!enabled) {
    state.enabled = false;
    return;
  }
  const paths = opts.paths ?? memoryRoots;
  if (paths.length === 0) {
    state.enabled = false;
    return;
  }
  state.enabled = true;
  state.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  state.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  state.quietAfterSyncMs = opts.quietAfterSyncMs ?? DEFAULT_QUIET_AFTER_SYNC_MS;
  state.syncFn = opts.syncFn ?? ((a) => syncLocalMemory(a));
  state.lastSyncStartedAt = null;
  state.lastSyncEndedAt = null;
  state.lastSyncFilesChanged = 0;
  state.lastSyncDurationMs = 0;
  state.lastSyncErrored = 0;
  state.totalSyncs = 0;
  state.totalFilesQueued = 0;
  state.ignoreEventsUntil = 0;
  state.pendingPaths.clear();

  for (const root of paths) {
    if (!fs.existsSync(root)) continue;
    try {
      const w = fs.watch(
        root,
        { recursive: true, persistent: false },
        (_evt, filename) => onChange(filename, root),
      );
      // fs.watch errors are usually transient (renamed dirs, perm flicker).
      // Swallow so a single bad event doesn't crash the daemon.
      w.on("error", () => {
        /* swallow */
      });
      state.watchers.push(w);
    } catch {
      /* dir unwatched (perm denied / unsupported FS) — skip silently */
    }
  }
  void emit({
    daemon: "file_watcher",
    event: "run_started",
    payload: { phase: "boot", roots_watched: state.watchers.length, roots_requested: paths.length },
  });
}

/**
 * Stop the file watcher daemon and release all resources. Safe to call
 * even when the daemon is not running. After stop, the module-level state
 * is reset so a subsequent startFileWatcher() begins from a clean slate.
 */
export function stopFileWatcher(): void {
  for (const w of state.watchers) {
    try {
      w.close();
    } catch {
      /* watcher already closed — ignore */
    }
  }
  state.watchers = [];
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  state.pendingPaths.clear();
  state.enabled = false;
  state.syncing = false;
}

/** Snapshot of the daemon's runtime state, for diagnostics / dashboard. */
export type FileWatcherStatus = {
  enabled: boolean;
  watchers_count: number;
  pending_paths: number;
  syncing: boolean;
  debounce_ms: number;
  min_interval_ms: number;
  quiet_after_sync_ms: number;
  last_sync_ended_at: string | null;
  last_sync_files_changed: number;
  last_sync_duration_ms: number;
  last_sync_errored: number;
  total_syncs: number;
  total_files_queued: number;
};

export function getFileWatcherStatus(): FileWatcherStatus {
  return {
    enabled: state.enabled,
    watchers_count: state.watchers.length,
    pending_paths: state.pendingPaths.size,
    syncing: state.syncing,
    debounce_ms: state.debounceMs,
    min_interval_ms: state.minIntervalMs,
    quiet_after_sync_ms: state.quietAfterSyncMs,
    last_sync_ended_at: state.lastSyncEndedAt,
    last_sync_files_changed: state.lastSyncFilesChanged,
    last_sync_duration_ms: state.lastSyncDurationMs,
    last_sync_errored: state.lastSyncErrored,
    total_syncs: state.totalSyncs,
    total_files_queued: state.totalFilesQueued,
  };
}
