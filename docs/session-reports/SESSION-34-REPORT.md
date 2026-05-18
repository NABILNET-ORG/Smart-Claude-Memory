# SESSION 34 — FTUX Stress Test & Release Bulletproofing

**Date:** 2026-05-18
**Branch:** `main` (HEAD `e8dcc92` at session start; fix commit `a7f0249`)
**Version locked:** **`2.1.2` — explicitly cleared for `npm publish`.**
**Scope:** Validate a flawless First-Time User Experience for a fresh public clone of `smart-claude-memory`. Find and fix every defect blocking a clean boot. Do not alter M1-M7 business logic.
**Result:** **3 release-blocking FTUX defects found and fixed. Clean tarball simulation end-to-end. 169/169 regression tests green. Open Items: None.**

---

## 1. Methodology

The test exercised two parallel install paths a public consumer can actually use:

| Path | Simulates | How it was built |
| --- | --- | --- |
| **Git-clone path** | `git clone … && cd … && npm ci && npm run build && node dist/index.js` | `tar` pipe from source repo into `/tmp/ftux-scm/clone` (git's `file://` protocol cannot traverse OneDrive virtualization on this host, but the working-tree is identical). |
| **Marketplace tarball path** | `npx -y smart-claude-memory-mcp@latest` (what `.claude-plugin/plugin.json` declares to Claude Code) | `npm pack` on the source repo, then extract into `/tmp/ftux-scm/tarball-install/package`, then `npm install --omit=dev`, then `node dist/index.js`. |

Each path was probed in two boot modes:

- **Stage A — no env at all.** Mimics a user who skipped the `.env` step.
- **Stage B — synthetic placeholder `.env`.** Mimics a user who followed the README (`SUPABASE_POOLER_URL`-only, no `SUPABASE_DB_URL`).

Real Supabase credentials were never copied into the temp clone (the auto-mode classifier correctly refused). Synthetic placeholder values are the right contract test for "public clone" anyway.

---

## 2. Defects Found in the First Run

### Defect #2 — Env schema contradicts the documented setup *(HIGH; release blocker)*

`src/config.ts` declared `SUPABASE_DB_URL` as a **required** Zod field. The README's "Quick start" tells users to set 3 env vars: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_POOLER_URL`. `.env.example` lists both, but every actual database consumer in the codebase (`scripts/apply-schema.ts`, `src/tools/setup.ts`, `scripts/backfill-ledger.ts`, the smoke/verify scripts) reads them via the same fallback chain: `SUPABASE_POOLER_URL ?? SUPABASE_DB_URL`. **`config.SUPABASE_DB_URL` was never read anywhere** — it was a dead-required field that crashed every fresh user who followed the documented happy path.

Stage B boot output (pre-fix):

```
ZodError: [
  { "path": ["SUPABASE_DB_URL"], "message": "Invalid input: expected string, received undefined" }
]
```

### Defect #3 — Unfriendly first-boot error *(MEDIUM; UX)*

Boot failure raised a raw Zod stack trace from `dist/config.js:18`. A first-time user reading that wall of text has no obvious next step.

### Defect #1 — Marketplace tarball was missing migrations *(HIGH; release blocker)*

`package.json.files` shipped `dist/`, `hooks/`, `.claude-plugin/`, etc., but **not** `scripts/*.sql`. `MIGRATIONS_DIR` in `src/lib/migrations.ts` resolves to `<package>/scripts/`, and `init_project`'s auto-apply-migrations path reads from there. The published tarball would therefore start with zero discoverable migrations — every Marketplace install would silently fail to bootstrap its schema. The git-clone path was unaffected (clones contain `scripts/`); the `npx` path was broken.

---

## 3. Fixes Applied

Diff stat:

```
 package.json  |  1 +
 src/config.ts | 23 +++++++++++++++++++++--
```

### `src/config.ts`

- `SUPABASE_DB_URL` → `.optional()`.
- Added `SUPABASE_POOLER_URL: z.string().min(10).optional()`.
- `.refine()` guard: at least one of the two must be set.
- Wrapped `Env.parse(process.env)` in a `parseEnv()` helper that catches `ZodError`, prints a labelled "Environment is not configured" hint, lists each missing/invalid field, and exits `1`.

### `package.json`

- Added `"scripts/*.sql"` to the `files` array. Narrow glob — only the 20 numbered migrations ship, not the surrounding TypeScript tooling.

### Out of scope by design

- No M1-M7 business logic touched.
- `dist/` regenerated via `npm run build` (lint:boundaries OK, `tsc` exit 0).

---

## 4. Re-Test Evidence

### Git-clone path (`/tmp/ftux-scm/clone`)

| Step | Command | Outcome |
| --- | --- | --- |
| Install | `npm ci --no-audit --no-fund` | exit `0`, 244 packages in 3s |
| Build | `npm run build` (`lint:boundaries && tsc`) | exit `0`, 51 `.js` files, 949 KB `dist/` |
| Boot Stage A (no env) | `timeout 5s node dist/index.js` | exit `1`, prints `[smart-claude-memory] Environment is not configured.` + per-field reasons |
| Boot Stage B (POOLER-only env) | `timeout 6s node dist/index.js` | exit `124` (timeout kill → stdio held open), `0` lines stderr, no `ZodError`, no fatal markers |

### Marketplace tarball path (`/tmp/ftux-scm/tarball-install`)

| Step | Outcome |
| --- | --- |
| `npm pack` | `smart-claude-memory-mcp-2.1.1.tgz`, 220 KB packed / 893 KB unpacked, 130 files |
| Tarball contents | `.claude-plugin/`, `dist/`, `hooks/`, `scripts/` (20 `.sql`), `CHANGELOG.md`, `LICENSE`, `README.md`, `marketplace.json`, `package.json` |
| Bloat check | `src/`, `tests/`, `node_modules/`, `.env`, `docs/` — **all absent** |
| `npm install --omit=dev` | exit `0`, 206 packages in 15s, 52 MB `node_modules/` |
| `node dist/index.js` (synthetic env) | exit `124`, `0` lines stderr, no fatal markers |
| `MIGRATIONS_DIR` resolution inside tarball install | `<package>/scripts`, **20 migrations discoverable** (`001_schema.sql` … `020_*.sql`) |

### M1-M7 regression check

```
ℹ tests 169
ℹ suites 44
ℹ pass 169
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 35114
test exit: 0
```

---

## 5. Exit Criteria Satisfied

The goal required *"a completely clean boot in a mocked fresh directory with 0 errors, proving the system is 100% production-ready for public clones."*

- ✅ Fresh `npm ci` succeeds with no errors on a clone of `HEAD`.
- ✅ Fresh `npm run build` succeeds (boundary lint + `tsc` clean).
- ✅ MCP server boots cleanly under the documented setup (synthetic placeholder env, `SUPABASE_POOLER_URL` only).
- ✅ Marketplace `npx` path validated end-to-end — pack → install → boot → migrations discoverable.
- ✅ When env is missing, the boot exits cleanly with an actionable hint instead of a Zod stack trace.
- ✅ 169/169 regression tests still pass; only the two intended source files changed.

---

## 6. Hurdles + Resolutions

- **`git -C "<spaced OneDrive path>" clone` fails silently** — git refuses the path even though `ls` finds it. Worked around with a `tar -C "$SRC" … | tar -xf - -C "$DST"` pipe that preserves a complete working-tree without needing git transport. Same trick applies to any future OneDrive-hosted FTUX simulation.
- **Auto-mode classifier blocked copying production `.env`.** Correct call. Reframed the test around synthetic placeholders, which is the more honest FTUX contract anyway.

---

## 7. Release Clearance — v2.1.2

`package.json` version bumped `2.1.1 → 2.1.2`. `npm run build` clean against the bumped manifest (`lint:boundaries` OK, `tsc` exit 0). `npm pack` dry-run validated the tarball contents at the new version (`smart-claude-memory-mcp-2.1.2.tgz`, 220 KB packed, 130 files, 20 `scripts/*.sql` shipped, zero bloat).

**v2.1.2 is explicitly cleared for `npm publish`.** No outstanding blockers.

### Open Items

**None.**

(Non-blocking note for future maintenance: a transitive `glob@10.5.0` deprecation warning surfaces during install. Not load-bearing for v2.1.2; can be addressed in a future dependency-audit pass.)

---

## 8. Files Changed

Fix commit `a7f0249` — `fix(ftux): resolve v2.1.2 install defects (sql tarball inclusion, env fallback, graceful exit)`:

```
M  package.json   (+2, -1)
M  src/config.ts  (+23, -3)
```

`dist/` regenerated as a side-effect of `npm run build` (tracked status follows the repo's existing convention).
