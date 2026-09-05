begin;

-- ============================================================
-- CHANANYA DEPARTMENT BOUNDARIES + AUDITED DOMAIN PERSISTENCE
--
-- One authenticated account has one active clinic department. Governance
-- admin does not inherit Clinical, Pharmacy, Production or Billing access.
-- Only system_role=super_admin receives the cross-workspace override, and
-- that override remains bound to the user's active clinic tenant.
-- ============================================================

-- Keep the legacy profile mirror compatible with the canonical membership
-- role. Earlier constraints predated the `doctor` department.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'admin','practitioner','doctor','reception','pharmacy',
    'production','inventory','billing','viewer'
  ));

-- Resolve only an active tenant. The earlier compatibility function looked
-- at memberships alone, which could keep an inactive clinic selected after a
-- clinic was suspended.
create or replace function public.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.clinic_id
  from public.clinic_memberships m
  join public.clinics c on c.id = m.clinic_id and c.active
  where m.profile_id = auth.uid()
    and m.active
  order by m.is_primary desc, m.joined_at
  limit 1;
$$;

-- Membership alone is not enough: all legacy tenant policies must resolve to
-- the same single active clinic selected above. This prevents a second stale
-- membership from widening PHI access without an explicit tenant switch.
create or replace function public.is_clinic_member(
  p_clinic_id uuid,
  p_allowed_roles text[] default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_clinic_id = public.current_clinic_id()
    and exists (
      select 1
      from public.clinic_memberships m
      join public.clinics c on c.id = m.clinic_id and c.active
      where m.clinic_id = p_clinic_id
        and m.profile_id = auth.uid()
        and m.active
        and (p_allowed_roles is null or m.clinic_role = any(p_allowed_roles))
    );
$$;

create or replace function public.current_department_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.clinic_role
    from public.clinic_memberships m
    join public.clinics c on c.id = m.clinic_id and c.active
    where m.profile_id = auth.uid()
      and m.active
    order by m.is_primary desc, m.joined_at
    limit 1
  ), 'viewer');
$$;

-- Legacy policies call current_user_role(). Return a governance-only marker
-- for old `admin` records so old policies containing `admin` cannot silently
-- grant operational access after this migration.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p.system_role, 'staff') = 'super_admin' then 'super_admin'
    when coalesce(p.system_role, 'staff') = 'admin'
      or public.current_department_role() in ('owner','admin')
      then 'governance_admin'
    else public.current_department_role()
  end
  from public.profiles p
  where p.id = auth.uid();
$$;

create or replace function public.has_role(allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or public.current_user_role() = any(allowed)
      -- `doctor` was added after the original clinical policies. Treat it as
      -- a practitioner only for legacy policy arrays while preserving the
      -- canonical doctor role in the access context and audit records.
      or (
        public.current_department_role() = 'doctor'
        and 'practitioner' = any(allowed)
      );
$$;

create or replace function public.department_can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then false
    when public.is_super_admin() then true
    when p_capability = 'governance' then
      exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.system_role = 'admin'
      ) or public.current_department_role() in ('owner','admin')
    when p_capability = 'patient_read' then
      public.current_department_role() in ('practitioner','doctor','reception','pharmacy','billing')
    when p_capability = 'patient_registry' then
      public.current_department_role() in ('practitioner','doctor','reception')
    when p_capability = 'clinical' then
      public.current_department_role() in ('practitioner','doctor')
    when p_capability = 'pharmacy' then
      public.current_department_role() = 'pharmacy'
    when p_capability = 'product_read' then
      public.current_department_role() in ('practitioner','doctor','pharmacy','production','inventory')
    when p_capability = 'product_write' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'inventory' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'production' then
      public.current_department_role() in ('production','inventory')
    when p_capability = 'billing' then
      public.current_department_role() = 'billing'
    else false
  end;
$$;

create or replace function public.current_access_context()
returns table (
  clinic_id uuid,
  clinic_code text,
  clinic_name text,
  clinic_role text,
  system_role text,
  effective_role text,
  ready boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.code,
    c.name_th,
    m.clinic_role,
    p.system_role,
    case
      when p.system_role = 'super_admin' then 'super_admin'
      when p.system_role = 'admin' or m.clinic_role in ('owner','admin') then 'admin'
      else m.clinic_role
    end,
    true
  from public.profiles p
  join public.clinic_memberships m
    on m.profile_id = p.id and m.active
  join public.clinics c
    on c.id = m.clinic_id and c.active
  where p.id = auth.uid()
  order by m.is_primary desc, m.joined_at
  limit 1;
$$;

revoke all on function public.current_clinic_id() from public;
revoke all on function public.is_clinic_member(uuid,text[]) from public;
revoke all on function public.current_department_role() from public;
revoke all on function public.current_user_role() from public;
revoke all on function public.has_role(text[]) from public;
revoke all on function public.department_can(text) from public;
revoke all on function public.current_access_context() from public;
grant execute on function public.current_clinic_id() to authenticated, service_role;
grant execute on function public.is_clinic_member(uuid,text[]) to authenticated, service_role;
grant execute on function public.current_department_role() to authenticated, service_role;
grant execute on function public.current_user_role() to authenticated, service_role;
grant execute on function public.has_role(text[]) to authenticated, service_role;
grant execute on function public.department_can(text) to authenticated, service_role;
grant execute on function public.current_access_context() to authenticated;

-- Keep the legacy Admin screen compatible, but make the clinic membership the
-- authorization source of truth. A governance admin may assign one department
-- inside the active clinic; only a super admin may modify another system admin.
create or replace function public.admin_assign_staff_role(
  p_user_id uuid,
  p_role text,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_old_role text;
  v_old_system_role text;
  v_old_clinic_role text;
begin
  if v_clinic_id is null or not public.department_can('governance') then
    raise exception 'GOVERNANCE_DEPARTMENT_REQUIRED';
  end if;
  if p_role not in (
    'practitioner','doctor','reception','pharmacy','production',
    'inventory','billing','viewer'
  ) then
    raise exception 'STAFF_DEPARTMENT_ROLE_INVALID';
  end if;
  select p.role, p.system_role into v_old_role, v_old_system_role
  from public.profiles p where p.id = p_user_id for update;
  if not found then raise exception 'USER_PROFILE_NOT_FOUND'; end if;
  if v_old_system_role = 'super_admin' then
    raise exception 'SUPER_ADMIN_ROLE_PROTECTED';
  end if;
  if v_old_system_role = 'admin' and not public.is_super_admin() then
    raise exception 'SYSTEM_ADMIN_ROLE_PROTECTED';
  end if;
  if p_user_id = auth.uid() and not public.is_super_admin() then
    raise exception 'SELF_ROLE_CHANGE_NOT_ALLOWED';
  end if;

  select m.clinic_role into v_old_clinic_role
  from public.clinic_memberships m
  where m.clinic_id = v_clinic_id and m.profile_id = p_user_id
  for update;

  insert into public.clinic_memberships (
    clinic_id, profile_id, clinic_role, is_primary, active, updated_at
  ) values (
    v_clinic_id, p_user_id, p_role,
    not exists (
      select 1 from public.clinic_memberships x
      where x.profile_id = p_user_id and x.active and x.is_primary
    ),
    true, now()
  )
  on conflict (clinic_id, profile_id) do update
  set clinic_role = excluded.clinic_role,
      active = true,
      updated_at = now();

  update public.profiles
  set role = p_role,
      system_role = case when v_old_system_role = 'admin' then 'staff' else system_role end,
      updated_at = now()
  where id = p_user_id;

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id, auth.uid(), 'assign_department_role',
    'clinic_memberships', p_user_id::text,
    jsonb_build_object(
      'old_profile_role', v_old_role,
      'old_clinic_role', v_old_clinic_role,
      'new_clinic_role', p_role,
      'reason', nullif(btrim(p_reason), '')
    )
  );
end;
$$;

revoke all on function public.admin_assign_staff_role(uuid,text,text) from public;
grant execute on function public.admin_assign_staff_role(uuid,text,text) to authenticated;

-- ============================================================
-- TENANT KEYS FOR PRODUCT / STOCK / PHARMACY DOMAINS
-- ============================================================

alter table public.products add column if not exists clinic_id uuid;
alter table public.products add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.products add column if not exists updated_by uuid references auth.users(id) on delete set null;
alter table public.products add column if not exists deactivated_at timestamptz;
alter table public.products add column if not exists deactivated_by uuid references auth.users(id) on delete set null;

update public.products
set clinic_id = '00000000-0000-0000-0000-000000000001'
where clinic_id is null;
alter table public.products alter column clinic_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_clinic_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
end $$;

alter table public.products drop constraint if exists products_sku_key;
drop index if exists public.products_sku_key;
create unique index if not exists products_clinic_sku_uidx
  on public.products(clinic_id, sku);
create unique index if not exists products_id_clinic_uidx
  on public.products(id, clinic_id);

alter table public.inventory_lots add column if not exists clinic_id uuid;
update public.inventory_lots l
set clinic_id = p.clinic_id
from public.products p
where p.id = l.product_id and l.clinic_id is null;
alter table public.inventory_lots alter column clinic_id set not null;
create index if not exists inventory_lots_clinic_product_idx
  on public.inventory_lots(clinic_id, product_id, expiry_date);

alter table public.stock_movements add column if not exists clinic_id uuid;
update public.stock_movements s
set clinic_id = l.clinic_id
from public.inventory_lots l
where l.id = s.inventory_lot_id and s.clinic_id is null;
alter table public.stock_movements alter column clinic_id set not null;
create index if not exists stock_movements_clinic_occurred_idx
  on public.stock_movements(clinic_id, occurred_at desc);

alter table public.pharmacy_counter_sales add column if not exists clinic_id uuid;
update public.pharmacy_counter_sales s
set clinic_id = p.clinic_id
from public.patients p
where p.id = s.patient_id
  and s.clinic_id is null;
update public.pharmacy_counter_sales
set clinic_id = '00000000-0000-0000-0000-000000000001'::uuid
where clinic_id is null;
alter table public.pharmacy_counter_sales alter column clinic_id set not null;
alter table public.pharmacy_counter_sales drop constraint if exists pharmacy_counter_sales_sale_no_key;
drop index if exists public.pharmacy_counter_sales_sale_no_key;
create unique index if not exists pharmacy_counter_sales_clinic_no_uidx
  on public.pharmacy_counter_sales(clinic_id, sale_no);
create unique index if not exists pharmacy_counter_sales_id_clinic_uidx
  on public.pharmacy_counter_sales(id, clinic_id);

alter table public.pharmacy_counter_sale_items add column if not exists clinic_id uuid;
update public.pharmacy_counter_sale_items i
set clinic_id = s.clinic_id
from public.pharmacy_counter_sales s
where s.id = i.sale_id and i.clinic_id is null;
alter table public.pharmacy_counter_sale_items alter column clinic_id set not null;
create index if not exists pharmacy_counter_items_clinic_sale_idx
  on public.pharmacy_counter_sale_items(clinic_id, sale_id);

alter table public.pharmacy_counter_allocations add column if not exists clinic_id uuid;
update public.pharmacy_counter_allocations a
set clinic_id = i.clinic_id
from public.pharmacy_counter_sale_items i
where i.id = a.sale_item_id and a.clinic_id is null;
alter table public.pharmacy_counter_allocations alter column clinic_id set not null;
create index if not exists pharmacy_counter_allocations_clinic_item_idx
  on public.pharmacy_counter_allocations(clinic_id, sale_item_id);

-- Composite tenant foreign keys prevent a row from pointing at an object in a
-- different clinic even when a privileged function or service makes a mistake.
create unique index if not exists inventory_lots_id_clinic_uidx
  on public.inventory_lots(id, clinic_id);
create unique index if not exists pharmacy_counter_items_id_clinic_uidx
  on public.pharmacy_counter_sale_items(id, clinic_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_lots_product_clinic_fkey') then
    alter table public.inventory_lots
      add constraint inventory_lots_product_clinic_fkey
      foreign key (product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_lot_clinic_fkey') then
    alter table public.stock_movements
      add constraint stock_movements_lot_clinic_fkey
      foreign key (inventory_lot_id, clinic_id)
      references public.inventory_lots(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pharmacy_counter_sales_clinic_id_fkey') then
    alter table public.pharmacy_counter_sales
      add constraint pharmacy_counter_sales_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pharmacy_counter_items_sale_clinic_fkey') then
    alter table public.pharmacy_counter_sale_items
      add constraint pharmacy_counter_items_sale_clinic_fkey
      foreign key (sale_id, clinic_id)
      references public.pharmacy_counter_sales(id, clinic_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pharmacy_counter_items_product_clinic_fkey') then
    alter table public.pharmacy_counter_sale_items
      add constraint pharmacy_counter_items_product_clinic_fkey
      foreign key (product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pharmacy_counter_allocations_item_clinic_fkey') then
    alter table public.pharmacy_counter_allocations
      add constraint pharmacy_counter_allocations_item_clinic_fkey
      foreign key (sale_item_id, clinic_id)
      references public.pharmacy_counter_sale_items(id, clinic_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pharmacy_counter_allocations_lot_clinic_fkey') then
    alter table public.pharmacy_counter_allocations
      add constraint pharmacy_counter_allocations_lot_clinic_fkey
      foreign key (inventory_lot_id, clinic_id)
      references public.inventory_lots(id, clinic_id) on delete restrict;
  end if;
end $$;

-- ============================================================
-- SERVER-ASSIGNED TENANT / DOMAIN WRITE GUARDS
-- ============================================================

create or replace function public.assign_product_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
begin
  if auth.role() = 'service_role' then
    new.clinic_id := coalesce(new.clinic_id, v_clinic_id, '00000000-0000-0000-0000-000000000001'::uuid);
    return new;
  end if;
  if v_clinic_id is null or not public.department_can('product_write') then
    raise exception 'PRODUCT_DEPARTMENT_REQUIRED';
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'PRODUCT_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.assign_inventory_lot_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select p.clinic_id into v_clinic_id
  from public.products p where p.id = new.product_id;
  if v_clinic_id is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' then
    if not public.department_can('inventory') then raise exception 'INVENTORY_DEPARTMENT_REQUIRED'; end if;
    if v_clinic_id <> public.current_clinic_id() then raise exception 'INVENTORY_TENANT_MISMATCH'; end if;
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'INVENTORY_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.assign_stock_movement_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select l.clinic_id into v_clinic_id
  from public.inventory_lots l where l.id = new.inventory_lot_id;
  if v_clinic_id is null then raise exception 'INVENTORY_LOT_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' then
    if not public.department_can('inventory') then raise exception 'INVENTORY_DEPARTMENT_REQUIRED'; end if;
    if v_clinic_id <> public.current_clinic_id() then raise exception 'INVENTORY_TENANT_MISMATCH'; end if;
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'INVENTORY_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.assign_pharmacy_sale_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_patient_clinic uuid;
begin
  if auth.role() <> 'service_role' and not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  if v_clinic_id is null then
    v_clinic_id := coalesce(new.clinic_id, '00000000-0000-0000-0000-000000000001'::uuid);
  end if;
  if new.patient_id is not null then
    select p.clinic_id into v_patient_clinic from public.patients p where p.id = new.patient_id;
    if v_patient_clinic is null then raise exception 'PATIENT_NOT_FOUND'; end if;
    if v_patient_clinic <> v_clinic_id then raise exception 'PHARMACY_PATIENT_TENANT_MISMATCH'; end if;
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'PHARMACY_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.assign_pharmacy_item_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_clinic uuid;
  v_product_clinic uuid;
begin
  select s.clinic_id into v_sale_clinic from public.pharmacy_counter_sales s where s.id = new.sale_id;
  select p.clinic_id into v_product_clinic from public.products p where p.id = new.product_id;
  if v_sale_clinic is null then raise exception 'PHARMACY_SALE_NOT_FOUND'; end if;
  if v_product_clinic is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if v_sale_clinic <> v_product_clinic then raise exception 'PHARMACY_ITEM_TENANT_MISMATCH'; end if;
  if auth.role() <> 'service_role' then
    if not public.department_can('pharmacy') then raise exception 'PHARMACY_DEPARTMENT_REQUIRED'; end if;
    if v_sale_clinic <> public.current_clinic_id() then raise exception 'PHARMACY_TENANT_MISMATCH'; end if;
  end if;
  new.clinic_id := v_sale_clinic;
  return new;
end;
$$;

create or replace function public.assign_pharmacy_allocation_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_clinic uuid;
  v_lot_clinic uuid;
begin
  select i.clinic_id into v_item_clinic from public.pharmacy_counter_sale_items i where i.id = new.sale_item_id;
  select l.clinic_id into v_lot_clinic from public.inventory_lots l where l.id = new.inventory_lot_id;
  if v_item_clinic is null or v_lot_clinic is null or v_item_clinic <> v_lot_clinic then
    raise exception 'PHARMACY_ALLOCATION_TENANT_MISMATCH';
  end if;
  if auth.role() <> 'service_role' and not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  new.clinic_id := v_item_clinic;
  return new;
end;
$$;

create or replace function public.enforce_patient_registry_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.department_can('patient_registry') then
    raise exception 'PATIENT_REGISTRY_DEPARTMENT_REQUIRED';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_product_clinic on public.products;
create trigger trg_assign_product_clinic
before insert or update of clinic_id, sku on public.products
for each row execute function public.assign_product_clinic();

drop trigger if exists trg_assign_inventory_lot_clinic on public.inventory_lots;
create trigger trg_assign_inventory_lot_clinic
before insert or update of clinic_id, product_id on public.inventory_lots
for each row execute function public.assign_inventory_lot_clinic();

drop trigger if exists trg_assign_stock_movement_clinic on public.stock_movements;
create trigger trg_assign_stock_movement_clinic
before insert or update of clinic_id, inventory_lot_id on public.stock_movements
for each row execute function public.assign_stock_movement_clinic();

drop trigger if exists trg_assign_pharmacy_sale_clinic on public.pharmacy_counter_sales;
create trigger trg_assign_pharmacy_sale_clinic
before insert or update of clinic_id, patient_id on public.pharmacy_counter_sales
for each row execute function public.assign_pharmacy_sale_clinic();

drop trigger if exists trg_assign_pharmacy_item_clinic on public.pharmacy_counter_sale_items;
create trigger trg_assign_pharmacy_item_clinic
before insert or update of clinic_id, sale_id, product_id on public.pharmacy_counter_sale_items
for each row execute function public.assign_pharmacy_item_clinic();

drop trigger if exists trg_assign_pharmacy_allocation_clinic on public.pharmacy_counter_allocations;
create trigger trg_assign_pharmacy_allocation_clinic
before insert or update of clinic_id, sale_item_id, inventory_lot_id on public.pharmacy_counter_allocations
for each row execute function public.assign_pharmacy_allocation_clinic();

drop trigger if exists trg_enforce_patient_registry_write on public.patients;
create trigger trg_enforce_patient_registry_write
before insert or update or delete on public.patients
for each row execute function public.enforce_patient_registry_write();

drop trigger if exists trg_enforce_patient_allergy_write on public.patient_allergies;
create trigger trg_enforce_patient_allergy_write
before insert or update or delete on public.patient_allergies
for each row execute function public.enforce_patient_registry_write();

-- ============================================================
-- RESTRICTIVE RLS: OLD PERMISSIVE POLICIES CANNOT WIDEN THESE
-- ============================================================

alter table public.products enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.stock_movements enable row level security;
alter table public.pharmacy_counter_sales enable row level security;
alter table public.pharmacy_counter_sale_items enable row level security;
alter table public.pharmacy_counter_allocations enable row level security;

drop policy if exists products_department_boundary on public.products;
create policy products_department_boundary
on public.products as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and public.department_can('product_read')
)
with check (
  clinic_id = public.current_clinic_id()
  and public.department_can('product_write')
);

drop policy if exists inventory_lots_department_boundary on public.inventory_lots;
create policy inventory_lots_department_boundary
on public.inventory_lots as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('inventory'))
with check (clinic_id = public.current_clinic_id() and public.department_can('inventory'));

drop policy if exists stock_movements_department_boundary on public.stock_movements;
create policy stock_movements_department_boundary
on public.stock_movements as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('inventory'))
with check (clinic_id = public.current_clinic_id() and public.department_can('inventory'));

drop policy if exists pharmacy_sales_department_boundary on public.pharmacy_counter_sales;
create policy pharmacy_sales_department_boundary
on public.pharmacy_counter_sales as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (public.department_can('pharmacy') or public.department_can('billing'))
)
with check (clinic_id = public.current_clinic_id() and public.department_can('pharmacy'));

drop policy if exists pharmacy_items_department_boundary on public.pharmacy_counter_sale_items;
create policy pharmacy_items_department_boundary
on public.pharmacy_counter_sale_items as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (public.department_can('pharmacy') or public.department_can('billing'))
)
with check (clinic_id = public.current_clinic_id() and public.department_can('pharmacy'));

drop policy if exists pharmacy_allocations_department_boundary on public.pharmacy_counter_allocations;
create policy pharmacy_allocations_department_boundary
on public.pharmacy_counter_allocations as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (public.department_can('pharmacy') or public.department_can('billing'))
)
with check (clinic_id = public.current_clinic_id() and public.department_can('pharmacy'));

drop policy if exists patients_department_boundary on public.patients;
create policy patients_department_boundary
on public.patients as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('patient_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('patient_registry'));

drop policy if exists patient_allergies_department_boundary on public.patient_allergies;
create policy patient_allergies_department_boundary
on public.patient_allergies as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('patient_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('patient_registry'));

-- ============================================================
-- AUDITED PRODUCT MASTER RPCS
-- ============================================================

create or replace function public.upsert_product_master(
  p_product_id uuid,
  p_sku text,
  p_name_th text,
  p_name_en text,
  p_category text,
  p_dosage_form text,
  p_purchase_unit text,
  p_stock_unit text,
  p_dispense_unit text,
  p_conversion_factor numeric,
  p_standard_cost numeric,
  p_min_stock numeric,
  p_reorder_level numeric
)
returns public.products
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_product public.products%rowtype;
  v_action text;
begin
  if v_clinic_id is null or not public.department_can('product_write') then
    raise exception 'PRODUCT_DEPARTMENT_REQUIRED';
  end if;
  if nullif(btrim(p_sku), '') is null
     or nullif(btrim(p_name_th), '') is null
     or nullif(btrim(p_category), '') is null
     or nullif(btrim(p_stock_unit), '') is null
     or nullif(btrim(p_dispense_unit), '') is null then
    raise exception 'PRODUCT_REQUIRED_FIELD_MISSING';
  end if;
  if coalesce(p_conversion_factor, 0) <= 0
     or coalesce(p_standard_cost, 0) < 0
     or coalesce(p_min_stock, 0) < 0
     or coalesce(p_reorder_level, 0) < 0 then
    raise exception 'PRODUCT_NUMERIC_VALUE_INVALID';
  end if;

  if p_product_id is null then
    v_action := 'create_product_master';
    insert into public.products (
      clinic_id, sku, name_th, name_en, category, dosage_form,
      purchase_unit, stock_unit, dispense_unit, conversion_factor,
      standard_cost, min_stock, reorder_level, active, created_by, updated_by
    ) values (
      v_clinic_id, upper(btrim(p_sku)), btrim(p_name_th), nullif(btrim(p_name_en), ''),
      lower(btrim(p_category)), nullif(btrim(p_dosage_form), ''),
      nullif(btrim(p_purchase_unit), ''), btrim(p_stock_unit), btrim(p_dispense_unit),
      p_conversion_factor, p_standard_cost, p_min_stock, p_reorder_level,
      true, auth.uid(), auth.uid()
    ) returning * into v_product;
  else
    v_action := 'update_product_master';
    select * into v_product
    from public.products p
    where p.id = p_product_id and p.clinic_id = v_clinic_id
    for update;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    update public.products
    set sku = upper(btrim(p_sku)),
        name_th = btrim(p_name_th),
        name_en = nullif(btrim(p_name_en), ''),
        category = lower(btrim(p_category)),
        dosage_form = nullif(btrim(p_dosage_form), ''),
        purchase_unit = nullif(btrim(p_purchase_unit), ''),
        stock_unit = btrim(p_stock_unit),
        dispense_unit = btrim(p_dispense_unit),
        conversion_factor = p_conversion_factor,
        standard_cost = p_standard_cost,
        min_stock = p_min_stock,
        reorder_level = p_reorder_level,
        updated_by = auth.uid(),
        updated_at = now()
    where id = p_product_id
    returning * into v_product;
  end if;

  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(), v_action, 'products', v_product.id::text,
    jsonb_build_object('sku', v_product.sku, 'category', v_product.category)
  );
  return v_product;
end;
$$;

create or replace function public.set_product_master_active(
  p_product_id uuid,
  p_active boolean,
  p_reason text default null
)
returns public.products
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_product public.products%rowtype;
begin
  if v_clinic_id is null or not public.department_can('product_write') then
    raise exception 'PRODUCT_DEPARTMENT_REQUIRED';
  end if;
  select * into v_product
  from public.products p
  where p.id = p_product_id and p.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  update public.products
  set active = p_active,
      deactivated_at = case when p_active then null else now() end,
      deactivated_by = case when p_active then null else auth.uid() end,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_product_id
  returning * into v_product;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(),
    case when p_active then 'activate_product_master' else 'deactivate_product_master' end,
    'products', v_product.id::text,
    jsonb_build_object('sku', v_product.sku, 'reason', nullif(btrim(p_reason), ''))
  );
  return v_product;
end;
$$;

-- ============================================================
-- AUDITED PHARMACY COUNTER RPCS
-- ============================================================

create or replace function public.create_pharmacy_counter_sale(
  p_patient_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_presenting_symptoms text,
  p_allergy_notes text,
  p_current_medicines text,
  p_contraindication_notes text,
  p_pharmacist_assessment text,
  p_advice text
)
returns public.pharmacy_counter_sales
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_sale public.pharmacy_counter_sales%rowtype;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  if nullif(btrim(p_presenting_symptoms), '') is null
     or nullif(btrim(p_pharmacist_assessment), '') is null then
    raise exception 'PHARMACY_ASSESSMENT_REQUIRED';
  end if;
  if p_patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = p_patient_id and p.clinic_id = v_clinic_id and p.active
  ) then
    raise exception 'PATIENT_NOT_FOUND';
  end if;
  select coalesce(nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''), 'CLN')
  into v_clinic_code from public.clinics c where c.id = v_clinic_id;
  insert into public.pharmacy_counter_sales (
    clinic_id, sale_no, customer_name, customer_phone, patient_id,
    presenting_symptoms, allergy_notes, current_medicines,
    contraindication_notes, pharmacist_assessment, advice, created_by
  ) values (
    v_clinic_id,
    'PS-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'pharmacy_sale')::text, 8, '0'),
    nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), p_patient_id,
    btrim(p_presenting_symptoms), nullif(btrim(p_allergy_notes), ''),
    nullif(btrim(p_current_medicines), ''), nullif(btrim(p_contraindication_notes), ''),
    btrim(p_pharmacist_assessment), nullif(btrim(p_advice), ''), auth.uid()
  ) returning * into v_sale;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(), 'create_pharmacy_counter_sale',
    'pharmacy_counter_sales', v_sale.id::text,
    jsonb_build_object('sale_no', v_sale.sale_no, 'patient_id', v_sale.patient_id)
  );
  return v_sale;
end;
$$;

create or replace function public.upsert_pharmacy_counter_sale_item(
  p_sale_item_id uuid,
  p_sale_id uuid,
  p_product_id uuid,
  p_quantity_requested numeric,
  p_unit_price numeric,
  p_dose text,
  p_frequency text,
  p_duration text,
  p_instructions text
)
returns public.pharmacy_counter_sale_items
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_sale public.pharmacy_counter_sales%rowtype;
  v_product public.products%rowtype;
  v_item public.pharmacy_counter_sale_items%rowtype;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  if coalesce(p_quantity_requested, 0) <= 0 or coalesce(p_unit_price, 0) < 0 then
    raise exception 'PHARMACY_ITEM_VALUE_INVALID';
  end if;
  select * into v_sale from public.pharmacy_counter_sales s
  where s.id = p_sale_id and s.clinic_id = v_clinic_id for update;
  if not found then raise exception 'PHARMACY_SALE_NOT_FOUND'; end if;
  if v_sale.status <> 'draft' then raise exception 'PHARMACY_SALE_NOT_DRAFT'; end if;
  select * into v_product from public.products p
  where p.id = p_product_id and p.clinic_id = v_clinic_id and p.active;
  if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;

  if p_sale_item_id is null then
    insert into public.pharmacy_counter_sale_items (
      clinic_id, sale_id, product_id, quantity_requested, unit, unit_price,
      dose, frequency, duration, instructions
    ) values (
      v_clinic_id, p_sale_id, p_product_id, p_quantity_requested,
      v_product.dispense_unit, p_unit_price, nullif(btrim(p_dose), ''),
      nullif(btrim(p_frequency), ''), nullif(btrim(p_duration), ''),
      nullif(btrim(p_instructions), '')
    ) returning * into v_item;
  else
    select * into v_item from public.pharmacy_counter_sale_items i
    where i.id = p_sale_item_id and i.sale_id = p_sale_id and i.clinic_id = v_clinic_id
    for update;
    if not found then raise exception 'PHARMACY_SALE_ITEM_NOT_FOUND'; end if;
    update public.pharmacy_counter_sale_items
    set product_id = p_product_id,
        quantity_requested = p_quantity_requested,
        unit = v_product.dispense_unit,
        unit_price = p_unit_price,
        dose = nullif(btrim(p_dose), ''),
        frequency = nullif(btrim(p_frequency), ''),
        duration = nullif(btrim(p_duration), ''),
        instructions = nullif(btrim(p_instructions), ''),
        updated_at = now()
    where id = p_sale_item_id
    returning * into v_item;
  end if;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(),
    case when p_sale_item_id is null then 'add_pharmacy_counter_item' else 'update_pharmacy_counter_item' end,
    'pharmacy_counter_sale_items', v_item.id::text,
    jsonb_build_object('sale_id', p_sale_id, 'product_id', p_product_id, 'quantity', p_quantity_requested)
  );
  return v_item;
end;
$$;

create or replace function public.remove_pharmacy_counter_sale_item(p_sale_item_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_item public.pharmacy_counter_sale_items%rowtype;
  v_status text;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  select s.status into v_status
  from public.pharmacy_counter_sales s
  join public.pharmacy_counter_sale_items i
    on i.sale_id = s.id and i.clinic_id = s.clinic_id
  where i.id = p_sale_item_id and i.clinic_id = v_clinic_id
  for update of s;
  if not found then raise exception 'PHARMACY_SALE_ITEM_NOT_FOUND'; end if;
  if v_status <> 'draft' then raise exception 'PHARMACY_SALE_NOT_DRAFT'; end if;
  select * into v_item
  from public.pharmacy_counter_sale_items i
  where i.id = p_sale_item_id and i.clinic_id = v_clinic_id
  for update;
  delete from public.pharmacy_counter_sale_items where id = p_sale_item_id;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(), 'remove_pharmacy_counter_item',
    'pharmacy_counter_sale_items', p_sale_item_id::text,
    jsonb_build_object('sale_id', v_item.sale_id, 'product_id', v_item.product_id)
  );
  return true;
end;
$$;

create or replace function public.transition_pharmacy_counter_sale(
  p_sale_id uuid,
  p_action text,
  p_reason text default null
)
returns public.pharmacy_counter_sales
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_sale public.pharmacy_counter_sales%rowtype;
  v_next text;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  select * into v_sale from public.pharmacy_counter_sales s
  where s.id = p_sale_id and s.clinic_id = v_clinic_id for update;
  if not found then raise exception 'PHARMACY_SALE_NOT_FOUND'; end if;
  v_next := case
    when p_action = 'review' and v_sale.status = 'draft' then 'reviewed'
    when p_action = 'submit_billing' and v_sale.status = 'dispensed' then 'submitted_to_billing'
    when p_action = 'cancel' and v_sale.status in ('draft','reviewed') then 'cancelled'
    else null
  end;
  if v_next is null then raise exception 'PHARMACY_STATUS_TRANSITION_INVALID'; end if;
  if p_action = 'review' and not exists (
    select 1 from public.pharmacy_counter_sale_items i
    where i.sale_id = p_sale_id and i.clinic_id = v_clinic_id
  ) then
    raise exception 'PHARMACY_SALE_ITEM_REQUIRED';
  end if;
  update public.pharmacy_counter_sales
  set status = v_next,
      reviewed_by = case when p_action = 'review' then auth.uid() else reviewed_by end,
      reviewed_at = case when p_action = 'review' then now() else reviewed_at end,
      submitted_to_billing_at = case when p_action = 'submit_billing' then now() else submitted_to_billing_at end,
      updated_at = now()
  where id = p_sale_id
  returning * into v_sale;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(), 'transition_pharmacy_counter_sale',
    'pharmacy_counter_sales', p_sale_id::text,
    jsonb_build_object('action', p_action, 'status', v_next, 'reason', nullif(btrim(p_reason), ''))
  );
  return v_sale;
end;
$$;

-- Replace the legacy FEFO function with tenant, role, row-lock and audit
-- enforcement. Stock mutation, allocation and sale state remain atomic.
create or replace function public.dispense_pharmacy_counter_sale(p_sale_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_sale public.pharmacy_counter_sales%rowtype;
  v_item public.pharmacy_counter_sale_items%rowtype;
  v_lot record;
  v_remaining numeric(18,4);
  v_take numeric(18,4);
  v_subtotal numeric(18,2) := 0;
  v_item_count integer := 0;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  select * into v_sale from public.pharmacy_counter_sales s
  where s.id = p_sale_id and s.clinic_id = v_clinic_id for update;
  if not found then raise exception 'PHARMACY_SALE_NOT_FOUND'; end if;
  if v_sale.status <> 'reviewed' then raise exception 'PHARMACY_SALE_NOT_REVIEWED'; end if;

  for v_item in
    select * from public.pharmacy_counter_sale_items i
    where i.sale_id = p_sale_id and i.clinic_id = v_clinic_id and i.status = 'pending'
    order by i.created_at, i.id
    for update
  loop
    v_item_count := v_item_count + 1;
    v_remaining := v_item.quantity_requested;
    for v_lot in
      select l.id, l.current_quantity, l.expiry_date
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
      insert into public.pharmacy_counter_allocations (
        clinic_id, sale_item_id, inventory_lot_id, quantity_dispensed, created_by
      ) values (
        v_clinic_id, v_item.id, v_lot.id, v_take, auth.uid()
      );
      insert into public.stock_movements (
        clinic_id, inventory_lot_id, movement_type, quantity, direction,
        reference_type, reference_id, reason, performed_by
      ) values (
        v_clinic_id, v_lot.id, 'pharmacy_counter_dispense', v_take, 'out',
        'pharmacy_counter_sale', p_sale_id, 'Walk-in pharmacy FEFO dispensing', auth.uid()
      );
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining > 0 then raise exception 'PHARMACY_STOCK_INSUFFICIENT'; end if;
    update public.pharmacy_counter_sale_items
    set quantity_dispensed = quantity_requested, status = 'dispensed', updated_at = now()
    where id = v_item.id;
    v_subtotal := v_subtotal + (v_item.quantity_requested * v_item.unit_price);
  end loop;
  if v_item_count = 0 then raise exception 'PHARMACY_PENDING_ITEM_REQUIRED'; end if;

  update public.pharmacy_counter_sales
  set status = 'dispensed', subtotal = v_subtotal,
      grand_total = greatest(0, v_subtotal - discount_total),
      dispensed_by = auth.uid(), dispensed_at = now(), updated_at = now()
  where id = p_sale_id
  returning * into v_sale;
  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id, auth.uid(), 'dispense_pharmacy_counter_sale',
    'pharmacy_counter_sales', p_sale_id::text,
    jsonb_build_object('sale_no', v_sale.sale_no, 'items', v_item_count, 'subtotal', v_subtotal, 'allocation', 'FEFO')
  );
  return jsonb_build_object(
    'sale_id', p_sale_id, 'sale_no', v_sale.sale_no,
    'status', v_sale.status, 'subtotal', v_subtotal
  );
end;
$$;

-- Browser users can read rows permitted by RLS, but every product/pharmacy
-- mutation must cross the controlled functions above.
revoke insert, update, delete on public.products from authenticated;
revoke insert, update, delete on public.pharmacy_counter_sales from authenticated;
revoke insert, update, delete on public.pharmacy_counter_sale_items from authenticated;
revoke insert, update, delete on public.pharmacy_counter_allocations from authenticated;
grant select on public.products, public.pharmacy_counter_sales,
  public.pharmacy_counter_sale_items, public.pharmacy_counter_allocations
  to authenticated;

revoke all on function public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric) from public;
revoke all on function public.set_product_master_active(uuid,boolean,text) from public;
revoke all on function public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text) from public;
revoke all on function public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text) from public;
revoke all on function public.remove_pharmacy_counter_sale_item(uuid) from public;
revoke all on function public.transition_pharmacy_counter_sale(uuid,text,text) from public;
revoke all on function public.dispense_pharmacy_counter_sale(uuid) from public;
grant execute on function public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric) to authenticated, service_role;
grant execute on function public.set_product_master_active(uuid,boolean,text) to authenticated, service_role;
grant execute on function public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text) to authenticated, service_role;
grant execute on function public.remove_pharmacy_counter_sale_item(uuid) to authenticated, service_role;
grant execute on function public.transition_pharmacy_counter_sale(uuid,text,text) to authenticated, service_role;
grant execute on function public.dispense_pharmacy_counter_sale(uuid) to authenticated, service_role;

-- ============================================================
-- ENCRYPTED GOOGLE DRIVE EXPORT SOURCE + NON-PHI AUDIT MANIFEST
-- ============================================================

create table if not exists public.backup_export_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  destination text not null default 'google_drive',
  scheduled_for timestamptz,
  status text not null check (status in ('started','completed','partial','failed')),
  domain_counts jsonb not null default '{}'::jsonb,
  object_manifest jsonb not null default '[]'::jsonb,
  request_id text,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists backup_export_runs_clinic_idx
  on public.backup_export_runs(clinic_id, started_at desc);
create unique index if not exists backup_export_runs_clinic_slot_uidx
  on public.backup_export_runs(clinic_id, scheduled_for)
  where scheduled_for is not null;
alter table public.backup_export_runs enable row level security;
drop policy if exists backup_export_runs_super_admin_read on public.backup_export_runs;
create policy backup_export_runs_super_admin_read
on public.backup_export_runs for select to authenticated
using (
  public.is_super_admin()
  and clinic_id = public.current_clinic_id()
);
revoke all on public.backup_export_runs from anon, authenticated;
grant select on public.backup_export_runs to authenticated;
grant all on public.backup_export_runs to service_role;

create or replace function public.begin_backup_export_run(
  p_clinic_id uuid,
  p_scheduled_for timestamptz,
  p_request_id text
)
returns table (run_id uuid, acquired boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_run public.backup_export_runs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_scheduled_for is null then raise exception 'BACKUP_SLOT_REQUIRED'; end if;
  if not exists (select 1 from public.clinics c where c.id = p_clinic_id and c.active) then
    raise exception 'CLINIC_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_clinic_id::text || ':' || p_scheduled_for::text)::bigint
  );
  select * into v_run
  from public.backup_export_runs r
  where r.clinic_id = p_clinic_id
    and r.scheduled_for = p_scheduled_for
  for update;

  if found and (
    v_run.status = 'completed'
    or (v_run.status = 'started' and v_run.started_at > now() - interval '30 minutes')
  ) then
    return query select v_run.id, false;
    return;
  end if;

  if found then
    update public.backup_export_runs
    set status = 'started',
        domain_counts = '{}'::jsonb,
        object_manifest = '[]'::jsonb,
        request_id = nullif(btrim(p_request_id), ''),
        error_code = null,
        started_at = now(),
        completed_at = null
    where id = v_run.id
    returning * into v_run;
  else
    insert into public.backup_export_runs (
      clinic_id, scheduled_for, status, request_id
    ) values (
      p_clinic_id, p_scheduled_for, 'started', nullif(btrim(p_request_id), '')
    ) returning * into v_run;
  end if;

  return query select v_run.id, true;
end;
$$;

create or replace function public.complete_backup_export_run(
  p_run_id uuid,
  p_status text,
  p_domain_counts jsonb,
  p_object_manifest jsonb,
  p_error_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_status not in ('completed','partial','failed') then
    raise exception 'BACKUP_STATUS_INVALID';
  end if;
  update public.backup_export_runs
  set status = p_status,
      domain_counts = coalesce(p_domain_counts, '{}'::jsonb),
      object_manifest = coalesce(p_object_manifest, '[]'::jsonb),
      error_code = nullif(btrim(p_error_code), ''),
      completed_at = now()
  where id = p_run_id and status = 'started';
  if not found then raise exception 'BACKUP_RUN_NOT_ACTIVE'; end if;
end;
$$;

create or replace function public.list_backup_export_clinics()
returns table (clinic_id uuid, clinic_code text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.code from public.clinics c where c.active order by c.code;
$$;

create or replace function public.export_clinic_backup_domain(
  p_clinic_id uuid,
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_requested_clinic uuid := p_clinic_id;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists (select 1 from public.clinics c where c.id = p_clinic_id and c.active) then
    raise exception 'CLINIC_NOT_FOUND';
  end if;
  if p_domain = 'patients' then
    select jsonb_build_object(
      'patients', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.patients p where p.clinic_id = v_requested_clinic), '[]'::jsonb),
      'patient_allergies', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.patient_allergies a where a.clinic_id = v_requested_clinic), '[]'::jsonb),
      'encounters', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at) from public.encounters e where e.clinic_id = v_requested_clinic), '[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'products' then
    select jsonb_build_object(
      'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.sku) from public.products p where p.clinic_id = v_requested_clinic), '[]'::jsonb),
      'inventory_lots', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from public.inventory_lots l where l.clinic_id = v_requested_clinic), '[]'::jsonb),
      'stock_movements', coalesce((select jsonb_agg(to_jsonb(s) order by s.occurred_at) from public.stock_movements s where s.clinic_id = v_requested_clinic), '[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'pharmacy' then
    select jsonb_build_object(
      'counter_sales', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.pharmacy_counter_sales s where s.clinic_id = v_requested_clinic), '[]'::jsonb),
      'counter_sale_items', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.pharmacy_counter_sale_items i where i.clinic_id = v_requested_clinic), '[]'::jsonb),
      'counter_allocations', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.pharmacy_counter_allocations a where a.clinic_id = v_requested_clinic), '[]'::jsonb),
      'prescriptions', coalesce((
        select jsonb_agg(to_jsonb(rx) order by rx.created_at)
        from public.prescriptions rx
        join public.encounters e on e.id = rx.encounter_id
        where e.clinic_id = v_requested_clinic
      ), '[]'::jsonb),
      'prescription_items', coalesce((
        select jsonb_agg(to_jsonb(ri) order by ri.created_at)
        from public.prescription_items ri
        join public.prescriptions rx on rx.id = ri.prescription_id
        join public.encounters e on e.id = rx.encounter_id
        where e.clinic_id = v_requested_clinic
      ), '[]'::jsonb),
      'dispensing_orders', coalesce((
        select jsonb_agg(to_jsonb(d) order by d.created_at)
        from public.dispensing_orders d
        join public.prescriptions rx on rx.id = d.prescription_id
        join public.encounters e on e.id = rx.encounter_id
        where e.clinic_id = v_requested_clinic
      ), '[]'::jsonb),
      'dispensing_items', coalesce((
        select jsonb_agg(to_jsonb(di) order by di.created_at)
        from public.dispensing_items di
        join public.dispensing_orders d on d.id = di.dispensing_order_id
        join public.prescriptions rx on rx.id = d.prescription_id
        join public.encounters e on e.id = rx.encounter_id
        where e.clinic_id = v_requested_clinic
      ), '[]'::jsonb)
    ) into v_payload;
  else
    raise exception 'BACKUP_DOMAIN_INVALID';
  end if;

  return jsonb_build_object(
    'format', 'chananya-domain-export/v1',
    'schema_version', '2026-08-27.1',
    'clinic_id', p_clinic_id,
    'domain', p_domain,
    'exported_at', now(),
    'data', coalesce(v_payload, '{}'::jsonb)
  );
end;
$$;

create or replace function public.department_persistence_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_regprocedure('public.current_access_context()') is not null
    and to_regprocedure('public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)') is not null
    and to_regprocedure('public.export_clinic_backup_domain(uuid,text)') is not null,
    '2026-08-27.1'::text;
$$;

revoke all on function public.list_backup_export_clinics() from public, anon, authenticated;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public, anon, authenticated;
revoke all on function public.begin_backup_export_run(uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function public.complete_backup_export_run(uuid,text,jsonb,jsonb,text) from public, anon, authenticated;
revoke all on function public.department_persistence_healthcheck() from public;
grant execute on function public.list_backup_export_clinics() to service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;
grant execute on function public.begin_backup_export_run(uuid,timestamptz,text) to service_role;
grant execute on function public.complete_backup_export_run(uuid,text,jsonb,jsonb,text) to service_role;
grant execute on function public.department_persistence_healthcheck() to authenticated, service_role;

commit;

select
  'CHANANYA_DEPARTMENT_PERSISTENCE_READY' as status,
  to_regprocedure('public.current_access_context()') as access_context,
  to_regprocedure('public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)') as product_rpc,
  to_regprocedure('public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)') as pharmacy_rpc,
  to_regprocedure('public.export_clinic_backup_domain(uuid,text)') as drive_export_source;
