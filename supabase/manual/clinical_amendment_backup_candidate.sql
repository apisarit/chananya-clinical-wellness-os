-- Review candidate only: pair with amendment recovery and versioned clients.
-- Managed full-database restore is required; do not insert exports into live tables.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin raise exception 'CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED'; end $$;

create function cnyos_amendment_internal.backup_projection(p_clinic uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,pg_temp set timezone='UTC' set datestyle='ISO, YMD'
as $$
declare v_data jsonb; v_counts jsonb; v_hashes jsonb;
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  if exists (
    select 1 from cnyos_amendment_internal.receipts r
    left join public.encounters e on e.id=r.encounter_id
    left join public.clinical_record_signoffs s on s.id=r.signoff_id
    where (r.clinic_id=p_clinic or e.clinic_id=p_clinic)
      and (e.id is null or e.clinic_id is distinct from r.clinic_id
        or s.id is null or s.encounter_id is distinct from r.encounter_id
        or s.record_section is distinct from 'complete_record'
        or s.signature_generation < r.generation
        or (s.signature_generation=r.generation and s.lock_record)
        or r.result is distinct from jsonb_build_object(
          'request_id',r.request_id,'encounter_id',r.encounter_id,'signoff_id',r.signoff_id,
          'signature_generation',r.generation::text,'unlocked',true,
          'actor_id',r.actor_id,'clinic_id',r.clinic_id,
          'reason_digest',encode(sha256(convert_to(r.reason,'UTF8')),'hex'))
        or 1 <> (select count(*) from public.clinical_record_audit_events a
          where a.encounter_id=r.encounter_id and a.actor_id=r.actor_id
            and a.event_type='UNLOCK_FOR_AMENDMENT' and a.record_section='complete_record'
            and a.reason=r.reason and a.details=jsonb_build_object(
              'request_id',r.request_id,'signoff_id',r.signoff_id,
              'signature_generation',r.generation::text,'old_locked',true,'new_locked',false)))
  ) or exists (
    select 1 from public.clinical_record_audit_events a
    join public.encounters e on e.id=a.encounter_id
    where e.clinic_id=p_clinic and a.event_type='UNLOCK_FOR_AMENDMENT'
      and a.details ? 'request_id' and not exists (
        select 1 from cnyos_amendment_internal.receipts r
        where r.request_id::text=a.details->>'request_id'
          and r.clinic_id=e.clinic_id and r.encounter_id=a.encounter_id)
  ) or exists (
    select 1 from cnyos_amendment_internal.receipts where clinic_id=p_clinic
    group by signoff_id,generation having count(*)>1
  ) then raise exception 'BACKUP_AMENDMENT_INTEGRITY_ANOMALY'; end if;
  v_data:=jsonb_build_object(
    -- Keep bigint generations exact across the JSON/JavaScript transport.
    'cnyos_amendment_internal.receipts',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('generation',r.generation::text) order by r.request_id)
      from cnyos_amendment_internal.receipts r where r.clinic_id=p_clinic),'[]'::jsonb),
    'clinical_record_signoffs',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('signature_generation',s.signature_generation::text) order by s.id)
      from public.clinical_record_signoffs s join public.encounters e on e.id=s.encounter_id
      where e.clinic_id=p_clinic),'[]'::jsonb),
    'clinical_record_audit_events',coalesce((select jsonb_agg(to_jsonb(a) order by a.id)
      from public.clinical_record_audit_events a join public.encounters e on e.id=a.encounter_id
      where e.clinic_id=p_clinic),'[]'::jsonb));
  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),
    jsonb_object_agg(k,encode(sha256(convert_to((v_data->k)::text,'UTF8')),'hex'))
    into v_counts,v_hashes from jsonb_object_keys(v_data) keys(k);
  return jsonb_build_object('data',v_data,'counts',v_counts,'table_sha256',v_hashes);
end $$;
revoke all on function cnyos_amendment_internal.backup_projection(uuid) from public,anon,authenticated,service_role;

-- Refuse an unexpected predecessor instead of silently relabeling its contract.
do $$ begin
  if position('2026-09-27.1' in pg_get_functiondef('public.export_clinic_backup_domain(uuid,text)'::regprocedure))=0
    or position('2026-09-27.1' in pg_get_functiondef('public.verify_clinic_restore_trace(uuid)'::regprocedure))=0
  then raise exception 'AMENDMENT_BACKUP_PREDECESSOR_MISMATCH'; end if;
end $$;
alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_pre_amendment;
alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_pre_amendment;
revoke all on function public.export_clinic_backup_domain_pre_amendment(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.verify_clinic_restore_trace_pre_amendment(uuid) from public,anon,authenticated,service_role;

create function public.export_clinic_backup_domain(p_clinic_id uuid,p_domain text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp
as $$
declare v_base jsonb; v_extra jsonb; v_data jsonb; v_hashes jsonb; v_tables jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.export_clinic_backup_domain_pre_amendment(p_clinic_id,p_domain);
  v_extra:=cnyos_amendment_internal.backup_projection(p_clinic_id);
  v_data:=v_base->'data'; v_hashes:=coalesce(v_base->'table_sha256','{}'::jsonb);
  if p_domain='patients' then
    v_data:=v_data||jsonb_build_object('clinical_record_signoffs',v_extra->'data'->'clinical_record_signoffs');
    v_hashes:=v_hashes||jsonb_build_object('clinical_record_signoffs',v_extra->'table_sha256'->'clinical_record_signoffs');
  elsif p_domain='transactions' then
    v_data:=v_data||((v_extra->'data')-'clinical_record_signoffs');
    v_hashes:=v_hashes||((v_extra->'table_sha256')-'clinical_record_signoffs');
  end if;
  select jsonb_agg(k order by k) into v_tables from jsonb_object_keys(v_data) keys(k);
  return v_base||jsonb_build_object('schema_version','2026-09-27.2',
    'data',v_data,'included_tables',v_tables,'table_sha256',v_hashes);
end $$;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp
as $$
declare v_base jsonb; v_extra jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.verify_clinic_restore_trace_pre_amendment(p_clinic_id);
  v_extra:=cnyos_amendment_internal.backup_projection(p_clinic_id);
  return v_base||jsonb_build_object('schema_version','2026-09-27.2',
    'counts',(v_base->'counts')||(v_extra->'counts'),
    'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
end $$;
revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table(ready boolean,schema_version text,domain_count integer,patient_table_count integer,product_table_count integer,pharmacy_table_count integer,transaction_table_count integer,managed_database_restore_required boolean)
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select true,'2026-09-27.2',4,31,16,7,21,true where auth.role()='service_role' or public.is_super_admin();
$$;
revoke all on function public.backup_restore_contract_healthcheck() from public,anon,authenticated,service_role;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;
commit;
