begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Prescriptions are clinical acts. Keep the atomic handoff, but require the
-- caller to be the practitioner assigned to the Encounter. Super Admin is the
-- only explicit cross-workspace override.
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic_id uuid := public.current_clinic_id();
  v_is_super_admin boolean := public.is_super_admin();
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
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not v_is_super_admin and not public.department_can('clinical') then
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

  select e.* into v_encounter
  from public.encounters e
  where e.id = p_encounter_id
    and e.clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND';
  end if;
  if not v_is_super_admin
     and v_encounter.practitioner_id is distinct from v_actor then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;

  -- Authorize against the current Encounter assignment before returning an
  -- idempotent result. This prevents a different clinician from using a known
  -- request key to read or replay another practitioner's handoff.
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

  -- The Encounter row lock serializes retries for this clinical context. A
  -- concurrent retry observes the first committed handoff here.
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
    v_actor,
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
      and p.clinic_id = v_clinic_id
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
    v_actor,
    'create_prescription_handoff',
    'prescriptions',
    v_prescription.id::text,
    jsonb_build_object(
      'encounter_id', v_encounter.id,
      'assigned_practitioner_id', v_encounter.practitioner_id,
      'super_admin_override', v_is_super_admin,
      'dispensing_order_id', v_order.id,
      'item_count', v_item_count,
      'request_key', p_request_key
    )
  );

  return query
  select v_prescription.id, v_prescription.prescription_no, v_order.id, v_order.queue_number;
end;
$$;

revoke all on function public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)
  to authenticated;

commit;
