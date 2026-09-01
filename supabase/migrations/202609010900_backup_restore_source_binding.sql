begin;

-- ============================================================
-- EXACT BACKUP RESTORE SOURCE BINDING
--
-- A restore drill must consume the five objects recorded by one completed
-- backup slot. It must never rediscover files by name or resolve the clinic's
-- current Drive assignment, because either can change after the backup.
-- ============================================================

-- Serialize a backup lease with Owner Drive assignment changes. The Owner
-- mutation in 202609010500 locks the same clinic row before checking for an
-- active run. Whichever transaction obtains this row lock first therefore
-- wins cleanly: an assignment commits before the new lease, or the Owner
-- change sees the committed started run and fails closed.
create or replace function public.begin_backup_export_run(
  p_clinic_id uuid,
  p_scheduled_for timestamptz,
  p_request_id text
)
returns table (run_id uuid, acquired boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic public.clinics%rowtype;
  v_run public.backup_export_runs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_clinic_id is null then
    raise exception 'CLINIC_ID_REQUIRED';
  end if;
  if p_scheduled_for is null then
    raise exception 'BACKUP_SLOT_REQUIRED';
  end if;

  select * into v_clinic
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if not found or not v_clinic.active then
    raise exception 'CLINIC_NOT_FOUND';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':' || p_scheduled_for::text,
      0
    )
  );

  select * into v_run
  from public.backup_export_runs r
  where r.clinic_id = p_clinic_id
    and r.scheduled_for = p_scheduled_for
  for update;

  if found and (
    v_run.status = 'completed'
    or (
      v_run.status = 'started'
      and v_run.started_at > pg_catalog.now() - interval '30 minutes'
    )
  ) then
    return query select v_run.id, false;
    return;
  end if;

  if found then
    update public.backup_export_runs
    set status = 'started',
        domain_counts = '{}'::jsonb,
        object_manifest = '[]'::jsonb,
        request_id = nullif(pg_catalog.btrim(p_request_id), ''),
        error_code = null,
        started_at = pg_catalog.now(),
        completed_at = null
    where id = v_run.id
    returning * into v_run;
  else
    insert into public.backup_export_runs (
      clinic_id,
      scheduled_for,
      status,
      request_id
    ) values (
      p_clinic_id,
      p_scheduled_for,
      'started',
      nullif(pg_catalog.btrim(p_request_id), '')
    )
    returning * into v_run;
  end if;

  return query select v_run.id, true;
end;
$$;

revoke all on function public.begin_backup_export_run(uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.begin_backup_export_run(uuid, timestamptz, text)
  to service_role;

-- Return a sanitized, immutable restore recipe for exactly one completed run.
-- The response contains opaque Drive identifiers and integrity metadata only;
-- it never contains a Supabase credential, Google credential, encryption key,
-- or clinical payload.
create or replace function public.get_exact_backup_restore_source(
  p_clinic_code text,
  p_scheduled_for timestamptz,
  p_environment text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic public.clinics%rowtype;
  v_run public.backup_export_runs%rowtype;
  v_clinic_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_clinic_code, '')));
  v_environment text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_environment, '')));
  v_object jsonb;
  v_objects jsonb := '{}'::jsonb;
  v_domain text;
  v_file_id text;
  v_file_name text;
  v_folder_id text;
  v_root_folder_id text;
  v_assignment_version bigint;
  v_expected_name text;
  v_stamp text;
  v_file_ids text[] := array[]::text[];
  v_folder_ids text[] := array[]::text[];
  v_domains constant text[] := array['patients','products','pharmacy','transactions','manifest'];
  v_data_domains constant text[] := array['patients','products','pharmacy','transactions'];
begin
  if auth.role() <> 'service_role' then
    raise exception 'RESTORE_SOURCE_SERVICE_ROLE_REQUIRED';
  end if;
  if v_clinic_code !~ '^[A-Z][A-Z0-9_-]{1,23}$' then
    raise exception 'RESTORE_SOURCE_CLINIC_CODE_INVALID';
  end if;
  if p_scheduled_for is null then
    raise exception 'RESTORE_SOURCE_SLOT_REQUIRED';
  end if;
  if v_environment not in ('staging', 'production') then
    raise exception 'RESTORE_SOURCE_ENVIRONMENT_INVALID';
  end if;

  select * into v_clinic
  from public.clinics c
  where c.code = v_clinic_code;

  if not found then
    raise exception 'RESTORE_SOURCE_CLINIC_NOT_FOUND';
  end if;

  select * into v_run
  from public.backup_export_runs r
  where r.clinic_id = v_clinic.id
    and r.scheduled_for = p_scheduled_for
    and r.status = 'completed'
    and r.destination = 'google_drive';

  if not found then
    raise exception 'RESTORE_SOURCE_COMPLETED_RUN_NOT_FOUND';
  end if;
  if v_run.completed_at is null or v_run.error_code is not null then
    raise exception 'RESTORE_SOURCE_COMPLETED_RUN_INVALID';
  end if;
  if pg_catalog.jsonb_typeof(v_run.object_manifest) <> 'array'
     or pg_catalog.jsonb_array_length(v_run.object_manifest) <> 5 then
    raise exception 'RESTORE_SOURCE_OBJECT_MANIFEST_INVALID';
  end if;
  if pg_catalog.jsonb_typeof(v_run.domain_counts) <> 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_run.domain_counts)) <> 4
     or exists (
       select 1
       from pg_catalog.jsonb_object_keys(v_run.domain_counts) as keys(domain)
       where not (keys.domain = any(v_data_domains))
     ) then
    raise exception 'RESTORE_SOURCE_DOMAIN_COUNTS_INVALID';
  end if;

  v_stamp := pg_catalog.to_char(
    p_scheduled_for at time zone 'UTC',
    'YYYYMMDD"T"HH24MISS"Z"'
  );

  for v_object in
    select entry.value
    from pg_catalog.jsonb_array_elements(v_run.object_manifest) as entry(value)
  loop
    if pg_catalog.jsonb_typeof(v_object) <> 'object' then
      raise exception 'RESTORE_SOURCE_OBJECT_INVALID';
    end if;

    v_domain := v_object->>'domain';
    if v_domain is null
       or not (v_domain = any(v_domains))
       or v_objects ? v_domain then
      raise exception 'RESTORE_SOURCE_OBJECT_DOMAIN_INVALID';
    end if;
    if v_object->>'environment' is distinct from v_environment then
      raise exception 'RESTORE_SOURCE_OBJECT_ENVIRONMENT_MISMATCH';
    end if;

    v_file_id := v_object->>'file_id';
    v_file_name := v_object->>'file_name';
    v_folder_id := v_object->>'destination_folder_id';
    if v_file_id is null
       or v_folder_id is null
       or v_file_id !~ '^[A-Za-z0-9_-]{10,200}$'
       or v_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' then
      raise exception 'RESTORE_SOURCE_DRIVE_ID_INVALID';
    end if;
    if v_file_id = any(v_file_ids) or v_folder_id = any(v_folder_ids) then
      raise exception 'RESTORE_SOURCE_DRIVE_IDS_NOT_UNIQUE';
    end if;
    v_file_ids := pg_catalog.array_append(v_file_ids, v_file_id);
    v_folder_ids := pg_catalog.array_append(v_folder_ids, v_folder_id);

    if v_object->>'drive_root_folder_id' is null
       or v_object->>'drive_root_folder_id' !~ '^[A-Za-z0-9_-]{10,200}$' then
      raise exception 'RESTORE_SOURCE_ROOT_FOLDER_INVALID';
    end if;
    if v_root_folder_id is null then
      v_root_folder_id := v_object->>'drive_root_folder_id';
    elsif v_object->>'drive_root_folder_id' is distinct from v_root_folder_id then
      raise exception 'RESTORE_SOURCE_ROOT_FOLDER_MISMATCH';
    end if;

    if pg_catalog.jsonb_typeof(v_object->'drive_assignment_version') is distinct from 'number'
       or (v_object->>'drive_assignment_version') !~ '^[1-9][0-9]*$' then
      raise exception 'RESTORE_SOURCE_ASSIGNMENT_VERSION_INVALID';
    end if;
    if (v_object->>'drive_assignment_version')::numeric > 9223372036854775807 then
      raise exception 'RESTORE_SOURCE_ASSIGNMENT_VERSION_INVALID';
    end if;
    if v_assignment_version is null then
      v_assignment_version := (v_object->>'drive_assignment_version')::bigint;
    elsif (v_object->>'drive_assignment_version')::bigint <> v_assignment_version then
      raise exception 'RESTORE_SOURCE_ASSIGNMENT_VERSION_MISMATCH';
    end if;

    v_expected_name := pg_catalog.upper(v_environment)
      || '_' || v_clinic.code
      || '_' || v_domain
      || '_' || v_stamp
      || case
        when v_domain = 'manifest' then '.manifest.json'
        else '.cdb.json.enc'
      end;
    if v_file_name is distinct from v_expected_name then
      raise exception 'RESTORE_SOURCE_FILE_NAME_MISMATCH';
    end if;

    if v_domain = any(v_data_domains) then
      if pg_catalog.jsonb_typeof(v_object->'plaintext_bytes') is distinct from 'number'
         or pg_catalog.jsonb_typeof(v_object->'encrypted_bytes') is distinct from 'number'
         or (v_object->>'plaintext_bytes') !~ '^[1-9][0-9]*$'
         or (v_object->>'encrypted_bytes') !~ '^[1-9][0-9]*$'
         or v_object->>'plaintext_sha256' is null
         or v_object->>'ciphertext_sha256' is null
         or v_object->>'key_id' is null
         or v_object->>'plaintext_sha256' !~ '^[0-9a-f]{64}$'
         or v_object->>'ciphertext_sha256' !~ '^[0-9a-f]{64}$'
         or v_object->>'key_id' !~ '^[0-9a-f]{16}$'
         or pg_catalog.jsonb_typeof(v_run.domain_counts->v_domain) is distinct from 'object'
         or exists (
           select 1
           from pg_catalog.jsonb_each(v_run.domain_counts->v_domain) as counts(table_name, row_count)
           where pg_catalog.jsonb_typeof(counts.row_count) <> 'number'
              or counts.row_count::text !~ '^(0|[1-9][0-9]*)$'
         ) then
        raise exception 'RESTORE_SOURCE_DOMAIN_EVIDENCE_INVALID';
      end if;
      v_object := v_object || pg_catalog.jsonb_build_object(
        'row_counts', v_run.domain_counts->v_domain
      );
    end if;

    v_objects := v_objects || pg_catalog.jsonb_build_object(v_domain, v_object);
  end loop;

  if not (v_objects ?& v_domains) then
    raise exception 'RESTORE_SOURCE_OBJECT_DOMAINS_INCOMPLETE';
  end if;

  return pg_catalog.jsonb_build_object(
    'format', 'chananya-exact-restore-source/v1',
    'run_id', v_run.id,
    'clinic_id', v_clinic.id,
    'clinic_code', v_clinic.code,
    'environment', v_environment,
    'slot', v_run.scheduled_for,
    'completed_at', v_run.completed_at,
    'drive_assignment', pg_catalog.jsonb_build_object(
      'version', v_assignment_version,
      'root_folder_id', v_root_folder_id,
      'folder_ids', pg_catalog.jsonb_build_object(
        'patients', v_objects->'patients'->>'destination_folder_id',
        'products', v_objects->'products'->>'destination_folder_id',
        'pharmacy', v_objects->'pharmacy'->>'destination_folder_id',
        'transactions', v_objects->'transactions'->>'destination_folder_id',
        'manifests', v_objects->'manifest'->>'destination_folder_id'
      )
    ),
    'objects', v_objects
  );
end;
$$;

revoke all on function public.get_exact_backup_restore_source(text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.get_exact_backup_restore_source(text, timestamptz, text)
  to service_role;

commit;

select 'BACKUP_RESTORE_SOURCE_BINDING_READY' as status;
