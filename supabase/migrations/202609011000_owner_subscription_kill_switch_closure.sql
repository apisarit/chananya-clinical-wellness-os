begin;

-- ============================================================
-- OWNER SUBSCRIPTION KILL-SWITCH CLOSURE
--
-- Forward-only closure for legacy browser and service-role paths which were
-- created before clinics.subscription_state became authoritative.  An
-- already-authenticated browser session must lose every RLS-backed read and
-- write as soon as its clinic is suspended.  Appointment, approval and LINE
-- operational SECURITY DEFINER paths additionally bind to one exact clinic.
-- Backup/export/restore evidence functions are intentionally not changed.
-- ============================================================

-- Service and trigger code use one exact-clinic assertion.  It is not
-- browser-callable: authenticated SECURITY DEFINER functions invoke it as the
-- function owner, while service endpoints call it through a service-only RPC.
create or replace function public.assert_clinic_subscription_active(
  p_clinic_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic public.clinics%rowtype;
begin
  if p_clinic_id is null then
    raise exception 'CNYOS_CLINIC_ID_REQUIRED';
  end if;

  select * into v_clinic
  from public.clinics c
  where c.id = p_clinic_id
  for share;

  if not found then
    raise exception 'CNYOS_CLINIC_NOT_FOUND';
  end if;
  if not v_clinic.active or v_clinic.subscription_state <> 'active' then
    raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED';
  end if;

  -- An authenticated caller may reach this helper only from a SECURITY
  -- DEFINER routine/trigger and must still be bound to its selected clinic.
  if auth.role() <> 'service_role'
     and public.current_clinic_id() is distinct from p_clinic_id then
    raise exception 'CNYOS_CLINIC_SCOPE_DENIED';
  end if;

  return p_clinic_id;
end;
$$;

revoke all on function public.assert_clinic_subscription_active(uuid)
  from public, anon, authenticated;
grant execute on function public.assert_clinic_subscription_active(uuid)
  to service_role;

-- Every legacy permissive policy is ANDed with this restrictive boundary.
-- The helper is SECURITY DEFINER, so it can resolve the membership after the
-- browser policy itself has hidden clinic_memberships and clinics.
do $$
declare
  v_table record;
begin
  for v_table in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r','p')
      and c.relrowsecurity
      and (
        has_table_privilege('authenticated',c.oid,'SELECT')
        or has_table_privilege('authenticated',c.oid,'INSERT')
        or has_table_privilege('authenticated',c.oid,'UPDATE')
        or has_table_privilege('authenticated',c.oid,'DELETE')
      )
  loop
    execute format(
      'drop policy if exists cnyos_active_subscription_boundary on %I.%I',
      v_table.nspname,
      v_table.relname
    );
    execute format(
      'create policy cnyos_active_subscription_boundary on %I.%I '
      'as restrictive for all to authenticated '
      'using (public.current_clinic_id() is not null) '
      'with check (public.current_clinic_id() is not null)',
      v_table.nspname,
      v_table.relname
    );
  end loop;
end $$;

-- Owner-rights views otherwise bypass the RLS boundary of their base tables.
-- Apply security_invoker to every ordinary public view exposed to browsers.
do $$
declare
  v_view record;
begin
  for v_view in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and has_table_privilege('authenticated', c.oid, 'SELECT')
  loop
    execute format(
      'alter view %I.%I set (security_invoker = true)',
      v_view.nspname,
      v_view.relname
    );
  end loop;
end $$;

-- This clinical trace view also receives an explicit tenant predicate.  The
-- security-invoker option then enforces the base-table RLS policies as well.
create or replace view public.v_clinical_herbal_traceability
with (security_invoker = true)
as
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
left join public.inventory_lots il on il.id = di.inventory_lot_id
where e.clinic_id = public.current_clinic_id();

grant select on public.v_clinical_herbal_traceability to authenticated;

-- ============================================================
-- Appointment tenant ownership and browser RPC closure
-- ============================================================

alter table public.practitioner_schedules
  add column if not exists clinic_id uuid;
alter table public.clinic_appointments
  add column if not exists clinic_id uuid;
alter table public.appointment_events
  add column if not exists clinic_id uuid;

do $$
begin
  if exists (
    select 1
    from public.clinic_appointments a
    join public.patients p on p.id = a.patient_id
    group by a.schedule_id
    having count(distinct p.clinic_id) > 1
  ) then
    raise exception 'APPOINTMENT_SCHEDULE_CROSS_TENANT_BACKFILL';
  end if;
end $$;

update public.practitioner_schedules s
set clinic_id = mapped.clinic_id
from (
  select a.schedule_id, min(p.clinic_id::text)::uuid as clinic_id
  from public.clinic_appointments a
  join public.patients p on p.id = a.patient_id
  group by a.schedule_id
) mapped
where mapped.schedule_id = s.id
  and s.clinic_id is null;

-- An unused historical schedule has no tenant-bearing patient reference.
-- Attribute it only when every historical membership belonging to its creator
-- and practitioner converges on exactly one clinic. Inactive memberships are
-- still provenance; active/primary flags are runtime selection preferences.
update public.practitioner_schedules s
set clinic_id = (
  select min(m.clinic_id::text)::uuid
  from public.clinic_memberships m
  where m.profile_id in (s.created_by,s.practitioner_id)
  having count(distinct m.clinic_id)=1
)
where s.clinic_id is null;

do $$
begin
  if exists (select 1 from public.practitioner_schedules where clinic_id is null) then
    raise exception 'APPOINTMENT_SCHEDULE_CLINIC_BACKFILL_REQUIRED';
  end if;
end $$;

update public.clinic_appointments a
set clinic_id = p.clinic_id
from public.patients p
where p.id = a.patient_id
  and a.clinic_id is null;

do $$
begin
  if exists (
    select 1
    from public.clinic_appointments a
    join public.practitioner_schedules s on s.id = a.schedule_id
    join public.patients p on p.id = a.patient_id
    where a.clinic_id is null
       or a.clinic_id <> s.clinic_id
       or a.clinic_id <> p.clinic_id
  ) then
    raise exception 'APPOINTMENT_CLINIC_BACKFILL_MISMATCH';
  end if;
end $$;

update public.appointment_events e
set clinic_id = a.clinic_id
from public.clinic_appointments a
where a.id = e.appointment_id
  and e.clinic_id is null;

do $$
begin
  if exists (select 1 from public.appointment_events where clinic_id is null) then
    raise exception 'APPOINTMENT_EVENT_CLINIC_BACKFILL_REQUIRED';
  end if;
end $$;

alter table public.practitioner_schedules alter column clinic_id set not null;
alter table public.clinic_appointments alter column clinic_id set not null;
alter table public.appointment_events alter column clinic_id set not null;

create unique index if not exists practitioner_schedules_id_clinic_uidx
  on public.practitioner_schedules(id, clinic_id);
create unique index if not exists clinic_appointments_id_clinic_uidx
  on public.clinic_appointments(id, clinic_id);
create index if not exists practitioner_schedules_clinic_starts_idx
  on public.practitioner_schedules(clinic_id, starts_at);
create index if not exists clinic_appointments_clinic_start_idx
  on public.clinic_appointments(clinic_id, scheduled_start);
create index if not exists appointment_events_clinic_created_idx
  on public.appointment_events(clinic_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'practitioner_schedules_clinic_id_fkey'
      and conrelid = 'public.practitioner_schedules'::regclass
  ) then
    alter table public.practitioner_schedules
      add constraint practitioner_schedules_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clinic_appointments_schedule_clinic_fkey'
      and conrelid = 'public.clinic_appointments'::regclass
  ) then
    alter table public.clinic_appointments
      add constraint clinic_appointments_schedule_clinic_fkey
      foreign key (schedule_id, clinic_id)
      references public.practitioner_schedules(id, clinic_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clinic_appointments_patient_clinic_fkey'
      and conrelid = 'public.clinic_appointments'::regclass
  ) then
    alter table public.clinic_appointments
      add constraint clinic_appointments_patient_clinic_fkey
      foreign key (patient_id, clinic_id)
      references public.patients(id, clinic_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_events_appointment_clinic_fkey'
      and conrelid = 'public.appointment_events'::regclass
  ) then
    alter table public.appointment_events
      add constraint appointment_events_appointment_clinic_fkey
      foreign key (appointment_id, clinic_id)
      references public.clinic_appointments(id, clinic_id) on delete cascade;
  end if;
end $$;

create or replace function public.is_clinic_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      join public.profiles p on p.id = m.profile_id
      where m.clinic_id = public.current_clinic_id()
        and m.profile_id = auth.uid()
        and m.active
        and (
          m.clinic_role in ('owner','admin')
          or p.system_role in ('admin','super_admin')
        )
    );
$$;

create or replace function public.is_reception_or_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      join public.profiles p on p.id = m.profile_id
      where m.clinic_id = public.current_clinic_id()
        and m.profile_id = auth.uid()
        and m.active
        and p.system_role <> 'super_admin'
        and (m.clinic_role in ('owner','admin','reception') or p.system_role = 'admin')
    );
$$;

create or replace function public.is_practitioner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      where m.clinic_id = public.current_clinic_id()
        and m.profile_id = auth.uid()
        and m.active
        and m.clinic_role in ('practitioner','doctor')
    );
$$;

create or replace function public.is_appointment_operator()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      join public.profiles p on p.id = m.profile_id
      where m.clinic_id = public.current_clinic_id()
        and m.profile_id = auth.uid()
        and m.active
        and p.system_role <> 'super_admin'
        and (m.clinic_role in ('owner','admin','reception') or p.system_role = 'admin')
    );
$$;

create or replace function public.is_appointment_practitioner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      join public.profiles p on p.id = m.profile_id
      where m.clinic_id = public.current_clinic_id()
        and m.profile_id = auth.uid()
        and m.active
        and p.system_role <> 'super_admin'
        and m.clinic_role in ('practitioner','doctor')
    );
$$;

revoke all on function public.is_clinic_admin() from public;
revoke all on function public.is_reception_or_admin() from public;
revoke all on function public.is_practitioner() from public;
revoke all on function public.is_appointment_operator() from public;
revoke all on function public.is_appointment_practitioner() from public;
grant execute on function public.is_clinic_admin() to authenticated, service_role;
grant execute on function public.is_reception_or_admin() to authenticated, service_role;
grant execute on function public.is_practitioner() to authenticated, service_role;
grant execute on function public.is_appointment_operator() to authenticated, service_role;
grant execute on function public.is_appointment_practitioner() to authenticated, service_role;

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
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_schedule public.practitioner_schedules%rowtype;
  v_active_count integer;
  v_queue integer;
  v_result public.clinic_appointments%rowtype;
  v_appt_no text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;

  perform public.assert_clinic_subscription_active(v_clinic_id);

  select * into v_schedule
  from public.practitioner_schedules s
  where s.id = p_schedule_id
    and s.clinic_id = v_clinic_id
  for update;

  if not found then raise exception 'SCHEDULE_NOT_FOUND'; end if;
  if v_schedule.booking_status <> 'open' then raise exception 'SCHEDULE_NOT_OPEN'; end if;
  if v_schedule.starts_at <= now() then raise exception 'SCHEDULE_ALREADY_STARTED'; end if;
  if not exists (
    select 1 from public.patients p
    where p.id = p_patient_id and p.clinic_id = v_clinic_id and p.active
  ) then raise exception 'PATIENT_NOT_FOUND'; end if;

  select count(*) into v_active_count
  from public.clinic_appointments a
  where a.schedule_id = p_schedule_id
    and a.clinic_id = v_clinic_id
    and a.status in ('booked','confirmed','checked_in','in_service');

  if v_active_count >= v_schedule.max_patients then raise exception 'SCHEDULE_FULL'; end if;

  select coalesce(max(queue_number),0) + 1 into v_queue
  from public.clinic_appointments
  where schedule_id = p_schedule_id and clinic_id = v_clinic_id;

  v_appt_no := 'APT-' || to_char(current_date,'YYYYMMDD') || '-' ||
               upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.clinic_appointments (
    clinic_id,appointment_no,patient_id,schedule_id,practitioner_id,service_id,
    queue_number,scheduled_start,scheduled_end,status,booking_source,
    chief_complaint,notes,created_by
  ) values (
    v_clinic_id,v_appt_no,p_patient_id,p_schedule_id,v_schedule.practitioner_id,
    v_schedule.service_id,v_queue,v_schedule.starts_at,v_schedule.ends_at,
    'booked','staff',nullif(trim(p_chief_complaint),''),
    nullif(trim(p_notes),''),auth.uid()
  ) returning * into v_result;

  insert into public.appointment_events(
    clinic_id,appointment_id,event_type,new_status,detail,actor_id
  ) values (
    v_clinic_id,v_result.id,'booked','booked',
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
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_appt public.clinic_appointments%rowtype;
  v_old text;
begin
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_appointment_operator() then raise exception 'APPOINTMENT_OPERATOR_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);

  select * into v_appt
  from public.clinic_appointments a
  where a.id = p_appointment_id and a.clinic_id = v_clinic_id
  for update;

  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if v_appt.status not in ('booked','confirmed') then raise exception 'APPOINTMENT_CANNOT_BE_CANCELLED'; end if;

  v_old := v_appt.status;
  update public.clinic_appointments
  set status='cancelled',cancellation_reason=nullif(trim(p_reason),''),
      cancelled_by=auth.uid(),cancelled_at=now()
  where id=p_appointment_id and clinic_id=v_clinic_id
  returning * into v_appt;

  insert into public.appointment_events(
    clinic_id,appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_clinic_id,v_appt.id,'cancelled',v_old,'cancelled',
    jsonb_build_object('reason',p_reason),auth.uid()
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
set search_path = pg_catalog, public
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

  if v_operator and p_new_status not in ('booked','confirmed','checked_in','cancelled','no_show','rescheduled','in_service','completed') then
    raise exception 'INVALID_ADMIN_APPOINTMENT_STATUS';
  end if;
  if v_practitioner and p_new_status not in ('in_service','completed') then
    raise exception 'PRACTITIONER_STATUS_NOT_ALLOWED';
  end if;

  select * into v_appt
  from public.clinic_appointments a
  where a.id = p_appointment_id and a.clinic_id = v_clinic_id
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
  where id=p_appointment_id and clinic_id=v_clinic_id
  returning * into v_appt;

  insert into public.appointment_events(
    clinic_id,appointment_id,event_type,old_status,new_status,detail,actor_id
  ) values (
    v_clinic_id,v_appt.id,'status_changed',v_old,p_new_status,
    jsonb_build_object('note',p_note),auth.uid()
  );

  return v_appt;
end;
$$;

revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text) from public;
revoke all on function public.cancel_clinic_appointment(uuid,text) from public;
revoke all on function public.set_clinic_appointment_status(uuid,text,text) from public;
grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.cancel_clinic_appointment(uuid,text) to authenticated;
grant execute on function public.set_clinic_appointment_status(uuid,text,text) to authenticated;

drop policy if exists practitioner_schedules_read on public.practitioner_schedules;
create policy practitioner_schedules_read on public.practitioner_schedules
for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (booking_status='open' or practitioner_id=auth.uid() or public.is_reception_or_admin())
);

drop policy if exists practitioner_schedules_manage_own on public.practitioner_schedules;
create policy practitioner_schedules_manage_own on public.practitioner_schedules
for all to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (practitioner_id=auth.uid() or public.is_clinic_admin())
)
with check (
  clinic_id = public.current_clinic_id()
  and (practitioner_id=auth.uid() or public.is_clinic_admin())
);

drop policy if exists patient_user_links_own on public.patient_user_links;
create policy patient_user_links_own on public.patient_user_links
for select to authenticated
using (
  exists (
    select 1 from public.patients p
    where p.id=patient_user_links.patient_id
      and p.clinic_id=public.current_clinic_id()
  )
  and (user_id=auth.uid() or public.is_clinic_admin())
);

drop policy if exists patient_user_links_manage on public.patient_user_links;
create policy patient_user_links_manage on public.patient_user_links
for all to authenticated
using (
  public.is_clinic_admin()
  and exists (
    select 1 from public.patients p
    where p.id=patient_user_links.patient_id
      and p.clinic_id=public.current_clinic_id()
  )
)
with check (
  public.is_clinic_admin()
  and exists (
    select 1 from public.patients p
    where p.id=patient_user_links.patient_id
      and p.clinic_id=public.current_clinic_id()
  )
);

drop policy if exists clinic_appointments_staff_read on public.clinic_appointments;
create policy clinic_appointments_staff_read on public.clinic_appointments
for select to authenticated
using (
  clinic_id=public.current_clinic_id()
  and (
    public.is_reception_or_admin()
    or practitioner_id=auth.uid()
    or exists (
      select 1 from public.patient_user_links l
      where l.patient_id=clinic_appointments.patient_id
        and l.user_id=auth.uid()
        and l.active
    )
  )
);

drop policy if exists appointment_events_read on public.appointment_events;
create policy appointment_events_read on public.appointment_events
for select to authenticated
using (
  clinic_id=public.current_clinic_id()
  and (
    public.is_clinic_admin()
    or exists (
      select 1 from public.clinic_appointments a
      where a.id=appointment_events.appointment_id
        and a.clinic_id=appointment_events.clinic_id
        and a.practitioner_id=auth.uid()
    )
  )
);

drop trigger if exists trg_appointment_events_append_only on public.appointment_events;
create trigger trg_appointment_events_append_only
before update or delete on public.appointment_events
for each row execute function public.reject_append_only_mutation();

-- ============================================================
-- Approval task tenant ownership and browser RPC closure
-- ============================================================

alter table public.approval_tasks add column if not exists clinic_id uuid;
alter table public.approval_actions add column if not exists clinic_id uuid;

-- Approval rows had no tenant column. Backfill only when all historical
-- memberships for every referenced participant converge on one clinic.
-- Ambiguous rows abort this migration for explicit operator remediation.
update public.approval_tasks t
set clinic_id = (
  select min(m.clinic_id::text)::uuid
  from public.clinic_memberships m
  where m.profile_id in (t.requested_by,t.assigned_to,t.decided_by)
  having count(distinct m.clinic_id)=1
)
where t.clinic_id is null;

do $$
begin
  if exists (select 1 from public.approval_tasks where clinic_id is null) then
    raise exception 'APPROVAL_TASK_CLINIC_BACKFILL_REQUIRED';
  end if;
end $$;

update public.approval_actions a
set clinic_id = t.clinic_id
from public.approval_tasks t
where t.id = a.task_id
  and a.clinic_id is null;

do $$
begin
  if exists (select 1 from public.approval_actions where clinic_id is null) then
    raise exception 'APPROVAL_ACTION_CLINIC_BACKFILL_REQUIRED';
  end if;
end $$;

alter table public.approval_tasks alter column clinic_id set not null;
alter table public.approval_actions alter column clinic_id set not null;

create unique index if not exists approval_tasks_id_clinic_uidx
  on public.approval_tasks(id,clinic_id);
create index if not exists approval_tasks_clinic_status_idx
  on public.approval_tasks(clinic_id,status,priority,requested_at desc);
create index if not exists approval_actions_clinic_task_idx
  on public.approval_actions(clinic_id,task_id,acted_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='approval_tasks_clinic_id_fkey'
      and conrelid='public.approval_tasks'::regclass
  ) then
    alter table public.approval_tasks
      add constraint approval_tasks_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname='approval_actions_task_clinic_fkey'
      and conrelid='public.approval_actions'::regclass
  ) then
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (task_id,clinic_id)
      references public.approval_tasks(id,clinic_id) on delete cascade;
  end if;
end $$;

create or replace function public.is_admin_or_super()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.current_clinic_id() is not null
    and exists (
      select 1
      from public.clinic_memberships m
      join public.profiles p on p.id=m.profile_id
      where m.clinic_id=public.current_clinic_id()
        and m.profile_id=auth.uid()
        and m.active
        and (m.clinic_role in ('owner','admin') or p.system_role in ('admin','super_admin'))
    );
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when public.current_clinic_id() is null then 'viewer'
    when coalesce(p.system_role,'staff')='super_admin' then 'super_admin'
    when coalesce(p.system_role,'staff')='admin'
      or public.current_department_role() in ('owner','admin') then 'governance_admin'
    else public.current_department_role()
  end
  from public.profiles p
  where p.id=auth.uid();
$$;

revoke all on function public.is_admin_or_super() from public;
revoke all on function public.current_user_role() from public;
grant execute on function public.is_admin_or_super() to authenticated,service_role;
grant execute on function public.current_user_role() to authenticated,service_role;

create or replace function public.create_approval_task(
  p_task_type text,
  p_module text,
  p_title text,
  p_description text default null,
  p_priority text default 'normal',
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_due_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_id uuid;
  v_no text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if p_priority not in ('low','normal','high','urgent','critical') then
    raise exception 'INVALID_APPROVAL_PRIORITY';
  end if;

  v_no := 'AT-' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  insert into public.approval_tasks(
    clinic_id,task_no,task_type,module,title,description,priority,reference_type,
    reference_id,requested_by,due_at,metadata
  ) values (
    v_clinic_id,v_no,p_task_type,p_module,p_title,p_description,p_priority,p_reference_type,
    p_reference_id,auth.uid(),p_due_at,coalesce(p_metadata,'{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.decide_approval_task(
  p_task_id uuid,
  p_action text,
  p_notes text default null
)
returns public.approval_tasks
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_task public.approval_tasks%rowtype;
  v_from text;
  v_to text;
begin
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  if not public.is_admin_or_super() then raise exception 'ADMIN_PERMISSION_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);

  select * into v_task
  from public.approval_tasks t
  where t.id=p_task_id and t.clinic_id=v_clinic_id
  for update;
  if not found then raise exception 'APPROVAL_TASK_NOT_FOUND'; end if;

  v_from := v_task.status;
  v_to := case p_action
    when 'take' then 'in_review'
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'complete' then 'completed'
    when 'cancel' then 'cancelled'
    else null
  end;
  if v_to is null then raise exception 'INVALID_APPROVAL_ACTION'; end if;

  update public.approval_tasks
  set status=v_to,
      assigned_to=case when p_action='take' then auth.uid() else coalesce(assigned_to,auth.uid()) end,
      decision_notes=case when p_action in ('approve','reject','cancel') then p_notes else decision_notes end,
      decided_by=case when p_action in ('approve','reject','cancel') then auth.uid() else decided_by end,
      decided_at=case when p_action in ('approve','reject','cancel') then now() else decided_at end,
      completed_at=case when p_action='complete' then now() else completed_at end
  where id=p_task_id and clinic_id=v_clinic_id
  returning * into v_task;

  insert into public.approval_actions(
    clinic_id,task_id,action,from_status,to_status,notes,action_by
  ) values (
    v_clinic_id,p_task_id,p_action,v_from,v_to,p_notes,auth.uid()
  );
  return v_task;
end;
$$;

revoke all on function public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb) from public;
revoke all on function public.decide_approval_task(uuid,text,text) from public;
grant execute on function public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb) to authenticated;
grant execute on function public.decide_approval_task(uuid,text,text) to authenticated;

drop policy if exists approval_tasks_read_participant on public.approval_tasks;
create policy approval_tasks_read_participant on public.approval_tasks
for select to authenticated
using (
  clinic_id=public.current_clinic_id()
  and (public.is_admin_or_super() or requested_by=auth.uid() or assigned_to=auth.uid())
);

drop policy if exists approval_tasks_create_staff on public.approval_tasks;
drop policy if exists approval_tasks_update_admin on public.approval_tasks;

drop policy if exists approval_actions_read_participant on public.approval_actions;
create policy approval_actions_read_participant on public.approval_actions
for select to authenticated
using (
  clinic_id=public.current_clinic_id()
  and (
    public.is_admin_or_super()
    or exists (
      select 1 from public.approval_tasks t
      where t.id=approval_actions.task_id
        and t.clinic_id=approval_actions.clinic_id
        and (t.requested_by=auth.uid() or t.assigned_to=auth.uid())
    )
  )
);

drop policy if exists approval_actions_insert_admin on public.approval_actions;

-- Direct task/action mutations can bypass transition validation and fabricate
-- append-only decision evidence. Browser callers retain tenant-filtered reads;
-- create/decide RPCs are the only authenticated mutation boundary.
revoke insert,update,delete on public.approval_tasks from authenticated;
revoke insert,update,delete on public.approval_actions from authenticated;
grant select on public.approval_tasks,public.approval_actions to authenticated;

drop trigger if exists trg_approval_actions_append_only on public.approval_actions;
create trigger trg_approval_actions_append_only
before update or delete on public.approval_actions
for each row execute function public.reject_append_only_mutation();

create or replace view public.admin_task_summary
with (security_invoker = true)
as
select
  count(*) filter (where status='pending') as pending,
  count(*) filter (where status='in_review') as in_review,
  count(*) filter (
    where priority in ('urgent','critical') and status in ('pending','in_review')
  ) as urgent,
  count(*) filter (
    where due_at is not null and due_at<now() and status in ('pending','in_review')
  ) as overdue,
  count(*) filter (
    where status='approved' and decided_at::date=current_date
  ) as approved_today,
  count(*) filter (
    where status='rejected' and decided_at::date=current_date
  ) as rejected_today
from public.approval_tasks
where clinic_id=public.current_clinic_id()
  and public.current_clinic_id() is not null
having public.current_clinic_id() is not null;

grant select on public.admin_task_summary to authenticated;

-- ============================================================
-- Browser metadata functions retain active-clinic behavior but return no row
-- to a suspended session. Service health and backup automation remain usable.
-- ============================================================

create or replace function public.clinical_financial_handoffs_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    to_regprocedure('public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)') is not null
    and to_regprocedure('public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)') is not null
    and to_regprocedure('public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)') is not null,
    '2026-08-27.1'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

create or replace function public.department_persistence_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    to_regprocedure('public.current_access_context()') is not null
    and to_regprocedure('public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)') is not null
    and to_regprocedure('public.export_clinic_backup_domain(uuid,text)') is not null,
    '2026-08-27.1'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

create or replace function public.production_execution_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public
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
    '2026-08-27.2'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

create or replace function public.quality_release_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    to_regprocedure('public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.quality_reject_production_order(uuid,text,text)') is not null,
    '2026-08-27.3'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

create or replace function public.prescription_dispensing_healthcheck()
returns table (ready boolean, schema_version text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    to_regprocedure('public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)') is not null,
    '2026-08-27.2'::text
  where auth.role()='service_role' or public.current_clinic_id() is not null;
$$;

revoke all on function public.clinical_financial_handoffs_healthcheck() from public;
revoke all on function public.department_persistence_healthcheck() from public;
revoke all on function public.production_execution_healthcheck() from public;
revoke all on function public.quality_release_healthcheck() from public;
revoke all on function public.prescription_dispensing_healthcheck() from public;
grant execute on function public.clinical_financial_handoffs_healthcheck() to authenticated,service_role;
grant execute on function public.department_persistence_healthcheck() to authenticated,service_role;
grant execute on function public.production_execution_healthcheck() to authenticated,service_role;
grant execute on function public.quality_release_healthcheck() to authenticated,service_role;
grant execute on function public.prescription_dispensing_healthcheck() to authenticated,service_role;

-- ============================================================
-- Clinical sign-off exact-tenant SECURITY DEFINER closure
-- ============================================================

create or replace function public.sign_clinical_record_complete(
  p_encounter_id uuid,
  p_signer_name text default null,
  p_license_no text default null,
  p_reason text default 'Complete clinical record sign-off'
)
returns public.clinical_record_signoffs
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid;
  v_row public.clinical_record_signoffs;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic_id := public.current_clinic_id();
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.has_role(array['super_admin','admin','practitioner','doctor']) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1 from public.encounters e
    where e.id=p_encounter_id and e.clinic_id=v_clinic_id
  ) then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if not exists (
    select 1 from public.ttm_structured_diagnoses d
    where d.encounter_id=p_encounter_id
  ) then raise exception 'DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF'; end if;
  if not exists (
    select 1 from public.clinical_treatment_plans p
    where p.encounter_id=p_encounter_id
  ) and not exists (
    select 1 from public.clinical_treatment_sessions s
    where s.encounter_id=p_encounter_id
  ) then raise exception 'TREATMENT_REQUIRED_BEFORE_SIGNOFF'; end if;

  insert into public.clinical_record_signoffs(
    encounter_id,record_section,signer_id,signer_name,
    professional_license_no,signed_at,lock_record,reason
  ) values (
    p_encounter_id,'complete_record',auth.uid(),
    nullif(btrim(p_signer_name),''),nullif(btrim(p_license_no),''),
    now(),true,p_reason
  )
  on conflict(encounter_id,record_section) do update set
    signer_id=auth.uid(),
    signer_name=excluded.signer_name,
    professional_license_no=excluded.professional_license_no,
    signed_at=now(),
    lock_record=true,
    reason=excluded.reason
  returning * into v_row;

  insert into public.clinical_record_audit_events(
    encounter_id,event_type,record_section,actor_id,reason,details
  ) values (
    p_encounter_id,'SIGN_AND_LOCK','complete_record',auth.uid(),p_reason,
    pg_catalog.jsonb_build_object('license_no',p_license_no,'signed_at',now())
  );
  return v_row;
end;
$$;

create or replace function public.unlock_clinical_record_for_amendment(
  p_encounter_id uuid,
  p_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic_id := public.current_clinic_id();
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.has_role(array['super_admin','admin']) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_reason is null or length(btrim(p_reason))<5 then
    raise exception 'AMENDMENT_REASON_REQUIRED';
  end if;
  if not exists (
    select 1 from public.encounters e
    where e.id=p_encounter_id and e.clinic_id=v_clinic_id
  ) then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;

  update public.clinical_record_signoffs
  set lock_record=false,reason='Unlocked for amendment: '||btrim(p_reason)
  where encounter_id=p_encounter_id and record_section='complete_record';
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  insert into public.clinical_record_audit_events(
    encounter_id,event_type,record_section,actor_id,reason
  ) values (
    p_encounter_id,'UNLOCK_FOR_AMENDMENT','complete_record',auth.uid(),btrim(p_reason)
  );
  return true;
end;
$$;

revoke all on function public.sign_clinical_record_complete(uuid,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.unlock_clinical_record_for_amendment(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.sign_clinical_record_complete(uuid,text,text,text)
  to authenticated;
grant execute on function public.unlock_clinical_record_for_amendment(uuid,text)
  to authenticated;

-- ============================================================
-- Tenant write trigger for operational paths reached with the service key.
-- It deliberately excludes backup/export/restore and Owner control tables.
-- ============================================================

create or replace function public.prepare_line_subscription_off_exception(
  p_clinic_id uuid,
  p_capability text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic public.clinics%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_capability not in (
    'line-consent-withdrawal/v1',
    'line-finish-webhook/v1',
    'line-finish-notification/v1'
  ) then raise exception 'CNYOS_LINE_OFF_EXCEPTION_INVALID'; end if;

  select * into v_clinic
  from public.clinics c
  where c.id=p_clinic_id
  for share;
  if not found then raise exception 'CNYOS_CLINIC_NOT_FOUND'; end if;

  perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
  perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
  if v_clinic.active and v_clinic.subscription_state='active' then
    return false;
  end if;

  perform pg_catalog.set_config(
    'cnyos.subscription_off_exception',p_capability,true
  );
  perform pg_catalog.set_config(
    'cnyos.subscription_off_exception_clinic',p_clinic_id::text,true
  );
  return true;
end;
$$;

revoke all on function public.prepare_line_subscription_off_exception(uuid,text)
  from public,anon,authenticated,service_role;

create or replace function public.enforce_active_subscription_tenant_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_clinic uuid;
  v_new_clinic uuid;
  v_capability text := pg_catalog.current_setting(
    'cnyos.subscription_off_exception',true
  );
  v_capability_clinic uuid := nullif(pg_catalog.current_setting(
    'cnyos.subscription_off_exception_clinic',true
  ),'')::uuid;
begin
  -- SQL migrations and controlled database restores run without a request JWT.
  -- This is the only maintenance bypass; browser and service-key requests
  -- always carry auth.role() and remain subject to the exact clinic lock.
  if auth.role() is null
     and auth.uid() is null
     and session_user=current_user then
    return case when tg_op='DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT' then
    v_old_clinic := old.clinic_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_clinic := new.clinic_id;
  end if;

  -- These capabilities are transaction-local, service-role-only and set only
  -- by exact wrapper functions after locking an already-existing row. They do
  -- not permit a new claim, send, link, consent grant or queue entry.
  if auth.role()='service_role'
    and coalesce(v_new_clinic,v_old_clinic)=v_capability_clinic
    and (
    (
      v_capability='line-consent-withdrawal/v1'
      and tg_table_name in (
        'line_oa_notification_preferences','line_oa_notification_outbox',
        'patient_identity_events','audit_logs'
      )
    )
    or (
      v_capability='line-finish-webhook/v1'
      and tg_table_name='line_oa_webhook_events'
    )
    or (
      v_capability='line-finish-notification/v1'
      and tg_table_name in (
        'line_oa_notification_outbox','line_oa_delivery_events',
        'patient_identity_events'
      )
    )
  ) then
    return case when tg_op='DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT' then
    perform public.assert_clinic_subscription_active(v_old_clinic);
  end if;
  if tg_op <> 'DELETE' then
    if v_old_clinic is distinct from v_new_clinic then
      perform public.assert_clinic_subscription_active(v_new_clinic);
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

revoke all on function public.enforce_active_subscription_tenant_write()
  from public,anon,authenticated,service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'practitioner_schedules','clinic_appointments','appointment_events',
    'approval_tasks','approval_actions',
    'patient_identity_link_requests','patient_identity_links',
    'patient_qr_sessions','patient_identity_events',
    'line_oa_contacts','line_oa_notification_preferences',
    'line_oa_webhook_events','line_oa_notification_outbox',
    'line_oa_delivery_events'
  ] loop
    execute format(
      'drop trigger if exists trg_cnyos_active_subscription_write on public.%I',
      v_table
    );
    execute format(
      'create trigger trg_cnyos_active_subscription_write '
      'before insert or update or delete on public.%I '
      'for each row execute function public.enforce_active_subscription_tenant_write()',
      v_table
    );
  end loop;
end $$;

-- A browser write must hold a SHARE lock on the clinic row for the complete
-- statement. Owner OFF takes FOR UPDATE in the reviewed concurrency RPC, so
-- either the operational statement commits first or the writer wakes after
-- OFF and fails closed. The JWT subject check keeps migrations/background
-- owner work outside browser request context.
create or replace function public.enforce_authenticated_subscription_statement_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    return null;
  end if;
  v_clinic_id := public.current_clinic_id();
  if v_clinic_id is null then
    raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED';
  end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  return null;
end;
$$;

revoke all on function public.enforce_authenticated_subscription_statement_write()
  from public,anon,authenticated,service_role;

do $$
declare
  v_table record;
begin
  for v_table in
    select n.nspname,c.relname
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relkind in ('r','p')
  loop
    execute format(
      'drop trigger if exists trg_cnyos_authenticated_subscription_statement_write on %I.%I',
      v_table.nspname,v_table.relname
    );
    execute format(
      'create trigger trg_cnyos_authenticated_subscription_statement_write '
      'before insert or update or delete on %I.%I for each statement '
      'execute function public.enforce_authenticated_subscription_statement_write()',
      v_table.nspname,v_table.relname
    );
  end loop;
end $$;

-- Legacy migrations granted the service key broad direct DML. Remove it
-- schema-wide, then restore only the reviewed staging bootstrap/import calls.
-- Tenant-bearing exceptions are guarded by the same exact-clinic row lock.
-- Backup mutations are RPC-only; SELECT remains available for managed backup
-- and restore verification while a clinic is suspended.
revoke insert,update,delete,truncate,references,trigger
  on all tables in schema public from service_role;

grant insert,update on table public.profiles to service_role;
grant insert,update on table public.clinic_memberships to service_role;
grant insert,update on table
  public.ttm_sources,
  public.ttm_concepts,
  public.ttm_concept_relations,
  public.ttm_diagnostic_knowledge
to service_role;
grant insert on table public.audit_logs to service_role;
grant insert on table public.inventory_lots to service_role;
grant update on table public.patient_qr_sessions to service_role;

revoke all privileges on all sequences in schema public from service_role;
do $$
declare
  v_audit_sequence text := pg_get_serial_sequence('public.audit_logs','id');
begin
  if v_audit_sequence is null then
    raise exception 'AUDIT_LOG_SEQUENCE_REQUIRED';
  end if;
  execute format(
    'grant usage on sequence %s to service_role',
    v_audit_sequence::regclass
  );
end $$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'clinic_memberships','audit_logs','inventory_lots','patient_qr_sessions'
  ] loop
    execute format(
      'drop trigger if exists trg_cnyos_active_subscription_write on public.%I',
      v_table
    );
    execute format(
      'create trigger trg_cnyos_active_subscription_write '
      'before insert or update or delete on public.%I for each row '
      'execute function public.enforce_active_subscription_tenant_write()',
      v_table
    );
  end loop;
end $$;

-- ============================================================
-- Exact-clinic LINE / patient identity service API
-- ============================================================

create or replace function public.consume_patient_identity_rate_limit_for_clinic(
  p_clinic_id uuid,
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return public.consume_patient_identity_rate_limit(p_bucket_key,p_limit,p_window_seconds);
end;
$$;

create or replace function public.complete_patient_line_link_for_clinic(
  p_clinic_id uuid,
  p_link_code text,
  p_subject_hash text,
  p_provider_channel text,
  p_subject_consent_confirmed boolean
)
returns table (patient_id uuid,clinic_id uuid,link_type text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link record;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  select * into v_link
  from public.complete_patient_line_link(
    p_link_code,p_subject_hash,p_provider_channel,p_subject_consent_confirmed
  );
  if v_link.clinic_id is distinct from p_clinic_id then
    raise exception 'CNYOS_CLINIC_SCOPE_DENIED';
  end if;
  return query select v_link.patient_id,v_link.clinic_id,v_link.link_type;
end;
$$;

create or replace function public.list_line_linked_patients_for_clinic(
  p_clinic_id uuid,
  p_subject_hash text
)
returns table (
  patient_id uuid,
  clinic_id uuid,
  clinic_name text,
  hn text,
  display_name text,
  link_type text,
  relation_label text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return query
  select
    p.id,p.clinic_id,c.name_th,p.hn,
    concat_ws(' ',nullif(p.prefix,''),p.first_name,p.last_name),
    l.link_type,l.relation_label
  from public.patient_identity_links l
  join public.patients p on p.id=l.patient_id and p.clinic_id=l.clinic_id
  join public.clinics c on c.id=l.clinic_id
  where l.provider='line'
    and l.clinic_id=p_clinic_id
    and l.subject_hash=p_subject_hash
    and l.status='active'
    and p.active
    and c.active
    and c.subscription_state='active'
  order by l.link_type='self' desc,p.first_name,p.last_name;
end;
$$;

create or replace function public.issue_patient_qr_for_subject_in_clinic(
  p_clinic_id uuid,
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
set search_path = pg_catalog, public
as $$
declare
  v_issued record;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  if not exists (
    select 1 from public.patients p
    where p.id=p_patient_id and p.clinic_id=p_clinic_id and p.active
  ) then raise exception 'PATIENT_NOT_FOUND'; end if;

  select * into v_issued
  from public.issue_patient_qr_for_subject(
    p_subject_hash,p_patient_id,p_token_hash,p_display_code_hash,p_expires_at
  );
  if v_issued.clinic_id is distinct from p_clinic_id then
    raise exception 'CNYOS_CLINIC_SCOPE_DENIED';
  end if;
  return query select
    v_issued.qr_session_id,v_issued.patient_id,v_issued.clinic_id,
    v_issued.hn,v_issued.display_name,v_issued.expires_at;
end;
$$;

revoke all on function public.consume_patient_identity_rate_limit(text,integer,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.complete_patient_line_link(text,text,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.list_line_linked_patients(text)
  from public,anon,authenticated,service_role;
revoke all on function public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz)
  from public,anon,authenticated,service_role;

revoke all on function public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)
  from public,anon,authenticated;
revoke all on function public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)
  from public,anon,authenticated;
revoke all on function public.list_line_linked_patients_for_clinic(uuid,text)
  from public,anon,authenticated;
revoke all on function public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer) to service_role;
grant execute on function public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean) to service_role;
grant execute on function public.list_line_linked_patients_for_clinic(uuid,text) to service_role;
grant execute on function public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz) to service_role;

-- Archive the pre-subscription operational implementations.  The public
-- signatures remain stable, but wrappers assert the requested tenant before
-- any lookup, claim, queue mutation or delivery finalization.
alter function public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)
  rename to line_oa_queue_notification_v20260829;
alter function public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)
  rename to line_oa_set_preference_v20260829;
alter function public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)
  rename to line_oa_complete_link_consent_v20260829;
alter function public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)
  rename to line_oa_list_preferences_v20260829;
alter function public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)
  rename to line_oa_claim_webhook_v20260829;
alter function public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)
  rename to line_oa_finish_webhook_v20260829;
alter function public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)
  rename to line_oa_claim_batch_v20260829;
alter function public.finish_line_oa_notification(uuid,text,text,integer,text,text)
  rename to line_oa_finish_notification_v20260829;

revoke all on function public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.queue_line_oa_appointment_notification(
  p_appointment_id uuid,p_notification_type text,p_scheduled_for timestamptz,
  p_expires_at timestamptz,p_idempotency_suffix text
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare v_clinic_id uuid;
begin
  select a.clinic_id into v_clinic_id
  from public.clinic_appointments a where a.id=p_appointment_id;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  return public.line_oa_queue_notification_v20260829(
    p_appointment_id,p_notification_type,p_scheduled_for,p_expires_at,p_idempotency_suffix
  );
end;
$$;

create or replace function public.set_line_oa_notification_preference_for_subject(
  p_subject_hash text,p_patient_id uuid,p_clinic_id uuid,p_environment text,
  p_deployment_id text,p_channel_hash text,p_enabled boolean
)
returns table (
  patient_id uuid,operational_messaging_enabled boolean,
  appointment_reminders_enabled boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_enabled then
    perform public.assert_clinic_subscription_active(p_clinic_id);
  else
    perform public.prepare_line_subscription_off_exception(
      p_clinic_id,'line-consent-withdrawal/v1'
    );
  end if;
  begin
    return query select * from public.line_oa_set_preference_v20260829(
      p_subject_hash,p_patient_id,p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_enabled
    );
  exception when others then
    perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
    perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
    raise;
  end;
  perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
  perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
end;
$$;

create or replace function public.complete_patient_line_link_with_oa_consent(
  p_link_code text,p_subject_hash text,p_provider_channel text,
  p_subject_consent_confirmed boolean,p_clinic_id uuid,p_environment text,
  p_deployment_id text,p_channel_hash text
)
returns table (patient_id uuid,clinic_id uuid,link_type text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return query select * from public.line_oa_complete_link_consent_v20260829(
    p_link_code,p_subject_hash,p_provider_channel,p_subject_consent_confirmed,
    p_clinic_id,p_environment,p_deployment_id,p_channel_hash
  );
end;
$$;

create or replace function public.list_line_oa_notification_preferences_for_subject(
  p_subject_hash text,p_clinic_id uuid,p_environment text,
  p_deployment_id text,p_channel_hash text
)
returns table (patient_id uuid,operational_messaging_enabled boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return query select * from public.line_oa_list_preferences_v20260829(
    p_subject_hash,p_clinic_id,p_environment,p_deployment_id,p_channel_hash
  );
end;
$$;

create or replace function public.claim_line_oa_webhook_event(
  p_clinic_id uuid,p_environment text,p_deployment_id text,p_channel_hash text,
  p_webhook_event_id text,p_event_type text,p_event_timestamp timestamptz,
  p_is_redelivery boolean,p_mode text,p_subject_hash text,p_contact_state text,
  p_user_id_ciphertext text,p_user_id_iv text,p_user_id_auth_tag text,
  p_encryption_key_id text,p_metadata jsonb
)
returns table (claimed boolean,linked_patient_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return query select * from public.line_oa_claim_webhook_v20260829(
    p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_webhook_event_id,
    p_event_type,p_event_timestamp,p_is_redelivery,p_mode,p_subject_hash,p_contact_state,
    p_user_id_ciphertext,p_user_id_iv,p_user_id_auth_tag,p_encryption_key_id,p_metadata
  );
end;
$$;

create or replace function public.finish_line_oa_webhook_event(
  p_clinic_id uuid,p_environment text,p_deployment_id text,p_channel_hash text,
  p_webhook_event_id text,p_outcome text,p_error_code text,p_retryable boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_id uuid;
  v_finished boolean;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select e.id into v_event_id
  from public.line_oa_webhook_events e
  where e.clinic_id=p_clinic_id
    and e.environment=p_environment
    and e.deployment_id=p_deployment_id
    and e.channel_hash=p_channel_hash
    and e.webhook_event_id=p_webhook_event_id
    and e.processing_status='processing'
  for update;
  if not found then return false; end if;
  perform public.prepare_line_subscription_off_exception(
    p_clinic_id,'line-finish-webhook/v1'
  );
  begin
    v_finished := public.line_oa_finish_webhook_v20260829(
      p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_webhook_event_id,
      p_outcome,p_error_code,p_retryable
    );
  exception when others then
    perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
    perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
    raise;
  end;
  perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
  perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
  return v_finished;
end;
$$;

create or replace function public.claim_line_oa_notification_batch(
  p_clinic_id uuid,p_environment text,p_deployment_id text,p_channel_hash text,
  p_worker_id text,p_limit integer default 8
)
returns table (
  notification_id uuid,notification_type text,appointment_no text,
  scheduled_start timestamptz,subject_hash text,user_id_ciphertext text,
  user_id_iv text,user_id_auth_tag text,encryption_key_id text,retry_key uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  return query select * from public.line_oa_claim_batch_v20260829(
    p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_worker_id,p_limit
  );
end;
$$;

create or replace function public.finish_line_oa_notification(
  p_notification_id uuid,p_worker_id text,p_outcome text,p_http_status integer,
  p_error_code text,p_line_request_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid;
  v_finished boolean;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select o.clinic_id into v_clinic_id
  from public.line_oa_notification_outbox o
  where o.id=p_notification_id
    and o.status='sending'
    and o.locked_by=p_worker_id
  for update;
  if not found then return false; end if;
  perform public.prepare_line_subscription_off_exception(
    v_clinic_id,'line-finish-notification/v1'
  );
  begin
    v_finished := public.line_oa_finish_notification_v20260829(
      p_notification_id,p_worker_id,p_outcome,p_http_status,p_error_code,p_line_request_id
    );
  exception when others then
    perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
    perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
    raise;
  end;
  perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);
  perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);
  return v_finished;
end;
$$;

revoke all on function public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)
  from public,anon,authenticated,service_role;
revoke all on function public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)
  from public,anon,authenticated;
revoke all on function public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)
  from public,anon,authenticated;
revoke all on function public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)
  from public,anon,authenticated;
revoke all on function public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)
  from public,anon,authenticated;
revoke all on function public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)
  from public,anon,authenticated;
revoke all on function public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)
  from public,anon,authenticated;
revoke all on function public.finish_line_oa_notification(uuid,text,text,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean) to service_role;
grant execute on function public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text) to service_role;
grant execute on function public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text) to service_role;
grant execute on function public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean) to service_role;
grant execute on function public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer) to service_role;
grant execute on function public.finish_line_oa_notification(uuid,text,text,integer,text,text) to service_role;

-- Messaging gateway events have no clinic column, so the service-visible
-- registration API adds the immutable expected clinic and refuses a subject
-- already linked to any other tenant. Finalization/evidence remain available
-- only to close an event already accepted before a concurrent suspension.
alter function public.register_line_oa_webhook_event(text,text,text,text,text,timestamptz,boolean,text)
  rename to line_oa_register_gateway_v20260829;
revoke all on function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)
  from public,anon,authenticated,service_role;

create or replace function public.register_line_oa_webhook_event_for_clinic(
  p_clinic_id uuid,p_provider_channel_hash text,p_event_id_hash text,
  p_subject_hash text,p_event_type text,p_action_code text,
  p_event_timestamp timestamptz,p_is_redelivery boolean,p_payload_hash text
)
returns table (accepted boolean,linked_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(p_clinic_id);
  if p_subject_hash is not null and exists (
    select 1 from public.patient_identity_links l
    where l.provider='line'
      and l.subject_hash=p_subject_hash
      and l.status='active'
      and l.clinic_id<>p_clinic_id
  ) then raise exception 'LINE_OA_CROSS_TENANT_SUBJECT'; end if;

  return query select * from public.line_oa_register_gateway_v20260829(
    p_provider_channel_hash,p_event_id_hash,p_subject_hash,p_event_type,p_action_code,
    p_event_timestamp,p_is_redelivery,p_payload_hash
  );
end;
$$;

revoke all on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)
  from public,anon,authenticated;
grant execute on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)
  to service_role;

-- Re-run the dynamic boundary now that tenant tables/columns and replacement
-- policies exist, so this migration cannot accidentally leave a newly-created
-- permissive policy outside the OFF kill switch.
do $$
declare
  v_table record;
begin
  for v_table in
    select n.nspname,c.relname
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relkind in ('r','p')
      and c.relrowsecurity
      and (
        has_table_privilege('authenticated',c.oid,'SELECT')
        or has_table_privilege('authenticated',c.oid,'INSERT')
        or has_table_privilege('authenticated',c.oid,'UPDATE')
        or has_table_privilege('authenticated',c.oid,'DELETE')
      )
  loop
    execute format(
      'drop policy if exists cnyos_active_subscription_boundary on %I.%I',
      v_table.nspname,v_table.relname
    );
    execute format(
      'create policy cnyos_active_subscription_boundary on %I.%I '
      'as restrictive for all to authenticated '
      'using (public.current_clinic_id() is not null) '
      'with check (public.current_clinic_id() is not null)',
      v_table.nspname,v_table.relname
    );
  end loop;
end $$;

comment on function public.assert_clinic_subscription_active(uuid) is
  'Fail-closed exact-clinic subscription assertion for service and SECURITY DEFINER operational paths.';
comment on column public.practitioner_schedules.clinic_id is
  'Authoritative appointment schedule tenant; required by the Owner subscription kill switch.';
comment on column public.approval_tasks.clinic_id is
  'Authoritative approval workflow tenant; prevents global admin-task access.';

commit;
