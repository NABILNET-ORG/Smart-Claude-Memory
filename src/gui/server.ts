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
//   GET  /api/graduations[?project_id=&state=&k=&offset=]
//                                           — listGraduationCandidates
//   POST /api/graduations/:id/compose       — composeGlobalRationale
//   POST /api/graduations/:id/confirm       — confirmPromotion
//   POST /api/graduations/:id/reject        — rejectGraduation

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
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
// SCM-S39-D1 (v2.2.2): /api/budget surface.
import {
  getDaemonBudget as defaultGetDaemonBudget,
  getTaskBudget as defaultGetTaskBudget,
} from "../tools/budget.js";

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

export type GuiHandlers = {
  listGraduationCandidates: (input: ListGraduationCandidatesInput) => Promise<unknown>;
  composeGlobalRationale: (input: ComposeGlobalRationaleInput) => Promise<unknown>;
  confirmPromotion: (input: ConfirmPromotionInput) => Promise<unknown>;
  rejectGraduation: (input: RejectGraduationInput) => Promise<unknown>;
  listKgNodes: (input: ListKgNodesInput) => Promise<unknown>;
  listKgEdges: (input: ListKgEdgesInput) => Promise<unknown>;
};

const DEFAULT_HANDLERS: GuiHandlers = {
  listGraduationCandidates: defaultList,
  composeGlobalRationale: defaultCompose,
  confirmPromotion: defaultConfirm,
  rejectGraduation: defaultReject,
  listKgNodes: defaultListKgNodes,
  listKgEdges: defaultListKgEdges,
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

function resolveProjectId(raw: string | null): string {
  if (raw && raw.trim().length > 0) return raw;
  const env = process.env.SMART_CLAUDE_MEMORY_PROJECT_ID;
  if (env && env.trim().length > 0) return env;
  return "claude-memory";
}

export interface GuiServerOptions {
  port?: number;
  host?: string;
  token?: string | null;
  handlers?: GuiHandlers;
}

export function createGuiServer(opts: GuiServerOptions = {}): http.Server {
  const handlers = opts.handlers ?? DEFAULT_HANDLERS;
  const token = opts.token ?? null;

  return http.createServer(async (req, res) => {
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
        return serveStatic(res, "/index.html");
      }

      if (method === "GET" && path === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "scm-gui",
          version: GUI_VERSION,
        });
      }

      // SCM-S39-D1: Agentic Resource Manager surface for the GUI ticker.
      // Always returns the daemon-budget current-hour rollup; if task_id is
      // passed, also returns that task's burn state.
      if (method === "GET" && path === "/api/budget") {
        const taskId = url.searchParams.get("task_id");
        const daemons = await defaultGetDaemonBudget({});
        let task: unknown = null;
        if (taskId && taskId.trim().length > 0) {
          task = await defaultGetTaskBudget({ task_id: taskId.trim() });
        }
        return sendJson(res, 200, { ok: true, mode: daemons.mode, daemons: daemons.rows, task });
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

      if (method === "GET" && path === "/api/graph") {
        const projectId = resolveProjectId(url.searchParams.get("project_id"));
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

      // Static asset fall-through — any GET that didn't match an API route
      // is attempted as a file from PUBLIC_DIR. serveStatic itself 404s if
      // the file is missing or escapes the public sandbox.
      if (method === "GET" && !path.startsWith("/api/")) {
        return serveStatic(res, path);
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
  close: () => Promise<void>;
}

export async function startGuiServer(opts: GuiServerOptions = {}): Promise<StartedGuiServer> {
  const port = opts.port ?? Number(process.env.SCM_GUI_PORT ?? "7788");
  const host = opts.host ?? process.env.SCM_GUI_HOST ?? "127.0.0.1";
  const server = createGuiServer(opts);
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
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
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
  })
    .then((s) => {
      process.stderr.write(`[scm-gui] listening on ${s.url}\n`);
    })
    .catch((err: Error) => {
      process.stderr.write(`[scm-gui] failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
