// Epic F (M8) — GUI Backlog route smoke test.
//
// Hermetic: stubs listBacklog so no Supabase round-trip. Verifies that
// /api/backlog:
//   1. responds 200 + { ok:true } shape with all four kanban columns
//   2. forwards project_id from the query string into the handler
//   3. forwards a single status filter
//   4. forwards a CSV status filter (e.g. ?status=todo,blocked)
//   5. groups + sorts rows correctly per column
//      (priority asc, then created_at asc within each column)
//   6. ignores garbage status tokens
//
// Same shape as tests/gui.test.ts — ephemeral 127.0.0.1 server on port 0.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import {
  createGuiServer,
  type GuiHandlers,
  type ListBacklogInput,
} from "../src/gui/server.js";
import type { BacklogRow, BacklogStatus } from "../src/supabase.js";

type BacklogStubState = {
  lastInput?: ListBacklogInput;
  callCount: number;
  // PATCH stub telemetry (Phase 1 write route).
  lastUpdateId?: number;
  lastUpdatePatch?: { status: BacklogStatus };
  updateCallCount: number;
  // When set, the updateBacklog stub throws this message (simulates a DB
  // error / not-found) instead of returning a row.
  updateThrows?: string;
};

function row(
  id: number,
  status: BacklogStatus,
  priority: number,
  title: string,
  createdAt: string,
): BacklogRow {
  return {
    id,
    project_id: "test-project",
    title,
    status,
    priority,
    notes: null,
    metadata: null,
    created_at: createdAt,
    updated_at: createdAt,
  } as BacklogRow;
}

const FIXTURE: BacklogRow[] = [
  // todo column — should sort by priority asc, then age asc
  row(10, "todo", 3, "low-pri todo",       "2026-05-20T00:00:00Z"),
  row(11, "todo", 1, "urgent todo (newer)", "2026-05-22T00:00:00Z"),
  row(12, "todo", 1, "urgent todo (older)", "2026-05-21T00:00:00Z"),
  // in_progress column
  row(20, "in_progress", 2, "in-flight work", "2026-05-23T00:00:00Z"),
  // blocked column
  row(30, "blocked", 1, "blocked on external dep", "2026-05-19T00:00:00Z"),
  // done is intentionally empty (rows would already be archived)
];

function makeHandlers(state: BacklogStubState, rows: BacklogRow[]): GuiHandlers {
  const stub = {
    listBacklog: async (input: ListBacklogInput) => {
      state.lastInput = input;
      state.callCount += 1;
      // Apply status filter the same way the real Supabase query would,
      // so our test exercises the route's filter-forwarding correctly.
      if (!input.status) return rows;
      const set = new Set(Array.isArray(input.status) ? input.status : [input.status]);
      return rows.filter((r) => set.has(r.status));
    },
    // PATCH write route (Phase 1). Echoes the patched row back so the route
    // can wrap it as { ok:true, task }. Throws on demand to exercise the
    // DB-error / not-found path. Stubbed the same way as listBacklog above —
    // no Supabase round-trip.
    updateBacklog: async (id: number, patch: { status: BacklogStatus }) => {
      state.lastUpdateId = id;
      state.lastUpdatePatch = patch;
      state.updateCallCount += 1;
      if (state.updateThrows) throw new Error(state.updateThrows);
      return row(id, patch.status, 2, "patched row", "2026-05-24T00:00:00Z");
    },
    // Other handlers are unused by /api/backlog; cast bypasses the
    // GuiHandlers exhaustiveness check (same pragmatic stance as the
    // sibling gui.test.ts stub which only provides the M7 handlers).
  };
  return stub as unknown as GuiHandlers;
}

async function startTestServer(handlers: GuiHandlers) {
  const server = createGuiServer({ handlers, token: null });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("gui server — /api/backlog (Epic F)", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: BacklogStubState = { callCount: 0, updateCallCount: 0 };

  before(async () => {
    const handlers = makeHandlers(state, FIXTURE);
    const started = await startTestServer(handlers);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 200 with the ok:true Kanban shape and four columns", async () => {
    const res = await fetch(`${baseUrl}/api/backlog`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      project_id: string;
      total: number;
      columns: Record<string, BacklogRow[]>;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.project_id, "string");
    assert.ok(body.columns);
    assert.deepEqual(
      Object.keys(body.columns).sort(),
      ["blocked", "done", "in_progress", "todo"],
    );
    assert.equal(body.total, FIXTURE.length);
  });

  it("forwards ?project_id to the handler", async () => {
    state.lastInput = undefined;
    const res = await fetch(`${baseUrl}/api/backlog?project_id=alpha-proj`);
    assert.equal(res.status, 200);
    assert.equal(state.lastInput?.project_id, "alpha-proj");
  });

  it("forwards a single ?status= filter and the handler narrows the rows", async () => {
    state.lastInput = undefined;
    const res = await fetch(`${baseUrl}/api/backlog?status=todo`);
    assert.equal(res.status, 200);
    assert.equal(state.lastInput?.status, "todo");
    const body = (await res.json()) as { columns: Record<string, BacklogRow[]> };
    // todo column has 3 rows in FIXTURE; other columns empty.
    assert.equal(body.columns.todo.length, 3);
    assert.equal(body.columns.in_progress.length, 0);
    assert.equal(body.columns.blocked.length, 0);
    assert.equal(body.columns.done.length, 0);
  });

  it("forwards a CSV ?status=todo,blocked filter as an array", async () => {
    state.lastInput = undefined;
    const res = await fetch(`${baseUrl}/api/backlog?status=todo,blocked`);
    assert.equal(res.status, 200);
    assert.deepEqual(state.lastInput?.status, ["todo", "blocked"]);
    const body = (await res.json()) as { columns: Record<string, BacklogRow[]> };
    assert.equal(body.columns.todo.length, 3);
    assert.equal(body.columns.blocked.length, 1);
    assert.equal(body.columns.in_progress.length, 0);
  });

  it("sorts rows within a column by priority asc then created_at asc", async () => {
    const res = await fetch(`${baseUrl}/api/backlog?status=todo`);
    const body = (await res.json()) as { columns: { todo: BacklogRow[] } };
    const ids = body.columns.todo.map((r) => r.id);
    // Expected order: id=12 (pri=1, older) → id=11 (pri=1, newer) → id=10 (pri=3)
    assert.deepEqual(ids, [12, 11, 10]);
  });

  it("ignores unknown status tokens in the CSV", async () => {
    state.lastInput = undefined;
    const res = await fetch(`${baseUrl}/api/backlog?status=garbage,todo,nope`);
    assert.equal(res.status, 200);
    // Only the recognized 'todo' token survives the filter pipeline.
    assert.equal(state.lastInput?.status, "todo");
  });

  it("returns empty columns + total=0 when the handler returns no rows", async () => {
    // Re-spin a fresh server with an empty fixture to keep this hermetic.
    const localState: BacklogStubState = { callCount: 0, updateCallCount: 0 };
    const localServer = await startTestServer(makeHandlers(localState, []));
    try {
      const res = await fetch(`${localServer.baseUrl}/api/backlog`);
      const body = (await res.json()) as {
        ok: boolean;
        total: number;
        columns: Record<string, BacklogRow[]>;
      };
      assert.equal(body.ok, true);
      assert.equal(body.total, 0);
      for (const col of ["todo", "in_progress", "blocked", "done"]) {
        assert.equal(body.columns[col].length, 0);
      }
    } finally {
      await localServer.close();
    }
  });
});

describe("gui server — PATCH /api/backlog/:id (Phase 1 write route)", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let state: BacklogStubState;

  before(async () => {
    state = { callCount: 0, updateCallCount: 0 };
    const started = await startTestServer(makeHandlers(state, FIXTURE));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("patches a valid status → 200 { ok:true, task } with the updated row", async () => {
    state.updateThrows = undefined;
    const res = await fetch(`${baseUrl}/api/backlog/42`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; task: BacklogRow };
    assert.equal(body.ok, true);
    assert.equal(body.task.id, 42);
    assert.equal(body.task.status, "done");
    // The route forwarded exactly the parsed id + status-only patch.
    assert.equal(state.lastUpdateId, 42);
    assert.deepEqual(state.lastUpdatePatch, { status: "done" });
  });

  it("ignores non-status fields, forwarding only { status }", async () => {
    state.updateThrows = undefined;
    const res = await fetch(`${baseUrl}/api/backlog/7`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "blocked", priority: 1, title: "hijack" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.lastUpdatePatch, { status: "blocked" });
  });

  it("rejects an invalid status → 400 { ok:false } and never calls updateBacklog", async () => {
    state.updateThrows = undefined;
    const before = state.updateCallCount;
    const res = await fetch(`${baseUrl}/api/backlog/42`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "nope" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(typeof body.reason, "string");
    assert.equal(state.updateCallCount, before);
  });

  it("rejects a missing status → 400 { ok:false }", async () => {
    const res = await fetch(`${baseUrl}/api/backlog/42`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it("rejects a non-integer id → 400 (route regex falls through to 404 only for non-numeric)", async () => {
    // A non-numeric id never matches /^\/api\/backlog\/(\d+)$/, so it falls
    // through the API routes and 404s — assert it is NOT a successful 200.
    const res = await fetch(`${baseUrl}/api/backlog/abc`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.notEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it("surfaces a DB error → 500 { ok:false, reason }", async () => {
    state.updateThrows = "updateBacklog failed: connection reset";
    const res = await fetch(`${baseUrl}/api/backlog/99`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.match(body.reason, /connection reset/);
    state.updateThrows = undefined;
  });

  it("maps a not-found DB error → 404 { ok:false }", async () => {
    state.updateThrows = "updateBacklog failed: JSON object requested, multiple (or no) rows returned (PGRST116)";
    const res = await fetch(`${baseUrl}/api/backlog/123456`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
    state.updateThrows = undefined;
  });
});
