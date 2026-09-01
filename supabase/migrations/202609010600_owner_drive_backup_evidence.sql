begin;

-- ============================================================
-- OWNER DRIVE ASSIGNMENT BACKUP / RESTORE EVIDENCE
--
-- Drive destination changes are operational, non-PHI audit evidence. Keep
-- them in the encrypted transaction domain while excluding the free-text
-- reason and actor email, either of which could contain unnecessary personal
-- or sensitive text. Folder IDs are opaque destination identifiers, not
-- credentials; Google service-account material and encryption keys never
-- enter these database records.
-- ============================================================

-- Archive the 2026-08-31 owner-subscription wrapper once, then replace only
-- this migration's outer wrapper on replay. This is safe for dashboard/manual
-- application and preserves every previously exported domain field.
do $migration$
begin
  if to_regclass('public.clinic_drive_destination_events') is null then
    raise exception 'DRIVE_DESTINATION_EVENTS_REQUIRED';
  end if;
  if to_regprocedure('public.export_clinic_backup_domain_v20260831(uuid,text)') is null then
    if to_regprocedure('public.export_clinic_backup_domain(uuid,text)') is null then
      raise exception 'BASE_BACKUP_EXPORTER_REQUIRED';
    end if;
    execute 'alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_v20260831';
  end if;
end
$migration$;

create or replace function public.export_clinic_backup_domain(
  p_clinic_id uuid,
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_export jsonb;
  v_data jsonb;
  v_included jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  v_export := public.export_clinic_backup_domain_v20260831(p_clinic_id, p_domain);
  v_data := coalesce(v_export->'data', '{}'::jsonb);

  if p_domain = 'transactions' then
    v_data := v_data || jsonb_build_object(
      'clinic_drive_destination_events', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', e.id,
            'request_id', e.request_id,
            'clinic_id', e.clinic_id,
            'clinic_code', e.clinic_code,
            'environment', e.environment,
            'expected_version', e.expected_version,
            'assignment_version', e.assignment_version,
            'previous_assignment', jsonb_build_object(
              'environment', e.previous_assignment->'environment',
              'patientsFolderId', e.previous_assignment->'patientsFolderId',
              'productsFolderId', e.previous_assignment->'productsFolderId',
              'pharmacyFolderId', e.previous_assignment->'pharmacyFolderId',
              'transactionsFolderId', e.previous_assignment->'transactionsFolderId',
              'manifestsFolderId', e.previous_assignment->'manifestsFolderId',
              'version', e.previous_assignment->'version',
              'updatedAt', e.previous_assignment->'updatedAt',
              'updatedByUserId', e.previous_assignment->'updatedByUserId'
            ),
            'new_assignment', jsonb_build_object(
              'environment', e.new_assignment->'environment',
              'patientsFolderId', e.new_assignment->'patientsFolderId',
              'productsFolderId', e.new_assignment->'productsFolderId',
              'pharmacyFolderId', e.new_assignment->'pharmacyFolderId',
              'transactionsFolderId', e.new_assignment->'transactionsFolderId',
              'manifestsFolderId', e.new_assignment->'manifestsFolderId',
              'version', e.new_assignment->'version',
              'updatedAt', e.new_assignment->'updatedAt',
              'updatedByUserId', e.new_assignment->'updatedByUserId'
            ),
            'changed', e.changed,
            'actor_user_id', e.actor_user_id,
            'created_at', e.created_at
          ) order by e.created_at, e.id
        )
        from public.clinic_drive_destination_events e
        where e.clinic_id = p_clinic_id
      ), '[]'::jsonb)
    );
  end if;

  select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
  into v_included
  from jsonb_object_keys(v_data) as keys(k);

  return jsonb_set(
    jsonb_set(
      jsonb_set(v_export, '{schema_version}', '"2026-09-01.1"'::jsonb),
      '{included_tables}', v_included
    ),
    '{data}', v_data
  );
end;
$$;

revoke all on function public.export_clinic_backup_domain(uuid, text)
  from public, anon, authenticated;
grant execute on function public.export_clinic_backup_domain(uuid, text)
  to service_role;

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
set search_path = pg_catalog, public
as $$
  select true, '2026-09-01.1', 4, 31, 16, 7, 12, true
  where auth.role() = 'service_role' or public.is_super_admin();
$$;

revoke all on function public.backup_restore_contract_healthcheck()
  from public, anon;
grant execute on function public.backup_restore_contract_healthcheck()
  to authenticated, service_role;

-- A managed/PITR restore restores the append-only event table itself. Extend
-- the isolated restore trace with its tenant-scoped evidence count; do not
-- logically replay folder assignments into another environment.
do $migration$
begin
  if to_regprocedure('public.verify_clinic_restore_trace_v20260831(uuid)') is null then
    if to_regprocedure('public.verify_clinic_restore_trace(uuid)') is null then
      raise exception 'BASE_RESTORE_TRACE_REQUIRED';
    end if;
    execute 'alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_v20260831';
  end if;
end
$migration$;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_trace jsonb;
  v_counts jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  v_trace := public.verify_clinic_restore_trace_v20260831(p_clinic_id);
  v_counts := coalesce(v_trace->'counts', '{}'::jsonb) || jsonb_build_object(
    'clinic_drive_destination_events', (
      select count(*)
      from public.clinic_drive_destination_events e
      where e.clinic_id = p_clinic_id
    )
  );

  return jsonb_set(
    jsonb_set(v_trace, '{schema_version}', '"2026-09-01.1"'::jsonb),
    '{counts}', v_counts
  );
end;
$$;

revoke all on function public.verify_clinic_restore_trace(uuid)
  from public, anon, authenticated;
grant execute on function public.verify_clinic_restore_trace(uuid)
  to service_role;

commit;

select 'OWNER_DRIVE_BACKUP_EVIDENCE_READY' as status;
