-- Review-only projection; not activation, a complete provenance certificate or causality.
begin;
set local statement_timeout = '30s';
do $$ begin raise exception 'OUTCOME_LOT_TRACE_REVIEW_REQUIRED'; end $$;

create or replace function public.clinical_outcome_lot_trace(p_encounter_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_patient uuid;
  v_rows jsonb;
  v_link_conflicts bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'ACTIVE_CLINIC_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.department_can('clinical') then raise exception 'PERMISSION_DENIED'; end if;
  select e.patient_id into v_patient from public.encounters e
    join public.patients p on p.id=e.patient_id and p.clinic_id=v_clinic
    where e.id=p_encounter_id and e.clinic_id=v_clinic
      and e.status not in ('cancelled','void');
  if not found then raise exception 'ENCOUNTER_NOT_AVAILABLE'; end if;

  -- Count broken edges without returning identifiers from the foreign prescription.
  select count(*) into v_link_conflicts
  from public.prescriptions rx
  join public.dispensing_orders d on d.prescription_id=rx.id
  join public.dispensing_items di on di.dispensing_order_id=d.id
  where rx.encounter_id=p_encounter_id and rx.status not in ('cancelled','void','superseded')
    and di.status not in ('cancelled','void')
    and not exists (select 1 from public.prescription_items pi
      where pi.id=di.prescription_item_id and pi.prescription_id=rx.id
        and pi.status not in ('cancelled','void'));

  with edges as (
    select rx.id rx_id, pi.id pi_id, d.id order_id, di.id item_id,
      di.inventory_lot_id requested_lot, lot.id lot_id, lot.lot_number,
      di.quantity_dispensed, pi.quantity_prescribed,
      prescribed.total_dispensed,
      case
        when pi.id is null then 'not_evaluable'
        when pi.quantity_prescribed::text in ('NaN','Infinity','-Infinity')
          or prescribed.total_dispensed::text in ('NaN','Infinity','-Infinity') then 'prescribed_quantity_invalid'
        when pi.quantity_prescribed is null or pi.quantity_prescribed<=0 then 'prescribed_quantity_invalid'
        when prescribed.total_dispensed<pi.quantity_prescribed then 'under_prescribed_quantity'
        when prescribed.total_dispensed>pi.quantity_prescribed then 'over_prescribed_quantity'
        else 'matched_prescribed_quantity'
      end prescription_quantity_state,
      production.id production_order_id, formula.id formula_id, formula.revision formula_revision,
      qc.id qc_id, qc.status qc_status,
      production.actual_quantity, receipt.received_quantity receipt_quantity,
      lot.received_quantity lot_received_quantity,
      case
        when lot.id is null or receipt.id is null or production.id is null then 'not_evaluable'
        when production.actual_quantity::text in ('NaN','Infinity','-Infinity')
          or receipt.received_quantity::text in ('NaN','Infinity','-Infinity')
          or lot.received_quantity::text in ('NaN','Infinity','-Infinity') then 'receipt_quantity_invalid'
        when production.finished_product_id is distinct from lot.product_id
          or receipt.unit is distinct from lot.unit or production.planned_unit is distinct from lot.unit
          then 'receipt_context_conflict'
        when production.actual_quantity is null or production.actual_quantity<=0 then 'actual_production_quantity_missing'
        when receipt.received_quantity is null or receipt.received_quantity<=0
          or lot.received_quantity is null or lot.received_quantity<=0 then 'receipt_quantity_invalid'
        when receipt.received_quantity is distinct from production.actual_quantity then 'production_receipt_quantity_mismatch'
        when receipt.received_quantity is distinct from lot.received_quantity then 'lot_receipt_quantity_mismatch'
        else 'matched_production_receipt_quantity'
      end receipt_quantity_state,
      case
        when lot.id is null then 'not_evaluable'
        when receipt.id is null then 'production_source_unavailable'
        when production.id is null then 'production_order_missing_or_out_of_scope'
        when production.finished_product_id is distinct from lot.product_id then 'production_product_conflict'
        when receipt.unit is distinct from lot.unit or production.planned_unit is distinct from lot.unit then 'production_unit_conflict'
        when formula.id is null then 'formula_missing_or_out_of_scope'
        when formula.finished_product_id is distinct from lot.product_id then 'formula_product_conflict'
        when production.status is distinct from 'released' then 'production_not_released'
        when qc.id is null then 'qc_missing'
        when qc.status is distinct from 'passed' then 'qc_not_passed'
        when qc.approved_by is null or qc.approved_at is null then 'qc_approval_missing'
        else 'internal_qc_recorded'
      end production_state,
      stock.movement_count, stock.moved_quantity, allocated.allocated_quantity,
      case
        when lot.id is null or di.status is distinct from 'dispensed' then 'not_evaluable'
        when stock.movement_count=0 then 'movement_missing'
        when stock.moved_quantity::text in ('NaN','Infinity','-Infinity')
          or allocated.allocated_quantity::text in ('NaN','Infinity','-Infinity') then 'stock_quantity_invalid'
        when stock.invalid_count>0 then 'movement_type_conflict'
        when stock.moved_quantity is distinct from allocated.allocated_quantity then 'quantity_mismatch'
        when allocated.allocated_quantity<=0 then 'quantity_mismatch'
        else 'matched_order_lot_quantity'
      end stock_state,
      rx.status rx_status, d.status order_status, di.status item_status,
      case
        when rx.patient_id is distinct from v_patient then 'patient_link_conflict'
        when pi.id is null then 'prescription_items_missing'
        when d.id is null then 'awaiting_pharmacy'
        when di.id is null then 'dispensing_item_missing'
        when di.prescription_item_id is distinct from pi.id then 'prescription_item_conflict'
        when d.status not in ('dispensed','submitted_to_billing','paid')
          or di.status is distinct from 'dispensed' then 'not_dispensed'
        when di.quantity_dispensed::text in ('NaN','Infinity','-Infinity') then 'dispensed_quantity_invalid'
        when di.quantity_dispensed is null or di.quantity_dispensed <= 0 then 'quantity_missing'
        when lot.id is null then 'lot_missing_or_out_of_scope'
        when lot.product_id is distinct from pi.product_id then 'product_conflict'
        when lot.unit is distinct from di.unit or pi.unit is distinct from di.unit then 'unit_conflict'
        else 'recorded_dispense'
      end state
    from public.prescriptions rx
    left join public.prescription_items pi on pi.prescription_id=rx.id
      and pi.status not in ('cancelled','void')
    left join public.dispensing_orders d on d.prescription_id=rx.id
    left join public.dispensing_items di on di.dispensing_order_id=d.id
      and di.prescription_item_id=pi.id and di.status not in ('cancelled','void')
    left join public.inventory_lots lot on lot.id=di.inventory_lot_id and lot.clinic_id=v_clinic
    left join public.finished_goods_receipts receipt on receipt.inventory_lot_id=lot.id
      and receipt.clinic_id=v_clinic
    left join public.production_orders production on production.id=receipt.production_order_id
      and production.clinic_id=v_clinic
    left join public.formulas formula on formula.id=production.formula_id and formula.clinic_id=v_clinic
    left join public.production_qc qc on qc.production_order_id=production.id and qc.clinic_id=v_clinic
    left join lateral (
      select count(*) movement_count,
        count(*) filter (where sm.direction is distinct from 'out'
          or sm.movement_type is distinct from 'prescription_dispense') invalid_count,
        coalesce(sum(sm.quantity) filter (where sm.direction='out'
          and sm.movement_type='prescription_dispense'),0) moved_quantity
      from public.stock_movements sm
      where sm.clinic_id=v_clinic and sm.inventory_lot_id=lot.id
        and sm.reference_type='dispensing_order' and sm.reference_id=d.id
    ) stock on true
    left join lateral (
      select coalesce(sum(other.quantity_dispensed),0) allocated_quantity
      from public.dispensing_items other
      where other.dispensing_order_id=d.id and other.inventory_lot_id=lot.id
        and other.status='dispensed'
    ) allocated on true
    left join lateral (
      select coalesce(sum(other.quantity_dispensed),0) total_dispensed
      from public.dispensing_items other
      join public.dispensing_orders parent on parent.id=other.dispensing_order_id
      where other.prescription_item_id=pi.id and parent.prescription_id=rx.id
        and parent.status in ('dispensed','submitted_to_billing','paid')
        and other.status='dispensed'
    ) prescribed on true
    where rx.encounter_id=p_encounter_id and rx.status not in ('cancelled','void','superseded')
  ), bounded_edges as (
    -- One extra row detects overflow. Never return a silently truncated trace.
    -- This bounds JSON construction, not total join/aggregate execution cost.
    select * from edges limit 1001
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'prescription_id',rx_id,'prescription_item_id',pi_id,'dispensing_order_id',order_id,
    'dispensing_item_id',item_id,'state',state,
    'lot_id',case when state='recorded_dispense' then lot_id end,
    'lot_number',case when state='recorded_dispense' then lot_number end,
    'quantity_dispensed',quantity_dispensed,'quantity_prescribed',quantity_prescribed,
    'prescription_total_dispensed',total_dispensed,'prescription_quantity_state',prescription_quantity_state,
    'production_state',production_state,'production_order_id',production_order_id,
    'receipt_quantity_state',receipt_quantity_state,'production_actual_quantity',actual_quantity,
    'receipt_quantity',receipt_quantity,'lot_received_quantity',lot_received_quantity,
    'formula_id',formula_id,'formula_revision',formula_revision,'qc_id',qc_id,'qc_status',qc_status,
    'stock_state',stock_state,'stock_movement_count',movement_count,
    'stock_quantity',moved_quantity,'order_lot_quantity',allocated_quantity,
    'prescription_status',rx_status,'order_status',order_status,'item_status',item_status
  ) order by rx_id,pi_id,item_id),'[]'::jsonb) into v_rows from bounded_edges;
  if jsonb_array_length(v_rows)>1000 then
    raise exception 'OUTCOME_TRACE_RESULT_LIMIT_EXCEEDED';
  end if;
  return jsonb_build_object('encounter_id',p_encounter_id,'scope','encounter',
    'entries',v_rows,'link_conflict_count',v_link_conflicts,'complete',false,
    'limitations',jsonb_build_array('stock_reconciliation_is_order_lot_scoped',
      'formula_is_current_record_not_immutable_snapshot','external_coa_not_verified',
      'no_treatment_causality_claim'));
end;
$$;
revoke all on function public.clinical_outcome_lot_trace(uuid) from public, anon, authenticated, service_role;
-- No runtime grant until projection, full provenance and caller packaging are reviewed.
commit;
