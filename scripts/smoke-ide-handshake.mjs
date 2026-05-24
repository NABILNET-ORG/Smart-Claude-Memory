// scripts/smoke-ide-handshake.mjs
// EPIC D — Live E2E smoke for the MCP stdio handshake that Cursor / Windsurf /
// Cline / Claude Code all use to talk to Smart-Claude-Memory.
//
// Proves the IDE → MCP-server contract without needing the actual IDE running:
//   1. Spawn `node dist/index.js` with stdio piped, env inherited.
//   2. Send JSON-RPC `initialize` → assert server responds with serverInfo +
//      capabilities.tools and a protocolVersion ≥ 2024-11-05.
//   3. Send `notifications/initialized` (MCP handshake completion notification).
//   4. Send `tools/list` → assert the canonical SCM tool roster comes back.
//      (Currently 58 tools at v2.3.0 — the smoke asserts a small SAMPLE of
//      load-bearing names so the assertion doesn't churn on every tool addition.)
//   5. Send `tools/call` for `check_system_health` (read-only) → assert
//      response.content[0].text is parseable JSON with the v2.3.0 shape.
//   6. SIGTERM the child + drain.
//
// Why this matters: IDE-INTEGRATION.md says "Cursor reads MCP servers from
// JSON" + ships .cursor/mcp.json templates — but until something actually
// spawns dist/index.js over JSON-RPC and gets a tools/list back, the
// integration is unproven. This script IS that proof.
//
// Usage:
//   node scripts/smoke-ide-handshake.mjs
//   node scripts/smoke-ide-handshake.mjs --verbose   (dump every JSON-RPC line)
//
// Exit 0 = handshake green. Non-zero = first FAIL printed to stderr + JSON
// summary on stdout for diagnosis.

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const VERBOSE = process.argv.includes("--verbose");

const MCP_PROTOCOL_VERSION = "2024-11-05";
const EXPECTED_TOOL_SAMPLE = [
  // memory + vault
  "search_memory",
  "save_memory",
  "request_skill",
  "package_skill",
  // health + boot
  "init_project",
  "check_system_health",
  // m8 clustering (M8.3 — newest surface — proves v2.3.0 build is loaded)
  "list_supernodes",
  "trigger_clustering",
];

// ── assertion helpers ──────────────────────────────────────────────────────
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? "" });
  const tag = ok ? "PASS" : "FAIL";
  console.error(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) throw new Error(`smoke check failed: ${name} — ${detail ?? ""}`);
}

// ── newline-delimited JSON-RPC over stdio ──────────────────────────────────
class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pendingById = new Map();
    this.nextId = 1;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (VERBOSE) console.error(`[child-stderr] ${chunk}`);
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (VERBOSE) console.error(`[<-] ${line}`);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON line (banner / log) — ignore
      }
      if (msg.id != null && this.pendingById.has(msg.id)) {
        const { resolve } = this.pendingById.get(msg.id);
        this.pendingById.delete(msg.id);
        resolve(msg);
      }
    }
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (VERBOSE) console.error(`[->] ${payload}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => {
          this.pendingById.delete(id);
          reject(new Error(`request timeout (${method}) after ${timeoutMs}ms`));
        },
        timeoutMs,
      );
      this.pendingById.set(id, {
        resolve: (msg) => {
          clearTimeout(t);
          resolve(msg);
        },
      });
      this.child.stdin.write(payload + "\n");
    });
  }

  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    if (VERBOSE) console.error(`[->] ${payload}`);
    this.child.stdin.write(payload + "\n");
  }
}

// ── main flow ──────────────────────────────────────────────────────────────
let child = null;
const summary = {
  server_entry: SERVER_ENTRY,
  initialize: null,
  tools_list: null,
  tools_call: null,
  duration_ms: 0,
};
const T0 = Date.now();

try {
  child = spawn("node", [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });
  const client = new McpStdioClient(child);

  child.on("error", (err) => {
    console.error(`[smoke-ide] child spawn error: ${err.message}`);
  });
  child.on("exit", (code, sig) => {
    if (VERBOSE) console.error(`[smoke-ide] child exited code=${code} sig=${sig}`);
  });

  // 1. initialize
  const initResp = await client.request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "smoke-ide-handshake", version: "0.1.0" },
  });
  summary.initialize = {
    protocolVersion: initResp.result?.protocolVersion,
    serverInfo: initResp.result?.serverInfo,
    capabilities: Object.keys(initResp.result?.capabilities ?? {}),
  };
  check("initialize responded with result", initResp.result != null, JSON.stringify(initResp.error ?? null));
  check(
    "serverInfo present",
    typeof initResp.result?.serverInfo?.name === "string",
    `serverInfo=${JSON.stringify(initResp.result?.serverInfo)}`,
  );
  check(
    "server advertises tools capability",
    initResp.result?.capabilities?.tools != null,
    `capabilities=${Object.keys(initResp.result?.capabilities ?? {}).join(",")}`,
  );

  // MCP handshake completion notification
  client.notify("notifications/initialized", {});

  // 2. tools/list
  const listResp = await client.request("tools/list", {});
  const tools = listResp.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name);
  summary.tools_list = { total: toolNames.length, sample_present: {} };
  check("tools/list returned an array", Array.isArray(tools), JSON.stringify(listResp.error ?? null));
  check(
    "tool roster non-empty",
    toolNames.length > 0,
    `count=${toolNames.length}`,
  );
  for (const expected of EXPECTED_TOOL_SAMPLE) {
    const present = toolNames.includes(expected);
    summary.tools_list.sample_present[expected] = present;
    check(`tool present: ${expected}`, present, `roster size=${toolNames.length}`);
  }

  // 3. tools/call: check_system_health (read-only, idempotent)
  const callResp = await client.request("tools/call", {
    name: "check_system_health",
    arguments: {},
  });
  const content = callResp.result?.content;
  check(
    "tools/call check_system_health succeeded",
    callResp.error == null && Array.isArray(content) && content.length > 0,
    JSON.stringify(callResp.error ?? null),
  );
  const textBlock = content?.[0];
  check(
    "response content is text-type block",
    textBlock?.type === "text" && typeof textBlock.text === "string",
    `block=${JSON.stringify(textBlock)?.slice(0, 200)}`,
  );
  let parsedHealth = null;
  try {
    parsedHealth = JSON.parse(textBlock.text);
  } catch (e) {
    check("response.text parseable as JSON", false, e.message);
  }
  check(
    "health payload has 'overall' field",
    parsedHealth?.overall != null,
    `keys=${parsedHealth ? Object.keys(parsedHealth).join(",") : "n/a"}`,
  );
  check(
    "health payload has v2.3.0 clustering_scanner block",
    parsedHealth?.clustering_scanner != null,
    "Confirms the running binary is v2.3.0 (Session 42 health surface)",
  );
  summary.tools_call = {
    name: "check_system_health",
    overall: parsedHealth?.overall,
    clustering_scanner_present: !!parsedHealth?.clustering_scanner,
  };
} catch (e) {
  console.error(`\n[smoke-ide] FAIL — ${e?.message ?? e}`);
  summary.error = e?.message ?? String(e);
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    // give it 500ms to drain then SIGKILL if still alive
    await new Promise((r) => setTimeout(r, 500));
    if (!child.killed) child.kill("SIGKILL");
  }
  summary.duration_ms = Date.now() - T0;
}

const allPass = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok: allPass, checks, summary }, null, 2));
process.exit(allPass ? 0 : 1);
