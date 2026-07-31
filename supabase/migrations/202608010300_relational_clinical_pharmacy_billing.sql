begin;

create extension if not exists pgcrypto;

-- ============================================================
-- ROLE MODEL
-- ============================================================
update public.profiles
set role = 'viewer'
where role is null
   or role not in ('admin','practitioner','reception','pharmacy','inventory','billing','viewer');

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin','practitioner','reception','pharmacy','inventory','billing','viewer'));

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer');
$$;

revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated, service_role;

create or replace function public.has_role(allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() = any(allowed);
$$;

revoke all on function public.has_role(text[]) from public;
grant execute on function public.has_role(text[]) to authenticated, service_role;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================
-- MASTER DATA
-- ============================================================
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  hn text not null unique,
  national_id text,
  prefix text,
  first_name text not null,
  last_name text not null,
  gender text,
  date_of_birth date,
  phone text,
  email text,
  address text,
  occupation text,
  marital_status text,
  nationality text,
  religion text,
  payment_right text,
  emergency_contact_name text,
  emergency_contact_relation text,
  emergency_contact_phone text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.patient_allergies (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  allergen_type text not null,
  allergen_name text not null,
  reaction text,
  severity text,
  status text not null default 'active',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_code text unique,
  name text not null,
  tax_id text,
  phone text,
  email text,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name_th text not null,
  name_en text,
  category text not null,
  dosage_form text,
  purchase_unit text,
  stock_unit text not null,
  dispense_unit text not null,
  conversion_factor numeric(18,6) not null default 1,
  standard_cost numeric(18,2) not null default 0,
  tax_rate numeric(7,4) not null default 0,
  min_stock numeric(18,4) not null default 0,
  reorder_level numeric(18,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  service_code text not null unique,
  name_th text not null,
  name_en text,
  category text not null,
  duration_minutes integer,
  default_room text,
  practitioner_role text,
  tax_rate numeric(7,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  effective_from date not null,
  effective_to date,
  customer_type text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.price_list_items (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references public.price_lists(id) on delete cascade,
  item_type text not null check (item_type in ('product','service')),
  product_id uuid references public.products(id) on delete cascade,
  service_id uuid references public.services(id) on delete cascade,
  unit_price numeric(18,2) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(price_list_id, item_type, product_id, service_id),
  check ((item_type='product' and product_id is not null and service_id is null)
      or (item_type='service' and service_id is not null and product_id is null))
);

-- ============================================================
-- CLINICAL
-- ============================================================
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete restrict,
  appointment_date date not null,
  appointment_time time,
  service_id uuid references public.services(id) on delete set null,
  practitioner_id uuid references auth.users(id) on delete set null,
  room text,
  status text not null default 'scheduled',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.encounters (
  id uuid primary key default gen_random_uuid(),
  encounter_no text not null unique,
  patient_id uuid not null references public.patients(id) on delete restrict,
  appointment_id uuid references public.appointments(id) on delete set null,
  encounter_type text not null default 'opd',
  status text not null default 'draft',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  chief_complaint text,
  present_illness text,
  past_history text,
  family_history text,
  personal_history text,
  current_medications text,
  red_flags text,
  general_examination text,
  problem_summary text,
  modern_diagnosis text,
  thai_diagnosis text,
  element_principle text,
  seasonal_principle text,
  age_principle text,
  time_principle text,
  geographical_principle text,
  practitioner_id uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vital_signs (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  measured_at timestamptz not null default now(),
  temperature numeric(5,2),
  pulse integer,
  respiration integer,
  systolic_bp integer,
  diastolic_bp integer,
  spo2 numeric(5,2),
  height_cm numeric(7,2),
  weight_kg numeric(7,2),
  bmi numeric(7,2),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.pain_assessments (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  assessment_stage text not null check (assessment_stage in ('before','after','followup')),
  score integer not null check (score between 0 and 10),
  notes text,
  assessed_at timestamptz not null default now(),
  assessed_by uuid references auth.users(id) on delete set null
);

create table if not exists public.pain_markers (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  body_view text not null,
  x_percent numeric(7,4) not null check (x_percent between 0 and 100),
  y_percent numeric(7,4) not null check (y_percent between 0 and 100),
  symptom_type text,
  severity integer check (severity between 0 and 10),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.intermediate_care_assessments (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null unique references public.encounters(id) on delete cascade,
  care_path text,
  principal_diagnosis text,
  comorbidity_diagnosis text,
  stroke_type text,
  nihss_score numeric(6,2),
  facial_palsy_admit text,
  facial_palsy_discharge text,
  dysarthria_admit text,
  dysarthria_discharge text,
  dysphagia_status text,
  ng_tube_status text,
  ng_tube_on_date date,
  ng_tube_off_date date,
  swallowing_test_result text,
  swallowing_volume_ml numeric(10,2),
  complication_notes text,
  rehabilitation_goals text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.barthel_assessments (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  assessment_stage text not null,
  assessment_date date not null default current_date,
  feeding integer,
  transfer integer,
  grooming integer,
  toilet_use integer,
  bathing integer,
  mobility integer,
  stairs integer,
  dressing integer,
  bowels integer,
  bladder integer,
  total_score integer generated always as (
    coalesce(feeding,0)+coalesce(transfer,0)+coalesce(grooming,0)+coalesce(toilet_use,0)+
    coalesce(bathing,0)+coalesce(mobility,0)+coalesce(stairs,0)+coalesce(dressing,0)+
    coalesce(bowels,0)+coalesce(bladder,0)
  ) stored,
  assessed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.treatment_orders (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  order_type text not null,
  instructions text,
  frequency text,
  duration text,
  treatment_area text,
  status text not null default 'ordered',
  ordered_by uuid references auth.users(id) on delete set null,
  ordered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.treatment_sessions (
  id uuid primary key default gen_random_uuid(),
  treatment_order_id uuid references public.treatment_orders(id) on delete set null,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  room text,
  practitioner_id uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  actual_duration_minutes integer,
  treatment_area text,
  procedure_notes text,
  adverse_event text,
  outcome text,
  status text not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  next_visit_date date,
  next_visit_time time,
  advice text,
  outcome text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- PHARMACY / INVENTORY
-- ============================================================
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  prescription_no text not null unique,
  encounter_id uuid not null references public.encounters(id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete restrict,
  prescriber_id uuid references auth.users(id) on delete set null,
  status text not null default 'draft',
  clinical_notes text,
  prescribed_at timestamptz not null default now(),
  sent_to_pharmacy_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  formula_name text,
  dose text,
  frequency text,
  duration text,
  route text,
  quantity_prescribed numeric(18,4) not null,
  unit text not null,
  instructions text,
  precautions text,
  substitution_allowed boolean not null default false,
  status text not null default 'ordered',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete set null,
  lot_number text not null,
  manufacture_date date,
  expiry_date date,
  received_quantity numeric(18,4) not null default 0,
  current_quantity numeric(18,4) not null default 0,
  unit text not null,
  purchase_cost numeric(18,2) not null default 0,
  storage_location text,
  status text not null default 'active',
  received_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, lot_number)
);

create table if not exists public.dispensing_orders (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null unique references public.prescriptions(id) on delete restrict,
  queue_number text,
  status text not null default 'waiting',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  prepared_by uuid references auth.users(id) on delete set null,
  prepared_at timestamptz,
  dispensed_by uuid references auth.users(id) on delete set null,
  dispensed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dispensing_items (
  id uuid primary key default gen_random_uuid(),
  dispensing_order_id uuid not null references public.dispensing_orders(id) on delete cascade,
  prescription_item_id uuid not null references public.prescription_items(id) on delete restrict,
  inventory_lot_id uuid references public.inventory_lots(id) on delete restrict,
  quantity_dispensed numeric(18,4) not null default 0,
  unit text not null,
  unit_price numeric(18,2) not null default 0,
  status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  inventory_lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  movement_type text not null,
  quantity numeric(18,4) not null check (quantity > 0),
  direction text not null check (direction in ('in','out')),
  reference_type text,
  reference_id uuid,
  reason text,
  performed_by uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'in' then
    update public.inventory_lots
       set current_quantity = current_quantity + new.quantity,
           updated_at = now()
     where id = new.inventory_lot_id;
  else
    update public.inventory_lots
       set current_quantity = current_quantity - new.quantity,
           updated_at = now()
     where id = new.inventory_lot_id
       and current_quantity >= new.quantity;
    if not found then
      raise exception 'Insufficient stock for lot %', new.inventory_lot_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movement_apply on public.stock_movements;
create trigger stock_movement_apply
after insert on public.stock_movements
for each row execute function public.apply_stock_movement();

-- ============================================================
-- BILLING / PAYMENT
-- ============================================================
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  patient_id uuid not null references public.patients(id) on delete restrict,
  encounter_id uuid references public.encounters(id) on delete set null,
  price_list_id uuid references public.price_lists(id) on delete set null,
  status text not null default 'draft',
  subtotal numeric(18,2) not null default 0,
  discount_total numeric(18,2) not null default 0,
  tax_total numeric(18,2) not null default 0,
  rounding numeric(18,2) not null default 0,
  grand_total numeric(18,2) not null default 0,
  paid_amount numeric(18,2) not null default 0,
  balance_due numeric(18,2) not null default 0,
  issued_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  item_type text not null,
  service_id uuid references public.services(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  treatment_session_id uuid references public.treatment_sessions(id) on delete set null,
  dispensing_item_id uuid references public.dispensing_items(id) on delete set null,
  description text not null,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  discount_amount numeric(18,2) not null default 0,
  tax_amount numeric(18,2) not null default 0,
  line_total numeric(18,2) not null default 0,
  cost_snapshot numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  payment_reference text not null unique,
  provider text not null default 'manual',
  channel text not null,
  amount numeric(18,2) not null check (amount > 0),
  currency text not null default 'THB',
  status text not null default 'created',
  gateway_transaction_id text,
  requested_at timestamptz not null default now(),
  paid_at timestamptz,
  failed_at timestamptz,
  raw_callback jsonb not null default '{}'::jsonb,
  received_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists patients_name_idx on public.patients(last_name, first_name);
create index if not exists appointments_date_idx on public.appointments(appointment_date, appointment_time);
create index if not exists encounters_patient_idx on public.encounters(patient_id, started_at desc);
create index if not exists prescriptions_status_idx on public.prescriptions(status, prescribed_at);
create index if not exists dispensing_orders_status_idx on public.dispensing_orders(status, created_at);
create index if not exists inventory_lots_fefo_idx on public.inventory_lots(product_id, expiry_date, current_quantity);
create index if not exists stock_movements_lot_idx on public.stock_movements(inventory_lot_id, occurred_at desc);
create index if not exists invoices_patient_idx on public.invoices(patient_id, created_at desc);
create index if not exists payments_invoice_idx on public.payments(invoice_id, created_at desc);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'patients','patient_allergies','suppliers','products','services','price_lists',
    'appointments','encounters','intermediate_care_assessments','treatment_orders',
    'treatment_sessions','followups','prescriptions','prescription_items','inventory_lots',
    'dispensing_orders','dispensing_items','invoices','payments'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================
-- RLS
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'patients','patient_allergies','suppliers','products','services','price_lists','price_list_items',
    'appointments','encounters','vital_signs','pain_assessments','pain_markers',
    'intermediate_care_assessments','barthel_assessments','treatment_orders','treatment_sessions','followups',
    'prescriptions','prescription_items','inventory_lots','dispensing_orders','dispensing_items','stock_movements',
    'invoices','invoice_items','payments'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read_staff on public.%I', t, t);
    execute format(
      'create policy %I_read_staff on public.%I for select to authenticated using (public.has_role(array[''admin'',''practitioner'',''reception'',''pharmacy'',''inventory'',''billing'',''viewer'']))',
      t, t
    );
  end loop;
end $$;

-- patient registration
create policy patients_write_staff on public.patients for all to authenticated
using (public.has_role(array['admin','practitioner','reception']))
with check (public.has_role(array['admin','practitioner','reception']));
create policy patient_allergies_write_clinical on public.patient_allergies for all to authenticated
using (public.has_role(array['admin','practitioner']))
with check (public.has_role(array['admin','practitioner']));
create policy appointments_write_staff on public.appointments for all to authenticated
using (public.has_role(array['admin','practitioner','reception']))
with check (public.has_role(array['admin','practitioner','reception']));

-- clinical records
create policy encounters_write_clinical on public.encounters for all to authenticated
using (public.has_role(array['admin','practitioner']))
with check (public.has_role(array['admin','practitioner']));

do $$
declare
  t text;
begin
  foreach t in array array[
    'vital_signs','pain_assessments','pain_markers','intermediate_care_assessments',
    'barthel_assessments','treatment_orders','treatment_sessions','followups'
  ] loop
    execute format('drop policy if exists %I_write_clinical on public.%I', t, t);
    execute format(
      'create policy %I_write_clinical on public.%I for all to authenticated using (public.has_role(array[''admin'',''practitioner''])) with check (public.has_role(array[''admin'',''practitioner'']))',
      t, t
    );
  end loop;
end $$;

-- pharmacy and inventory
create policy prescriptions_write_clinical_pharmacy on public.prescriptions for all to authenticated
using (public.has_role(array['admin','practitioner','pharmacy']))
with check (public.has_role(array['admin','practitioner','pharmacy']));
create policy prescription_items_write_clinical_pharmacy on public.prescription_items for all to authenticated
using (public.has_role(array['admin','practitioner','pharmacy']))
with check (public.has_role(array['admin','practitioner','pharmacy']));
create policy dispensing_orders_write_pharmacy on public.dispensing_orders for all to authenticated
using (public.has_role(array['admin','pharmacy']))
with check (public.has_role(array['admin','pharmacy']));
create policy dispensing_items_write_pharmacy on public.dispensing_items for all to authenticated
using (public.has_role(array['admin','pharmacy']))
with check (public.has_role(array['admin','pharmacy']));
create policy inventory_lots_write_inventory on public.inventory_lots for all to authenticated
using (public.has_role(array['admin','pharmacy','inventory']))
with check (public.has_role(array['admin','pharmacy','inventory']));
create policy stock_movements_write_inventory on public.stock_movements for insert to authenticated
with check (public.has_role(array['admin','pharmacy','inventory']));
create policy products_write_inventory on public.products for all to authenticated
using (public.has_role(array['admin','pharmacy','inventory']))
with check (public.has_role(array['admin','pharmacy','inventory']));
create policy suppliers_write_inventory on public.suppliers for all to authenticated
using (public.has_role(array['admin','inventory']))
with check (public.has_role(array['admin','inventory']));

-- pricing and billing
create policy services_write_admin_billing on public.services for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));
create policy price_lists_write_admin_billing on public.price_lists for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));
create policy price_list_items_write_admin_billing on public.price_list_items for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));
create policy invoices_write_billing on public.invoices for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));
create policy invoice_items_write_billing on public.invoice_items for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));
create policy payments_write_billing on public.payments for all to authenticated
using (public.has_role(array['admin','billing']))
with check (public.has_role(array['admin','billing']));

-- ============================================================
-- GRANTS
-- ============================================================
grant usage on schema public to authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'patients','patient_allergies','suppliers','products','services','price_lists','price_list_items',
    'appointments','encounters','vital_signs','pain_assessments','pain_markers',
    'intermediate_care_assessments','barthel_assessments','treatment_orders','treatment_sessions','followups',
    'prescriptions','prescription_items','inventory_lots','dispensing_orders','dispensing_items','stock_movements',
    'invoices','invoice_items','payments'
  ] loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('grant all privileges on table public.%I to service_role', t);
  end loop;
end $$;

grant usage, select on all sequences in schema public to authenticated;
grant all privileges on all sequences in schema public to service_role;

revoke all on function public.apply_stock_movement() from public;
grant execute on function public.apply_stock_movement() to service_role;

-- ============================================================
-- STARTER MASTER DATA
-- ============================================================
insert into public.services(service_code,name_th,name_en,category,duration_minutes)
values
  ('CONSULT-TTM','ตรวจและวินิจฉัยการแพทย์แผนไทย','Thai Traditional Medicine Consultation','consultation',30),
  ('MASSAGE-60','นวดไทยเพื่อการรักษา 60 นาที','Therapeutic Thai Massage 60 min','treatment',60),
  ('COMPRESS','ประคบสมุนไพร','Thai Herbal Compress','treatment',30),
  ('STEAM','อบสมุนไพร','Herbal Steam','treatment',30),
  ('FOLLOWUP','ติดตามผล','Clinical Follow-up','followup',20)
on conflict(service_code) do nothing;

insert into public.price_lists(code,name,effective_from,customer_type)
values ('STANDARD','ราคามาตรฐาน',current_date,'general')
on conflict(code) do nothing;

commit;

select 'CHANANYA_RELATIONAL_CLINICAL_PHARMACY_BILLING_READY' as migration_status,
       now() as verified_at;
