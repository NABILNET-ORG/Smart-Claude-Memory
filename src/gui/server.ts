// Sovereign Command Center — HTTP server.
//
// Zero-dependency HTTP API + dashboard. Runs alongside the MCP stdio server
// in the same Node process. Loopback-only (127.0.0.1) by default — the
// service-role Supabase key lives in this process, so the GUI MUST NOT
// listen on any non-loopback interface unless the operator explicitly opts
// in via SCM_GUI_HOST. An optional bearer token (SCM_GUI_TOKEN) gates the
// mutation routes when the operator needs an extra layer.
//
// All handlers are passed in via the GuiHandlers seam so tests can stub
// them without touching the Supabase client. The default handler set is
// the real M7 graduation surface from src/tools/graduation.ts.
//
// Routes:
//   GET  /                                  — dashboard HTML
//   GET  /api/health                        — { ok, service, version }
//   GET  /api/backlog[?project_id=&status=todo,in_progress,blocked,done]
//                                           — Active Backlog Kanban (Epic F / M8)
//   PATCH /api/backlog/:id                  — move a card (status only); Phase 1
//   GET  /api/graduations[?project_id=&state=&k=&offset=]
//                                           — listGraduationCandidates
//   POST /api/graduations/:id/compose       — composeGlobalRationale
//   POST /api/graduations/:id/confirm       — confirmPromotion
//   POST /api/graduations/:id/reject        — rejectGraduation

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { currentProjectId, slugify } from "../project.js";
import {
  listGraduationCandidates as defaultList,
  composeGlobalRationale as defaultCompose,
  confirmPromotion as defaultConfirm,
  rejectGraduation as defaultReject,
  type ListGraduationCandidatesInput,
  type ComposeGlobalRationaleInput,
  type ConfirmPromotionInput,
  type RejectGraduationInput,
} from "../tools/graduation.js";
import {
  listKgNodes as defaultListKgNodes,
  listKgEdges as defaultListKgEdges,
  type ListKgNodesInput,
  type ListKgEdgesInput,
} from "../tools/kg.js";
import {
  getClusterGraphSuper as defaultGetClusterGraphSuper,
  getClusterGraphDrill as defaultGetClusterGraphDrill,
  type ClusterGraphSuperPayload,
  type ClusterGraphDrillPayload,
  type ClusterGraphFailure,
} from "../clustering/clusters.js";
// SCM-S39-D1 (v2.2.2): /api/budget surface.
import {
  getDaemonBudget as defaultGetDaemonBudget,
  getTaskBudget as defaultGetTaskBudget,
} from "../tools/budget.js";
// Epic F (M8 Backlog UI): /api/backlog surface.
import {
  listBacklog as defaultListBacklog,
  updateBacklog as defaultUpdateBacklog,
  getBacklogRow as defaultGetBacklogRow,
  type BacklogRow,
  type BacklogStatus,
} from "../supabase.js";
// Phase 1 (Epic F): Active Backlog write route (PATCH status), split out to keep this file under the 750-line ceiling.
import { handleBacklogPatch } from "./backlog-write.js";

export type ListBacklogInput = {
  project_id?: string;
  status?: BacklogStatus | BacklogStatus[];
};

export type BacklogKanbanColumns = {
  todo: BacklogRow[];
  in_progress: BacklogRow[];
  blocked: BacklogRow[];
  done: BacklogRow[];
};

export type BacklogKanbanPayload = {
  ok: true;
  project_id: string;
  total: number;
  columns: BacklogKanbanColumns;
};

const BACKLOG_STATUSES: readonly BacklogStatus[] = ["todo", "in_progress", "blocked", "done"];

function isBacklogStatus(s: string): s is BacklogStatus {
  return (BACKLOG_STATUSES as readonly string[]).includes(s);
}

function emptyColumns(): BacklogKanbanColumns {
  return { todo: [], in_progress: [], blocked: [], done: [] };
}

// #300 — intra-column drag-to-reorder. A card's position is governed by an
// "effective key": its metadata.rank when that is a finite number, ELSE its
// index in the LEGACY order (priority asc, then created_at asc) of the column.
// This lets a freshly-ranked card slot between two never-ranked neighbours by
// landing on a fractional midpoint of their legacy indices — no schema/migration
// needed, and unranked columns render byte-identical to the pre-#300 behaviour.
// Pure + deterministic so the test can call it directly.
export function sortColumn(rows: BacklogRow[]): BacklogRow[] {
  // Legacy order = the historical comparator. Build id→legacyIndex from it so
  // an unranked card's effective key is its slot in that exact ordering.
  const legacy = [...rows].sort(
    (a, b) =>
      a.priority - b.priority ||
      Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const legacyIndex = new Map<number, number>();
  legacy.forEach((r, i) => legacyIndex.set(r.id, i));

  const keyOf = (r: BacklogRow): number => {
    const rank = (r.metadata as { rank?: unknown } | null | undefined)?.rank;
    return typeof rank === "number" && Number.isFinite(rank)
      ? rank
      : (legacyIndex.get(r.id) ?? 0);
  };

  return [...rows].sort(
    (a, b) =>
      keyOf(a) - keyOf(b) ||
      // Stable tie-break: identical effective keys fall back to legacy order.
      a.priority - b.priority ||
      Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

function groupByStatus(rows: BacklogRow[]): BacklogKanbanColumns {
  const cols = emptyColumns();
  for (const row of rows) {
    if (cols[row.status]) cols[row.status].push(row);
  }
  // Within each column: effective-key order (metadata.rank, else legacy index).
  for (const status of BACKLOG_STATUSES) {
    cols[status] = sortColumn(cols[status]);
  }
  return cols;
}

// Static asset root — resolves to src/gui/public when tsx-running directly
// (npm run gui) and to dist/gui/public after `tsc` builds. The build step
// `npm run copy:gui` mirrors src/gui/public/ → dist/gui/public/.
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "public",
);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export const GUI_VERSION = "1.0.0";

// v2.1.9 — Deterministic per-project port. Hashes the project_id into a
// stable port in [PROJECT_PORT_RANGE_START, PROJECT_PORT_RANGE_START+SIZE).
// Same project_id → same port across MCP restarts, machines, time. Different
// projects → different ports (collisions are theoretical but the range is
// 1000-wide so practical collisions need 2 projects with same SHA-256 head).
// Universal — adapts to ANY workspace via its derived project_id.
export const PROJECT_PORT_RANGE_START = 7790;
export const PROJECT_PORT_RANGE_SIZE = 1000;

export function computeProjectPort(projectId: string): number {
  const digest = createHash("sha256").update(projectId, "utf8").digest();
  const u32 = digest.readUInt32LE(0);
  return PROJECT_PORT_RANGE_START + (u32 % PROJECT_PORT_RANGE_SIZE);
}

// ─── #342 browser auto-open recency guard ──────────────────────────────────
// The GUI runs IN-PROCESS, so it dies with the MCP process. probePort() only
// catches a *concurrent* server, never a prior sequential session — so a fresh
// tab was opened on every boot ("browser fatigue"). A per-port recency marker
// suppresses the redundant auto-open within a TTL; the stable per-project port
// means any still-open tab simply reconnects when the new session rebinds it.
export const GUI_OPEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h; override via SCM_GUI_OPEN_TTL_MS

/** Per-port "last browser auto-open" timestamps (epoch ms), under ~/.claude-memory. */
export function guiOpenMarkerPath(): string {
  return path.join(os.homedir(), ".claude-memory", "gui-open-marker.json");
}

/** Pure decision: open only if no open within ttl. A non-positive ttl or a
 *  missing / non-finite timestamp ⇒ always open (degrades to legacy behavior). */
export function shouldOpenBrowserNow(lastOpenMs: number | undefined, ttlMs: number, nowMs: number): boolean {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return true;
  if (typeof lastOpenMs !== "number" || !Number.isFinite(lastOpenMs)) return true;
  return nowMs - lastOpenMs >= ttlMs;
}

function readOpenMarker(file: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** True if a browser tab should be auto-opened for `port` at `nowMs`. */
export function shouldOpenForPort(
  port: number,
  ttlMs: number,
  nowMs: number,
  file: string = guiOpenMarkerPath(),
): boolean {
  return shouldOpenBrowserNow(readOpenMarker(file)[String(port)], ttlMs, nowMs);
}

/** Best-effort stamp of "opened a tab for `port` at nowMs". Never throws — the
 *  marker is an optimization and must never block GUI startup. */
export function stampOpenForPort(port: number, nowMs: number, file: string = guiOpenMarkerPath()): void {
  try {
    const data = readOpenMarker(file);
    data[String(port)] = nowMs;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {
    /* swallow: marker write is non-critical */
  }
}

export type GuiHandlers = {
  listGraduationCandidates: (input: ListGraduationCandidatesInput) => Promise<unknown>;
  composeGlobalRationale: (input: ComposeGlobalRationaleInput) => Promise<unknown>;
  confirmPromotion: (input: ConfirmPromotionInput) => Promise<unknown>;
  rejectGraduation: (input: RejectGraduationInput) => Promise<unknown>;
  listKgNodes: (input: ListKgNodesInput) => Promise<unknown>;
  listKgEdges: (input: ListKgEdgesInput) => Promise<unknown>;
  getClusterGraphSuper: (projectId: string) => Promise<ClusterGraphSuperPayload | ClusterGraphFailure>;
  getClusterGraphDrill: (projectId: string, supernodeId: number) => Promise<ClusterGraphDrillPayload | ClusterGraphFailure>;
  listBacklog: (input: ListBacklogInput) => Promise<BacklogRow[]>;
  // #300: patch may carry status (cross-column move) and/or metadata (rank reorder).
  updateBacklog: (
    id: number,
    patch: { status?: BacklogStatus; metadata?: Record<string, unknown> },
  ) => Promise<BacklogRow>;
  // #300: single-row read for the rank read-merge-write path.
  getBacklogRow: (id: number) => Promise<BacklogRow>;
};

const DEFAULT_HANDLERS: GuiHandlers = {
  listGraduationCandidates: defaultList,
  composeGlobalRationale: defaultCompose,
  confirmPromotion: defaultConfirm,
  rejectGraduation: defaultReject,
  listKgNodes: defaultListKgNodes,
  listKgEdges: defaultListKgEdges,
  getClusterGraphSuper: defaultGetClusterGraphSuper,
  getClusterGraphDrill: defaultGetClusterGraphDrill,
  listBacklog: ({ project_id, status }) =>
    defaultListBacklog(project_id ?? currentProjectId, status ? { status } : {}),
  updateBacklog: (id, patch) => defaultUpdateBacklog(id, patch),
  getBacklogRow: (id) => defaultGetBacklogRow(id),
};

// Knowledge Graph route parameter clamps.
const GRAPH_NODE_LIMIT_DEFAULT = 60;
const GRAPH_NODE_LIMIT_MIN = 1;
const GRAPH_NODE_LIMIT_MAX = 200;
const GRAPH_EDGE_LIMIT_DEFAULT = 120;
const GRAPH_EDGE_LIMIT_MIN = 1;
const GRAPH_EDGE_LIMIT_MAX = 500;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function resolveProjectId(raw: string | null, fallback: string): string {
  if (raw && raw.trim().length > 0) return raw;
  const env = process.env.SMART_CLAUDE_MEMORY_PROJECT_ID;
  if (env && env.trim().length > 0) return env;
  return fallback;
}

export interface GuiServerOptions {
  port?: number;
  host?: string;
  token?: string | null;
  handlers?: GuiHandlers;
  /**
   * v2.1.9 — Project namespace this GUI is serving. Used as (a) the universal
   * fallback for resolveProjectId when neither URL nor env supplies one, and
   * (b) the branding text injected into the index.html header. Omit → derive
   * from cwd via slugify(currentProjectId). NEVER hardcoded.
   */
  projectId?: string;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/**
 * v2.1.9 — Inject project branding into the dashboard HTML at serve time so
 * the header carries the live project_id without requiring any frontend code
 * changes. Pure string replacement, idempotent (markers are uncommon enough
 * that re-injection won't compound).
 */
export function injectProjectBranding(html: string, projectId: string): string {
  const safe = htmlEscape(projectId);
  const headInject =
    `  <meta name="scm-project-id" content="${safe}" />\n` +
    `  <script>window.__SCM_PROJECT_ID=${JSON.stringify(projectId)};</script>\n` +
    `</head>`;
  let out = html.replace("</head>", headInject);
  const brandMarker = `<span class="accent">M7 GRADUATIONS</span></h1>`;
  if (out.includes(brandMarker)) {
    out = out.replace(
      brandMarker,
      `<span class="accent">M7 GRADUATIONS</span><span class="sep">//</span>` +
        `<span class="accent" data-scm-project-id>PROJECT · ${safe.toUpperCase()}</span></h1>`,
    );
  }
  return out;
}

export function createGuiServer(opts: GuiServerOptions = {}): http.Server {
  const handlers = opts.handlers ?? DEFAULT_HANDLERS;
  const token = opts.token ?? null;
  // Universal default: derive from cwd when caller didn't wire a project_id.
  // ZERO hardcoded names — every workspace gets its own slug.
  const serverProjectId = opts.projectId ?? slugify(currentProjectId);

  return http.createServer(async (req, res) => {
    // Per-request access log (QA watcher signal): one stderr line on finish.
    const reqStart = Date.now();
    const logMethod = (req.method ?? "GET").toUpperCase();
    const logPath = (req.url ?? "/").split("?")[0];
    res.on("finish", () =>
      console.error("[scm-gui] %s %s -> %d %dms", logMethod, logPath, res.statusCode, Date.now() - reqStart),
    );

    // Defense-in-depth headers. The dashboard is same-origin, no third-party
    // assets, no inline event handlers — CSP is permissive only for inline
    // styles + scripts the dashboard itself ships.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // CSP allows JetBrains Mono via Google Fonts (declared in the
    // user-authored index.html): style-src extension for the stylesheet,
    // font-src for the @font-face downloads. Everything else stays same-origin.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
    );

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();
      const path = url.pathname;

      // Token guards the API surface only — dashboard HTML and its static
      // assets (CSS, JS, images, fonts) must load alongside the page itself.
      // /api/health stays open so an operator can probe liveness without a token.
      if (token !== null && path.startsWith("/api/") && path !== "/api/health") {
        const sent = pickHeader(req.headers["x-scm-gui-token"]);
        if (sent !== token) {
          return sendJson(res, 401, { ok: false, reason: "unauthorized" });
        }
      }

      if (method === "GET" && path === "/") {
        return serveStatic(res, "/index.html", serverProjectId);
      }

      if (method === "GET" && path === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "scm-gui",
          version: GUI_VERSION,
          project_id: serverProjectId,
        });
      }

      // SCM-S39-D1: Agentic Resource Manager surface for the GUI ticker.
      // Returns the daemon current-hour rollup; with task_id, also that task's burn.
      if (method === "GET" && path === "/api/budget") {
        const taskId = url.searchParams.get("task_id");
        const daemons = await defaultGetDaemonBudget({});
        let task: unknown = null;
        if (taskId && taskId.trim().length > 0) {
          task = await defaultGetTaskBudget({ task_id: taskId.trim() });
        }
        return sendJson(res, 200, { ok: true, mode: daemons.mode, daemons: daemons.rows, task });
      }

      // Epic F (M8 Backlog UI) — Active Backlog Kanban surface. Reads
      // cloud_backlog rows for the resolved project_id, pre-grouped + sorted
      // (priority asc, age asc) per column so the client renders without re-sort.
      if (method === "GET" && path === "/api/backlog") {
        const projectId = resolveProjectId(url.searchParams.get("project_id"), serverProjectId);
        const rawStatus = url.searchParams.get("status");
        let statusFilter: BacklogStatus | BacklogStatus[] | undefined;
        if (rawStatus !== null && rawStatus.trim().length > 0) {
          const parts = rawStatus
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .filter(isBacklogStatus);
          if (parts.length === 1) statusFilter = parts[0];
          else if (parts.length > 1) statusFilter = parts;
        }
        const input: ListBacklogInput = { project_id: projectId };
        if (statusFilter !== undefined) input.status = statusFilter;
        const rows = await handlers.listBacklog(input);
        const columns = groupByStatus(rows);
        const payload: BacklogKanbanPayload = {
          ok: true,
          project_id: projectId,
          total: rows.length,
          columns,
        };
        return sendJson(res, 200, payload);
      }

      if (method === "GET" && path === "/api/graduations") {
        const input: ListGraduationCandidatesInput = {};
        const p = url.searchParams.get("project_id");
        const s = url.searchParams.get("state");
        const k = url.searchParams.get("k");
        const o = url.searchParams.get("offset");
        if (p) input.project_id = p;
        if (s === "proposed" || s === "composed" || s === "approved" || s === "rejected") {
          input.state = s;
        }
        if (k && !Number.isNaN(Number(k))) input.k = Number(k);
        if (o && !Number.isNaN(Number(o))) input.offset = Number(o);

        const result = await handlers.listGraduationCandidates(input);
        return sendJson(res, 200, result);
      }

      // M8.3 Task 4 — semantic clustering view. level=super returns Super
      // Node graph (one node per supernode, cross-supernode kg_edge weights
      // aggregated); level=drill returns members of one supernode (or a
      // nested community view when the supernode has > 200 members).
      if (method === "GET" && path === "/api/graph/clusters") {
        const projectId = resolveProjectId(url.searchParams.get("project_id"), serverProjectId);
        const level = url.searchParams.get("level") ?? "super";
        try {
          if (level === "super") {
            const payload = await handlers.getClusterGraphSuper(projectId);
            return sendJson(res, payload.ok ? 200 : 500, payload);
          }
          if (level === "drill") {
            const raw = url.searchParams.get("supernode_id");
            const snId = raw === null ? NaN : Number(raw);
            if (!Number.isInteger(snId) || snId < 0) {
              return sendJson(res, 400, {
                ok: false,
                reason: "level=drill requires integer supernode_id >= 0",
              });
            }
            const payload = await handlers.getClusterGraphDrill(projectId, snId);
            return sendJson(res, payload.ok ? 200 : 500, payload);
          }
          return sendJson(res, 400, { ok: false, reason: `unknown level: ${level}` });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 500, { ok: false, reason: msg });
        }
      }

      if (method === "GET" && path === "/api/graph") {
        const projectId = resolveProjectId(url.searchParams.get("project_id"), serverProjectId);
        const nodeLimit = clampInt(
          url.searchParams.get("node_limit"),
          GRAPH_NODE_LIMIT_DEFAULT,
          GRAPH_NODE_LIMIT_MIN,
          GRAPH_NODE_LIMIT_MAX,
        );
        const edgeLimit = clampInt(
          url.searchParams.get("edge_limit"),
          GRAPH_EDGE_LIMIT_DEFAULT,
          GRAPH_EDGE_LIMIT_MIN,
          GRAPH_EDGE_LIMIT_MAX,
        );
        const typeFilter = url.searchParams.get("type");
        const labelPrefix = url.searchParams.get("label_prefix");

        const nodesInput: ListKgNodesInput = { project_id: projectId, k: nodeLimit };
        if (typeFilter && typeFilter.trim().length > 0) nodesInput.type = typeFilter;
        if (labelPrefix && labelPrefix.trim().length > 0) nodesInput.label_prefix = labelPrefix;
        const edgesInput: ListKgEdgesInput = { project_id: projectId, k: edgeLimit };

        try {
          const [nodesRes, edgesRes] = await Promise.all([
            handlers.listKgNodes(nodesInput),
            handlers.listKgEdges(edgesInput),
          ]);

          const nodesPayload = nodesRes as { ok?: boolean; reason?: string; results?: unknown[] };
          if (nodesPayload && nodesPayload.ok === false) {
            return sendJson(res, 500, {
              ok: false,
              reason: String(nodesPayload.reason ?? "list_kg_nodes_failed"),
            });
          }
          const edgesPayload = edgesRes as { ok?: boolean; reason?: string; results?: unknown[] };
          if (edgesPayload && edgesPayload.ok === false) {
            return sendJson(res, 500, {
              ok: false,
              reason: String(edgesPayload.reason ?? "list_kg_edges_failed"),
            });
          }

          const rawNodes = Array.isArray(nodesPayload?.results) ? nodesPayload.results : [];
          const rawEdges = Array.isArray(edgesPayload?.results) ? edgesPayload.results : [];

          const nodeIds = new Set<number>();
          for (const n of rawNodes) {
            const id = (n as { id?: unknown }).id;
            if (typeof id === "number") nodeIds.add(id);
          }
          const filteredEdges = rawEdges.filter((e) => {
            const src = (e as { source_id?: unknown }).source_id;
            const tgt = (e as { target_id?: unknown }).target_id;
            return (
              typeof src === "number" &&
              typeof tgt === "number" &&
              nodeIds.has(src) &&
              nodeIds.has(tgt)
            );
          });

          const typeBreakdown: Record<string, number> = {};
          for (const n of rawNodes) {
            const t = (n as { type?: unknown }).type;
            const key = typeof t === "string" && t.length > 0 ? t : "UNKNOWN";
            typeBreakdown[key] = (typeBreakdown[key] ?? 0) + 1;
          }

          return sendJson(res, 200, {
            ok: true,
            project_id: projectId,
            params: {
              node_limit: nodeLimit,
              edge_limit: edgeLimit,
              type: typeFilter ?? null,
              label_prefix: labelPrefix ?? null,
            },
            nodes: rawNodes,
            edges: filteredEdges,
            stats: {
              node_count: rawNodes.length,
              edge_count: filteredEdges.length,
              type_breakdown: typeBreakdown,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 500, { ok: false, reason: msg });
        }
      }

      const mutMatch = path.match(/^\/api\/graduations\/(\d+)\/(confirm|reject|compose)$/);
      if (method === "POST" && mutMatch) {
        const id = Number(mutMatch[1]);
        const action = mutMatch[2];
        const body = await readJsonBody(req);

        if (action === "confirm") {
          const r = (await handlers.confirmPromotion({ graduation_id: id })) as { ok: boolean };
          return sendJson(res, r.ok ? 200 : 400, r);
        }

        if (action === "reject") {
          const reason = typeof body.reason === "string" ? body.reason : "";
          const r = (await handlers.rejectGraduation({
            graduation_id: id,
            reason,
          })) as { ok: boolean };
          return sendJson(res, r.ok ? 200 : 400, r);
        }

        if (action === "compose") {
          const verdict = body.verdict === "pass" || body.verdict === "fail" ? body.verdict : "fail";
          const evidence = typeof body.evidence === "string" ? body.evidence : "";
          const model = typeof body.model === "string" ? body.model : "";
          const rationale = body.global_rationale == null ? null : String(body.global_rationale);
          const r = (await handlers.composeGlobalRationale({
            graduation_id: id,
            verdict,
            evidence,
            global_rationale: rationale,
            model,
          })) as { ok: boolean };
          return sendJson(res, r.ok ? 200 : 400, r);
        }
      }

      // Phase 1 (Epic F) — Active Backlog drag-drop persistence: PATCH one
      // card's status. Token auth is already enforced above for /api/*; the
      // handler reuses the same helpers + guard as the graduation routes.
      const backlogPatchMatch = path.match(/^\/api\/backlog\/(\d+)$/);
      if (method === "PATCH" && backlogPatchMatch) {
        return handleBacklogPatch(
          req,
          res,
          {
            readJsonBody,
            sendJson,
            isBacklogStatus,
            updateBacklog: handlers.updateBacklog,
            getBacklogRow: handlers.getBacklogRow,
          },
          backlogPatchMatch[1],
        );
      }

      // Static asset fall-through — any non-API GET is served from PUBLIC_DIR
      // (serveStatic 404s if the file is missing or escapes the sandbox).
      if (method === "GET" && !path.startsWith("/api/")) {
        return serveStatic(res, path, serverProjectId);
      }

      sendJson(res, 404, { ok: false, reason: "not_found", path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, reason: "server_error", detail: msg });
    }
  });
}

export interface StartedGuiServer {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  project_id: string;
  close: () => Promise<void>;
}

/**
 * Resolve the listen port with this precedence:
 *   1. Explicit opts.port
 *   2. SCM_GUI_PORT env override
 *   3. Deterministic hash of project_id (universal, per-project, stable)
 *   4. Legacy default 7788 (only when no project_id is wired at all)
 */
function resolveListenPort(opts: GuiServerOptions): number {
  if (typeof opts.port === "number" && Number.isFinite(opts.port)) return opts.port;
  const env = process.env.SCM_GUI_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n)) return n;
  }
  const pid = opts.projectId ?? slugify(currentProjectId);
  if (pid && pid.length > 0) return computeProjectPort(pid);
  return 7788;
}

export async function startGuiServer(opts: GuiServerOptions = {}): Promise<StartedGuiServer> {
  const port = resolveListenPort(opts);
  const host = opts.host ?? process.env.SCM_GUI_HOST ?? "127.0.0.1";
  const resolvedProjectId = opts.projectId ?? slugify(currentProjectId);
  const server = createGuiServer({ ...opts, projectId: resolvedProjectId });
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = (): void => {
      server.off("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(port, host);
  });

  // v2.1.10 EADDRINUSE-safe post-startup error guard. Any error fired AFTER
  // the initial 'listening' handshake must NOT crash the MCP stdio loop —
  // log to stderr and keep serving; the MCP tool surface is independent.
  server.on("error", (err: Error) => {
    try {
      process.stderr.write(`[scm-gui] post-startup error (non-fatal): ${err.message}\n`);
    } catch {
      /* even stderr can fail — never throw */
    }
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    project_id: resolvedProjectId,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function serveStatic(
  res: http.ServerResponse,
  reqPath: string,
  projectId?: string,
): Promise<void> {
  // URI-decode so paths like /style%2Ecss still resolve; fall back to raw
  // path if decoding throws (e.g. malformed percent-encoding).
  let decoded: string;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    decoded = reqPath;
  }

  // Strip leading slashes; "/" → index.html.
  const stripped = decoded.replace(/^\/+/, "");
  const target = stripped.length === 0 ? "index.html" : stripped;

  // Resolve under PUBLIC_DIR and reject anything that escapes via ../ or
  // an absolute path. `path.relative` is the canonical containment check.
  const abs = path.resolve(PUBLIC_DIR, target);
  const rel = path.relative(PUBLIC_DIR, abs);
  if (rel.length > 0 && (rel.startsWith("..") || path.isAbsolute(rel))) {
    return sendJson(res, 404, { ok: false, reason: "not_found", path: reqPath });
  }

  try {
    const buf = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    // v2.1.9 — inject project branding into the dashboard HTML at serve time.
    // Other assets (CSS/JS/fonts/images) pass through untouched.
    if (ext === ".html" && projectId) {
      const html = injectProjectBranding(buf.toString("utf8"), projectId);
      const body = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": body.byteLength,
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": buf.byteLength,
    });
    res.end(buf);
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "ENOENT" || code === "EISDIR") {
      return sendJson(res, 404, { ok: false, reason: "not_found", path: reqPath });
    }
    throw e;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── Standalone entry point ───────────────────────────────────────────────
// Lets `npm run gui` boot the dashboard without the MCP stdio server.
// Useful when an operator wants to curate graduations from a browser with
// the MCP server NOT running (e.g. an offline review pass).
//
// Cross-platform guard: compare both sides as fs paths (resolves spaces /
// drive-letter casing / triple-slash drift between `file:///c:/...` and
// raw `process.argv[1]` on Windows — SCM-S37 regression fix).
const isStandaloneEntry =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1] as string);
if (isStandaloneEntry) {
  startGuiServer({
    token: process.env.SCM_GUI_TOKEN ?? null,
    projectId: slugify(currentProjectId),
  })
    .then((s) => {
      process.stderr.write(
        `[scm-gui] listening on ${s.url} (project: ${s.project_id})\n`,
      );
    })
    .catch((err: Error) => {
      process.stderr.write(`[scm-gui] failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
