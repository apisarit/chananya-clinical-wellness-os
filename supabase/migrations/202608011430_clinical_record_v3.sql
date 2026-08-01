begin;

create extension if not exists pgcrypto;

create table if not exists public.clinical_examination_findings (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  sequence_no integer not null default 1,
  body_region text not null,
  side text not null default 'midline' check (side in ('left','right','bilateral','midline','not_applicable')),
  tenderness boolean not null default false,
  swelling boolean not null default false,
  warmth boolean not null default false,
  redness boolean not null default false,
  numbness boolean not null default false,
  muscle_tightness boolean not null default false,
  range_of_motion text check (range_of_motion is null or range_of_motion in ('normal','limited','painful','unable','not_assessed')),
  movement_notes text,
  abnormal_finding text,
  identified_problem text,
  severity smallint check (severity is null or severity between 0 and 10),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clinical_exam_encounter on public.clinical_examination_findings(encounter_id, sequence_no);
create index if not exists idx_clinical_exam_region on public.clinical_examination_findings(body_region, side);

create table if not exists public.ttm_structured_diagnoses (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null unique references public.encounters(id) on delete cascade,
  dhatu_samutthan text,
  utu_samutthan text,
  ayu_samutthan text,
  kala_samutthan text,
  pradesa_samutthan text,
  birth_constitution text,
  present_constitution text,
  disease_causes text[] not null default '{}',
  food_cause text,
  posture_cause text,
  climate_cause text,
  lifestyle_cause text,
  emotional_cause text,
  other_cause text,
  symptom_mechanism text,
  analysis_summary text not null,
  thai_diagnosis text not null,
  differential_diagnosis text,
  diagnostic_confidence text check (diagnostic_confidence is null or diagnostic_confidence in ('low','moderate','high')),
  diagnosed_by uuid references auth.users(id),
  diagnosed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clinical_treatment_plans (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  plan_number text,
  goal_1 text,
  goal_2 text,
  goal_3 text,
  frequency_per_week numeric(6,2),
  planned_duration_weeks numeric(6,2),
  planned_sessions integer,
  precautions text,
  treatment_modalities text[] not null default '{}',
  target_areas text[] not null default '{}',
  herbal_plan text,
  home_program text,
  status text not null default 'active' check (status in ('draft','active','completed','cancelled')),
  planned_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_treatment_plan_encounter on public.clinical_treatment_plans(encounter_id, status);

create table if not exists public.body_pain_points (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  assessment_stage text not null check (assessment_stage in ('before','after','followup')),
  body_view text not null check (body_view in ('front','back','left','right')),
  x_percent numeric(5,2) not null check (x_percent between 0 and 100),
  y_percent numeric(5,2) not null check (y_percent between 0 and 100),
  symptom_type text not null check (symptom_type in ('pain','numbness','tightness','burning','swelling','weakness','other')),
  pain_score smallint check (pain_score is null or pain_score between 0 and 10),
  notes text,
  recorded_by uuid references auth.users(id),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_body_pain_encounter on public.body_pain_points(encounter_id, assessment_stage);

create table if not exists public.clinical_followup_notes (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  followup_date date not null default current_date,
  current_symptoms text,
  change_from_previous text,
  pain_score smallint check (pain_score is null or pain_score between 0 and 10),
  functional_status text,
  outcome_status text check (outcome_status is null or outcome_status in ('improved','unchanged','worse','resolved','unknown')),
  plan_adjustment text,
  next_appointment_at timestamptz,
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.clinical_record_signoffs (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  record_section text not null check (record_section in ('examination','diagnosis','treatment_plan','session','followup','complete_record')),
  signer_id uuid not null references auth.users(id),
  signer_name text,
  professional_license_no text,
  signed_at timestamptz not null default now(),
  lock_record boolean not null default true,
  reason text,
  unique(encounter_id, record_section)
);

create or replace view public.v_clinical_herbal_traceability as
select
  e.id as encounter_id,
  p.id as prescription_id,
  p.prescription_no,
  pr.id as product_id,
  pr.sku,
  pr.name_th as medicine_name,
  di.quantity_dispensed,
  di.unit,
  il.lot_number,
  il.expiry_date,
  d.dispensed_by,
  d.dispensed_at
from public.encounters e
join public.prescriptions p on p.encounter_id = e.id
join public.dispensing_orders d on d.prescription_id = p.id
join public.dispensing_items di on di.dispensing_order_id = d.id
left join public.prescription_items pi on pi.id = di.prescription_item_id
left join public.products pr on pr.id = pi.product_id
left join public.inventory_lots il on il.id = di.inventory_lot_id;

alter table public.clinical_examination_findings enable row level security;
alter table public.ttm_structured_diagnoses enable row level security;
alter table public.clinical_treatment_plans enable row level security;
alter table public.body_pain_points enable row level security;
alter table public.clinical_followup_notes enable row level security;
alter table public.clinical_record_signoffs enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'clinical_examination_findings',
    'ttm_structured_diagnoses',
    'clinical_treatment_plans',
    'body_pain_points',
    'clinical_followup_notes',
    'clinical_record_signoffs'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated using (public.has_role(array[''admin'',''practitioner'',''pharmacy'']))', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (public.has_role(array[''admin'',''practitioner''])) with check (public.has_role(array[''admin'',''practitioner'']))', t, t);
  end loop;
end $$;

grant select, insert, update, delete on public.clinical_examination_findings to authenticated;
grant select, insert, update, delete on public.ttm_structured_diagnoses to authenticated;
grant select, insert, update, delete on public.clinical_treatment_plans to authenticated;
grant select, insert, update, delete on public.body_pain_points to authenticated;
grant select, insert, update, delete on public.clinical_followup_notes to authenticated;
grant select, insert, update, delete on public.clinical_record_signoffs to authenticated;
grant select on public.v_clinical_herbal_traceability to authenticated;

commit;

select
  'CHANANYA_CLINICAL_RECORD_V3_READY' as status,
  6 as structured_modules_created;
