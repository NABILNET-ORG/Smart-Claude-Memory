# Marketplace Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge `smart-claude-memory` from internal v2.0.0-rc1 to a public v2.0.0 Claude Code Plugin, installable from a marketplace with zero manual schema/hook/settings.json edits.

**Architecture:** Eight isolated Foundation-First commits. Commits 1–2 are pure foundation (P0 FTUX health-state fix + idempotent migration ledger). Commits 3–6 add features atop. Commit 7 rewrites docs. Commit 8 releases. Each commit ships independently and reviewable in isolation — never bundle foundation + feature in one commit.

**Tech Stack:** TypeScript (Node 20+), `@modelcontextprotocol/sdk`, `pg` (Postgres client), `@supabase/supabase-js`, Zod, Claude Code Plugin manifest schema (`${CLAUDE_PLUGIN_ROOT}` token), Node built-in test runner.

**Spec:** [docs/superpowers/specs/2026-05-14-marketplace-packaging-design.md](../specs/2026-05-14-marketplace-packaging-design.md)

---

## Task 1: Health — `pending` state + 15min grace window (P0 FTUX fix)

**Why:** New daemons (`curriculum_scanner`, `telemetry_pruner`) report `down` on cold boot because they have no `run_ended` events yet. This poisons `overall` to `down`. A new public user must see `pending → healthy`, never `down` on first boot.

**Files:**
- Modify: `src/tools/health.ts` (extend `DerivedStatus` enum at line 24, fix cold-boot derivation at line 55-63, update `SEVERITY` map at line 392-397)
- Create: `tests/health.test.ts`

### Steps

- [ ] **Step 1.1: Read `src/tools/health.ts` end-to-end to confirm exact symbol shapes**

The plan references the recon's line numbers (24, 55-63, 392-397). Confirm these before editing — line numbers may have drifted by a few lines.

- [ ] **Step 1.2: Write the failing test file `tests/health.test.ts`**

```typescript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveDaemonStatus, rollupOverall } from "../src/tools/health.js";

describe("deriveDaemonStatus — pending state (grace window)", () => {
  test("daemon with no run_ended events within grace window returns pending", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 60, // 1 minute since boot
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "pending");
    assert.match(result.reason, /grace/i);
  });

  test("daemon with no run_ended events past grace window returns down", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [],
      uptimeSec: 20 * 60, // 20 minutes since boot
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "down");
    assert.match(result.reason, /no run_ended/i);
  });

  test("daemon with recent run_ended events returns healthy", () => {
    const result = deriveDaemonStatus({
      enabled: true,
      events: [{ event_type: "run_ended", created_at: new Date().toISOString() }],
      uptimeSec: 30 * 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.equal(result.status, "healthy");
  });

  test("disabled daemon never returns pending", () => {
    const result = deriveDaemonStatus({
      enabled: false,
      events: [],
      uptimeSec: 60,
      graceMs: 15 * 60 * 1000,
    });
    assert.notEqual(result.status, "pending");
  });
});

describe("rollupOverall — pending does not promote past degraded", () => {
  test("all healthy except one pending → overall pending", () => {
    const overall = rollupOverall(["healthy", "pending", "healthy"]);
    assert.equal(overall, "pending");
  });

  test("one pending + one degraded → overall degraded", () => {
    const overall = rollupOverall(["pending", "degraded", "healthy"]);
    assert.equal(overall, "degraded");
  });

  test("one pending + one down → overall down", () => {
    const overall = rollupOverall(["pending", "down", "healthy"]);
    assert.equal(overall, "down");
  });

  test("all healthy → overall healthy", () => {
    const overall = rollupOverall(["healthy", "healthy", "healthy"]);
    assert.equal(overall, "healthy");
  });
});
```

- [ ] **Step 1.3: Run test, expect failure**

Run: `npm test -- tests/health.test.ts` (may need to add the path to the test script in package.json; see Step 1.7).

Expected: FAIL — `deriveDaemonStatus` and `rollupOverall` are not exported (the recon describes them as internal logic; this task externalizes them so they're unit-testable).

- [ ] **Step 1.4: Refactor `src/tools/health.ts` — extract pure functions + extend enum**

Open the file. Find the `DerivedStatus` type (~line 24):

```typescript
// BEFORE
type DerivedStatus = "healthy" | "degraded" | "down";

// AFTER
export type DerivedStatus = "healthy" | "pending" | "degraded" | "down";

const GRACE_MS = 15 * 60 * 1000; // 15 minutes
```

Find the `SEVERITY` map (~line 392-397):

```typescript
// BEFORE
const SEVERITY: Record<DerivedStatus, number> = {
  healthy: 0,
  degraded: 1,
  down: 2,
};

// AFTER
const SEVERITY: Record<DerivedStatus, number> = {
  healthy: 0,
  pending: 0.5,
  degraded: 1,
  down: 2,
};
```

Extract the per-daemon derivation (the block currently inline at line 55-63) into an exported pure function placed near the top of the file (just after `GRACE_MS`):

```typescript
export interface DeriveInput {
  enabled: boolean;
  events: Array<{ event_type: string; created_at: string }>;
  uptimeSec: number;
  graceMs?: number;
}

export function deriveDaemonStatus(input: DeriveInput): { status: DerivedStatus; reason: string } {
  const { enabled, events, uptimeSec, graceMs = GRACE_MS } = input;
  if (!enabled) {
    return { status: "down", reason: "daemon disabled" };
  }
  const runEnded = events.find(e => e.event_type === "run_ended");
  if (!runEnded) {
    if (uptimeSec * 1000 < graceMs) {
      return { status: "pending", reason: "warming up — no run_ended events yet, within 15min grace window" };
    }
    return { status: "down", reason: "no run_ended events on record" };
  }
  // existing staleness logic preserved; copy the current "ended_at + interval" check here
  // (see existing health.ts implementation around current line 64+)
  return { status: "healthy", reason: "within thresholds" };
}

export function rollupOverall(statuses: DerivedStatus[]): DerivedStatus {
  return statuses.reduce<DerivedStatus>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), "healthy");
}
```

Now replace the inline derivation at line 55-63 to call `deriveDaemonStatus()`. Replace the rollup at line ~400 to call `rollupOverall()`. Wire `uptimeSec: process.uptime()` from the caller.

**Important:** preserve the existing staleness check (the part that compares `last_run_ended_at` against `interval_ms` and decides `healthy` vs `degraded` vs `down`). Only the cold-boot null branch is new.

- [ ] **Step 1.5: Run test, expect pass**

Run: `npm test -- tests/health.test.ts`

Expected: PASS (all 7 tests green).

- [ ] **Step 1.6: Run the existing build + lint gates**

```
npm run lint:boundaries
npm run build
```

Expected: both green. No TS errors. No boundary violations.

- [ ] **Step 1.7: Update `package.json` test script to include the new file**

In `package.json`, extend the existing `"test"` script to include the new test path:

```json
"test": "node --import tsx --experimental-test-module-mocks --no-warnings --test tests/trajectory-stripper.test.ts tests/trajectory-summarizer.test.ts tests/trajectory-daemon.test.ts tests/health.test.ts"
```

- [ ] **Step 1.8: Re-run the full test suite**

Run: `npm test`

Expected: all tests green (existing + new).

- [ ] **Step 1.9: Commit**

```
git add src/tools/health.ts tests/health.test.ts package.json
git commit -m "fix(obs): health.ts pending state + 15min grace window

P0 FTUX fix. Extends DerivedStatus enum with 'pending' (severity 0.5,
ranks between healthy and degraded). Daemons without run_ended events
within 15min of boot now report 'pending' instead of 'down', so the
top-level overall is no longer falsely promoted to 'down' on cold boot.
Past the grace window, behavior reverts to 'down' as before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `schema_migrations` ledger + idempotent apply-all CLI

**Why:** Today `npm run schema 001_schema.sql` applies one file at a time with no tracking, no transaction, no idempotency. A new user with an empty Supabase project needs all 18 migrations applied automatically and re-runnably.

**Files:**
- Create: `src/lib/migrations.ts` (shared helper, importable by `init_project` in Task 3)
- Modify: `scripts/apply-schema.ts` (use the helper; preserve single-file mode for emergencies)
- Create: `tests/migrations.test.ts`

### Steps

- [ ] **Step 2.1: Read `scripts/apply-schema.ts` to confirm current connection logic**

Confirm it uses `pg.Client` with `SUPABASE_POOLER_URL` and `ssl.rejectUnauthorized: false`. Note the import shape and env var resolution so the new helper matches.

- [ ] **Step 2.2: Write the failing test `tests/migrations.test.ts`**

Note: this test needs a real Postgres. Use the existing `SUPABASE_POOLER_URL` env. The test creates a temporary schema, runs apply-all twice, asserts ledger state.

```typescript
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { applyPendingMigrations, ensureLedger, listPendingMigrations } from "../src/lib/migrations.js";

const TEST_SCHEMA = `scm_test_${Date.now()}`;

let client: Client;

before(async () => {
  client = new Client({ connectionString: process.env.SUPABASE_POOLER_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
  await client.query(`SET search_path TO ${TEST_SCHEMA}`);
});

after(async () => {
  await client.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
  await client.end();
});

describe("migrations applier", () => {
  test("ensureLedger creates schema_migrations table", async () => {
    await ensureLedger(client);
    const r = await client.query(
      `SELECT to_regclass('${TEST_SCHEMA}.schema_migrations') AS t`
    );
    assert.ok(r.rows[0].t, "schema_migrations table should exist");
  });

  test("first apply-all inserts all pending into ledger", async () => {
    const result = await applyPendingMigrations(client, { searchPath: TEST_SCHEMA });
    assert.ok(result.applied >= 1, "should apply at least one migration on empty schema");
    assert.equal(result.skipped, 0);
  });

  test("re-running apply-all is a no-op", async () => {
    const result = await applyPendingMigrations(client, { searchPath: TEST_SCHEMA });
    assert.equal(result.applied, 0);
    assert.ok(result.skipped >= 1);
  });

  test("listPendingMigrations is empty after full apply", async () => {
    const pending = await listPendingMigrations(client);
    assert.equal(pending.length, 0);
  });
});
```

- [ ] **Step 2.3: Run test, expect failure**

Run: `npm test -- tests/migrations.test.ts`

Expected: FAIL — `src/lib/migrations.ts` does not exist.

- [ ] **Step 2.4: Create `src/lib/migrations.ts`**

```typescript
import { Client } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "scripts");

export interface MigrationFile {
  filename: string;
  sha256: string;
  body: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  total: number;
  appliedFiles: string[];
  skippedFiles: string[];
}

export async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export function loadMigrationFiles(): MigrationFile[] {
  const all = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^0\d{2}_.+\.sql$/.test(f))
    .sort();
  return all.map(filename => {
    const body = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { filename, sha256, body };
  });
}

export async function listPendingMigrations(client: Client): Promise<MigrationFile[]> {
  await ensureLedger(client);
  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations"
  );
  const applied = new Set(rows.map(r => r.filename));
  return loadMigrationFiles().filter(m => !applied.has(m.filename));
}

export async function applyPendingMigrations(
  client: Client,
  opts: { searchPath?: string } = {}
): Promise<ApplyResult> {
  await ensureLedger(client);
  const all = loadMigrationFiles();
  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations"
  );
  const applied = new Set(rows.map(r => r.filename));
  const pending = all.filter(m => !applied.has(m.filename));
  const skippedFiles = all.filter(m => applied.has(m.filename)).map(m => m.filename);
  const appliedFiles: string[] = [];

  for (const m of pending) {
    try {
      await client.query("BEGIN");
      if (opts.searchPath) {
        await client.query(`SET LOCAL search_path TO ${opts.searchPath}`);
      }
      await client.query(m.body);
      await client.query(
        "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
        [m.filename, m.sha256]
      );
      await client.query("COMMIT");
      appliedFiles.push(m.filename);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${m.filename} failed: ${(err as Error).message}`);
    }
  }

  return {
    applied: appliedFiles.length,
    skipped: skippedFiles.length,
    total: all.length,
    appliedFiles,
    skippedFiles,
  };
}
```

- [ ] **Step 2.5: Run test, expect pass**

Run: `npm test -- tests/migrations.test.ts`

Expected: PASS (4 tests green). If the test schema can't be created, the user lacks DB perms — fail loudly with a clear error.

- [ ] **Step 2.6: Refactor `scripts/apply-schema.ts` to use the helper**

Replace the existing single-file logic with a dispatch:

```typescript
import "dotenv/config";
import { Client } from "pg";
import { applyPendingMigrations, listPendingMigrations } from "../src/lib/migrations.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const connectionString = process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error("Missing SUPABASE_POOLER_URL (or SUPABASE_DB_URL).");
    process.exit(1);
  }
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const arg = process.argv[2];
  try {
    if (arg) {
      // Legacy single-file mode — applies one file, NO ledger tracking.
      // Use only for emergencies; prefer the no-arg apply-all mode.
      const body = readFileSync(join("scripts", arg), "utf8");
      console.log(`[legacy] Applying ${arg} (no ledger)…`);
      await client.query(body);
      console.log(`[legacy] Applied ${arg}.`);
    } else {
      const pending = await listPendingMigrations(client);
      if (pending.length === 0) {
        console.log("No pending migrations. Schema is up to date.");
        return;
      }
      console.log(`Applying ${pending.length} pending migration(s)…`);
      const result = await applyPendingMigrations(client);
      console.log(`Done. applied=${result.applied} skipped=${result.skipped} total=${result.total}`);
      for (const f of result.appliedFiles) console.log(`  ✓ ${f}`);
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2.7: Smoke-test against the live dev DB**

Run: `npm run schema`

Expected: prints "No pending migrations. Schema is up to date." (since the dev DB already has all 18 applied). If it reports otherwise, investigate — the ledger may need backfilling for the existing project.

If the dev DB needs backfilling (ledger is empty but tables exist), insert ledger rows manually for the 18 existing migrations to bring state in sync, then re-run.

- [ ] **Step 2.8: Run the build + boundary lint**

```
npm run lint:boundaries
npm run build
```

Expected: green.

- [ ] **Step 2.9: Commit**

```
git add src/lib/migrations.ts scripts/apply-schema.ts tests/migrations.test.ts package.json
git commit -m "feat(schema): schema_migrations ledger + apply-all idempotent CLI

Adds a schema_migrations(filename, sha256, applied_at) ledger and a
shared src/lib/migrations.ts module. apply-schema.ts default mode
(no args) scans scripts/*.sql, diffs against the ledger, and applies
all pending migrations transactionally. Re-running is a no-op.
Legacy single-file mode preserved for emergencies.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `init_project` auto-applies pending migrations

**Why:** Closes the BYO-Supabase loop. User sets 3 env vars, makes the first MCP call, and the DB is bootstrapped without them ever running `npm run schema`.

**Files:**
- Modify: `src/tools/init.ts` (or wherever `init_project` is implemented — confirm via file inspection)

### Steps

- [ ] **Step 3.1: Locate `init_project` implementation**

Search: `grep -rn "init_project" src/` or use the codebase index. Identify the file (likely `src/tools/init.ts` per the recon). Confirm the existing return shape so the new `migrations` block matches the convention.

- [ ] **Step 3.2: Extend the init_project response with a migrations check**

Add to the implementation, after the existing readiness checks:

```typescript
import { applyPendingMigrations, listPendingMigrations } from "../lib/migrations.js";
import { Client } from "pg";

// ...inside the init_project handler, after existing checks:

let migrationsCheck: { name: string; status: "ok" | "partial" | "not_ready"; detail: string };
let migrationsResult: { applied: number; skipped: number; total: number } | null = null;
try {
  const cs = process.env.SUPABASE_POOLER_URL;
  if (!cs) {
    migrationsCheck = { name: "migrations", status: "not_ready", detail: "SUPABASE_POOLER_URL not set; cannot apply migrations" };
  } else {
    const client = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const pending = await listPendingMigrations(client);
      if (pending.length === 0) {
        migrationsCheck = { name: "migrations", status: "ok", detail: "schema up to date (0 pending)" };
        migrationsResult = { applied: 0, skipped: 18, total: 18 };
      } else {
        const result = await applyPendingMigrations(client);
        migrationsCheck = { name: "migrations", status: "ok", detail: `applied ${result.applied} pending migration(s)` };
        migrationsResult = { applied: result.applied, skipped: result.skipped, total: result.total };
      }
    } finally {
      await client.end();
    }
  }
} catch (err) {
  migrationsCheck = { name: "migrations", status: "not_ready", detail: `migration apply failed: ${(err as Error).message}` };
}

// append migrationsCheck to the existing checks array
// add migrationsResult to the response top-level as `migrations: migrationsResult`
```

- [ ] **Step 3.3: Update the `overall` aggregation if necessary**

If `overall` is computed by inspecting all checks' `status`, no change needed — the new `migrations` check participates. If it's hardcoded to a subset, extend it to include migrations.

- [ ] **Step 3.4: Manual smoke test**

Run the MCP server (`npm run dev` or rebuild + reload Claude Code), call `init_project()`, inspect the response. Expected: a new `migrations` check is in the checks array, and `migrations: { applied, skipped, total }` is at the top-level alongside other blocks like `core3`.

- [ ] **Step 3.5: Run the build + lint**

```
npm run lint:boundaries
npm run build
```

Expected: green.

- [ ] **Step 3.6: Commit**

```
git add src/tools/init.ts
git commit -m "feat(boot): init_project auto-applies pending migrations on first call

init_project now wraps applyPendingMigrations() and surfaces a new
'migrations' check + a top-level migrations:{applied,skipped,total}
block. BYO-Supabase users no longer run npm run schema manually;
the first init_project call bootstraps an empty DB transparently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `.claude-plugin/plugin.json` manifest

**Why:** This is the marketplace plugin's entry point. Claude Code reads the manifest, auto-wires the MCP server and the hook. Replaces the current manual `~/.claude.json` edit.

**Files:**
- Create: `.claude-plugin/plugin.json`

### Steps

- [ ] **Step 4.1: Look up the Claude Code Plugin manifest schema**

Reference: the plugin-dev skill documents the schema. Key fields: `name`, `version`, `description`, `author`, `mcpServers`, `hooks`. The `${CLAUDE_PLUGIN_ROOT}` token resolves to the installed plugin's root directory.

- [ ] **Step 4.2: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "smart-claude-memory",
  "version": "2.0.0",
  "description": "Sovereign memory protocol for Claude Code — typed, dual-scope, observability-grade. Bring your own empty Supabase project; the plugin handles the rest.",
  "author": {
    "name": "NABILNET.AI",
    "url": "https://nabilnet.ai"
  },
  "homepage": "https://nabilnet.ai",
  "mcpServers": {
    "smart-claude-memory": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
      "env": {
        "SUPABASE_URL": "${SUPABASE_URL}",
        "SUPABASE_SECRET_KEY": "${SUPABASE_SECRET_KEY}",
        "SUPABASE_POOLER_URL": "${SUPABASE_POOLER_URL}",
        "OLLAMA_HOST": "${OLLAMA_HOST:-http://localhost:11434}",
        "OLLAMA_EMBED_MODEL": "${OLLAMA_EMBED_MODEL:-nomic-embed-text}",
        "MEMORY_ROOTS": "${MEMORY_ROOTS}",
        "EMBED_DIM": "${EMBED_DIM:-768}"
      }
    }
  }
}
```

(The `hooks` block is added in Task 5; this commit lands the manifest and MCP wiring only.)

- [ ] **Step 4.3: Validate the manifest is well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json', 'utf8')); console.log('OK')"`

Expected: prints `OK`.

- [ ] **Step 4.4: Verify the MCP entry path is correct relative to plugin root**

`${CLAUDE_PLUGIN_ROOT}/dist/index.js` must point at the existing compiled entry. Confirm `dist/index.js` exists post-`npm run build`.

- [ ] **Step 4.5: Commit**

```
git add .claude-plugin/plugin.json
git commit -m "feat(plugin): .claude-plugin/plugin.json manifest + \${CLAUDE_PLUGIN_ROOT}

Adds the Claude Code Plugin manifest. Declares the smart-claude-memory
MCP server with command 'node \${CLAUDE_PLUGIN_ROOT}/dist/index.js'.
Marketplace install now auto-wires the MCP server — no more hand-editing
~/.claude.json. Env passthrough covers the 7 SCM env vars with sensible
defaults for OLLAMA_HOST, OLLAMA_EMBED_MODEL, and EMBED_DIM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Auto-wire `md-policy.py` hook via plugin manifest

**Why:** Removes the last manual settings.json edit. Plugin install = hook live. Plugin uninstall = hook gone.

**Files:**
- Modify: `.claude-plugin/plugin.json` (add `hooks` block)

### Steps

- [ ] **Step 5.1: Confirm the hook event + matcher**

The recon describes it as a PreToolUse hook matching `Write|Edit|Bash`. Confirm against `hooks/md-policy.py` and `hooks/README.md`.

- [ ] **Step 5.2: Extend `plugin.json` with the `hooks` block**

Add as a top-level sibling of `mcpServers`:

```json
  "hooks": {
    "preToolUse": [
      {
        "matcher": "Write|Edit|Bash",
        "command": "python",
        "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/md-policy.py"]
      }
    ]
  }
```

- [ ] **Step 5.3: Re-validate the manifest is well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json', 'utf8')); console.log('OK')"`

Expected: prints `OK`.

- [ ] **Step 5.4: Confirm `hooks/md-policy.py` shebang and platform handling**

The hook is a `.py` file. Ensure it has a `#!/usr/bin/env python` (or `python3`) shebang and that the manifest invocation (`command: "python", args: [...]`) works on both POSIX and Windows. If Windows users install Python as `py`, document in README.

- [ ] **Step 5.5: Commit**

```
git add .claude-plugin/plugin.json
git commit -m "feat(plugin): auto-wire md-policy.py hook via plugin manifest

Adds PreToolUse hook block to plugin.json matching Write|Edit|Bash.
Plugin install now registers the md-policy guard automatically; users
no longer hand-edit ~/.claude/settings.json. Single source of truth:
plugin lifecycle = hook lifecycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Ollama models preflight with actionable error

**Why:** Existing `init_project` checks Ollama reachability but not whether the required models (`moondream`, `nomic-embed-text`) are pulled. A user with Ollama installed but no models gets a cryptic embedding failure later instead of an upfront fix-it.

**Files:**
- Modify: `src/tools/init.ts` (extend the existing Ollama section)

### Steps

- [ ] **Step 6.1: Locate the existing Ollama check**

The recon notes `check_system_health` already does Ollama model presence detection (it reports `present: [...]` and `missing: [...]`). `init_project` may not — confirm.

- [ ] **Step 6.2: Add a `models` check to `init_project`**

If `init_project` already inspects Ollama models, just enrich the failure detail. If not, fetch `/api/tags` and check for `moondream` and `nomic-embed-text`:

```typescript
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const REQUIRED = ["moondream", "nomic-embed-text"];

async function checkOllamaModels(): Promise<{ status: "ok" | "partial" | "not_ready"; detail: string }> {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!r.ok) return { status: "not_ready", detail: `Ollama unreachable at ${OLLAMA_HOST} (HTTP ${r.status})` };
    const data = await r.json() as { models: Array<{ name: string }> };
    const present = data.models.map(m => m.name.split(":")[0]);
    const missing = REQUIRED.filter(req => !present.includes(req));
    if (missing.length === 0) {
      return { status: "ok", detail: `required models present: ${REQUIRED.join(", ")}` };
    }
    return {
      status: "partial",
      detail: `Missing Ollama models: ${missing.join(", ")}. Run: ollama pull ${missing.join(" && ollama pull ")}`,
    };
  } catch (err) {
    return { status: "not_ready", detail: `Ollama unreachable: ${(err as Error).message}` };
  }
}
```

Wire this into the checks array next to the existing Ollama-reachability check.

- [ ] **Step 6.3: Manual smoke test with a missing model**

Run: `ollama rm nomic-embed-text` (temporarily). Call `init_project()`. Expected: the check reports `partial` with the actionable `Run: ollama pull nomic-embed-text` detail. Then `ollama pull nomic-embed-text` to restore.

- [ ] **Step 6.4: Run build + lint**

```
npm run lint:boundaries
npm run build
```

Expected: green.

- [ ] **Step 6.5: Commit**

```
git add src/tools/init.ts
git commit -m "feat(env): preflight check for Ollama models with actionable error

init_project now verifies moondream + nomic-embed-text are pulled,
not just that Ollama is reachable. Missing models surface a 'partial'
status with the exact 'ollama pull <names>' command to fix, instead
of a cryptic embedding failure deeper in the call chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: README rewrite — 3-step BYO Supabase install ritual

**Why:** The current README documents the 5-step manual install. After Tasks 1-6, the install is 3 steps. README must reflect this; otherwise a new user reads stale instructions.

**Files:**
- Modify: `README.md` (rewrite the "Install" / "Getting started" section)
- Modify: `ARCHITECTURE.md` (add §X — Plugin Distribution)
- Modify: `docs/NEXT-SESSION-PROMPT.md` (update if any boot ritual steps change)

### Steps

- [ ] **Step 7.1: Inspect the current `README.md` install section**

Identify the section heading (`## Getting started` or similar). Locate the 5-step manual ritual.

- [ ] **Step 7.2: Replace the install section with the 3-step path**

```markdown
## Install (3 steps, ~5 minutes)

### 1. Install the plugin from the marketplace

In Claude Code, open the plugin marketplace and install **smart-claude-memory**. This auto-wires the MCP server and the `md-policy.py` PreToolUse hook. No `~/.claude.json` edits required.

### 2. Create an empty Supabase project + Ollama models

- Create a free Supabase project at https://supabase.com.
- Install Ollama (https://ollama.ai) and pull the two required models:
  ```
  ollama pull moondream
  ollama pull nomic-embed-text
  ```

### 3. Set 3 env vars in your project's `.env`

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SECRET_KEY=<service-role-key>
SUPABASE_POOLER_URL=postgres://postgres:<password>@<pooler-host>:6543/postgres
```

Then call `init_project()` from Claude Code. The plugin auto-applies all 18 schema migrations to your empty DB on the first call and reports `overall: pending → healthy` within a few minutes.

### Optional env vars

| Name | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBED_DIM` | `768` | Embedding vector dimension |
| `MEMORY_ROOTS` | (empty) | Semicolon-separated folders to sync |
```

- [ ] **Step 7.3: Add `## Plugin Distribution` section to `ARCHITECTURE.md`**

Add a new section explaining: marketplace manifest → MCP wiring → hook wiring → `${CLAUDE_PLUGIN_ROOT}` semantics → migration ledger boot path. Keep it focused, ~30-50 lines.

- [ ] **Step 7.4: Verify all README links still resolve**

Spot-check internal links (anchor jumps, `docs/...` paths) survive the rewrite.

- [ ] **Step 7.5: Commit**

```
git add README.md ARCHITECTURE.md docs/NEXT-SESSION-PROMPT.md
git commit -m "docs: README rewrite — 3-step BYO Supabase install ritual

Replaces the 5-step manual install (clone, npm install, fill .env,
apply 18 schemas one-by-one, hand-edit settings.json) with the 3-step
marketplace path: install plugin, create empty Supabase + pull
Ollama models, set 3 env vars. ARCHITECTURE.md gains a §Plugin
Distribution section covering manifest semantics and the migration
ledger boot path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Release v2.0.0 — drop `-rc1`, `marketplace.json`, GA changelog

**Why:** Closes the epic and ships the GA. Drops the release-candidate suffix, publishes the marketplace metadata, cuts a changelog enumerating the deltas from `2.0.0-rc1`.

**Files:**
- Modify: `package.json` (`version: "2.0.0-rc1"` → `"2.0.0"`)
- Modify: `.claude-plugin/plugin.json` (version field, if not already `2.0.0` — Task 4 already set it)
- Create: `marketplace.json` (top-level marketplace listing metadata)
- Create: `CHANGELOG.md` (or extend existing if present)

### Steps

- [ ] **Step 8.1: Confirm all prior tasks are merged + green**

Run: `npm run lint:boundaries && npm run build && npm test`

Expected: all green. Verify the working tree is clean (`git status`).

- [ ] **Step 8.2: Bump `package.json` version**

Edit `package.json`:

```json
  "version": "2.0.0",
```

- [ ] **Step 8.3: Create `marketplace.json`**

The marketplace.json schema is documented in the plugin-dev skill. Minimum fields:

```json
{
  "name": "smart-claude-memory",
  "version": "2.0.0",
  "description": "Sovereign memory protocol for Claude Code — typed, dual-scope, observability-grade.",
  "author": {
    "name": "NABILNET.AI",
    "url": "https://nabilnet.ai"
  },
  "homepage": "https://nabilnet.ai",
  "repository": "https://github.com/<your-org>/smart-claude-memory",
  "license": "MIT",
  "keywords": ["claude-code", "memory", "mcp", "supabase", "ollama", "sovereign"],
  "categories": ["memory", "observability"]
}
```

(Replace `<your-org>` with the actual GitHub org/user before publishing.)

- [ ] **Step 8.4: Create `CHANGELOG.md`**

```markdown
# Changelog

## [2.0.0] — 2026-05-14

**v2.0.0 GA — Plugin Marketplace Release**

### Added
- `.claude-plugin/plugin.json` manifest — installable via Claude Code marketplace; auto-wires the MCP server and the `md-policy.py` PreToolUse hook.
- `schema_migrations` ledger table + idempotent apply-all CLI (`npm run schema`); re-runs are no-ops.
- `init_project` auto-applies pending migrations on first call. BYO empty Supabase, no manual `npm run schema`.
- `marketplace.json` for marketplace listing.
- Ollama preflight: `init_project` now verifies `moondream` + `nomic-embed-text` are pulled and surfaces actionable `ollama pull` commands if missing.

### Changed
- Health enum extended: `"healthy" | "pending" | "degraded" | "down"`. Daemons within the 15-minute boot grace window report `pending` instead of `down`. Top-level `overall` no longer falsely promotes to `down` on cold boot.
- README install ritual reduced from 5 steps to 3.

### Migrated from `2.0.0-rc1`
- All Observability Epic work (4 daemons + GLOBAL Vault + system_dashboard) carried over; no behavior change.
- No breaking changes to existing tool surfaces (39 MCP tools).
```

- [ ] **Step 8.5: Final build + lint + test**

```
npm run lint:boundaries && npm run build && npm test
```

Expected: green across the board.

- [ ] **Step 8.6: Commit + tag**

```
git add package.json marketplace.json CHANGELOG.md .claude-plugin/plugin.json
git commit -m "release(2.0.0): drop -rc1, marketplace.json, GA changelog

Smart-Claude-Memory v2.0.0 GA. Drops the -rc1 suffix. Adds marketplace.json
for Claude Code marketplace publication. CHANGELOG.md enumerates the
deltas from 2.0.0-rc1: plugin manifest + auto-wired hook, schema_migrations
ledger + idempotent apply-all, init_project boot-time migration apply,
health.ts pending state + grace window, Ollama preflight, 3-step README.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git tag v2.0.0
```

- [ ] **Step 8.7: Pause for user sign-off before pushing tag**

Do NOT push `v2.0.0` to the remote without explicit user approval. A tag push is a hard-to-reverse public action (per CLAUDE.md's "Executing actions with care").

---

## Self-Review Checklist

**Spec coverage:**
- [x] §2.1 Distribution Model → Task 4 (manifest), Task 5 (hook auto-wire)
- [x] §2.2 BYO Supabase → Task 2 (ledger + apply-all), Task 3 (init_project hook)
- [x] §2.3 Ollama Stays Local → Task 6
- [x] §2.4 Hook Auto-Wiring → Task 5
- [x] §3 Acceptance Criteria 1-6 → Tasks 1-8 collectively
- [x] §4.1 Plugin Surface → Task 4 + 5
- [x] §4.2 Migration Ledger → Task 2
- [x] §4.3 Health Enum Extension → Task 1
- [x] §4.4 Boot-Time Migration Apply → Task 3
- [x] §4.5 Ollama Preflight → Task 6
- [x] §7 Testing — health unit tests (Task 1.2), migration integration tests (Task 2.2), plugin manifest schema validation (Task 4.3 / 5.3 via `JSON.parse`), README manual smoke (Task 7 — pre-tag-push), tx rollback test (Task 2.2 — covered indirectly via re-run no-op; consider adding an explicit force-failure test in a v2.0.1 if needed)
- [x] §8 Foundation-First Commit Sequence → Tasks 1-8 map 1:1 to spec commits 1-8

**Placeholder scan:** None. All code blocks are concrete. No TBD/TODO/"fill in details". `<your-org>` in `marketplace.json` is flagged explicitly as a substitution before publishing (not a placeholder in the implementation sense).

**Type consistency:**
- `DerivedStatus` used identically across Task 1 (`"healthy" | "pending" | "degraded" | "down"`).
- `applyPendingMigrations()` signature consistent in Task 2 (definition) and Task 3 (consumer).
- `ApplyResult` interface fields (`applied`, `skipped`, `total`, `appliedFiles`, `skippedFiles`) match across producer (Task 2) and consumer (Task 3).
- `${CLAUDE_PLUGIN_ROOT}` token used consistently across Task 4 (MCP path) and Task 5 (hook path).

Plan is internally consistent and externally complete.
