begin;

-- A fresh installation temporarily contains the historical CHANANYA seed so
-- older migrations can backfill tenant columns safely. Remove that seed only
-- when the database is provably pristine. The reviewed tenant bootstrap then
-- creates the one real clinic for this isolated project.
--
-- Existing installations are never re-keyed or deleted. A half-provisioned
-- database with no users fails closed instead of silently keeping two tenants.
do $fresh_white_label_seed_cleanup$
declare
  v_legacy_id constant uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_default_state constant jsonb := '{"patients":[],"appointments":[],"encounters":[],"inventory":[],"activity":[]}'::jsonb;
  v_relation record;
  v_has_rows boolean;
  v_has_users boolean;
begin
  if not exists (
    select 1 from public.clinics
    where id = v_legacy_id and code = 'CHANANYA'
  ) then
    return;
  end if;

  v_has_users := exists (select 1 from auth.users)
    or exists (select 1 from public.profiles)
    or exists (select 1 from public.clinic_memberships);

  -- Populated installations are upgrades, not fresh provisioning targets.
  if v_has_users then
    return;
  end if;

  if (select count(*) from public.clinics) <> 1 then
    raise exception 'FRESH_TENANT_SEED_CLEANUP_AMBIGUOUS_CLINICS';
  end if;

  -- Check every public base table carrying clinic_id before a DELETE can
  -- invoke any ON DELETE CASCADE relationship.
  for v_relation in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
     and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name = 'clinic_id'
    order by c.table_name
  loop
    execute format(
      'select exists (select 1 from %I.%I where clinic_id = $1)',
      v_relation.table_schema,
      v_relation.table_name
    ) into v_has_rows using v_legacy_id;
    if v_has_rows then
      raise exception 'FRESH_TENANT_SEED_CLEANUP_DATA_PRESENT:%', v_relation.table_name;
    end if;
  end loop;

  if exists (
    select 1 from public.clinic_state
    where id = v_legacy_id
      and (
        data is distinct from v_default_state
        or updated_by is not null
      )
  ) then
    raise exception 'FRESH_TENANT_SEED_CLEANUP_STATE_PRESENT';
  end if;

  delete from public.clinic_state
  where id = v_legacy_id
    and data = v_default_state
    and updated_by is null;

  delete from public.clinics
  where id = v_legacy_id and code = 'CHANANYA';
end
$fresh_white_label_seed_cleanup$;

commit;

select 'CLINICAL_OS_FRESH_WHITE_LABEL_SEED_READY' as status;
