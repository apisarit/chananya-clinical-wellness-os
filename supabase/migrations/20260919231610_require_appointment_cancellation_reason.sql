begin;

create or replace function public.cancel_clinic_appointment(
  p_appointment_id uuid,
  p_reason text
)
returns public.clinic_appointments
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_appt public.clinic_appointments%rowtype;
  v_old text;
begin
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'CANCELLATION_REASON_REQUIRED'; end if;

  perform public.assert_clinic_subscription_active(v_clinic_id);

  select * into v_appt
  from public.clinic_appointments a
  where a.id = p_appointment_id and a.clinic_id = v_clinic_id
  for update;

  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if v_appt.status not in ('booked','confirmed') then raise exception 'APPOINTMENT_CANNOT_BE_CANCELLED'; end if;

  v_old := v_appt.status;
  update public.clinic_appointments
  set status = 'cancelled', cancellation_reason = trim(p_reason),
      cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_appointment_id and clinic_id = v_clinic_id
  returning * into v_appt;

  insert into public.appointment_events(
    clinic_id, appointment_id, event_type, old_status, new_status, detail, actor_id
  ) values (
    v_clinic_id, v_appt.id, 'cancelled', v_old, 'cancelled',
    jsonb_build_object('reason', trim(p_reason)), auth.uid()
  );

  return v_appt;
end;
$$;

revoke all on function public.cancel_clinic_appointment(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_clinic_appointment(uuid,text) to authenticated;

create or replace function public.set_clinic_appointment_status(
  p_appointment_id uuid,
  p_new_status text,
  p_note text default null
)
returns public.clinic_appointments
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_appt public.clinic_appointments%rowtype;
  v_old text;
  v_operator boolean;
  v_practitioner boolean;
begin
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  v_operator := public.is_appointment_operator();
  v_practitioner := public.is_appointment_practitioner();
  if not (v_operator or v_practitioner) then raise exception 'APPOINTMENT_STAFF_REQUIRED'; end if;

  perform public.assert_clinic_subscription_active(v_clinic_id);

  if v_operator and p_new_status not in ('confirmed','checked_in','no_show','rescheduled','in_service','completed') then
    raise exception 'INVALID_ADMIN_APPOINTMENT_STATUS';
  end if;
  if not v_operator and v_practitioner and p_new_status not in ('in_service','completed') then
    raise exception 'PRACTITIONER_STATUS_NOT_ALLOWED';
  end if;

  select * into v_appt
  from public.clinic_appointments a
  where a.id = p_appointment_id and a.clinic_id = v_clinic_id
  for update;

  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if not v_operator and v_practitioner and v_appt.practitioner_id <> auth.uid() then
    raise exception 'APPOINTMENT_ACCESS_DENIED';
  end if;

  v_old := v_appt.status;
  if not (
    (v_old = 'booked' and p_new_status in ('confirmed','checked_in','no_show','rescheduled'))
    or (v_old = 'confirmed' and p_new_status in ('checked_in','no_show','rescheduled'))
    or (v_old = 'checked_in' and p_new_status = 'in_service')
    or (v_old = 'in_service' and p_new_status = 'completed')
  ) then
    raise exception 'INVALID_APPOINTMENT_TRANSITION';
  end if;

  update public.clinic_appointments
  set status = p_new_status,
      notes = case
        when nullif(trim(p_note), '') is null then notes
        when notes is null then trim(p_note)
        else notes || E'\n' || trim(p_note)
      end
  where id = p_appointment_id and clinic_id = v_clinic_id
  returning * into v_appt;

  insert into public.appointment_events(
    clinic_id, appointment_id, event_type, old_status, new_status, detail, actor_id
  ) values (
    v_clinic_id, v_appt.id, 'status_changed', v_old, p_new_status,
    jsonb_build_object('note', p_note), auth.uid()
  );

  return v_appt;
end;
$$;

revoke all on function public.set_clinic_appointment_status(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.set_clinic_appointment_status(uuid,text,text) to authenticated;

commit;
