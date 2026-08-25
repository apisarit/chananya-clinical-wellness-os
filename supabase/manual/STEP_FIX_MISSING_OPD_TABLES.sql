-- Chananya Clinical OS v3.1
-- STEP: repair missing OPD encounter tables before stabilization installer.
-- Safe to run repeatedly.

begin;

create table if not exists public.ttm_opd_histories (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null unique references public.encounters(id) on delete cascade,
  accident_history text,
  surgery_history text,
  chronic_diseases text,
  family_history text,
  personal_history text,
  food_pattern text,
  water_glasses_per_day numeric(6,2),
  tea_coffee_glasses_per_day numeric(6,2),
  smoking_detail text,
  alcohol_detail text,
  urination_per_day numeric(6,2),
  bowel_movement_per_day numeric(6,2),
  sleep_detail text,
  posture_detail text,
  emotional_state text,
  allergy_food_drug text,
  menstruation_detail text,
  current_medicines_supplements text,
  physical_exam_narrative text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clinical_treatment_sessions (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  session_no integer not null default 1,
  treated_at timestamptz not null default now(),
  treatment_modalities text[] not null default '{}',
  treatment_detail text not null,
  procedure_referral boolean not null default false,
  procedure_referral_detail text,
  precautions text,
  pain_before smallint check (pain_before is null or pain_before between 0 and 10),
  pain_after smallint check (pain_after is null or pain_after between 0 and 10),
  outcome_summary text,
  advice text,
  practitioner_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(encounter_id, session_no)
);

create index if not exists idx_ttm_opd_history_encounter
  on public.ttm_opd_histories(encounter_id);
create index if not exists idx_treatment_session_encounter
  on public.clinical_treatment_sessions(encounter_id, session_no);

alter table public.ttm_opd_histories enable row level security;
alter table public.clinical_treatment_sessions enable row level security;

drop policy if exists ttm_opd_histories_read on public.ttm_opd_histories;
create policy ttm_opd_histories_read on public.ttm_opd_histories
for select to authenticated
using (public.has_role(array['admin','practitioner','pharmacy']));

drop policy if exists ttm_opd_histories_write on public.ttm_opd_histories;
create policy ttm_opd_histories_write on public.ttm_opd_histories
for all to authenticated
using (public.has_role(array['admin','practitioner']))
with check (public.has_role(array['admin','practitioner']));

drop policy if exists clinical_treatment_sessions_read on public.clinical_treatment_sessions;
create policy clinical_treatment_sessions_read on public.clinical_treatment_sessions
for select to authenticated
using (public.has_role(array['admin','practitioner','pharmacy']));

drop policy if exists clinical_treatment_sessions_write on public.clinical_treatment_sessions;
create policy clinical_treatment_sessions_write on public.clinical_treatment_sessions
for all to authenticated
using (public.has_role(array['admin','practitioner']))
with check (public.has_role(array['admin','practitioner']));

grant select,insert,update,delete on public.ttm_opd_histories to authenticated;
grant select,insert,update,delete on public.clinical_treatment_sessions to authenticated;

commit;

select
  'CHANANYA_MISSING_OPD_TABLES_FIXED' as status,
  to_regclass('public.ttm_opd_histories') as opd_history_table,
  to_regclass('public.clinical_treatment_sessions') as treatment_sessions_table;
