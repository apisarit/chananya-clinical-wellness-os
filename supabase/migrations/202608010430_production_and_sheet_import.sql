begin;

-- ============================================================
-- PRODUCTION ROLE
-- ============================================================
update public.profiles
set role = 'viewer'
where role is null
   or role not in ('admin','practitioner','reception','pharmacy','production','inventory','billing','viewer');

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin','practitioner','reception','pharmacy','production','inventory','billing','viewer'));

-- ============================================================
-- FORMULA / BOM MASTER
-- ============================================================
create table if not exists public.formulas (
  id uuid primary key default gen_random_uuid(),
  formula_code text not null,
  revision text not null default '00',
  name_th text not null,
  name_en text,
  finished_product_id uuid not null references public.products(id) on delete restrict,
  standard_batch_size numeric(18,4) not null,
  batch_unit text not null,
  expected_yield_percent numeric(7,2) not null default 100,
  shelf_life_days integer,
  manufacturing_instructions text,
  status text not null default 'draft',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(formula_code, revision)
);

create table if not exists public.formula_components (
  id uuid primary key default gen_random_uuid(),
  formula_id uuid not null references public.formulas(id) on delete cascade,
  material_product_id uuid not null references public.products(id) on delete restrict,
  sequence_no integer not null default 1,
  quantity_per_batch numeric(18,6) not null,
  unit text not null,
  process_stage text,
  notes text,
  created_at timestamptz not null default now(),
  unique(formula_id, material_product_id, sequence_no)
);

-- ============================================================
-- PRODUCTION REQUEST / ORDER / MATERIAL ISSUE / QC / RECEIPT
-- ============================================================
create table if not exists public.production_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,
  source_type text not null default 'pharmacy',
  dispensing_order_id uuid references public.dispensing_orders(id) on delete set null,
  prescription_item_id uuid references public.prescription_items(id) on delete set null,
  requested_product_id uuid not null references public.products(id) on delete restrict,
  requested_quantity numeric(18,4) not null,
  unit text not null,
  required_by timestamptz,
  priority text not null default 'normal',
  status text not null default 'requested',
  reason text,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.production_orders (
  id uuid primary key default gen_random_uuid(),
  production_order_no text not null unique,
  production_request_id uuid references public.production_requests(id) on delete set null,
  formula_id uuid not null references public.formulas(id) on delete restrict,
  finished_product_id uuid not null references public.products(id) on delete restrict,
  batch_number text not null unique,
  planned_quantity numeric(18,4) not null,
  planned_unit text not null,
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  actual_quantity numeric(18,4),
  yield_percent numeric(7,2),
  loss_quantity numeric(18,4) not null default 0,
  waste_quantity numeric(18,4) not null default 0,
  status text not null default 'planned',
  produced_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.production_material_issues (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders(id) on delete cascade,
  formula_component_id uuid references public.formula_components(id) on delete set null,
  material_product_id uuid not null references public.products(id) on delete restrict,
  inventory_lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  required_quantity numeric(18,6) not null,
  issued_quantity numeric(18,6) not null,
  unit text not null,
  issued_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.production_qc (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null unique references public.production_orders(id) on delete cascade,
  sample_reference text,
  appearance_result text,
  moisture_result numeric(10,4),
  water_activity_result numeric(10,4),
  weight_result numeric(18,4),
  result_summary text,
  status text not null default 'pending',
  tested_by uuid references auth.users(id) on delete set null,
  tested_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finished_goods_receipts (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null unique references public.production_orders(id) on delete restrict,
  inventory_lot_id uuid not null unique references public.inventory_lots(id) on delete restrict,
  received_quantity numeric(18,4) not null,
  unit text not null,
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ============================================================
-- GOOGLE SHEETS / XLSX / CSV IMPORT STAGING
-- ============================================================
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  import_type text not null check (import_type in ('products','raw_materials','suppliers','formulas','formula_components','inventory_lots')),
  source_file_name text not null,
  source_sheet_name text,
  status text not null default 'uploaded',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  imported_rows integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text
);

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  validation_status text not null default 'pending',
  validation_errors jsonb not null default '[]'::jsonb,
  target_table text,
  target_id uuid,
  imported_at timestamptz,
  unique(import_batch_id, row_number)
);

-- ============================================================
-- UPDATED_AT
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['formulas','production_requests','production_orders','production_qc'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================
-- RLS
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['formulas','formula_components','production_requests','production_orders','production_material_issues','production_qc','finished_goods_receipts','import_batches','import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read_staff on public.%I', t, t);
    execute format('create policy %I_read_staff on public.%I for select to authenticated using (public.has_role(array[''admin'',''practitioner'',''pharmacy'',''production'',''inventory'',''billing'']))', t, t);
  end loop;
end $$;

create policy formulas_write_production on public.formulas for all to authenticated
using (public.has_role(array['admin','production']))
with check (public.has_role(array['admin','production']));
create policy formula_components_write_production on public.formula_components for all to authenticated
using (public.has_role(array['admin','production']))
with check (public.has_role(array['admin','production']));
create policy production_requests_write_ops on public.production_requests for all to authenticated
using (public.has_role(array['admin','pharmacy','production']))
with check (public.has_role(array['admin','pharmacy','production']));
create policy production_orders_write_production on public.production_orders for all to authenticated
using (public.has_role(array['admin','production']))
with check (public.has_role(array['admin','production']));
create policy material_issues_write_production on public.production_material_issues for all to authenticated
using (public.has_role(array['admin','production','inventory']))
with check (public.has_role(array['admin','production','inventory']));
create policy production_qc_write_production on public.production_qc for all to authenticated
using (public.has_role(array['admin','production']))
with check (public.has_role(array['admin','production']));
create policy finished_receipts_write_ops on public.finished_goods_receipts for all to authenticated
using (public.has_role(array['admin','production','inventory']))
with check (public.has_role(array['admin','production','inventory']));
create policy import_batches_write_admin_production on public.import_batches for all to authenticated
using (public.has_role(array['admin','production','inventory']))
with check (public.has_role(array['admin','production','inventory']));
create policy import_rows_write_admin_production on public.import_rows for all to authenticated
using (public.has_role(array['admin','production','inventory']))
with check (public.has_role(array['admin','production','inventory']));

grant select, insert, update, delete on public.formulas, public.formula_components, public.production_requests, public.production_orders, public.production_material_issues, public.production_qc, public.finished_goods_receipts, public.import_batches, public.import_rows to authenticated;

commit;

select 'CHANANYA_PRODUCTION_AND_SHEET_IMPORT_READY' as status;
