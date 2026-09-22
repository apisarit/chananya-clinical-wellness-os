begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- One appointment owns at most one Encounter, and an Encounter cannot be
-- attached to a different patient or tenant through the appointment surface.
create unique index if not exists clinic_appointments_encounter_uidx
  on public.clinic_appointments(encounter_id)
  where encounter_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clinic_appointments_encounter_clinic_patient_fkey'
      and conrelid = 'public.clinic_appointments'::regclass
  ) then
    alter table public.clinic_appointments
      add constraint clinic_appointments_encounter_clinic_patient_fkey
      foreign key (encounter_id, clinic_id, patient_id)
      references public.encounters(id, clinic_id, patient_id)
      on delete restrict;
  end if;
end $$;

create or replace function public.check_in_clinic_appointment(
  p_appointment_id uuid,
  p_patient_id uuid default null,
  p_qr_session_id uuid default null,
  p_verification_method text default 'manual_hn',
  p_patient_present_confirmed boolean default false,
  p_verification_note text default null,
  p_chief_complaint text default null,
  p_intake jsonb default '{}'::jsonb
)
returns table (
  encounter_id uuid,
  encounter_no text,
  patient_id uuid,
  practitioner_id uuid,
  appointment_status text,
  reused boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
  v_appt public.clinic_appointments%rowtype;
  v_qr public.patient_qr_sessions%rowtype;
  v_encounter public.encounters%rowtype;
  v_verified_patient uuid;
  v_old_status text;
  v_operator boolean;
  v_practitioner boolean;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  if not p_patient_present_confirmed then
    raise exception 'PATIENT_CONFIRMATION_REQUIRED';
  end if;
  if p_appointment_id is null then raise exception 'APPOINTMENT_REQUIRED'; end if;
  if p_intake is null or jsonb_typeof(p_intake) <> 'object' then
    raise exception 'INTAKE_OBJECT_REQUIRED';
  end if;
  perform public.assert_clinic_subscription_active(v_clinic);

  select a.* into v_appt
  from public.clinic_appointments a
  where a.id = p_appointment_id and a.clinic_id = v_clinic
  for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;

  v_operator := public.is_appointment_operator();
  v_practitioner := public.is_appointment_practitioner()
    and v_appt.practitioner_id = v_actor;
  if not (v_operator or v_practitioner) then
    raise exception 'APPOINTMENT_ACCESS_DENIED';
  end if;

  if p_qr_session_id is not null then
    if p_patient_id is not null or p_verification_method <> 'line_qr' then
      raise exception 'APPOINTMENT_IDENTITY_MODE_INVALID';
    end if;
    select q.* into v_qr
    from public.patient_qr_sessions q
    where q.id = p_qr_session_id
      and q.clinic_id = v_clinic
      and q.resolved_at is not null
      and q.resolved_by = v_actor
    for update;
    if not found then
      raise exception 'QR_INVALID_EXPIRED_OR_USED';
    end if;
    if v_appt.encounter_id is not null then
      if v_qr.used_at is null
         or v_qr.encounter_id is distinct from v_appt.encounter_id
         or v_qr.used_by is distinct from v_actor then
        raise exception 'QR_REPLAY_OR_APPOINTMENT_MISMATCH';
      end if;
    elsif v_qr.used_at is not null or v_qr.expires_at <= now() then
      raise exception 'QR_INVALID_EXPIRED_OR_USED';
    end if;
    v_verified_patient := v_qr.patient_id;
  else
    if p_patient_id is null then raise exception 'PATIENT_REQUIRED'; end if;
    if p_verification_method not in (
      'manual_hn','government_id','demographic_match','guardian_attestation'
    ) then
      raise exception 'INVALID_MANUAL_VERIFICATION_METHOD';
    end if;
    if p_verification_method = 'guardian_attestation'
       and nullif(btrim(p_verification_note), '') is null then
      raise exception 'GUARDIAN_NOTE_REQUIRED';
    end if;
    v_verified_patient := p_patient_id;
  end if;

  if v_verified_patient <> v_appt.patient_id then
    raise exception 'APPOINTMENT_PATIENT_MISMATCH';
  end if;

  if v_appt.encounter_id is not null then
    select e.* into v_encounter
    from public.encounters e
    where e.id = v_appt.encounter_id
      and e.clinic_id = v_clinic
      and e.patient_id = v_appt.patient_id;
    if not found then raise exception 'APPOINTMENT_ENCOUNTER_LINK_INVALID'; end if;
    return query select v_encounter.id, v_encounter.encounter_no,
      v_encounter.patient_id, v_encounter.practitioner_id, v_appt.status, true;
    return;
  end if;

  if v_appt.status not in ('booked','confirmed','checked_in','in_service') then
    raise exception 'APPOINTMENT_NOT_READY_FOR_CHECKIN';
  end if;

  insert into public.encounters (
    clinic_id, encounter_no, patient_id, encounter_type, status,
    chief_complaint, practitioner_id, created_by
  ) values (
    v_clinic,
    public.next_encounter_number(),
    v_appt.patient_id,
    'opd',
    'draft',
    coalesce(nullif(btrim(p_chief_complaint), ''), v_appt.chief_complaint),
    v_appt.practitioner_id,
    v_actor
  ) returning * into v_encounter;

  perform public.apply_initial_encounter_intake(v_encounter.id, p_intake);

  insert into public.encounter_identity_verifications (
    clinic_id, encounter_id, patient_id, verification_method,
    qr_session_id, patient_present_confirmed, verification_note, verified_by
  ) values (
    v_clinic, v_encounter.id, v_appt.patient_id, p_verification_method,
    p_qr_session_id, true, nullif(btrim(p_verification_note), ''), v_actor
  );

  if p_qr_session_id is not null then
    update public.patient_qr_sessions
    set used_at = now(), used_by = v_actor, encounter_id = v_encounter.id
    where id = p_qr_session_id;
  end if;

  v_old_status := v_appt.status;
  update public.clinic_appointments
  set encounter_id = v_encounter.id,
      status = case when status in ('booked','confirmed') then 'checked_in' else status end
  where id = v_appt.id and clinic_id = v_clinic
  returning * into v_appt;

  insert into public.appointment_events(
    clinic_id, appointment_id, event_type, old_status, new_status, detail, actor_id
  ) values (
    v_clinic, v_appt.id, 'encounter_opened', v_old_status, v_appt.status,
    jsonb_build_object('encounter_id', v_encounter.id, 'verification_method', p_verification_method),
    v_actor
  );

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, qr_session_id,
    encounter_id, metadata
  ) values (
    v_clinic, v_appt.patient_id, 'PATIENT_IDENTITY_CONFIRMED', v_actor,
    p_qr_session_id, v_encounter.id,
    jsonb_build_object('verification_method', p_verification_method,
      'appointment_id', v_appt.id)
  );

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic, v_actor, 'check_in_appointment_encounter', 'encounters',
    v_encounter.id::text,
    jsonb_build_object('appointment_id', v_appt.id,
      'practitioner_id', v_appt.practitioner_id,
      'verification_method', p_verification_method)
  );

  return query select v_encounter.id, v_encounter.encounter_no,
    v_encounter.patient_id, v_encounter.practitioner_id, v_appt.status, false;
end;
$$;

revoke all on function public.check_in_clinic_appointment(
  uuid,uuid,uuid,text,boolean,text,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.check_in_clinic_appointment(
  uuid,uuid,uuid,text,boolean,text,text,jsonb
) to authenticated;

-- The original treatment-session helper was SECURITY INVOKER. Later ACL
-- hardening intentionally removed direct writes to encounters, so the helper's
-- row lock failed before an assigned practitioner could save treatment. Keep
-- the table private and perform the tenant/department/assignment checks inside
-- this narrow RPC instead.
create or replace function public.create_clinical_treatment_session(
  p_encounter_id uuid,
  p_treatment_modalities text[] default '{}',
  p_treatment_detail text default null,
  p_procedure_referral boolean default false,
  p_procedure_referral_detail text default null,
  p_precautions text default null,
  p_pain_before smallint default null,
  p_pain_after smallint default null,
  p_outcome_summary text default null,
  p_advice text default null
)
returns public.clinical_treatment_sessions
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
  v_department text := public.current_department_role();
  v_profile_role text;
  v_encounter public.encounters%rowtype;
  v_session_no integer;
  v_row public.clinical_treatment_sessions%rowtype;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  select p.role into v_profile_role
  from public.profiles p
  where p.id = v_actor;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.department_can('clinical')
     and not (
       v_department in ('owner','admin')
       and v_profile_role in ('practitioner','doctor')
     ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if nullif(btrim(p_treatment_detail), '') is null then
    raise exception 'TREATMENT_DETAIL_REQUIRED';
  end if;
  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then
    raise exception 'INVALID_PAIN_BEFORE';
  end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then
    raise exception 'INVALID_PAIN_AFTER';
  end if;

  select e.* into v_encounter
  from public.encounters e
  where e.id = p_encounter_id and e.clinic_id = v_clinic
  for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.status in ('closed','cancelled','void') then
    raise exception 'ENCOUNTER_NOT_EDITABLE';
  end if;
  if v_encounter.practitioner_id is not null
     and v_encounter.practitioner_id <> v_actor
     and not public.is_super_admin() then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;

  select coalesce(max(s.session_no), 0) + 1 into v_session_no
  from public.clinical_treatment_sessions s
  where s.encounter_id = p_encounter_id;

  insert into public.clinical_treatment_sessions (
    encounter_id, session_no, treatment_modalities, treatment_detail,
    procedure_referral, procedure_referral_detail, precautions,
    pain_before, pain_after, outcome_summary, advice, practitioner_id
  ) values (
    p_encounter_id, v_session_no, coalesce(p_treatment_modalities, '{}'),
    btrim(p_treatment_detail), coalesce(p_procedure_referral, false),
    nullif(btrim(p_procedure_referral_detail), ''), nullif(btrim(p_precautions), ''),
    p_pain_before, p_pain_after, nullif(btrim(p_outcome_summary), ''),
    nullif(btrim(p_advice), ''), v_actor
  ) returning * into v_row;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic,v_actor,'create_clinical_treatment_session',
    'clinical_treatment_sessions',v_row.id::text,
    jsonb_build_object('encounter_id',p_encounter_id,'session_no',v_session_no)
  );
  return v_row;
end;
$$;

revoke all on function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text
) to authenticated;
revoke insert, update, delete on public.clinical_treatment_sessions
  from authenticated;

create or replace function public.list_billable_treatment_encounters()
returns table (
  encounter_id uuid,
  encounter_no text,
  patient_id uuid,
  hn text,
  patient_name text,
  started_at timestamptz,
  chief_complaint text,
  treatment_description text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic, array['owner','admin','billing']) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return query
  select e.id, e.encounter_no, e.patient_id, p.hn,
    btrim(concat_ws(' ', nullif(p.prefix,''), p.first_name, p.last_name)),
    e.started_at, e.chief_complaint,
    coalesce(nullif(btrim(latest.treatment_detail), ''),
      nullif(btrim(e.chief_complaint), ''), 'ค่าตรวจและหัตถการ')
  from public.encounters e
  join public.patients p
    on p.id = e.patient_id and p.clinic_id = e.clinic_id
  join lateral (
    select s.treatment_detail
    from public.clinical_treatment_sessions s
    where s.encounter_id = e.id
    order by s.session_no desc, s.created_at desc
    limit 1
  ) latest on true
  where e.clinic_id = v_clinic
    and e.status not in ('closed','cancelled','void')
    and exists (
      select 1 from public.clinical_record_signoffs s
      where s.encounter_id = e.id
        and s.record_section = 'complete_record'
        and s.lock_record
    )
    and not exists (
      select 1 from public.prescriptions rx
      where rx.encounter_id = e.id and rx.status not in ('cancelled','void')
    )
    and not exists (
      select 1 from public.invoices i
      where i.encounter_id = e.id and i.status not in ('cancelled','void')
    )
  order by e.started_at;
end;
$$;

revoke all on function public.list_billable_treatment_encounters()
  from public, anon, authenticated, service_role;
grant execute on function public.list_billable_treatment_encounters()
  to authenticated;

comment on function public.check_in_clinic_appointment(uuid,uuid,uuid,text,boolean,text,text,jsonb)
  is 'Atomically verifies an appointment patient, creates or reuses exactly one tenant-bound Encounter, preserves the assigned practitioner, and records identity/audit events.';
comment on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)
  is 'Creates a treatment session for an active tenant-bound Encounter after explicit clinical department and practitioner-assignment checks.';
comment on function public.list_billable_treatment_encounters()
  is 'Billing-only queue of signed treatment visits with no prescription and no active invoice.';

notify pgrst, 'reload schema';
commit;
