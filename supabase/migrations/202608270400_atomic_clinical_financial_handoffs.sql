begin;

-- ============================================================
-- ATOMIC CLINICAL -> PHARMACY -> BILLING HANDOFFS
--
-- Browser-side multi-table writes can leave partial prescriptions, invoices
-- or payments when a request is interrupted. These RPCs make each handoff a
-- single PostgreSQL transaction, generate references on the server, enforce
-- tenant/role boundaries, and write audit evidence before commit.
-- ============================================================

alter table public.prescriptions
  add column if not exists request_key uuid,
  add column if not exists request_fingerprint text;

create unique index if not exists prescriptions_request_key_uidx
  on public.prescriptions(request_key)
  where request_key is not null;

alter table public.invoices
  add column if not exists source_dispensing_order_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_source_dispensing_order_fkey'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_source_dispensing_order_fkey
      foreign key (source_dispensing_order_id)
      references public.dispensing_orders(id) on delete restrict;
  end if;
end $$;

create unique index if not exists invoices_source_dispensing_order_uidx
  on public.invoices(source_dispensing_order_id)
  where source_dispensing_order_id is not null;

alter table public.payments
  add column if not exists request_key uuid,
  add column if not exists request_fingerprint text;

create unique index if not exists payments_request_key_uidx
  on public.payments(request_key)
  where request_key is not null;

create or replace function public.create_atomic_prescription_handoff(
  p_request_key uuid,
  p_encounter_id uuid,
  p_clinical_notes text default null,
  p_items jsonb default '[]'::jsonb
)
returns table (
  prescription_id uuid,
  prescription_no text,
  dispensing_order_id uuid,
  queue_number text
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_encounter public.encounters%rowtype;
  v_prescription public.prescriptions%rowtype;
  v_existing public.prescriptions%rowtype;
  v_order public.dispensing_orders%rowtype;
  v_product public.products%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric(18,4);
  v_unit text;
  v_item_count integer;
  v_fingerprint text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_request_key is null then
    raise exception 'REQUEST_KEY_REQUIRED';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'PRESCRIPTION_ITEMS_MUST_BE_ARRAY';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 50 then
    raise exception 'PRESCRIPTION_ITEM_COUNT_INVALID';
  end if;
  if length(coalesce(p_clinical_notes, '')) > 4000 then
    raise exception 'CLINICAL_NOTES_TOO_LONG';
  end if;

  v_fingerprint := md5(
    p_encounter_id::text || '|' ||
    coalesce(p_clinical_notes, '') || '|' ||
    p_items::text
  );

  select rx.* into v_existing
  from public.prescriptions rx
  join public.encounters e on e.id = rx.encounter_id
  where rx.request_key = p_request_key
    and e.clinic_id = v_clinic_id;

  if found then
    if v_existing.encounter_id <> p_encounter_id
       or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;

    select d.* into v_order
    from public.dispensing_orders d
    where d.prescription_id = v_existing.id;

    return query
    select v_existing.id, v_existing.prescription_no, v_order.id, v_order.queue_number;
    return;
  end if;

  select e.* into v_encounter
  from public.encounters e
  where e.id = p_encounter_id
    and e.clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND';
  end if;
  if v_encounter.status in ('closed','cancelled','void') then
    raise exception 'ENCOUNTER_NOT_OPEN';
  end if;
  if exists (
    select 1
    from public.clinical_record_signoffs s
    where s.encounter_id = v_encounter.id
      and s.record_section = 'complete_record'
      and s.lock_record
  ) then
    raise exception 'CLINICAL_RECORD_LOCKED';
  end if;

  -- Recheck after the encounter lock. Concurrent retries with the same request
  -- key now observe the first committed handoff instead of surfacing a unique
  -- constraint error.
  select rx.* into v_existing
  from public.prescriptions rx
  where rx.request_key = p_request_key
    and rx.encounter_id = v_encounter.id;

  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;

    select d.* into v_order
    from public.dispensing_orders d
    where d.prescription_id = v_existing.id;

    return query
    select v_existing.id, v_existing.prescription_no, v_order.id, v_order.queue_number;
    return;
  end if;

  select coalesce(
    nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''),
    'CLN'
  ) into v_clinic_code
  from public.clinics c
  where c.id = v_clinic_id;

  insert into public.prescriptions (
    prescription_no, encounter_id, patient_id, prescriber_id, status,
    clinical_notes, sent_to_pharmacy_at, request_key, request_fingerprint
  ) values (
    'RX-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'prescription')::text, 8, '0'),
    v_encounter.id,
    v_encounter.patient_id,
    auth.uid(),
    'sent_to_pharmacy',
    nullif(btrim(p_clinical_notes), ''),
    now(),
    p_request_key,
    v_fingerprint
  ) returning * into v_prescription;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'PRESCRIPTION_ITEM_INVALID';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_quantity := (v_item ->> 'quantity_prescribed')::numeric(18,4);
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'PRESCRIPTION_ITEM_INVALID';
    end;

    if v_product_id is null or v_quantity is null
       or v_quantity <= 0 or v_quantity > 100000 then
      raise exception 'PRESCRIPTION_ITEM_INVALID';
    end if;

    select p.* into v_product
    from public.products p
    where p.id = v_product_id
      and p.active;

    if not found then
      raise exception 'PRODUCT_NOT_AVAILABLE';
    end if;

    v_unit := btrim(coalesce(v_item ->> 'unit', ''));
    if v_unit = '' or lower(v_unit) <> lower(btrim(v_product.dispense_unit)) then
      raise exception 'PRESCRIPTION_UNIT_MISMATCH';
    end if;

    if length(coalesce(v_item ->> 'dose', '')) > 200
       or length(coalesce(v_item ->> 'frequency', '')) > 200
       or length(coalesce(v_item ->> 'duration', '')) > 200
       or length(coalesce(v_item ->> 'route', '')) > 100
       or length(coalesce(v_item ->> 'instructions', '')) > 1000
       or length(coalesce(v_item ->> 'precautions', '')) > 1000
       or length(coalesce(v_item ->> 'formula_name', '')) > 300 then
      raise exception 'PRESCRIPTION_ITEM_FIELD_TOO_LONG';
    end if;

    insert into public.prescription_items (
      prescription_id, product_id, formula_name, dose, frequency, duration,
      route, quantity_prescribed, unit, instructions, precautions,
      substitution_allowed, status
    ) values (
      v_prescription.id,
      v_product.id,
      nullif(btrim(v_item ->> 'formula_name'), ''),
      nullif(btrim(v_item ->> 'dose'), ''),
      nullif(btrim(v_item ->> 'frequency'), ''),
      nullif(btrim(v_item ->> 'duration'), ''),
      nullif(btrim(v_item ->> 'route'), ''),
      v_quantity,
      v_product.dispense_unit,
      nullif(btrim(v_item ->> 'instructions'), ''),
      nullif(btrim(v_item ->> 'precautions'), ''),
      false,
      'ordered'
    );
  end loop;

  insert into public.dispensing_orders (
    prescription_id, queue_number, status
  ) values (
    v_prescription.id,
    'Q-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'pharmacy_queue')::text, 6, '0'),
    'waiting'
  ) returning * into v_order;

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id,
    auth.uid(),
    'create_prescription_handoff',
    'prescriptions',
    v_prescription.id::text,
    jsonb_build_object(
      'encounter_id', v_encounter.id,
      'dispensing_order_id', v_order.id,
      'item_count', v_item_count,
      'request_key', p_request_key
    )
  );

  return query
  select v_prescription.id, v_prescription.prescription_no, v_order.id, v_order.queue_number;
end;
$$;

create or replace function public.issue_atomic_dispensing_invoice(
  p_dispensing_order_id uuid,
  p_service_fee numeric default 0,
  p_discount numeric default 0
)
returns table (
  invoice_id uuid,
  invoice_number text,
  grand_total numeric,
  balance_due numeric
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_order public.dispensing_orders%rowtype;
  v_prescription public.prescriptions%rowtype;
  v_encounter public.encounters%rowtype;
  v_invoice public.invoices%rowtype;
  v_existing public.invoices%rowtype;
  v_existing_service_fee numeric(18,2);
  v_medicine_total numeric(18,2);
  v_subtotal numeric(18,2);
  v_grand_total numeric(18,2);
  v_line_count integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','billing']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_service_fee is null or p_discount is null
     or p_service_fee < 0 or p_discount < 0
     or p_service_fee > 10000000 or p_discount > 10000000
     or p_service_fee <> round(p_service_fee, 2)
     or p_discount <> round(p_discount, 2) then
    raise exception 'INVOICE_AMOUNT_INVALID';
  end if;

  select i.* into v_existing
  from public.invoices i
  join public.patients p on p.id = i.patient_id
  where i.source_dispensing_order_id = p_dispensing_order_id
    and p.clinic_id = v_clinic_id;

  if found then
    select coalesce(sum(li.line_total), 0)::numeric(18,2)
    into v_existing_service_fee
    from public.invoice_items li
    where li.invoice_id = v_existing.id
      and li.item_type = 'service'
      and li.description = 'ค่าตรวจและบริการรักษา';

    if v_existing.discount_total <> p_discount
       or v_existing_service_fee <> p_service_fee then
      raise exception 'DISPENSING_ORDER_ALREADY_BILLED';
    end if;
    return query
    select v_existing.id, v_existing.invoice_number,
           v_existing.grand_total, v_existing.balance_due;
    return;
  end if;

  select d.* into v_order
  from public.dispensing_orders d
  join public.prescriptions rx on rx.id = d.prescription_id
  join public.encounters e on e.id = rx.encounter_id
  where d.id = p_dispensing_order_id
    and e.patient_id = rx.patient_id
    and e.clinic_id = v_clinic_id
  for update of d;

  if not found then
    raise exception 'DISPENSING_ORDER_NOT_FOUND';
  end if;

  -- The dispensing-order lock serializes concurrent invoice attempts. Recheck
  -- the idempotent source link after acquiring it.
  select i.* into v_existing
  from public.invoices i
  where i.source_dispensing_order_id = v_order.id;

  if found then
    select coalesce(sum(li.line_total), 0)::numeric(18,2)
    into v_existing_service_fee
    from public.invoice_items li
    where li.invoice_id = v_existing.id
      and li.item_type = 'service'
      and li.description = 'ค่าตรวจและบริการรักษา';

    if v_existing.discount_total <> p_discount
       or v_existing_service_fee <> p_service_fee then
      raise exception 'DISPENSING_ORDER_ALREADY_BILLED';
    end if;
    return query
    select v_existing.id, v_existing.invoice_number,
           v_existing.grand_total, v_existing.balance_due;
    return;
  end if;

  select rx.* into v_prescription
  from public.prescriptions rx
  where rx.id = v_order.prescription_id;

  select e.* into v_encounter
  from public.encounters e
  where e.id = v_prescription.encounter_id
    and e.patient_id = v_prescription.patient_id
    and e.clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'DISPENSING_ORDER_NOT_FOUND';
  end if;
  if v_order.status <> 'submitted_to_billing' then
    raise exception 'DISPENSING_ORDER_NOT_READY_FOR_BILLING';
  end if;

  if exists (
    select 1
    from public.dispensing_items di
    join public.prescription_items pi on pi.id = di.prescription_item_id
    where di.dispensing_order_id = v_order.id
      and (
        pi.prescription_id <> v_prescription.id
        or di.quantity_dispensed <= 0
        or di.status <> 'dispensed'
      )
  ) then
    raise exception 'DISPENSING_ITEMS_NOT_FINALIZED';
  end if;

  select
    count(*)::integer,
    coalesce(sum(round(di.quantity_dispensed * di.unit_price, 2)), 0)::numeric(18,2)
  into v_line_count, v_medicine_total
  from public.dispensing_items di
  where di.dispensing_order_id = v_order.id
    and di.quantity_dispensed > 0;

  if v_line_count < 1 and p_service_fee = 0 then
    raise exception 'INVOICE_REQUIRES_LINE';
  end if;

  v_subtotal := v_medicine_total + p_service_fee;
  if p_discount > v_subtotal then
    raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL';
  end if;
  v_grand_total := v_subtotal - p_discount;

  if exists (
    select 1
    from public.invoices i
    where i.encounter_id = v_encounter.id
      and i.status not in ('void','cancelled')
  ) then
    raise exception 'ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE';
  end if;

  select coalesce(
    nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''),
    'CLN'
  ) into v_clinic_code
  from public.clinics c
  where c.id = v_clinic_id;

  insert into public.invoices (
    invoice_number, patient_id, encounter_id, source_dispensing_order_id,
    status, subtotal, discount_total, tax_total, rounding, grand_total,
    paid_amount, balance_due, issued_at, created_by
  ) values (
    'INV-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'invoice')::text, 8, '0'),
    v_prescription.patient_id,
    v_encounter.id,
    v_order.id,
    'issued',
    v_subtotal,
    p_discount,
    0,
    0,
    v_grand_total,
    0,
    v_grand_total,
    now(),
    auth.uid()
  ) returning * into v_invoice;

  if p_service_fee > 0 then
    insert into public.invoice_items (
      invoice_id, item_type, description, quantity, unit_price, line_total
    ) values (
      v_invoice.id, 'service', 'ค่าตรวจและบริการรักษา', 1,
      p_service_fee, p_service_fee
    );
  end if;

  insert into public.invoice_items (
    invoice_id, item_type, product_id, dispensing_item_id, description,
    quantity, unit_price, line_total
  )
  select
    v_invoice.id,
    'product',
    pi.product_id,
    di.id,
    coalesce(p.name_th, p.sku, 'ยา/สมุนไพร'),
    di.quantity_dispensed,
    di.unit_price,
    round(di.quantity_dispensed * di.unit_price, 2)
  from public.dispensing_items di
  join public.prescription_items pi on pi.id = di.prescription_item_id
  join public.products p on p.id = pi.product_id
  where di.dispensing_order_id = v_order.id
    and pi.prescription_id = v_prescription.id
    and di.quantity_dispensed > 0;

  update public.dispensing_orders
  set status = 'billed', updated_at = now()
  where id = v_order.id;

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id,
    auth.uid(),
    'issue_dispensing_invoice',
    'invoices',
    v_invoice.id::text,
    jsonb_build_object(
      'dispensing_order_id', v_order.id,
      'encounter_id', v_encounter.id,
      'medicine_total', v_medicine_total,
      'service_fee', p_service_fee,
      'discount', p_discount,
      'grand_total', v_grand_total
    )
  );

  return query
  select v_invoice.id, v_invoice.invoice_number,
         v_invoice.grand_total, v_invoice.balance_due;
end;
$$;

create or replace function public.record_atomic_invoice_payment(
  p_request_key uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_channel text,
  p_reference_note text default null
)
returns table (
  payment_id uuid,
  payment_reference text,
  invoice_status text,
  paid_amount numeric,
  balance_due numeric,
  encounter_closed boolean
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_invoice public.invoices%rowtype;
  v_payment public.payments%rowtype;
  v_existing public.payments%rowtype;
  v_total_paid numeric(18,2);
  v_balance numeric(18,2);
  v_status text;
  v_fingerprint text;
  v_closed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','billing']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_request_key is null then
    raise exception 'REQUEST_KEY_REQUIRED';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000
     or p_amount <> round(p_amount, 2) then
    raise exception 'PAYMENT_AMOUNT_INVALID';
  end if;
  if p_channel not in ('cash','qr','bank_transfer','card') then
    raise exception 'PAYMENT_CHANNEL_INVALID';
  end if;
  if length(coalesce(p_reference_note, '')) > 200 then
    raise exception 'PAYMENT_REFERENCE_TOO_LONG';
  end if;

  v_fingerprint := md5(
    p_invoice_id::text || '|' || p_amount::text || '|' || p_channel || '|' ||
    coalesce(p_reference_note, '')
  );

  select pay.* into v_existing
  from public.payments pay
  join public.invoices i on i.id = pay.invoice_id
  join public.patients p on p.id = i.patient_id
  where pay.request_key = p_request_key
    and p.clinic_id = v_clinic_id;

  if found then
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;

    select i.* into v_invoice
    from public.invoices i
    where i.id = v_existing.invoice_id;

    select exists (
      select 1
      from public.encounters e
      where e.id = v_invoice.encounter_id
        and e.status = 'closed'
    ) into v_closed;

    return query
    select v_existing.id, v_existing.payment_reference, v_invoice.status,
           v_invoice.paid_amount, v_invoice.balance_due,
           v_closed;
    return;
  end if;

  select i.* into v_invoice
  from public.invoices i
  join public.patients p on p.id = i.patient_id
  where i.id = p_invoice_id
    and p.clinic_id = v_clinic_id
  for update of i;

  if not found then
    raise exception 'INVOICE_NOT_FOUND';
  end if;

  -- The invoice lock serializes concurrent payment retries. Recheck the
  -- request key after acquiring it so a lost-response retry is deterministic.
  select pay.* into v_existing
  from public.payments pay
  where pay.request_key = p_request_key
    and pay.invoice_id = v_invoice.id;

  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;

    select exists (
      select 1
      from public.encounters e
      where e.id = v_invoice.encounter_id
        and e.status = 'closed'
    ) into v_closed;

    return query
    select v_existing.id, v_existing.payment_reference, v_invoice.status,
           v_invoice.paid_amount, v_invoice.balance_due, v_closed;
    return;
  end if;
  if v_invoice.status not in ('issued','partially_paid') then
    raise exception 'INVOICE_NOT_PAYABLE';
  end if;
  if p_amount > v_invoice.balance_due then
    raise exception 'PAYMENT_EXCEEDS_BALANCE';
  end if;

  select coalesce(
    nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''),
    'CLN'
  ) into v_clinic_code
  from public.clinics c
  where c.id = v_clinic_id;

  insert into public.payments (
    invoice_id, payment_reference, provider, channel, amount, status,
    gateway_transaction_id, raw_callback, paid_at, received_by,
    request_key, request_fingerprint
  ) values (
    v_invoice.id,
    'PAY-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'payment')::text, 8, '0'),
    'manual',
    p_channel,
    p_amount,
    'paid',
    nullif(btrim(p_reference_note), ''),
    case
      when nullif(btrim(p_reference_note), '') is null then '{}'::jsonb
      else jsonb_build_object('operator_reference', btrim(p_reference_note))
    end,
    now(),
    auth.uid(),
    p_request_key,
    v_fingerprint
  ) returning * into v_payment;

  select coalesce(sum(p.amount), 0)::numeric(18,2)
  into v_total_paid
  from public.payments p
  where p.invoice_id = v_invoice.id
    and p.status = 'paid';

  if v_total_paid > v_invoice.grand_total then
    raise exception 'PAYMENT_EXCEEDS_INVOICE_TOTAL';
  end if;

  v_balance := v_invoice.grand_total - v_total_paid;
  v_status := case when v_balance = 0 then 'paid' else 'partially_paid' end;

  update public.invoices
  set
    paid_amount = v_total_paid,
    balance_due = v_balance,
    status = v_status,
    updated_at = now()
  where id = v_invoice.id
  returning * into v_invoice;

  if v_balance = 0 and v_invoice.encounter_id is not null then
    update public.encounters
    set
      status = 'closed',
      completed_at = coalesce(completed_at, now()),
      updated_at = now()
    where id = v_invoice.encounter_id
      and clinic_id = v_clinic_id
      and status not in ('cancelled','void');
    v_closed := found;
  end if;

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id,
    auth.uid(),
    'record_invoice_payment',
    'payments',
    v_payment.id::text,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'amount', p_amount,
      'channel', p_channel,
      'invoice_status', v_status,
      'balance_due', v_balance,
      'encounter_closed', v_closed,
      'request_key', p_request_key
    )
  );

  return query
  select v_payment.id, v_payment.payment_reference, v_status,
         v_total_paid, v_balance, v_closed;
end;
$$;

create or replace function public.clinical_financial_handoffs_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_regprocedure(
      'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)'
    ) is not null
    and to_regprocedure(
      'public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)'
    ) is not null
    and to_regprocedure(
      'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)'
    ) is not null,
    '2026-08-27.1'::text;
$$;

revoke all on function public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb) from public;
revoke all on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric) from public;
revoke all on function public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text) from public;
revoke all on function public.clinical_financial_handoffs_healthcheck() from public;

grant execute on function public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)
  to authenticated, service_role;
grant execute on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)
  to authenticated, service_role;
grant execute on function public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)
  to authenticated, service_role;
grant execute on function public.clinical_financial_handoffs_healthcheck()
  to authenticated, service_role;

-- These records must now be created or mutated only through the transactional
-- RPCs above. Operational screens retain read access.
revoke insert, update, delete on public.patients from authenticated;
revoke insert, update, delete on public.patient_allergies from authenticated;
revoke insert, update, delete on public.encounters from authenticated;
revoke insert, update, delete on public.audit_logs from authenticated;
revoke insert, update, delete on public.prescriptions from authenticated;
revoke insert, update, delete on public.prescription_items from authenticated;
revoke insert, delete on public.dispensing_orders from authenticated;
revoke insert, update, delete on public.invoices from authenticated;
revoke insert, update, delete on public.invoice_items from authenticated;
revoke insert, update, delete on public.payments from authenticated;

grant select on public.patients, public.patient_allergies, public.encounters,
  public.audit_logs, public.prescriptions, public.prescription_items,
  public.dispensing_orders, public.invoices, public.invoice_items,
  public.payments to authenticated;

-- The original JSON clinic_state prototype is retained for rollback/history
-- but is not an operational source of truth and must not expose legacy PHI.
revoke all on public.clinic_state from authenticated;

commit;

select
  'CHANANYA_ATOMIC_CLINICAL_FINANCIAL_HANDOFFS_READY' as status,
  to_regprocedure(
    'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)'
  ) as prescription_rpc,
  to_regprocedure(
    'public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)'
  ) as invoice_rpc,
  to_regprocedure(
    'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)'
  ) as payment_rpc;
