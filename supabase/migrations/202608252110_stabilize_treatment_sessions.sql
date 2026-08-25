begin;

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
security invoker
set search_path = public
as $$
declare
  v_session_no integer;
  v_row public.clinical_treatment_sessions;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not public.has_role(array['admin','practitioner']) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_treatment_detail is null or btrim(p_treatment_detail) = '' then
    raise exception 'TREATMENT_DETAIL_REQUIRED';
  end if;

  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then
    raise exception 'INVALID_PAIN_BEFORE';
  end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then
    raise exception 'INVALID_PAIN_AFTER';
  end if;

  perform 1 from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND';
  end if;

  select coalesce(max(session_no), 0) + 1
    into v_session_no
  from public.clinical_treatment_sessions
  where encounter_id = p_encounter_id;

  insert into public.clinical_treatment_sessions (
    encounter_id, session_no, treatment_modalities, treatment_detail,
    procedure_referral, procedure_referral_detail, precautions,
    pain_before, pain_after, outcome_summary, advice, practitioner_id
  ) values (
    p_encounter_id, v_session_no, coalesce(p_treatment_modalities, '{}'), p_treatment_detail,
    coalesce(p_procedure_referral, false), p_procedure_referral_detail, p_precautions,
    p_pain_before, p_pain_after, p_outcome_summary, p_advice, auth.uid()
  ) returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text) to authenticated;

commit;

select 'CHANANYA_TREATMENT_SESSION_STABILIZED' as status;
