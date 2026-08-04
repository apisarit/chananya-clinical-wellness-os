-- ============================================================
-- CHANANYA APPOINTMENT ROLE SEPARATION
-- admin/reception = appointment operators
-- practitioner/doctor = clinical status only
-- super_admin = read/oversight only (no routine appointment actions)
-- ============================================================

begin;

create or replace function public.is_appointment_operator()
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
      and coalesce(p.system_role, '') <> 'super_admin'
      and (
        p.system_role = 'admin'
        or p.role in ('admin','reception')
      )
  );
$$;

create or replace function public.is_appointment_practitioner()
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
      and coalesce(p.system_role, '') <> 'super_admin'
      and p.role in ('practitioner','doctor')
  );
$$;

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
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;

  select * into v_schedule
  from public.practitioner_schedules
  where id = p_schedule_id
  for update;

  if not found then raise exception 'SCHEDULE_NOT_FOUND'; end if;
  if v_schedule.booking_status <> 'open' then raise exception 'SCHEDULE_NOT_OPEN'; end if;
  if v_schedule.starts_at <= now() then raise exception 'SCHEDULE_ALREADY_STARTED'; end if;

  select count(*) into v_active_count
  from public.clinic_appointments a
  where a.schedule_id = p_schedule_id
    and a.status in ('booked','confirmed','checked_in','in_service');

  if v_active_count >= v_schedule.max_patients then raise exception 'SCHEDULE_FULL'; end if;

  select coalesce(max(queue_number),0) + 1 into v_queue
  from public.clinic_appointments
  where schedule_id = p_schedule_id;

  v_appt_no := 'APT-' || to_char(current_date,'YYYYMMDD') || '-' ||
               upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.clinic_appointments (
    appointment_no, patient_id, schedule_id, practitioner_id, service_id,
    queue_number, scheduled_start, scheduled_end, status, booking_source,
    chief_complaint, notes, created_by
  ) values (
    v_appt_no, p_patient_id, p_schedule_id, v_schedule.practitioner_id,
    v_schedule.service_id, v_queue, v_schedule.starts_at, v_schedule.ends_at,
    'booked', 'staff', nullif(trim(p_chief_complaint),''),
    nullif(trim(p_notes),''), auth.uid()
  ) returning * into v_result;

  insert into public.appointment_events(
    appointment_id,event_type,new_status,detail,actor_id
  ) values (
    v_result.id,'booked','booked',
    jsonb_build_object('queue_number',v_queue,'booking_source','staff'),auth.uid()
  );

  return v_result;
end;
$$;

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
  v_old text;
begin
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;

  select * into v_appt
  from public.clinic_appointments
  where id = p_appointment_id
  for update;

  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if v_appt.status not in ('booked','confirmed') then raise exception 'APPOINTMENT_CANNOT_BE_CANCELLED'; end if;

  v_old := v_appt.status;
  update public.clinic_appointments
  set status='cancelled', cancellation_reason=nullif(trim(p_reason),''),
      cancelled_by=auth.uid(), cancelled_at=now()
  where id=p_appointment_id
  returning * into v_appt;

  insert into public.appointment_events(
    appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_appt.id,'cancelled',v_old,'cancelled',jsonb_build_object('reason',p_reason),auth.uid()
  );

  return v_appt;
end;
$$;

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
  v_operator boolean;
  v_practitioner boolean;
begin
  v_operator := public.is_appointment_operator();
  v_practitioner := public.is_appointment_practitioner();

  if not (v_operator or v_practitioner) then raise exception 'APPOINTMENT_STAFF_REQUIRED'; end if;

  if v_operator and p_new_status not in ('booked','confirmed','checked_in','cancelled','no_show','rescheduled','in_service','completed') then
    raise exception 'INVALID_ADMIN_APPOINTMENT_STATUS';
  end if;

  if v_practitioner and p_new_status not in ('in_service','completed') then
    raise exception 'PRACTITIONER_STATUS_NOT_ALLOWED';
  end if;

  select * into v_appt
  from public.clinic_appointments
  where id = p_appointment_id
  for update;

  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;

  if v_practitioner and v_appt.practitioner_id <> auth.uid() then
    raise exception 'APPOINTMENT_ACCESS_DENIED';
  end if;

  v_old := v_appt.status;
  update public.clinic_appointments
  set status=p_new_status,
      notes=case
        when nullif(trim(p_note),'') is null then notes
        when notes is null then trim(p_note)
        else notes || E'\n' || trim(p_note)
      end
  where id=p_appointment_id
  returning * into v_appt;

  insert into public.appointment_events(
    appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_appt.id,'status_changed',v_old,p_new_status,jsonb_build_object('note',p_note),auth.uid()
  );

  return v_appt;
end;
$$;

grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.cancel_clinic_appointment(uuid,text) to authenticated;
grant execute on function public.set_clinic_appointment_status(uuid,text,text) to authenticated;

commit;

select
  'CHANANYA_APPOINTMENT_ROLE_SEPARATION_READY' as status,
  'admin/reception operate; practitioner clinical status; super_admin oversight' as rule;
