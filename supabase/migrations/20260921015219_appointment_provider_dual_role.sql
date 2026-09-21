begin;

-- A clinic administrator or owner can also be a clinical practitioner.  The
-- clinic membership remains the authorization boundary, while profiles.role
-- carries the practitioner's clinical capability.  This avoids replacing an
-- owner's/admin's membership role merely to make the person schedulable.
create or replace function public.list_appointment_practitioners()
returns table (
  practitioner_id uuid,
  display_name text,
  clinic_role text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;

  perform public.assert_clinic_subscription_active(v_clinic_id);

  return query
  select
    m.profile_id,
    coalesce(nullif(trim(p.full_name), ''), 'ผู้ให้บริการ')::text,
    case
      when m.clinic_role in ('practitioner','doctor') then m.clinic_role::text
      else p.role::text
    end
  from public.clinic_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.clinic_id = v_clinic_id
    and m.active
    and (
      m.clinic_role in ('practitioner','doctor')
      or p.role in ('practitioner','doctor')
    )
  order by coalesce(nullif(trim(p.full_name), ''), 'ผู้ให้บริการ'), m.profile_id;
end;
$$;

create or replace function public.create_practitioner_schedule(
  p_practitioner_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_branch_code text default 'MAIN',
  p_room_code text default null,
  p_max_patients integer default 1,
  p_slot_minutes integer default 30,
  p_notes text default null
)
returns public.practitioner_schedules
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_result public.practitioner_schedules%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;

  perform public.assert_clinic_subscription_active(v_clinic_id);

  if p_practitioner_id is null then raise exception 'PRACTITIONER_REQUIRED'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'SCHEDULE_TITLE_REQUIRED'; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'INVALID_SCHEDULE_TIME';
  end if;
  if p_starts_at <= now() then raise exception 'SCHEDULE_MUST_BE_IN_FUTURE'; end if;
  if p_max_patients is null or p_max_patients < 1 or p_max_patients > 200 then
    raise exception 'INVALID_MAX_PATIENTS';
  end if;
  if p_slot_minutes is null or p_slot_minutes < 5 or p_slot_minutes > 480 then
    raise exception 'INVALID_SLOT_MINUTES';
  end if;
  if not exists (
    select 1
    from public.clinic_memberships m
    join public.profiles p on p.id = m.profile_id
    where m.clinic_id = v_clinic_id
      and m.profile_id = p_practitioner_id
      and m.active
      and (
        m.clinic_role in ('practitioner','doctor')
        or p.role in ('practitioner','doctor')
      )
  ) then
    raise exception 'PRACTITIONER_NOT_AVAILABLE';
  end if;

  insert into public.practitioner_schedules (
    clinic_id, practitioner_id, branch_code, room_code, title,
    starts_at, ends_at, slot_minutes, max_patients, booking_status,
    notes, created_by
  ) values (
    v_clinic_id, p_practitioner_id,
    coalesce(nullif(trim(p_branch_code), ''), 'MAIN'),
    nullif(trim(p_room_code), ''), trim(p_title),
    p_starts_at, p_ends_at, p_slot_minutes, p_max_patients, 'open',
    nullif(trim(p_notes), ''), auth.uid()
  ) returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.list_appointment_practitioners() from public, anon, authenticated, service_role;
revoke all on function public.create_practitioner_schedule(uuid,text,timestamptz,timestamptz,text,text,integer,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.list_appointment_practitioners() to authenticated;
grant execute on function public.create_practitioner_schedule(uuid,text,timestamptz,timestamptz,text,text,integer,integer,text) to authenticated;

commit;
