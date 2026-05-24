// scripts/smoke-m1-jit.mjs
// M1 / EPIC C — Live E2E smoke for the JIT Skill Vault loop.
//
// Proves the end-to-end path:
//   package_skill(desc, steps)              → Ollama embed → INSERT agent_skills
//      ↓
//   request_skill(query, k, min_similarity) → Ollama embed query → SQL ranking
//                                            (cosine 0.85 + recency 0.15)
//                                          → returns verbatim steps + telemetry bump
//
// Why a mock Ollama? The live host's Ollama daemon is offline in this
// environment (check_system_health.ollama.status = "down"). Rather than
// stub the call sites (which would skip the contract surface this smoke
// is meant to verify), the script binds a tiny HTTP mock to 127.0.0.1:11434
// for its lifetime. The mock:
//   • Returns deterministic 768-dim unit vectors seeded by a 64-bit hash
//     of the input string. Same text → same embedding → cosine 1.0.
//     Different text → unrelated vectors → low similarity.
//   • Lets us prove the FULL contract end-to-end (embed → upsert → embed
//     query → SQL rank → steps verbatim → telemetry bump) without depending
//     on the host's Ollama daemon being up.
//
// Safety: every read AND write is scoped to FIXTURE_PROJECT_ID. A finally
// block deletes the fixture rows even on mid-flight failure. NEVER touches
// the production `claude-memory` skills.
//
// Usage:
//   node scripts/smoke-m1-jit.mjs           (full E2E with mock embed)
//   node scripts/smoke-m1-jit.mjs --keep    (skip cleanup for inspection)
//   node scripts/smoke-m1-jit.mjs --real    (use real Ollama; FAILS if down)

import "dotenv/config";
import http from "node:http";

const FIXTURE_PROJECT_ID = "smoke-m1-jit-temp";
const EMBED_DIM = 768;
const MOCK_PORT = 11434;
const KEEP_FIXTURE = process.argv.includes("--keep");
const USE_REAL_OLLAMA = process.argv.includes("--real");

// ── deterministic embed: FNV-1a 64-bit → mulberry32 → unit vector ──────────
function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return Number(h & 0xffffffffn) >>> 0; // 32-bit folded for mulberry32 seed
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockEmbed(text) {
  const rng = mulberry32(fnv1a64(text));
  const v = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    // Box-Muller draw → broad coverage of unit sphere
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

// ── tiny assertion helpers ─────────────────────────────────────────────────
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? "" });
  const tag = ok ? "PASS" : "FAIL";
  console.error(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) throw new Error(`smoke check failed: ${name} — ${detail ?? ""}`);
}

// ── mock Ollama HTTP server ────────────────────────────────────────────────
function startMockOllama() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/embed") {
          try {
            const { input } = JSON.parse(body || "{}");
            const inputs = Array.isArray(input) ? input : [String(input ?? "")];
            const embeddings = inputs.map((s) => mockEmbed(String(s)));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ embeddings }));
            return;
          } catch (e) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e?.message ?? String(e) }));
            return;
          }
        }
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "nomic-embed-text:smoke" }] }));
          return;
        }
        res.writeHead(404).end("not found");
      });
    });
    server.once("error", reject);
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── decide embed strategy + import dist modules AFTER env is set ───────────
let mockServer = null;
if (!USE_REAL_OLLAMA) {
  // Override OLLAMA_HOST BEFORE config.js is imported (it freezes at first read).
  process.env.OLLAMA_HOST = `http://127.0.0.1:${MOCK_PORT}`;
  mockServer = await startMockOllama();
  console.error(`[smoke-m1] mock Ollama up on http://127.0.0.1:${MOCK_PORT}`);
}

const { supabase } = await import("../dist/supabase.js");
const { packageSkill, requestSkill } = await import("../dist/tools/skills.js");

let summary = {
  fixture_project_id: FIXTURE_PROJECT_ID,
  mock_ollama: !USE_REAL_OLLAMA,
  packaged: [],
  retrieved: null,
  retrieved_unrelated: null,
  telemetry_bump: null,
  versioning: null,
  duration_ms: 0,
  cleanup: null,
};

const T0 = Date.now();

async function deleteFixtureRows(reason) {
  const out = {};
  for (const table of ["agent_skills"]) {
    try {
      const { error, count } = await supabase
        .from(table)
        .delete({ count: "exact" })
        .eq("project_id", FIXTURE_PROJECT_ID);
      out[table] = error ? `ERR ${error.message}` : `del ${count ?? "?"}`;
    } catch (e) {
      out[table] = `THREW ${e?.message ?? e}`;
    }
  }
  return { reason, tables: out };
}

try {
  // ── 0. Pre-flight cleanup ───────────────────────────────────────────────
  summary.cleanup = { pre: await deleteFixtureRows("pre-flight") };

  // ── 1. Package two skills with distinct trigger semantics ───────────────
  // Same FNV → same embedding → cosine 1.0 on exact match query.
  // Different FNV → near-orthogonal random unit vectors → low cross-talk.
  const skillA = await packageSkill({
    project_id: FIXTURE_PROJECT_ID,
    name: "smoke_git_commit",
    description: "git_commit_workflow",
    steps: [
      { step: "git add <files>" },
      { step: "git commit -m '<msg>'" },
      { step: "git push origin <branch>" },
    ],
    trigger_keywords: ["git", "commit"],
  });
  check(
    "package_skill A persisted (id + version returned)",
    typeof skillA.id === "number" && Number(skillA.version) >= 1,
    JSON.stringify(skillA),
  );
  summary.packaged.push({ name: "smoke_git_commit", result: skillA });

  const skillB = await packageSkill({
    project_id: FIXTURE_PROJECT_ID,
    name: "smoke_pr_open",
    description: "pr_creation_workflow",
    steps: [
      { step: "gh pr create --title X" },
      { step: "gh pr view --web" },
    ],
    trigger_keywords: ["pr", "pull-request"],
  });
  check(
    "package_skill B persisted",
    typeof skillB.id === "number" && Number(skillB.version) >= 1,
    JSON.stringify(skillB),
  );
  summary.packaged.push({ name: "smoke_pr_open", result: skillB });

  // ── 2. Retrieve via natural-language query — exact-text match ───────────
  // Query string exactly equals skill A's description → cosine 1.0 vs A.
  const r1 = await requestSkill({
    project_id: FIXTURE_PROJECT_ID,
    query: "git_commit_workflow",
    k: 3,
    min_similarity: 0.0,
    include_global: false,
  });
  summary.retrieved = {
    query: r1.query,
    count: r1.count,
    top: r1.skills?.[0]
      ? { name: r1.skills[0].name, similarity: r1.skills[0].similarity }
      : null,
  };
  check("request_skill returns >= 1 hit", (r1.count ?? 0) >= 1, `count=${r1.count}`);
  check(
    "top hit is skill A (highest cosine)",
    r1.skills?.[0]?.name === "smoke_git_commit",
    `top=${r1.skills?.[0]?.name}`,
  );
  check(
    "top similarity ≈ 1.0 on exact-text query",
    r1.skills?.[0]?.similarity != null && r1.skills[0].similarity > 0.999,
    `sim=${r1.skills?.[0]?.similarity}`,
  );
  check(
    "JIT injection — steps payload is array, returned verbatim",
    Array.isArray(r1.skills?.[0]?.steps) && r1.skills[0].steps.length === 3,
    `len=${r1.skills?.[0]?.steps?.length}`,
  );
  check(
    "rank_score is a number (cosine 0.85 + recency 0.15 blend)",
    typeof r1.skills?.[0]?.rank_score === "number",
    `rank_score=${r1.skills?.[0]?.rank_score}`,
  );

  // ── 3. Retrieve via unrelated query — assert skill A doesn't dominate ──
  const r2 = await requestSkill({
    project_id: FIXTURE_PROJECT_ID,
    query: "pr_creation_workflow",
    k: 3,
    min_similarity: 0.0,
    include_global: false,
  });
  summary.retrieved_unrelated = {
    query: r2.query,
    count: r2.count,
    top: r2.skills?.[0]
      ? { name: r2.skills[0].name, similarity: r2.skills[0].similarity }
      : null,
  };
  check("unrelated query returns >= 1 hit", (r2.count ?? 0) >= 1, `count=${r2.count}`);
  check(
    "unrelated top hit is skill B (ranking differentiates)",
    r2.skills?.[0]?.name === "smoke_pr_open",
    `top=${r2.skills?.[0]?.name}`,
  );

  // ── 4. Telemetry bump — frequency_used increments on hit ────────────────
  // request_skill schedules the bump fire-and-forget; poll briefly for it.
  let bumped = null;
  for (let i = 0; i < 20; i++) {
    const { data } = await supabase
      .from("agent_skills")
      .select("name, frequency_used, last_invoked_at")
      .eq("project_id", FIXTURE_PROJECT_ID)
      .eq("name", "smoke_git_commit")
      .single();
    if (data && Number(data.frequency_used) >= 1) {
      bumped = data;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  summary.telemetry_bump = bumped;
  check("telemetry bump observed", bumped != null, "frequency_used never reached >=1");
  check(
    "frequency_used >= 1 after one retrieve",
    bumped && Number(bumped.frequency_used) >= 1,
    `frequency_used=${bumped?.frequency_used}`,
  );
  check(
    "last_invoked_at populated",
    bumped && typeof bumped.last_invoked_at === "string" && bumped.last_invoked_at.length > 0,
    `last_invoked_at=${bumped?.last_invoked_at}`,
  );

  // ── 5. Versioning — re-package same name bumps version, preserves telemetry
  const skillAv2 = await packageSkill({
    project_id: FIXTURE_PROJECT_ID,
    name: "smoke_git_commit",
    description: "git_commit_workflow_v2_with_signing",
    steps: [
      { step: "git add <files>" },
      { step: "git commit -S -m '<msg>'" }, // added signing
      { step: "git push origin <branch>" },
    ],
    trigger_keywords: ["git", "commit", "signing"],
  });
  check(
    "package_skill re-package persisted",
    typeof skillAv2.id === "number" && Number(skillAv2.version) >= 2,
    JSON.stringify(skillAv2),
  );
  const { data: postRow } = await supabase
    .from("agent_skills")
    .select("name, version, frequency_used")
    .eq("project_id", FIXTURE_PROJECT_ID)
    .eq("name", "smoke_git_commit")
    .single();
  summary.versioning = postRow;
  check(
    "version bumped on re-package",
    postRow && Number(postRow.version) >= 2,
    `version=${postRow?.version}`,
  );
  check(
    "telemetry (frequency_used) preserved across version bump",
    postRow && Number(postRow.frequency_used) >= 1,
    `frequency_used=${postRow?.frequency_used}`,
  );
} catch (e) {
  console.error(`\n[smoke-m1] FAIL — ${e?.message ?? e}`);
  summary.error = e?.message ?? String(e);
} finally {
  if (KEEP_FIXTURE) {
    console.error("[smoke-m1] --keep flag set — leaving fixture rows in place");
    summary.cleanup = { ...(summary.cleanup ?? {}), post: { skipped: "--keep" } };
  } else {
    summary.cleanup = { ...(summary.cleanup ?? {}), post: await deleteFixtureRows("post-run") };
  }
  if (mockServer) {
    await new Promise((r) => mockServer.close(() => r()));
  }
  summary.duration_ms = Date.now() - T0;
}

const allPass = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok: allPass, checks, summary }, null, 2));
process.exit(allPass ? 0 : 1);
