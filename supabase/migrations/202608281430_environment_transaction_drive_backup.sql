begin;

-- A fourth encrypted export domain preserves the canonical audit ledger and
-- financial transaction chain independently from clinical and pharmacy data.
-- The Netlify worker binds each encrypted object to its deployment environment,
-- source revision and isolated Drive tree in authenticated metadata.
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
  v_payload jsonb;
  v_requested_clinic uuid := p_clinic_id;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists (select 1 from public.clinics c where c.id=p_clinic_id and c.active) then
    raise exception 'CLINIC_NOT_FOUND';
  end if;

  if p_domain = 'patients' then
    select jsonb_build_object(
      'patients',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.patients p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_allergies',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.patient_allergies a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'encounters',coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at) from public.encounters e where e.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'products' then
    select jsonb_build_object(
      'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.sku) from public.products p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'suppliers',coalesce((select jsonb_agg(to_jsonb(s) order by s.supplier_code) from public.suppliers s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'inventory_lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from public.inventory_lots l where l.clinic_id=v_requested_clinic),'[]'::jsonb),
      'stock_movements',coalesce((select jsonb_agg(to_jsonb(s) order by s.occurred_at) from public.stock_movements s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formulas',coalesce((select jsonb_agg(to_jsonb(f) order by f.formula_code,f.revision) from public.formulas f where f.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formula_components',coalesce((select jsonb_agg(to_jsonb(c) order by c.formula_id,c.sequence_no) from public.formula_components c where c.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.requested_at) from public.production_requests r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at) from public.production_orders o where o.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_material_issues',coalesce((select jsonb_agg(to_jsonb(i) order by i.issued_at) from public.production_material_issues i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_qc',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from public.production_qc q where q.clinic_id=v_requested_clinic),'[]'::jsonb),
      'finished_goods_receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.received_at) from public.finished_goods_receipts r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_batches',coalesce((select jsonb_agg(to_jsonb(b) order by b.uploaded_at) from public.import_batches b where b.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.import_batch_id,r.row_number) from public.import_rows r where r.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'pharmacy' then
    select jsonb_build_object(
      'counter_sales',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.pharmacy_counter_sales s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_sale_items',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.pharmacy_counter_sale_items i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_allocations',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.pharmacy_counter_allocations a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescriptions',coalesce((select jsonb_agg(to_jsonb(rx) order by rx.created_at) from public.prescriptions rx join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescription_items',coalesce((select jsonb_agg(to_jsonb(ri) order by ri.created_at) from public.prescription_items ri join public.prescriptions rx on rx.id=ri.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_orders',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_items',coalesce((select jsonb_agg(to_jsonb(di) order by di.created_at) from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'transactions' then
    select jsonb_build_object(
      'audit_logs',coalesce((
        select jsonb_agg(to_jsonb(a) order by a.occurred_at,a.id)
        from public.audit_logs a
        where a.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'invoices',coalesce((
        select jsonb_agg(to_jsonb(i) order by i.created_at,i.id)
        from public.invoices i
        join public.patients p on p.id=i.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'invoice_items',coalesce((
        select jsonb_agg(to_jsonb(ii) order by ii.created_at,ii.id)
        from public.invoice_items ii
        join public.invoices i on i.id=ii.invoice_id
        join public.patients p on p.id=i.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'payments',coalesce((
        select jsonb_agg(to_jsonb(pay) order by pay.created_at,pay.id)
        from public.payments pay
        join public.invoices i on i.id=pay.invoice_id
        join public.patients p on p.id=i.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb)
    ) into v_payload;
  else
    raise exception 'BACKUP_DOMAIN_INVALID';
  end if;

  return jsonb_build_object(
    'format','chananya-domain-export/v1',
    'schema_version','2026-08-28.1',
    'clinic_id',p_clinic_id,
    'domain',p_domain,
    'exported_at',now(),
    'data',coalesce(v_payload,'{}'::jsonb)
  );
end;
$$;

revoke all on function public.export_clinic_backup_domain(uuid,text) from public, anon, authenticated;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

commit;

select
  'CHANANYA_ENVIRONMENT_TRANSACTION_BACKUP_READY' as status,
  to_regprocedure('public.export_clinic_backup_domain(uuid,text)') as export_rpc;
