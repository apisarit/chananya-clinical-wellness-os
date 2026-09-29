begin;

-- Financial/provenance backup extension.  The prior wrappers are immutable
-- compatibility surfaces; this migration replaces only the outer wrappers.
do $archive$
begin
  if to_regprocedure('public.export_clinic_backup_domain_v20260901(uuid,text)') is null then
    if to_regprocedure('public.export_clinic_backup_domain(uuid,text)') is null then
      raise exception 'BASE_BACKUP_EXPORTER_REQUIRED';
    end if;
    execute 'alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_v20260901';
  end if;
  if to_regprocedure('public.verify_clinic_restore_trace_v20260901(uuid)') is null then
    if to_regprocedure('public.verify_clinic_restore_trace(uuid)') is null then
      raise exception 'BASE_RESTORE_TRACE_REQUIRED';
    end if;
    execute 'alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_v20260901';
  end if;
end
$archive$;

create schema if not exists cnyos_backup_internal;
revoke all on schema cnyos_backup_internal from public, anon, authenticated, service_role;
create index if not exists invoice_request_receipts_clinic_idx on cnyos_billing_internal.invoice_request_receipts(clinic_id, request_key);
create index if not exists treatment_request_receipts_clinic_idx on cnyos_treatment_internal.session_request_receipts(clinic_id, request_id);
create index if not exists price_master_audit_clinic_idx on public.price_master_audit(clinic_id, id);

-- One stable tenant projection is shared by the export and restore verifier.
-- It is deliberately a definer-only implementation detail: no runtime role,
-- including service_role, can call it directly.
create or replace function cnyos_backup_internal.financial_tenant_projection(p_clinic_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, cnyos_billing_internal, cnyos_treatment_internal, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
declare
  v_data jsonb;
  v_counts jsonb;
  v_hashes jsonb;
  v_anomalies integer := 0;
begin
  if p_clinic_id is null then raise exception 'CLINIC_ID_REQUIRED'; end if;

  -- Relationship anomalies are evidence, not rows to be silently filtered.
  select coalesce(sum(x.n),0)::integer into v_anomalies from (values
    ((select count(*) from public.invoices i join public.patients p on p.id=i.patient_id
      left join public.encounters e on e.id=i.encounter_id
      where p.clinic_id=p_clinic_id and i.encounter_id is not null
        and (e.clinic_id is distinct from p_clinic_id or e.patient_id is distinct from i.patient_id))::bigint),
    ((select count(*) from cnyos_billing_internal.invoice_orders io
      join public.invoices i on i.id=io.invoice_id
      join public.patients p on p.id=i.patient_id
      left join public.dispensing_orders d on d.id=io.dispensing_order_id
      left join public.prescriptions dp on dp.id=d.prescription_id
      left join public.encounters de on de.id=dp.encounter_id
      where p.clinic_id=p_clinic_id
        and (de.id is null or de.clinic_id is distinct from p_clinic_id or io.prescription_id is distinct from dp.id
          or de.id is distinct from i.encounter_id or dp.patient_id is distinct from i.patient_id))::bigint),
    ((select count(*) from cnyos_billing_internal.invoice_source_charges sc
      join public.invoices i on i.id=sc.invoice_id join public.patients p on p.id=i.patient_id
      left join public.dispensing_items di on di.id=sc.dispensing_item_id
      left join public.dispensing_orders d on d.id=di.dispensing_order_id
      left join public.prescriptions dp on dp.id=d.prescription_id
      left join public.encounters de on de.id=dp.encounter_id
      left join public.clinical_treatment_sessions ts on ts.id=sc.treatment_session_id
      left join public.encounters te on te.id=ts.encounter_id
      where p.clinic_id=p_clinic_id and (
        (sc.source_kind='dispensing_item' and (de.id is null or de.clinic_id is distinct from p_clinic_id or de.id is distinct from i.encounter_id
          or not exists(select 1 from cnyos_billing_internal.invoice_orders io where io.invoice_id=i.id and io.dispensing_order_id=d.id))) or
        (sc.source_kind='treatment_charge' and (te.id is null or te.clinic_id is distinct from p_clinic_id or te.id is distinct from i.encounter_id))))::bigint),
    ((select count(*) from cnyos_billing_internal.invoice_request_receipts r
      left join public.invoices i on i.id=r.invoice_id left join public.patients p on p.id=i.patient_id
      left join public.encounters e on e.id=r.encounter_id
      where r.clinic_id=p_clinic_id and (p.clinic_id is distinct from p_clinic_id or e.clinic_id is distinct from p_clinic_id or i.encounter_id is distinct from r.encounter_id
        or i.aggregate_request_key is distinct from r.request_key or i.aggregate_quote_fingerprint is distinct from r.quote_fingerprint
        or i.created_by is distinct from r.actor_id))::bigint),
    ((select count(*) from public.invoices i join public.patients p on p.id=i.patient_id
      where p.clinic_id=p_clinic_id and i.aggregate_request_key is not null
        and not exists(select 1 from cnyos_billing_internal.invoice_request_receipts r
          where r.invoice_id=i.id and r.request_key=i.aggregate_request_key and r.clinic_id=p_clinic_id))::bigint),
    ((select count(*) from public.invoices i join public.patients p on p.id=i.patient_id
      where p.clinic_id=p_clinic_id and i.aggregate_request_key is not null and (
        (select coalesce(sum(sc.line_total),0) from cnyos_billing_internal.invoice_source_charges sc where sc.invoice_id=i.id) is distinct from i.subtotal
        or (select coalesce(sum(ii.line_total),0) from public.invoice_items ii where ii.invoice_id=i.id) is distinct from i.subtotal
      ))::bigint),
    ((select count(*) from cnyos_treatment_internal.session_request_receipts r
      left join public.encounters e on e.id=r.encounter_id
      left join public.clinical_treatment_sessions s on s.id=r.session_id
      left join public.encounters se on se.id=s.encounter_id
      where r.clinic_id=p_clinic_id and (e.clinic_id is distinct from p_clinic_id or se.clinic_id is distinct from p_clinic_id or s.encounter_id is distinct from r.encounter_id))::bigint),
    ((select count(*) from public.price_master_audit a
      left join public.price_lists l on l.id=a.price_list_id
      left join public.price_list_items li on li.id=a.price_list_item_id
      where a.clinic_id=p_clinic_id and (l.id is null or l.clinic_id is distinct from p_clinic_id
        or (a.price_list_item_id is not null and (li.id is null or li.clinic_id is distinct from p_clinic_id or li.price_list_id is distinct from a.price_list_id))))::bigint),
    ((select count(*) from public.appointments a join public.patients p on p.id=a.patient_id join public.services s on s.id=a.service_id
      where p.clinic_id=p_clinic_id and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.clinic_appointments a join public.patients p on p.id=a.patient_id join public.services s on s.id=a.service_id
      where p.clinic_id=p_clinic_id and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.treatment_orders t join public.encounters e on e.id=t.encounter_id join public.services s on s.id=t.service_id
      where e.clinic_id=p_clinic_id and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.treatment_sessions t join public.encounters e on e.id=t.encounter_id join public.services s on s.id=t.service_id
      where e.clinic_id=p_clinic_id and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.invoice_items ii join public.invoices i on i.id=ii.invoice_id join public.patients p on p.id=i.patient_id join public.services s on s.id=ii.service_id
      where p.clinic_id=p_clinic_id and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.invoices i join public.patients p on p.id=i.patient_id join public.price_lists l on l.id=i.price_list_id
      where p.clinic_id=p_clinic_id and l.clinic_id is not null and l.clinic_id is distinct from p_clinic_id)::bigint),
    ((select count(*) from public.price_list_items li join public.price_lists l on l.id=li.price_list_id
      where (li.clinic_id=p_clinic_id or l.clinic_id=p_clinic_id) and l.clinic_id is distinct from li.clinic_id)::bigint),
    ((select count(*) from public.price_list_items li
      left join public.services s on s.id=li.service_id left join public.products p on p.id=li.product_id
      where li.clinic_id=p_clinic_id and (
        (li.service_id is not null and s.clinic_id is not null and s.clinic_id is distinct from p_clinic_id)
        or (li.product_id is not null and p.clinic_id is distinct from p_clinic_id)))::bigint)
  ) as x(n);

  select jsonb_build_object(
    'services',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.services s where s.clinic_id=p_clinic_id or (s.clinic_id is null and (
      exists(select 1 from public.appointments a join public.patients p on p.id=a.patient_id where a.service_id=s.id and p.clinic_id=p_clinic_id) or
      exists(select 1 from public.clinic_appointments a join public.patients p on p.id=a.patient_id where a.service_id=s.id and p.clinic_id=p_clinic_id) or
      exists(select 1 from public.treatment_orders t join public.encounters e on e.id=t.encounter_id where t.service_id=s.id and e.clinic_id=p_clinic_id) or
      exists(select 1 from public.treatment_sessions t join public.encounters e on e.id=t.encounter_id where t.service_id=s.id and e.clinic_id=p_clinic_id) or
      exists(select 1 from public.invoice_items ii join public.invoices i on i.id=ii.invoice_id join public.patients p on p.id=i.patient_id where ii.service_id=s.id and p.clinic_id=p_clinic_id) or
      exists(select 1 from public.price_list_items li where li.service_id=s.id and li.clinic_id=p_clinic_id)
    ))),'[]'::jsonb),
    'price_lists',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.price_lists l where l.clinic_id=p_clinic_id or (l.clinic_id is null and exists(select 1 from public.invoices i join public.patients p on p.id=i.patient_id where i.price_list_id=l.id and p.clinic_id=p_clinic_id))),'[]'::jsonb),
    'price_list_items',coalesce((select jsonb_agg(to_jsonb(li) order by li.id) from public.price_list_items li join public.price_lists l on l.id=li.price_list_id
      where (l.clinic_id=p_clinic_id or l.clinic_id is null) and (li.clinic_id=p_clinic_id or (li.clinic_id is null and (
        exists(select 1 from cnyos_billing_internal.invoice_source_charges sc join public.invoices i on i.id=sc.invoice_id join public.patients p on p.id=i.patient_id where sc.price_list_item_id=li.id and p.clinic_id=p_clinic_id) or
        exists(select 1 from public.invoice_items ii join public.invoices i on i.id=ii.invoice_id join public.patients p on p.id=i.patient_id where ii.price_list_item_id=li.id and p.clinic_id=p_clinic_id) or
        exists(select 1 from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where di.price_list_item_id=li.id and e.clinic_id=p_clinic_id) or
        exists(select 1 from public.pharmacy_counter_sale_items ci where ci.price_list_item_id=li.id and ci.clinic_id=p_clinic_id)
      )))),'[]'::jsonb),
    'price_master_audit',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.price_master_audit a where a.clinic_id=p_clinic_id),'[]'::jsonb),
    'cnyos_billing_internal.invoice_orders',coalesce((select jsonb_agg(to_jsonb(io) order by io.invoice_id,io.dispensing_order_id) from cnyos_billing_internal.invoice_orders io join public.invoices i on i.id=io.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id),'[]'::jsonb),
    'cnyos_billing_internal.invoice_source_charges',coalesce((select jsonb_agg(to_jsonb(sc) order by sc.id) from cnyos_billing_internal.invoice_source_charges sc join public.invoices i on i.id=sc.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id),'[]'::jsonb),
    'cnyos_billing_internal.invoice_request_receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.request_key) from cnyos_billing_internal.invoice_request_receipts r where r.clinic_id=p_clinic_id),'[]'::jsonb),
    'cnyos_treatment_internal.session_request_receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.request_id) from cnyos_treatment_internal.session_request_receipts r where r.clinic_id=p_clinic_id),'[]'::jsonb)
  ) into v_data;

  -- Every explicitly referenced legacy item carries its parent list and service,
  -- but never causes all other items on an unassigned list to be exported.
  v_data := jsonb_set(v_data, '{price_lists}', coalesce((
    select jsonb_agg(to_jsonb(l) order by l.id) from public.price_lists l
    where l.clinic_id=p_clinic_id or (l.clinic_id is null and (
      exists(select 1 from jsonb_array_elements(v_data->'price_list_items') item where item->>'price_list_id'=l.id::text)
      or exists(select 1 from public.invoices i join public.patients p on p.id=i.patient_id where i.price_list_id=l.id and p.clinic_id=p_clinic_id)
    ))), '[]'::jsonb));
  v_data := jsonb_set(v_data, '{services}', coalesce((
    select jsonb_agg(to_jsonb(s) order by s.id) from public.services s
    where exists(select 1 from jsonb_array_elements(v_data->'services') old_row where old_row->>'id'=s.id::text)
      or (s.clinic_id is null and exists(select 1 from jsonb_array_elements(v_data->'price_list_items') item where item->>'service_id'=s.id::text))
  ), '[]'::jsonb));

  select coalesce(jsonb_object_agg(k,jsonb_array_length(v_data->k)),'{}'::jsonb),
         jsonb_object_agg(k, encode(pg_catalog.sha256(convert_to((v_data->k)::text,'UTF8')),'hex'))
    into v_counts,v_hashes
    from jsonb_object_keys(v_data) as keys(k);
  return jsonb_build_object('data',v_data,'counts',v_counts,'table_sha256',v_hashes,'anomalies',v_anomalies);
end;
$$;
revoke all on function cnyos_backup_internal.financial_tenant_projection(uuid) from public, anon, authenticated, service_role;

create or replace function public.export_clinic_backup_domain(p_clinic_id uuid,p_domain text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_base jsonb; v_projection jsonb; v_data jsonb; v_tables jsonb; v_domain_hashes jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.clinics c where c.id=p_clinic_id and c.active) then raise exception 'CLINIC_NOT_FOUND'; end if;
  v_projection := cnyos_backup_internal.financial_tenant_projection(p_clinic_id);
  if (v_projection->>'anomalies')::integer <> 0 then raise exception 'BACKUP_FINANCIAL_INTEGRITY_ANOMALY'; end if;
  v_base := public.export_clinic_backup_domain_v20260901(p_clinic_id,p_domain);
  v_data := coalesce(v_base->'data','{}'::jsonb);
  if p_domain='products' then
    v_data := v_data || jsonb_build_object('services',v_projection->'data'->'services','price_lists',v_projection->'data'->'price_lists','price_list_items',v_projection->'data'->'price_list_items');
  elsif p_domain='transactions' then
    v_data := v_data || (v_projection->'data') - 'services' - 'price_lists' - 'price_list_items';
  elsif p_domain not in ('patients','pharmacy') then raise exception 'BACKUP_DOMAIN_INVALID'; end if;
  if p_domain='products' then
    v_base := jsonb_set(v_base, '{filtered_tables}', coalesce(v_base->'filtered_tables','{}'::jsonb) || jsonb_build_object(
      'services','clinic-owned rows plus explicitly referenced unassigned historical services',
      'price_lists','clinic-owned rows plus explicitly referenced unassigned historical lists',
      'price_list_items','clinic-owned rows plus explicitly referenced unassigned historical items; unrelated legacy list items excluded'
    ));
  end if;
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb) into v_tables from jsonb_object_keys(v_data) as keys(k);
  v_domain_hashes := case when p_domain='products' then jsonb_build_object(
    'services',v_projection->'table_sha256'->'services',
    'price_lists',v_projection->'table_sha256'->'price_lists',
    'price_list_items',v_projection->'table_sha256'->'price_list_items')
    when p_domain='transactions' then jsonb_build_object(
      'price_master_audit',v_projection->'table_sha256'->'price_master_audit',
      'cnyos_billing_internal.invoice_orders',v_projection->'table_sha256'->'cnyos_billing_internal.invoice_orders',
      'cnyos_billing_internal.invoice_source_charges',v_projection->'table_sha256'->'cnyos_billing_internal.invoice_source_charges',
      'cnyos_billing_internal.invoice_request_receipts',v_projection->'table_sha256'->'cnyos_billing_internal.invoice_request_receipts',
      'cnyos_treatment_internal.session_request_receipts',v_projection->'table_sha256'->'cnyos_treatment_internal.session_request_receipts')
    else '{}'::jsonb end;
  return jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_base,'{schema_version}','"2026-09-26.1"'::jsonb),'{included_tables}',v_tables),'{data}',v_data),'{table_sha256}',v_domain_hashes);
end; $$;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public, anon, authenticated;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table(ready boolean,schema_version text,domain_count integer,patient_table_count integer,product_table_count integer,pharmacy_table_count integer,transaction_table_count integer,managed_database_restore_required boolean)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select true,'2026-09-26.1',4,31,16,7,17,true where auth.role()='service_role' or public.is_super_admin();
$$;
revoke all on function public.backup_restore_contract_healthcheck() from public, anon;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated, service_role;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_base jsonb; v_projection jsonb; v_counts jsonb; v_hashes jsonb; v_anomalies integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.clinics c where c.id=p_clinic_id) then raise exception 'CLINIC_NOT_FOUND'; end if;
  v_base:=public.verify_clinic_restore_trace_v20260901(p_clinic_id);
  v_projection:=cnyos_backup_internal.financial_tenant_projection(p_clinic_id);
  v_counts:=coalesce(v_base->'counts','{}'::jsonb)||(v_projection->'counts');
  v_hashes:=v_projection->'table_sha256';
  v_anomalies:=coalesce((v_base->>'referential_integrity_anomalies')::integer,0)+(v_projection->>'anomalies')::integer;
  return v_base||jsonb_build_object('schema_version','2026-09-26.1','ready',(v_base->>'ready')::boolean and v_anomalies=0,'counts',v_counts,'table_sha256',v_hashes,'referential_integrity_anomalies',v_anomalies);
end; $$;
revoke all on function public.verify_clinic_restore_trace(uuid) from public, anon, authenticated;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

commit;

select 'FINANCIAL_BACKUP_PROVENANCE_READY' as status;
