begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Encounter billing is an immutable source handoff. The source tables below
-- are private: the public RPCs are the only operational write boundary.
create schema if not exists cnyos_billing_internal;

alter table public.invoices
  add column if not exists aggregate_request_key uuid,
  add column if not exists aggregate_quote_fingerprint text;

create table if not exists cnyos_billing_internal.invoice_orders (
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  dispensing_order_id uuid not null references public.dispensing_orders(id) on delete restrict,
  prescription_id uuid not null references public.prescriptions(id) on delete restrict,
  provenance text not null default 'operational' check (provenance in ('operational','historical_import')),
  source_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (invoice_id, dispensing_order_id)
);

create table if not exists cnyos_billing_internal.invoice_source_charges (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  source_kind text not null check (source_kind in ('dispensing_item','treatment_charge')),
  source_id uuid,
  dispensing_item_id uuid references public.dispensing_items(id) on delete restrict,
  treatment_session_id uuid references public.clinical_treatment_sessions(id) on delete restrict,
  quantity numeric(24,12) not null,
  unit_price numeric(18,2) not null,
  line_total numeric(18,2) not null,
  duration_minutes integer,
  price_list_id uuid,
  price_list_version bigint,
  price_list_item_id uuid,
  price_item_version bigint,
  source_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  check ((source_kind='dispensing_item' and dispensing_item_id is not null and treatment_session_id is null)
      or (source_kind='treatment_charge' and treatment_session_id is not null and dispensing_item_id is null))
);

create table if not exists cnyos_billing_internal.invoice_request_receipts (
  request_key uuid primary key,
  encounter_id uuid not null references public.encounters(id) on delete restrict,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  quote_fingerprint text not null,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  created_at timestamptz not null default now()
);

create unique index if not exists invoices_aggregate_request_key_uidx
  on public.invoices(aggregate_request_key) where aggregate_request_key is not null;
create unique index if not exists invoice_source_charge_dispensing_uidx
  on cnyos_billing_internal.invoice_source_charges(invoice_id, dispensing_item_id)
  where dispensing_item_id is not null;
create unique index if not exists invoice_source_charge_treatment_uidx
  on cnyos_billing_internal.invoice_source_charges(invoice_id, source_kind, treatment_session_id)
  where source_kind='treatment_charge';

-- Existing one-order invoices are demonstrable from source_dispensing_order_id.
-- They are imported as historical provenance; no new operational handoff is
-- inferred and no historical invoice row is rewritten.
insert into cnyos_billing_internal.invoice_orders(
  invoice_id, dispensing_order_id, prescription_id, provenance, source_snapshot
)
select i.id, i.source_dispensing_order_id, d.prescription_id, 'historical_import',
       jsonb_build_object('invoice_id',i.id,'source_dispensing_order_id',d.id,
                          'prescription_id',d.prescription_id,'provenance','historical_import')
from public.invoices i
join public.dispensing_orders d on d.id=i.source_dispensing_order_id
where i.source_dispensing_order_id is not null
on conflict (invoice_id, dispensing_order_id) do nothing;

create or replace function cnyos_billing_internal.reject_immutable_source()
returns trigger language plpgsql security invoker set search_path = pg_catalog, cnyos_billing_internal
as $$
begin
  if tg_op <> 'INSERT' then raise exception 'INVOICE_SOURCE_IMMUTABLE'; end if;
  return new;
end;
$$;
drop trigger if exists invoice_orders_immutable on cnyos_billing_internal.invoice_orders;
create trigger invoice_orders_immutable before update or delete on cnyos_billing_internal.invoice_orders
for each row execute function cnyos_billing_internal.reject_immutable_source();
drop trigger if exists invoice_source_charges_immutable on cnyos_billing_internal.invoice_source_charges;
create trigger invoice_source_charges_immutable before update or delete on cnyos_billing_internal.invoice_source_charges
for each row execute function cnyos_billing_internal.reject_immutable_source();
drop trigger if exists invoice_request_receipts_immutable on cnyos_billing_internal.invoice_request_receipts;
create trigger invoice_request_receipts_immutable before update or delete on cnyos_billing_internal.invoice_request_receipts
for each row execute function cnyos_billing_internal.reject_immutable_source();

revoke all on schema cnyos_billing_internal from public, anon, authenticated, service_role;
revoke all on all tables in schema cnyos_billing_internal from public, anon, authenticated, service_role;
revoke all on all functions in schema cnyos_billing_internal from public, anon, authenticated, service_role;
alter table cnyos_billing_internal.invoice_orders enable row level security;
alter table cnyos_billing_internal.invoice_source_charges enable row level security;
alter table cnyos_billing_internal.invoice_request_receipts enable row level security;

create or replace function cnyos_billing_internal.encounter_invoice_quote(
  p_encounter_id uuid, p_clinic_id uuid, p_require_signoff boolean default false
)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare
  v_enc public.encounters%rowtype;
  v_rx public.prescriptions%rowtype;
  v_order public.dispensing_orders%rowtype;
  v_item record;
  v_di record;
  v_charge record;
  v_orders jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_fingerprint_input jsonb := '[]'::jsonb;
  v_medicine numeric(18,2) := 0;
  v_service numeric(18,2) := 0;
  v_order_count integer := 0;
  v_active_rx integer := 0;
  v_sessions integer := 0;
begin
  if p_encounter_id is null or p_clinic_id is null then raise exception 'ENCOUNTER_REQUIRED'; end if;
  select e.* into v_enc from public.encounters e
   where e.id=p_encounter_id and e.clinic_id=p_clinic_id;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_enc.status in ('cancelled','void') then raise exception 'ENCOUNTER_NOT_OPEN'; end if;
  if p_require_signoff and not exists (
    select 1 from public.clinical_record_signoffs s
     where s.encounter_id=p_encounter_id and s.record_section='complete_record' and s.lock_record
  ) then raise exception 'SIGNED_CLINICAL_RECORD_REQUIRED'; end if;

  select count(*)::integer into v_active_rx from public.prescriptions rx
   where rx.encounter_id=p_encounter_id and rx.status not in ('cancelled','void');
  if exists (
    select 1 from public.prescriptions rx
    join public.dispensing_orders d on d.prescription_id=rx.id
    join public.dispensing_items di on di.dispensing_order_id=d.id
    where rx.encounter_id=p_encounter_id and rx.status in ('cancelled','void') and di.quantity_dispensed>0
  ) then raise exception 'CANCELLED_PRESCRIPTION_HAS_DISPENSED_ITEMS'; end if;
  for v_rx in select rx.* from public.prescriptions rx
   where rx.encounter_id=p_encounter_id and rx.status not in ('cancelled','void') order by rx.id loop
    if v_rx.patient_id is distinct from v_enc.patient_id then raise exception 'PRESCRIPTION_PATIENT_MISMATCH'; end if;
    select d.* into v_order from public.dispensing_orders d where d.prescription_id=v_rx.id;
    if not found then raise exception 'PRESCRIPTION_ORDER_REQUIRED'; end if;
    if v_order.status <> 'submitted_to_billing' then raise exception 'DISPENSING_ORDER_NOT_READY_FOR_BILLING'; end if;
    if not exists (select 1 from public.prescription_items pi where pi.prescription_id=v_rx.id) then
      raise exception 'PRESCRIPTION_ITEMS_REQUIRED';
    end if;
    if exists (
      select 1 from public.dispensing_items di
      left join public.prescription_items pi on pi.id=di.prescription_item_id
      left join public.products p on p.id=pi.product_id
      where di.dispensing_order_id=v_order.id
        and (pi.id is null or pi.prescription_id<>v_rx.id or p.id is null or p.clinic_id is distinct from p_clinic_id or lower(p.dispense_unit) is distinct from lower(di.unit) or di.quantity_dispensed<=0 or di.status<>'dispensed'
             or di.unit_price is null or di.unit_price<=0)
    ) then raise exception 'DISPENSING_ITEMS_NOT_FINALIZED'; end if;
    if exists (
      select 1 from public.prescription_items pi
      where pi.prescription_id=v_rx.id
        and not exists (select 1 from public.dispensing_items di where di.dispensing_order_id=v_order.id and di.prescription_item_id=pi.id and di.quantity_dispensed>0 and di.status='dispensed')
    ) then raise exception 'DISPENSING_ITEMS_INCOMPLETE'; end if;
    v_order_count := v_order_count + 1;
    v_orders := v_orders || jsonb_build_array(jsonb_build_object('id',v_order.id,'prescription_id',v_rx.id,'queue_number',v_order.queue_number));
    v_fingerprint_input := v_fingerprint_input || jsonb_build_array(jsonb_build_object(
      'order_id',v_order.id,'prescription_id',v_rx.id,'queue_number',v_order.queue_number,'order_status',v_order.status,
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',di.id,'prescription_item_id',di.prescription_item_id,'product_id',pi.product_id,'quantity',di.quantity_dispensed,'unit',di.unit,'unit_price',di.unit_price,'status',di.status,'price_list_id',di.price_list_id,'price_list_version',di.price_list_version,'price_list_item_id',di.price_list_item_id,'price_item_version',di.price_item_version) order by di.id),'[]'::jsonb) from public.dispensing_items di join public.prescription_items pi on pi.id=di.prescription_item_id where di.dispensing_order_id=v_order.id)
    ));
    for v_di in select di.*,pi.product_id,p.name_th,p.sku from public.dispensing_items di
      join public.prescription_items pi on pi.id=di.prescription_item_id join public.products p on p.id=pi.product_id
      where di.dispensing_order_id=v_order.id order by di.id loop
      v_medicine := v_medicine + round(v_di.quantity_dispensed*v_di.unit_price,2);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind','medicine','id',v_di.id,'order_id',v_order.id,'prescription_id',v_rx.id,'product_id',v_di.product_id,'description',coalesce(v_di.name_th,v_di.sku,'ยา/สมุนไพร'),'quantity',v_di.quantity_dispensed,'unit_price',v_di.unit_price,'line_total',round(v_di.quantity_dispensed*v_di.unit_price,2),'price_list_id',v_di.price_list_id,'price_list_version',v_di.price_list_version,'price_list_item_id',v_di.price_list_item_id,'price_item_version',v_di.price_item_version));
    end loop;
  end loop;

  select count(*)::integer into v_sessions from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id;
  if v_sessions > 0 then
    select * into v_charge from cnyos_billing_internal.resolve_session_charge(p_encounter_id);
    v_service := v_charge.charge;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind','service','id',p_encounter_id,'treatment_session_id',(select s.id from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id order by s.id limit 1),'session_ids',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'duration_minutes',s.duration_minutes) order by s.id),'[]'::jsonb) from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id),'description','ค่าตรวจและบริการรักษา','quantity',v_charge.duration_minutes::numeric/60,'unit_price',v_charge.hourly_rate,'line_total',v_charge.charge,'duration_minutes',v_charge.duration_minutes,'service_id',v_charge.service_id,'price_list_id',v_charge.price_list_id,'price_list_version',v_charge.price_list_version,'price_list_item_id',v_charge.price_list_item_id,'price_item_version',v_charge.item_version));
    v_fingerprint_input := v_fingerprint_input || jsonb_build_array(jsonb_build_object('treatment_charge',v_charge.charge,'duration_minutes',v_charge.duration_minutes,'service_id',v_charge.service_id,'hourly_rate',v_charge.hourly_rate,'price_list_id',v_charge.price_list_id,'price_list_version',v_charge.price_list_version,'price_list_item_id',v_charge.price_list_item_id,'item_version',v_charge.item_version,'sessions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id)));
  end if;
  if v_medicine=0 and v_service=0 then raise exception 'INVOICE_REQUIRES_LINE'; end if;
  return jsonb_build_object('encounter_id',p_encounter_id,
    'quote_fingerprint',encode(sha256(convert_to(jsonb_build_object('encounter_id',p_encounter_id,'clinic_id',p_clinic_id,'sources',v_fingerprint_input)::text,'UTF8')),'hex'),
    'medicine_total',v_medicine,'service_total',v_service,'grand_total',v_medicine+v_service,
    'orders',v_orders,'lines',v_lines);
end;
$$;

create or replace function public.quote_encounter_invoice(p_encounter_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare v_clinic uuid:=public.current_clinic_id(); v_quote jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  v_quote:=cnyos_billing_internal.encounter_invoice_quote(p_encounter_id,v_clinic,false);
  return v_quote;
end;
$$;
revoke all on function public.quote_encounter_invoice(uuid) from public, anon, service_role;
grant execute on function public.quote_encounter_invoice(uuid) to authenticated;

create or replace function public.issue_atomic_encounter_invoice(
  p_request_key uuid, p_encounter_id uuid, p_quote_fingerprint text
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare
  v_clinic uuid:=public.current_clinic_id(); v_actor uuid:=auth.uid(); v_quote jsonb;
  v_enc public.encounters%rowtype; v_invoice public.invoices%rowtype; v_existing cnyos_billing_internal.invoice_request_receipts%rowtype;
  v_order jsonb; v_line jsonb; v_code text; v_order_id uuid; v_rx_id uuid; v_invoice_id uuid;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_request_key is null or p_encounter_id is null or p_quote_fingerprint is null or p_quote_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'REQUEST_QUOTE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cnyos-encounter-invoice-request:'||p_request_key::text,0));
  select e.* into v_enc from public.encounters e where e.id=p_encounter_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  select * into v_existing from cnyos_billing_internal.invoice_request_receipts where request_key=p_request_key;
  if found then
    if v_existing.encounter_id<>p_encounter_id or v_existing.clinic_id<>v_clinic or v_existing.actor_id<>v_actor or v_existing.quote_fingerprint<>p_quote_fingerprint then raise exception 'INVOICE_REQUEST_CONFLICT'; end if;
    return query select i.id,i.invoice_number,i.grand_total,i.balance_due from public.invoices i where i.id=v_existing.invoice_id; return;
  end if;
  if exists(select 1 from public.invoices i where i.encounter_id=p_encounter_id and i.status not in ('void','cancelled')) then raise exception 'ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE'; end if;
  -- Every caller locks encounter first, then all orders, prescriptions, items.
  perform 1 from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id
    where rx.encounter_id=p_encounter_id order by d.id for update of d;
  perform 1 from public.prescriptions rx where rx.encounter_id=p_encounter_id order by rx.id for update;
  perform 1 from public.prescription_items pi join public.prescriptions rx on rx.id=pi.prescription_id where rx.encounter_id=p_encounter_id order by pi.id for update of pi;
  perform 1 from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id where rx.encounter_id=p_encounter_id order by di.id for update of di;
  if exists(select 1 from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id) then
    -- Match Price Master's list -> item lock order, not item -> list.
    perform 1 from public.price_lists pl
     where pl.id=(select r.price_list_id from cnyos_billing_internal.resolve_session_charge(p_encounter_id) r)
     for update;
    perform 1 from public.price_list_items pli
     where pli.id=(select r.price_list_item_id from cnyos_billing_internal.resolve_session_charge(p_encounter_id) r)
     for update;
  end if;
  v_quote:=cnyos_billing_internal.encounter_invoice_quote(p_encounter_id,v_clinic,exists(select 1 from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id));
  if v_quote->>'quote_fingerprint' is distinct from p_quote_fingerprint then raise exception 'STALE_INVOICE_QUOTE'; end if;
  select coalesce(nullif(regexp_replace(upper(c.code),'[^A-Z0-9]','','g'),''),'CLN') into v_code from public.clinics c where c.id=v_clinic;
  insert into public.invoices(invoice_number,patient_id,encounter_id,status,subtotal,discount_total,tax_total,rounding,grand_total,paid_amount,balance_due,issued_at,created_by,aggregate_request_key,aggregate_quote_fingerprint)
  values ('INV-'||v_code||'-'||to_char(current_date,'YYYYMMDD')||'-'||lpad(public.next_clinic_counter(v_clinic,'invoice')::text,8,'0'),v_enc.patient_id,p_encounter_id,'issued',(v_quote->>'grand_total')::numeric,0,0,0,(v_quote->>'grand_total')::numeric,0,(v_quote->>'grand_total')::numeric,now(),v_actor,p_request_key,p_quote_fingerprint) returning * into v_invoice;
  for v_line in select value from jsonb_array_elements(v_quote->'lines') loop
    if v_line->>'kind'='service' then
      insert into public.invoice_items(invoice_id,item_type,service_id,description,quantity,unit_price,line_total)
      values(v_invoice.id,'service',(v_line->>'service_id')::uuid,v_line->>'description',(v_line->>'quantity')::numeric,(v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric);
      insert into cnyos_billing_internal.invoice_source_charges(invoice_id,source_kind,treatment_session_id,quantity,unit_price,line_total,duration_minutes,price_list_id,price_list_version,price_list_item_id,price_item_version,source_snapshot)
      select v_invoice.id,'treatment_charge',s.id,s.duration_minutes::numeric/60,(v_line->>'unit_price')::numeric,
        round(s.cumulative_minutes::numeric*(v_line->>'unit_price')::numeric/60,2)
          - round((s.cumulative_minutes-s.duration_minutes)::numeric*(v_line->>'unit_price')::numeric/60,2),
        s.duration_minutes,(v_line->>'price_list_id')::uuid,(v_line->>'price_list_version')::bigint,(v_line->>'price_list_item_id')::uuid,(v_line->>'price_item_version')::bigint,
        jsonb_build_object('line',v_line,'session_id',s.id,'duration_minutes',s.duration_minutes,'rounding_allocation','cumulative_minutes_by_session_id')
      from (select t.*,sum(t.duration_minutes) over(order by t.id) cumulative_minutes
        from public.clinical_treatment_sessions t where t.encounter_id=p_encounter_id) s;
    else
      insert into public.invoice_items(invoice_id,item_type,product_id,dispensing_item_id,description,quantity,unit_price,line_total)
      values(v_invoice.id,'product',(v_line->>'product_id')::uuid,(v_line->>'id')::uuid,v_line->>'description',(v_line->>'quantity')::numeric,(v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric);
      insert into cnyos_billing_internal.invoice_source_charges(invoice_id,source_kind,source_id,dispensing_item_id,quantity,unit_price,line_total,price_list_id,price_list_version,price_list_item_id,price_item_version,source_snapshot)
      values(v_invoice.id,'dispensing_item',(v_line->>'id')::uuid,(v_line->>'id')::uuid,(v_line->>'quantity')::numeric,(v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,(v_line->>'price_list_id')::uuid,(v_line->>'price_list_version')::bigint,(v_line->>'price_list_item_id')::uuid,(v_line->>'price_item_version')::bigint,v_line);
    end if;
  end loop;
  for v_order in select value from jsonb_array_elements(v_quote->'orders') loop
    v_order_id:=(v_order->>'id')::uuid; v_rx_id:=(v_order->>'prescription_id')::uuid;
    insert into cnyos_billing_internal.invoice_orders(invoice_id,dispensing_order_id,prescription_id,provenance,source_snapshot)
    values(v_invoice.id,v_order_id,v_rx_id,'operational',v_order);
    update public.dispensing_orders set status='billed',updated_at=now() where id=v_order_id;
  end loop;
  insert into cnyos_billing_internal.invoice_request_receipts(request_key,encounter_id,clinic_id,actor_id,quote_fingerprint,invoice_id)
  values(p_request_key,p_encounter_id,v_clinic,v_actor,p_quote_fingerprint,v_invoice.id);
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values(v_clinic,v_actor,'issue_encounter_invoice','invoices',v_invoice.id::text,jsonb_build_object('request_key',p_request_key,'encounter_id',p_encounter_id,'orders',v_quote->'orders','medicine_total',v_quote->'medicine_total','service_total',v_quote->'service_total','grand_total',v_quote->'grand_total'));
  return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due;
end;
$$;
revoke all on function public.issue_atomic_encounter_invoice(uuid,uuid,text) from public, anon, service_role;
grant execute on function public.issue_atomic_encounter_invoice(uuid,uuid,text) to authenticated;

-- Legacy callers remain a strictly single-order compatibility path.  They do
-- not get to choose prices and cannot silently widen to an encounter subset.
create or replace function public.issue_atomic_dispensing_invoice(
  p_dispensing_order_id uuid, p_service_fee numeric default 0, p_discount numeric default 0
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public, cnyos_billing_internal, pg_temp
as $$
declare v_clinic uuid:=public.current_clinic_id(); v_order public.dispensing_orders%rowtype; v_rx public.prescriptions%rowtype; v_quote jsonb; v_old public.invoices%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null or not public.is_clinic_member(v_clinic,array['owner','admin','billing']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_service_fee is null or p_service_fee<0 or p_service_fee<>round(p_service_fee,2) then raise exception 'INVOICE_AMOUNT_INVALID'; end if;
  if p_discount is null or p_discount<>0 then raise exception 'DISCOUNT_NOT_AUTHORIZED'; end if;
  select d.* into v_order from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where d.id=p_dispensing_order_id and e.clinic_id=v_clinic;
  if not found then raise exception 'DISPENSING_ORDER_NOT_FOUND'; end if;
  select rx.* into v_rx from public.prescriptions rx where rx.id=v_order.prescription_id;
  if (select count(*) from public.prescriptions x where x.encounter_id=v_rx.encounter_id and x.status not in ('cancelled','void')) > 1 then raise exception 'LEGACY_MULTI_ORDER_REQUIRES_ENCOUNTER_INVOICE'; end if;
  select i.* into v_old from public.invoices i
   where i.source_dispensing_order_id=p_dispensing_order_id and i.status not in ('void','cancelled')
  union all
  select i.* from public.invoices i join cnyos_billing_internal.invoice_orders io on io.invoice_id=i.id
   where io.dispensing_order_id=p_dispensing_order_id and i.status not in ('void','cancelled') limit 1;
  if found then
    if coalesce((select sum(ii.line_total) from public.invoice_items ii where ii.invoice_id=v_old.id and ii.item_type='service'),0)<>p_service_fee or v_old.discount_total<>p_discount then raise exception 'DISPENSING_ORDER_ALREADY_BILLED'; end if;
    return query select v_old.id,v_old.invoice_number,v_old.grand_total,v_old.balance_due; return;
  end if;
  v_quote:=cnyos_billing_internal.encounter_invoice_quote(v_rx.encounter_id,v_clinic,false);
  if (v_quote->'orders'->0->>'id')::uuid<>p_dispensing_order_id then raise exception 'LEGACY_ORDER_NOT_COMPLETE_SOURCE'; end if;
  if p_service_fee is distinct from (v_quote->>'service_total')::numeric then raise exception 'TREATMENT_PRICE_MISMATCH'; end if;
  return query select * from public.issue_atomic_encounter_invoice(gen_random_uuid(),v_rx.encounter_id,v_quote->>'quote_fingerprint');
end;
$$;
revoke all on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric) from public, anon, service_role;
grant execute on function public.issue_atomic_dispensing_invoice(uuid,numeric,numeric) to authenticated, service_role;

-- The historical pharmacy routine locked order then prescription.  Preserve
-- its behavior but prepend the encounter lock so it shares the aggregate
-- workflow's encounter -> order -> prescription lock order.
do $$
declare v_source text;
begin
  select pg_get_functiondef('public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'::regprocedure) into v_source;
  v_source := replace(v_source,
    E'  if length(coalesce(p_reason, \'\')) > 1000 then\n    raise exception \'PRESCRIPTION_DISPENSING_REASON_TOO_LONG\';\n  end if;\n',
    E'  if length(coalesce(p_reason, \'\')) > 1000 then\n    raise exception \'PRESCRIPTION_DISPENSING_REASON_TOO_LONG\';\n  end if;\n\n  perform e.id from public.encounters e join public.prescriptions rx on rx.encounter_id=e.id join public.dispensing_orders d on d.prescription_id=rx.id where d.id=p_dispensing_order_id and e.clinic_id=v_clinic_id for update of e;\n  if not found then raise exception \'DISPENSING_ORDER_NOT_FOUND\'; end if;\n');
  if position('perform e.id from public.encounters e join public.prescriptions rx' in v_source)=0 then
    raise exception 'PHARMACY_LOCK_ORDER_PATCH_FAILED';
  end if;
  execute v_source;
end $$;

-- The helper was created after the initial schema-wide revoke.
revoke all on all functions in schema cnyos_billing_internal from public, anon, authenticated, service_role;

commit;

select 'ENCOUNTER_INVOICE_AGGREGATION_READY' as status,
       to_regprocedure('public.quote_encounter_invoice(uuid)') is not null as quote_ready,
       to_regprocedure('public.issue_atomic_encounter_invoice(uuid,uuid,text)') is not null as issue_ready;
