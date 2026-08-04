-- ============================================================
-- CHANANYA CLINICAL OS
-- Compatible Appointment & Practitioner Scheduling Module
-- Safe for existing profiles / patients / roles / RLS architecture
-- ============================================================

begin;

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1) Access helpers
-- ------------------------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.system_role = 'super_admin'
  );
$$;

create or replace function public.is_clinic_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.system_role in ('super_admin','admin')
        or p.role = 'admin'
      )
  );
$$;

create or replace function public.is_reception_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.system_role in ('super_admin','admin')
        or p.role in ('admin','reception')
      )
  );
$$;

create or replace function public.is_practitioner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.system_role in ('super_admin','admin')
        or p.role in ('admin','practitioner','doctor')
      )
  );
$$;

-- ------------------------------------------------------------
-- 2) Specialty master
-- ------------------------------------------------------------
create table if not exists public.clinic_specialties (
  id                bigserial primary key,
  code              text not null unique,
  name_th           text not null,
  name_en           text,
  discipline        text not null default 'clinical',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id)
);

create table if not exists public.practitioner_specialties (
  id                uuid primary key default gen_random_uuid(),
  practitioner_id   uuid not null references public.profiles(id) on delete cascade,
  specialty_id      bigint not null references public.clinic_specialties(id),
  is_primary        boolean not null default false,
  credential_no     text,
  credential_type   text,
  verified          boolean not null default false,
  verified_by       uuid references public.profiles(id),
  verified_at       timestamptz,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (practitioner_id, specialty_id)
);

-- ------------------------------------------------------------
-- 3) Branch / room-safe scheduling
-- ------------------------------------------------------------
create table if not exists public.practitioner_schedules (
  id                  uuid primary key default gen_random_uuid(),
  practitioner_id     uuid not null references public.profiles(id),
  specialty_id        bigint references public.clinic_specialties(id),
  service_id          uuid,
  branch_code         text not null default 'MAIN',
  room_code           text,
  title               text not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  slot_minutes        integer not null default 30 check (slot_minutes between 5 and 480),
  max_patients        integer not null default 1 check (max_patients > 0),
  booking_status      text not null default 'open'
                      check (booking_status in ('draft','open','closed','cancelled')),
  notes               text,
  created_by          uuid not null references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists idx_practitioner_schedules_practitioner
  on public.practitioner_schedules(practitioner_id, starts_at);
create index if not exists idx_practitioner_schedules_open
  on public.practitioner_schedules(booking_status, starts_at);

-- ------------------------------------------------------------
-- 4) Optional link between patient master and login account
--    Patients in Chananya do not need an auth account.
-- ------------------------------------------------------------
create table if not exists public.patient_user_links (
  patient_id          uuid primary key references public.patients(id) on delete cascade,
  user_id             uuid not null unique references auth.users(id) on delete cascade,
  linked_by           uuid references public.profiles(id),
  linked_at           timestamptz not null default now(),
  active              boolean not null default true
);

-- ------------------------------------------------------------
-- 5) Appointments
-- ------------------------------------------------------------
create table if not exists public.clinic_appointments (
  id                  uuid primary key default gen_random_uuid(),
  appointment_no      text not null unique,
  patient_id          uuid not null references public.patients(id),
  schedule_id         uuid not null references public.practitioner_schedules(id),
  practitioner_id     uuid not null references public.profiles(id),
  service_id          uuid,
  queue_number        integer not null,
  scheduled_start     timestamptz not null,
  scheduled_end       timestamptz not null,
  status              text not null default 'booked'
                      check (status in (
                        'booked','confirmed','checked_in','in_service',
                        'completed','cancelled','no_show','rescheduled'
                      )),
  booking_source      text not null default 'staff'
                      check (booking_source in ('staff','patient_portal','walk_in','import')),
  chief_complaint     text,
  notes               text,
  encounter_id        uuid references public.encounters(id),
  cancellation_reason text,
  cancelled_by        uuid references public.profiles(id),
  cancelled_at        timestamptz,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (schedule_id, queue_number),
  check (scheduled_end > scheduled_start)
);

create index if not exists idx_clinic_appointments_patient
  on public.clinic_appointments(patient_id, scheduled_start desc);
create index if not exists idx_clinic_appointments_schedule
  on public.clinic_appointments(schedule_id, status);
create index if not exists idx_clinic_appointments_practitioner
  on public.clinic_appointments(practitioner_id, scheduled_start);

create table if not exists public.appointment_events (
  id                  bigserial primary key,
  appointment_id      uuid not null references public.clinic_appointments(id) on delete cascade,
  event_type          text not null,
  old_status          text,
  new_status          text,
  detail              jsonb not null default '{}'::jsonb,
  actor_id            uuid references public.profiles(id),
  created_at          timestamptz not null default now()
);

create index if not exists idx_appointment_events_appointment
  on public.appointment_events(appointment_id, created_at);

-- ------------------------------------------------------------
-- 6) Updated-at trigger
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_practitioner_schedules_updated_at on public.practitioner_schedules;
create trigger trg_practitioner_schedules_updated_at
before update on public.practitioner_schedules
for each row execute function public.set_updated_at();

drop trigger if exists trg_clinic_appointments_updated_at on public.clinic_appointments;
create trigger trg_clinic_appointments_updated_at
before update on public.clinic_appointments
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 7) Transaction-safe appointment booking RPC
-- ------------------------------------------------------------
create or replace function public.book_clinic_appointment(
  p_patient_id uuid,
  p_schedule_id uuid,
  p_chief_complaint text default null,
  p_notes text default null,
  p_booking_source text default 'staff'
)
returns public.clinic_appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_schedule public.practitioner_schedules%rowtype;
  v_active_count integer;
  v_queue integer;
  v_result public.clinic_appointments%rowtype;
  v_appt_no text;
  v_patient_linked boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_schedule
  from public.practitioner_schedules
  where id = p_schedule_id
  for update;

  if not found then
    raise exception 'SCHEDULE_NOT_FOUND';
  end if;

  if v_schedule.booking_status <> 'open' then
    raise exception 'SCHEDULE_NOT_OPEN';
  end if;

  if v_schedule.starts_at <= now() then
    raise exception 'SCHEDULE_ALREADY_STARTED';
  end if;

  -- Staff may book for any patient. Patient portal may book only linked patient.
  if not public.is_reception_or_admin() then
    select exists (
      select 1 from public.patient_user_links l
      where l.patient_id = p_patient_id
        and l.user_id = auth.uid()
        and l.active = true
    ) into v_patient_linked;

    if not v_patient_linked then
      raise exception 'PATIENT_ACCESS_DENIED';
    end if;

    p_booking_source := 'patient_portal';
  end if;

  select count(*) into v_active_count
  from public.clinic_appointments a
  where a.schedule_id = p_schedule_id
    and a.status in ('booked','confirmed','checked_in','in_service');

  if v_active_count >= v_schedule.max_patients then
    raise exception 'SCHEDULE_FULL';
  end if;

  select coalesce(max(queue_number),0) + 1 into v_queue
  from public.clinic_appointments
  where schedule_id = p_schedule_id;

  v_appt_no := 'APT-' || to_char(current_date,'YYYYMMDD') || '-' ||
               upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.clinic_appointments (
    appointment_no,
    patient_id,
    schedule_id,
    practitioner_id,
    service_id,
    queue_number,
    scheduled_start,
    scheduled_end,
    status,
    booking_source,
    chief_complaint,
    notes,
    created_by
  ) values (
    v_appt_no,
    p_patient_id,
    p_schedule_id,
    v_schedule.practitioner_id,
    v_schedule.service_id,
    v_queue,
    v_schedule.starts_at,
    v_schedule.ends_at,
    'booked',
    case when p_booking_source in ('staff','patient_portal','walk_in','import')
         then p_booking_source else 'staff' end,
    nullif(trim(p_chief_complaint),''),
    nullif(trim(p_notes),''),
    auth.uid()
  ) returning * into v_result;

  insert into public.appointment_events(
    appointment_id,event_type,new_status,detail,actor_id
  ) values (
    v_result.id,'booked','booked',
    jsonb_build_object('queue_number',v_queue,'booking_source',v_result.booking_source),
    auth.uid()
  );

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- 8) Controlled cancellation RPC
-- ------------------------------------------------------------
create or replace function public.cancel_clinic_appointment(
  p_appointment_id uuid,
  p_reason text
)
returns public.clinic_appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt public.clinic_appointments%rowtype;
  v_linked boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_appt
  from public.clinic_appointments
  where id = p_appointment_id
  for update;

  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND';
  end if;

  if v_appt.status not in ('booked','confirmed') then
    raise exception 'APPOINTMENT_CANNOT_BE_CANCELLED';
  end if;

  if not public.is_reception_or_admin() then
    select exists (
      select 1 from public.patient_user_links l
      where l.patient_id = v_appt.patient_id
        and l.user_id = auth.uid()
        and l.active = true
    ) into v_linked;

    if not v_linked then
      raise exception 'APPOINTMENT_ACCESS_DENIED';
    end if;
  end if;

  update public.clinic_appointments
  set status = 'cancelled',
      cancellation_reason = nullif(trim(p_reason),''),
      cancelled_by = auth.uid(),
      cancelled_at = now()
  where id = p_appointment_id
  returning * into v_appt;

  insert into public.appointment_events(
    appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_appt.id,'cancelled','booked','cancelled',
    jsonb_build_object('reason',p_reason),auth.uid()
  );

  return v_appt;
end;
$$;

-- ------------------------------------------------------------
-- 9) Staff status transition RPC
-- ------------------------------------------------------------
create or replace function public.set_clinic_appointment_status(
  p_appointment_id uuid,
  p_new_status text,
  p_note text default null
)
returns public.clinic_appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt public.clinic_appointments%rowtype;
  v_old text;
begin
  if not (public.is_reception_or_admin() or public.is_practitioner()) then
    raise exception 'STAFF_ACCESS_REQUIRED';
  end if;

  if p_new_status not in (
    'booked','confirmed','checked_in','in_service',
    'completed','cancelled','no_show','rescheduled'
  ) then
    raise exception 'INVALID_APPOINTMENT_STATUS';
  end if;

  select * into v_appt
  from public.clinic_appointments
  where id = p_appointment_id
  for update;

  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND';
  end if;

  if not public.is_reception_or_admin()
     and v_appt.practitioner_id <> auth.uid() then
    raise exception 'APPOINTMENT_ACCESS_DENIED';
  end if;

  v_old := v_appt.status;

  update public.clinic_appointments
  set status = p_new_status,
      notes = case
        when nullif(trim(p_note),'') is null then notes
        when notes is null then trim(p_note)
        else notes || E'\n' || trim(p_note)
      end
  where id = p_appointment_id
  returning * into v_appt;

  insert into public.appointment_events(
    appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_appt.id,'status_changed',v_old,p_new_status,
    jsonb_build_object('note',p_note),auth.uid()
  );

  return v_appt;
end;
$$;

-- ------------------------------------------------------------
-- 10) Available schedule view
-- ------------------------------------------------------------
create or replace view public.available_practitioner_schedules
with (security_invoker = true)
as
select
  s.id,
  s.practitioner_id,
  p.full_name as practitioner_name,
  s.specialty_id,
  cs.name_th as specialty_name_th,
  cs.name_en as specialty_name_en,
  s.service_id,
  s.branch_code,
  s.room_code,
  s.title,
  s.starts_at,
  s.ends_at,
  s.max_patients,
  count(a.id) filter (
    where a.status in ('booked','confirmed','checked_in','in_service')
  )::integer as booked_patients,
  greatest(
    s.max_patients - count(a.id) filter (
      where a.status in ('booked','confirmed','checked_in','in_service')
    )::integer,
    0
  ) as available_capacity
from public.practitioner_schedules s
join public.profiles p on p.id = s.practitioner_id
left join public.clinic_specialties cs on cs.id = s.specialty_id
left join public.clinic_appointments a on a.schedule_id = s.id
where s.booking_status = 'open'
  and s.starts_at > now()
group by s.id,p.full_name,cs.name_th,cs.name_en;

-- ------------------------------------------------------------
-- 11) RLS
-- ------------------------------------------------------------
alter table public.clinic_specialties enable row level security;
alter table public.practitioner_specialties enable row level security;
alter table public.practitioner_schedules enable row level security;
alter table public.patient_user_links enable row level security;
alter table public.clinic_appointments enable row level security;
alter table public.appointment_events enable row level security;

drop policy if exists clinic_specialties_read on public.clinic_specialties;
create policy clinic_specialties_read
on public.clinic_specialties for select
to authenticated
using (active = true or public.is_clinic_admin());

drop policy if exists clinic_specialties_manage on public.clinic_specialties;
create policy clinic_specialties_manage
on public.clinic_specialties for all
to authenticated
using (public.is_clinic_admin())
with check (public.is_clinic_admin());

drop policy if exists practitioner_specialties_read on public.practitioner_specialties;
create policy practitioner_specialties_read
on public.practitioner_specialties for select
to authenticated
using (active = true or practitioner_id = auth.uid() or public.is_clinic_admin());

drop policy if exists practitioner_specialties_manage on public.practitioner_specialties;
create policy practitioner_specialties_manage
on public.practitioner_specialties for all
to authenticated
using (public.is_clinic_admin())
with check (public.is_clinic_admin());

drop policy if exists practitioner_schedules_read on public.practitioner_schedules;
create policy practitioner_schedules_read
on public.practitioner_schedules for select
to authenticated
using (
  booking_status = 'open'
  or practitioner_id = auth.uid()
  or public.is_reception_or_admin()
);

drop policy if exists practitioner_schedules_manage_own on public.practitioner_schedules;
create policy practitioner_schedules_manage_own
on public.practitioner_schedules for all
to authenticated
using (practitioner_id = auth.uid() or public.is_clinic_admin())
with check (practitioner_id = auth.uid() or public.is_clinic_admin());

drop policy if exists patient_user_links_own on public.patient_user_links;
create policy patient_user_links_own
on public.patient_user_links for select
to authenticated
using (user_id = auth.uid() or public.is_clinic_admin());

drop policy if exists patient_user_links_manage on public.patient_user_links;
create policy patient_user_links_manage
on public.patient_user_links for all
to authenticated
using (public.is_clinic_admin())
with check (public.is_clinic_admin());

drop policy if exists clinic_appointments_staff_read on public.clinic_appointments;
create policy clinic_appointments_staff_read
on public.clinic_appointments for select
to authenticated
using (
  public.is_reception_or_admin()
  or practitioner_id = auth.uid()
  or exists (
    select 1 from public.patient_user_links l
    where l.patient_id = clinic_appointments.patient_id
      and l.user_id = auth.uid()
      and l.active = true
  )
);

-- Direct insert/update/delete is intentionally blocked.
-- Use the secured RPC functions instead.

drop policy if exists appointment_events_read on public.appointment_events;
create policy appointment_events_read
on public.appointment_events for select
to authenticated
using (
  public.is_clinic_admin()
  or exists (
    select 1 from public.clinic_appointments a
    where a.id = appointment_events.appointment_id
      and a.practitioner_id = auth.uid()
  )
);

-- ------------------------------------------------------------
-- 12) Grants
-- ------------------------------------------------------------
grant select on public.clinic_specialties to authenticated;
grant select on public.practitioner_specialties to authenticated;
grant select on public.practitioner_schedules to authenticated;
grant select on public.patient_user_links to authenticated;
grant select on public.clinic_appointments to authenticated;
grant select on public.appointment_events to authenticated;
grant select on public.available_practitioner_schedules to authenticated;

grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.cancel_clinic_appointment(uuid,text) to authenticated;
grant execute on function public.set_clinic_appointment_status(uuid,text,text) to authenticated;

-- ------------------------------------------------------------
-- 13) Chananya specialty seed
-- ------------------------------------------------------------
insert into public.clinic_specialties(code,name_th,name_en,discipline)
values
  ('TTM-MED','เวชกรรมไทย','Thai Traditional Medicine','thai_traditional_medicine'),
  ('TTM-PHM','เภสัชกรรมไทย','Thai Traditional Pharmacy','thai_traditional_medicine'),
  ('TTM-MSG','หัตถเวชกรรมไทย / นวดไทย','Thai Traditional Therapeutic Massage','thai_traditional_medicine'),
  ('TTM-MID','ผดุงครรภ์ไทย','Thai Traditional Midwifery','thai_traditional_medicine'),
  ('WELLNESS','เวชศาสตร์สุขภาวะ','Wellness Practice','wellness'),
  ('REHAB','เวชศาสตร์ฟื้นฟู','Physical Medicine and Rehabilitation','modern_medicine'),
  ('GP','เวชปฏิบัติทั่วไป','General Practice','modern_medicine'),
  ('PHARMACY','เภสัชกรรม','Pharmacy','pharmacy')
on conflict (code) do update
set name_th = excluded.name_th,
    name_en = excluded.name_en,
    discipline = excluded.discipline,
    active = true;

commit;

select
  'CHANANYA_APPOINTMENT_MODULE_READY' as status,
  (select count(*) from public.clinic_specialties where active = true) as specialty_count,
  (select count(*) from public.practitioner_schedules) as schedule_count,
  (select count(*) from public.clinic_appointments) as appointment_count;
