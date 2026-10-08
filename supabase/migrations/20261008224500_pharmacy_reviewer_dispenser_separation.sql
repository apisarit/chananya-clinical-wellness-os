begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Pharmacy sale prices are tenant-owned master data.  Browser price fields are
-- presentation only; dispensing resolves the current row below while holding
-- the order and stock rows in the same transaction.
create table if not exists public.clinic_product_prices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  product_id uuid not null,
  unit_price numeric(18,2) not null
    constraint clinic_product_prices_thb_range_check
    check (unit_price between 100 and 2000),
  currency text not null default 'THB'
    constraint clinic_product_prices_thb_only_check
    check (currency = 'THB'),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deactivated_by uuid references auth.users(id) on delete set null,
  deactivated_at timestamptz,
  reason text,
  constraint clinic_product_prices_product_clinic_fkey
    foreign key (product_id, clinic_id)
    references public.products(id, clinic_id) on delete restrict,
  constraint clinic_product_prices_effective_window_check
    check (effective_to is null or effective_to > effective_from)
);

create unique index if not exists clinic_product_prices_one_current_uidx
  on public.clinic_product_prices(clinic_id, product_id)
  where active and effective_to is null;
create index if not exists clinic_product_prices_lookup_idx
  on public.clinic_product_prices(clinic_id, product_id, effective_from desc)
  where active;

-- This is the durable state-transition receipt.  It is intentionally separate
-- from the general audit log so a reviewer, dispenser and governance reader can
-- prove the exact order history without reconstructing mutable queue rows.
create table if not exists public.dispensing_order_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  prescription_id uuid not null references public.prescriptions(id) on delete restrict,
  dispensing_order_id uuid not null references public.dispensing_orders(id) on delete restrict,
  action text not null check (action in ('review','dispense','submit_billing')),
  from_status text not null,
  to_status text not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  actor_role text not null check (length(btrim(actor_role)) > 0),
  reason text,
  request_key uuid not null default gen_random_uuid(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint dispensing_order_events_request_key_uidx unique(request_key),
  constraint dispensing_order_events_transition_uidx
    unique(dispensing_order_id, from_status, to_status)
);

create index if not exists dispensing_order_events_clinic_created_idx
  on public.dispensing_order_events(clinic_id, created_at desc);
create index if not exists dispensing_order_events_prescription_idx
  on public.dispensing_order_events(prescription_id, created_at);

alter table public.clinic_product_prices enable row level security;
alter table public.dispensing_order_events enable row level security;

drop policy if exists clinic_product_prices_tenant_read
  on public.clinic_product_prices;
create policy clinic_product_prices_tenant_read
on public.clinic_product_prices for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (
    public.department_can('product_read')
    or public.department_can('billing')
    or public.department_can('governance')
  )
);

drop policy if exists dispensing_order_events_tenant_read
  on public.dispensing_order_events;
create policy dispensing_order_events_tenant_read
on public.dispensing_order_events for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (
    public.department_can('patient_read')
    or public.department_can('governance')
  )
);

-- These tables are created after the global subscription-boundary migration,
-- so install the same restrictive OFF switch explicitly instead of relying on
-- an earlier schema sweep that could not have seen them.
create policy cnyos_active_subscription_boundary
on public.clinic_product_prices as restrictive for all to authenticated
using (public.current_clinic_id() is not null)
with check (public.current_clinic_id() is not null);

create policy cnyos_active_subscription_boundary
on public.dispensing_order_events as restrictive for all to authenticated
using (public.current_clinic_id() is not null)
with check (public.current_clinic_id() is not null);

drop trigger if exists trg_cnyos_authenticated_subscription_statement_write
  on public.clinic_product_prices;
create trigger trg_cnyos_authenticated_subscription_statement_write
before insert or update or delete on public.clinic_product_prices
for each statement
execute function public.enforce_authenticated_subscription_statement_write();

drop trigger if exists trg_cnyos_authenticated_subscription_statement_write
  on public.dispensing_order_events;
create trigger trg_cnyos_authenticated_subscription_statement_write
before insert or update or delete on public.dispensing_order_events
for each statement
execute function public.enforce_authenticated_subscription_statement_write();

create or replace function public.reject_dispensing_order_event_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'DISPENSING_ORDER_EVENTS_APPEND_ONLY';
end;
$$;

drop trigger if exists dispensing_order_events_append_only_update_delete
  on public.dispensing_order_events;
create trigger dispensing_order_events_append_only_update_delete
before update or delete on public.dispensing_order_events
for each statement execute function public.reject_dispensing_order_event_mutation();

drop trigger if exists dispensing_order_events_append_only_truncate
  on public.dispensing_order_events;
create trigger dispensing_order_events_append_only_truncate
before truncate on public.dispensing_order_events
for each statement execute function public.reject_dispensing_order_event_mutation();

-- Governance or Billing owns price master changes.  Pharmacy can consume the
-- price but cannot silently alter it while dispensing.
create or replace function public.set_clinic_product_price(
  p_product_id uuid,
  p_unit_price numeric,
  p_currency text default 'THB',
  p_reason text default null
)
returns public.clinic_product_prices
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic_id uuid := public.current_clinic_id();
  v_product public.products%rowtype;
  v_previous public.clinic_product_prices%rowtype;
  v_price public.clinic_product_prices%rowtype;
  v_currency text := upper(btrim(coalesce(p_currency, '')));
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not (
    public.department_can('governance')
    or public.department_can('billing')
  ) then
    raise exception 'PRICE_GOVERNANCE_REQUIRED';
  end if;
  if p_product_id is null then
    raise exception 'PRODUCT_REQUIRED';
  end if;
  if p_unit_price is null or p_unit_price < 100 or p_unit_price > 2000 then
    raise exception 'PRODUCT_PRICE_INVALID';
  end if;
  if v_currency <> 'THB' then
    raise exception 'PRODUCT_PRICE_CURRENCY_INVALID';
  end if;
  if length(coalesce(p_reason, '')) > 1000 then
    raise exception 'PRODUCT_PRICE_REASON_TOO_LONG';
  end if;

  select p.* into v_product
  from public.products p
  where p.id = p_product_id
    and p.clinic_id = v_clinic_id
    and p.active
  for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  select price.* into v_previous
  from public.clinic_product_prices price
  where price.clinic_id = v_clinic_id
    and price.product_id = p_product_id
    and price.active
    and price.effective_to is null
  for update;

  if found
     and v_previous.unit_price = p_unit_price
     and v_previous.currency = v_currency then
    return v_previous;
  end if;

  if v_previous.id is not null then
    update public.clinic_product_prices
    set active = false,
        effective_to = now(),
        deactivated_by = v_actor,
        deactivated_at = now()
    where id = v_previous.id;
  end if;

  insert into public.clinic_product_prices(
    clinic_id,product_id,unit_price,currency,created_by,reason
  ) values (
    v_clinic_id,p_product_id,p_unit_price,v_currency,v_actor,
    nullif(btrim(p_reason),'')
  ) returning * into v_price;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id,v_actor,'set_product_sale_price','clinic_product_prices',
    v_price.id::text,
    jsonb_build_object(
      'product_id',p_product_id,
      'old_unit_price',v_previous.unit_price,
      'new_unit_price',v_price.unit_price,
      'currency',v_price.currency,
      'reason',nullif(btrim(p_reason),'')
    )
  );

  return v_price;
end;
$$;

-- Billing and Governance need an explicit completeness gate before Pharmacy
-- can dispense.  The function is the bounded read surface: it returns active
-- products for the caller's clinic only and marks every missing current THB
-- price as blocking.  It does not invent or backfill commercial prices.
create or replace function public.list_clinic_product_price_completeness()
returns table (
  product_id uuid,
  sku text,
  name_th text,
  stock_unit text,
  dispense_unit text,
  conversion_factor numeric,
  price_id uuid,
  unit_price numeric,
  currency text,
  effective_from timestamptz,
  price_ready boolean,
  issue_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic_id uuid := public.current_clinic_id();
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not (
    public.department_can('governance')
    or public.department_can('billing')
  ) then
    raise exception 'PRICE_GOVERNANCE_REQUIRED';
  end if;

  return query
  select
    p.id,
    p.sku,
    p.name_th,
    p.stock_unit,
    p.dispense_unit,
    p.conversion_factor,
    price.id,
    price.unit_price,
    price.currency,
    price.effective_from,
    price.id is not null,
    case when price.id is null then 'PRODUCT_PRICE_REQUIRED' else null end
  from public.products p
  left join lateral (
    select current_price.*
    from public.clinic_product_prices current_price
    where current_price.clinic_id = v_clinic_id
      and current_price.product_id = p.id
      and current_price.active
      and current_price.effective_from <= now()
      and (
        current_price.effective_to is null
        or current_price.effective_to > now()
      )
    order by current_price.effective_from desc,current_price.id desc
    limit 1
  ) price on true
  where p.clinic_id = v_clinic_id
    and p.active
  order by p.sku,p.id;
end;
$$;

-- Keep the four-argument identity used by the existing browser.  The legacy
-- p_item_prices JSON remains accepted for wire compatibility but is never used
-- as a source of price; price always comes from clinic_product_prices.
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.dispensing_orders%rowtype;
  v_prescription public.prescriptions%rowtype;
  v_item public.prescription_items%rowtype;
  v_product public.products%rowtype;
  v_price public.clinic_product_prices%rowtype;
  v_lot record;
  v_request_key uuid;
  v_from_status text;
  v_conversion_factor numeric(18,6);
  v_exact_required_stock numeric;
  v_required_stock numeric(18,4);
  v_remaining_stock numeric(18,4);
  v_remaining_dispense numeric(18,4);
  v_take_stock numeric(18,4);
  v_take_dispense numeric(18,4);
  v_item_count integer := 0;
  v_allocation_count integer := 0;
  v_medication_total numeric(18,2) := 0;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if v_clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  if not public.department_can('pharmacy') then
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

  v_actor_role := case
    when public.is_super_admin() then 'super_admin'
    else coalesce(
      nullif(public.current_department_role(), ''),
      nullif(public.current_user_role(), ''),
      'unknown'
    )
  end;

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

  select rx.* into v_prescription
  from public.prescriptions rx
  where rx.id = v_order.prescription_id
  for update;

  if v_action = 'review' then
    if v_order.status in ('reviewed','dispensed','submitted_to_billing','billed') then
      select event.request_key into v_request_key
      from public.dispensing_order_events event
      where event.dispensing_order_id = v_order.id
        and event.to_status = 'reviewed'
      order by event.created_at desc
      limit 1;
      return jsonb_build_object(
        'dispensing_order_id',v_order.id,
        'status',v_order.status,
        'request_key',v_request_key,
        'idempotent',true
      );
    end if;
    if v_order.status not in ('waiting','pending') then
      raise exception 'PRESCRIPTION_ORDER_NOT_REVIEWABLE';
    end if;

    v_from_status := v_order.status;
    v_request_key := gen_random_uuid();
    update public.dispensing_orders
    set status = 'reviewed',
        reviewed_by = v_actor,
        reviewed_at = now(),
        updated_at = now()
    where id = v_order.id
    returning * into v_order;

    update public.prescriptions
    set status = 'in_pharmacy', updated_at = now()
    where id = v_prescription.id;

    insert into public.dispensing_order_events(
      clinic_id,prescription_id,dispensing_order_id,action,
      from_status,to_status,actor_id,actor_role,reason,request_key,metadata
    ) values (
      v_clinic_id,v_prescription.id,v_order.id,'review',
      v_from_status,'reviewed',v_actor,v_actor_role,
      nullif(btrim(p_reason),''),v_request_key,
      jsonb_build_object('prescription_no',v_prescription.prescription_no)
    );

    insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values (
      v_clinic_id,v_actor,'review_prescription_dispensing',
      'dispensing_orders',v_order.id::text,
      jsonb_build_object(
        'prescription_id',v_prescription.id,
        'prescription_no',v_prescription.prescription_no,
        'from_status',v_from_status,
        'to_status','reviewed',
        'actor_role',v_actor_role,
        'request_key',v_request_key,
        'reason',nullif(btrim(p_reason),'')
      )
    );

    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'request_key',v_request_key,
      'idempotent',false
    );
  end if;

  if v_action = 'dispense' then
    if v_order.status in ('dispensed','submitted_to_billing','billed') then
      select event.request_key into v_request_key
      from public.dispensing_order_events event
      where event.dispensing_order_id = v_order.id
        and event.to_status = 'dispensed'
      order by event.created_at desc
      limit 1;
      select count(*)::int,
             coalesce(sum(di.quantity_dispensed * di.unit_price),0)
      into v_allocation_count,v_medication_total
      from public.dispensing_items di
      where di.dispensing_order_id = v_order.id
        and di.status = 'dispensed';
      return jsonb_build_object(
        'dispensing_order_id',v_order.id,
        'status',v_order.status,
        'allocation_count',v_allocation_count,
        'medication_total',v_medication_total,
        'request_key',v_request_key,
        'idempotent',true
      );
    end if;
    if v_order.status <> 'reviewed' then
      raise exception 'PRESCRIPTION_ORDER_NOT_REVIEWED';
    end if;
    if v_order.reviewed_by is null then
      raise exception 'PRESCRIPTION_REVIEWER_REQUIRED';
    end if;
    if v_order.reviewed_by = v_actor then
      raise exception 'PRESCRIPTION_REVIEWER_DISPENSER_MUST_DIFFER';
    end if;

    for v_item in
      select pi.*
      from public.prescription_items pi
      where pi.prescription_id = v_prescription.id
        and pi.status = 'ordered'
      order by pi.created_at,pi.id
      for update
    loop
      v_item_count := v_item_count + 1;

      select p.* into v_product
      from public.products p
      where p.id = v_item.product_id
        and p.clinic_id = v_clinic_id
        and p.active
      for share;
      if not found then
        raise exception 'PRESCRIPTION_PRODUCT_NOT_FOUND';
      end if;

      select price.* into v_price
      from public.clinic_product_prices price
      where price.clinic_id = v_clinic_id
        and price.product_id = v_item.product_id
        and price.active
        and price.effective_from <= now()
        and (price.effective_to is null or price.effective_to > now())
      order by price.effective_from desc,price.id desc
      limit 1
      for share;
      if not found then
        raise exception 'PRESCRIPTION_PRODUCT_PRICE_NOT_CONFIGURED';
      end if;

      if v_product.conversion_factor is null or v_product.conversion_factor <= 0 then
        raise exception 'PRODUCT_CONVERSION_FACTOR_INVALID';
      end if;
      if v_item.quantity_prescribed is null or v_item.quantity_prescribed <= 0 then
        raise exception 'PRESCRIPTION_ITEM_QUANTITY_INVALID';
      end if;

      if v_item.unit = v_product.stock_unit then
        v_conversion_factor := 1;
        v_exact_required_stock := v_item.quantity_prescribed;
      elsif v_item.unit = v_product.dispense_unit then
        -- Exact unit policy: inventory_lots are held in the atomic stock/base
        -- unit. conversion_factor is the number of stock/base units consumed
        -- by one dispense unit (for example 10 tablets per blister).  This
        -- avoids fractional stock decrements for pack factors such as
        -- 3/6/12/30. Product Master must use the atomic inventory unit here.
        v_conversion_factor := v_product.conversion_factor;
        v_exact_required_stock :=
          v_item.quantity_prescribed * v_conversion_factor;
      else
        raise exception 'PRESCRIPTION_ITEM_UNIT_NOT_CONVERTIBLE';
      end if;

      v_required_stock := round(v_exact_required_stock,4);
      if v_required_stock <> v_exact_required_stock then
        raise exception 'PRESCRIPTION_STOCK_UNIT_PRECISION_EXCEEDED';
      end if;

      if v_required_stock <= 0 then
        raise exception 'PRESCRIPTION_STOCK_QUANTITY_INVALID';
      end if;

      v_remaining_stock := v_required_stock;
      v_remaining_dispense := v_item.quantity_prescribed;
      for v_lot in
        select l.id,l.current_quantity,l.expiry_date,l.lot_number,l.unit
        from public.inventory_lots l
        where l.clinic_id = v_clinic_id
          and l.product_id = v_item.product_id
          and l.unit = v_product.stock_unit
          and l.status = 'active'
          and l.current_quantity > 0
          and (l.expiry_date is null or l.expiry_date >= current_date)
        order by l.expiry_date nulls last,l.received_at,l.id
        for update
      loop
        exit when v_remaining_stock <= 0;
        v_take_stock := least(v_remaining_stock,v_lot.current_quantity);
        -- Stock is exact.  Dispense quantities are represented to the table's
        -- 4-decimal contract; the last FEFO allocation receives the residual
        -- so the invoiceable sum remains exactly the prescribed quantity.
        v_take_dispense := case
          when v_take_stock = v_remaining_stock then v_remaining_dispense
          else round(v_take_stock / v_conversion_factor,4)
        end;
        if v_take_dispense <= 0 or v_take_dispense > v_remaining_dispense then
          raise exception 'PRESCRIPTION_DISPENSE_ALLOCATION_PRECISION_INVALID';
        end if;

        insert into public.dispensing_items(
          dispensing_order_id,prescription_item_id,inventory_lot_id,
          quantity_dispensed,unit,unit_price,status,notes
        ) values (
          v_order.id,v_item.id,v_lot.id,v_take_dispense,v_item.unit,
          v_price.unit_price,'dispensed',
          format(
            'FEFO; stock=%s %s; stock-units-per-dispense=%s; price=%s/%s',
            v_take_stock,v_product.stock_unit,v_conversion_factor,
            v_price.unit_price,v_price.currency
          )
        );

        insert into public.stock_movements(
          clinic_id,inventory_lot_id,movement_type,quantity,direction,
          reference_type,reference_id,reason,performed_by
        ) values (
          v_clinic_id,v_lot.id,'prescription_dispense',v_take_stock,'out',
          'dispensing_order',v_order.id,
          format(
            'Prescription FEFO base units: %s %s -> %s %s',
            v_take_stock,v_product.stock_unit,v_take_dispense,v_item.unit
          ),
          v_actor
        );

        v_remaining_stock := v_remaining_stock - v_take_stock;
        v_remaining_dispense := v_remaining_dispense - v_take_dispense;
        v_allocation_count := v_allocation_count + 1;
      end loop;

      if v_remaining_stock > 0 or v_remaining_dispense <> 0 then
        raise exception 'PRESCRIPTION_STOCK_INSUFFICIENT';
      end if;

      update public.prescription_items
      set status = 'dispensed',updated_at = now()
      where id = v_item.id;

      v_medication_total := v_medication_total
        + round(v_item.quantity_prescribed * v_price.unit_price,2);
    end loop;

    if v_item_count = 0 then
      raise exception 'PRESCRIPTION_PENDING_ITEM_REQUIRED';
    end if;

    v_from_status := v_order.status;
    v_request_key := gen_random_uuid();
    update public.dispensing_orders
    set status = 'dispensed',
        prepared_by = v_actor,
        prepared_at = now(),
        dispensed_by = v_actor,
        dispensed_at = now(),
        updated_at = now()
    where id = v_order.id
    returning * into v_order;

    update public.prescriptions
    set status = 'dispensed',completed_at = now(),updated_at = now()
    where id = v_prescription.id;

    insert into public.dispensing_order_events(
      clinic_id,prescription_id,dispensing_order_id,action,
      from_status,to_status,actor_id,actor_role,reason,request_key,metadata
    ) values (
      v_clinic_id,v_prescription.id,v_order.id,'dispense',
      v_from_status,'dispensed',v_actor,v_actor_role,
      nullif(btrim(p_reason),''),v_request_key,
      jsonb_build_object(
        'prescription_no',v_prescription.prescription_no,
        'reviewed_by',v_order.reviewed_by,
        'item_count',v_item_count,
        'allocation_count',v_allocation_count,
        'medication_total',v_medication_total,
        'price_source','clinic_product_prices',
        'allocation','FEFO',
        'conversion_policy','stock_base_units_per_dispense_unit'
      )
    );

    insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values (
      v_clinic_id,v_actor,'dispense_prescription_order',
      'dispensing_orders',v_order.id::text,
      jsonb_build_object(
        'prescription_id',v_prescription.id,
        'prescription_no',v_prescription.prescription_no,
        'from_status',v_from_status,
        'to_status','dispensed',
        'reviewed_by',v_order.reviewed_by,
        'dispensed_by',v_actor,
        'actor_role',v_actor_role,
        'item_count',v_item_count,
        'allocation_count',v_allocation_count,
        'medication_total',v_medication_total,
        'price_source','clinic_product_prices',
        'allocation','FEFO',
        'conversion_policy','stock_base_units_per_dispense_unit',
        'request_key',v_request_key,
        'reason',nullif(btrim(p_reason),'')
      )
    );

    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'item_count',v_item_count,
      'allocation_count',v_allocation_count,
      'medication_total',v_medication_total,
      'request_key',v_request_key,
      'idempotent',false
    );
  end if;

  if v_order.status in ('submitted_to_billing','billed') then
    select event.request_key into v_request_key
    from public.dispensing_order_events event
    where event.dispensing_order_id = v_order.id
      and event.to_status = 'submitted_to_billing'
    order by event.created_at desc
    limit 1;
    return jsonb_build_object(
      'dispensing_order_id',v_order.id,
      'status',v_order.status,
      'request_key',v_request_key,
      'idempotent',true
    );
  end if;
  if v_order.status <> 'dispensed' then
    raise exception 'PRESCRIPTION_ORDER_NOT_DISPENSED';
  end if;

  v_from_status := v_order.status;
  v_request_key := gen_random_uuid();
  update public.dispensing_orders
  set status = 'submitted_to_billing',updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.dispensing_order_events(
    clinic_id,prescription_id,dispensing_order_id,action,
    from_status,to_status,actor_id,actor_role,reason,request_key,metadata
  ) values (
    v_clinic_id,v_prescription.id,v_order.id,'submit_billing',
    v_from_status,'submitted_to_billing',v_actor,v_actor_role,
    nullif(btrim(p_reason),''),v_request_key,
    jsonb_build_object('prescription_no',v_prescription.prescription_no)
  );

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id,v_actor,'submit_prescription_to_billing',
    'dispensing_orders',v_order.id::text,
    jsonb_build_object(
      'prescription_id',v_prescription.id,
      'prescription_no',v_prescription.prescription_no,
      'from_status',v_from_status,
      'to_status','submitted_to_billing',
      'actor_role',v_actor_role,
      'request_key',v_request_key,
      'reason',nullif(btrim(p_reason),'')
    )
  );

  return jsonb_build_object(
    'dispensing_order_id',v_order.id,
    'status',v_order.status,
    'request_key',v_request_key,
    'idempotent',false
  );
end;
$$;

create or replace function public.prescription_dispensing_healthcheck()
returns table (ready boolean,schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    to_regprocedure(
      'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'
    ) is not null
    and to_regprocedure(
      'public.set_clinic_product_price(uuid,numeric,text,text)'
    ) is not null
    and to_regprocedure(
      'public.list_clinic_product_price_completeness()'
    ) is not null
    and to_regclass('public.clinic_product_prices') is not null
    and to_regclass('public.dispensing_order_events') is not null,
    '2026-10-08.1'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

revoke all on table public.clinic_product_prices from public,anon,authenticated;
grant select on table public.clinic_product_prices to authenticated;
revoke insert,update,delete,truncate,references,trigger
  on table public.clinic_product_prices from service_role;
grant select on table public.clinic_product_prices to service_role;

revoke all on table public.dispensing_order_events
  from public,anon,authenticated,service_role;
grant select on table public.dispensing_order_events to authenticated,service_role;

revoke all on function public.reject_dispensing_order_event_mutation()
  from public,anon,authenticated,service_role;
revoke all on function public.set_clinic_product_price(uuid,numeric,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.set_clinic_product_price(uuid,numeric,text,text)
  to authenticated;
revoke all on function public.list_clinic_product_price_completeness()
  from public,anon,authenticated,service_role;
grant execute on function public.list_clinic_product_price_completeness()
  to authenticated;
revoke all on function public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)
  to authenticated;
revoke all on function public.prescription_dispensing_healthcheck()
  from public,anon,authenticated,service_role;
grant execute on function public.prescription_dispensing_healthcheck()
  to authenticated,service_role;

-- All operational mutations stay behind the controlled RPCs.
revoke insert,update,delete,truncate on public.dispensing_orders from authenticated;
revoke insert,update,delete,truncate on public.dispensing_items from authenticated;
revoke insert,update,delete,truncate on public.stock_movements from authenticated;

commit;

select
  'CNYOS_PHARMACY_REVIEWER_DISPENSER_SEPARATION_READY' as status,
  to_regprocedure(
    'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'
  ) as dispensing_rpc,
  to_regprocedure(
    'public.set_clinic_product_price(uuid,numeric,text,text)'
  ) as price_rpc;
