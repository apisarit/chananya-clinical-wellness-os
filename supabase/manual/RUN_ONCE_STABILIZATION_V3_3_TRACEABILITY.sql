-- CHANANYA Clinical OS v3.3 — Pharmacy traceability release gate
-- Safe/idempotent: adds a read-only traceability view without altering clinical records.

create or replace view public.v_prescription_dispense_traceability
with (security_invoker = true)
as
select
  p.id as prescription_id,
  p.prescription_no,
  p.patient_id,
  p.encounter_id,
  p.status as prescription_status,
  d.id as dispensing_order_id,
  d.status as dispensing_status,
  d.created_at as dispensing_created_at,
  count(di.id) as dispensing_line_count,
  coalesce(sum(di.quantity_dispensed),0) as total_quantity_dispensed
from public.prescriptions p
left join public.dispensing_orders d on d.prescription_id = p.id
left join public.dispensing_items di on di.dispensing_order_id = d.id
group by p.id,p.prescription_no,p.patient_id,p.encounter_id,p.status,d.id,d.status,d.created_at;

grant select on public.v_prescription_dispense_traceability to authenticated;

-- Release gate. Billing is intentionally checked by capability because deployments may
-- use invoice/billing tables from different migration generations.
with checks as (
  select 'prescriptions' item, to_regclass('public.prescriptions') is not null ok
  union all select 'prescription_items', to_regclass('public.prescription_items') is not null
  union all select 'dispensing_orders', to_regclass('public.dispensing_orders') is not null
  union all select 'dispensing_items', to_regclass('public.dispensing_items') is not null
  union all select 'inventory_lots', to_regclass('public.inventory_lots') is not null
  union all select 'clinical_audit_events', to_regclass('public.clinical_audit_events') is not null
  union all select 'clinical_record_signoffs', to_regclass('public.clinical_record_signoffs') is not null
  union all select 'traceability_view', to_regclass('public.v_prescription_dispense_traceability') is not null
)
select item, case when ok then 'READY' else 'MISSING' end status from checks
union all
select 'SUMMARY', case when bool_and(ok) then 'CHANANYA_CLINICAL_OS_V3_3 READY 8/8' else 'CHANANYA_CLINICAL_OS_V3_3 NOT READY' end from checks;
