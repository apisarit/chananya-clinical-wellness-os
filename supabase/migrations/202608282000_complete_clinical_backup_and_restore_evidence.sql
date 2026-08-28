begin;

-- The Drive export is an encrypted, tenant-scoped logical recovery package and
-- audit artifact. A managed database backup/PITR remains mandatory because
-- Supabase Auth identities, platform configuration and database internals
-- cannot be safely reconstructed by replaying JSON rows.
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
  v_included_tables jsonb;
  v_filtered_tables jsonb := '{}'::jsonb;
  v_excluded_tables jsonb := '[]'::jsonb;
  v_requested_clinic uuid := p_clinic_id;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists (select 1 from public.clinics c where c.id=p_clinic_id and c.active) then
    raise exception 'CLINIC_NOT_FOUND';
  end if;

  if p_domain = 'patients' then
    select jsonb_build_object(
      'patients',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.patients p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_allergies',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.patient_allergies a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_user_links',coalesce((
        select jsonb_agg(to_jsonb(l) order by l.patient_id)
        from public.patient_user_links l
        join public.patients p on p.id=l.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'appointments',coalesce((
        select jsonb_agg(to_jsonb(a) order by a.id)
        from public.appointments a
        join public.patients p on p.id=a.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'practitioner_schedules',coalesce((
        select jsonb_agg(to_jsonb(s) order by s.id)
        from public.practitioner_schedules s
        where exists (
          select 1 from public.clinic_appointments a
          join public.patients p on p.id=a.patient_id
          where a.schedule_id=s.id and p.clinic_id=v_requested_clinic
        )
      ),'[]'::jsonb),
      'clinic_appointments',coalesce((
        select jsonb_agg(to_jsonb(a) order by a.id)
        from public.clinic_appointments a
        join public.patients p on p.id=a.patient_id
        where p.clinic_id=v_requested_clinic
      ),'[]'::jsonb),
      'encounters',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.encounters e where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'vital_signs',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.vital_signs x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'pain_assessments',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.pain_assessments x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'pain_markers',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.pain_markers x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'intermediate_care_assessments',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.intermediate_care_assessments x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'barthel_assessments',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.barthel_assessments x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_examination_findings',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clinical_examination_findings x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'ttm_opd_histories',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.ttm_opd_histories x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'ttm_diagnostic_contexts',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.ttm_diagnostic_contexts x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'ttm_structured_diagnoses',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.ttm_structured_diagnoses x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'ttm_encounter_concepts',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.ttm_encounter_concepts x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'body_pain_points',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.body_pain_points x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_treatment_plans',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clinical_treatment_plans x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'treatment_orders',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.treatment_orders x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'treatment_sessions',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.treatment_sessions x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_treatment_sessions',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clinical_treatment_sessions x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'followups',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.followups x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_followup_notes',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clinical_followup_notes x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_record_signoffs',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clinical_record_signoffs x join public.encounters e on e.id=x.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_identity_links',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.patient_identity_links x where x.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_identity_link_requests',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.id)
        from public.patient_identity_link_requests x
        where x.clinic_id=v_requested_clinic
          and (x.claimed_at is not null or x.invalidated_at is not null or x.expires_at <= now())
      ),'[]'::jsonb),
      'patient_qr_sessions',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.id)
        from public.patient_qr_sessions x
        where x.clinic_id=v_requested_clinic
          and (x.used_at is not null or x.expires_at <= now())
      ),'[]'::jsonb),
      'encounter_identity_verifications',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.encounter_identity_verifications x where x.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
    v_filtered_tables := jsonb_build_object(
      'patient_identity_link_requests','terminal rows only: claimed, invalidated or expired',
      'patient_qr_sessions','terminal rows only: used or expired',
      'practitioner_schedules','schedules referenced by this clinic appointments'
    );
    v_excluded_tables := jsonb_build_array(
      'patient_identity_rate_limits',
      'active patient_identity_link_requests',
      'active unused patient_qr_sessions'
    );
  elsif p_domain = 'products' then
    select jsonb_build_object(
      'services',coalesce((
        select jsonb_agg(to_jsonb(s) order by s.id) from public.services s where
          exists(select 1 from public.appointments a join public.patients p on p.id=a.patient_id where a.service_id=s.id and p.clinic_id=v_requested_clinic)
          or exists(select 1 from public.clinic_appointments a join public.patients p on p.id=a.patient_id where a.service_id=s.id and p.clinic_id=v_requested_clinic)
          or exists(select 1 from public.treatment_orders x join public.encounters e on e.id=x.encounter_id where x.service_id=s.id and e.clinic_id=v_requested_clinic)
          or exists(select 1 from public.treatment_sessions x join public.encounters e on e.id=x.encounter_id where x.service_id=s.id and e.clinic_id=v_requested_clinic)
          or exists(select 1 from public.invoice_items x join public.invoices i on i.id=x.invoice_id join public.patients p on p.id=i.patient_id where x.service_id=s.id and p.clinic_id=v_requested_clinic)
      ),'[]'::jsonb),
      'price_lists',coalesce((
        select jsonb_agg(to_jsonb(pl) order by pl.id) from public.price_lists pl where exists(
          select 1 from public.invoices i join public.patients p on p.id=i.patient_id
          where i.price_list_id=pl.id and p.clinic_id=v_requested_clinic
        )
      ),'[]'::jsonb),
      'price_list_items',coalesce((
        select jsonb_agg(to_jsonb(pli) order by pli.id) from public.price_list_items pli where exists(
          select 1 from public.invoices i join public.patients p on p.id=i.patient_id
          where i.price_list_id=pli.price_list_id and p.clinic_id=v_requested_clinic
        )
      ),'[]'::jsonb),
      'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'suppliers',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.suppliers s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'inventory_lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.inventory_lots l where l.clinic_id=v_requested_clinic),'[]'::jsonb),
      'stock_movements',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.stock_movements s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formulas',coalesce((select jsonb_agg(to_jsonb(f) order by f.id) from public.formulas f where f.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formula_components',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.formula_components c where c.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.production_requests r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from public.production_orders o where o.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_material_issues',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.production_material_issues i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_qc',coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from public.production_qc q where q.clinic_id=v_requested_clinic),'[]'::jsonb),
      'finished_goods_receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.finished_goods_receipts r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_batches',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from public.import_batches b where b.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.import_rows r where r.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
    v_filtered_tables := jsonb_build_object(
      'services','rows referenced by this clinic operational records',
      'price_lists','rows referenced by this clinic invoices',
      'price_list_items','rows belonging to referenced price lists'
    );
  elsif p_domain = 'pharmacy' then
    select jsonb_build_object(
      'counter_sales',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.pharmacy_counter_sales s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_sale_items',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.pharmacy_counter_sale_items i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_allocations',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.pharmacy_counter_allocations a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescriptions',coalesce((select jsonb_agg(to_jsonb(rx) order by rx.id) from public.prescriptions rx join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescription_items',coalesce((select jsonb_agg(to_jsonb(ri) order by ri.id) from public.prescription_items ri join public.prescriptions rx on rx.id=ri.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_orders',coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_items',coalesce((select jsonb_agg(to_jsonb(di) order by di.id) from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'transactions' then
    select jsonb_build_object(
      'audit_logs',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_logs a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'clinical_record_audit_events',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.clinical_record_audit_events a join public.encounters e on e.id=a.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'appointment_events',coalesce((select jsonb_agg(to_jsonb(ae) order by ae.id) from public.appointment_events ae join public.clinic_appointments a on a.id=ae.appointment_id join public.patients p on p.id=a.patient_id where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_identity_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.patient_identity_events e where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'invoices',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.invoices i join public.patients p on p.id=i.patient_id where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'invoice_items',coalesce((select jsonb_agg(to_jsonb(ii) order by ii.id) from public.invoice_items ii join public.invoices i on i.id=ii.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'payments',coalesce((select jsonb_agg(to_jsonb(pay) order by pay.id) from public.payments pay join public.invoices i on i.id=pay.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  else
    raise exception 'BACKUP_DOMAIN_INVALID';
  end if;

  select coalesce(jsonb_agg(k order by k),'[]'::jsonb)
  into v_included_tables
  from jsonb_object_keys(coalesce(v_payload,'{}'::jsonb)) as keys(k);

  return jsonb_build_object(
    'format','chananya-domain-export/v1',
    'schema_version','2026-08-28.2',
    'clinic_id',p_clinic_id,
    'domain',p_domain,
    'exported_at',now(),
    'included_tables',v_included_tables,
    'filtered_tables',v_filtered_tables,
    'excluded_tables',v_excluded_tables,
    'recovery_model',jsonb_build_object(
      'drive_export','encrypted tenant-scoped logical recovery evidence',
      'full_database_restore','managed database backup or PITR required',
      'auth_restore','managed restore or reviewed identity mapping required',
      'not_logically_exported',jsonb_build_array('auth.users','profiles','clinics','clinic_memberships','database internals')
    ),
    'data',coalesce(v_payload,'{}'::jsonb)
  );
end;
$$;

revoke all on function public.export_clinic_backup_domain(uuid,text) from public, anon, authenticated;
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
  select true,'2026-08-28.2',4,29,16,7,7,true
  where auth.role()='service_role' or public.is_super_admin();
$$;

revoke all on function public.backup_restore_contract_healthcheck() from public, anon;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated, service_role;

-- Deactivating clinic membership revokes every application/database capability
-- for an already-issued JWT because current_access_context and department_can
-- resolve active membership on every request. Auth token expiry remains the
-- responsibility of the isolated Supabase Auth configuration and E2E evidence.
create or replace function public.admin_set_staff_membership_active(
  p_user_id uuid,
  p_active boolean,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_membership public.clinic_memberships%rowtype;
  v_system_role text;
  v_reason text := btrim(coalesce(p_reason,''));
begin
  if v_clinic_id is null or not public.department_can('governance') then
    raise exception 'GOVERNANCE_DEPARTMENT_REQUIRED';
  end if;
  if length(v_reason)<5 then raise exception 'MEMBERSHIP_CHANGE_REASON_REQUIRED'; end if;
  if p_user_id=auth.uid() and not p_active then raise exception 'SELF_DEACTIVATION_NOT_ALLOWED'; end if;

  select m.* into v_membership
  from public.clinic_memberships m
  where m.clinic_id=v_clinic_id and m.profile_id=p_user_id
  for update;
  if not found then raise exception 'CLINIC_MEMBERSHIP_NOT_FOUND'; end if;
  select p.system_role into v_system_role from public.profiles p where p.id=p_user_id;
  if v_system_role='super_admin' then raise exception 'SUPER_ADMIN_MEMBERSHIP_PROTECTED'; end if;
  if v_system_role='admin' and not public.is_super_admin() then raise exception 'SYSTEM_ADMIN_MEMBERSHIP_PROTECTED'; end if;
  if v_membership.clinic_role='owner' and not p_active and (
    select count(*) from public.clinic_memberships m
    where m.clinic_id=v_clinic_id and m.clinic_role='owner' and m.active
  )<=1 then raise exception 'LAST_CLINIC_OWNER_PROTECTED'; end if;

  update public.clinic_memberships
  set active=p_active,
      is_primary=case when p_active then is_primary else false end,
      updated_at=now()
  where clinic_id=v_clinic_id and profile_id=p_user_id;

  if p_active and not exists(
    select 1 from public.clinic_memberships m
    where m.profile_id=p_user_id and m.active and m.is_primary
  ) then
    update public.clinic_memberships
    set is_primary=true,updated_at=now()
    where clinic_id=v_clinic_id and profile_id=p_user_id;
  end if;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values(
    v_clinic_id,auth.uid(),
    case when p_active then 'activate_staff_membership' else 'deactivate_staff_membership' end,
    'clinic_memberships',p_user_id::text,
    jsonb_build_object('old_active',v_membership.active,'new_active',p_active,'reason',v_reason)
  );
end;
$$;

revoke all on function public.admin_set_staff_membership_active(uuid,boolean,text) from public, anon;
grant execute on function public.admin_set_staff_membership_active(uuid,boolean,text) to authenticated;

-- This verifier runs only after an operator restores a managed backup/PITR into
-- an isolated project. It reports non-PHI counts and a complete clinical to
-- financial trace; it does not mutate or replay records.
create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_counts jsonb;
  v_orphans integer;
  v_complete_chains integer;
  v_latest_activity timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.clinics c where c.id=p_clinic_id) then raise exception 'CLINIC_NOT_FOUND'; end if;

  select jsonb_build_object(
    'patients',(select count(*) from public.patients p where p.clinic_id=p_clinic_id),
    'patient_allergies',(select count(*) from public.patient_allergies a where a.clinic_id=p_clinic_id),
    'encounters',(select count(*) from public.encounters e where e.clinic_id=p_clinic_id),
    'clinical_record_signoffs',(select count(*) from public.clinical_record_signoffs s join public.encounters e on e.id=s.encounter_id where e.clinic_id=p_clinic_id),
    'products',(select count(*) from public.products p where p.clinic_id=p_clinic_id),
    'inventory_lots',(select count(*) from public.inventory_lots l where l.clinic_id=p_clinic_id),
    'prescriptions',(select count(*) from public.prescriptions rx join public.encounters e on e.id=rx.encounter_id where e.clinic_id=p_clinic_id),
    'dispensing_orders',(select count(*) from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=p_clinic_id),
    'dispensing_items',(select count(*) from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=p_clinic_id),
    'audit_logs',(select count(*) from public.audit_logs a where a.clinic_id=p_clinic_id),
    'invoices',(select count(*) from public.invoices i join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id),
    'invoice_items',(select count(*) from public.invoice_items ii join public.invoices i on i.id=ii.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id),
    'payments',(select count(*) from public.payments pay join public.invoices i on i.id=pay.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id)
  ) into v_counts;

  select
    (select count(*) from public.patient_allergies a where a.clinic_id=p_clinic_id and not exists(select 1 from public.patients p where p.id=a.patient_id and p.clinic_id=p_clinic_id))
    + (select count(*) from public.encounters e where e.clinic_id=p_clinic_id and not exists(select 1 from public.patients p where p.id=e.patient_id and p.clinic_id=p_clinic_id))
    + (select count(*) from public.prescriptions rx join public.encounters e on e.id=rx.encounter_id where e.clinic_id=p_clinic_id and not exists(select 1 from public.patients p where p.id=rx.patient_id and p.clinic_id=p_clinic_id))
    + (select count(*) from public.dispensing_items di
       join public.dispensing_orders d on d.id=di.dispensing_order_id
       join public.prescriptions rx on rx.id=d.prescription_id
       join public.encounters e on e.id=rx.encounter_id
       join public.inventory_lots l on l.id=di.inventory_lot_id
       where e.clinic_id=p_clinic_id and l.clinic_id<>p_clinic_id)
  into v_orphans;

  select count(distinct e.id)
  into v_complete_chains
  from public.encounters e
  join public.prescriptions rx on rx.encounter_id=e.id
  join public.dispensing_orders d on d.prescription_id=rx.id
  join public.invoices i on i.encounter_id=e.id
  join public.payments pay on pay.invoice_id=i.id
  where e.clinic_id=p_clinic_id;

  select max(activity_at) into v_latest_activity from (
    select max(p.updated_at) activity_at from public.patients p where p.clinic_id=p_clinic_id
    union all select max(e.updated_at) from public.encounters e where e.clinic_id=p_clinic_id
    union all select max(a.occurred_at) from public.audit_logs a where a.clinic_id=p_clinic_id
    union all select max(pay.updated_at) from public.payments pay join public.invoices i on i.id=pay.invoice_id join public.patients p on p.id=i.patient_id where p.clinic_id=p_clinic_id
  ) activity;

  return jsonb_build_object(
    'ready',v_orphans=0,
    'schema_version','2026-08-28.2',
    'clinic_id',p_clinic_id,
    'counts',v_counts,
    'referential_integrity_anomalies',v_orphans,
    'complete_clinical_financial_chains',v_complete_chains,
    'latest_activity_at',v_latest_activity,
    'verified_at',now()
  );
end;
$$;

revoke all on function public.verify_clinic_restore_trace(uuid) from public, anon, authenticated;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

commit;

select
  'CHANANYA_COMPLETE_BACKUP_RESTORE_EVIDENCE_READY' as status,
  to_regprocedure('public.export_clinic_backup_domain(uuid,text)') as export_rpc,
  to_regprocedure('public.verify_clinic_restore_trace(uuid)') as restore_rpc;
