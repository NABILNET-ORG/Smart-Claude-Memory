# SESSION 37 — M8.1 Visual QA, Windows ESM Entry-Point Fix, v2.2.0 Promotion

**Date:** 2026-05-18
**Branch:** main
**Result:** ✅ All M8.1 acceptance criteria pass · ✅ Windows regression caught + fixed · ✅ v2.2.0 locked · ✅ GLOBAL pattern minted

---

## 1. Mission

Session 36 shipped the M8.1 Mega-Epic (Knowledge Graph daemon + SVG Command Center) with full server-side test coverage but explicitly deferred **visual QA in a live browser** to Session 37. The handover named three acceptance criteria:

1. Force-directed layout settles cleanly (no chaos at 60+ nodes).
2. Clicking a node pops the detail drawer with correct payload.
3. `?type=FILE` filter passes through end-to-end.

Session 37's mandate was to run that QA, capture evidence, fix anything broken, and then close out the M8 chapter with a clean version bump.

---

## 2. Visual QA — All Three Criteria Pass

| Criterion | Method | Result |
|---|---|---|
| Force layout convergence | JS audit of all 60 `g.node` transforms — min pairwise distance, viewBox boundary check, type histogram | 60 nodes, **0 overlapping pairs**, all inside the 1000×600 viewBox, min pairwise distance **24.7 px** (>2× radius), types 17 DECISION + 43 FILE. **No tuning of `k_rep` / `k_attr` / `ideal` / `max_iter` required.** |
| Node click → drawer | `dispatchEvent('click')` on first `g.node`; inspect `#graph-detail` hidden state + innerHTML | `hidden` flipped `true → false`; drawer rendered label, type=DECISION, source_chunk=12147, and properties JSON (`{"status":"applied","decision_id":"SCM-S30-D1",...}`). Close button wired. |
| `?type=FILE` filter passthrough | Set `#g-type-filter`=FILE, click Reload, wait for refetch, inspect remaining nodes | Backend `/api/graph?type=FILE` returns 60 FILE-only nodes; UI renders 60 nodes · 0 edges (cross-type edges correctly pruned — expected behavior since DECISION↔FILE edges have no surviving endpoint pair in the FILE subset). |

Evidence screenshots (committed alongside the fix in `dab7f2d`):
- [SESSION-37-kg-initial.png](SESSION-37-kg-initial.png) — default 60-node load
- [SESSION-37-kg-drawer.png](SESSION-37-kg-drawer.png) — node clicked, drawer open
- [SESSION-37-kg-filter-FILE.png](SESSION-37-kg-filter-FILE.png) — type=FILE active

Console: only cosmetic items (favicon 404, 5 unlabeled form-field a11y warnings on the M7 graduation controls). No graph-related errors.

---

## 3. Regression Caught + Fixed — Windows ESM Entry-Point Guard

Before the QA could even start, `SCM_GUI_ENABLED=1 npm run gui` exited with code 0 in under 2 seconds and nothing bound to `:7788`. The dashboard was simply not coming up.

### 3.1 Root Cause

The standalone-entry-point guard at `src/gui/server.ts:368` (pre-fix):

```ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  startGuiServer({ ... });
}
```

On Windows the two sides never match for **three independent reasons**:

| # | Mismatch | LHS (`import.meta.url`) | RHS (hand-built) |
|---|---|---|---|
| 1 | Slash count | `file:///C:/...` (3) | `file://C:/...` (2) |
| 2 | Space encoding | `My%20Projects` | `My Projects` (literal) |
| 3 | Drive-letter case | environment-dependent (often lowercase) | from argv (often uppercase) |

Because the equality silently returned `false`, `startGuiServer` was never invoked — `tsx` finished evaluating the module and exited cleanly. The bug only manifests on Windows; Linux/macOS dodge it by having no spaces in standard paths and no drive-letter quirk, and the slash count happens to match.

### 3.2 Fix

Replaced the string-equality guard with normalized fs-path comparison (commit `dab7f2d`):

```ts
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

const isStandaloneEntry =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1] as string);
if (isStandaloneEntry) {
  startGuiServer({ ... });
}
```

`fileURLToPath` strips the `file://` prefix and percent-decodes the path; `path.resolve` on both sides normalizes slashes and drive-letter case. The idiom is the Node-recommended canonical form for this guard and is fully cross-platform.

### 3.3 Verification

- Re-launched: `npm run gui` → `GET /api/health` returned 200 in ~1 second.
- `GET /api/graph` returned 60 nodes, 75 edges immediately.
- All Visual QA criteria above ran end-to-end on the live dashboard.

---

## 4. Cross-Project Promotion — SCM-S37-P1 (GLOBAL PATTERN)

Per Sovereign Vetting, the entry-point-guard pattern is **not** SCM-specific:
- Every Node ESM/TS codebase that wants `npm run X` to dual-purpose a module as both library export and standalone CLI hits the exact same Windows landmine.
- The wrong idiom has been propagating through tutorials and Stack Overflow for years.
- The fix has zero project-specific coupling and survives the loss of any specific project.

**Cross-Project Test:** PASS. If smart-claude-memory died tomorrow, this idiom would still be the canonical way for the next project's CLI entry to work on Windows.

User granted explicit YES. Minted into the GLOBAL vault as:

| Field | Value |
|---|---|
| Pattern ID | SCM-S37-P1 |
| chunk_id | 12862 |
| project_id | `GLOBAL` |
| metadata.type | `PATTERN` |
| metadata.is_global | `true` |
| metadata.global_rationale | "Every Node ESM/TS project that dual-purposes a module as library export and CLI entry needs this exact guard. The standard `import.meta.url === \`file://${argv[1]}\`` idiom is broken on Windows in 3 independent ways (slash count, percent-encoded spaces, drive-letter casing) and silently no-ops the entry — a Windows-only landmine that costs hours to diagnose..." |

This is the second GLOBAL pattern minted from this repo and the first one derived from a concrete production regression rather than a theoretical decision.

---

## 5. v2.2.0 Promotion

`package.json` bumped from `2.1.2` → **`2.2.0`** to reflect the cumulative M8 chapter:

- M8 (Session 35): Hybrid RAG knowledge graph backbone — `kg_nodes` / `kg_edges` schema, RPCs, `kg_hybrid_search`, search splice.
- M8.1 (Session 36): Graph extractor daemon + `/api/graph` endpoint + zero-dependency SVG force-directed renderer in the Command Center.
- M8.1 fix (Session 37, this session): Windows ESM entry-point guard regression resolved; visual QA evidence captured.

A minor bump (`2.1.2 → 2.2.0`) is appropriate because the work is purely additive — no breaking changes to the publishable surface, but a substantial new feature surface (Knowledge Graph extraction + GUI panel) deserves more than a patch bump.

### Verification

| Gate | Command | Result |
|---|---|---|
| Test suite | `npm test` | **241 / 241 pass · 0 fail · 0 skipped · 32.9 s** |
| Lint (boundary invariant #1) | `npm run lint:boundaries` (part of `build`) | OK — scanned 6 files under `src/sleep`, `src/curriculum`, `src/graduation`. No LLM imports / endpoints across the deterministic boundary. |
| Typecheck | `npm run build` → `tsc` | exit 0 |

**Workspace is clean and v2.2.0 is locked. Ready for human `npm publish`.**

---

## 6. Hurdles + Resolutions

| Hurdle | Resolution |
|---|---|
| `npm run gui` exited 0 instantly — no server, no logs, no errors. | Hypothesized standalone-entry-point guard mismatch from prior Windows scars. Built a probe script (`probe-entry.mjs`) to dump `import.meta.url` vs the hand-built comparand side-by-side. Confirmed the 3-way mismatch in <30 s. |
| `dispatchEvent('click')` needed for SVG nodes (no per-node `uid` in the a11y tree, since the whole SVG is one image node). | Used `evaluate_script` with a closure-over-DOM approach instead of trying to drive individual `<g>` elements through the a11y MCP. Worked cleanly. |
| Stop hook intercepted the version-bump Edit because `package.json` had not been Read yet in this session. | Read `package.json`, retried Edit. Clean apply. |

---

## 7. Files Changed (this session)

| File | Change | Lines |
|---|---|---|
| `src/gui/server.ts` | Cross-platform entry-point guard (added `path` + `fileURLToPath` imports; rewrote the `if`) | +11 / −2 |
| `package.json` | Version bump `2.1.2` → `2.2.0` | +1 / −1 |
| `docs/session-reports/SESSION-37-kg-initial.png` | QA evidence (default load) | new |
| `docs/session-reports/SESSION-37-kg-drawer.png` | QA evidence (drawer open) | new |
| `docs/session-reports/SESSION-37-kg-filter-FILE.png` | QA evidence (filter active) | new |
| `docs/session-reports/SESSION-37-REPORT.md` | This report | new |
| `README.md` / `ARCHITECTURE.md` | Living-docs sync via `manage_backlog({ action: 'session_end' })` | regenerated |

---

## 8. Memory Imprints

| Chunk | Type | Scope | Subject |
|---|---|---|---|
| 12860 | DECISION | claude-memory | SCM-S37-D1: M8.1 Visual QA pass + Windows regression caught & fixed |
| 12861 | ERROR (fixed) | claude-memory | Root-cause + fix for the silent `npm run gui` exit on Windows |
| 12862 | PATTERN | **GLOBAL** | SCM-S37-P1: Cross-platform ESM standalone-entry-point guard |

---

## 9. Open Items

**None blocking.** v2.2.0 is publish-ready.

Cosmetic-only follow-ups, deferable indefinitely:

- Add a `favicon.ico` to silence the 404 in the GUI console.
- Wire `<label for>` associations to the M7 graduation form controls (currently 5 a11y warnings).

Neither affects the publishable surface or the M8 feature contract.

---

## 10. Decision IDs

- `SCM-S37-D1` — Visual QA pass + Windows entry-point fix (project-scoped, chunk 12860).
- `SCM-S37-P1` — Cross-platform ESM entry-point guard pattern (GLOBAL, chunk 12862).
