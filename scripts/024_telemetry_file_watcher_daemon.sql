-- Migration 024: Epic G (Session 43 Phase 2) — admit 'file_watcher' to the
-- daemon_telemetry allow-list, and concurrently backfill 'clustering_scanner'
-- which has been emitting since M8.3 shipped (Session 41) but was never added
-- to the constraint and has therefore been logging silent stderr noise on
-- every run.
--
-- Pattern: drop-and-readd, same as migrations 018 + 019. Forward-only —
-- never edit a prior migration. The constraint name itself stays stable
-- (daemon_telemetry_daemon_allowed) so downstream queries / dashboards
-- continue to work without churn.
--
-- Note: 'graph_extractor' is intentionally NOT in this list. src/graph/daemon.ts
-- tracks its run state in-memory only (no daemon_telemetry insert path), so
-- admitting it here would be dead surface. If a future patch wires up
-- graph_extractor.emit() calls, a follow-up migration extends this list.

do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'daemon_telemetry'
       and c.conname = 'daemon_telemetry_daemon_allowed'
  ) then
    alter table public.daemon_telemetry drop constraint daemon_telemetry_daemon_allowed;
  end if;
end$$;

alter table public.daemon_telemetry
  add constraint daemon_telemetry_daemon_allowed
  check (daemon in (
    'sleep_learner',
    'curriculum_scanner',
    'trajectory_compactor',
    'telemetry_pruner',
    'graduation_scanner',
    'clustering_scanner',
    'file_watcher'
  ));
