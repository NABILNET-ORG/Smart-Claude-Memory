// Epic G (Session 43 Phase 2) — File Watcher Daemon tests.
//
// Hermetic: writes to a fresh os.tmpdir() subtree, injects a stub syncFn
// so we never touch Supabase/Ollama. Asserts the debounce + min-interval
// + ignored-extension + idempotent-start + clean-stop behaviour that the
// daemon documents in src/sync/file-watcher-daemon.ts.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startFileWatcher,
  stopFileWatcher,
  getFileWatcherStatus,
} from "../src/sync/file-watcher-daemon.js";

// Wait for `ms` real milliseconds. fs.watch is event-driven so the test
// must yield to the event loop after writes; setTimeout is the standard
// way to do that with deterministic latency on Windows + POSIX.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type SyncCall = { at: number };

function makeStubSync() {
  const calls: SyncCall[] = [];
  const fn = async () => {
    calls.push({ at: Date.now() });
  };
  return { fn, calls };
}

describe("file watcher daemon — Epic G", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scm-fw-"));
  });

  afterEach(() => {
    stopFileWatcher();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("fires syncFn once for a single .md write after the debounce window", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    // Yield a tick so fs.watch is fully wired up on Windows.
    await sleep(40);
    writeFileSync(join(tempDir, "note.md"), "hello world\n");
    // Wait > debounceMs to let the flush fire.
    await sleep(220);
    assert.equal(sync.calls.length, 1, `expected 1 sync, got ${sync.calls.length}`);
  });

  it("coalesces a burst of rapid writes into a single syncFn call", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 100,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    await sleep(40);
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(tempDir, `burst-${i}.md`), String(i));
    }
    // Wait > debounceMs to let the coalesced flush fire.
    await sleep(260);
    assert.equal(
      sync.calls.length,
      1,
      `expected 1 coalesced sync for 8 burst writes, got ${sync.calls.length}`,
    );
  });

  it("ignores writes to non-watched extensions (.log, .lock, no-ext)", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    await sleep(40);
    writeFileSync(join(tempDir, "thing.log"), "log line\n");
    writeFileSync(join(tempDir, "thing.lock"), "lock\n");
    writeFileSync(join(tempDir, "no-extension-file"), "x\n");
    await sleep(220);
    assert.equal(
      sync.calls.length,
      0,
      `non-watched extensions should not fire sync; got ${sync.calls.length}`,
    );
  });

  it("stopFileWatcher() prevents any further syncFn calls", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    await sleep(40);
    stopFileWatcher();
    writeFileSync(join(tempDir, "post-stop.md"), "should be ignored\n");
    await sleep(220);
    assert.equal(
      sync.calls.length,
      0,
      `stopped daemon must not sync; got ${sync.calls.length}`,
    );
  });

  it("is idempotent — a second startFileWatcher() is a no-op while running", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    const first = getFileWatcherStatus().watchers_count;
    // Second call must NOT install a second set of watchers.
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    const second = getFileWatcherStatus().watchers_count;
    assert.equal(first, second, "watcher count must not grow on re-start");
    await sleep(40);
    writeFileSync(join(tempDir, "single-write.md"), "once\n");
    await sleep(220);
    // Single physical write should still produce exactly one sync.
    assert.equal(sync.calls.length, 1, `idempotent start must not double-fire sync`);
  });

  it("stays dormant when no paths are configured", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [],
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    const status = getFileWatcherStatus();
    assert.equal(status.enabled, false, "empty paths → daemon must self-disable");
    assert.equal(status.watchers_count, 0, "no watchers installed");
    // Even if we write a file in some other dir, sync must NOT fire.
    writeFileSync(join(tempDir, "untouched.md"), "ignored\n");
    await sleep(180);
    assert.equal(sync.calls.length, 0);
  });

  it("respects opts.enabled=false (stays dormant)", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      enabled: false,
      debounceMs: 80,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    const status = getFileWatcherStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.watchers_count, 0);
    writeFileSync(join(tempDir, "should-not-trigger.md"), "x\n");
    await sleep(180);
    assert.equal(sync.calls.length, 0);
  });

  it("counts queued files in totalFilesQueued telemetry", async () => {
    const sync = makeStubSync();
    startFileWatcher({
      paths: [tempDir],
      debounceMs: 100,
      minIntervalMs: 0,
      quietAfterSyncMs: 0,
      syncFn: sync.fn,
    });
    await sleep(40);
    writeFileSync(join(tempDir, "a.md"), "1\n");
    writeFileSync(join(tempDir, "b.md"), "2\n");
    writeFileSync(join(tempDir, "c.md"), "3\n");
    await sleep(220);
    const status = getFileWatcherStatus();
    assert.ok(
      status.total_files_queued >= 3,
      `expected >= 3 queued events, got ${status.total_files_queued}`,
    );
    assert.equal(status.total_syncs, 1);
  });
});
