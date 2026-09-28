-- LOCAL CANDIDATE. Requires clarification candidate and financial backup v1.
-- Runtime/restore clients must support 2026-09-26.2 before activation.
begin;
create or replace function cnyos_clarification_internal.backup_projection(p_clinic uuid)
returns jsonb language plpgsql stable security definer set search_path=''
set timezone='UTC' set datestyle='ISO, YMD' as $$
declare v_data jsonb; v_counts jsonb; v_hashes jsonb;
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  if exists(select 1 from cnyos_clarification_internal.tickets t
    join public.dispensing_orders d on d.id=t.order_id
    join public.prescriptions rx on rx.id=d.prescription_id
    join public.encounters e on e.id=rx.encounter_id
    where (t.clinic_id=p_clinic or e.clinic_id=p_clinic) and t.clinic_id is distinct from e.clinic_id)
    or exists(select 1 from cnyos_clarification_internal.clearances c
      join cnyos_clarification_internal.tickets t on t.id=c.ticket_id
      join public.dispensing_orders d on d.id=c.order_id
      join public.prescriptions rx on rx.id=d.prescription_id
      join public.encounters e on e.id=rx.encounter_id
      where (t.clinic_id=p_clinic or e.clinic_id=p_clinic)
        and (t.order_id<>c.order_id or t.clinic_id is distinct from e.clinic_id or t.status<>'resolved'))
  then raise exception 'BACKUP_CLARIFICATION_INTEGRITY_ANOMALY'; end if;
  v_data:=jsonb_build_object(
    'cnyos_clarification_internal.tickets',coalesce((select jsonb_agg(to_jsonb(t) order by t.id)
      from cnyos_clarification_internal.tickets t where t.clinic_id=p_clinic),'[]'::jsonb),
    'cnyos_clarification_internal.clearances',coalesce((select jsonb_agg(to_jsonb(c) order by c.order_id)
      from cnyos_clarification_internal.clearances c join cnyos_clarification_internal.tickets t on t.id=c.ticket_id
      where t.clinic_id=p_clinic),'[]'::jsonb));
  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),
    jsonb_object_agg(k,encode(pg_catalog.sha256(convert_to((v_data->k)::text,'UTF8')),'hex'))
    into v_counts,v_hashes from jsonb_object_keys(v_data) keys(k);
  return jsonb_build_object('data',v_data,'counts',v_counts,'table_sha256',v_hashes);
end $$;
revoke all on function cnyos_clarification_internal.backup_projection(uuid) from public,anon,authenticated,service_role;

do $$ begin
  if to_regprocedure('public.export_clinic_backup_domain_pre_clarification(uuid,text)') is null then
    alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_pre_clarification;
  end if;
  if to_regprocedure('public.verify_clinic_restore_trace_pre_clarification(uuid)') is null then
    alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_pre_clarification;
  end if;
end $$;
revoke all on function public.export_clinic_backup_domain_pre_clarification(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.verify_clinic_restore_trace_pre_clarification(uuid) from public,anon,authenticated,service_role;

create or replace function public.export_clinic_backup_domain(p_clinic_id uuid,p_domain text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_base jsonb; v_extra jsonb; v_data jsonb; v_tables jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.export_clinic_backup_domain_pre_clarification(p_clinic_id,p_domain);
  v_extra:=cnyos_clarification_internal.backup_projection(p_clinic_id);
  if p_domain='transactions' then
    v_data:=(v_base->'data')||(v_extra->'data');
    select jsonb_agg(k order by k) into v_tables from jsonb_object_keys(v_data) keys(k);
    v_base:=v_base||jsonb_build_object('data',v_data,'included_tables',v_tables,
      'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
  end if;
  return v_base||jsonb_build_object('schema_version','2026-09-26.2');
end $$;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_base jsonb; v_extra jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.verify_clinic_restore_trace_pre_clarification(p_clinic_id);
  v_extra:=cnyos_clarification_internal.backup_projection(p_clinic_id);
  return v_base||jsonb_build_object('schema_version','2026-09-26.2',
    'counts',(v_base->'counts')||(v_extra->'counts'),
    'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
end $$;
revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table(ready boolean,schema_version text,domain_count integer,patient_table_count integer,product_table_count integer,pharmacy_table_count integer,transaction_table_count integer,managed_database_restore_required boolean)
language sql stable security definer set search_path='' as $$
  select true,'2026-09-26.2',4,31,16,7,19,true where auth.role()='service_role' or public.is_super_admin();
$$;
revoke all on function public.backup_restore_contract_healthcheck() from public,anon,authenticated,service_role;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;
commit;
