# Session 57 — Report

**Branch:** `main` (PR #8 merged) · **Next session:** confirm CI is green · retire the cloud project · organic-learning backfill

## Summary
A coda to Session 56's Supabase → plain-PostgreSQL migration: published the signed master schematic into the docs, merged the whole v2.5.0 release to `main`, built a corruption-proof code-rendered schematic, and diagnosed the post-merge red CI.

## The arc
1. **Signed schematic in the docs.** Placed the finalized v2.5.0 Master Schematic at `docs/assets/Signed-SMC-v2.5.png` and pointed the README + ARCHITECTURE image embeds at it by name (renamed from the generic `schematic.png`).
2. **PR #8 merged to `main` (`777f947`).** The full v2.5.0 release — plain-PostgreSQL migration, the `pg` adapter behind `src/supabase.ts`, v2.5.0 docs, signed schematic — is now live on the default branch (which is what the public repo page shows).
3. **Code-rendered schematic (Remotion).** Built an editable, version-controllable master schematic at `C:\Users\saeee\scm-schematic` (Remotion → PNG, 1920×1080 + 2×). Every label is literal text — immune to the AI-image text corruption that repeatedly mangled the generated versions (`LANGUAGE`, `cloud_backlog`, `sync_artefacts`, `alternatives`).
4. **Post-merge CI diagnosis.** The merge landed over red checks (the merge was not blocked):
   - **Build & Test** — CI has no database (tests point at `placeholder.pooler.supabase.com`); the new eager `pg.Pool` adapter then fails to connect. Fix: add a `pgvector/pgvector:pg17` service + schema-provision step to `.github/workflows/ci.yml`.
   - **GitGuardian** — the flagged `POSTGRES_PASSWORD` is already scrubbed from code; the incident stays open until resolved on the GitGuardian dashboard (user action).

## Decisions
- **SCM-S57-D1** — maintain the master schematic as **code** (Remotion), not an AI-generated image: deterministic, perfect text, diff-able, and re-renderable in sync with the repo.

## Hurdles + solutions
- Public README still showed the old v2.3.2 image → it was the `main` branch; all v2.5.0 work was in PR #8 → merged PR #8 into `main`.
- The AI image generator corrupted tiny labels on every regeneration → rebuilt the schematic in code (Remotion).

## Remaining / Handover
- **CI green:** add the Postgres + pgvector service to `ci.yml` (this session) and confirm Build & Test passes.
- **GitGuardian:** mark the `POSTGRES_PASSWORD` incident resolved on the GitGuardian dashboard (user).
- **Cloud Supabase:** retire the cloud project — data is fully backed up.
- **Organic-learning backfill:** the scoped build in `docs/superpowers/plans/2026-06-25-S56-organic-learning-backfill.md`.

## Branch state
`main` @ `777f947` (merge) + this wrap-up. The CI Postgres-service fix follows immediately.
