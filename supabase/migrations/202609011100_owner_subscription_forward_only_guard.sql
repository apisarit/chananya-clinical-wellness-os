begin;

-- ============================================================
-- OWNER SUBSCRIPTION FORWARD-ONLY MUTATION GUARD
--
-- Historical migration 202608311800 is immutable. It contains a direct
-- UPDATE that derived subscription_state from clinics.active, so replaying it
-- after Owner Control launched could reactivate a suspended clinic and then
-- replace newer backup wrappers. Protect the state transition here, entirely
-- forward: every statement that targets subscription-control columns needs
-- both service-role request context and the transaction-local marker set by
-- the current Owner RPC wrapper. Browser roles have no direct UPDATE grant.
-- ============================================================

do $migration$
begin
  if not exists (
    select 1
    from public.owner_control_historical_replay_guard
    where singleton
      and protected_migration = '202608311800_owner_subscription_control'
      and historical_sha256 =
        'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
  ) then
    raise exception 'OWNER_CONTROL_FORWARD_MARKER_REQUIRED';
  end if;
  if to_regprocedure(
    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)'
  ) is null then
    raise exception 'OWNER_SUBSCRIPTION_CONCURRENCY_RPC_REQUIRED';
  end if;
end
$migration$;

-- Archive the reviewed concurrency implementation once. The public wrapper
-- below keeps the exact PostgREST signature and delegates every validation,
-- row lock, version check, idempotency check and append-only event write to
-- that implementation after setting the narrow mutation capability.
do $archive$
begin
  if to_regprocedure(
    'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)'
  ) is null then
    execute
      'alter function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) rename to set_clinic_subscription_state_v20260901';
  end if;
end
$archive$;

revoke all on function public.set_clinic_subscription_state_v20260901(
  uuid, uuid, text, boolean, bigint, text, uuid, text
)
  from public, anon, authenticated, service_role;

create or replace function public.guard_owner_subscription_forward_only()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role'
     or pg_catalog.current_setting(
       'cnyos.owner_subscription_forward_guard',
       true
     ) is distinct from 'service-role-rpc/v1' then
    raise exception 'CNYOS_OWNER_SUBSCRIPTION_HISTORICAL_REPLAY_BLOCKED'
      using errcode = '55000',
        detail = tg_table_schema || '.' || tg_table_name,
        hint = 'Change subscription state only through the current Owner Control service-role RPC.';
  end if;
  return null;
end;
$$;

revoke all on function public.guard_owner_subscription_forward_only()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_clinics_owner_subscription_forward_only
  on public.clinics;
create trigger trg_clinics_owner_subscription_forward_only
before update of
  subscription_state,
  subscription_version,
  subscription_changed_at,
  subscription_changed_by,
  subscription_reason
on public.clinics
for each statement execute function public.guard_owner_subscription_forward_only();

create or replace function public.set_clinic_subscription_state(
  p_request_id uuid,
  p_clinic_id uuid,
  p_expected_clinic_code text,
  p_enabled boolean,
  p_expected_version bigint,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;

  perform pg_catalog.set_config(
    'cnyos.owner_subscription_forward_guard',
    'service-role-rpc/v1',
    true
  );

  v_result := public.set_clinic_subscription_state_v20260901(
    p_request_id,
    p_clinic_id,
    p_expected_clinic_code,
    p_enabled,
    p_expected_version,
    p_reason,
    p_actor_user_id,
    p_actor_email
  );

  -- Do not leak the narrow trigger capability to a later statement in the
  -- caller's transaction after the reviewed state transition has finished.
  perform pg_catalog.set_config(
    'cnyos.owner_subscription_forward_guard',
    '',
    true
  );

  return v_result;
exception
  when others then
    perform pg_catalog.set_config(
      'cnyos.owner_subscription_forward_guard',
      '',
      true
    );
    raise;
end;
$$;

revoke all on function public.set_clinic_subscription_state(
  uuid, uuid, text, boolean, bigint, text, uuid, text
)
  from public, anon, authenticated, service_role;
grant execute on function public.set_clinic_subscription_state(
  uuid, uuid, text, boolean, bigint, text, uuid, text
)
  to service_role;

comment on function public.guard_owner_subscription_forward_only() is
  'Statement-level fail-closed guard for direct subscription-state mutation and historical migration replay.';

commit;

select 'OWNER_SUBSCRIPTION_FORWARD_ONLY_GUARD_READY' as status;
