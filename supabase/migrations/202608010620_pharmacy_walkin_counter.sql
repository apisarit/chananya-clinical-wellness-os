begin;

-- Pharmacy counter sales are separate from doctor prescriptions.
create table if not exists public.pharmacy_counter_sales (
  id uuid primary key default gen_random_uuid(),
  sale_no text not null unique,
  customer_name text,
  customer_phone text,
  patient_id uuid references public.patients(id) on delete set null,
  sale_type text not null default 'walk_in' check (sale_type in ('walk_in','refill','general_medicine')),
  presenting_symptoms text,
  allergy_notes text,
  current_medicines text,
  contraindication_notes text,
  pharmacist_assessment text,
  advice text,
  status text not null default 'draft' check (status in ('draft','reviewed','dispensed','submitted_to_billing','paid','cancelled')),
  subtotal numeric(18,2) not null default 0,
  discount_total numeric(18,2) not null default 0,
  grand_total numeric(18,2) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','pending','paid','void')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  dispensed_by uuid references auth.users(id) on delete set null,
  dispensed_at timestamptz,
  submitted_to_billing_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pharmacy_counter_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.pharmacy_counter_sales(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_requested numeric(18,4) not null check (quantity_requested > 0),
  quantity_dispensed numeric(18,4) not null default 0,
  unit text not null,
  unit_price numeric(18,2) not null default 0,
  dose text,
  frequency text,
  duration text,
  instructions text,
  warnings text,
  line_total numeric(18,2) generated always as (quantity_dispensed * unit_price) stored,
  status text not null default 'pending' check (status in ('pending','dispensed','out_of_stock','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pharmacy_counter_allocations (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.pharmacy_counter_sale_items(id) on delete cascade,
  inventory_lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  quantity_dispensed numeric(18,4) not null check (quantity_dispensed > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(sale_item_id, inventory_lot_id)
);

create index if not exists pharmacy_counter_sales_status_idx on public.pharmacy_counter_sales(status, created_at desc);
create index if not exists pharmacy_counter_items_sale_idx on public.pharmacy_counter_sale_items(sale_id);
create index if not exists pharmacy_counter_allocations_item_idx on public.pharmacy_counter_allocations(sale_item_id);

-- updated_at triggers
drop trigger if exists pharmacy_counter_sales_set_updated_at on public.pharmacy_counter_sales;
create trigger pharmacy_counter_sales_set_updated_at before update on public.pharmacy_counter_sales
for each row execute function public.set_updated_at();
drop trigger if exists pharmacy_counter_sale_items_set_updated_at on public.pharmacy_counter_sale_items;
create trigger pharmacy_counter_sale_items_set_updated_at before update on public.pharmacy_counter_sale_items
for each row execute function public.set_updated_at();

-- Atomic FEFO allocation and stock deduction.
create or replace function public.dispense_pharmacy_counter_sale(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_sale public.pharmacy_counter_sales%rowtype;
  v_item public.pharmacy_counter_sale_items%rowtype;
  v_lot record;
  v_remaining numeric(18,4);
  v_take numeric(18,4);
  v_subtotal numeric(18,2) := 0;
begin
  v_role := public.current_user_role();
  if v_role not in ('admin','pharmacy') then
    raise exception 'Not authorized for pharmacy dispensing';
  end if;

  select * into v_sale from public.pharmacy_counter_sales where id = p_sale_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'reviewed' then raise exception 'Sale must be reviewed before dispensing'; end if;

  for v_item in select * from public.pharmacy_counter_sale_items where sale_id = p_sale_id and status='pending' order by created_at loop
    v_remaining := v_item.quantity_requested;
    for v_lot in
      select id,current_quantity,expiry_date
      from public.inventory_lots
      where product_id=v_item.product_id
        and status='active'
        and current_quantity>0
        and (expiry_date is null or expiry_date>=current_date)
      order by expiry_date nulls last, received_at, id
      for update
    loop
      exit when v_remaining<=0;
      v_take := least(v_remaining,v_lot.current_quantity);
      insert into public.pharmacy_counter_allocations(sale_item_id,inventory_lot_id,quantity_dispensed,created_by)
      values(v_item.id,v_lot.id,v_take,auth.uid());
      insert into public.stock_movements(inventory_lot_id,movement_type,quantity,direction,reference_type,reference_id,reason,performed_by)
      values(v_lot.id,'pharmacy_counter_dispense',v_take,'out','pharmacy_counter_sale',p_sale_id,'Walk-in pharmacy dispensing',auth.uid());
      v_remaining := v_remaining-v_take;
    end loop;

    if v_remaining>0 then
      raise exception 'Insufficient stock for product %',v_item.product_id;
    end if;

    update public.pharmacy_counter_sale_items
      set quantity_dispensed=quantity_requested,status='dispensed'
      where id=v_item.id;
    v_subtotal := v_subtotal + (v_item.quantity_requested*v_item.unit_price);
  end loop;

  update public.pharmacy_counter_sales
    set status='dispensed',subtotal=v_subtotal,
        grand_total=greatest(0,v_subtotal-discount_total),
        dispensed_by=auth.uid(),dispensed_at=now()
    where id=p_sale_id;

  return jsonb_build_object('sale_id',p_sale_id,'status','dispensed','subtotal',v_subtotal);
end;
$$;

revoke all on function public.dispense_pharmacy_counter_sale(uuid) from public;
grant execute on function public.dispense_pharmacy_counter_sale(uuid) to authenticated;

alter table public.pharmacy_counter_sales enable row level security;
alter table public.pharmacy_counter_sale_items enable row level security;
alter table public.pharmacy_counter_allocations enable row level security;

drop policy if exists pharmacy_counter_sales_access on public.pharmacy_counter_sales;
create policy pharmacy_counter_sales_access on public.pharmacy_counter_sales for all to authenticated
using (public.has_role(array['admin','pharmacy','billing']))
with check (public.has_role(array['admin','pharmacy','billing']));
drop policy if exists pharmacy_counter_items_access on public.pharmacy_counter_sale_items;
create policy pharmacy_counter_items_access on public.pharmacy_counter_sale_items for all to authenticated
using (public.has_role(array['admin','pharmacy','billing']))
with check (public.has_role(array['admin','pharmacy','billing']));
drop policy if exists pharmacy_counter_allocations_access on public.pharmacy_counter_allocations;
create policy pharmacy_counter_allocations_access on public.pharmacy_counter_allocations for select to authenticated
using (public.has_role(array['admin','pharmacy','inventory','billing']));

grant select,insert,update,delete on public.pharmacy_counter_sales,public.pharmacy_counter_sale_items to authenticated;
grant select on public.pharmacy_counter_allocations to authenticated;

commit;
select 'CHANANYA_PHARMACY_WALKIN_COUNTER_READY' as status;
