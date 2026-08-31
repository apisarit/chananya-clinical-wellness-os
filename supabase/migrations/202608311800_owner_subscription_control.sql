begin;

-- ============================================================
-- CNYOS OWNER SUBSCRIPTION CONTROL
--
-- Subscription suspension is a database authorization boundary. The
-- tenant functions below require both an operationally active clinic and an
-- active subscription, so changing the state immediately removes the clinic
-- from current_clinic_id(), current_access_context() and tenant RLS evaluation.
-- The browser console never receives a service-role credential.
-- ============================================================

alter table public.clinics
  add column if not exists subscription_state text not null default 'active',
  add column if not exists subscription_version bigint not null default 1,
  add column if not exists subscription_changed_at timestamptz,
  add column if not exists subscription_changed_by text,
  add column if not exists subscription_reason text;

update public.clinics
set subscription_state = case when active then 'active' else 'suspended' end,
    subscription_changed_at = coalesce(subscription_changed_at, updated_at, now()),
    subscription_changed_by = coalesce(subscription_changed_by, 'migration:202608311800'),
    subscription_reason = coalesce(subscription_reason, 'Initial state derived from clinics.active')
where subscription_state is distinct from case when active then 'active' else 'suspended' end
   or subscription_changed_at is null
   or subscription_changed_by is null
   or subscription_reason is null;

alter table public.clinics drop constraint if exists clinics_subscription_state_check;
alter table public.clinics
  add constraint clinics_subscription_state_check
  check (subscription_state in ('active','suspended'));

alter table public.clinics drop constraint if exists clinics_subscription_version_check;
alter table public.clinics
  add constraint clinics_subscription_version_check
  check (subscription_version > 0);

-- Preserve clinics.active as the operational lifecycle flag so managed and
-- encrypted backups can continue while a commercial subscription is OFF.
-- Every end-user authorization primitive independently requires the
-- subscription state to be active on each database request.
create or replace function public.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.clinic_id
  from public.clinic_memberships m
  join public.clinics c
    on c.id = m.clinic_id
   and c.active
   and c.subscription_state = 'active'
  where m.profile_id = auth.uid()
    and m.active
  order by m.is_primary desc, m.joined_at
  limit 1;
$$;

create or replace function public.is_clinic_member(
  p_clinic_id uuid,
  p_allowed_roles text[] default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_clinic_id = public.current_clinic_id()
    and exists (
      select 1
      from public.clinic_memberships m
      join public.clinics c
        on c.id = m.clinic_id
       and c.active
       and c.subscription_state = 'active'
      where m.clinic_id = p_clinic_id
        and m.profile_id = auth.uid()
        and m.active
        and (p_allowed_roles is null or m.clinic_role = any(p_allowed_roles))
    );
$$;

create or replace function public.current_department_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.clinic_role
    from public.clinic_memberships m
    join public.clinics c
      on c.id = m.clinic_id
     and c.active
     and c.subscription_state = 'active'
    where m.profile_id = auth.uid()
      and m.active
    order by m.is_primary desc, m.joined_at
    limit 1
  ), 'viewer');
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_clinic_id() is not null
     and exists (
       select 1 from public.profiles p
       where p.id = auth.uid() and p.system_role = 'super_admin'
     );
$$;

create or replace function public.has_role(allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_clinic_id() is not null
     and (
       public.is_super_admin()
       or public.current_user_role() = any(allowed)
       or (
         public.current_department_role() = 'doctor'
         and 'practitioner' = any(allowed)
       )
     );
$$;

create or replace function public.department_can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null or public.current_clinic_id() is null then false
    when public.is_super_admin() then true
    when p_capability = 'governance' then
      exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.system_role = 'admin'
      ) or public.current_department_role() in ('owner','admin')
    when p_capability = 'patient_read' then
      public.current_department_role() in ('practitioner','doctor','reception','pharmacy','billing')
    when p_capability = 'patient_registry' then
      public.current_department_role() in ('practitioner','doctor','reception')
    when p_capability = 'clinical' then
      public.current_department_role() in ('practitioner','doctor')
    when p_capability = 'pharmacy' then
      public.current_department_role() = 'pharmacy'
    when p_capability = 'product_read' then
      public.current_department_role() in ('practitioner','doctor','pharmacy','production','inventory','quality')
    when p_capability = 'product_write' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'inventory' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'production_read' then
      public.current_department_role() in ('production','inventory','quality')
    when p_capability = 'production' then
      public.current_department_role() in ('production','inventory')
    when p_capability = 'quality' then
      public.current_department_role() = 'quality'
    when p_capability = 'billing' then
      public.current_department_role() = 'billing'
    else false
  end;
$$;

create or replace function public.current_access_context()
returns table (
  clinic_id uuid,
  clinic_code text,
  clinic_name text,
  clinic_role text,
  system_role text,
  effective_role text,
  ready boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.code,
    c.name_th,
    m.clinic_role,
    p.system_role,
    case
      when p.system_role = 'super_admin' then 'super_admin'
      when p.system_role = 'admin' or m.clinic_role in ('owner','admin') then 'admin'
      else m.clinic_role
    end,
    true
  from public.profiles p
  join public.clinic_memberships m
    on m.profile_id = p.id and m.active
  join public.clinics c
    on c.id = m.clinic_id
   and c.active
   and c.subscription_state = 'active'
  where p.id = auth.uid()
  order by m.is_primary desc, m.joined_at
  limit 1;
$$;

revoke all on function public.current_clinic_id() from public;
revoke all on function public.is_clinic_member(uuid,text[]) from public;
revoke all on function public.current_department_role() from public;
revoke all on function public.is_super_admin() from public;
revoke all on function public.has_role(text[]) from public;
revoke all on function public.department_can(text) from public;
revoke all on function public.current_access_context() from public;
grant execute on function public.current_clinic_id() to authenticated, service_role;
grant execute on function public.is_clinic_member(uuid,text[]) to authenticated, service_role;
grant execute on function public.current_department_role() to authenticated, service_role;
grant execute on function public.is_super_admin() to authenticated, service_role;
grant execute on function public.has_role(text[]) to authenticated, service_role;
grant execute on function public.department_can(text) to authenticated, service_role;
grant execute on function public.current_access_context() to authenticated;

create table if not exists public.clinic_subscription_control_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  clinic_code text not null,
  previous_state text not null check (previous_state in ('active','suspended')),
  new_state text not null check (new_state in ('active','suspended')),
  subscription_version bigint not null check (subscription_version > 0),
  reason text not null check (char_length(reason) between 8 and 500),
  actor_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now()
);

create index if not exists clinic_subscription_events_clinic_created_idx
  on public.clinic_subscription_control_events(clinic_id, created_at desc);

alter table public.clinic_subscription_control_events enable row level security;
revoke all on public.clinic_subscription_control_events from public, anon, authenticated, service_role;
grant select on public.clinic_subscription_control_events to service_role;

-- Customers may read their own active clinic metadata. Subscription control
-- remains service-role only even if table grants are broadened in the future.
drop policy if exists clinics_admin_manage on public.clinics;
revoke insert, update, delete on public.clinics from anon, authenticated;

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
set search_path = public
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

create or replace function public.set_clinic_subscription_state(
  p_request_id uuid,
  p_clinic_id uuid,
  p_expected_clinic_code text,
  p_enabled boolean,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic public.clinics%rowtype;
  v_existing public.clinic_subscription_control_events%rowtype;
  v_new_state text := case when p_enabled then 'active' else 'suspended' end;
  v_reason text := trim(coalesce(p_reason, ''));
  v_actor_email text := lower(trim(coalesce(p_actor_email, '')));
  v_version bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;
  if p_request_id is null or p_clinic_id is null or p_enabled is null or p_actor_user_id is null then
    raise exception 'CNYOS_OWNER_CONTROL_INPUT_REQUIRED';
  end if;
  if char_length(v_reason) < 8 or char_length(v_reason) > 500 then
    raise exception 'CNYOS_OWNER_REASON_INVALID';
  end if;
  if char_length(v_actor_email) > 320 or position('@' in v_actor_email) < 2 then
    raise exception 'CNYOS_OWNER_EMAIL_INVALID';
  end if;

  select * into v_existing
  from public.clinic_subscription_control_events e
  where e.request_id = p_request_id;

  if found then
    if v_existing.clinic_id <> p_clinic_id
       or v_existing.new_state <> v_new_state
       or v_existing.actor_user_id <> p_actor_user_id
       or v_existing.actor_email <> v_actor_email
       or v_existing.reason <> v_reason
       or upper(v_existing.clinic_code) <> upper(trim(coalesce(p_expected_clinic_code, ''))) then
      raise exception 'CNYOS_OWNER_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'clinicId', v_existing.clinic_id,
      'clinicCode', v_existing.clinic_code,
      'enabled', v_existing.new_state = 'active',
      'state', v_existing.new_state,
      'version', v_existing.subscription_version,
      'changedAt', v_existing.created_at,
      'idempotent', true
    );
  end if;

  select * into v_clinic
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if not found then raise exception 'CNYOS_OWNER_CLINIC_NOT_FOUND'; end if;
  if upper(trim(coalesce(p_expected_clinic_code, ''))) <> upper(v_clinic.code) then
    raise exception 'CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH';
  end if;

  if v_clinic.subscription_state = v_new_state then
    insert into public.clinic_subscription_control_events (
      request_id,
      clinic_id,
      clinic_code,
      previous_state,
      new_state,
      subscription_version,
      reason,
      actor_user_id,
      actor_email
    ) values (
      p_request_id,
      v_clinic.id,
      v_clinic.code,
      v_clinic.subscription_state,
      v_new_state,
      v_clinic.subscription_version,
      v_reason,
      p_actor_user_id,
      v_actor_email
    );
    return jsonb_build_object(
      'clinicId', v_clinic.id,
      'clinicCode', v_clinic.code,
      'enabled', v_clinic.subscription_state = 'active',
      'state', v_clinic.subscription_state,
      'version', v_clinic.subscription_version,
      'changedAt', v_clinic.subscription_changed_at,
      'idempotent', true
    );
  end if;

  v_version := v_clinic.subscription_version + 1;
  update public.clinics
  set subscription_state = v_new_state,
      subscription_version = v_version,
      subscription_changed_at = now(),
      subscription_changed_by = v_actor_email,
      subscription_reason = v_reason,
      updated_at = now()
  where id = v_clinic.id;

  insert into public.clinic_subscription_control_events (
    request_id,
    clinic_id,
    clinic_code,
    previous_state,
    new_state,
    subscription_version,
    reason,
    actor_user_id,
    actor_email
  ) values (
    p_request_id,
    v_clinic.id,
    v_clinic.code,
    v_clinic.subscription_state,
    v_new_state,
    v_version,
    v_reason,
    p_actor_user_id,
    v_actor_email
  );

  return jsonb_build_object(
    'clinicId', v_clinic.id,
    'clinicCode', v_clinic.code,
    'enabled', p_enabled,
    'state', v_new_state,
    'version', v_version,
    'changedAt', now(),
    'idempotent', false
  );
end;
$$;

revoke all on function public.list_owner_subscription_clinics() from public;
revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text) from public;
grant execute on function public.list_owner_subscription_clinics() to service_role;
grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text) to service_role;

-- Preserve subscription control evidence in the encrypted transaction/audit
-- domain. clinics.active remains true during a commercial suspension, so the
-- service-role backup path continues to run while all end-user RLS is denied.
alter function public.export_clinic_backup_domain(uuid,text)
  rename to export_clinic_backup_domain_v20260829;

create or replace function public.export_clinic_backup_domain(
  p_clinic_id uuid,
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_export jsonb;
  v_data jsonb;
  v_included jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_export := public.export_clinic_backup_domain_v20260829(p_clinic_id,p_domain);
  v_data := coalesce(v_export->'data','{}'::jsonb);
  if p_domain = 'transactions' then
    v_data := v_data || jsonb_build_object(
      'clinic_subscription_control_events',coalesce((
        select jsonb_agg(to_jsonb(e) order by e.created_at,e.id)
        from public.clinic_subscription_control_events e
        where e.clinic_id = p_clinic_id
      ),'[]'::jsonb)
    );
  end if;
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb)
  into v_included from jsonb_object_keys(v_data) as keys(k);
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_export,'{schema_version}','"2026-08-31.1"'::jsonb),
      '{included_tables}',v_included
    ),
    '{data}',v_data
  );
end;
$$;

revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table (
  ready boolean,
  schema_version text,
  domain_count integer,
  patient_table_count integer,
  product_table_count integer,
  pharmacy_table_count integer,
  transaction_table_count integer,
  managed_database_restore_required boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select true,'2026-08-31.1',4,31,16,7,11,true
  where auth.role()='service_role' or public.is_super_admin();
$$;

revoke all on function public.backup_restore_contract_healthcheck() from public,anon;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;

alter function public.verify_clinic_restore_trace(uuid)
  rename to verify_clinic_restore_trace_v20260829;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trace jsonb;
  v_counts jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_trace := public.verify_clinic_restore_trace_v20260829(p_clinic_id);
  v_counts := coalesce(v_trace->'counts','{}'::jsonb) || jsonb_build_object(
    'clinic_subscription_control_events',(
      select count(*) from public.clinic_subscription_control_events e where e.clinic_id=p_clinic_id
    )
  );
  return jsonb_set(
    jsonb_set(v_trace,'{schema_version}','"2026-08-31.1"'::jsonb),
    '{counts}',v_counts
  );
end;
$$;

revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

commit;
