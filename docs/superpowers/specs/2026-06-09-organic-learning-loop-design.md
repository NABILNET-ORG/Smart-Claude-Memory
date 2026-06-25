# Design Spec — Prove the Organic Self-Learning Loop End-to-End (Session 55)

- **Status:** DRAFT — awaiting human review (no code written yet)
- **Date:** 2026-06-09
- **Project:** `claude-memory`
- **Decision IDs:** `SCM-S55-D1` (organic-only, reject manual seeding), `SCM-S55-D2` (defer continuous threshold recalibration)
- **Mode:** Brainstormed with the user acting as Senior Architect / Sparring Partner.

---

## 1. Goal

Prove the self-learning loop works **organically, end-to-end**: real historical signal → mined skill candidate → curated → **promoted into the Skill Vault (`agent_skills`)**, with the candidate carrying **non-empty `source_summary_ids`** as proof it was *mined*, not hand-authored.

Explicitly **not** a goal: putting *a* skill in the Vault by any means. Manual `package_skill` seeding is rejected (`SCM-S55-D1`) — it would only recreate the Session-22 `livetest` artifact and prove nothing about autonomy.

---

## 2. Empirical Findings (ground truth, 2026-06-09)

Established via read-only inspection of code (`src/sleep/miner.ts`, `scripts/*.sql`) and a one-time read-only DB probe (the probe tripped a security guard for reading `service_role` from `.env`; **all future DB access goes through vetted MCP tools**). Point-in-time facts to re-confirm at implementation via MCP:

| Signal | Value |
|---|---|
| `trajectory_summaries` rows (all projects) | **0** |
| `memory_chunks` by size | >16KB **0** · 8–16KB **0** · 4–8KB **8** · 2–4KB **40** · <2KB **2399** (total 2447) |
| `archive_backlog` `status='done'` | **144** (the only status present) |
| Existing skill candidates | 2 — both Session-22 synthetic `livetest` seeds (`source_summary_ids: []`) |
| Curriculum tasks | 2 — one `verified`, one `queued` **but expired since 2026-05-26** (latent bug) |
| Daemon budget mode | `off` — nothing is budget-blocked |
| Daemons | `sleep_learner`, `curriculum_scanner`, `graduation_scanner`, `clustering_scanner` all `enabled` and idle |

**Interpretation:** the daemons are awake and unblocked. The loop has *never* learned organically — every artifact is a hand-seeded test fixture.

---

## 3. Root Cause — Two Structural Blockers

The miner pipeline (`mineClusters`, `src/sleep/miner.ts:292`) is sound. Organic output is blocked by **two** independent data-linkage gaps:

### Blocker 1 — `trajectory_summaries` is empty
The miner reads **only** `trajectory_summaries` (`miner.ts:101-116`). That table is populated by the trajectory compactor, which only summarizes `memory_chunks` whose byte length exceeds `DEFAULT_MIN_BYTES = 16_000` (`src/trajectory/daemon.ts:20,90`). **Zero** chunks in this project cross that line (largest bucket is 4–8KB, 8 rows). The faucet is dry by design — this project stores small memory-notes, not large agent trajectories.

### Blocker 2 — the hard success-gate can never pass
After fetching summaries, `mineClusters` applies a **hard gate** (`miner.ts:306-312`):

```js
// "INNER JOIN semantics: keep only summaries whose source_chunk_id maps to
//  a successful archive_backlog row. failed/in-flight tasks must NEVER seed a candidate."
const successful = summaries.filter((s) => archiveByChunk.has(s.source_chunk_id));
if (successful.length === 0) return [];
```

`archiveByChunk` is `{chunk_id → archive_id}` for `done` rows **where `chunk_id IS NOT NULL`** (`miner.ts:124-142`). The `chunk_id` column exists (`scripts/013`) but is populated **only** when an archived task had a terminal-committed `workflow_checkpoint` linking a `source_chunk_id` (`scripts/014`). None of the 144 real `done` tasks went through that M4 path → **all have `chunk_id = NULL`** (expected; verify in dry-run) → `archiveByChunk` is empty → `successful` is empty → **the gate returns `[]` regardless of how many summaries exist.**

**Both blockers must be resolved together.** Fixing only Blocker 1 (backfilling summaries) still yields zero candidates because Blocker 2 rejects them.

---

## 4. Non-Goals / Out of Scope

- **`SCM-S55-D2` — Continuous threshold recalibration is DEFERRED.** Lowering `TRAJECTORY_COMPACTOR_MIN_BYTES` 16KB→8KB captures **zero** additional chunks (8–16KB bucket = 0). It is "vibes-based engineering" with no value today. Not touched this session.
- No changes to the miner clustering algorithm (trigram + cosine ≥ 0.85). The algorithm is correct.
- No manual `package_skill` authoring of the proof skill.
- No backfill of *all* history — strictly a targeted Sessions 51–54 slice.

---

## 5. Approach

Five work items. Item A is an isolated **Foundation Fix** committed **first**; items B–E are the feature.

### 5.A — Foundation Fix: Curriculum TTL expiry (isolated, ships FIRST)
**Bug:** the `'expired'` status exists in the CHECK constraint (`scripts/015_curriculum_tasks.sql:37`) and the Zod enum (`src/tools/curriculum.ts:52`), but **no code path ever writes it**. `pull_next_curriculum_task` only *skips* expired rows (`...and (ct.expires_at is null or ct.expires_at > now())`, `015:~235`), leaving them frozen at `queued` forever (e.g. task id=6, expired 2026-05-26).

**Fix (SQL-side, atomic):** new idempotent migration `scripts/029_curriculum_ttl_expiry.sql`:
1. `CREATE OR REPLACE FUNCTION expire_curriculum_tasks(p_project_id text DEFAULT NULL) RETURNS integer` —
   ```sql
   UPDATE curriculum_tasks
      SET status = 'expired', updated_at = now()
    WHERE status = 'queued'
      AND expires_at IS NOT NULL
      AND expires_at <= now()
      AND (p_project_id IS NULL OR project_id = p_project_id);
   -- return affected row count via GET DIAGNOSTICS
   ```
2. `CREATE OR REPLACE` on `pull_next_curriculum_task` to call the sweep **before** its SELECT (lazy expiry on every claim — no extra round-trip).
3. The curriculum daemon (`src/curriculum/daemon.ts`) calls `expire_curriculum_tasks()` once per tick, so stale `queued` rows expire even when nothing is pulling.

**Test:** insert a `queued` row with `expires_at` in the past → assert it becomes `expired` after the sweep / a pull. Lands in the curriculum test suite.

> Note: this bug is *independent* of the mining path — it is fixed first per the user's directive and the **Foundation First / No Entangled Commits** rule, not because mining depends on it.

### 5.B — Unblock Blocker 2: populate `archive_backlog.chunk_id`
**Target:** ~6–10 `done` tasks spanning **2–3 genuinely recurring themes** (e.g. ship-gate eval runs, foundation-fix commits, graph-rerank eval cycles) so each theme has **≥2 members** — the minimum for a `minFreq=2` cluster to form.

For each, set `chunk_id` to the `memory_chunks.id` that genuinely records that task's work. This is real provenance (a completed task linked to the chunk documenting it), not fabrication. Only `status='done'` rows are touched, honoring the gate's intent ("failed/in-flight must never seed"). The dry-run prints every proposed task→chunk link for human approval before `--confirm`.

### 5.C — Backfill `trajectory_summaries` from real content (Blocker 1)
For each chosen `memory_chunks` row from 5.B: generate a **real** summary via the *same Ollama summarizer the compactor uses* and insert a `trajectory_summaries` row (`source_chunk_id` = that chunk id, plus `summary_embedding` from `nomic-embed-text`, 768-dim). Honors the `UNIQUE(project_id, source_chunk_id)` constraint (`scripts/011:73`). No fabricated text.

**Mechanism:** a one-time, idempotent, **dry-run-default** backfill script (mirrors the proven `scripts/backup-and-remove.ts` safety pattern: dotenv fail-fast, dry-run, `--confirm`, JSON manifest sidecar for rollback). It uses the project's existing Supabase client and is committed + reviewed — *not* an ad-hoc prod query.

### 5.D — Clustering tuning: `minFreq` 3 → 2 (reversible)
Set `SLEEP_LEARNER_MIN_FREQ=2` (`miner.ts:296`). At small backfill scale, requiring 3 co-clustering summaries is too strict; 2 doubles cluster-survival odds. **Keep `COSINE_THRESHOLD = 0.85`** (`miner.ts:257`) — we do not weaken the similarity/quality bar. Reversible env flag.

### 5.E — End-to-end proof: mine → curate → promote
1. Trigger a `sleep_learner` cycle (manual `runOnce` alias or the hourly tick).
2. Expect ≥1 `skill_candidate` with **non-empty `source_summary_ids`**.
3. `compose_skill_candidate` (fill `proposed_name` + ordered `proposed_steps`) → `promote_skill_candidate` → row appears in `agent_skills`.
4. Confirm `request_skill` retrieves it.

---

## 6. Integrity Clause (NON-NEGOTIABLE)

We feed **real** signal (real chunks, real Ollama summaries, truthful task→chunk links) and **accept whatever the miner returns**. We will **not**:
- hand-craft summaries engineered to clear cosine 0.85,
- link arbitrary chunks to tasks just to make the gate pass,
- lower `COSINE_THRESHOLD` to force a cluster.

**If Sessions 51–54 do not cluster at `minFreq=2` / cosine 0.85, that is a TRUE NEGATIVE we report honestly** — a real finding about signal density — and we tune from evidence, not fake a green light. Forcing it would just rebuild the S22 `livetest` in disguise.

---

## 7. Commit Sequencing (No Entangled Commits)

1. **Commit 1 (Foundation Fix):** `scripts/029_curriculum_ttl_expiry.sql` + daemon tick call + test. Isolated.
2. **Commit 2 (Backfill tooling):** the idempotent, dry-run backfill script (5.B + 5.C) + its test. No data mutated yet (dry-run).
3. **Commit 3 (Tuning + proof):** `SLEEP_LEARNER_MIN_FREQ=2` config; run the backfill with `--confirm`; execute the proof; record the resulting candidate/skill IDs (or the true-negative finding) in the session report.

---

## 8. Rollback & Reversibility

- **TTL migration:** idempotent (`CREATE OR REPLACE`); no destructive DDL.
- **Backfill:** every inserted `trajectory_summaries` id and every `archive_backlog.chunk_id` UPDATE (old value NULL) recorded in a manifest sidecar; a `--rollback <manifest>` mode deletes the inserts and restores `chunk_id` to NULL.
- **Tuning:** `SLEEP_LEARNER_MIN_FREQ` is an env flag; revert to 3 to restore prior behavior.

---

## 9. Acceptance Criteria

1. A past-expiry `queued` curriculum task transitions to `expired` (test green).
2. After backfill, `trajectory_summaries` for `claude-memory` is non-zero with real, embedded summaries linked to real `done` chunks.
3. A `sleep_learner` cycle produces a `skill_candidate` with **non-empty `source_summary_ids`** — OR a documented true-negative (no cluster ≥2 at cosine 0.85) with the cluster diagnostics captured.
4. On success: the candidate is promoted to `agent_skills` and retrievable via `request_skill`.
5. `npm run build` + tests green; no placeholders/TODOs; no `.tmp` at root.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Real S51–54 summaries don't cluster (too dissimilar) | `minFreq=2`; choose chunks around genuinely recurring procedures; **accept true negative** if it still won't cluster (§6). |
| Picking the "right" chunk↔task link is ambiguous | Link only where a chunk clearly records the task; dry-run prints proposed links for human review before `--confirm`. |
| Ollama summary nondeterminism | Acceptable — embeddings drive clustering; record the model + run for reproducibility. |
| Touching `archive_backlog` (production table) | `done`-rows only; manifest + `--rollback`; reviewed script, not ad-hoc query. |
| Scope creep into the deferred threshold work | Explicitly out of scope (§4, `SCM-S55-D2`). |

---

## 11. Open Questions — verify at implementation (TDD)

1. Confirm via MCP/dry-run that the chosen `done` tasks' `chunk_id` is NULL (expected) before populating.
2. Confirm the exact full column set + NOT-NULL requirements for a `trajectory_summaries` INSERT (`scripts/011`).
3. Confirm the `sleep_learner` manual `runOnce` entrypoint exists (else rely on the hourly tick).
4. Confirm `compose_skill_candidate` accepts a mined candidate whose `proposed_name` is currently NULL.

---

## 12. Reference Map

| Concern | Location |
|---|---|
| Miner + hard gate + clustering | `src/sleep/miner.ts:101-142, 292-372` |
| Trajectory threshold | `src/trajectory/daemon.ts:20,52,90` |
| `trajectory_summaries` schema | `scripts/011_trajectory_compaction.sql` |
| `archive_backlog` schema + chunk_id | `scripts/005_archive_backlog.sql`, `scripts/013_archive_backlog_chunk_link.sql`, `scripts/014_workflow_checkpoints.sql` |
| Curriculum TTL bug | `scripts/015_curriculum_tasks.sql:37,~235`; `src/tools/curriculum.ts:52`; `src/curriculum/daemon.ts` |
| Skill candidate schema | `scripts/012_sleep_learning.sql` |
| Skill Vault | `scripts/010_agent_skills.sql` |
