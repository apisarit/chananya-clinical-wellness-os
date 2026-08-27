begin;

create extension if not exists pgcrypto;

-- ============================================================
-- CHANANYA HYBRID PATIENT IDENTITY
--
-- Digital-first, never digital-only:
--   LINE identity -> short-lived one-time QR -> staff confirmation
--   HN / demographic / guardian verification -> same encounter path
--
-- Privacy boundaries:
--   * LINE subject IDs and QR credentials are never stored in plaintext.
--   * QR payloads contain no HN, name, national ID, or clinical data.
--   * Patient identity confirmation and encounter creation are atomic.
--   * Existing HN records are preserved as the legacy/no-phone path.
-- ============================================================

-- ============================================================
-- CLINIC / TENANT COMPATIBILITY LAYER
-- ============================================================

create table if not exists public.clinics (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_th text not null,
  name_en text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.clinics (id, code, name_th, name_en)
values (
  '00000000-0000-0000-0000-000000000001',
  'CHANANYA',
  'ชนัญญา คลินิกการแพทย์แผนไทยและสุขภาวะ',
  'Chananya Thai Traditional Medicine & Wellness Clinic'
)
on conflict (id) do nothing;

create table if not exists public.clinic_memberships (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clinic_role text not null,
  is_primary boolean not null default false,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, profile_id),
  check (clinic_role in (
    'owner','admin','practitioner','doctor','reception','pharmacy',
    'billing','inventory','production','viewer'
  ))
);

create unique index if not exists clinic_memberships_one_primary_idx
  on public.clinic_memberships(profile_id)
  where is_primary and active;

insert into public.clinic_memberships (
  clinic_id,
  profile_id,
  clinic_role,
  is_primary
)
select
  '00000000-0000-0000-0000-000000000001'::uuid,
  p.id,
  case
    when coalesce(p.system_role, '') = 'super_admin' then 'owner'
    when coalesce(p.system_role, '') = 'admin' then 'admin'
    when p.role in ('admin','practitioner','doctor','reception','pharmacy','billing','inventory','production','viewer') then p.role
    else 'viewer'
  end,
  true
from public.profiles p
on conflict (clinic_id, profile_id) do nothing;

create or replace function public.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.clinic_id
  from public.clinic_memberships m
  where m.profile_id = auth.uid()
    and m.active
  order by m.is_primary desc, m.joined_at
  limit 1;
$$;

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
  select exists (
    select 1
    from public.clinic_memberships m
    where m.clinic_id = p_clinic_id
      and m.profile_id = auth.uid()
      and m.active
      and (p_allowed_roles is null or m.clinic_role = any(p_allowed_roles))
  );
$$;

revoke all on function public.current_clinic_id() from public;
revoke all on function public.is_clinic_member(uuid,text[]) from public;
grant execute on function public.current_clinic_id() to authenticated, service_role;
grant execute on function public.is_clinic_member(uuid,text[]) to authenticated, service_role;

alter table public.clinics enable row level security;
alter table public.clinic_memberships enable row level security;

drop policy if exists clinics_member_read on public.clinics;
create policy clinics_member_read on public.clinics
for select to authenticated
using (public.is_clinic_member(id));

drop policy if exists clinics_admin_manage on public.clinics;
create policy clinics_admin_manage on public.clinics
for all to authenticated
using (public.is_clinic_member(id, array['owner','admin']))
with check (public.is_clinic_member(id, array['owner','admin']));

drop policy if exists clinic_memberships_member_read on public.clinic_memberships;
create policy clinic_memberships_member_read on public.clinic_memberships
for select to authenticated
using (
  profile_id = auth.uid()
  or public.is_clinic_member(clinic_id, array['owner','admin'])
);

drop policy if exists clinic_memberships_admin_manage on public.clinic_memberships;
create policy clinic_memberships_admin_manage on public.clinic_memberships
for all to authenticated
using (public.is_clinic_member(clinic_id, array['owner','admin']))
with check (public.is_clinic_member(clinic_id, array['owner','admin']));

grant select on public.clinics to authenticated;
grant select on public.clinic_memberships to authenticated;

-- Existing patient and encounter rows belong to the preserved legacy clinic.
alter table public.patients add column if not exists clinic_id uuid;
update public.patients
set clinic_id = '00000000-0000-0000-0000-000000000001'
where clinic_id is null;
alter table public.patients alter column clinic_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'patients_clinic_id_fkey'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table public.patients
      add constraint patients_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
end $$;

alter table public.patients drop constraint if exists patients_hn_key;
create unique index if not exists patients_clinic_hn_uidx
  on public.patients(clinic_id, hn);
create unique index if not exists patients_id_clinic_uidx
  on public.patients(id, clinic_id);

alter table public.patient_allergies add column if not exists clinic_id uuid;
update public.patient_allergies a
set clinic_id = p.clinic_id
from public.patients p
where p.id = a.patient_id
  and a.clinic_id is null;
alter table public.patient_allergies alter column clinic_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'patient_allergies_patient_clinic_fkey'
      and conrelid = 'public.patient_allergies'::regclass
  ) then
    alter table public.patient_allergies
      add constraint patient_allergies_patient_clinic_fkey
      foreign key (patient_id, clinic_id)
      references public.patients(id, clinic_id) on delete cascade;
  end if;
end $$;

alter table public.encounters add column if not exists clinic_id uuid;
update public.encounters e
set clinic_id = p.clinic_id
from public.patients p
where p.id = e.patient_id
  and e.clinic_id is null;
alter table public.encounters alter column clinic_id set not null;
create index if not exists encounters_clinic_started_idx
  on public.encounters(clinic_id, started_at desc);
create unique index if not exists encounters_id_clinic_patient_uidx
  on public.encounters(id, clinic_id, patient_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'encounters_patient_clinic_fkey'
      and conrelid = 'public.encounters'::regclass
  ) then
    alter table public.encounters
      add constraint encounters_patient_clinic_fkey
      foreign key (patient_id, clinic_id)
      references public.patients(id, clinic_id) on delete restrict;
  end if;
end $$;

alter table public.audit_logs add column if not exists clinic_id uuid;
update public.audit_logs
set clinic_id = '00000000-0000-0000-0000-000000000001'
where clinic_id is null;
alter table public.audit_logs alter column clinic_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'audit_logs_clinic_id_fkey'
      and conrelid = 'public.audit_logs'::regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
end $$;

create or replace function public.assign_patient_clinic()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.clinic_id is null then
    new.clinic_id := public.current_clinic_id();
  end if;
  if new.clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_patient_clinic on public.patients;
create trigger trg_assign_patient_clinic
before insert or update of clinic_id on public.patients
for each row execute function public.assign_patient_clinic();

create or replace function public.assign_patient_child_clinic()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select p.clinic_id into v_clinic_id
  from public.patients p
  where p.id = new.patient_id;

  if v_clinic_id is null then
    raise exception 'PATIENT_NOT_FOUND';
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'CROSS_CLINIC_PATIENT_REFERENCE';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_allergy_clinic on public.patient_allergies;
create trigger trg_assign_allergy_clinic
before insert or update of patient_id, clinic_id on public.patient_allergies
for each row execute function public.assign_patient_child_clinic();

drop trigger if exists trg_assign_encounter_clinic on public.encounters;
create trigger trg_assign_encounter_clinic
before insert or update of patient_id, clinic_id on public.encounters
for each row execute function public.assign_patient_child_clinic();

create or replace function public.assign_audit_clinic()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.clinic_id is null then
    new.clinic_id := public.current_clinic_id();
  end if;
  if new.clinic_id is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_audit_clinic on public.audit_logs;
create trigger trg_assign_audit_clinic
before insert on public.audit_logs
for each row execute function public.assign_audit_clinic();

create or replace function public.can_access_patient(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.patients p
    where p.id = p_patient_id
      and public.is_clinic_member(p.clinic_id)
  );
$$;

create or replace function public.can_access_encounter(p_encounter_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.encounters e
    where e.id = p_encounter_id
      and public.is_clinic_member(e.clinic_id)
  );
$$;

create or replace function public.can_access_prescription(p_prescription_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.prescriptions rx
    where rx.id = p_prescription_id
      and public.can_access_patient(rx.patient_id)
      and public.can_access_encounter(rx.encounter_id)
  );
$$;

create or replace function public.can_access_invoice(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.invoices i
    where i.id = p_invoice_id
      and public.can_access_patient(i.patient_id)
      and (i.encounter_id is null or public.can_access_encounter(i.encounter_id))
  );
$$;

revoke all on function public.can_access_patient(uuid) from public;
revoke all on function public.can_access_encounter(uuid) from public;
revoke all on function public.can_access_prescription(uuid) from public;
revoke all on function public.can_access_invoice(uuid) from public;
grant execute on function public.can_access_patient(uuid) to authenticated, service_role;
grant execute on function public.can_access_encounter(uuid) to authenticated, service_role;
grant execute on function public.can_access_prescription(uuid) to authenticated, service_role;
grant execute on function public.can_access_invoice(uuid) to authenticated, service_role;

-- Restrictive policies are ANDed with existing role policies. They preserve
-- operational permissions while preventing cross-clinic PHI access.
drop policy if exists patients_tenant_boundary on public.patients;
create policy patients_tenant_boundary
on public.patients as restrictive
for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));

drop policy if exists patient_allergies_tenant_boundary on public.patient_allergies;
create policy patient_allergies_tenant_boundary
on public.patient_allergies as restrictive
for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));

drop policy if exists encounters_tenant_boundary on public.encounters;
create policy encounters_tenant_boundary
on public.encounters as restrictive
for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));

drop policy if exists audit_logs_tenant_boundary on public.audit_logs;
create policy audit_logs_tenant_boundary
on public.audit_logs as restrictive
for all to authenticated
using (clinic_id is not null and public.is_clinic_member(clinic_id))
with check (clinic_id is not null and public.is_clinic_member(clinic_id));

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('appointments', 'public.can_access_patient(patient_id)'),
      ('vital_signs', 'public.can_access_encounter(encounter_id)'),
      ('pain_assessments', 'public.can_access_encounter(encounter_id)'),
      ('pain_markers', 'public.can_access_encounter(encounter_id)'),
      ('intermediate_care_assessments', 'public.can_access_encounter(encounter_id)'),
      ('barthel_assessments', 'public.can_access_encounter(encounter_id)'),
      ('treatment_orders', 'public.can_access_encounter(encounter_id)'),
      ('treatment_sessions', 'public.can_access_encounter(encounter_id)'),
      ('followups', 'public.can_access_encounter(encounter_id)'),
      ('ttm_opd_histories', 'public.can_access_encounter(encounter_id)'),
      ('clinical_treatment_sessions', 'public.can_access_encounter(encounter_id)'),
      ('clinical_examination_findings', 'public.can_access_encounter(encounter_id)'),
      ('ttm_structured_diagnoses', 'public.can_access_encounter(encounter_id)'),
      ('ttm_diagnostic_contexts', 'public.can_access_encounter(encounter_id)'),
      ('clinical_treatment_plans', 'public.can_access_encounter(encounter_id)'),
      ('clinical_followup_notes', 'public.can_access_encounter(encounter_id)'),
      ('clinical_record_signoffs', 'public.can_access_encounter(encounter_id)'),
      ('clinical_record_audit_events', 'public.can_access_encounter(encounter_id)'),
      ('body_pain_points', 'public.can_access_encounter(encounter_id)'),
      ('ttm_encounter_concepts', 'public.can_access_encounter(encounter_id)'),
      ('prescriptions', 'public.can_access_patient(patient_id) and public.can_access_encounter(encounter_id)'),
      ('prescription_items', 'public.can_access_prescription(prescription_id)'),
      ('dispensing_orders', 'public.can_access_prescription(prescription_id)'),
      ('dispensing_items', 'exists (select 1 from public.dispensing_orders d where d.id = dispensing_order_id and public.can_access_prescription(d.prescription_id))'),
      ('invoices', 'public.can_access_patient(patient_id) and (encounter_id is null or public.can_access_encounter(encounter_id))'),
      ('invoice_items', 'public.can_access_invoice(invoice_id)'),
      ('payments', 'public.can_access_invoice(invoice_id)'),
      ('clinic_appointments', 'public.can_access_patient(patient_id)'),
      ('appointment_audit_events', 'exists (select 1 from public.clinic_appointments a where a.id = appointment_id and public.can_access_patient(a.patient_id))'),
      ('patient_user_links', 'public.can_access_patient(patient_id)')
    ) as boundaries(table_name, predicate)
  loop
    if to_regclass('public.' || r.table_name) is not null then
      execute format('drop policy if exists %I_tenant_boundary on public.%I', r.table_name, r.table_name);
      execute format(
        'create policy %I_tenant_boundary on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
        r.table_name,
        r.table_name,
        r.predicate,
        r.predicate
      );
    end if;
  end loop;
end $$;

-- ============================================================
-- SERVER-AUTHORITATIVE HN AND ENCOUNTER NUMBERS
-- ============================================================

create table if not exists public.clinic_counters (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  counter_name text not null,
  last_value bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, counter_name)
);

alter table public.clinic_counters enable row level security;
revoke all on public.clinic_counters from anon, authenticated;

-- Continue above every numeric legacy suffix so activation cannot reissue an
-- HN that already exists, regardless of the legacy prefix format.
insert into public.clinic_counters (
  clinic_id, counter_name, last_value, updated_at
)
select
  p.clinic_id,
  'patient_hn',
  coalesce(max(
    case
      when substring(p.hn from '([0-9]+)$') ~ '^[0-9]{1,18}$'
      then substring(p.hn from '([0-9]+)$')::bigint
      else 0
    end
  ), 0),
  now()
from public.patients p
group by p.clinic_id
on conflict (clinic_id, counter_name)
do update set
  last_value = greatest(
    public.clinic_counters.last_value,
    excluded.last_value
  ),
  updated_at = now();

create or replace function public.next_clinic_counter(
  p_clinic_id uuid,
  p_counter_name text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_value bigint;
begin
  insert into public.clinic_counters (clinic_id, counter_name, last_value)
  values (p_clinic_id, p_counter_name, 1)
  on conflict (clinic_id, counter_name)
  do update set
    last_value = public.clinic_counters.last_value + 1,
    updated_at = now()
  returning last_value into v_value;
  return v_value;
end;
$$;

revoke all on function public.next_clinic_counter(uuid,text) from public;

create sequence if not exists public.encounter_number_seq;

select setval(
  'public.encounter_number_seq',
  coalesce(max(substring(e.encounter_no from '([0-9]+)$')::bigint), 0) + 1,
  false
)
from public.encounters e
where e.encounter_no ~ '^ENC-[0-9]{8}-[0-9]{1,18}$';

create or replace function public.next_encounter_number()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'ENC-' || to_char(current_date, 'YYYYMMDD') || '-' ||
    lpad(nextval('public.encounter_number_seq')::text, 8, '0');
$$;

revoke all on function public.next_encounter_number() from public;

-- ============================================================
-- IDENTITY, CONSENT, ONE-TIME QR, AND AUDIT TABLES
-- ============================================================

create table if not exists public.patient_identity_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  provider text not null default 'line' check (provider in ('line')),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  link_type text not null default 'self' check (link_type in ('self','guardian')),
  relation_label text,
  status text not null default 'active' check (status in ('active','revoked')),
  staff_consent_confirmed_at timestamptz not null,
  staff_consent_recorded_by uuid not null references public.profiles(id) on delete restrict,
  subject_consent_confirmed_at timestamptz not null,
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_identity_links_patient_provider_subject_key
    unique (patient_id, provider, subject_hash),
  unique (id, clinic_id, patient_id),
  foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id) on delete cascade,
  check (link_type <> 'guardian' or nullif(btrim(relation_label), '') is not null),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index if not exists patient_identity_one_self_subject_idx
  on public.patient_identity_links(clinic_id, provider, subject_hash)
  where link_type = 'self' and status = 'active';
create unique index if not exists patient_identity_one_active_self_patient_idx
  on public.patient_identity_links(clinic_id, patient_id, provider)
  where link_type = 'self' and status = 'active';
create index if not exists patient_identity_links_patient_idx
  on public.patient_identity_links(clinic_id, patient_id, status);

create table if not exists public.patient_identity_link_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  link_type text not null default 'self' check (link_type in ('self','guardian')),
  relation_label text,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  invalidated_at timestamptz,
  staff_consent_confirmed_at timestamptz not null,
  issued_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id) on delete cascade,
  check (link_type <> 'guardian' or nullif(btrim(relation_label), '') is not null),
  check (expires_at > created_at),
  check (claimed_at is null or invalidated_at is null)
);

create index if not exists patient_identity_link_requests_active_idx
  on public.patient_identity_link_requests(clinic_id, patient_id, expires_at desc);

create table if not exists public.patient_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  identity_link_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  display_code_hash text not null check (display_code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  used_by uuid references public.profiles(id) on delete set null,
  encounter_id uuid,
  created_at timestamptz not null default now(),
  unique (id, clinic_id, patient_id),
  foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id) on delete cascade,
  foreign key (identity_link_id, clinic_id, patient_id)
    references public.patient_identity_links(id, clinic_id, patient_id) on delete cascade,
  foreign key (encounter_id, clinic_id, patient_id)
    references public.encounters(id, clinic_id, patient_id) on delete restrict,
  check (expires_at > created_at),
  check (
    (used_at is null and used_by is null and encounter_id is null)
    or (used_at is not null and used_by is not null and encounter_id is not null)
  )
);

create index if not exists patient_qr_sessions_code_idx
  on public.patient_qr_sessions(display_code_hash, expires_at desc);
create index if not exists patient_qr_sessions_patient_idx
  on public.patient_qr_sessions(clinic_id, patient_id, created_at desc);

create table if not exists public.encounter_identity_verifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  encounter_id uuid not null unique,
  patient_id uuid not null,
  verification_method text not null check (verification_method in (
    'line_qr','manual_hn','government_id','demographic_match','guardian_attestation'
  )),
  qr_session_id uuid,
  patient_present_confirmed boolean not null,
  verification_note text,
  verified_by uuid not null references public.profiles(id) on delete restrict,
  verified_at timestamptz not null default now(),
  foreign key (encounter_id, clinic_id, patient_id)
    references public.encounters(id, clinic_id, patient_id) on delete cascade,
  foreign key (qr_session_id, clinic_id, patient_id)
    references public.patient_qr_sessions(id, clinic_id, patient_id) on delete restrict,
  check (patient_present_confirmed),
  check (
    (verification_method = 'line_qr' and qr_session_id is not null)
    or (verification_method <> 'line_qr' and qr_session_id is null)
  ),
  check (
    verification_method <> 'guardian_attestation'
    or nullif(btrim(verification_note), '') is not null
  )
);

create table if not exists public.patient_identity_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete set null,
  event_type text not null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  identity_link_id uuid references public.patient_identity_links(id) on delete set null,
  qr_session_id uuid references public.patient_qr_sessions(id) on delete set null,
  encounter_id uuid references public.encounters(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists patient_identity_events_clinic_idx
  on public.patient_identity_events(clinic_id, occurred_at desc);
create index if not exists patient_identity_events_patient_idx
  on public.patient_identity_events(patient_id, occurred_at desc);

create table if not exists public.patient_identity_rate_limits (
  bucket_key text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.patient_identity_links enable row level security;
alter table public.patient_identity_link_requests enable row level security;
alter table public.patient_qr_sessions enable row level security;
alter table public.encounter_identity_verifications enable row level security;
alter table public.patient_identity_events enable row level security;
alter table public.patient_identity_rate_limits enable row level security;

revoke all on public.patient_identity_links from anon, authenticated;
revoke all on public.patient_identity_link_requests from anon, authenticated;
revoke all on public.patient_qr_sessions from anon, authenticated;
revoke all on public.patient_identity_rate_limits from anon, authenticated;

drop policy if exists encounter_identity_verifications_read on public.encounter_identity_verifications;
create policy encounter_identity_verifications_read
on public.encounter_identity_verifications for select to authenticated
using (
  public.is_clinic_member(clinic_id, array['owner','admin','practitioner','doctor','reception'])
  and public.can_access_encounter(encounter_id)
);

drop policy if exists patient_identity_events_read on public.patient_identity_events;
create policy patient_identity_events_read
on public.patient_identity_events for select to authenticated
using (public.is_clinic_member(clinic_id, array['owner','admin','practitioner','doctor']));

grant select on public.encounter_identity_verifications to authenticated;
grant select on public.patient_identity_events to authenticated;

-- ============================================================
-- STAFF AND SERVICE RPCS
-- ============================================================

create or replace function public.hybrid_patient_identity_healthcheck()
returns table (
  ready boolean,
  clinic_id uuid,
  clinic_code text,
  qr_ttl_seconds integer,
  legacy_hn_available boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id is not null,
    c.id,
    c.code,
    90,
    true
  from public.clinics c
  where c.id = public.current_clinic_id()
    and c.active;
$$;

revoke all on function public.hybrid_patient_identity_healthcheck() from public;
grant execute on function public.hybrid_patient_identity_healthcheck() to authenticated;

create or replace function public.upsert_patient_registration(
  p_patient_id uuid,
  p_prefix text,
  p_first_name text,
  p_last_name text,
  p_national_id text,
  p_gender text,
  p_date_of_birth date,
  p_phone text,
  p_address text,
  p_payment_right text,
  p_emergency_contact_name text,
  p_allergy text
)
returns public.patients
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_clinic_code text;
  v_patient public.patients%rowtype;
  v_hn text;
begin
  if v_clinic_id is null or not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if nullif(btrim(p_first_name), '') is null or nullif(btrim(p_last_name), '') is null then
    raise exception 'PATIENT_NAME_REQUIRED';
  end if;

  if p_patient_id is null then
    select coalesce(nullif(regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g'), ''), 'CLN')
    into v_clinic_code
    from public.clinics c
    where c.id = v_clinic_id;

    v_hn := v_clinic_code || '-' ||
      lpad(public.next_clinic_counter(v_clinic_id, 'patient_hn')::text, 8, '0');

    insert into public.patients (
      clinic_id, hn, prefix, first_name, last_name, national_id, gender,
      date_of_birth, phone, address, payment_right,
      emergency_contact_name, created_by
    ) values (
      v_clinic_id, v_hn, nullif(btrim(p_prefix), ''), btrim(p_first_name),
      btrim(p_last_name), nullif(btrim(p_national_id), ''), nullif(btrim(p_gender), ''),
      p_date_of_birth, nullif(btrim(p_phone), ''), nullif(btrim(p_address), ''),
      nullif(btrim(p_payment_right), ''), nullif(btrim(p_emergency_contact_name), ''),
      auth.uid()
    )
    returning * into v_patient;
  else
    select * into v_patient
    from public.patients p
    where p.id = p_patient_id
      and p.clinic_id = v_clinic_id
    for update;

    if not found then
      raise exception 'PATIENT_NOT_FOUND';
    end if;

    update public.patients
    set
      prefix = nullif(btrim(p_prefix), ''),
      first_name = btrim(p_first_name),
      last_name = btrim(p_last_name),
      national_id = nullif(btrim(p_national_id), ''),
      gender = nullif(btrim(p_gender), ''),
      date_of_birth = p_date_of_birth,
      phone = nullif(btrim(p_phone), ''),
      address = nullif(btrim(p_address), ''),
      payment_right = nullif(btrim(p_payment_right), ''),
      emergency_contact_name = nullif(btrim(p_emergency_contact_name), ''),
      updated_at = now()
    where id = p_patient_id
    returning * into v_patient;
  end if;

  if nullif(btrim(p_allergy), '') is not null
     and not exists (
       select 1
       from public.patient_allergies a
       where a.patient_id = v_patient.id
         and a.status = 'active'
         and lower(a.allergen_name) = lower(btrim(p_allergy))
     ) then
    insert into public.patient_allergies (
      clinic_id, patient_id, allergen_type, allergen_name, status, created_by
    ) values (
      v_clinic_id, v_patient.id, 'other', btrim(p_allergy), 'active', auth.uid()
    );
  end if;

  insert into public.audit_logs (clinic_id, user_id, action, entity, entity_id, metadata)
  values (
    v_clinic_id,
    auth.uid(),
    case when p_patient_id is null then 'create' else 'update' end,
    'patients',
    v_patient.id::text,
    jsonb_build_object('source', 'upsert_patient_registration', 'hn_generated_by_server', true)
  );

  return v_patient;
end;
$$;

revoke all on function public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text) from public;
grant execute on function public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text) to authenticated;

create or replace function public.issue_patient_line_link_code(
  p_patient_id uuid,
  p_link_type text default 'self',
  p_relation_label text default null,
  p_consent_confirmed boolean default false
)
returns table (link_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_code text;
  v_expires_at timestamptz := now() + interval '15 minutes';
  v_request_id uuid;
  v_attempt integer;
begin
  if p_link_type not in ('self','guardian') then
    raise exception 'INVALID_LINK_TYPE';
  end if;
  if not p_consent_confirmed then
    raise exception 'CONSENT_REQUIRED';
  end if;
  if p_link_type = 'guardian'
     and nullif(btrim(p_relation_label), '') is null then
    raise exception 'GUARDIAN_RELATION_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1 from public.patients p
    where p.id = p_patient_id and p.clinic_id = v_clinic_id and p.active
  ) then
    raise exception 'PATIENT_NOT_FOUND';
  end if;

  update public.patient_identity_link_requests
  set invalidated_at = now()
  where patient_id = p_patient_id
    and clinic_id = v_clinic_id
    and claimed_at is null
    and invalidated_at is null;

  for v_attempt in 1..5 loop
    begin
      v_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 12));
      insert into public.patient_identity_link_requests (
        clinic_id, patient_id, code_hash, link_type, relation_label,
        expires_at, staff_consent_confirmed_at, issued_by
      ) values (
        v_clinic_id,
        p_patient_id,
        encode(digest(v_code, 'sha256'), 'hex'),
        p_link_type,
        nullif(btrim(p_relation_label), ''),
        v_expires_at,
        now(),
        auth.uid()
      )
      returning id into v_request_id;
      exit;
    exception when unique_violation then
      if v_attempt = 5 then
        raise exception 'LINK_CODE_GENERATION_FAILED';
      end if;
    end;
  end loop;

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, metadata
  ) values (
    v_clinic_id,
    p_patient_id,
    'LINE_LINK_CODE_ISSUED',
    auth.uid(),
    jsonb_build_object(
      'request_id', v_request_id,
      'link_type', p_link_type,
      'staff_consent_confirmed', true,
      'expires_at', v_expires_at
    )
  );

  return query select v_code, v_expires_at;
end;
$$;

revoke all on function public.issue_patient_line_link_code(uuid,text,text,boolean) from public;
grant execute on function public.issue_patient_line_link_code(uuid,text,text,boolean) to authenticated;

create or replace function public.consume_patient_identity_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  if p_bucket_key !~ '^[0-9a-f]{64}$'
     or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'INVALID_RATE_LIMIT_ARGUMENT';
  end if;

  insert into public.patient_identity_rate_limits (
    bucket_key, window_started_at, attempts, updated_at
  ) values (
    p_bucket_key, now(), 1, now()
  )
  on conflict (bucket_key)
  do update set
    window_started_at = case
      when public.patient_identity_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
      then now()
      else public.patient_identity_rate_limits.window_started_at
    end,
    attempts = case
      when public.patient_identity_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
      then 1
      else public.patient_identity_rate_limits.attempts + 1
    end,
    updated_at = now()
  returning attempts into v_attempts;

  return v_attempts <= p_limit;
end;
$$;

revoke all on function public.consume_patient_identity_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_patient_identity_rate_limit(text,integer,integer) to service_role;

create or replace function public.complete_patient_line_link(
  p_link_code text,
  p_subject_hash text,
  p_provider_channel text,
  p_subject_consent_confirmed boolean
)
returns table (patient_id uuid, clinic_id uuid, link_type text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_link_code, ''), '[^0-9A-F]', '', 'g'));
  v_request public.patient_identity_link_requests%rowtype;
  v_link public.patient_identity_links%rowtype;
begin
  if length(v_code) <> 12 or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_LINK_CREDENTIAL';
  end if;
  if not p_subject_consent_confirmed then
    raise exception 'CONSENT_REQUIRED';
  end if;

  select * into v_request
  from public.patient_identity_link_requests r
  where r.code_hash = encode(digest(v_code, 'sha256'), 'hex')
    and r.claimed_at is null
    and r.invalidated_at is null
    and r.expires_at > now()
  for update;

  if not found then
    raise exception 'LINK_CODE_INVALID_OR_EXPIRED';
  end if;

  if v_request.link_type = 'self'
     and exists (
       select 1
       from public.patient_identity_links l
       where l.provider = 'line'
         and l.subject_hash = p_subject_hash
         and l.clinic_id = v_request.clinic_id
         and l.link_type = 'self'
         and l.status = 'active'
         and l.patient_id <> v_request.patient_id
     ) then
    raise exception 'LINE_ID_ALREADY_LINKED';
  end if;

  if v_request.link_type = 'self'
     and exists (
       select 1
       from public.patient_identity_links l
       where l.provider = 'line'
         and l.clinic_id = v_request.clinic_id
         and l.patient_id = v_request.patient_id
         and l.link_type = 'self'
         and l.status = 'active'
         and l.subject_hash <> p_subject_hash
     ) then
    raise exception 'LINE_PATIENT_ALREADY_LINKED';
  end if;

  insert into public.patient_identity_links (
    clinic_id, patient_id, provider, subject_hash, link_type,
    relation_label, status, staff_consent_confirmed_at,
    staff_consent_recorded_by, subject_consent_confirmed_at, verified_at
  ) values (
    v_request.clinic_id,
    v_request.patient_id,
    'line',
    p_subject_hash,
    v_request.link_type,
    v_request.relation_label,
    'active',
    v_request.staff_consent_confirmed_at,
    v_request.issued_by,
    now(),
    now()
  )
  on conflict on constraint patient_identity_links_patient_provider_subject_key
  do update set
    status = 'active',
    link_type = excluded.link_type,
    relation_label = excluded.relation_label,
    staff_consent_confirmed_at = excluded.staff_consent_confirmed_at,
    staff_consent_recorded_by = excluded.staff_consent_recorded_by,
    subject_consent_confirmed_at = excluded.subject_consent_confirmed_at,
    verified_at = now(),
    revoked_at = null,
    updated_at = now()
  returning * into v_link;

  update public.patient_identity_link_requests
  set claimed_at = now()
  where id = v_request.id;

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, identity_link_id, metadata
  ) values (
    v_request.clinic_id,
    v_request.patient_id,
    'LINE_IDENTITY_LINKED',
    v_link.id,
    jsonb_build_object(
      'link_type', v_link.link_type,
      'subject_consent_confirmed', true,
      'provider_channel_hash', encode(digest(coalesce(p_provider_channel, ''), 'sha256'), 'hex')
    )
  );

  return query select v_link.patient_id, v_link.clinic_id, v_link.link_type;
end;
$$;

revoke all on function public.complete_patient_line_link(text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.complete_patient_line_link(text,text,text,boolean) to service_role;

create or replace function public.list_line_linked_patients(p_subject_hash text)
returns table (
  patient_id uuid,
  clinic_id uuid,
  clinic_name text,
  hn text,
  display_name text,
  link_type text,
  relation_label text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.clinic_id,
    c.name_th,
    p.hn,
    concat_ws(' ', nullif(p.prefix, ''), p.first_name, p.last_name),
    l.link_type,
    l.relation_label
  from public.patient_identity_links l
  join public.patients p on p.id = l.patient_id and p.clinic_id = l.clinic_id
  join public.clinics c on c.id = l.clinic_id
  where l.provider = 'line'
    and l.subject_hash = p_subject_hash
    and l.status = 'active'
    and p.active
    and c.active
  order by l.link_type = 'self' desc, p.first_name, p.last_name;
$$;

revoke all on function public.list_line_linked_patients(text) from public, anon, authenticated;
grant execute on function public.list_line_linked_patients(text) to service_role;

create or replace function public.list_patient_identity_links(p_patient_id uuid)
returns table (
  link_id uuid,
  link_type text,
  relation_label text,
  status text,
  verified_at timestamptz,
  subject_consent_confirmed_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
begin
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1
    from public.patients p
    where p.id = p_patient_id
      and p.clinic_id = v_clinic_id
  ) then
    raise exception 'PATIENT_NOT_FOUND';
  end if;

  return query
  select
    l.id,
    l.link_type,
    l.relation_label,
    l.status,
    l.verified_at,
    l.subject_consent_confirmed_at,
    l.revoked_at
  from public.patient_identity_links l
  where l.patient_id = p_patient_id
    and l.clinic_id = v_clinic_id
  order by (l.status = 'active') desc, l.verified_at desc
  limit 50;
end;
$$;

revoke all on function public.list_patient_identity_links(uuid) from public;
grant execute on function public.list_patient_identity_links(uuid) to authenticated;

create or replace function public.revoke_patient_identity_link(
  p_link_id uuid,
  p_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_link public.patient_identity_links%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'REVOCATION_REASON_REQUIRED';
  end if;

  select * into v_link
  from public.patient_identity_links l
  where l.id = p_link_id
    and l.clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'PATIENT_IDENTITY_LINK_NOT_FOUND';
  end if;
  if v_link.status = 'revoked' then
    return false;
  end if;

  update public.patient_identity_links l
  set
    status = 'revoked',
    revoked_at = now(),
    updated_at = now()
  where l.id = v_link.id;

  update public.patient_qr_sessions q
  set expires_at = least(q.expires_at, now())
  where q.identity_link_id = v_link.id
    and q.used_at is null
    and q.expires_at > now();

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id,
    identity_link_id, metadata
  ) values (
    v_link.clinic_id,
    v_link.patient_id,
    'LINE_IDENTITY_REVOKED',
    auth.uid(),
    v_link.id,
    jsonb_build_object('reason', v_reason, 'link_type', v_link.link_type)
  );

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_link.clinic_id,
    auth.uid(),
    'revoke',
    'patient_identity_links',
    v_link.id::text,
    jsonb_build_object(
      'patient_id', v_link.patient_id,
      'reason', v_reason,
      'link_type', v_link.link_type
    )
  );

  return true;
end;
$$;

revoke all on function public.revoke_patient_identity_link(uuid,text) from public;
grant execute on function public.revoke_patient_identity_link(uuid,text) to authenticated;

create or replace function public.issue_patient_qr_for_subject(
  p_subject_hash text,
  p_patient_id uuid,
  p_token_hash text,
  p_display_code_hash text,
  p_expires_at timestamptz
)
returns table (
  qr_session_id uuid,
  patient_id uuid,
  clinic_id uuid,
  hn text,
  display_name text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_link public.patient_identity_links%rowtype;
  v_session public.patient_qr_sessions%rowtype;
  v_patient public.patients%rowtype;
begin
  if p_subject_hash !~ '^[0-9a-f]{64}$'
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_display_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_QR_CREDENTIAL_HASH';
  end if;
  if p_expires_at <= now() + interval '30 seconds'
     or p_expires_at > now() + interval '3 minutes' then
    raise exception 'INVALID_QR_EXPIRY';
  end if;

  select * into v_link
  from public.patient_identity_links l
  where l.provider = 'line'
    and l.subject_hash = p_subject_hash
    and l.patient_id = p_patient_id
    and l.status = 'active'
  order by l.link_type = 'self' desc, l.verified_at desc
  limit 1;

  if not found then
    raise exception 'PATIENT_IDENTITY_NOT_LINKED';
  end if;

  select * into v_patient
  from public.patients p
  where p.id = v_link.patient_id
    and p.clinic_id = v_link.clinic_id
    and p.active;

  if not found then
    raise exception 'PATIENT_NOT_FOUND';
  end if;

  -- Six digits are deliberately usable without a camera. Serialize the small
  -- credential space per clinic and make the caller retry instead of ever
  -- resolving a collision to the wrong patient.
  perform pg_advisory_xact_lock(
    hashtextextended(v_link.clinic_id::text || ':' || p_display_code_hash, 0)
  );
  if exists (
    select 1
    from public.patient_qr_sessions q
    where q.clinic_id = v_link.clinic_id
      and q.display_code_hash = p_display_code_hash
      and q.used_at is null
      and q.expires_at > now()
  ) then
    raise exception 'DISPLAY_CODE_COLLISION';
  end if;

  update public.patient_qr_sessions q
  set expires_at = least(q.expires_at, now())
  where q.identity_link_id = v_link.id
    and q.used_at is null
    and q.expires_at > now();

  insert into public.patient_qr_sessions (
    clinic_id, patient_id, identity_link_id, token_hash,
    display_code_hash, expires_at
  ) values (
    v_link.clinic_id,
    v_link.patient_id,
    v_link.id,
    p_token_hash,
    p_display_code_hash,
    p_expires_at
  )
  returning * into v_session;

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, identity_link_id, qr_session_id,
    metadata
  ) values (
    v_link.clinic_id,
    v_link.patient_id,
    'PATIENT_QR_ISSUED',
    v_link.id,
    v_session.id,
    jsonb_build_object('expires_at', p_expires_at)
  );

  return query
  select
    v_session.id,
    v_patient.id,
    v_patient.clinic_id,
    v_patient.hn,
    concat_ws(' ', nullif(v_patient.prefix, ''), v_patient.first_name, v_patient.last_name),
    v_session.expires_at;
end;
$$;

revoke all on function public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz) to service_role;

create or replace function public.search_patients_for_checkin(p_query text)
returns table (
  patient_id uuid,
  hn text,
  display_name text,
  date_of_birth date,
  phone_last4 text,
  active_allergies jsonb
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_query text := btrim(coalesce(p_query, ''));
  v_result_count integer;
begin
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if length(v_query) < 2 or length(v_query) > 80 then
    raise exception 'SEARCH_QUERY_LENGTH_INVALID';
  end if;

  select count(*) into v_result_count
  from public.patients p
  where p.clinic_id = v_clinic_id
    and p.active
    and (
      p.hn ilike '%' || v_query || '%'
      or p.first_name ilike '%' || v_query || '%'
      or p.last_name ilike '%' || v_query || '%'
      or coalesce(p.phone, '') ilike '%' || v_query || '%'
      or coalesce(p.date_of_birth::text, '') = v_query
    );

  insert into public.patient_identity_events (
    clinic_id, event_type, actor_profile_id, metadata
  ) values (
    v_clinic_id,
    'MANUAL_PATIENT_SEARCH',
    auth.uid(),
    jsonb_build_object(
      'query_hash', encode(digest(lower(v_query), 'sha256'), 'hex'),
      'result_count', least(v_result_count, 20)
    )
  );

  return query
  select
    p.id,
    p.hn,
    concat_ws(' ', nullif(p.prefix, ''), p.first_name, p.last_name),
    p.date_of_birth,
    case
      when length(regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g')) >= 4
      then right(regexp_replace(p.phone, '\\D', '', 'g'), 4)
      else null
    end,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', a.allergen_name,
          'reaction', a.reaction,
          'severity', a.severity
        ) order by a.allergen_name
      )
      from public.patient_allergies a
      where a.patient_id = p.id
        and a.clinic_id = p.clinic_id
        and a.status = 'active'
    ), '[]'::jsonb)
  from public.patients p
  where p.clinic_id = v_clinic_id
    and p.active
    and (
      p.hn ilike '%' || v_query || '%'
      or p.first_name ilike '%' || v_query || '%'
      or p.last_name ilike '%' || v_query || '%'
      or coalesce(p.phone, '') ilike '%' || v_query || '%'
      or coalesce(p.date_of_birth::text, '') = v_query
    )
  order by p.updated_at desc
  limit 20;
end;
$$;

revoke all on function public.search_patients_for_checkin(text) from public;
grant execute on function public.search_patients_for_checkin(text) to authenticated;

create or replace function public.resolve_patient_qr(
  p_token text default null,
  p_display_code text default null
)
returns table (
  qr_session_id uuid,
  patient_id uuid,
  hn text,
  display_name text,
  date_of_birth date,
  phone_last4 text,
  active_allergies jsonb,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_token text := btrim(coalesce(p_token, ''));
  v_code text := regexp_replace(coalesce(p_display_code, ''), '\\D', '', 'g');
  v_session public.patient_qr_sessions%rowtype;
  v_patient public.patients%rowtype;
  v_allergies jsonb;
begin
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_token like 'CHANANYA:PT1:%' then
    v_token := substr(v_token, length('CHANANYA:PT1:') + 1);
  end if;
  if v_token = '' and length(v_code) <> 6 then
    raise exception 'QR_OR_SIX_DIGIT_CODE_REQUIRED';
  end if;
  if v_token = '' and not public.consume_patient_identity_rate_limit(
    encode(digest(
      v_clinic_id::text || ':' || auth.uid()::text || ':staff_display_code',
      'sha256'
    ), 'hex'),
    20,
    300
  ) then
    raise exception 'RATE_LIMITED';
  end if;

  select * into v_session
  from public.patient_qr_sessions q
  where q.clinic_id = v_clinic_id
    and q.used_at is null
    and q.expires_at > now()
    and (
      (v_token <> '' and q.token_hash = encode(digest(v_token, 'sha256'), 'hex'))
      or (v_token = '' and q.display_code_hash = encode(digest(v_code, 'sha256'), 'hex'))
    )
  order by q.created_at desc
  limit 1
  for update;

  if not found then
    if v_token = '' then
      -- Return no row instead of raising so the failed-attempt rate-limit
      -- increment is committed rather than rolled back with the RPC.
      insert into public.patient_identity_events (
        clinic_id, event_type, actor_profile_id, metadata
      ) values (
        v_clinic_id,
        'PATIENT_QR_LOOKUP_FAILED',
        auth.uid(),
        jsonb_build_object('credential', 'display_code')
      );
      return;
    end if;
    raise exception 'QR_INVALID_EXPIRED_OR_USED';
  end if;

  update public.patient_qr_sessions
  set resolved_at = now(), resolved_by = auth.uid()
  where id = v_session.id;

  select * into v_patient
  from public.patients p
  where p.id = v_session.patient_id
    and p.clinic_id = v_clinic_id
    and p.active;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', a.allergen_name,
        'reaction', a.reaction,
        'severity', a.severity
      ) order by a.allergen_name
    ) filter (where a.id is not null),
    '[]'::jsonb
  ) into v_allergies
  from public.patient_allergies a
  where a.patient_id = v_patient.id
    and a.clinic_id = v_clinic_id
    and a.status = 'active';

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, qr_session_id,
    metadata
  ) values (
    v_clinic_id,
    v_patient.id,
    'PATIENT_QR_RESOLVED',
    auth.uid(),
    v_session.id,
    jsonb_build_object('credential', case when v_token <> '' then 'qr' else 'display_code' end)
  );

  return query
  select
    v_session.id,
    v_patient.id,
    v_patient.hn,
    concat_ws(' ', nullif(v_patient.prefix, ''), v_patient.first_name, v_patient.last_name),
    v_patient.date_of_birth,
    case
      when length(regexp_replace(coalesce(v_patient.phone, ''), '\\D', '', 'g')) >= 4
      then right(regexp_replace(v_patient.phone, '\\D', '', 'g'), 4)
      else null
    end,
    v_allergies,
    v_session.expires_at;
end;
$$;

revoke all on function public.resolve_patient_qr(text,text) from public;
grant execute on function public.resolve_patient_qr(text,text) to authenticated;

create or replace function public.apply_initial_encounter_intake(
  p_encounter_id uuid,
  p_intake jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_intake jsonb := coalesce(p_intake, '{}'::jsonb);
begin
  if jsonb_typeof(v_intake) <> 'object' or length(v_intake::text) > 50000 then
    raise exception 'INTAKE_PAYLOAD_INVALID';
  end if;

  update public.encounters
  set
    chief_complaint = coalesce(nullif(btrim(v_intake->>'chief_complaint'), ''), chief_complaint),
    present_illness = nullif(btrim(v_intake->>'present_illness'), ''),
    past_history = nullif(btrim(v_intake->>'past_history'), ''),
    current_medications = nullif(btrim(v_intake->>'current_medications'), ''),
    red_flags = nullif(btrim(v_intake->>'red_flags'), ''),
    general_examination = nullif(btrim(v_intake->>'general_examination'), ''),
    updated_at = now()
  where id = p_encounter_id;

  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND';
  end if;

  if coalesce(
    nullif(v_intake->>'temperature', ''),
    nullif(v_intake->>'pulse', ''),
    nullif(v_intake->>'respiration', ''),
    nullif(v_intake->>'systolic_bp', ''),
    nullif(v_intake->>'diastolic_bp', ''),
    nullif(v_intake->>'spo2', '')
  ) is not null then
    insert into public.vital_signs (
      encounter_id, temperature, pulse, respiration, systolic_bp,
      diastolic_bp, spo2, recorded_by
    ) values (
      p_encounter_id,
      nullif(v_intake->>'temperature', '')::numeric,
      nullif(v_intake->>'pulse', '')::integer,
      nullif(v_intake->>'respiration', '')::integer,
      nullif(v_intake->>'systolic_bp', '')::integer,
      nullif(v_intake->>'diastolic_bp', '')::integer,
      nullif(v_intake->>'spo2', '')::numeric,
      auth.uid()
    );
  end if;

  if nullif(v_intake->>'pain_before', '') is not null then
    insert into public.pain_assessments (
      encounter_id, assessment_stage, score, assessed_by
    ) values (
      p_encounter_id,
      'before',
      (v_intake->>'pain_before')::integer,
      auth.uid()
    );
  end if;
end;
$$;

revoke all on function public.apply_initial_encounter_intake(uuid,jsonb) from public;

create or replace function public.confirm_patient_qr(
  p_qr_session_id uuid,
  p_patient_present_confirmed boolean,
  p_chief_complaint text default null,
  p_intake jsonb default '{}'::jsonb
)
returns table (encounter_id uuid, encounter_no text, patient_id uuid)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_session public.patient_qr_sessions%rowtype;
  v_encounter public.encounters%rowtype;
begin
  if not p_patient_present_confirmed then
    raise exception 'PATIENT_CONFIRMATION_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_session
  from public.patient_qr_sessions q
  where q.id = p_qr_session_id
    and q.clinic_id = v_clinic_id
    and q.resolved_at is not null
    and q.resolved_by = auth.uid()
  for update;

  if not found or v_session.used_at is not null or v_session.expires_at <= now() then
    raise exception 'QR_INVALID_EXPIRED_OR_USED';
  end if;

  insert into public.encounters (
    clinic_id, encounter_no, patient_id, encounter_type, status,
    chief_complaint, practitioner_id, created_by
  ) values (
    v_clinic_id,
    public.next_encounter_number(),
    v_session.patient_id,
    'opd',
    'draft',
    nullif(btrim(p_chief_complaint), ''),
    case when public.has_role(array['practitioner','doctor']) then auth.uid() else null end,
    auth.uid()
  )
  returning * into v_encounter;

  perform public.apply_initial_encounter_intake(v_encounter.id, p_intake);

  insert into public.encounter_identity_verifications (
    clinic_id, encounter_id, patient_id, verification_method,
    qr_session_id, patient_present_confirmed, verified_by
  ) values (
    v_clinic_id,
    v_encounter.id,
    v_session.patient_id,
    'line_qr',
    v_session.id,
    true,
    auth.uid()
  );

  update public.patient_qr_sessions
  set
    used_at = now(),
    used_by = auth.uid(),
    encounter_id = v_encounter.id
  where id = v_session.id;

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, qr_session_id,
    encounter_id, metadata
  ) values (
    v_clinic_id,
    v_session.patient_id,
    'PATIENT_IDENTITY_CONFIRMED',
    auth.uid(),
    v_session.id,
    v_encounter.id,
    jsonb_build_object('verification_method', 'line_qr')
  );

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id,
    auth.uid(),
    'create_verified_encounter',
    'encounters',
    v_encounter.id::text,
    jsonb_build_object('verification_method', 'line_qr', 'qr_session_id', v_session.id)
  );

  return query select v_encounter.id, v_encounter.encounter_no, v_encounter.patient_id;
end;
$$;

revoke all on function public.confirm_patient_qr(uuid,boolean,text,jsonb) from public;
grant execute on function public.confirm_patient_qr(uuid,boolean,text,jsonb) to authenticated;

create or replace function public.start_manual_patient_encounter(
  p_patient_id uuid,
  p_verification_method text,
  p_patient_present_confirmed boolean,
  p_verification_note text default null,
  p_chief_complaint text default null,
  p_intake jsonb default '{}'::jsonb
)
returns table (encounter_id uuid, encounter_no text, patient_id uuid)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_encounter public.encounters%rowtype;
begin
  if p_verification_method not in (
    'manual_hn','government_id','demographic_match','guardian_attestation'
  ) then
    raise exception 'INVALID_MANUAL_VERIFICATION_METHOD';
  end if;
  if not p_patient_present_confirmed then
    raise exception 'PATIENT_CONFIRMATION_REQUIRED';
  end if;
  if p_verification_method = 'guardian_attestation'
     and nullif(btrim(p_verification_note), '') is null then
    raise exception 'GUARDIAN_NOTE_REQUIRED';
  end if;
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1 from public.patients p
    where p.id = p_patient_id and p.clinic_id = v_clinic_id and p.active
  ) then
    raise exception 'PATIENT_NOT_FOUND';
  end if;

  insert into public.encounters (
    clinic_id, encounter_no, patient_id, encounter_type, status,
    chief_complaint, practitioner_id, created_by
  ) values (
    v_clinic_id,
    public.next_encounter_number(),
    p_patient_id,
    'opd',
    'draft',
    nullif(btrim(p_chief_complaint), ''),
    case when public.has_role(array['practitioner','doctor']) then auth.uid() else null end,
    auth.uid()
  )
  returning * into v_encounter;

  perform public.apply_initial_encounter_intake(v_encounter.id, p_intake);

  insert into public.encounter_identity_verifications (
    clinic_id, encounter_id, patient_id, verification_method,
    patient_present_confirmed, verification_note, verified_by
  ) values (
    v_clinic_id,
    v_encounter.id,
    p_patient_id,
    p_verification_method,
    true,
    nullif(btrim(p_verification_note), ''),
    auth.uid()
  );

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, encounter_id,
    metadata
  ) values (
    v_clinic_id,
    p_patient_id,
    'PATIENT_IDENTITY_CONFIRMED',
    auth.uid(),
    v_encounter.id,
    jsonb_build_object('verification_method', p_verification_method)
  );

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id,
    auth.uid(),
    'create_verified_encounter',
    'encounters',
    v_encounter.id::text,
    jsonb_build_object('verification_method', p_verification_method)
  );

  return query select v_encounter.id, v_encounter.encounter_no, v_encounter.patient_id;
end;
$$;

revoke all on function public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb) from public;
grant execute on function public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb) to authenticated;

commit;

select
  'CHANANYA_HYBRID_PATIENT_IDENTITY_READY' as status,
  to_regclass('public.patient_qr_sessions') is not null as qr_sessions_ready,
  to_regprocedure('public.confirm_patient_qr(uuid,boolean,text,jsonb)') is not null as atomic_confirmation_ready,
  to_regprocedure('public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)') is not null as legacy_fallback_ready;
