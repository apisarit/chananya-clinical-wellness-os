begin;

-- ============================================================
-- ATOMIC, TENANT-SCOPED PRODUCTION EXECUTION
--
-- Production previously performed request creation, FEFO material issue,
-- completion, QC and finished-goods receipt as separate browser writes. A
-- dropped connection could therefore leave stock and workflow state out of
-- sync. This migration makes every transition a server transaction, binds
-- every row to one clinic, and removes direct browser mutation privileges.
-- ============================================================

-- ------------------------------------------------------------
-- Tenant keys and idempotency evidence
-- ------------------------------------------------------------

alter table public.suppliers add column if not exists clinic_id uuid;
alter table public.formulas add column if not exists clinic_id uuid;
alter table public.formula_components add column if not exists clinic_id uuid;
alter table public.production_requests add column if not exists clinic_id uuid;
alter table public.production_requests add column if not exists request_key uuid;
alter table public.production_requests add column if not exists request_fingerprint text;
alter table public.production_orders add column if not exists clinic_id uuid;
alter table public.production_material_issues add column if not exists clinic_id uuid;
alter table public.production_qc add column if not exists clinic_id uuid;
alter table public.finished_goods_receipts add column if not exists clinic_id uuid;
alter table public.import_batches add column if not exists clinic_id uuid;
alter table public.import_rows add column if not exists clinic_id uuid;

update public.suppliers
set clinic_id = '00000000-0000-0000-0000-000000000001'::uuid
where clinic_id is null;

update public.formulas f
set clinic_id = p.clinic_id
from public.products p
where p.id = f.finished_product_id and f.clinic_id is null;

update public.formula_components c
set clinic_id = f.clinic_id
from public.formulas f
where f.id = c.formula_id and c.clinic_id is null;

update public.production_requests r
set clinic_id = p.clinic_id
from public.products p
where p.id = r.requested_product_id and r.clinic_id is null;

update public.production_orders o
set clinic_id = f.clinic_id
from public.formulas f
where f.id = o.formula_id and o.clinic_id is null;

update public.production_material_issues i
set clinic_id = o.clinic_id
from public.production_orders o
where o.id = i.production_order_id and i.clinic_id is null;

update public.production_qc q
set clinic_id = o.clinic_id
from public.production_orders o
where o.id = q.production_order_id and q.clinic_id is null;

update public.finished_goods_receipts r
set clinic_id = o.clinic_id
from public.production_orders o
where o.id = r.production_order_id and r.clinic_id is null;

update public.import_batches
set clinic_id = '00000000-0000-0000-0000-000000000001'::uuid
where clinic_id is null;

update public.import_rows r
set clinic_id = b.clinic_id
from public.import_batches b
where b.id = r.import_batch_id and r.clinic_id is null;

alter table public.suppliers alter column clinic_id set not null;
alter table public.formulas alter column clinic_id set not null;
alter table public.formula_components alter column clinic_id set not null;
alter table public.production_requests alter column clinic_id set not null;
alter table public.production_orders alter column clinic_id set not null;
alter table public.production_material_issues alter column clinic_id set not null;
alter table public.production_qc alter column clinic_id set not null;
alter table public.finished_goods_receipts alter column clinic_id set not null;
alter table public.import_batches alter column clinic_id set not null;
alter table public.import_rows alter column clinic_id set not null;

-- References that were globally unique become tenant-local references.
alter table public.suppliers drop constraint if exists suppliers_supplier_code_key;
drop index if exists public.suppliers_supplier_code_key;
create unique index if not exists suppliers_clinic_code_uidx
  on public.suppliers(clinic_id, supplier_code)
  where supplier_code is not null;

alter table public.formulas drop constraint if exists formulas_formula_code_revision_key;
drop index if exists public.formulas_formula_code_revision_key;
create unique index if not exists formulas_clinic_code_revision_uidx
  on public.formulas(clinic_id, formula_code, revision);

alter table public.production_requests drop constraint if exists production_requests_request_no_key;
drop index if exists public.production_requests_request_no_key;
create unique index if not exists production_requests_clinic_no_uidx
  on public.production_requests(clinic_id, request_no);
create unique index if not exists production_requests_clinic_key_uidx
  on public.production_requests(clinic_id, request_key)
  where request_key is not null;

alter table public.production_orders drop constraint if exists production_orders_production_order_no_key;
alter table public.production_orders drop constraint if exists production_orders_batch_number_key;
drop index if exists public.production_orders_production_order_no_key;
drop index if exists public.production_orders_batch_number_key;
create unique index if not exists production_orders_clinic_no_uidx
  on public.production_orders(clinic_id, production_order_no);
create unique index if not exists production_orders_clinic_batch_uidx
  on public.production_orders(clinic_id, batch_number);
create unique index if not exists production_orders_request_uidx
  on public.production_orders(production_request_id)
  where production_request_id is not null;

create unique index if not exists suppliers_id_clinic_uidx
  on public.suppliers(id, clinic_id);
create unique index if not exists formulas_id_clinic_uidx
  on public.formulas(id, clinic_id);
create unique index if not exists formula_components_id_clinic_uidx
  on public.formula_components(id, clinic_id);
create unique index if not exists production_requests_id_clinic_uidx
  on public.production_requests(id, clinic_id);
create unique index if not exists production_orders_id_clinic_uidx
  on public.production_orders(id, clinic_id);
create unique index if not exists production_material_issues_id_clinic_uidx
  on public.production_material_issues(id, clinic_id);
create unique index if not exists import_batches_id_clinic_uidx
  on public.import_batches(id, clinic_id);

-- A movement source can be committed only once. New production movement
-- references point to the issue/receipt/import row, not merely the order.
create unique index if not exists stock_movements_atomic_source_uidx
  on public.stock_movements(
    clinic_id, reference_type, reference_id, inventory_lot_id, movement_type
  )
  where reference_type in (
    'production_material_issue', 'production_receipt', 'import_row'
  ) and reference_id is not null;

-- Composite foreign keys make a cross-clinic relationship impossible even
-- inside SECURITY DEFINER functions.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'suppliers_clinic_id_fkey') then
    alter table public.suppliers
      add constraint suppliers_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'formulas_product_clinic_fkey') then
    alter table public.formulas
      add constraint formulas_product_clinic_fkey
      foreign key (finished_product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'formula_components_formula_clinic_fkey') then
    alter table public.formula_components
      add constraint formula_components_formula_clinic_fkey
      foreign key (formula_id, clinic_id)
      references public.formulas(id, clinic_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'formula_components_product_clinic_fkey') then
    alter table public.formula_components
      add constraint formula_components_product_clinic_fkey
      foreign key (material_product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_requests_product_clinic_fkey') then
    alter table public.production_requests
      add constraint production_requests_product_clinic_fkey
      foreign key (requested_product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_orders_request_clinic_fkey') then
    alter table public.production_orders
      add constraint production_orders_request_clinic_fkey
      foreign key (production_request_id, clinic_id)
      references public.production_requests(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_orders_formula_clinic_fkey') then
    alter table public.production_orders
      add constraint production_orders_formula_clinic_fkey
      foreign key (formula_id, clinic_id)
      references public.formulas(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_orders_product_clinic_fkey') then
    alter table public.production_orders
      add constraint production_orders_product_clinic_fkey
      foreign key (finished_product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_issues_order_clinic_fkey') then
    alter table public.production_material_issues
      add constraint production_issues_order_clinic_fkey
      foreign key (production_order_id, clinic_id)
      references public.production_orders(id, clinic_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_issues_component_clinic_fkey') then
    alter table public.production_material_issues
      add constraint production_issues_component_clinic_fkey
      foreign key (formula_component_id, clinic_id)
      references public.formula_components(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_issues_product_clinic_fkey') then
    alter table public.production_material_issues
      add constraint production_issues_product_clinic_fkey
      foreign key (material_product_id, clinic_id)
      references public.products(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_issues_lot_clinic_fkey') then
    alter table public.production_material_issues
      add constraint production_issues_lot_clinic_fkey
      foreign key (inventory_lot_id, clinic_id)
      references public.inventory_lots(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_qc_order_clinic_fkey') then
    alter table public.production_qc
      add constraint production_qc_order_clinic_fkey
      foreign key (production_order_id, clinic_id)
      references public.production_orders(id, clinic_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finished_receipts_order_clinic_fkey') then
    alter table public.finished_goods_receipts
      add constraint finished_receipts_order_clinic_fkey
      foreign key (production_order_id, clinic_id)
      references public.production_orders(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finished_receipts_lot_clinic_fkey') then
    alter table public.finished_goods_receipts
      add constraint finished_receipts_lot_clinic_fkey
      foreign key (inventory_lot_id, clinic_id)
      references public.inventory_lots(id, clinic_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_batches_clinic_id_fkey') then
    alter table public.import_batches
      add constraint import_batches_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_rows_batch_clinic_fkey') then
    alter table public.import_rows
      add constraint import_rows_batch_clinic_fkey
      foreign key (import_batch_id, clinic_id)
      references public.import_batches(id, clinic_id) on delete cascade;
  end if;
end $$;

-- Stop a prescription item from referencing a Product Master belonging to
-- another clinic. This also hardens the earlier prescription handoff RPC.
create or replace function public.enforce_prescription_item_product_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prescription_clinic uuid;
  v_product_clinic uuid;
begin
  select e.clinic_id into v_prescription_clinic
  from public.prescriptions rx
  join public.encounters e on e.id = rx.encounter_id
  where rx.id = new.prescription_id;
  select p.clinic_id into v_product_clinic
  from public.products p where p.id = new.product_id;
  if v_prescription_clinic is null or v_product_clinic is null then
    raise exception 'PRESCRIPTION_TENANT_CONTEXT_MISSING';
  end if;
  if v_prescription_clinic <> v_product_clinic then
    raise exception 'PRESCRIPTION_PRODUCT_TENANT_MISMATCH';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prescription_item_product_tenant on public.prescription_items;
create trigger trg_prescription_item_product_tenant
before insert or update of prescription_id, product_id on public.prescription_items
for each row execute function public.enforce_prescription_item_product_tenant();

-- ------------------------------------------------------------
-- Restrictive department RLS
-- ------------------------------------------------------------

alter table public.suppliers enable row level security;
alter table public.formulas enable row level security;
alter table public.formula_components enable row level security;
alter table public.production_requests enable row level security;
alter table public.production_orders enable row level security;
alter table public.production_material_issues enable row level security;
alter table public.production_qc enable row level security;
alter table public.finished_goods_receipts enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;

drop policy if exists suppliers_department_boundary on public.suppliers;
create policy suppliers_department_boundary
on public.suppliers as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and public.department_can('product_read')
)
with check (
  clinic_id = public.current_clinic_id()
  and public.department_can('product_write')
);

drop policy if exists formulas_department_boundary on public.formulas;
create policy formulas_department_boundary
on public.formulas as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists formula_components_department_boundary on public.formula_components;
create policy formula_components_department_boundary
on public.formula_components as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_requests_department_boundary on public.production_requests;
create policy production_requests_department_boundary
on public.production_requests as restrictive for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (public.department_can('production') or public.department_can('pharmacy'))
)
with check (
  clinic_id = public.current_clinic_id()
  and (public.department_can('production') or public.department_can('pharmacy'))
);

drop policy if exists production_orders_department_boundary on public.production_orders;
create policy production_orders_department_boundary
on public.production_orders as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_issues_department_boundary on public.production_material_issues;
create policy production_issues_department_boundary
on public.production_material_issues as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_qc_department_boundary on public.production_qc;
create policy production_qc_department_boundary
on public.production_qc as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists finished_receipts_department_boundary on public.finished_goods_receipts;
create policy finished_receipts_department_boundary
on public.finished_goods_receipts as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists import_batches_department_boundary on public.import_batches;
create policy import_batches_department_boundary
on public.import_batches as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists import_rows_department_boundary on public.import_rows;
create policy import_rows_department_boundary
on public.import_rows as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

-- ------------------------------------------------------------
-- Audited master-data RPCs
-- ------------------------------------------------------------

create or replace function public.upsert_supplier_master(
  p_supplier_id uuid,
  p_supplier_code text,
  p_name text,
  p_tax_id text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null
)
returns public.suppliers
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_supplier public.suppliers%rowtype;
begin
  if v_clinic_id is null or not public.department_can('product_write') then
    raise exception 'PRODUCT_DEPARTMENT_REQUIRED';
  end if;
  if nullif(btrim(p_supplier_code), '') is null or nullif(btrim(p_name), '') is null then
    raise exception 'SUPPLIER_REQUIRED_FIELD_MISSING';
  end if;
  if p_supplier_id is null then
    insert into public.suppliers(
      clinic_id, supplier_code, name, tax_id, phone, email, address, active
    ) values (
      v_clinic_id, upper(btrim(p_supplier_code)), btrim(p_name),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_phone), ''),
      nullif(btrim(p_email), ''), nullif(btrim(p_address), ''), true
    )
    on conflict (clinic_id, supplier_code) where supplier_code is not null
    do update set
      name = excluded.name,
      tax_id = excluded.tax_id,
      phone = excluded.phone,
      email = excluded.email,
      address = excluded.address,
      active = true,
      updated_at = now()
    returning * into v_supplier;
  else
    update public.suppliers
    set supplier_code = upper(btrim(p_supplier_code)),
        name = btrim(p_name),
        tax_id = nullif(btrim(p_tax_id), ''),
        phone = nullif(btrim(p_phone), ''),
        email = nullif(btrim(p_email), ''),
        address = nullif(btrim(p_address), ''),
        updated_at = now()
    where id = p_supplier_id and clinic_id = v_clinic_id
    returning * into v_supplier;
    if not found then raise exception 'SUPPLIER_NOT_FOUND'; end if;
  end if;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'upsert_supplier_master', 'suppliers',
    v_supplier.id::text, jsonb_build_object('supplier_code',v_supplier.supplier_code)
  );
  return v_supplier;
end;
$$;

create or replace function public.upsert_production_formula(
  p_formula_id uuid,
  p_formula_code text,
  p_revision text,
  p_name_th text,
  p_finished_product_id uuid,
  p_standard_batch_size numeric,
  p_batch_unit text,
  p_expected_yield_percent numeric default 100,
  p_shelf_life_days integer default null,
  p_manufacturing_instructions text default null,
  p_status text default 'approved'
)
returns public.formulas
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_product public.products%rowtype;
  v_formula public.formulas%rowtype;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if nullif(btrim(p_formula_code), '') is null
     or nullif(btrim(p_revision), '') is null
     or nullif(btrim(p_name_th), '') is null
     or coalesce(p_standard_batch_size, 0) <= 0
     or coalesce(p_expected_yield_percent, 0) <= 0
     or p_status not in ('draft','approved','inactive') then
    raise exception 'FORMULA_VALUE_INVALID';
  end if;
  select * into v_product from public.products p
  where p.id = p_finished_product_id and p.clinic_id = v_clinic_id and p.active;
  if not found then raise exception 'FINISHED_PRODUCT_NOT_FOUND'; end if;
  if lower(btrim(p_batch_unit)) <> lower(btrim(v_product.stock_unit)) then
    raise exception 'FORMULA_FINISHED_UNIT_MISMATCH';
  end if;
  if p_shelf_life_days is not null and p_shelf_life_days < 0 then
    raise exception 'FORMULA_SHELF_LIFE_INVALID';
  end if;

  if p_formula_id is null then
    insert into public.formulas(
      clinic_id, formula_code, revision, name_th, finished_product_id,
      standard_batch_size, batch_unit, expected_yield_percent,
      shelf_life_days, manufacturing_instructions, status,
      approved_by, approved_at, created_by
    ) values (
      v_clinic_id, upper(btrim(p_formula_code)), btrim(p_revision), btrim(p_name_th),
      p_finished_product_id, p_standard_batch_size, btrim(p_batch_unit),
      p_expected_yield_percent, p_shelf_life_days,
      nullif(btrim(p_manufacturing_instructions), ''), p_status,
      case when p_status = 'approved' then auth.uid() else null end,
      case when p_status = 'approved' then now() else null end,
      auth.uid()
    )
    on conflict (clinic_id, formula_code, revision)
    do update set
      name_th = excluded.name_th,
      finished_product_id = excluded.finished_product_id,
      standard_batch_size = excluded.standard_batch_size,
      batch_unit = excluded.batch_unit,
      expected_yield_percent = excluded.expected_yield_percent,
      shelf_life_days = excluded.shelf_life_days,
      manufacturing_instructions = excluded.manufacturing_instructions,
      status = excluded.status,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = now()
    returning * into v_formula;
  else
    update public.formulas
    set formula_code = upper(btrim(p_formula_code)),
        revision = btrim(p_revision),
        name_th = btrim(p_name_th),
        finished_product_id = p_finished_product_id,
        standard_batch_size = p_standard_batch_size,
        batch_unit = btrim(p_batch_unit),
        expected_yield_percent = p_expected_yield_percent,
        shelf_life_days = p_shelf_life_days,
        manufacturing_instructions = nullif(btrim(p_manufacturing_instructions), ''),
        status = p_status,
        approved_by = case when p_status = 'approved' then auth.uid() else null end,
        approved_at = case when p_status = 'approved' then now() else null end,
        updated_at = now()
    where id = p_formula_id and clinic_id = v_clinic_id
    returning * into v_formula;
    if not found then raise exception 'FORMULA_NOT_FOUND'; end if;
  end if;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'upsert_production_formula', 'formulas',
    v_formula.id::text,
    jsonb_build_object(
      'formula_code',v_formula.formula_code,
      'revision',v_formula.revision,
      'status',v_formula.status
    )
  );
  return v_formula;
end;
$$;

create or replace function public.upsert_production_formula_component(
  p_component_id uuid,
  p_formula_id uuid,
  p_material_product_id uuid,
  p_sequence_no integer,
  p_quantity_per_batch numeric,
  p_unit text,
  p_process_stage text default null,
  p_notes text default null
)
returns public.formula_components
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_formula public.formulas%rowtype;
  v_product public.products%rowtype;
  v_component public.formula_components%rowtype;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if coalesce(p_sequence_no, 0) < 1 or coalesce(p_quantity_per_batch, 0) <= 0 then
    raise exception 'FORMULA_COMPONENT_VALUE_INVALID';
  end if;
  select * into v_formula from public.formulas f
  where f.id = p_formula_id and f.clinic_id = v_clinic_id for update;
  if not found then raise exception 'FORMULA_NOT_FOUND'; end if;
  if v_formula.status = 'inactive' then raise exception 'FORMULA_INACTIVE'; end if;
  select * into v_product from public.products p
  where p.id = p_material_product_id and p.clinic_id = v_clinic_id and p.active;
  if not found then raise exception 'MATERIAL_PRODUCT_NOT_FOUND'; end if;
  if lower(btrim(p_unit)) <> lower(btrim(v_product.stock_unit)) then
    raise exception 'FORMULA_COMPONENT_UNIT_MISMATCH';
  end if;

  if p_component_id is null then
    insert into public.formula_components(
      clinic_id, formula_id, material_product_id, sequence_no,
      quantity_per_batch, unit, process_stage, notes
    ) values (
      v_clinic_id, p_formula_id, p_material_product_id, p_sequence_no,
      p_quantity_per_batch, btrim(p_unit), nullif(btrim(p_process_stage), ''),
      nullif(btrim(p_notes), '')
    )
    on conflict (formula_id, material_product_id, sequence_no)
    do update set
      quantity_per_batch = excluded.quantity_per_batch,
      unit = excluded.unit,
      process_stage = excluded.process_stage,
      notes = excluded.notes
    returning * into v_component;
  else
    update public.formula_components
    set formula_id = p_formula_id,
        material_product_id = p_material_product_id,
        sequence_no = p_sequence_no,
        quantity_per_batch = p_quantity_per_batch,
        unit = btrim(p_unit),
        process_stage = nullif(btrim(p_process_stage), ''),
        notes = nullif(btrim(p_notes), '')
    where id = p_component_id and clinic_id = v_clinic_id
    returning * into v_component;
    if not found then raise exception 'FORMULA_COMPONENT_NOT_FOUND'; end if;
  end if;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'upsert_production_formula_component',
    'formula_components', v_component.id::text,
    jsonb_build_object(
      'formula_id',p_formula_id,
      'material_product_id',p_material_product_id,
      'quantity_per_batch',p_quantity_per_batch,
      'unit',btrim(p_unit)
    )
  );
  return v_component;
end;
$$;

-- ------------------------------------------------------------
-- Atomic Pharmacy -> Production -> QC -> Inventory workflow
-- ------------------------------------------------------------

create or replace function public.create_production_request(
  p_request_key uuid,
  p_dispensing_order_id uuid,
  p_prescription_item_id uuid,
  p_requested_quantity numeric,
  p_unit text,
  p_required_by timestamptz default null,
  p_priority text default 'normal',
  p_reason text default 'out_of_stock'
)
returns public.production_requests
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_item public.prescription_items%rowtype;
  v_product public.products%rowtype;
  v_request public.production_requests%rowtype;
  v_existing public.production_requests%rowtype;
  v_fingerprint text;
begin
  if v_clinic_id is null or not public.department_can('pharmacy') then
    raise exception 'PHARMACY_DEPARTMENT_REQUIRED';
  end if;
  if p_request_key is null then raise exception 'REQUEST_KEY_REQUIRED'; end if;
  if coalesce(p_requested_quantity, 0) <= 0 or p_requested_quantity > 100000000 then
    raise exception 'PRODUCTION_REQUEST_QUANTITY_INVALID';
  end if;
  if p_priority not in ('normal','urgent','critical') then
    raise exception 'PRODUCTION_REQUEST_PRIORITY_INVALID';
  end if;
  if p_required_by is not null and p_required_by < now() - interval '5 minutes' then
    raise exception 'PRODUCTION_REQUEST_REQUIRED_BY_INVALID';
  end if;

  select pi.* into v_item
  from public.prescription_items pi
  join public.prescriptions rx on rx.id = pi.prescription_id
  join public.dispensing_orders d on d.prescription_id = rx.id
  join public.encounters e on e.id = rx.encounter_id
  where pi.id = p_prescription_item_id
    and d.id = p_dispensing_order_id
    and e.clinic_id = v_clinic_id
    and d.status not in ('submitted_to_billing','billed','cancelled','rejected')
  for update of d, pi;
  if not found then raise exception 'PHARMACY_PRESCRIPTION_ITEM_NOT_FOUND'; end if;

  select * into v_product from public.products p
  where p.id = v_item.product_id
    and p.clinic_id = v_clinic_id
    and p.active;
  if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;
  if lower(btrim(p_unit)) <> lower(btrim(v_product.stock_unit)) then
    raise exception 'PRODUCTION_REQUEST_UNIT_MISMATCH';
  end if;

  v_fingerprint := md5(
    p_dispensing_order_id::text || '|' || p_prescription_item_id::text || '|' ||
    p_requested_quantity::text || '|' || lower(btrim(p_unit)) || '|' ||
    coalesce(p_required_by::text, '') || '|' || p_priority || '|' ||
    coalesce(nullif(btrim(p_reason), ''), 'out_of_stock')
  );

  select * into v_existing from public.production_requests r
  where r.clinic_id = v_clinic_id and r.request_key = p_request_key;
  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_existing;
  end if;

  select coalesce(
    nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''), 'CLN'
  ) into v_clinic_code from public.clinics c where c.id = v_clinic_id;

  insert into public.production_requests(
    clinic_id, request_no, request_key, request_fingerprint, source_type,
    dispensing_order_id, prescription_item_id, requested_product_id,
    requested_quantity, unit, required_by, priority, status, reason, requested_by
  ) values (
    v_clinic_id,
    'PR-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'production_request')::text, 8, '0'),
    p_request_key, v_fingerprint, 'pharmacy', p_dispensing_order_id,
    p_prescription_item_id, v_item.product_id, p_requested_quantity,
    btrim(p_unit), p_required_by, p_priority, 'requested',
    coalesce(nullif(btrim(p_reason), ''), 'out_of_stock'), auth.uid()
  ) returning * into v_request;

  update public.dispensing_orders
  set status = 'out_of_stock', updated_at = now()
  where id = p_dispensing_order_id
    and status not in ('submitted_to_billing','billed','cancelled','rejected');

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'create_production_request',
    'production_requests', v_request.id::text,
    jsonb_build_object(
      'request_no',v_request.request_no,
      'dispensing_order_id',p_dispensing_order_id,
      'prescription_item_id',p_prescription_item_id,
      'product_id',v_item.product_id,
      'quantity',p_requested_quantity,
      'unit',btrim(p_unit),
      'priority',p_priority
    )
  );
  return v_request;
end;
$$;

create or replace function public.open_production_order(
  p_request_id uuid,
  p_formula_id uuid default null,
  p_planned_quantity numeric default null
)
returns public.production_orders
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_request public.production_requests%rowtype;
  v_formula public.formulas%rowtype;
  v_order public.production_orders%rowtype;
  v_planned numeric(18,4);
  v_counter bigint;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  select * into v_request from public.production_requests r
  where r.id = p_request_id and r.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_REQUEST_NOT_FOUND'; end if;

  select * into v_order from public.production_orders o
  where o.production_request_id = p_request_id and o.clinic_id = v_clinic_id;
  if found then return v_order; end if;
  if v_request.status <> 'requested' then raise exception 'PRODUCTION_REQUEST_NOT_OPEN'; end if;

  if p_formula_id is null then
    select * into v_formula from public.formulas f
    where f.clinic_id = v_clinic_id
      and f.finished_product_id = v_request.requested_product_id
      and f.status = 'approved'
    order by f.approved_at desc nulls last, f.revision desc, f.id
    limit 1
    for update;
  else
    select * into v_formula from public.formulas f
    where f.id = p_formula_id
      and f.clinic_id = v_clinic_id
      and f.finished_product_id = v_request.requested_product_id
      and f.status = 'approved'
    for update;
  end if;
  if not found then raise exception 'APPROVED_FORMULA_NOT_FOUND'; end if;
  if not exists (
    select 1 from public.formula_components c
    where c.formula_id = v_formula.id and c.clinic_id = v_clinic_id
  ) then raise exception 'FORMULA_COMPONENT_REQUIRED'; end if;

  v_planned := coalesce(p_planned_quantity,
    greatest(v_request.requested_quantity, v_formula.standard_batch_size));
  if v_planned <= 0 or v_planned < v_request.requested_quantity then
    raise exception 'PRODUCTION_PLANNED_QUANTITY_INVALID';
  end if;

  select coalesce(
    nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''), 'CLN'
  ) into v_clinic_code from public.clinics c where c.id = v_clinic_id;
  v_counter := public.next_clinic_counter(v_clinic_id, 'production_order');

  insert into public.production_orders(
    clinic_id, production_order_no, production_request_id, formula_id,
    finished_product_id, batch_number, planned_quantity, planned_unit,
    planned_start_at, status, created_by
  ) values (
    v_clinic_id,
    'PO-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(v_counter::text, 8, '0'),
    v_request.id, v_formula.id, v_request.requested_product_id,
    'B-' || v_clinic_code || '-' || to_char(current_date, 'YYYYMMDD') || '-' ||
      lpad(v_counter::text, 8, '0'),
    v_planned, v_formula.batch_unit, now(), 'planned', auth.uid()
  ) returning * into v_order;

  update public.production_requests
  set status = 'planned', updated_at = now()
  where id = v_request.id;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'open_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'batch_number',v_order.batch_number,
      'request_id',v_request.id,
      'formula_id',v_formula.id,
      'planned_quantity',v_planned,
      'unit',v_formula.batch_unit
    )
  );
  return v_order;
end;
$$;

create or replace function public.issue_production_materials_fefo(
  p_production_order_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
  v_formula public.formulas%rowtype;
  v_component public.formula_components%rowtype;
  v_product public.products%rowtype;
  v_lot record;
  v_required numeric(18,6);
  v_remaining numeric(18,6);
  v_take numeric(18,6);
  v_issue public.production_material_issues%rowtype;
  v_line_count integer := 0;
  v_total numeric(18,6) := 0;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status in ('materials_issued','in_process','awaiting_qc','released') then
    return jsonb_build_object(
      'production_order_id',v_order.id,
      'status',v_order.status,
      'issue_lines',(select count(*) from public.production_material_issues i where i.production_order_id=v_order.id)
    );
  end if;
  if v_order.status <> 'planned' then raise exception 'PRODUCTION_ORDER_NOT_PLANNED'; end if;

  select * into v_formula from public.formulas f
  where f.id = v_order.formula_id and f.clinic_id = v_clinic_id;
  if not found or v_formula.status <> 'approved' then raise exception 'APPROVED_FORMULA_NOT_FOUND'; end if;

  for v_component in
    select c.* from public.formula_components c
    where c.formula_id = v_formula.id and c.clinic_id = v_clinic_id
    order by c.material_product_id, c.sequence_no, c.id
  loop
    select * into v_product from public.products p
    where p.id = v_component.material_product_id and p.clinic_id = v_clinic_id and p.active;
    if not found then raise exception 'MATERIAL_PRODUCT_NOT_FOUND'; end if;
    if lower(btrim(v_component.unit)) <> lower(btrim(v_product.stock_unit)) then
      raise exception 'PRODUCTION_UNIT_CONVERSION_REQUIRED';
    end if;
    v_required := v_component.quantity_per_batch *
      (v_order.planned_quantity / v_formula.standard_batch_size);
    v_remaining := v_required;

    for v_lot in
      select l.id, l.current_quantity, l.expiry_date, l.received_at, l.unit
      from public.inventory_lots l
      where l.clinic_id = v_clinic_id
        and l.product_id = v_component.material_product_id
        and l.status = 'active'
        and l.current_quantity > 0
        and (l.expiry_date is null or l.expiry_date >= current_date)
      order by l.expiry_date nulls last, l.received_at, l.id
      for update
    loop
      exit when v_remaining <= 0;
      if lower(btrim(v_lot.unit)) <> lower(btrim(v_component.unit)) then
        raise exception 'PRODUCTION_LOT_UNIT_MISMATCH';
      end if;
      v_take := least(v_remaining, v_lot.current_quantity);
      insert into public.production_material_issues(
        clinic_id, production_order_id, formula_component_id,
        material_product_id, inventory_lot_id, required_quantity,
        issued_quantity, unit, issued_by
      ) values (
        v_clinic_id, v_order.id, v_component.id,
        v_component.material_product_id, v_lot.id, v_required,
        v_take, v_component.unit, auth.uid()
      ) returning * into v_issue;
      insert into public.stock_movements(
        clinic_id, inventory_lot_id, movement_type, quantity, direction,
        reference_type, reference_id, reason, performed_by
      ) values (
        v_clinic_id, v_lot.id, 'production_issue', v_take, 'out',
        'production_material_issue', v_issue.id,
        'FEFO issue to ' || v_order.production_order_no, auth.uid()
      );
      v_remaining := v_remaining - v_take;
      v_line_count := v_line_count + 1;
      v_total := v_total + v_take;
    end loop;
    if v_remaining > 0 then
      raise exception 'PRODUCTION_MATERIAL_INSUFFICIENT:%', v_component.material_product_id;
    end if;
  end loop;
  if v_line_count = 0 then raise exception 'FORMULA_COMPONENT_REQUIRED'; end if;

  update public.production_orders
  set status = 'materials_issued', actual_start_at = now(),
      produced_by = auth.uid(), updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'issue_production_materials_fefo',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'issue_lines',v_line_count,
      'total_issued',v_total,
      'allocation','FEFO'
    )
  );
  return jsonb_build_object(
    'production_order_id',v_order.id,
    'status',v_order.status,
    'issue_lines',v_line_count,
    'total_issued',v_total
  );
end;
$$;

create or replace function public.complete_production_order(
  p_production_order_id uuid,
  p_actual_quantity numeric,
  p_loss_quantity numeric default 0,
  p_waste_quantity numeric default 0
)
returns public.production_orders
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
  v_yield numeric(7,2);
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if coalesce(p_actual_quantity, 0) <= 0
     or coalesce(p_loss_quantity, 0) < 0
     or coalesce(p_waste_quantity, 0) < 0 then
    raise exception 'PRODUCTION_OUTPUT_VALUE_INVALID';
  end if;
  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status = 'awaiting_qc'
     and v_order.actual_quantity = p_actual_quantity
     and v_order.loss_quantity = p_loss_quantity
     and v_order.waste_quantity = p_waste_quantity then
    return v_order;
  end if;
  if v_order.status not in ('materials_issued','in_process') then
    raise exception 'PRODUCTION_ORDER_NOT_IN_PROCESS';
  end if;
  if not exists (
    select 1 from public.production_material_issues i
    where i.production_order_id = v_order.id and i.clinic_id = v_clinic_id
  ) then raise exception 'PRODUCTION_MATERIAL_ISSUE_REQUIRED'; end if;

  v_yield := round((p_actual_quantity / v_order.planned_quantity) * 100, 2);
  update public.production_orders
  set actual_quantity = p_actual_quantity,
      loss_quantity = p_loss_quantity,
      waste_quantity = p_waste_quantity,
      yield_percent = v_yield,
      actual_end_at = now(),
      status = 'awaiting_qc',
      updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'complete_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'actual_quantity',p_actual_quantity,
      'loss_quantity',p_loss_quantity,
      'waste_quantity',p_waste_quantity,
      'yield_percent',v_yield,
      'unit',v_order.planned_unit
    )
  );
  return v_order;
end;
$$;

create or replace function public.release_production_order(
  p_production_order_id uuid,
  p_result_summary text,
  p_sample_reference text default null,
  p_appearance_result text default null,
  p_moisture_result numeric default null,
  p_water_activity_result numeric default null,
  p_weight_result numeric default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
  v_formula public.formulas%rowtype;
  v_request public.production_requests%rowtype;
  v_qc public.production_qc%rowtype;
  v_lot public.inventory_lots%rowtype;
  v_receipt public.finished_goods_receipts%rowtype;
  v_expiry date;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if length(btrim(coalesce(p_result_summary, ''))) < 3 then
    raise exception 'QC_RESULT_SUMMARY_REQUIRED';
  end if;
  if coalesce(p_moisture_result, 0) < 0
     or coalesce(p_water_activity_result, 0) < 0
     or coalesce(p_weight_result, 0) < 0 then
    raise exception 'QC_RESULT_VALUE_INVALID';
  end if;

  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status = 'released' then
    select * into v_receipt from public.finished_goods_receipts r
    where r.production_order_id = v_order.id and r.clinic_id = v_clinic_id;
    return jsonb_build_object(
      'production_order_id',v_order.id,
      'status',v_order.status,
      'inventory_lot_id',v_receipt.inventory_lot_id,
      'received_quantity',v_receipt.received_quantity
    );
  end if;
  if v_order.status <> 'awaiting_qc' or coalesce(v_order.actual_quantity, 0) <= 0 then
    raise exception 'PRODUCTION_ORDER_NOT_AWAITING_QC';
  end if;
  select * into v_formula from public.formulas f
  where f.id = v_order.formula_id and f.clinic_id = v_clinic_id;
  if not found then raise exception 'FORMULA_NOT_FOUND'; end if;

  insert into public.production_qc(
    clinic_id, production_order_id, sample_reference, appearance_result,
    moisture_result, water_activity_result, weight_result, result_summary,
    status, tested_by, tested_at, approved_by, approved_at, rejection_reason
  ) values (
    v_clinic_id, v_order.id, nullif(btrim(p_sample_reference), ''),
    nullif(btrim(p_appearance_result), ''), p_moisture_result,
    p_water_activity_result, p_weight_result, btrim(p_result_summary),
    'passed', auth.uid(), now(), auth.uid(), now(), null
  )
  on conflict (production_order_id) do update set
    clinic_id = excluded.clinic_id,
    sample_reference = excluded.sample_reference,
    appearance_result = excluded.appearance_result,
    moisture_result = excluded.moisture_result,
    water_activity_result = excluded.water_activity_result,
    weight_result = excluded.weight_result,
    result_summary = excluded.result_summary,
    status = 'passed',
    tested_by = excluded.tested_by,
    tested_at = excluded.tested_at,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at,
    rejection_reason = null,
    updated_at = now()
  returning * into v_qc;

  v_expiry := case
    when coalesce(v_formula.shelf_life_days, 0) > 0
      then current_date + v_formula.shelf_life_days
    else null
  end;
  insert into public.inventory_lots(
    clinic_id, product_id, lot_number, manufacture_date, expiry_date,
    received_quantity, current_quantity, unit, purchase_cost,
    storage_location, status, created_by
  ) values (
    v_clinic_id, v_order.finished_product_id, v_order.batch_number,
    current_date, v_expiry, v_order.actual_quantity, 0,
    v_order.planned_unit, 0, 'Finished Goods', 'active', auth.uid()
  ) returning * into v_lot;

  insert into public.finished_goods_receipts(
    clinic_id, production_order_id, inventory_lot_id,
    received_quantity, unit, received_by
  ) values (
    v_clinic_id, v_order.id, v_lot.id,
    v_order.actual_quantity, v_order.planned_unit, auth.uid()
  ) returning * into v_receipt;

  insert into public.stock_movements(
    clinic_id, inventory_lot_id, movement_type, quantity, direction,
    reference_type, reference_id, reason, performed_by
  ) values (
    v_clinic_id, v_lot.id, 'production_receipt', v_order.actual_quantity,
    'in', 'production_receipt', v_receipt.id,
    'QC released ' || v_order.production_order_no, auth.uid()
  );

  update public.production_orders
  set status = 'released', updated_at = now()
  where id = v_order.id
  returning * into v_order;

  if v_order.production_request_id is not null then
    select * into v_request from public.production_requests r
    where r.id = v_order.production_request_id and r.clinic_id = v_clinic_id
    for update;
    if found then
      update public.production_requests
      set status = 'fulfilled', updated_at = now()
      where id = v_request.id;
      if v_request.dispensing_order_id is not null then
        update public.dispensing_orders
        set status = 'waiting', updated_at = now()
        where id = v_request.dispensing_order_id and status = 'out_of_stock';
      end if;
    end if;
  end if;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'release_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'batch_number',v_order.batch_number,
      'qc_id',v_qc.id,
      'inventory_lot_id',v_lot.id,
      'receipt_id',v_receipt.id,
      'received_quantity',v_receipt.received_quantity,
      'expiry_date',v_expiry
    )
  );
  return jsonb_build_object(
    'production_order_id',v_order.id,
    'status',v_order.status,
    'qc_id',v_qc.id,
    'inventory_lot_id',v_lot.id,
    'received_quantity',v_receipt.received_quantity,
    'expiry_date',v_expiry
  );
end;
$$;

create or replace function public.reject_production_order(
  p_production_order_id uuid,
  p_rejection_reason text,
  p_result_summary text default 'ไม่ผ่านข้อกำหนด'
)
returns public.production_orders
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if length(btrim(coalesce(p_rejection_reason, ''))) < 5 then
    raise exception 'QC_REJECTION_REASON_REQUIRED';
  end if;
  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status = 'rejected' then return v_order; end if;
  if v_order.status <> 'awaiting_qc' then
    raise exception 'PRODUCTION_ORDER_NOT_AWAITING_QC';
  end if;

  insert into public.production_qc(
    clinic_id, production_order_id, result_summary, status,
    tested_by, tested_at, rejection_reason
  ) values (
    v_clinic_id, v_order.id,
    coalesce(nullif(btrim(p_result_summary), ''), 'ไม่ผ่านข้อกำหนด'),
    'rejected', auth.uid(), now(), btrim(p_rejection_reason)
  )
  on conflict (production_order_id) do update set
    clinic_id = excluded.clinic_id,
    result_summary = excluded.result_summary,
    status = 'rejected',
    tested_by = excluded.tested_by,
    tested_at = excluded.tested_at,
    approved_by = null,
    approved_at = null,
    rejection_reason = excluded.rejection_reason,
    updated_at = now();

  update public.production_orders
  set status = 'rejected', updated_at = now()
  where id = v_order.id
  returning * into v_order;
  if v_order.production_request_id is not null then
    update public.production_requests
    set status = 'rejected', updated_at = now()
    where id = v_order.production_request_id and clinic_id = v_clinic_id;
  end if;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'reject_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'batch_number',v_order.batch_number,
      'reason',btrim(p_rejection_reason)
    )
  );
  return v_order;
end;
$$;

-- ------------------------------------------------------------
-- Transactional spreadsheet staging/import
-- ------------------------------------------------------------

create or replace function public.stage_production_import(
  p_import_type text,
  p_source_file_name text,
  p_source_sheet_name text,
  p_rows jsonb
)
returns public.import_batches
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_batch public.import_batches%rowtype;
  v_row jsonb;
  v_normalized jsonb;
  v_raw jsonb;
  v_errors jsonb;
  v_row_number integer;
  v_total integer;
  v_valid integer := 0;
  v_invalid integer := 0;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  if p_import_type not in (
    'products','raw_materials','suppliers','formulas',
    'formula_components','inventory_lots'
  ) then raise exception 'IMPORT_TYPE_INVALID'; end if;
  if nullif(btrim(p_source_file_name), '') is null then
    raise exception 'IMPORT_FILE_NAME_REQUIRED';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'IMPORT_ROWS_MUST_BE_ARRAY';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 5000 or octet_length(p_rows::text) > 10000000 then
    raise exception 'IMPORT_SIZE_INVALID';
  end if;

  insert into public.import_batches(
    clinic_id, import_type, source_file_name, source_sheet_name,
    status, total_rows, uploaded_by
  ) values (
    v_clinic_id, p_import_type, btrim(p_source_file_name),
    nullif(btrim(p_source_sheet_name), ''), 'validated', v_total, auth.uid()
  ) returning * into v_batch;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'IMPORT_ROW_INVALID'; end if;
    begin
      v_row_number := (v_row ->> 'row_number')::integer;
    exception when others then
      raise exception 'IMPORT_ROW_NUMBER_INVALID';
    end;
    if v_row_number < 1 then raise exception 'IMPORT_ROW_NUMBER_INVALID'; end if;
    v_normalized := coalesce(v_row -> 'normalized_data', '{}'::jsonb);
    v_raw := coalesce(v_row -> 'raw_data', '{}'::jsonb);
    if jsonb_typeof(v_normalized) <> 'object' or jsonb_typeof(v_raw) <> 'object' then
      raise exception 'IMPORT_ROW_PAYLOAD_INVALID';
    end if;
    v_errors := '[]'::jsonb;

    if p_import_type in ('products','raw_materials') then
      if nullif(btrim(v_normalized ->> 'sku'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing sku');
      end if;
      if nullif(btrim(v_normalized ->> 'name_th'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing name');
      end if;
      if nullif(btrim(coalesce(v_normalized ->> 'stock_unit',v_normalized ->> 'unit')), '') is null then
        v_errors := v_errors || jsonb_build_array('missing unit');
      end if;
    elsif p_import_type = 'suppliers' then
      if nullif(btrim(v_normalized ->> 'supplier_code'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing supplier_code');
      end if;
      if nullif(btrim(coalesce(v_normalized ->> 'supplier_name',v_normalized ->> 'name_th')), '') is null then
        v_errors := v_errors || jsonb_build_array('missing supplier name');
      end if;
    elsif p_import_type = 'formulas' then
      if nullif(btrim(v_normalized ->> 'formula_code'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing formula_code');
      end if;
      if nullif(btrim(v_normalized ->> 'finished_sku'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing finished_sku');
      end if;
      if nullif(btrim(v_normalized ->> 'batch_size'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing batch_size');
      end if;
    elsif p_import_type = 'formula_components' then
      if nullif(btrim(v_normalized ->> 'formula_code'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing formula_code');
      end if;
      if nullif(btrim(v_normalized ->> 'material_sku'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing material_sku');
      end if;
      if nullif(btrim(v_normalized ->> 'quantity'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing quantity');
      end if;
    elsif p_import_type = 'inventory_lots' then
      if nullif(btrim(v_normalized ->> 'sku'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing sku');
      end if;
      if nullif(btrim(v_normalized ->> 'lot_number'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing lot');
      end if;
      if nullif(btrim(v_normalized ->> 'current_quantity'), '') is null then
        v_errors := v_errors || jsonb_build_array('missing quantity');
      end if;
    end if;

    if jsonb_array_length(v_errors) = 0 then
      v_valid := v_valid + 1;
    else
      v_invalid := v_invalid + 1;
    end if;
    insert into public.import_rows(
      clinic_id, import_batch_id, row_number, raw_data, normalized_data,
      validation_status, validation_errors, target_table
    ) values (
      v_clinic_id, v_batch.id, v_row_number, v_raw, v_normalized,
      case when jsonb_array_length(v_errors)=0 then 'valid' else 'invalid' end,
      v_errors, case when p_import_type='raw_materials' then 'products' else p_import_type end
    );
  end loop;

  update public.import_batches
  set valid_rows = v_valid, invalid_rows = v_invalid
  where id = v_batch.id
  returning * into v_batch;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'stage_production_import',
    'import_batches', v_batch.id::text,
    jsonb_build_object(
      'import_type',p_import_type,
      'total_rows',v_total,
      'valid_rows',v_valid,
      'invalid_rows',v_invalid,
      'source_file_name',btrim(p_source_file_name)
    )
  );
  return v_batch;
end;
$$;

create or replace function public.commit_production_import(
  p_import_batch_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_batch public.import_batches%rowtype;
  v_row public.import_rows%rowtype;
  v_n jsonb;
  v_product public.products%rowtype;
  v_supplier public.suppliers%rowtype;
  v_formula public.formulas%rowtype;
  v_component public.formula_components%rowtype;
  v_lot public.inventory_lots%rowtype;
  v_target uuid;
  v_qty numeric(18,4);
  v_batch_size numeric(18,4);
  v_component_qty numeric(18,6);
  v_sequence integer;
  v_expiry date;
  v_count integer := 0;
begin
  if v_clinic_id is null or not public.department_can('production') then
    raise exception 'PRODUCTION_DEPARTMENT_REQUIRED';
  end if;
  select * into v_batch from public.import_batches b
  where b.id = p_import_batch_id and b.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'IMPORT_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'completed' then
    return jsonb_build_object(
      'import_batch_id',v_batch.id,
      'status',v_batch.status,
      'imported_rows',v_batch.imported_rows
    );
  end if;
  if v_batch.status <> 'validated' then raise exception 'IMPORT_BATCH_NOT_VALIDATED'; end if;
  if v_batch.valid_rows < 1 then raise exception 'IMPORT_VALID_ROW_REQUIRED'; end if;

  for v_row in
    select * from public.import_rows r
    where r.import_batch_id = v_batch.id
      and r.clinic_id = v_clinic_id
      and r.validation_status = 'valid'
    order by r.row_number
    for update
  loop
    v_n := v_row.normalized_data;
    v_target := null;
    if v_batch.import_type in ('products','raw_materials') then
      select * into v_product from public.products p
      where p.clinic_id = v_clinic_id
        and p.sku = upper(btrim(v_n ->> 'sku'));
      select * into v_product from public.upsert_product_master(
        case when found then v_product.id else null end,
        btrim(v_n ->> 'sku'), btrim(v_n ->> 'name_th'), null,
        case when v_batch.import_type='raw_materials' then 'raw_material'
          else coalesce(nullif(btrim(v_n ->> 'category'), ''),'finished_product') end,
        null,
        coalesce(nullif(btrim(v_n ->> 'stock_unit'),''),btrim(v_n ->> 'unit')),
        coalesce(nullif(btrim(v_n ->> 'stock_unit'),''),btrim(v_n ->> 'unit')),
        coalesce(
          nullif(btrim(v_n ->> 'dispense_unit'),''),
          nullif(btrim(v_n ->> 'stock_unit'),''),
          btrim(v_n ->> 'unit')
        ),
        1,0,0,0
      );
      v_target := v_product.id;
    elsif v_batch.import_type = 'suppliers' then
      select * into v_supplier from public.upsert_supplier_master(
        null, btrim(v_n ->> 'supplier_code'),
        btrim(coalesce(v_n ->> 'supplier_name',v_n ->> 'name_th')),
        null,null,null,null
      );
      v_target := v_supplier.id;
    elsif v_batch.import_type = 'formulas' then
      begin
        v_batch_size := (v_n ->> 'batch_size')::numeric(18,4);
      exception when others then raise exception 'IMPORT_FORMULA_QUANTITY_INVALID'; end;
      select * into v_product from public.products p
      where p.clinic_id = v_clinic_id
        and p.sku = upper(btrim(v_n ->> 'finished_sku'))
        and p.active;
      if not found then raise exception 'IMPORT_FINISHED_PRODUCT_NOT_FOUND'; end if;
      select * into v_formula from public.upsert_production_formula(
        null, btrim(v_n ->> 'formula_code'),
        coalesce(nullif(btrim(v_n ->> 'revision'),''),'00'),
        coalesce(nullif(btrim(v_n ->> 'name_th'),''),btrim(v_n ->> 'formula_code')),
        v_product.id, v_batch_size,
        coalesce(nullif(btrim(v_n ->> 'batch_unit'),''),v_product.stock_unit),
        100,null,null,'approved'
      );
      v_target := v_formula.id;
    elsif v_batch.import_type = 'formula_components' then
      begin
        v_component_qty := (v_n ->> 'quantity')::numeric(18,6);
        v_sequence := coalesce(nullif(v_n ->> 'sequence_no','')::integer,v_row.row_number);
      exception when others then raise exception 'IMPORT_COMPONENT_QUANTITY_INVALID'; end;
      select * into v_formula from public.formulas f
      where f.clinic_id = v_clinic_id
        and f.formula_code = upper(btrim(v_n ->> 'formula_code'))
        and f.revision = coalesce(nullif(btrim(v_n ->> 'revision'),''),'00');
      if not found then raise exception 'IMPORT_FORMULA_NOT_FOUND'; end if;
      select * into v_product from public.products p
      where p.clinic_id = v_clinic_id
        and p.sku = upper(btrim(v_n ->> 'material_sku')) and p.active;
      if not found then raise exception 'IMPORT_MATERIAL_PRODUCT_NOT_FOUND'; end if;
      select * into v_component from public.upsert_production_formula_component(
        null, v_formula.id, v_product.id, v_sequence,
        v_component_qty,
        coalesce(nullif(btrim(v_n ->> 'unit'),''),v_product.stock_unit),
        null,null
      );
      v_target := v_component.id;
    elsif v_batch.import_type = 'inventory_lots' then
      begin
        v_qty := (v_n ->> 'current_quantity')::numeric(18,4);
        v_expiry := case when nullif(btrim(v_n ->> 'expiry_date'),'') is null
          then null else (v_n ->> 'expiry_date')::date end;
      exception when others then raise exception 'IMPORT_LOT_VALUE_INVALID'; end;
      if v_qty <= 0 then raise exception 'IMPORT_LOT_QUANTITY_INVALID'; end if;
      select * into v_product from public.products p
      where p.clinic_id = v_clinic_id
        and p.sku = upper(btrim(v_n ->> 'sku')) and p.active;
      if not found then raise exception 'IMPORT_PRODUCT_NOT_FOUND'; end if;
      if lower(btrim(coalesce(nullif(v_n ->> 'unit',''),v_product.stock_unit)))
         <> lower(btrim(v_product.stock_unit)) then
        raise exception 'IMPORT_LOT_UNIT_MISMATCH';
      end if;
      select * into v_lot from public.inventory_lots l
      where l.clinic_id = v_clinic_id
        and l.product_id = v_product.id
        and l.lot_number = btrim(v_n ->> 'lot_number')
      for update;
      if found then
        if exists (
          select 1 from public.stock_movements s
          where s.clinic_id = v_clinic_id
            and s.reference_type='import_row'
            and s.reference_id=v_row.id
        ) then
          v_target := v_lot.id;
        else
          raise exception 'IMPORT_LOT_ALREADY_EXISTS';
        end if;
      else
        insert into public.inventory_lots(
          clinic_id, product_id, lot_number, expiry_date,
          received_quantity, current_quantity, unit, storage_location,
          status, created_by
        ) values (
          v_clinic_id, v_product.id, btrim(v_n ->> 'lot_number'), v_expiry,
          v_qty, 0, v_product.stock_unit,
          nullif(btrim(v_n ->> 'location'),''), 'active', auth.uid()
        ) returning * into v_lot;
        insert into public.stock_movements(
          clinic_id, inventory_lot_id, movement_type, quantity, direction,
          reference_type, reference_id, reason, performed_by
        ) values (
          v_clinic_id, v_lot.id, 'opening_balance', v_qty, 'in',
          'import_row', v_row.id, 'Validated opening-balance import', auth.uid()
        );
        v_target := v_lot.id;
      end if;
    end if;

    update public.import_rows
    set validation_status='imported', target_id=v_target, imported_at=now()
    where id=v_row.id;
    v_count := v_count + 1;
  end loop;

  update public.import_batches
  set status='completed', imported_rows=v_count, completed_at=now()
  where id=v_batch.id
  returning * into v_batch;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'commit_production_import',
    'import_batches', v_batch.id::text,
    jsonb_build_object(
      'import_type',v_batch.import_type,
      'imported_rows',v_count,
      'invalid_rows',v_batch.invalid_rows
    )
  );
  return jsonb_build_object(
    'import_batch_id',v_batch.id,
    'status',v_batch.status,
    'imported_rows',v_count,
    'invalid_rows',v_batch.invalid_rows
  );
end;
$$;

-- Keep the three-domain Drive model requested by the product while ensuring
-- the Products export is sufficient to restore Production/Inventory state.
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
  if not exists (select 1 from public.clinics c where c.id=p_clinic_id and c.active) then
    raise exception 'CLINIC_NOT_FOUND';
  end if;
  if p_domain = 'patients' then
    select jsonb_build_object(
      'patients',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.patients p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'patient_allergies',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.patient_allergies a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'encounters',coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at) from public.encounters e where e.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'products' then
    select jsonb_build_object(
      'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.sku) from public.products p where p.clinic_id=v_requested_clinic),'[]'::jsonb),
      'suppliers',coalesce((select jsonb_agg(to_jsonb(s) order by s.supplier_code) from public.suppliers s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'inventory_lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from public.inventory_lots l where l.clinic_id=v_requested_clinic),'[]'::jsonb),
      'stock_movements',coalesce((select jsonb_agg(to_jsonb(s) order by s.occurred_at) from public.stock_movements s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formulas',coalesce((select jsonb_agg(to_jsonb(f) order by f.formula_code,f.revision) from public.formulas f where f.clinic_id=v_requested_clinic),'[]'::jsonb),
      'formula_components',coalesce((select jsonb_agg(to_jsonb(c) order by c.formula_id,c.sequence_no) from public.formula_components c where c.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.requested_at) from public.production_requests r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at) from public.production_orders o where o.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_material_issues',coalesce((select jsonb_agg(to_jsonb(i) order by i.issued_at) from public.production_material_issues i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'production_qc',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from public.production_qc q where q.clinic_id=v_requested_clinic),'[]'::jsonb),
      'finished_goods_receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.received_at) from public.finished_goods_receipts r where r.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_batches',coalesce((select jsonb_agg(to_jsonb(b) order by b.uploaded_at) from public.import_batches b where b.clinic_id=v_requested_clinic),'[]'::jsonb),
      'import_rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.import_batch_id,r.row_number) from public.import_rows r where r.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  elsif p_domain = 'pharmacy' then
    select jsonb_build_object(
      'counter_sales',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.pharmacy_counter_sales s where s.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_sale_items',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.pharmacy_counter_sale_items i where i.clinic_id=v_requested_clinic),'[]'::jsonb),
      'counter_allocations',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.pharmacy_counter_allocations a where a.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescriptions',coalesce((select jsonb_agg(to_jsonb(rx) order by rx.created_at) from public.prescriptions rx join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'prescription_items',coalesce((select jsonb_agg(to_jsonb(ri) order by ri.created_at) from public.prescription_items ri join public.prescriptions rx on rx.id=ri.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_orders',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb),
      'dispensing_items',coalesce((select jsonb_agg(to_jsonb(di) order by di.created_at) from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id join public.encounters e on e.id=rx.encounter_id where e.clinic_id=v_requested_clinic),'[]'::jsonb)
    ) into v_payload;
  else
    raise exception 'BACKUP_DOMAIN_INVALID';
  end if;
  return jsonb_build_object(
    'format','chananya-domain-export/v1',
    'schema_version','2026-08-27.2',
    'clinic_id',p_clinic_id,
    'domain',p_domain,
    'exported_at',now(),
    'data',coalesce(v_payload,'{}'::jsonb)
  );
end;
$$;

create or replace function public.production_execution_healthcheck()
returns table(ready boolean, schema_version text)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_regprocedure('public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text)') is not null
    and to_regprocedure('public.open_production_order(uuid,uuid,numeric)') is not null
    and to_regprocedure('public.issue_production_materials_fefo(uuid)') is not null
    and to_regprocedure('public.complete_production_order(uuid,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.reject_production_order(uuid,text,text)') is not null
    and to_regprocedure('public.stage_production_import(text,text,text,jsonb)') is not null
    and to_regprocedure('public.commit_production_import(uuid)') is not null,
    '2026-08-27.2'::text;
$$;

-- Browser users retain tenant-filtered reads, but all operational mutations
-- cross the audited RPC boundary above.
revoke insert, update, delete on public.suppliers from authenticated;
revoke insert, update, delete on public.formulas from authenticated;
revoke insert, update, delete on public.formula_components from authenticated;
revoke insert, update, delete on public.production_requests from authenticated;
revoke insert, update, delete on public.production_orders from authenticated;
revoke insert, update, delete on public.production_material_issues from authenticated;
revoke insert, update, delete on public.production_qc from authenticated;
revoke insert, update, delete on public.finished_goods_receipts from authenticated;
revoke insert, update, delete on public.inventory_lots from authenticated;
revoke insert, update, delete on public.stock_movements from authenticated;
revoke insert, update, delete on public.import_batches from authenticated;
revoke insert, update, delete on public.import_rows from authenticated;
revoke update on public.dispensing_orders from authenticated;

grant select on public.suppliers, public.formulas, public.formula_components,
  public.production_requests, public.production_orders,
  public.production_material_issues, public.production_qc,
  public.finished_goods_receipts, public.inventory_lots,
  public.stock_movements, public.import_batches, public.import_rows
  to authenticated;

revoke all on function public.upsert_supplier_master(uuid,text,text,text,text,text,text) from public;
revoke all on function public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text) from public;
revoke all on function public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text) from public;
revoke all on function public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text) from public;
revoke all on function public.open_production_order(uuid,uuid,numeric) from public;
revoke all on function public.issue_production_materials_fefo(uuid) from public;
revoke all on function public.complete_production_order(uuid,numeric,numeric,numeric) from public;
revoke all on function public.release_production_order(uuid,text,text,text,numeric,numeric,numeric) from public;
revoke all on function public.reject_production_order(uuid,text,text) from public;
revoke all on function public.stage_production_import(text,text,text,jsonb) from public;
revoke all on function public.commit_production_import(uuid) from public;
revoke all on function public.production_execution_healthcheck() from public;
revoke all on function public.enforce_prescription_item_product_tenant() from public;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public, anon, authenticated;

grant execute on function public.upsert_supplier_master(uuid,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text) to authenticated, service_role;
grant execute on function public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text) to authenticated, service_role;
grant execute on function public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text) to authenticated, service_role;
grant execute on function public.open_production_order(uuid,uuid,numeric) to authenticated, service_role;
grant execute on function public.issue_production_materials_fefo(uuid) to authenticated, service_role;
grant execute on function public.complete_production_order(uuid,numeric,numeric,numeric) to authenticated, service_role;
grant execute on function public.release_production_order(uuid,text,text,text,numeric,numeric,numeric) to authenticated, service_role;
grant execute on function public.reject_production_order(uuid,text,text) to authenticated, service_role;
grant execute on function public.stage_production_import(text,text,text,jsonb) to authenticated, service_role;
grant execute on function public.commit_production_import(uuid) to authenticated, service_role;
grant execute on function public.production_execution_healthcheck() to authenticated, service_role;
grant execute on function public.enforce_prescription_item_product_tenant() to service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

commit;

select
  'CHANANYA_ATOMIC_PRODUCTION_EXECUTION_READY' as status,
  to_regprocedure('public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text)') as request_rpc,
  to_regprocedure('public.issue_production_materials_fefo(uuid)') as fefo_rpc,
  to_regprocedure('public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)') as release_rpc,
  to_regprocedure('public.commit_production_import(uuid)') as import_rpc;
