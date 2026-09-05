begin;

-- ============================================================
-- OWNER SUBSCRIPTION OPTIMISTIC CONCURRENCY
--
-- public.clinics.subscription_version is the authoritative optimistic
-- concurrency token for Owner ON/OFF. A caller must submit the exact version
-- returned by list_owner_subscription_clinics(). Request UUIDs are serialized
-- independently so simultaneous retries are deterministic, while the clinic
-- row lock serializes distinct requests for the same tenant.
-- ============================================================

alter table public.clinic_subscription_control_events
  add column if not exists expected_version bigint;

-- Preserve historical evidence. A state-changing legacy event advanced the
-- version once; a legacy no-op event kept the current version.
update public.clinic_subscription_control_events
set expected_version = case
  when previous_state is distinct from new_state then subscription_version - 1
  else subscription_version
end
where expected_version is null;

alter table public.clinic_subscription_control_events
  alter column expected_version set not null;

alter table public.clinic_subscription_control_events
  drop constraint if exists clinic_subscription_event_expected_version_check;
alter table public.clinic_subscription_control_events
  add constraint clinic_subscription_event_expected_version_check
  check (expected_version > 0);

-- Subscription evidence is append-only. Corrections are represented by a
-- later Owner event, never by rewriting or deleting a committed event.
drop trigger if exists trg_clinic_subscription_control_events_append_only
  on public.clinic_subscription_control_events;
create trigger trg_clinic_subscription_control_events_append_only
before update or delete on public.clinic_subscription_control_events
for each row execute function public.reject_append_only_mutation();

-- Keep the list response backward-compatible: subscription_version remains
-- the browser/API concurrency token and is always returned with the state.
create or replace function public.list_owner_subscription_clinics()
returns table (
  clinic_id uuid,
  clinic_code text,
  clinic_name_th text,
  clinic_name_en text,
  enabled boolean,
  subscription_state text,
  subscription_version bigint,
  changed_at timestamptz,
  changed_by text,
  change_reason text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;

  return query
  select
    c.id,
    c.code,
    c.name_th,
    c.name_en,
    c.subscription_state = 'active',
    c.subscription_state,
    c.subscription_version,
    c.subscription_changed_at,
    c.subscription_changed_by,
    c.subscription_reason
  from public.clinics c
  order by c.code;
end;
$$;

-- Remove the legacy overload so PostgREST can only invoke the version-bound
-- transition. The conditional block also makes a reviewed forward migration
-- retry safe after the old overload has already been removed.
do $remove_legacy_owner_subscription_rpc$
begin
  if to_regprocedure(
    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'
  ) is not null then
    execute
      'revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text) from public, anon, authenticated, service_role';
    execute
      'drop function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)';
  end if;
end
$remove_legacy_owner_subscription_rpc$;

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
  v_clinic public.clinics%rowtype;
  v_existing public.clinic_subscription_control_events%rowtype;
  v_new_state text := case when p_enabled then 'active' else 'suspended' end;
  v_expected_clinic_code text := upper(trim(coalesce(p_expected_clinic_code, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_actor_email text := lower(trim(coalesce(p_actor_email, '')));
  v_version bigint;
  v_changed_at timestamptz;
  v_lock_attempt integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;
  if p_request_id is null
     or p_clinic_id is null
     or p_enabled is null
     or p_expected_version is null
     or p_actor_user_id is null then
    raise exception 'CNYOS_OWNER_CONTROL_INPUT_REQUIRED';
  end if;
  if p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'CNYOS_OWNER_REQUEST_ID_INVALID';
  end if;
  if p_expected_version < 1 then
    raise exception 'CNYOS_OWNER_SUBSCRIPTION_VERSION_INVALID';
  end if;
  if v_expected_clinic_code = '' then
    raise exception 'CNYOS_OWNER_CLINIC_CONFIRMATION_REQUIRED';
  end if;
  if char_length(v_reason) < 8 or char_length(v_reason) > 500 then
    raise exception 'CNYOS_OWNER_REASON_INVALID';
  end if;
  if char_length(v_actor_email) > 320
     or position('@' in v_actor_email) < 2
     or position('@' in v_actor_email) >= char_length(v_actor_email) then
    raise exception 'CNYOS_OWNER_EMAIL_INVALID';
  end if;

  -- Serialize this idempotency key independently of the clinic target. This
  -- prevents two simultaneous callers from reusing one request UUID with
  -- different payloads and racing the unique event constraint.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  -- Check once before locking the clinic (fast retry path), lock the tenant,
  -- then check again to close the simultaneous-retry window before mutation.
  for v_lock_attempt in 1..2 loop
    select * into v_existing
    from public.clinic_subscription_control_events e
    where e.request_id = p_request_id;

    if found then
      if v_existing.clinic_id <> p_clinic_id
         or upper(v_existing.clinic_code) <> v_expected_clinic_code
         or v_existing.new_state <> v_new_state
         or v_existing.expected_version <> p_expected_version
         or v_existing.reason <> v_reason
         or v_existing.actor_user_id <> p_actor_user_id
         or v_existing.actor_email <> v_actor_email then
        raise exception 'CNYOS_OWNER_REQUEST_ID_CONFLICT';
      end if;

      return jsonb_build_object(
        'clinicId', v_existing.clinic_id,
        'clinicCode', v_existing.clinic_code,
        'enabled', v_existing.new_state = 'active',
        'state', v_existing.new_state,
        'version', v_existing.subscription_version,
        'changedAt', v_existing.created_at,
        'changed', v_existing.previous_state is distinct from v_existing.new_state,
        'idempotent', true
      );
    end if;

    if v_lock_attempt = 1 then
      select * into v_clinic
      from public.clinics c
      where c.id = p_clinic_id
      for update;

      if not found then
        raise exception 'CNYOS_OWNER_CLINIC_NOT_FOUND';
      end if;
      if upper(v_clinic.code) <> v_expected_clinic_code then
        raise exception 'CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH';
      end if;
    end if;
  end loop;

  if v_clinic.subscription_version <> p_expected_version then
    raise exception 'CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT';
  end if;

  v_changed_at := now();

  if v_clinic.subscription_state = v_new_state then
    insert into public.clinic_subscription_control_events (
      request_id,
      clinic_id,
      clinic_code,
      previous_state,
      new_state,
      expected_version,
      subscription_version,
      reason,
      actor_user_id,
      actor_email,
      created_at
    ) values (
      p_request_id,
      v_clinic.id,
      v_clinic.code,
      v_clinic.subscription_state,
      v_new_state,
      p_expected_version,
      v_clinic.subscription_version,
      v_reason,
      p_actor_user_id,
      v_actor_email,
      v_changed_at
    );

    return jsonb_build_object(
      'clinicId', v_clinic.id,
      'clinicCode', v_clinic.code,
      'enabled', v_clinic.subscription_state = 'active',
      'state', v_clinic.subscription_state,
      'version', v_clinic.subscription_version,
      'changedAt', v_changed_at,
      'changed', false,
      'idempotent', false
    );
  end if;

  v_version := v_clinic.subscription_version + 1;
  update public.clinics
  set subscription_state = v_new_state,
      subscription_version = v_version,
      subscription_changed_at = v_changed_at,
      subscription_changed_by = v_actor_email,
      subscription_reason = v_reason,
      updated_at = v_changed_at
  where id = v_clinic.id
    and subscription_version = p_expected_version;

  if not found then
    raise exception 'CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT';
  end if;

  insert into public.clinic_subscription_control_events (
    request_id,
    clinic_id,
    clinic_code,
    previous_state,
    new_state,
    expected_version,
    subscription_version,
    reason,
    actor_user_id,
    actor_email,
    created_at
  ) values (
    p_request_id,
    v_clinic.id,
    v_clinic.code,
    v_clinic.subscription_state,
    v_new_state,
    p_expected_version,
    v_version,
    v_reason,
    p_actor_user_id,
    v_actor_email,
    v_changed_at
  );

  return jsonb_build_object(
    'clinicId', v_clinic.id,
    'clinicCode', v_clinic.code,
    'enabled', p_enabled,
    'state', v_new_state,
    'version', v_version,
    'changedAt', v_changed_at,
    'changed', true,
    'idempotent', false
  );
end;
$$;

revoke all on function public.list_owner_subscription_clinics()
  from public, anon, authenticated, service_role;
revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_owner_subscription_clinics()
  to service_role;
grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)
  to service_role;

commit;

select 'OWNER_SUBSCRIPTION_CONCURRENCY_READY' as status;
