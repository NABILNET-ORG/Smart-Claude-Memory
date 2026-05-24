// M8.3 Suite D — /api/graph/clusters HTTP-route contract tests.
//
// Mirrors gui-graph.test.ts: spins up createGuiServer() against a fresh
// random port for each case, stubs getClusterGraphSuper / getClusterGraphDrill
// via the GuiHandlers seam (wired in the Session 42 prep refactor), and
// verifies the 5 contract points from M8.3 spec §11.D:
//   D1 — level=super returns ≤ CLUSTER_GRAPH_NODE_LIMIT (200) nodes
//   D2 — level=drill&supernode_id=N returns members of that supernode
//   D3 — drill with > 200 members nests to community level (mode='community-nested')
//   D4 — bearer token gate (parity with /api/graph)
//   D5 — bad project_id → 200 with empty arrays (NOT 500)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import { createGuiServer, type GuiHandlers } from "../src/gui/server.js";
import type {
  ClusterGraphSuperPayload,
  ClusterGraphDrillPayload,
  ClusterGraphFailure,
} from "../src/clustering/clusters.js";

const CLUSTER_GRAPH_NODE_LIMIT = 200;

function emptyOtherHandlers(): Omit<
  GuiHandlers,
  "getClusterGraphSuper" | "getClusterGraphDrill"
> {
  return {
    listGraduationCandidates: async () => ({ count: 0, results: [] }),
    composeGlobalRationale: async () => ({ ok: true }),
    confirmPromotion: async () => ({ ok: true }),
    rejectGraduation: async () => ({ ok: true }),
    listKgNodes: async () => ({ count: 0, results: [] }),
    listKgEdges: async () => ({ count: 0, results: [] }),
  };
}

type StubState = {
  superCalls: string[];
  drillCalls: Array<{ projectId: string; supernodeId: number }>;
  superPayload?: ClusterGraphSuperPayload | ClusterGraphFailure;
  drillPayload?: ClusterGraphDrillPayload | ClusterGraphFailure;
};

function makeHandlers(state: StubState): GuiHandlers {
  return {
    ...emptyOtherHandlers(),
    getClusterGraphSuper: async (projectId: string) => {
      state.superCalls.push(projectId);
      return (
        state.superPayload ?? {
          ok: true,
          level: "super",
          project_id: projectId,
          nodes: [],
          edges: [],
          computed_at: null,
        }
      );
    },
    getClusterGraphDrill: async (projectId: string, supernodeId: number) => {
      state.drillCalls.push({ projectId, supernodeId });
      return (
        state.drillPayload ?? {
          ok: true,
          level: "drill",
          mode: "members",
          project_id: projectId,
          supernode_id: supernodeId,
          nodes: [],
          edges: [],
        }
      );
    },
  };
}

async function startServer(
  handlers: GuiHandlers,
  token: string | null = null,
): Promise<{ server: ReturnType<typeof createGuiServer>; base: string }> {
  const server = createGuiServer({ handlers, token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function stopServer(server: ReturnType<typeof createGuiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("M8.3 Suite D — /api/graph/clusters HTTP routes", () => {
  it("D1: level=super returns payload with nodes ≤ CLUSTER_GRAPH_NODE_LIMIT", async () => {
    const nodes = Array.from({ length: CLUSTER_GRAPH_NODE_LIMIT }, (_, i) => ({
      id: `S:${i}`,
      supernode_id: i,
      label: `cluster-${i}`,
      node_count: 10,
    }));
    const state: StubState = {
      superCalls: [],
      drillCalls: [],
      superPayload: {
        ok: true,
        level: "super",
        project_id: "claude-memory",
        nodes,
        edges: [],
        computed_at: "2026-05-24T00:00:00Z",
      },
    };
    const { server, base } = await startServer(makeHandlers(state));
    try {
      const r = await fetch(
        `${base}/api/graph/clusters?level=super&project_id=claude-memory`,
      );
      assert.equal(r.status, 200);
      const body = (await r.json()) as ClusterGraphSuperPayload;
      assert.equal(body.ok, true);
      assert.equal(body.level, "super");
      assert.equal(body.project_id, "claude-memory");
      assert.ok(Array.isArray(body.nodes));
      assert.ok(
        body.nodes.length <= CLUSTER_GRAPH_NODE_LIMIT,
        `expected ≤${CLUSTER_GRAPH_NODE_LIMIT} nodes, got ${body.nodes.length}`,
      );
      assert.equal(state.superCalls.length, 1);
      assert.equal(state.superCalls[0], "claude-memory");
    } finally {
      await stopServer(server);
    }
  });

  it("D2: level=drill&supernode_id=N returns members of that supernode", async () => {
    const members = Array.from({ length: 15 }, (_, i) => ({
      id: 1000 + i,
      label: `node-${1000 + i}`,
      type: "NOTE",
    }));
    const state: StubState = {
      superCalls: [],
      drillCalls: [],
      drillPayload: {
        ok: true,
        level: "drill",
        mode: "members",
        project_id: "claude-memory",
        supernode_id: 7,
        nodes: members,
        edges: [],
      },
    };
    const { server, base } = await startServer(makeHandlers(state));
    try {
      const r = await fetch(
        `${base}/api/graph/clusters?level=drill&supernode_id=7&project_id=claude-memory`,
      );
      assert.equal(r.status, 200);
      const body = (await r.json()) as ClusterGraphDrillPayload;
      assert.equal(body.ok, true);
      assert.equal(body.level, "drill");
      assert.equal(body.mode, "members");
      assert.equal(body.supernode_id, 7);
      assert.equal(body.nodes.length, 15);
      assert.equal(state.drillCalls.length, 1);
      assert.equal(state.drillCalls[0].supernodeId, 7);
      assert.equal(state.drillCalls[0].projectId, "claude-memory");
    } finally {
      await stopServer(server);
    }
  });

  it("D3: drill with > 200 members nests to community level", async () => {
    // When a supernode contains more members than the GUI can render, the
    // handler returns a community-nested view (one node per Louvain community
    // inside the supernode) so the client still gets a bounded graph.
    const community = Array.from({ length: 12 }, (_, i) => ({
      id: `C:${i}`,
      community_id: i,
      label: `community-${i}`,
      node_count: Math.ceil(250 / 12),
    }));
    const state: StubState = {
      superCalls: [],
      drillCalls: [],
      drillPayload: {
        ok: true,
        level: "drill",
        mode: "community-nested",
        project_id: "claude-memory",
        supernode_id: 3,
        nodes: community,
        edges: [],
      },
    };
    const { server, base } = await startServer(makeHandlers(state));
    try {
      const r = await fetch(
        `${base}/api/graph/clusters?level=drill&supernode_id=3&project_id=claude-memory`,
      );
      assert.equal(r.status, 200);
      const body = (await r.json()) as ClusterGraphDrillPayload;
      assert.equal(body.ok, true);
      assert.equal(body.mode, "community-nested");
      assert.equal(body.supernode_id, 3);
      assert.equal(body.nodes.length, 12);
    } finally {
      await stopServer(server);
    }
  });

  it("D4: bearer token gate — 401 without correct token, 200 with it", async () => {
    const token = "test-token-d4";
    const state: StubState = { superCalls: [], drillCalls: [] };
    const { server, base } = await startServer(makeHandlers(state), token);
    try {
      const noToken = await fetch(`${base}/api/graph/clusters?level=super`);
      assert.equal(noToken.status, 401);
      const noTokenBody = await noToken.json();
      assert.equal(noTokenBody.ok, false);
      assert.equal(noTokenBody.reason, "unauthorized");
      assert.equal(
        state.superCalls.length,
        0,
        "handler must NOT be invoked when token check fails",
      );

      const withToken = await fetch(`${base}/api/graph/clusters?level=super`, {
        headers: { "x-scm-gui-token": token },
      });
      assert.equal(withToken.status, 200);
      const okBody = await withToken.json();
      assert.equal(okBody.ok, true);
      assert.equal(state.superCalls.length, 1);
    } finally {
      await stopServer(server);
    }
  });

  it("D5: unknown project_id returns 200 with empty arrays (NOT 500)", async () => {
    // Empty payload semantics — the route MUST NOT 500 on "no clusters yet"
    // because that's the steady state for a fresh project. The clusters.ts
    // handler returns ok:true + empty nodes/edges in that case; the route
    // surfaces it as 200.
    const state: StubState = {
      superCalls: [],
      drillCalls: [],
      superPayload: {
        ok: true,
        level: "super",
        project_id: "ghost-project",
        nodes: [],
        edges: [],
        computed_at: null,
      },
    };
    const { server, base } = await startServer(makeHandlers(state));
    try {
      const r = await fetch(
        `${base}/api/graph/clusters?level=super&project_id=ghost-project`,
      );
      assert.equal(r.status, 200, "empty result must be 200 not 500");
      const body = (await r.json()) as ClusterGraphSuperPayload;
      assert.equal(body.ok, true);
      assert.equal(body.project_id, "ghost-project");
      assert.deepEqual(body.nodes, []);
      assert.deepEqual(body.edges, []);
      assert.equal(body.computed_at, null);
      assert.equal(state.superCalls[0], "ghost-project");
    } finally {
      await stopServer(server);
    }
  });
});
