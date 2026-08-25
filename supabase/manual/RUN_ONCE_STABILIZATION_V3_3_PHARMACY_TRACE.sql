-- CHANANYA CLINICAL OS v3.3
-- Prescription -> Dispense -> Billing-state traceability
begin;

create or replace view public.v_prescription_pharmacy_traceability
with (security_invoker=true) as
select
  p.id as prescription_id,
  p.prescription_no,
  p.encounter_id,
  p.patient_id,
  p.prescribed_at,
  d.id as dispensing_order_id,
  d.queue_number,
  d.status as dispensing_status,
  d.created_at as dispensing_created_at,
  case
    when d.status='billed' then 'billed'
    when d.status='submitted_to_billing' then 'submitted_to_billing'
    when d.status='dispensed' then 'ready_for_billing'
    else 'not_ready'
  end as billing_state,
  (select count(*) from public.prescription_items pi where pi.prescription_id=p.id) as prescribed_item_count,
  (select count(*) from public.dispensing_items di where di.dispensing_order_id=d.id) as dispensing_allocation_count,
  (select coalesce(sum(di.quantity_dispensed),0) from public.dispensing_items di where di.dispensing_order_id=d.id) as total_quantity_dispensed
from public.prescriptions p
left join public.dispensing_orders d on d.prescription_id=p.id;

grant select on public.v_prescription_pharmacy_traceability to authenticated;

create or replace function public.get_prescription_traceability(p_prescription_id uuid)
returns setof public.v_prescription_pharmacy_traceability
language sql
security invoker
set search_path=public
as $$
  select * from public.v_prescription_pharmacy_traceability
  where prescription_id=p_prescription_id;
$$;

grant execute on function public.get_prescription_traceability(uuid) to authenticated;

commit;

with checks(name,ready) as (
  values
    ('traceability_view',to_regclass('public.v_prescription_pharmacy_traceability') is not null),
    ('traceability_rpc',to_regprocedure('public.get_prescription_traceability(uuid)') is not null),
    ('audit_table',to_regclass('public.clinical_record_audit_events') is not null),
    ('signoff_table',to_regclass('public.clinical_record_signoffs') is not null),
    ('amendment_rpc',to_regprocedure('public.unlock_clinical_record_for_amendment(uuid,text)') is not null),
    ('dispensing_orders',to_regclass('public.dispensing_orders') is not null),
    ('dispensing_items',to_regclass('public.dispensing_items') is not null)
), s as (
  select count(*) total,count(*) filter(where ready) ok,count(*) filter(where not ready) missing from checks
)
select name,case when ready then 'READY' else 'MISSING' end status from checks
union all
select 'SUMMARY',case when missing=0 then 'CHANANYA_CLINICAL_OS_V3_3 READY '||ok||'/'||total else 'CHANANYA_CLINICAL_OS_V3_3 MISSING '||missing||' OF '||total end from s
order by name;