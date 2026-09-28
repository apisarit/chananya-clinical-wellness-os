begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Existing financial rows are immutable snapshots.  New operational rows carry
-- the resolver identity used at creation time; changing the master later does
-- not rewrite these columns.
alter table public.dispensing_items
  add column if not exists price_list_id uuid,
  add column if not exists price_list_version bigint,
  add column if not exists price_list_item_id uuid,
  add column if not exists price_item_version bigint;
alter table public.pharmacy_counter_sale_items
  add column if not exists price_list_id uuid,
  add column if not exists price_list_version bigint,
  add column if not exists price_list_item_id uuid,
  add column if not exists price_item_version bigint;
alter table public.invoice_items
  alter column quantity type numeric(24,12),
  add column if not exists price_list_id uuid,
  add column if not exists price_list_version bigint,
  add column if not exists price_list_item_id uuid,
  add column if not exists price_item_version bigint,
  add column if not exists price_unit_code text;
alter table public.clinical_treatment_sessions
  add column if not exists duration_minutes integer;

create or replace function public.enforce_product_price_snapshot()
returns trigger
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_product_id uuid;
  v_price record;
  v_expected_unit text;
begin
  if tg_table_name = 'dispensing_items' then
    select pi.product_id into v_product_id
      from public.prescription_items pi where pi.id = new.prescription_item_id;
  else
    v_product_id := new.product_id;
  end if;
  if v_product_id is null then raise exception 'PRICE_PRODUCT_REQUIRED'; end if;
  select p.dispense_unit into v_expected_unit from public.products p
   where p.id=v_product_id and p.clinic_id=public.current_clinic_id() and p.active;
  if v_expected_unit is null then raise exception 'PRICE_PRODUCT_REQUIRED'; end if;
  if new.unit is null or lower(btrim(new.unit)) <> lower(btrim(v_expected_unit)) then
    raise exception 'PRICE_UNIT_MISMATCH';
  end if;
  select * into v_price from public.resolve_price_master_item(
    'product', v_product_id, null, current_date, null
  );
  if not found or v_price.unit_price is null or v_price.unit_price <= 0 then
    raise exception 'PRICE_REQUIRED';
  end if;
  if new.unit_price is null or new.unit_price <> v_price.unit_price then
    raise exception 'PRICE_MISMATCH';
  end if;
  new.unit_price := v_price.unit_price;
  new.price_list_id := v_price.price_list_id;
  new.price_list_version := v_price.price_list_version;
  new.price_list_item_id := v_price.item_id;
  new.price_item_version := v_price.item_version;
  return new;
end;
$$;

drop trigger if exists dispensing_items_price_snapshot on public.dispensing_items;
create trigger dispensing_items_price_snapshot
  before insert or update of unit_price, prescription_item_id on public.dispensing_items
  for each row execute function public.enforce_product_price_snapshot();
drop trigger if exists pharmacy_counter_items_price_snapshot on public.pharmacy_counter_sale_items;
create trigger pharmacy_counter_items_price_snapshot
  before insert or update of unit_price, product_id on public.pharmacy_counter_sale_items
  for each row execute function public.enforce_product_price_snapshot();

revoke all on function public.enforce_product_price_snapshot() from public, anon, authenticated, service_role;

-- A clinician must record the actual completed treatment time.  The RPC keeps
-- its existing arguments and appends the new value for client compatibility.
create or replace function public.create_clinical_treatment_session(
  p_encounter_id uuid, p_treatment_modalities text[], p_treatment_detail text,
  p_procedure_referral boolean, p_procedure_referral_detail text, p_precautions text,
  p_pain_before smallint, p_pain_after smallint, p_outcome_summary text, p_advice text,
  p_duration_minutes integer
)
returns public.clinical_treatment_sessions
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_clinic uuid := public.current_clinic_id();
  v_department text := public.current_department_role(); v_profile_role text;
  v_encounter public.encounters%rowtype; v_session_no integer;
  v_row public.clinical_treatment_sessions%rowtype;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  select p.role into v_profile_role from public.profiles p where p.id=v_actor;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.department_can('clinical') and not (v_department in ('owner','admin') and v_profile_role in ('practitioner','doctor')) then raise exception 'PERMISSION_DENIED'; end if;
  if p_treatment_detail is null or btrim(p_treatment_detail) = '' then raise exception 'TREATMENT_DETAIL_REQUIRED'; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 1440 then
    raise exception 'TREATMENT_DURATION_REQUIRED';
  end if;
  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then raise exception 'INVALID_PAIN_BEFORE'; end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then raise exception 'INVALID_PAIN_AFTER'; end if;
  select e.* into v_encounter from public.encounters e where e.id=p_encounter_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.status in ('closed','cancelled','void') then raise exception 'ENCOUNTER_NOT_EDITABLE'; end if;
  if v_encounter.practitioner_id is not null and v_encounter.practitioner_id<>v_actor and not public.is_super_admin() then raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH'; end if;
  select coalesce(max(session_no), 0) + 1 into v_session_no
    from public.clinical_treatment_sessions where encounter_id = p_encounter_id;
  insert into public.clinical_treatment_sessions(
    encounter_id,session_no,treatment_modalities,treatment_detail,procedure_referral,
    procedure_referral_detail,precautions,pain_before,pain_after,outcome_summary,advice,
    duration_minutes,practitioner_id
  ) values (
    p_encounter_id,v_session_no,coalesce(p_treatment_modalities,'{}'),p_treatment_detail,
    coalesce(p_procedure_referral,false),p_procedure_referral_detail,p_precautions,
    p_pain_before,p_pain_after,nullif(btrim(p_outcome_summary),''),nullif(btrim(p_advice),''),p_duration_minutes,v_actor
  ) returning * into v_row;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values(v_clinic,v_actor,'create_clinical_treatment_session','clinical_treatment_sessions',v_row.id::text,
      jsonb_build_object('encounter_id',p_encounter_id,'session_no',v_session_no,'duration_minutes',p_duration_minutes));
  return v_row;
end;
$$;
revoke all on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text,integer) to authenticated;

-- The old ten-argument routine cannot silently create a billable session.
create or replace function public.create_clinical_treatment_session(
  p_encounter_id uuid, p_treatment_modalities text[] default '{}',
  p_treatment_detail text default null, p_procedure_referral boolean default false,
  p_procedure_referral_detail text default null, p_precautions text default null,
  p_pain_before smallint default null, p_pain_after smallint default null,
  p_outcome_summary text default null, p_advice text default null
)
returns public.clinical_treatment_sessions
language plpgsql security invoker set search_path = public
as $$
begin
  raise exception 'TREATMENT_DURATION_REQUIRED';
end;
$$;
revoke all on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text) from public, anon, authenticated, service_role;
grant execute on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text) to authenticated;

create or replace function public.enforce_invoice_price_snapshot()
returns trigger
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_service_id uuid := new.service_id;
  v_price record;
begin
  if new.item_type = 'product' then
    if new.product_id is null then raise exception 'PRICE_PRODUCT_REQUIRED'; end if;
    -- Finalized dispensing owns its historical price. Never re-resolve a
    -- product line against today's master while creating its invoice.
    if new.dispensing_item_id is not null then
      if not exists (
        select 1 from public.dispensing_items di
        join public.prescription_items pi on pi.id=di.prescription_item_id
        where di.id=new.dispensing_item_id and pi.product_id=new.product_id
      ) then raise exception 'DISPENSING_PRODUCT_MISMATCH'; end if;
      select di.price_list_id,di.price_list_version,di.price_list_item_id as item_id,
             di.price_item_version as item_version,
             null::text as unit_code,di.unit_price
        into v_price
        from public.dispensing_items di
       where di.id=new.dispensing_item_id and di.unit_price>0;
    else
      select * into v_price from public.resolve_price_master_item(
        'product', new.product_id, null, current_date, null
      );
    end if;
  elsif new.item_type = 'service' then
    if v_service_id is null then
      select s.id into v_service_id from public.services s
       where s.clinic_id = public.current_clinic_id()
         and s.service_code = 'SESSION_HOURLY' and s.active;
    end if;
    if v_service_id is null then raise exception 'SESSION_HOURLY_SERVICE_REQUIRED'; end if;
    select * into v_price from public.resolve_price_master_item(
      'service', null, v_service_id, current_date, null
    );
    new.service_id := v_service_id;
  else
    return new;
  end if;
  if not found or v_price.unit_price is null or v_price.unit_price <= 0 then
    raise exception 'PRICE_REQUIRED';
  end if;
  if new.unit_price is null or new.unit_price <> v_price.unit_price then
    raise exception 'PRICE_MISMATCH';
  end if;
  if new.quantity is null or new.quantity <= 0 then raise exception 'INVOICE_QUANTITY_INVALID'; end if;
  if new.line_total is null or new.line_total <> round(new.quantity * v_price.unit_price, 2) then
    raise exception 'INVOICE_LINE_TOTAL_MISMATCH';
  end if;
  new.price_list_id := v_price.price_list_id;
  new.price_list_version := v_price.price_list_version;
  new.price_list_item_id := v_price.item_id;
  new.price_item_version := v_price.item_version;
  new.price_unit_code := v_price.unit_code;
  return new;
end;
$$;
drop trigger if exists invoice_items_price_snapshot on public.invoice_items;
create trigger invoice_items_price_snapshot
  before insert or update of item_type,product_id,service_id,quantity,unit_price,line_total
  on public.invoice_items for each row execute function public.enforce_invoice_price_snapshot();
revoke all on function public.enforce_invoice_price_snapshot() from public, anon, authenticated, service_role;

create or replace function cnyos_billing_internal.resolve_session_charge(p_encounter_id uuid)
returns table(service_id uuid, duration_minutes integer, hourly_rate numeric, charge numeric,
              price_list_id uuid, price_list_version bigint, price_list_item_id uuid,
              item_version bigint, unit_code text)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_price record;
begin
  if p_encounter_id is null or v_clinic is null then raise exception 'TREATMENT_PRICE_REQUIRED'; end if;
  select s.id into service_id from public.services s
   where s.clinic_id=v_clinic and s.service_code='SESSION_HOURLY' and s.active;
  if service_id is null then raise exception 'SESSION_HOURLY_SERVICE_REQUIRED'; end if;
  select * into v_price from public.resolve_price_master_item('service',null,service_id,current_date,null);
  if not found or v_price.unit_price is null or v_price.unit_price <= 0 then raise exception 'PRICE_REQUIRED'; end if;
  if exists (select 1 from public.clinical_treatment_sessions s
             where s.encounter_id=p_encounter_id
               and (s.duration_minutes is null or s.duration_minutes <= 0)) then
    raise exception 'TREATMENT_DURATION_REQUIRED';
  end if;
  select coalesce(sum(s.duration_minutes),0)::integer into duration_minutes
    from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id;
  if duration_minutes <= 0 then raise exception 'TREATMENT_DURATION_REQUIRED'; end if;
  hourly_rate := v_price.unit_price;
  charge := round((duration_minutes::numeric / 60) * hourly_rate, 2);
  price_list_id := v_price.price_list_id;
  price_list_version := v_price.price_list_version;
  price_list_item_id := v_price.item_id;
  item_version := v_price.item_version;
  unit_code := v_price.unit_code;
  return next;
end;
$$;
revoke all on function cnyos_billing_internal.resolve_session_charge(uuid) from public, anon, authenticated, service_role;

create or replace function cnyos_billing_internal.issue_treatment_invoice(
  p_request_key uuid, p_encounter_id uuid, p_amount numeric, p_description text
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare
  v_clinic uuid; v_actor uuid; v_encounter public.encounters%rowtype;
  v_invoice public.invoices%rowtype; v_fingerprint text; v_code text; v_existing boolean := false;
  v_charge record;
begin
  v_actor := auth.uid(); if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic := public.current_clinic_id(); if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_request_key is null or p_encounter_id is null then raise exception 'REQUEST_AND_ENCOUNTER_REQUIRED'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2) then raise exception 'INVOICE_AMOUNT_INVALID'; end if;
  if p_description is null or length(btrim(p_description)) < 1 or length(btrim(p_description)) > 500 then raise exception 'SERVICE_DESCRIPTION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cnyos-service-invoice:'||p_request_key::text,0));
  select e.* into v_encounter from public.encounters e where e.id=p_encounter_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if not exists(select 1 from public.patients p where p.id=v_encounter.patient_id and p.clinic_id=v_clinic) then raise exception 'ENCOUNTER_PATIENT_MISMATCH'; end if;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_array(v_clinic,v_actor,p_encounter_id,p_amount::numeric(18,2),btrim(p_description))::text,'UTF8')),'hex');
  select i.* into v_invoice from public.invoices i where i.source_service_request_key=p_request_key;
  v_existing := found;
  if v_existing then
    if v_invoice.encounter_id<>p_encounter_id or v_invoice.service_request_fingerprint is distinct from v_fingerprint then raise exception 'INVOICE_REQUEST_CONFLICT'; end if;
    return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due; return;
  end if;
  select * into v_charge from cnyos_billing_internal.resolve_session_charge(p_encounter_id);
  if p_amount <> v_charge.charge then raise exception 'TREATMENT_PRICE_MISMATCH'; end if;
  if v_encounter.status in ('closed','cancelled','void') then raise exception 'ENCOUNTER_NOT_OPEN'; end if;
  perform 1 from public.clinical_record_signoffs s where s.encounter_id=p_encounter_id and s.record_section='complete_record' and s.lock_record for share;
  if not found then raise exception 'SIGNED_CLINICAL_RECORD_REQUIRED'; end if;
  if exists(select 1 from public.prescriptions p where p.encounter_id=p_encounter_id and p.status not in ('cancelled','void')) then raise exception 'PRESCRIPTION_BILLING_PATH_REQUIRED'; end if;
  if exists(select 1 from public.invoices i where i.encounter_id=p_encounter_id and i.status not in ('cancelled','void')) then raise exception 'ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE'; end if;
  select coalesce(nullif(regexp_replace(upper(c.code),'[^A-Z0-9]','','g'),''),'CLN') into v_code from public.clinics c where c.id=v_clinic;
  insert into public.invoices(invoice_number,patient_id,encounter_id,status,subtotal,discount_total,tax_total,rounding,grand_total,paid_amount,balance_due,issued_at,created_by,source_service_request_key,service_request_fingerprint)
  values('INV-'||v_code||'-'||to_char(current_date,'YYYYMMDD')||'-'||lpad(public.next_clinic_counter(v_clinic,'invoice')::text,8,'0'),v_encounter.patient_id,p_encounter_id,'issued',p_amount,0,0,0,p_amount,0,p_amount,now(),v_actor,p_request_key,v_fingerprint) returning * into v_invoice;
  insert into public.invoice_items(invoice_id,item_type,service_id,description,quantity,unit_price,line_total)
  values(v_invoice.id,'service',v_charge.service_id,btrim(p_description),v_charge.duration_minutes::numeric/60,v_charge.hourly_rate,p_amount);
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values(v_clinic,v_actor,'issue_treatment_invoice','invoices',v_invoice.id::text,jsonb_build_object('request_key',p_request_key,'encounter_id',p_encounter_id,'amount',p_amount,'duration_minutes',v_charge.duration_minutes,'hourly_rate',v_charge.hourly_rate,'service_only',true));
  return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due;
end;
$$;
revoke all on function cnyos_billing_internal.issue_treatment_invoice(uuid,uuid,numeric,text) from public, anon, authenticated, service_role;

create or replace function public.quote_treatment_invoice(p_encounter_id uuid)
returns table(amount numeric, duration_minutes integer, unit_price numeric,
              description text, item_id uuid, item_version bigint)
language plpgsql stable security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare
  v_clinic uuid := public.current_clinic_id(); v_charge record; v_session_count integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  if not exists(select 1 from public.encounters e where e.id=p_encounter_id and e.clinic_id=v_clinic) then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  select count(*)::integer into v_session_count from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id;
  if v_session_count = 0 then
    amount := 0; duration_minutes := 0; unit_price := 0;
    description := 'ไม่มีค่าบริการรักษา'; item_id := null; item_version := null;
    return next; return;
  end if;
  select * into v_charge from cnyos_billing_internal.resolve_session_charge(p_encounter_id);
  amount := v_charge.charge; duration_minutes := v_charge.duration_minutes;
  unit_price := v_charge.hourly_rate; description := 'ค่าตรวจและบริการรักษา';
  item_id := v_charge.price_list_item_id; item_version := v_charge.item_version;
  return next;
end;
$$;
revoke all on function public.quote_treatment_invoice(uuid) from public, anon, service_role;
grant execute on function public.quote_treatment_invoice(uuid) to authenticated;

create or replace function public.amend_treatment_session_duration(
  p_session_id uuid, p_duration_minutes integer,
  p_expected_duration_minutes integer, p_reason text
)
returns public.clinical_treatment_sessions
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_clinic uuid := public.current_clinic_id();
  v_session public.clinical_treatment_sessions%rowtype;
  v_encounter public.encounters%rowtype; v_profile_role text;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  select p.role into v_profile_role from public.profiles p where p.id=v_actor;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.department_can('clinical') and not (public.current_department_role() in ('owner','admin') and v_profile_role in ('practitioner','doctor')) then raise exception 'PERMISSION_DENIED'; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 1440 then raise exception 'TREATMENT_DURATION_INVALID'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then raise exception 'AMENDMENT_REASON_REQUIRED'; end if;
  select s.* into v_session from public.clinical_treatment_sessions s
   join public.encounters e on e.id=s.encounter_id
   where s.id=p_session_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'TREATMENT_SESSION_NOT_FOUND'; end if;
  select e.* into v_encounter from public.encounters e where e.id=v_session.encounter_id for update;
  if v_encounter.practitioner_id is not null and v_encounter.practitioner_id<>v_actor and not public.is_super_admin() then raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH'; end if;
  if v_session.duration_minutes is distinct from p_expected_duration_minutes then raise exception 'TREATMENT_DURATION_VERSION_CONFLICT'; end if;
  if exists(select 1 from public.clinical_record_signoffs s where s.encounter_id=v_session.encounter_id and s.record_section='complete_record' and s.lock_record) then raise exception 'CLINICAL_RECORD_LOCKED'; end if;
  if exists(select 1 from public.invoices i where i.encounter_id=v_session.encounter_id and i.status not in ('void','cancelled')) then raise exception 'TREATMENT_SESSION_ALREADY_BILLED'; end if;
  update public.clinical_treatment_sessions set duration_minutes=p_duration_minutes,updated_at=now() where id=p_session_id returning * into v_session;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values(v_clinic,v_actor,'amend_treatment_session_duration','clinical_treatment_sessions',p_session_id::text,jsonb_build_object('old_duration_minutes',p_expected_duration_minutes,'new_duration_minutes',p_duration_minutes,'reason',btrim(p_reason)));
  return v_session;
end;
$$;
revoke all on function public.amend_treatment_session_duration(uuid,integer,integer,text) from public, anon, service_role;
grant execute on function public.amend_treatment_session_duration(uuid,integer,integer,text) to authenticated;

create or replace function public.issue_atomic_dispensing_invoice(
  p_dispensing_order_id uuid, p_service_fee numeric default 0, p_discount numeric default 0
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic uuid := public.current_clinic_id(); v_order public.dispensing_orders%rowtype;
  v_rx public.prescriptions%rowtype; v_enc public.encounters%rowtype; v_invoice public.invoices%rowtype;
  v_existing public.invoices%rowtype; v_code text; v_charge record;
  v_medicine numeric(18,2); v_subtotal numeric(18,2); v_total numeric(18,2); v_count integer;
  v_session_count integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  if not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_service_fee is null or p_discount is null or p_service_fee < 0 or p_discount < 0 or p_discount <> round(p_discount,2) then raise exception 'INVOICE_AMOUNT_INVALID'; end if;
  if p_discount <> 0 then raise exception 'DISCOUNT_NOT_AUTHORIZED'; end if;
  select i.* into v_existing from public.invoices i join public.patients p on p.id=i.patient_id where i.source_dispensing_order_id=p_dispensing_order_id and p.clinic_id=v_clinic;
  if found then
    if (select coalesce(sum(li.line_total),0)::numeric(18,2) from public.invoice_items li where li.invoice_id=v_existing.id and li.item_type='service') <> p_service_fee or v_existing.discount_total<>p_discount then raise exception 'DISPENSING_ORDER_ALREADY_BILLED'; end if;
    return query select v_existing.id,v_existing.invoice_number,v_existing.grand_total,v_existing.balance_due; return;
  end if;
  select d.* into v_order from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where d.id=p_dispensing_order_id and e.clinic_id=v_clinic for update of d;
  if not found then raise exception 'DISPENSING_ORDER_NOT_FOUND'; end if;
  select i.* into v_existing from public.invoices i where i.source_dispensing_order_id=v_order.id;
  if found then return query select v_existing.id,v_existing.invoice_number,v_existing.grand_total,v_existing.balance_due; return; end if;
  select rx.* into v_rx from public.prescriptions rx where rx.id=v_order.prescription_id;
  select e.* into v_enc from public.encounters e where e.id=v_rx.encounter_id and e.patient_id=v_rx.patient_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'DISPENSING_ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'submitted_to_billing' then raise exception 'DISPENSING_ORDER_NOT_READY_FOR_BILLING'; end if;
  if exists(select 1 from public.dispensing_items di join public.prescription_items pi on pi.id=di.prescription_item_id where di.dispensing_order_id=v_order.id and (pi.prescription_id<>v_rx.id or di.quantity_dispensed<=0 or di.status<>'dispensed')) then raise exception 'DISPENSING_ITEMS_NOT_FINALIZED'; end if;
  select count(*)::integer,coalesce(sum(round(di.quantity_dispensed*di.unit_price,2)),0)::numeric(18,2) into v_count,v_medicine from public.dispensing_items di where di.dispensing_order_id=v_order.id and di.quantity_dispensed>0;
  select count(*)::integer into v_session_count from public.clinical_treatment_sessions s where s.encounter_id=v_enc.id;
  if v_session_count > 0 then
    select * into v_charge from cnyos_billing_internal.resolve_session_charge(v_enc.id);
    if p_service_fee <> v_charge.charge then raise exception 'TREATMENT_PRICE_MISMATCH'; end if;
  elsif p_service_fee <> 0 then
    raise exception 'TREATMENT_DURATION_REQUIRED';
  end if;
  if v_count < 1 and p_service_fee=0 then raise exception 'INVOICE_REQUIRES_LINE'; end if;
  v_subtotal:=v_medicine+p_service_fee; if p_discount>v_subtotal then raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL'; end if; v_total:=v_subtotal-p_discount;
  if exists(select 1 from public.invoices i where i.encounter_id=v_enc.id and i.status not in ('void','cancelled')) then raise exception 'ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE'; end if;
  select coalesce(nullif(regexp_replace(upper(c.code),'[^A-Z0-9]','','g'),''),'CLN') into v_code from public.clinics c where c.id=v_clinic;
  insert into public.invoices(invoice_number,patient_id,encounter_id,source_dispensing_order_id,status,subtotal,discount_total,tax_total,rounding,grand_total,paid_amount,balance_due,issued_at,created_by)
  values('INV-'||v_code||'-'||to_char(current_date,'YYYYMMDD')||'-'||lpad(public.next_clinic_counter(v_clinic,'invoice')::text,8,'0'),v_rx.patient_id,v_enc.id,v_order.id,'issued',v_subtotal,p_discount,0,0,v_total,0,v_total,now(),auth.uid()) returning * into v_invoice;
  if p_service_fee>0 then
    insert into public.invoice_items(invoice_id,item_type,service_id,description,quantity,unit_price,line_total)
    values(v_invoice.id,'service',v_charge.service_id,'ค่าตรวจและบริการรักษา',v_charge.duration_minutes::numeric/60,v_charge.hourly_rate,p_service_fee);
  end if;
  insert into public.invoice_items(invoice_id,item_type,product_id,dispensing_item_id,description,quantity,unit_price,line_total)
  select v_invoice.id,'product',pi.product_id,di.id,coalesce(p.name_th,p.sku,'ยา/สมุนไพร'),di.quantity_dispensed,di.unit_price,round(di.quantity_dispensed*di.unit_price,2)
    from public.dispensing_items di join public.prescription_items pi on pi.id=di.prescription_item_id join public.products p on p.id=pi.product_id
   where di.dispensing_order_id=v_order.id and pi.prescription_id=v_rx.id and di.quantity_dispensed>0;
  update public.dispensing_orders set status='billed',updated_at=now() where id=v_order.id;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values(v_clinic,auth.uid(),'issue_dispensing_invoice','invoices',v_invoice.id::text,jsonb_build_object('dispensing_order_id',v_order.id,'encounter_id',v_enc.id,'medicine_total',v_medicine,'service_fee',p_service_fee,'discount',p_discount,'grand_total',v_total));
  return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due;
end;
$$;
revoke all on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric) from public,anon,authenticated,service_role;
grant execute on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric) to authenticated,service_role;

commit;
