begin;

-- ============================================================
-- ATOMIC PRESCRIPTION PHARMACY EXECUTION
--
-- The original prescription queue stopped after Clinical handed the order to
-- Pharmacy.  This RPC completes the missing Review -> FEFO Dispense -> Submit
-- Billing boundary without allowing browser-side stock or dispensing writes.
-- ============================================================

create or replace function public.transition_atomic_prescription_dispensing(
  p_dispensing_order_id uuid,
  p_action text,
  p_item_prices jsonb default '[]'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.dispensing_orders%rowtype;
  v_prescription public.prescriptions%rowtype;
  v_item public.prescription_items%rowtype;
  v_lot record;
  v_price_entry jsonb;
  v_unit_price numeric(18,2);
  v_remaining numeric(18,4);
  v_take numeric(18,4);
  v_item_count integer := 0;
  v_allocation_count integer := 0;
  v_medication_total numeric(18,2) := 0;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  if p_dispensing_order_id is null then
    raise exception 'DISPENSING_ORDER_REQUIRED';
  end if;
  if v_action not in ('review','dispense','submit_billing') then
    raise exception 'PRESCRIPTION_DISPENSING_ACTION_INVALID';
  end if;
  if length(coalesce(p_reason, '')) > 1000 then
    raise exception 'PRESCRIPTION_DISPENSING_REASON_TOO_LONG';
  end if;

  select d.* into v_order
  from public.dispensing_orders d
  join public.prescriptions rx on rx.id = d.prescription_id
  join public.encounters e on e.id = rx.encounter_id
  where d.id = p_dispensing_order_id
    and e.clinic_id = v_clinic_id
  for update of d;

  if not found then
    raise exception 'DISPENSING_ORDER_NOT_FOUND';
  end if;

  select * into v_prescription
  from public.prescriptions rx
  where rx.id = v_order.prescription_id
  for update;

  if v_action = 'review' then
    if v_order.status in ('reviewed','dispensed','submitted_to_billing','billed') then
      return jsonb_build_object(
        'dispensing_order_id', v_order.id,
        'status', v_order.status,
        'idempotent', true
      );
    end if;
    if v_order.status not in ('waiting','pending') then
      raise exception 'PRESCRIPTION_ORDER_NOT_REVIEWABLE';
    end if;

    update public.dispensing_orders
    set status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now(),
        updated_at = now()
    where id = v_order.id
    returning * into v_order;

    update public.prescriptions
    set status = 'in_pharmacy', updated_at = now()
    where id = v_prescription.id;

    insert into public.audit_logs(
      clinic_id,user_id,action,entity,entity_id,metadata
    ) values (
      v_clinic_id,auth.uid(),'review_prescription_dispensing',
      'dispensing_orders',v_order.id::text,
      jsonb_build_object(
        'prescription_id',v_prescription.id,
        'prescription_no',v_prescription.prescription_no,
        'reason',nullif(btrim(p_reason),'')
      )
    );

    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'idempotent',false
    );
  end if;

  if v_action = 'dispense' then
    if v_order.status in ('dispensed','submitted_to_billing','billed') then
      select count(*)::int, coalesce(sum(di.quantity_dispensed * di.unit_price),0)
      into v_allocation_count, v_medication_total
      from public.dispensing_items di
      where di.dispensing_order_id = v_order.id
        and di.status = 'dispensed';
      return jsonb_build_object(
        'dispensing_order_id',v_order.id,
        'status',v_order.status,
        'allocation_count',v_allocation_count,
        'medication_total',v_medication_total,
        'idempotent',true
      );
    end if;
    if v_order.status <> 'reviewed' then
      raise exception 'PRESCRIPTION_ORDER_NOT_REVIEWED';
    end if;
    if p_item_prices is null or jsonb_typeof(p_item_prices) <> 'array' then
      raise exception 'PRESCRIPTION_ITEM_PRICES_MUST_BE_ARRAY';
    end if;

    for v_item in
      select pi.*
      from public.prescription_items pi
      where pi.prescription_id = v_prescription.id
        and pi.status = 'ordered'
      order by pi.created_at, pi.id
      for update
    loop
      v_item_count := v_item_count + 1;

      select entry.value into v_price_entry
      from jsonb_array_elements(p_item_prices) entry(value)
      where entry.value ->> 'prescription_item_id' = v_item.id::text;

      if v_price_entry is null then
        raise exception 'PRESCRIPTION_ITEM_PRICE_REQUIRED';
      end if;
      begin
        v_unit_price := (v_price_entry ->> 'unit_price')::numeric(18,2);
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'PRESCRIPTION_ITEM_PRICE_INVALID';
      end;
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 1000000 then
        raise exception 'PRESCRIPTION_ITEM_PRICE_INVALID';
      end if;

      v_remaining := v_item.quantity_prescribed;
      for v_lot in
        select l.id, l.current_quantity, l.expiry_date, l.lot_number
        from public.inventory_lots l
        where l.clinic_id = v_clinic_id
          and l.product_id = v_item.product_id
          and l.status = 'active'
          and l.current_quantity > 0
          and (l.expiry_date is null or l.expiry_date >= current_date)
        order by l.expiry_date nulls last, l.received_at, l.id
        for update
      loop
        exit when v_remaining <= 0;
        v_take := least(v_remaining, v_lot.current_quantity);

        insert into public.dispensing_items(
          dispensing_order_id,prescription_item_id,inventory_lot_id,
          quantity_dispensed,unit,unit_price,status,notes
        ) values (
          v_order.id,v_item.id,v_lot.id,v_take,v_item.unit,v_unit_price,
          'dispensed','FEFO prescription allocation'
        );

        insert into public.stock_movements(
          clinic_id,inventory_lot_id,movement_type,quantity,direction,
          reference_type,reference_id,reason,performed_by
        ) values (
          v_clinic_id,v_lot.id,'prescription_dispense',v_take,'out',
          'dispensing_order',v_order.id,'Prescription FEFO dispensing',auth.uid()
        );

        v_remaining := v_remaining - v_take;
        v_allocation_count := v_allocation_count + 1;
      end loop;

      if v_remaining > 0 then
        raise exception 'PRESCRIPTION_STOCK_INSUFFICIENT';
      end if;

      update public.prescription_items
      set status = 'dispensed', updated_at = now()
      where id = v_item.id;

      v_medication_total := v_medication_total
        + (v_item.quantity_prescribed * v_unit_price);
    end loop;

    if v_item_count = 0 then
      raise exception 'PRESCRIPTION_PENDING_ITEM_REQUIRED';
    end if;

    if jsonb_array_length(p_item_prices) <> v_item_count then
      raise exception 'PRESCRIPTION_ITEM_PRICE_COUNT_MISMATCH';
    end if;

    update public.dispensing_orders
    set status = 'dispensed', prepared_by = auth.uid(), prepared_at = now(),
        dispensed_by = auth.uid(), dispensed_at = now(), updated_at = now()
    where id = v_order.id
    returning * into v_order;

    update public.prescriptions
    set status = 'dispensed', completed_at = now(), updated_at = now()
    where id = v_prescription.id;

    insert into public.audit_logs(
      clinic_id,user_id,action,entity,entity_id,metadata
    ) values (
      v_clinic_id,auth.uid(),'dispense_prescription_order',
      'dispensing_orders',v_order.id::text,
      jsonb_build_object(
        'prescription_id',v_prescription.id,
        'prescription_no',v_prescription.prescription_no,
        'item_count',v_item_count,
        'allocation_count',v_allocation_count,
        'medication_total',v_medication_total,
        'allocation','FEFO',
        'reason',nullif(btrim(p_reason),'')
      )
    );

    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'item_count',v_item_count,
      'allocation_count',v_allocation_count,
      'medication_total',v_medication_total,
      'idempotent',false
    );
  end if;

  if v_order.status in ('submitted_to_billing','billed') then
    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'idempotent',true
    );
  end if;
  if v_order.status <> 'dispensed' then
    raise exception 'PRESCRIPTION_ORDER_NOT_DISPENSED';
  end if;

  update public.dispensing_orders
  set status = 'submitted_to_billing', updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.audit_logs(
    clinic_id,user_id,action,entity,entity_id,metadata
  ) values (
    v_clinic_id,auth.uid(),'submit_prescription_to_billing',
    'dispensing_orders',v_order.id::text,
    jsonb_build_object(
      'prescription_id',v_prescription.id,
      'prescription_no',v_prescription.prescription_no,
      'reason',nullif(btrim(p_reason),'')
    )
  );

  return jsonb_build_object(
    'dispensing_order_id',v_order.id,
    'status',v_order.status,
    'idempotent',false
  );
end;
$$;

create or replace function public.prescription_dispensing_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_regprocedure(
      'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'
    ) is not null,
    '2026-08-27.2'::text;
$$;

revoke all on function public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text) from public;
revoke all on function public.prescription_dispensing_healthcheck() from public;
grant execute on function public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)
  to authenticated, service_role;
grant execute on function public.prescription_dispensing_healthcheck()
  to authenticated, service_role;

-- Operational users may inspect authorized rows, but only the RPC above may
-- execute prescription stock or order transitions.
revoke insert, update, delete on public.dispensing_orders from authenticated;
revoke insert, update, delete on public.dispensing_items from authenticated;
revoke insert, update, delete on public.stock_movements from authenticated;
grant select on public.dispensing_orders, public.dispensing_items,
  public.stock_movements to authenticated;

commit;

select
  'CHANANYA_ATOMIC_PRESCRIPTION_DISPENSING_READY' as status,
  to_regprocedure(
    'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'
  ) as dispensing_rpc;
