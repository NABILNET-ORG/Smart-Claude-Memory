#!/usr/bin/env node
// scripts/smoke-epic-e-packaging.mjs
//
// Epic E (Marketplace Packaging) — E2E smoke test.
//
// Pipeline:
//   1. Run `npm pack --json` against the repo root → produces the tarball.
//   2. Extract the .tgz into a fresh temp directory.
//   3. Verify the tarball contains the marketplace-critical artefacts:
//      dist/index.js, hooks/md-policy.py, .claude-plugin/plugin.json,
//      marketplace.json, README.md, LICENSE, CHANGELOG.md, and at least
//      one scripts/*.sql migration file.
//   4. Cross-check the version fields across package.json, plugin.json,
//      and marketplace.json INSIDE the extracted tarball (drift catch).
//   5. Boot the extracted `node dist/index.js` as an MCP stdio server and
//      send a JSON-RPC `initialize` request. Assert a well-formed `result`
//      (serverInfo + capabilities) comes back.
//   6. Send `tools/list` and assert at least one tool is exposed (the
//      tarball must ship a working tool surface — not an empty server).
//   7. Cleanup: kill the child, remove the temp dir, delete the .tgz.
//
// Exit codes: 0 on full pass, 1 on any failed assertion.
//
// Run with: node scripts/smoke-epic-e-packaging.mjs

import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const REQUIRED_PACKED_PATHS = [
  "package/dist/index.js",
  "package/hooks/md-policy.py",
  "package/.claude-plugin/plugin.json",
  "package/marketplace.json",
  "package/README.md",
  "package/LICENSE",
  "package/CHANGELOG.md",
  "package/package.json",
];

let exitCode = 0;
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) exitCode = 1;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- step 1: npm pack
section("Step 1: npm pack --json");
// On Windows, npm resolves to npm.cmd which requires shell: true under
// Node 18+ (security-tightening change). On POSIX, shell:true is harmless.
const packResult = spawnSync("npm", ["pack", "--json"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  shell: true,
});
if (packResult.status !== 0) {
  console.error(`npm pack failed (exit ${packResult.status})`);
  if (packResult.error) console.error(`spawn error: ${packResult.error.message}`);
  if (packResult.stderr) console.error(`stderr: ${packResult.stderr}`);
  if (packResult.stdout) console.error(`stdout: ${packResult.stdout}`);
  process.exit(1);
}

let packMeta;
try {
  packMeta = JSON.parse(packResult.stdout)[0];
} catch (err) {
  console.error("Could not parse npm pack JSON output:", err.message);
  console.error("stdout was:", packResult.stdout.slice(0, 500));
  process.exit(1);
}
const tarballFilename = packMeta.filename;
const tarballPath = join(REPO_ROOT, tarballFilename);
check("npm pack produced tarball", existsSync(tarballPath), tarballFilename);
check("tarball is non-empty", statSync(tarballPath).size > 1024, `${statSync(tarballPath).size} bytes`);
check("tarball reports >0 files", packMeta.files && packMeta.files.length > 0, `files=${packMeta.files?.length ?? 0}`);

// ---------------------------------------------------------------- step 2: extract
section("Step 2: Extract tarball to temp dir");
const tempDir = mkdtempSync(join(tmpdir(), "scm-epic-e-"));
// On Windows, prefer the bundled libarchive tar (C:\Windows\System32\tar.exe).
// MSYS/Cygwin GNU tar mis-parses `C:` paths as remote-host syntax.
const winNativeTar = "C:\\Windows\\System32\\tar.exe";
const tarBin = process.platform === "win32" && existsSync(winNativeTar) ? winNativeTar : "tar";
const extractResult = spawnSync(tarBin, ["-xzf", tarballPath, "-C", tempDir], {
  encoding: "utf8",
  shell: false,
});
if (extractResult.status !== 0) {
  console.error(`tar extract failed (exit ${extractResult.status}) using ${tarBin}`);
  if (extractResult.error) console.error(`spawn error: ${extractResult.error.message}`);
  if (extractResult.stderr) console.error(`stderr: ${extractResult.stderr}`);
  cleanup();
  process.exit(1);
}
check("tar extract succeeded", true, `${tarBin} → ${tempDir}`);

// ---------------------------------------------------------------- step 3: verify contents
section("Step 3: Verify marketplace-critical artefacts in tarball");
for (const rel of REQUIRED_PACKED_PATHS) {
  const abs = join(tempDir, rel);
  check(`contains ${rel}`, existsSync(abs));
}
// At least one SQL migration must ship
const sqlInTarball = (packMeta.files ?? []).filter(f => /^scripts\/.*\.sql$/.test(f.path));
check("ships ≥1 scripts/*.sql migration", sqlInTarball.length > 0, `count=${sqlInTarball.length}`);

// ---------------------------------------------------------------- step 4: version drift catch
section("Step 4: Cross-check version fields inside tarball");
let pkgVer, pluginVer, mktVer;
try {
  pkgVer = JSON.parse(readFileSync(join(tempDir, "package/package.json"), "utf8")).version;
  pluginVer = JSON.parse(readFileSync(join(tempDir, "package/.claude-plugin/plugin.json"), "utf8")).version;
  mktVer = JSON.parse(readFileSync(join(tempDir, "package/marketplace.json"), "utf8")).version;
} catch (err) {
  check("version files parse as JSON", false, err.message);
}
check(`package.json version present`, typeof pkgVer === "string", pkgVer);
check(`plugin.json version matches package.json`, pluginVer === pkgVer, `plugin=${pluginVer} pkg=${pkgVer}`);
check(`marketplace.json version matches package.json`, mktVer === pkgVer, `mkt=${mktVer} pkg=${pkgVer}`);

// ---------------------------------------------------------------- step 5+6: boot + handshake
section("Step 5: Boot extracted dist/index.js and complete MCP handshake");

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: res } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        res(msg);
      }
    }
  }
  request(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`Timeout waiting for ${method} response (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(t);
          res(msg);
        },
      });
      this.child.stdin.write(payload + "\n");
    });
  }
  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(payload + "\n");
  }
}

const serverEntry = join(tempDir, "package", "dist", "index.js");
const child = spawn("node", [serverEntry], {
  cwd: join(tempDir, "package"),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SCM_SMOKE_DISABLE_AUTO_OPEN: "1" },
});

let childExited = false;
let childExitCode = null;
let stderrBuf = "";
child.stderr.on("data", (c) => { stderrBuf += c.toString(); });
child.on("exit", (code) => { childExited = true; childExitCode = code; });
child.on("error", (err) => {
  console.error(`Child spawn error: ${err.message}`);
});

const client = new StdioClient(child);

try {
  const initResp = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "smoke-epic-e-packaging", version: "1.0.0" },
    capabilities: {},
  }, 15000);

  check("initialize: server responded", initResp != null);
  check("initialize: has result (no error)", initResp.result != null, initResp.error ? JSON.stringify(initResp.error) : "");
  check("initialize: protocolVersion present", typeof initResp.result?.protocolVersion === "string", initResp.result?.protocolVersion);
  check("initialize: serverInfo.name present", typeof initResp.result?.serverInfo?.name === "string", initResp.result?.serverInfo?.name);
  check("initialize: capabilities present", initResp.result?.capabilities != null);

  // Complete handshake per MCP spec
  client.notify("notifications/initialized", {});

  // ---------------------------------------------------------------- step 6: tools/list
  section("Step 6: tools/list — server exposes a non-empty surface");
  const toolsResp = await client.request("tools/list", {}, 15000);
  check("tools/list: server responded", toolsResp != null);
  check("tools/list: has result (no error)", toolsResp.result != null, toolsResp.error ? JSON.stringify(toolsResp.error) : "");
  const toolCount = Array.isArray(toolsResp.result?.tools) ? toolsResp.result.tools.length : 0;
  check("tools/list: exposes ≥1 tool", toolCount > 0, `count=${toolCount}`);
  // Spot-check a flagship tool is present
  const toolNames = (toolsResp.result?.tools ?? []).map(t => t.name);
  check("tools/list: includes init_project", toolNames.includes("init_project"), `sample: ${toolNames.slice(0, 5).join(", ")}`);
} catch (err) {
  check("MCP handshake completed without throwing", false, err.message);
  if (stderrBuf) {
    console.error("--- server stderr tail ---");
    console.error(stderrBuf.split("\n").slice(-15).join("\n"));
  }
}

// ---------------------------------------------------------------- cleanup
function cleanup() {
  try {
    if (!childExited && child && !child.killed) {
      child.kill();
    }
  } catch {}
  try {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Could not remove temp dir ${tempDir}: ${err.message}`);
  }
  try {
    if (existsSync(tarballPath)) rmSync(tarballPath);
  } catch (err) {
    console.warn(`Could not remove tarball ${tarballPath}: ${err.message}`);
  }
}

section("Cleanup");
cleanup();
check("temp dir removed", !existsSync(tempDir));
check("tarball removed", !existsSync(tarballPath));

// ---------------------------------------------------------------- summary
section("Summary");
const passed = checks.filter(c => c.ok).length;
const failed = checks.filter(c => !c.ok).length;
console.log(`Total: ${checks.length}  Passed: ${passed}  Failed: ${failed}`);
console.log(`Server exit code on cleanup: ${childExitCode ?? "still-running-killed"}`);
process.exit(exitCode);
