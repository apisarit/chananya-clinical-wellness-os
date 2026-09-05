begin;

-- ============================================================
-- OWNER-MANAGED GOOGLE DRIVE BACKUP DESTINATIONS
--
-- Folder assignments are tenant- and environment-specific configuration.
-- The browser never receives the Google service-account credential: an
-- authenticated Netlify owner function validates Drive access, then invokes
-- these service-role-only RPCs. Direct table access stays closed, including
-- to service_role, so every change is versioned and recorded in an immutable
-- event ledger.
-- ============================================================

create table if not exists public.clinic_drive_backup_destinations (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  environment text not null,
  patients_folder_id text not null,
  products_folder_id text not null,
  pharmacy_folder_id text not null,
  transactions_folder_id text not null,
  manifests_folder_id text not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid not null,
  updated_by text not null,
  updated_reason text not null,
  primary key (clinic_id, environment),
  constraint clinic_drive_destination_environment_check
    check (environment in ('staging', 'production')),
  constraint clinic_drive_destination_version_check
    check (version > 0),
  constraint clinic_drive_destination_actor_check
    check (
      char_length(updated_by) between 3 and 320
      and position('@' in updated_by) between 2 and char_length(updated_by) - 1
      and updated_by = lower(trim(updated_by))
    ),
  constraint clinic_drive_destination_reason_check
    check (char_length(updated_reason) between 8 and 500),
  constraint clinic_drive_destination_folder_ids_check
    check (
      patients_folder_id = trim(patients_folder_id)
      and products_folder_id = trim(products_folder_id)
      and pharmacy_folder_id = trim(pharmacy_folder_id)
      and transactions_folder_id = trim(transactions_folder_id)
      and manifests_folder_id = trim(manifests_folder_id)
      and char_length(patients_folder_id) between 10 and 200
      and char_length(products_folder_id) between 10 and 200
      and char_length(pharmacy_folder_id) between 10 and 200
      and char_length(transactions_folder_id) between 10 and 200
      and char_length(manifests_folder_id) between 10 and 200
      and patients_folder_id ~ '^[A-Za-z0-9_-]+$'
      and products_folder_id ~ '^[A-Za-z0-9_-]+$'
      and pharmacy_folder_id ~ '^[A-Za-z0-9_-]+$'
      and transactions_folder_id ~ '^[A-Za-z0-9_-]+$'
      and manifests_folder_id ~ '^[A-Za-z0-9_-]+$'
      and patients_folder_id <> all (array[
        products_folder_id,
        pharmacy_folder_id,
        transactions_folder_id,
        manifests_folder_id
      ])
      and products_folder_id <> all (array[
        pharmacy_folder_id,
        transactions_folder_id,
        manifests_folder_id
      ])
      and pharmacy_folder_id <> all (array[
        transactions_folder_id,
        manifests_folder_id
      ])
      and transactions_folder_id <> manifests_folder_id
    )
);

create table if not exists public.clinic_drive_destination_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  clinic_code text not null,
  environment text not null,
  expected_version bigint not null,
  assignment_version bigint not null,
  previous_assignment jsonb not null,
  new_assignment jsonb not null,
  changed boolean not null,
  reason text not null,
  actor_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  constraint clinic_drive_event_environment_check
    check (environment in ('staging', 'production')),
  constraint clinic_drive_event_expected_version_check
    check (expected_version >= 0),
  constraint clinic_drive_event_assignment_version_check
    check (assignment_version > 0),
  constraint clinic_drive_event_previous_json_check
    check (jsonb_typeof(previous_assignment) = 'object'),
  constraint clinic_drive_event_new_json_check
    check (jsonb_typeof(new_assignment) = 'object'),
  constraint clinic_drive_event_reason_check
    check (char_length(reason) between 8 and 500),
  constraint clinic_drive_event_actor_email_check
    check (
      char_length(actor_email) between 3 and 320
      and position('@' in actor_email) between 2 and char_length(actor_email) - 1
      and actor_email = lower(trim(actor_email))
    )
);

create index if not exists clinic_drive_destination_events_clinic_created_idx
  on public.clinic_drive_destination_events(clinic_id, environment, created_at desc);

alter table public.clinic_drive_backup_destinations enable row level security;
alter table public.clinic_drive_destination_events enable row level security;

revoke all on public.clinic_drive_backup_destinations
  from public, anon, authenticated, service_role;
revoke all on public.clinic_drive_destination_events
  from public, anon, authenticated, service_role;

-- Corrections are represented by a later event. Even a table owner cannot
-- silently update or delete existing evidence through ordinary DML.
drop trigger if exists trg_clinic_drive_destination_events_append_only
  on public.clinic_drive_destination_events;
create trigger trg_clinic_drive_destination_events_append_only
before update or delete on public.clinic_drive_destination_events
for each row execute function public.reject_append_only_mutation();

create or replace function public.list_owner_drive_assignments()
returns table (
  clinic_id uuid,
  clinic_code text,
  clinic_name_th text,
  clinic_name_en text,
  clinic_active boolean,
  environment text,
  assigned boolean,
  patients_folder_id text,
  products_folder_id text,
  pharmacy_folder_id text,
  transactions_folder_id text,
  manifests_folder_id text,
  version bigint,
  updated_at timestamptz,
  updated_by_user_id uuid,
  updated_by text,
  reason text
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
    c.active,
    target_environment.environment,
    d.clinic_id is not null,
    d.patients_folder_id,
    d.products_folder_id,
    d.pharmacy_folder_id,
    d.transactions_folder_id,
    d.manifests_folder_id,
    coalesce(d.version, 0),
    d.updated_at,
    d.updated_by_user_id,
    d.updated_by,
    d.updated_reason
  from public.clinics c
  cross join (
    values ('staging'::text), ('production'::text)
  ) as target_environment(environment)
  left join public.clinic_drive_backup_destinations d
    on d.clinic_id = c.id
   and d.environment = target_environment.environment
  where c.active
  order by c.code, target_environment.environment;
end;
$$;

create or replace function public.get_clinic_drive_backup_destination(
  p_clinic_id uuid,
  p_environment text
)
returns table (
  clinic_id uuid,
  clinic_code text,
  environment text,
  patients_folder_id text,
  products_folder_id text,
  pharmacy_folder_id text,
  transactions_folder_id text,
  manifests_folder_id text,
  version bigint,
  updated_at timestamptz,
  updated_by_user_id uuid,
  updated_by text,
  updated_reason text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_environment text := lower(trim(coalesce(p_environment, '')));
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;
  if p_clinic_id is null then
    raise exception 'CNYOS_DRIVE_CLINIC_ID_REQUIRED';
  end if;
  if v_environment not in ('staging', 'production') then
    raise exception 'CNYOS_DRIVE_ENVIRONMENT_INVALID';
  end if;

  return query
  select
    d.clinic_id,
    c.code,
    d.environment,
    d.patients_folder_id,
    d.products_folder_id,
    d.pharmacy_folder_id,
    d.transactions_folder_id,
    d.manifests_folder_id,
    d.version,
    d.updated_at,
    d.updated_by_user_id,
    d.updated_by,
    d.updated_reason
  from public.clinic_drive_backup_destinations d
  join public.clinics c
    on c.id = d.clinic_id
   and c.active
  where d.clinic_id = p_clinic_id
    and d.environment = v_environment;
end;
$$;

create or replace function public.set_clinic_drive_assignment(
  p_request_id uuid,
  p_clinic_id uuid,
  p_expected_clinic_code text,
  p_environment text,
  p_patients_folder_id text,
  p_products_folder_id text,
  p_pharmacy_folder_id text,
  p_transactions_folder_id text,
  p_manifests_folder_id text,
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
  v_destination public.clinic_drive_backup_destinations%rowtype;
  v_existing public.clinic_drive_destination_events%rowtype;
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_expected_clinic_code text := upper(trim(coalesce(p_expected_clinic_code, '')));
  v_patients_folder_id text := trim(coalesce(p_patients_folder_id, ''));
  v_products_folder_id text := trim(coalesce(p_products_folder_id, ''));
  v_pharmacy_folder_id text := trim(coalesce(p_pharmacy_folder_id, ''));
  v_transactions_folder_id text := trim(coalesce(p_transactions_folder_id, ''));
  v_manifests_folder_id text := trim(coalesce(p_manifests_folder_id, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_actor_email text := lower(trim(coalesce(p_actor_email, '')));
  v_previous jsonb;
  v_new jsonb;
  v_version bigint;
  v_updated_at timestamptz;
  v_updated_by_user_id uuid;
  v_updated_by text;
  v_updated_reason text;
  v_changed boolean;
  v_destination_found boolean;
  v_lock_attempt integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'CNYOS_OWNER_SERVICE_ROLE_REQUIRED';
  end if;
  if p_request_id is null
     or p_clinic_id is null
     or p_expected_version is null
     or p_actor_user_id is null then
    raise exception 'CNYOS_DRIVE_ASSIGNMENT_INPUT_REQUIRED';
  end if;
  if p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'CNYOS_DRIVE_REQUEST_ID_INVALID';
  end if;
  if v_environment not in ('staging', 'production') then
    raise exception 'CNYOS_DRIVE_ENVIRONMENT_INVALID';
  end if;
  if p_expected_version < 0 then
    raise exception 'CNYOS_DRIVE_EXPECTED_VERSION_INVALID';
  end if;
  if char_length(v_reason) < 8 or char_length(v_reason) > 500 then
    raise exception 'CNYOS_OWNER_REASON_INVALID';
  end if;
  if char_length(v_actor_email) > 320
     or position('@' in v_actor_email) < 2
     or position('@' in v_actor_email) >= char_length(v_actor_email) then
    raise exception 'CNYOS_OWNER_EMAIL_INVALID';
  end if;
  if v_expected_clinic_code = '' then
    raise exception 'CNYOS_DRIVE_CLINIC_CONFIRMATION_REQUIRED';
  end if;
  if exists (
    select 1
    from unnest(array[
      v_patients_folder_id,
      v_products_folder_id,
      v_pharmacy_folder_id,
      v_transactions_folder_id,
      v_manifests_folder_id
    ]) as folder(folder_id)
    where char_length(folder.folder_id) not between 10 and 200
       or folder.folder_id !~ '^[A-Za-z0-9_-]+$'
  ) then
    raise exception 'CNYOS_DRIVE_FOLDER_ID_INVALID';
  end if;
  if (
    select count(distinct folder.folder_id)
    from unnest(array[
      v_patients_folder_id,
      v_products_folder_id,
      v_pharmacy_folder_id,
      v_transactions_folder_id,
      v_manifests_folder_id
    ]) as folder(folder_id)
  ) <> 5 then
    raise exception 'CNYOS_DRIVE_FOLDER_IDS_NOT_DISTINCT';
  end if;

  -- Serialize the idempotency key independently of the target clinic. This
  -- makes simultaneous retries deterministic even if a conflicting caller
  -- attempts to reuse the same request UUID for another tenant.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  -- First honor a completed request even if the clinic lifecycle changed
  -- after the original commit. If it is new, the clinic row lock serializes
  -- all destination changes for this tenant. The second lookup closes the
  -- simultaneous-retry window before mutation.
  for v_lock_attempt in 1..2 loop
    select * into v_existing
    from public.clinic_drive_destination_events e
    where e.request_id = p_request_id;

    if found then
      if v_existing.clinic_id <> p_clinic_id
         or upper(v_existing.clinic_code) <> v_expected_clinic_code
         or v_existing.environment <> v_environment
         or v_existing.expected_version <> p_expected_version
         or v_existing.reason <> v_reason
         or v_existing.actor_user_id <> p_actor_user_id
         or v_existing.actor_email <> v_actor_email
         or v_existing.new_assignment->>'patientsFolderId' is distinct from v_patients_folder_id
         or v_existing.new_assignment->>'productsFolderId' is distinct from v_products_folder_id
         or v_existing.new_assignment->>'pharmacyFolderId' is distinct from v_pharmacy_folder_id
         or v_existing.new_assignment->>'transactionsFolderId' is distinct from v_transactions_folder_id
         or v_existing.new_assignment->>'manifestsFolderId' is distinct from v_manifests_folder_id then
        raise exception 'CNYOS_DRIVE_REQUEST_ID_CONFLICT';
      end if;

      return v_existing.new_assignment || jsonb_build_object(
        'clinicId', v_existing.clinic_id,
        'clinicCode', v_existing.clinic_code,
        'environment', v_existing.environment,
        'changed', v_existing.changed,
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
      if not v_clinic.active then
        raise exception 'CNYOS_DRIVE_CLINIC_INACTIVE';
      end if;
      if upper(v_clinic.code) <> v_expected_clinic_code then
        raise exception 'CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH';
      end if;
    end if;
  end loop;

  -- Keep a scheduled export bound to the assignment it resolved after taking
  -- its lease. Owner changes may resume as soon as the run completes/fails or
  -- its existing 30-minute lease becomes stale.
  if exists (
    select 1
    from public.backup_export_runs r
    where r.clinic_id = p_clinic_id
      and r.status = 'started'
      and r.started_at > pg_catalog.now() - interval '30 minutes'
  ) then
    raise exception 'CNYOS_DRIVE_BACKUP_RUN_ACTIVE';
  end if;

  select * into v_destination
  from public.clinic_drive_backup_destinations d
  where d.clinic_id = p_clinic_id
    and d.environment = v_environment
  for update;
  v_destination_found := found;

  -- A folder may belong to exactly one clinic/environment assignment. A
  -- namespace-wide advisory lock makes the cross-row/cross-column check safe
  -- when two tenants are assigned concurrently.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cnyos:drive-folder-assignment-registry', 0)
  );
  if exists (
    select 1
    from public.clinic_drive_backup_destinations other
    where (other.clinic_id, other.environment) <> (p_clinic_id, v_environment)
      and array[
        other.patients_folder_id,
        other.products_folder_id,
        other.pharmacy_folder_id,
        other.transactions_folder_id,
        other.manifests_folder_id
      ] && array[
        v_patients_folder_id,
        v_products_folder_id,
        v_pharmacy_folder_id,
        v_transactions_folder_id,
        v_manifests_folder_id
      ]
  ) then
    raise exception 'CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED';
  end if;

  if v_destination_found then
    if p_expected_version <> v_destination.version then
      raise exception 'CNYOS_DRIVE_VERSION_CONFLICT';
    end if;
    v_previous := jsonb_build_object(
      'environment', v_destination.environment,
      'patientsFolderId', v_destination.patients_folder_id,
      'productsFolderId', v_destination.products_folder_id,
      'pharmacyFolderId', v_destination.pharmacy_folder_id,
      'transactionsFolderId', v_destination.transactions_folder_id,
      'manifestsFolderId', v_destination.manifests_folder_id,
      'version', v_destination.version,
      'updatedAt', v_destination.updated_at,
      'updatedByUserId', v_destination.updated_by_user_id,
      'updatedBy', v_destination.updated_by,
      'reason', v_destination.updated_reason
    );
    v_changed := v_destination.patients_folder_id is distinct from v_patients_folder_id
      or v_destination.products_folder_id is distinct from v_products_folder_id
      or v_destination.pharmacy_folder_id is distinct from v_pharmacy_folder_id
      or v_destination.transactions_folder_id is distinct from v_transactions_folder_id
      or v_destination.manifests_folder_id is distinct from v_manifests_folder_id;
  else
    if p_expected_version <> 0 then
      raise exception 'CNYOS_DRIVE_VERSION_CONFLICT';
    end if;
    v_previous := jsonb_build_object(
      'environment', v_environment,
      'patientsFolderId', null,
      'productsFolderId', null,
      'pharmacyFolderId', null,
      'transactionsFolderId', null,
      'manifestsFolderId', null,
      'version', 0,
      'updatedAt', null,
      'updatedByUserId', null,
      'updatedBy', null,
      'reason', null
    );
    v_changed := true;
  end if;

  if v_changed then
    v_version := coalesce(v_destination.version, 0) + 1;
    v_updated_at := now();
    v_updated_by_user_id := p_actor_user_id;
    v_updated_by := v_actor_email;
    v_updated_reason := v_reason;

    insert into public.clinic_drive_backup_destinations (
      clinic_id,
      environment,
      patients_folder_id,
      products_folder_id,
      pharmacy_folder_id,
      transactions_folder_id,
      manifests_folder_id,
      version,
      updated_at,
      updated_by_user_id,
      updated_by,
      updated_reason
    ) values (
      p_clinic_id,
      v_environment,
      v_patients_folder_id,
      v_products_folder_id,
      v_pharmacy_folder_id,
      v_transactions_folder_id,
      v_manifests_folder_id,
      v_version,
      v_updated_at,
      v_updated_by_user_id,
      v_updated_by,
      v_updated_reason
    )
    on conflict (clinic_id, environment) do update
    set patients_folder_id = excluded.patients_folder_id,
        products_folder_id = excluded.products_folder_id,
        pharmacy_folder_id = excluded.pharmacy_folder_id,
        transactions_folder_id = excluded.transactions_folder_id,
        manifests_folder_id = excluded.manifests_folder_id,
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_by = excluded.updated_by,
        updated_reason = excluded.updated_reason;
  else
    v_version := v_destination.version;
    v_updated_at := v_destination.updated_at;
    v_updated_by_user_id := v_destination.updated_by_user_id;
    v_updated_by := v_destination.updated_by;
    v_updated_reason := v_destination.updated_reason;
  end if;

  v_new := jsonb_build_object(
    'environment', v_environment,
    'patientsFolderId', v_patients_folder_id,
    'productsFolderId', v_products_folder_id,
    'pharmacyFolderId', v_pharmacy_folder_id,
    'transactionsFolderId', v_transactions_folder_id,
    'manifestsFolderId', v_manifests_folder_id,
    'version', v_version,
    'updatedAt', v_updated_at,
    'updatedByUserId', v_updated_by_user_id,
    'updatedBy', v_updated_by,
    'reason', v_updated_reason
  );

  insert into public.clinic_drive_destination_events (
    request_id,
    clinic_id,
    clinic_code,
    environment,
    expected_version,
    assignment_version,
    previous_assignment,
    new_assignment,
    changed,
    reason,
    actor_user_id,
    actor_email
  ) values (
    p_request_id,
    v_clinic.id,
    v_clinic.code,
    v_environment,
    p_expected_version,
    v_version,
    v_previous,
    v_new,
    v_changed,
    v_reason,
    p_actor_user_id,
    v_actor_email
  );

  return v_new || jsonb_build_object(
    'clinicId', v_clinic.id,
    'clinicCode', v_clinic.code,
    'changed', v_changed,
    'idempotent', false
  );
end;
$$;

revoke all on function public.list_owner_drive_assignments()
  from public, anon, authenticated, service_role;
revoke all on function public.get_clinic_drive_backup_destination(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_clinic_drive_assignment(
  uuid, uuid, text, text, text, text, text, text, text, bigint, text, uuid, text
)
  from public, anon, authenticated, service_role;

grant execute on function public.list_owner_drive_assignments()
  to service_role;
grant execute on function public.get_clinic_drive_backup_destination(uuid, text)
  to service_role;
grant execute on function public.set_clinic_drive_assignment(
  uuid, uuid, text, text, text, text, text, text, text, bigint, text, uuid, text
)
  to service_role;

commit;

select 'OWNER_DRIVE_ASSIGNMENT_READY' as status;
