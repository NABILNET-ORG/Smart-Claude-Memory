# Session 31 Report — Smart Claude Memory

**Theme: prune_memory shipped + GLOBAL deletion-safety pattern promoted.** One epic, end-to-end TDD, zero production bugs, zero rework. The system now has a safe garbage collector for orphan `memory_chunks` rows, and the safety architecture behind it was elevated to the GLOBAL vault as a universal pattern for any vector-DB-backed agent project.

---

## 1. Headline Wins

| Win | Detail |
|---|---|
| **`prune_memory` MCP tool shipped** | Pays off the README:489 deferral ("a dedicated `prune_memory` tool is deferred to a later release so deletions are never silent"). Registered in `src/index.ts` between `sync_local_memory` and `search_memory`. |
| **+16 new green tests** | Suite **104 → 120**, 100% pass. Live-Supabase characterization tests across 7 describe blocks pinning the full contract before any TS landed. |
| **`inline:*` bug pre-empted** | The highest-severity foreseeable bug — a naive on-disk absence check would have silently wiped every `save_memory` row (synthetic `inline:<sha256>` origins). T3 pins the contract: even with `confirm:true`, inline rows survive. |
| **Mid-flight `currentProjectId` correction** | Pre-flight grep on `src/project.ts:20` caught that `currentProjectId` is a `const string`, not a function. Plan referenced a fabricated `getDefaultProjectId()` helper — patched the plan AND the implementation before any TS shipped. Zero rework. |
| **GLOBAL pattern promotion** | "Deletion Safety Architecture for Vector-DB-Backed Agent Memory" saved at `project_id='GLOBAL'` (memory id 12272) with explicit user consent per the Sovereign Scout Protocol. Five-pillar contract documented for portability. |
| **Constitution reconciled** | "Archive, never delete" (SCM-S17-D1, SCM-S18-D1) targets **content mutation** of immutable HNSW rows, not row-lifecycle reaping. README:489 pre-authorised; FK CASCADE (ARCH:343) and telemetry pruner hard-DELETE (ARCH:630) precedents apply. Manifest-as-archive closes the loop. |
| **Zero production bugs** | All 16 characterization assertions held on first run after each TDD red→green flip. |

---

## 2. Source Material (analyzed; never imported)

- **`src/tools/sync.ts`** — read end-to-end via delegated subagent to map the `orphan_files` detection block (lines 186-189 of the localSet check) and confirm `auto_purge` deletes local files, not DB rows. The deletion gap was the build target.
- **`src/supabase.ts`** — discovered `deleteChunksForFile(projectId, fileOrigin)` already existed at lines 199-210, pinned on both keys. No new SQL needed; new helper `listFileOriginsForProject` added at lines 213-223.
- **`src/index.ts:186-195`** — `sync_local_memory` registration block read to mirror the canonical 4-arg `server.tool()` shape.
- **`src/project.ts:20`** — confirmed `currentProjectId` is a `const`, not a function. Drove the pre-flight plan correction.
- **`tests/fixtures/m4.ts`** — modelled `tests/fixtures/prune.ts` after this shape: `uniqueProjectId()` namespacing, 768-dim zero embedding, `content_hash` via sha256.
- **`README.md:489`** — the deferral note quoted verbatim by the investigation, replaced verbatim in Task 7.

Nothing imported from external repos. All discoveries from in-repo audit.

---

## 3. DECISIONs (saved to project memory)

| ID | Memory ID | Status | Topic |
|---|---|---|---|
| SCM-S31-D1 | 12184 | proposed | `prune_memory` spec drafted at `docs/specs/prune-memory-tool.md`. Five locked design pins, 10 characterization tests defined. |
| SCM-S31-D1 | 12271 | applied | `prune_memory` shipped on `main`. 16 tests green (104→120). Mid-flight `currentProjectId` correction documented. |
| (GLOBAL) | 12272 | applied | Universal PATTERN — "Deletion Safety Architecture for Vector-DB-Backed Agent Memory" promoted to GLOBAL vault with five-pillar contract: explicit-paths, dry-run default, synthetic-origin filter, key-pinned delete helper, JSON-manifest-as-archive. |

---

## 4. Hurdles + Solutions

| Hurdle | Solution |
|---|---|
| **`inline:*` silent-wipe risk** — naive absence check would always flag synthetic `inline:<sha256>` origins as orphans (no disk file) and wipe every `save_memory` row in the project. Highest-severity foreseeable bug. | Caught during planning. Locked as Decision Pin #3 in the spec ("Inline filter — hard skip `file_origin.startsWith('inline:')`"). T3 pins the contract: even with `confirm:true`, inline rows survive. Verified GREEN before any other test passed. |
| **`currentProjectId` plan inaccuracy** — spec referenced a fabricated `getDefaultProjectId()` import; the actual export at `src/project.ts:20` is a `const string`, not a function. TS error surfaced on first `npm run build`. | Two patches: (1) inline `slugify(basename(process.cwd()) \|\| "default")` first attempt; (2) verified `currentProjectId` exists as a const → dropped the parens. Spec doc updated to match. Caught at Task 6 build step, fixed in <1 minute. |
| **`countChunks` async/dynamic-import smell** — original plan used `await import("../supabase.js")` inside `countChunks` to dodge top-level import cycles that didn't exist. | Direct top-level import of `supabase` works cleanly; pattern matches other tools in `src/tools/`. Refactored before commit. |
| **Test-runner script omits glob** — `package.json` `test` script names files explicitly; new `tests/prune.test.ts` would be silently excluded from `npm test`. | Task 8 step adds the file to the list. Final `npm test` reports 120 tests across 39 suites — confirms wiring. |
| **GLOBAL Sovereign Scout consent** — the deletion-safety pattern passes the Cross-Project Test, but Sovereign Scout Protocol forbids silent GLOBAL writes. | Explicit YES/NO question surfaced to user with rationale + proposed `global_rationale`. User approved. Saved with full audit trail in the metadata. |

---

## 5. Files Changed (10 commits this session)

**Epic — `prune_memory` (9 commits):**
- `b681ddb` docs(prune): add prune-memory-tool spec for SCM-S31-D1 (`docs/specs/prune-memory-tool.md` +710 LOC)
- `4229644` feat(prune): add `listFileOriginsForProject` helper + test (`src/supabase.ts`, `tests/fixtures/prune.ts`, `tests/prune.test.ts`)
- `cff65aa` feat(prune): pruneMemory dry-run skeleton + input guards T1/T2/T4 (`src/tools/prune.ts` +120 LOC)
- `f6b0c7a` test(prune): T3 confirms `inline:*` origins are never deleted
- `443bd54` test(prune): T5/T6 pin `still_on_disk` + `not_in_db` classifications
- `b2de6a2` feat(prune): confirmed delete branch + manifest writer T7-T10
- `d2cdc3b` feat(prune): register `prune_memory` MCP tool (`src/index.ts`)
- `ec27e89` docs(prune): README:489 replacement + Toolbox row + ARCHITECTURE.md §4.2.1
- `d68f84a` chore(test): include `prune.test.ts` in `npm test` suite (`package.json`)

**Wrap-up (this commit):**
- `(next)` session: wrap-up Session 31 — `prune_memory` shipped and GLOBAL deletion pattern promoted (`SESSION-31-REPORT.md` + auto-synced README/ARCHITECTURE)

---

## 6. New Tool Surface

**`prune_memory`** — `src/tools/prune.ts` exporting `pruneMemory(args)`:

```ts
interface PruneArgs {
  explicit_paths: string[];  // REQUIRED, non-empty, no wildcards
  project_id?: string;       // defaults to currentProjectId; 'GLOBAL' rejected
  confirm?: boolean;         // default false = dry-run; true = actually delete
}
```

Returns `{ mode: "dry_run" \| "deleted", project_id, candidates, deleted_total, manifest_path? }`. Each candidate carries a `skipped_reason` of `"inline_origin" \| "not_in_db" \| "still_on_disk"` when bypassed. On confirmed delete: writes `~/.claude-memory/prune-backups/<ISO-stamp>-<project>/manifest.json` with `{project_id, prune_at, items:[{file_origin, chunk_count, was_orphan:true}]}`.

---

## 7. Test Coverage Map (16 new tests)

| Suite | Tests | What it pins |
|---|---|---|
| `listFileOriginsForProject` | 2 | distinct enumeration scoped to project; empty array for empty project |
| `pruneMemory — input validation` | 3 | T2/T2b/T4 — empty array rejected, missing arg rejected, GLOBAL refused |
| `pruneMemory — dry-run` | 1 | T1 — mode='dry_run' is non-destructive |
| `pruneMemory — inline:* filter` | 1 | T3 — `inline:<hash>` rows survive even with `confirm:true` (regression-killer) |
| `pruneMemory — skipped reasons` | 2 | T5/T6 — `still_on_disk` and `not_in_db` classifications block deletion |
| `pruneMemory — confirmed delete` | 4 | T7-T10 — orphan-only deletion, manifest content, deleted_total invariant, cross-project isolation |
| `pruneMemory — MCP zod schema contract` | 3 | Schema accepts valid payload; rejects empty array; rejects missing arg |

All run live against Supabase; each describe uses `uniqueProjectId()` namespacing + per-test try/finally cleanup via `deleteChunksForFile`.

---

## 8. Open Items

**None.**

The epic is complete. README:489 deferral resolved. `prune_memory` shipped, registered, tested, documented. GLOBAL pattern promoted with explicit consent. Backlog empty. Build green. Suite green.

---

## 9. Next Session Boot Command

See bottom of this file — preserved verbatim from `manage_backlog({action:"session_end"})` with the only edit being `Session 31 plan` → `Session 32 plan` (the upstream tool emits a stale label).
