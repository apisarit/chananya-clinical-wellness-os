begin;

-- Restore the measurable-outcomes workspace from the original Clinical OS as
-- tenant-bound, read-only server queries. Governance admin does not inherit
-- clinical access; only practitioner/doctor or the explicit super-admin
-- override may read these patient-linked analytics.

create or replace function public.clinical_outcomes_summary(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  total_sessions bigint,
  measured_sessions bigint,
  improved_sessions bigint,
  average_pain_before numeric,
  average_pain_after numeric,
  improvement_rate numeric,
  followup_encounters bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_from timestamptz := coalesce(p_from, now() - interval '90 days');
  v_to timestamptz := coalesce(p_to, now() + interval '1 second');
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'ACTIVE_CLINIC_REQUIRED'; end if;
  if not public.department_can('clinical') then raise exception 'PERMISSION_DENIED'; end if;
  if v_to <= v_from then raise exception 'INVALID_DATE_RANGE'; end if;
  if v_to - v_from > interval '5 years' then raise exception 'DATE_RANGE_TOO_LARGE'; end if;

  return query
  with filtered as (
    select
      session.encounter_id,
      session.pain_before,
      session.pain_after
    from public.clinical_treatment_sessions session
    join public.encounters encounter on encounter.id = session.encounter_id
    where encounter.clinic_id = v_clinic_id
      and encounter.status not in ('cancelled','void')
      and session.treated_at >= v_from
      and session.treated_at < v_to
  ), measured as (
    select * from filtered
    where pain_before is not null and pain_after is not null
  ), followups as (
    select count(distinct note.encounter_id)::bigint as count
    from public.clinical_followup_notes note
    join (select distinct encounter_id from filtered) scope using (encounter_id)
  )
  select
    count(*)::bigint,
    (select count(*)::bigint from measured),
    (select count(*)::bigint from measured where pain_after < pain_before),
    coalesce((select round(avg(pain_before)::numeric, 2) from measured), 0),
    coalesce((select round(avg(pain_after)::numeric, 2) from measured), 0),
    coalesce((
      select round(
        100.0 * count(*) filter (where pain_after < pain_before) / nullif(count(*), 0),
        1
      )
      from measured
    ), 0),
    (select count from followups)
  from filtered;
end;
$$;

create or replace function public.search_clinical_outcomes(
  p_query text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  treatment_session_id uuid,
  encounter_id uuid,
  encounter_no text,
  patient_id uuid,
  hn text,
  patient_name text,
  treated_at timestamptz,
  thai_diagnosis text,
  treatment_modalities text[],
  herbal_lots text[],
  pain_before smallint,
  pain_after smallint,
  pain_change integer,
  outcome_summary text,
  advice text,
  latest_followup_date date,
  next_followup_at timestamptz,
  followup_status text,
  practitioner_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_query text := nullif(btrim(p_query), '');
  v_from timestamptz := coalesce(p_from, now() - interval '90 days');
  v_to timestamptz := coalesce(p_to, now() + interval '1 second');
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'ACTIVE_CLINIC_REQUIRED'; end if;
  if not public.department_can('clinical') then raise exception 'PERMISSION_DENIED'; end if;
  if v_to <= v_from then raise exception 'INVALID_DATE_RANGE'; end if;
  if v_to - v_from > interval '5 years' then raise exception 'DATE_RANGE_TOO_LARGE'; end if;
  if v_query is not null and char_length(v_query) > 120 then raise exception 'QUERY_TOO_LONG'; end if;

  return query
  select
    session.id,
    encounter.id,
    encounter.encounter_no,
    patient.id,
    patient.hn,
    concat_ws(' ', nullif(patient.prefix, ''), patient.first_name, patient.last_name),
    session.treated_at,
    coalesce(diagnosis.thai_diagnosis, encounter.thai_diagnosis),
    session.treatment_modalities,
    coalesce(trace.lot_numbers, '{}'::text[]),
    session.pain_before,
    session.pain_after,
    case
      when session.pain_before is null or session.pain_after is null then null
      else (session.pain_before - session.pain_after)::integer
    end,
    session.outcome_summary,
    session.advice,
    followup.followup_date,
    followup.next_appointment_at,
    followup.outcome_status,
    coalesce(profile.full_name, 'ไม่ระบุผู้รักษา')
  from public.clinical_treatment_sessions session
  join public.encounters encounter
    on encounter.id = session.encounter_id and encounter.clinic_id = v_clinic_id
  join public.patients patient
    on patient.id = encounter.patient_id and patient.clinic_id = v_clinic_id
  left join public.ttm_structured_diagnoses diagnosis on diagnosis.encounter_id = encounter.id
  left join public.profiles profile on profile.id = session.practitioner_id
  left join lateral (
    select
      note.followup_date,
      note.next_appointment_at,
      note.outcome_status,
      note.current_symptoms,
      note.change_from_previous
    from public.clinical_followup_notes note
    where note.encounter_id = encounter.id
    order by note.followup_date desc, note.created_at desc
    limit 1
  ) followup on true
  left join lateral (
    select array_agg(distinct lot.lot_number order by lot.lot_number)
      filter (where lot.lot_number is not null) as lot_numbers
    from public.prescriptions prescription
    join public.dispensing_orders dispensing
      on dispensing.prescription_id = prescription.id
    join public.dispensing_items item
      on item.dispensing_order_id = dispensing.id
    join public.inventory_lots lot
      on lot.id = item.inventory_lot_id and lot.clinic_id = v_clinic_id
    where prescription.encounter_id = encounter.id
      and prescription.status not in ('cancelled','void')
      and item.status not in ('cancelled','void')
  ) trace on true
  where session.treated_at >= v_from
    and session.treated_at < v_to
    and encounter.status not in ('cancelled','void')
    and (
      v_query is null
      or patient.hn ilike '%' || v_query || '%'
      or concat_ws(' ', patient.prefix, patient.first_name, patient.last_name) ilike '%' || v_query || '%'
      or encounter.encounter_no ilike '%' || v_query || '%'
      or coalesce(diagnosis.thai_diagnosis, '') ilike '%' || v_query || '%'
      or coalesce(encounter.thai_diagnosis, '') ilike '%' || v_query || '%'
      or coalesce(session.outcome_summary, '') ilike '%' || v_query || '%'
      or coalesce(session.advice, '') ilike '%' || v_query || '%'
      or coalesce(array_to_string(session.treatment_modalities, ' '), '') ilike '%' || v_query || '%'
      or coalesce(array_to_string(trace.lot_numbers, ' '), '') ilike '%' || v_query || '%'
      or coalesce(followup.outcome_status, '') ilike '%' || v_query || '%'
      or coalesce(followup.current_symptoms, '') ilike '%' || v_query || '%'
      or coalesce(followup.change_from_previous, '') ilike '%' || v_query || '%'
      or coalesce(to_char(followup.followup_date, 'YYYY-MM-DD'), '') ilike '%' || v_query || '%'
      or coalesce(to_char(followup.next_appointment_at, 'YYYY-MM-DD'), '') ilike '%' || v_query || '%'
      or coalesce(profile.full_name, '') ilike '%' || v_query || '%'
    )
  order by session.treated_at desc, session.id desc
  limit v_limit offset v_offset;
end;
$$;

revoke all on function public.clinical_outcomes_summary(timestamptz,timestamptz) from public;
revoke all on function public.search_clinical_outcomes(text,timestamptz,timestamptz,integer,integer) from public;
grant execute on function public.clinical_outcomes_summary(timestamptz,timestamptz) to authenticated;
grant execute on function public.search_clinical_outcomes(text,timestamptz,timestamptz,integer,integer) to authenticated;

commit;

select 'CHANANYA_CLINICAL_OUTCOMES_ANALYTICS_READY' as status;
