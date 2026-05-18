-- Migration 019: M7 Phase B — admit 'graduation_scanner' into daemon_telemetry.
--
-- SCM-S33-D3. The M7 daemon (src/graduation/daemon.ts, Phase B) emits the
-- standard run_started / run_ended / run_errored event triplet to the shared
-- daemon_telemetry surface. Migration 018 added telemetry_pruner to the
-- daemon CHECK allow-list with the same drop-and-readd pattern; this
-- migration extends that pattern by one entry. Forward-only — never edit
-- prior migrations.

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
    'graduation_scanner'
  ));
