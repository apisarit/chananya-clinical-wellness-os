-- Guarded additive contract. Requires both export-audit and amendment candidates.
-- No live installation, permission activation or restore-to-source authorization.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin raise exception 'SELECTED_EXPORT_BACKUP_REVIEW_REQUIRED'; end $$;
create function cnyos_export_internal.backup_projection(p_clinic uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,pg_temp set timezone='UTC' set datestyle='ISO, YMD' as $$
declare v_data jsonb; v_counts jsonb; v_hashes jsonb;
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  -- Reject mixed-tenant historical payloads before projecting either tenant.
  if exists (
    select 1 from cnyos_export_internal.permission_events e
    where (e.clinic_id=p_clinic or e.before_state->>'clinic_id'=p_clinic::text
      or e.after_state->>'clinic_id'=p_clinic::text)
      and ((e.before_state is not null and
        (e.before_state->>'clinic_id'=e.clinic_id::text
          and e.before_state->>'actor_id'=e.subject_id::text
          and jsonb_typeof(e.before_state->'active')='boolean'
          and jsonb_typeof(e.before_state->'policy_reference')='string') is not true)
      or (e.after_state is not null and
        (e.after_state->>'clinic_id'=e.clinic_id::text
          and e.after_state->>'actor_id'=e.subject_id::text
          and jsonb_typeof(e.after_state->'active')='boolean'
          and jsonb_typeof(e.after_state->'policy_reference')='string') is not true))
  ) or exists (
    select 1 from cnyos_export_internal.preparation_events e
    where (e.clinic_id=p_clinic or exists(select 1 from public.patients p
      where p.id=any(e.patient_ids) and p.clinic_id=p_clinic))
      and ((select count(distinct p.id) from unnest(e.patient_ids) requested(id)
        join public.patients p on p.id=requested.id and p.clinic_id=e.clinic_id)
        <>cardinality(e.patient_ids))
  ) then raise exception 'BACKUP_EXPORT_AUDIT_INTEGRITY_ANOMALY'; end if;
  v_data:=jsonb_build_object(
    'cnyos_export_internal.permissions',coalesce((select jsonb_agg(to_jsonb(p) order by clinic_id,actor_id)
      from cnyos_export_internal.permissions p where p.clinic_id=p_clinic),'[]'::jsonb),
    'cnyos_export_internal.permission_events',coalesce((select jsonb_agg(to_jsonb(p) order by id)
      from cnyos_export_internal.permission_events p where p.clinic_id=p_clinic),'[]'::jsonb),
    'cnyos_export_internal.preparation_events',coalesce((select jsonb_agg(to_jsonb(p) order by id)
      from cnyos_export_internal.preparation_events p where p.clinic_id=p_clinic),'[]'::jsonb));
  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),
    jsonb_object_agg(k,encode(sha256(convert_to((v_data->k)::text,'UTF8')),'hex'))
    into v_counts,v_hashes from jsonb_object_keys(v_data) keys(k);
  return jsonb_build_object('data',v_data,'counts',v_counts,'table_sha256',v_hashes);
end $$;
revoke all on function cnyos_export_internal.backup_projection(uuid) from public,anon,authenticated,service_role;
do $$ begin
  if position('2026-09-27.2' in pg_get_functiondef('public.export_clinic_backup_domain(uuid,text)'::regprocedure))=0
    or position('2026-09-27.2' in pg_get_functiondef('public.verify_clinic_restore_trace(uuid)'::regprocedure))=0
  then raise exception 'EXPORT_BACKUP_PREDECESSOR_MISMATCH'; end if;
end $$;
alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_pre_export_audit;
alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_pre_export_audit;
revoke all on function public.export_clinic_backup_domain_pre_export_audit(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.verify_clinic_restore_trace_pre_export_audit(uuid) from public,anon,authenticated,service_role;
create function public.export_clinic_backup_domain(p_clinic_id uuid,p_domain text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare v_base jsonb; v_extra jsonb; v_data jsonb; v_hashes jsonb; v_tables jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.export_clinic_backup_domain_pre_export_audit(p_clinic_id,p_domain);
  v_extra:=cnyos_export_internal.backup_projection(p_clinic_id);
  v_data:=v_base->'data';v_hashes:=coalesce(v_base->'table_sha256','{}'::jsonb);
  if p_domain='transactions' then
    v_data:=v_data||(v_extra->'data');v_hashes:=v_hashes||(v_extra->'table_sha256');
  end if;
  select jsonb_agg(k order by k) into v_tables from jsonb_object_keys(v_data) keys(k);
  return v_base||jsonb_build_object('schema_version','2026-09-27.3',
    'data',v_data,'included_tables',v_tables,'table_sha256',v_hashes);
end $$;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;
create function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare v_base jsonb; v_extra jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.verify_clinic_restore_trace_pre_export_audit(p_clinic_id);
  v_extra:=cnyos_export_internal.backup_projection(p_clinic_id);
  return v_base||jsonb_build_object('schema_version','2026-09-27.3',
    'counts',(v_base->'counts')||(v_extra->'counts'),
    'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
end $$;
revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;
create or replace function public.backup_restore_contract_healthcheck()
returns table(ready boolean,schema_version text,domain_count integer,patient_table_count integer,product_table_count integer,pharmacy_table_count integer,transaction_table_count integer,managed_database_restore_required boolean)
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select true,'2026-09-27.3',4,31,16,7,24,true where auth.role()='service_role' or public.is_super_admin();
$$;
revoke all on function public.backup_restore_contract_healthcheck() from public,anon,authenticated,service_role;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;
commit;
