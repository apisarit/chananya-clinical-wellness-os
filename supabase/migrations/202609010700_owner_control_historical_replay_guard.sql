begin;

-- ============================================================
-- OWNER CONTROL FORWARD-MIGRATION MARKER
--
-- 202608311800 derives subscription_state from clinics.active and owns the
-- first owner-aware backup/restore wrappers. That already-applied file must
-- remain byte-for-byte immutable. Record its canonical repository SHA here;
-- later forward migrations install database guards without changing or
-- teaching the historical file about future schema. This marker is locked
-- and has no browser or service-role data path.
-- ============================================================

do $migration$
begin
  if to_regprocedure(
    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'
  ) is null then
    raise exception 'OWNER_SUBSCRIPTION_CONTROL_REQUIRED';
  end if;
  if to_regprocedure(
    'public.export_clinic_backup_domain_v20260831(uuid,text)'
  ) is null then
    raise exception 'OWNER_DRIVE_EXPORT_WRAPPER_REQUIRED';
  end if;
  if to_regprocedure(
    'public.verify_clinic_restore_trace_v20260831(uuid)'
  ) is null then
    raise exception 'OWNER_DRIVE_RESTORE_WRAPPER_REQUIRED';
  end if;
end
$migration$;

create table if not exists public.owner_control_historical_replay_guard (
  singleton boolean primary key default true check (singleton),
  protected_migration text not null unique
    check (protected_migration = '202608311800_owner_subscription_control'),
  historical_sha256 text not null unique
    check (
      historical_sha256 =
        'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
    ),
  installed_at timestamptz not null default now()
);

insert into public.owner_control_historical_replay_guard (
  singleton,
  protected_migration,
  historical_sha256
) values (
  true,
  '202608311800_owner_subscription_control',
  'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
)
on conflict (singleton) do nothing;

alter table public.owner_control_historical_replay_guard enable row level security;
alter table public.owner_control_historical_replay_guard force row level security;
revoke all on public.owner_control_historical_replay_guard
  from public, anon, authenticated, service_role;

comment on table public.owner_control_historical_replay_guard is
  'Locked forward marker: records the immutable 202608311800 SHA for terminal replay guards and migration-ledger verification.';

commit;

select 'OWNER_CONTROL_HISTORICAL_REPLAY_GUARD_READY' as status;
