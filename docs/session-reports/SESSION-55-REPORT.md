# Session 55 — Report

**Branch:** `fix/scm-s55-egress-leak` (PR held) · **Next session:** 56

## Summary
Planned as the "organic learning loop" session, but pivoted to a production incident: the cloud Supabase project exceeded its Free-tier **egress** quota (12.671 GB vs 5 GB) and later its **Disk-IO** budget. We root-caused the egress, shipped a structural fix, and — after a failed server-side experiment took the cloud database offline — migrated the whole system to a local database and planned a full retirement of Supabase.

## The arc
1. **Egress investigation.** Refuted the "Vector Tax" hypothesis (that the search functions leaked embeddings) with first-hand evidence — the search function returns only small values, never vectors. Real cause: background workers (clustering + graph-extractor) pulling **all** 768-dimension embeddings to the app on a timer; the clustering worker re-pulled everything every 30 minutes during the Session 52–54 graph densification (~12 GB).
2. **Egress fix (shipped, all tests green on local):**
   - **Delta-gate** on the clustering worker — only re-cluster after a 24-hour cooldown or a >100-item change (`674c95d`), keeping the heavy math in the app (in-memory, zero database IO). Cluster writes hardened against a delete-mid-write race.
   - **Server-side embedding copy** for the graph-extractor (`cdc4b11`) — the vector never leaves the database.
3. **Server-side clustering — attempted and ABORTED.** Briefly moved the clustering math *into* the database; it melted the cloud Disk-IO budget (temporary tables + repeated update loops) and took the cloud offline. Reverted to the delta-gate above.
4. **Local migration.** Pointed everything at a local Supabase (Docker) stack; fixed the database connection to work without SSL locally (`9556520`); applied all migrations; added a permission migration so the app can call every database routine locally (`030` / `a259960`). Verified end-to-end.
5. **Data rescue planned (parked).** Wrote a precise, data-only copy-out → restore runbook (`6699ad9`) to clone the cloud data into local once the user lifts the cloud restriction (~4 days, user-driven).
6. **Strategic plan.** Drafted the full plan to retire Supabase entirely in favor of a plain local database (Session 56).

## Hurdles + solutions
- **Cloud went unreachable mid-work** — diagnosed as self-inflicted Disk-IO exhaustion from the server-side clustering runs, not a random outage. → Abort, throttle, migrate local.
- **Local rejected SSL** → made direct database connections local-aware (SSL off for 127.0.0.1).
- **Database routines uncallable locally** (missing permissions for the app key) → migration `030`.
- **Dashboard showed the egress error after migrating** → traced to the app server still running the old cloud config (it serves the dashboard itself); fixed by restarting it. There was no separate dashboard config (verified) — the user's "separate frontend" hypothesis was disproven by tracing the code.

## Decisions (save to memory after the data rescue — local DB is an empty shell now)
- **SCM-S55-D1** — Egress root cause = background workers pulling full embeddings on a timer (not the search functions). Fix: in-app clustering + delta-gate + server-side embedding copy.
- **SCM-S55-D2** — Server-side clustering in the database is forbidden on constrained Postgres; temporary tables + repeated update loops exhaust Disk-IO. Keep heavy iterative math in the app; gate how often it runs.
- **SCM-S55-D3** — Migrated to a local Supabase (Docker); cloud abandoned (data rescue pending).
- **SCM-S55-D4** — Will retire Supabase entirely in favor of a plain PostgreSQL database with the vector add-on (Session 56) — the correct professional home for a single-user local memory system.

## Deferred to Session 56 (and why)
- **Data rescue** (parked) — user lifts the cloud restriction, then runs the rescue runbook.
- **Plain-database migration** — `docs/superpowers/plans/2026-06-13-go-fully-local-retire-supabase.md`, staged + tested.
- **Organic learning loop** (the original goal) — resumes once real data is local — `docs/superpowers/specs/2026-06-09-organic-learning-loop-design.md`.
- **Database-side memory steps** (backlog flush, saving the decisions above, vector sync) — skipped this wrap-up on purpose: the local database is an empty shell awaiting the rescue, so anything written now would be wiped by the restore. Resume post-rescue.
- **Core-3 docs refresh + version bump** — deferred to when this branch merges (after the migration), so the architecture is rewritten once against the settled design.

## Branch state (PR held)
`53008e7` infra config · `a259960` permissions (030) · `6699ad9` rescue runbook · `9556520` local-SSL · `cdc4b11` graph server-side copy · `674c95d` delta-gate · `efa1108`/`1d56e61`/`b7544ec` audit+plan+pivot docs · + this report, the go-local plan, and the parked organic-learning spec.
