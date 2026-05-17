# Session 28 Report — Smart Claude Memory

**Date:** 2026-05-17
**Mission:** Housekeeping + v2.1.0 distribution (npm publish + GLOBAL Vault promotions)
**Outcome:** SHIPPED — `smart-claude-memory-mcp@2.1.0` live on npm registry; v2.1.0 released on GitHub; 2 universal patterns promoted to the GLOBAL vault.

---

## 1. Headline Wins

- **🚀 npm Distribution.** `smart-claude-memory-mcp@2.1.0` published to the public npm registry under the `nabilgpt` maintainer. Tarball: 185.2 KB packed / 745 KB unpacked / 104 files. Two-pillar install path is now live: **Option A** `/plugin install NABILNET-ORG/Smart-Claude-Memory` (Claude Code plugin) OR **Option B** `npm install smart-claude-memory-mcp` (programmatic).
- **🛡️ Sovereign Vetting — 2 promotions to GLOBAL Vault.** Both [SCM-S27-D2](#) (Foundation-First commit-sequencing) and [SCM-S27-D3](#) (defense-in-depth for clock-dependent pure functions) passed the Cross-Project Test and were saved with `is_global: true` + `global_rationale`. New GLOBAL row IDs: `12139` (D2) and `12140` (D3). Both visible to every future project via dual-scope `search_memory`.
- **📦 GitHub Release.** v2.1.0 tag force-moved to the package-prep commit `e410f51` so the tag → npm tarball mapping is 1:1. Release published on GitHub using [`docs/release-notes-v2.1.0.md`](../release-notes-v2.1.0.md) (97 lines, comprehensive).
- **📚 README Install Section.** Surgical Edit added a new `## Install` section to the README between "Multi-project isolation" and "System Architecture", covering both distribution channels with copy-paste-ready commands.

---

## 2. Exact Publication Path (reproducible)

The path from "v2.1.0 committed locally" → "live on npm" required surgical fixes to `package.json`:

| Blocker | Fix |
|---|---|
| `"private": true` | Removed |
| No `"files"` allowlist (would have shipped `node_modules/`, `tests/`, `docs/`, `src/`, `backups/`) | Added explicit allowlist: `dist/`, `hooks/`, `.claude-plugin/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `marketplace.json` |
| Missing publish metadata (`description`, `license`, `homepage`, `repository`, `bugs`, `keywords`) | Mirrored from `marketplace.json` (single source of truth) |
| No npm credentials on machine | User ran `npm login` interactively (one-time) |
| 2FA required for publish (E403 on first attempt) | User re-ran `npm publish --access public` — npm auto-prompted for OTP via browser auth-cli URL |

**Pre-flight verification (via `npm pack --dry-run --json`):**
- ✅ Critical inclusions: `dist/index.js`, `hooks/md-policy.py`, `.claude-plugin/plugin.json`, README, LICENSE, CHANGELOG, marketplace.json, package.json
- ✅ Forbidden exclusions (all clean): `tests/`, `src/`, `docs/`, `backups/`, `scripts/`, `node_modules/`, `images/`, `.git/`
- ✅ Top-level shipped: `.claude-plugin`, `CHANGELOG.md`, `LICENSE`, `README.md`, `dist`, `hooks`, `marketplace.json`, `package.json`

**Post-publish verification (via `npm view`):**
- ✅ `latest` dist-tag → `2.1.0`
- ✅ MIT license, 7 runtime deps (sdk, supabase, dotenv, glob, ollama, pg, zod)
- ✅ Tarball SHA: `b57eaf83edafac2bf038d2007f1f047fc3792d85`
- ✅ Maintainer: `nabilgpt <nabilgpt.en@gmail.com>`

---

## 3. DECISIONs (saved to project memory + GLOBAL vault)

| ID | Subject | Scope | GLOBAL Row ID |
|---|---|---|---|
| **SCM-S28-D1** | npm `files` allowlist as the only safe publish gate (vs relying on `.npmignore` / `.gitignore` exclusions). | Local | — |
| **SCM-S27-D2 → GLOBAL** | Foundation-First commit-sequencing: hoist shared-dependency refactors to commit #1; never bundle refactor+feature. Lived through real epic with measurable bisect/review/recovery wins. | GLOBAL | `12139` |
| **SCM-S27-D3 → GLOBAL** | Defense-in-depth for time-dependent pure functions: inject optional `now?: number` param AND clamp durations with `Math.max(0, …)`. Both required — neither alone is sufficient. | GLOBAL | `12140` |

**Anti-bloat note:** `SCM-S28-D1` was kept local — the npm `files` allowlist pattern is npm-specific and doesn't pass the Cross-Project Test for non-npm projects.

---

## 4. Hurdles + Solutions

| Hurdle | Solution |
|---|---|
| `.gitignore` excludes `dist/` — would have caused npm to skip the compiled code entirely (no `.npmignore` to override). | Explicit `"files"` array in `package.json` overrides both `.gitignore` and `.npmignore` defaults. Verified via JSON-parsed `npm pack --dry-run`. |
| First `npm publish` returned `E403 — Two-factor authentication required`. | User retried; npm auto-served a browser auth-cli URL for the OTP flow. Second attempt succeeded. |
| `npm login` is interactive — cannot be invoked by the orchestrator's non-interactive Bash tool. | Documented three publication paths (automation token / user-runs-login / user-runs-publish) and let the user pick. User chose Path 2 (login manually, then I publish). After login, all `npm publish` calls became non-interactive-friendly modulo the 2FA gate. |
| Tag `v2.1.0` was at `84f34c4` (Session 27 wrap) but the published npm tarball was built from `e410f51` (package prep). One-commit drift between tag and shipped artifact. | User force-moved the tag (`git tag -f v2.1.0 e410f51 && git push --force origin v2.1.0`) so tag → npm tarball is 1:1. Deliberate, audited, single force-push. |
| Backlog returned 0 active tasks on session start — no concrete Session 28 spec existed. | Per [Planning — Think Before Coding], surfaced state honestly + held for direction rather than invent scope. User chose v2.1.0 distribution. |

---

## 5. Files Changed

| File | Status | Commits |
|---|---|---|
| `package.json` | Modified | `e410f51` (drop `private`, add `files` + metadata) |
| `README.md` | Modified | `4cb8e7e` (add `## Install` section) — plus auto-sync by `manage_backlog session_end` |
| `docs/release-notes-v2.1.0.md` | New | `4cb8e7e` (97-line release notes draft) |
| `docs/session-reports/SESSION-28-REPORT.md` | New | this commit |
| `ARCHITECTURE.md` | Auto-sync | `manage_backlog session_end` regenerated diagrams |

**Cumulative LOC delta:** +28 (package.json) +22 (README) +97 (release notes) + session report.

---

## 6. System State at Wrap

- `init_project` checks: 14/14 ok
- `check_system_health`: healthy (Supabase 8012 chunks, Ollama models present, 264 frozen patterns active)
- `bloat_audit`: CLAUDE.md 2631 tokens, hidden MEMORY.md 94 tokens — both well under 10k
- Backlog: empty (0 todo · 0 in-progress · 0 blocked)
- `npm view smart-claude-memory-mcp version` → `2.1.0` (latest)
- Git: `main` synced with `origin/main`; `v2.1.0` tag force-aligned to `e410f51`
- GLOBAL vault: 2 new rows added this session (`12139`, `12140`)

---

## 7. Open Items / Loose Ends

- **None.** The v2.1.0 distribution loop is closed end-to-end (commit → tag → npm registry → GitHub release → install snippets in README).
- **Optional future work (not blocking):** scope the package under `@nabilnet/` if desired, set up an npm Granular Access Token with "bypass 2FA" for fully autonomous future publishes.

---

## 8. Sovereign Constitution Compliance

- ✅ [Planning — Think Before Coding]: Surfaced empty backlog honestly; required explicit user direction before scoping work.
- ✅ [Execution Engine — Loop Until Verified]: Every claim (npm live, GLOBAL saves, tarball contents) verified via independent read (npm view, search_memory, JSON-parsed npm pack).
- ✅ [Surgical Editing]: All Edits were minimum-viable. `package.json` change touched only the manifest, not runtime. README `## Install` insertion left all surrounding sections intact.
- ✅ [Tokens Are Currency]: Used `ctx_execute` / `ctx_execute_file` for analysis; reserved Read for files I was about to Edit. Used `intent` flag on large pack-listing output.
- ✅ [Foundation First — No Broken Windows]: Two clean commits, no entanglement. Package-prep (`e410f51`) and docs (`4cb8e7e`) are separate concerns on separate commits.
- ✅ [Sovereign Vetting]: Both GLOBAL promotions explicitly consented by user before save; both include `global_rationale`.
- ✅ [Wrap-Up Ritual]: `manage_backlog({ action: "session_end" })` confirmed `readme_sync.updated === true` AND `architecture_sync.updated === true` BEFORE this report was written.

---

## 9. Next-Session Command

See bottom of synthesis (chat output).
