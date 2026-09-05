begin;

-- The original atomic diagnosis function used SECURITY INVOKER. Later
-- hardening correctly revoked direct Encounter/diagnosis writes, which also
-- prevented the function from locking its Encounter. Recreate the boundary as
-- a tenant-scoped SECURITY DEFINER function instead of returning table-write
-- privileges to the browser.

create or replace function public.save_ttm_diagnosis_atomic(
  p_encounter_id uuid,
  p_dhatu_samutthan text default null,
  p_utu_samutthan text default null,
  p_ayu_samutthan text default null,
  p_kala_samutthan text default null,
  p_pradesa_samutthan text default null,
  p_birth_constitution text default null,
  p_present_constitution text default null,
  p_disease_causes text[] default '{}',
  p_symptom_mechanism text default null,
  p_analysis_summary text default null,
  p_thai_diagnosis text default null,
  p_differential_diagnosis text default null,
  p_diagnostic_confidence text default null,
  p_dosha_state text default null,
  p_coordinate text default null,
  p_mixed_coordinate text default null,
  p_season_4 text default null,
  p_season_6 text default null,
  p_season_pitsadan text default null,
  p_zodiac_samutthan text default null,
  p_practitioner_confirmed boolean default false,
  p_knowledge_version text default 'TTM-DKR-v1'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dx_id uuid;
  v_clinic_id uuid := public.current_clinic_id();
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null or not public.department_can('clinical') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_analysis_summary is null or btrim(p_analysis_summary) = '' then
    raise exception 'ANALYSIS_SUMMARY_REQUIRED';
  end if;
  if p_thai_diagnosis is null or btrim(p_thai_diagnosis) = '' then
    raise exception 'THAI_DIAGNOSIS_REQUIRED';
  end if;

  perform 1
  from public.encounters e
  where e.id = p_encounter_id
    and e.clinic_id = v_clinic_id
    and e.status not in ('closed','cancelled','void')
  for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND_OR_LOCKED'; end if;

  if exists (
    select 1
    from public.clinical_record_signoffs s
    where s.encounter_id = p_encounter_id
      and s.record_section = 'complete_record'
      and s.lock_record
  ) then
    raise exception 'CLINICAL_RECORD_LOCKED';
  end if;

  insert into public.ttm_structured_diagnoses(
    encounter_id,dhatu_samutthan,utu_samutthan,ayu_samutthan,kala_samutthan,
    pradesa_samutthan,birth_constitution,present_constitution,disease_causes,
    symptom_mechanism,analysis_summary,thai_diagnosis,differential_diagnosis,
    diagnostic_confidence,dosha_state,coordinate,mixed_coordinate,season_4,
    season_6,season_pitsadan,zodiac_samutthan,knowledge_version,
    practitioner_confirmed,diagnosed_by,diagnosed_at,updated_at
  ) values (
    p_encounter_id,p_dhatu_samutthan,p_utu_samutthan,p_ayu_samutthan,
    p_kala_samutthan,p_pradesa_samutthan,p_birth_constitution,
    p_present_constitution,coalesce(p_disease_causes,'{}'),
    p_symptom_mechanism,p_analysis_summary,p_thai_diagnosis,
    p_differential_diagnosis,p_diagnostic_confidence,p_dosha_state,
    p_coordinate,p_mixed_coordinate,p_season_4,p_season_6,
    p_season_pitsadan,p_zodiac_samutthan,p_knowledge_version,
    coalesce(p_practitioner_confirmed,false),auth.uid(),now(),now()
  )
  on conflict (encounter_id) do update set
    dhatu_samutthan=excluded.dhatu_samutthan,
    utu_samutthan=excluded.utu_samutthan,
    ayu_samutthan=excluded.ayu_samutthan,
    kala_samutthan=excluded.kala_samutthan,
    pradesa_samutthan=excluded.pradesa_samutthan,
    birth_constitution=excluded.birth_constitution,
    present_constitution=excluded.present_constitution,
    disease_causes=excluded.disease_causes,
    symptom_mechanism=excluded.symptom_mechanism,
    analysis_summary=excluded.analysis_summary,
    thai_diagnosis=excluded.thai_diagnosis,
    differential_diagnosis=excluded.differential_diagnosis,
    diagnostic_confidence=excluded.diagnostic_confidence,
    dosha_state=excluded.dosha_state,
    coordinate=excluded.coordinate,
    mixed_coordinate=excluded.mixed_coordinate,
    season_4=excluded.season_4,
    season_6=excluded.season_6,
    season_pitsadan=excluded.season_pitsadan,
    zodiac_samutthan=excluded.zodiac_samutthan,
    knowledge_version=excluded.knowledge_version,
    practitioner_confirmed=excluded.practitioner_confirmed,
    diagnosed_by=auth.uid(),diagnosed_at=now(),updated_at=now()
  returning id into v_dx_id;

  insert into public.ttm_diagnostic_contexts(
    encounter_id,birth_element,current_element,ayu_samutthan,kala_samutthan,
    pradesa_samutthan,dosha_state,coordinate,mixed_coordinate,season_4,season_6,
    season_pitsadan,zodiac_samutthan,practitioner_confirmed,confirmed_by,
    confirmed_at,knowledge_version,updated_at
  ) values (
    p_encounter_id,p_birth_constitution,p_present_constitution,p_ayu_samutthan,
    p_kala_samutthan,p_pradesa_samutthan,p_dosha_state,p_coordinate,
    p_mixed_coordinate,p_season_4,p_season_6,p_season_pitsadan,
    p_zodiac_samutthan,coalesce(p_practitioner_confirmed,false),
    case when p_practitioner_confirmed then auth.uid() else null end,
    case when p_practitioner_confirmed then now() else null end,
    p_knowledge_version,now()
  )
  on conflict (encounter_id) do update set
    birth_element=excluded.birth_element,
    current_element=excluded.current_element,
    ayu_samutthan=excluded.ayu_samutthan,
    kala_samutthan=excluded.kala_samutthan,
    pradesa_samutthan=excluded.pradesa_samutthan,
    dosha_state=excluded.dosha_state,
    coordinate=excluded.coordinate,
    mixed_coordinate=excluded.mixed_coordinate,
    season_4=excluded.season_4,
    season_6=excluded.season_6,
    season_pitsadan=excluded.season_pitsadan,
    zodiac_samutthan=excluded.zodiac_samutthan,
    practitioner_confirmed=excluded.practitioner_confirmed,
    confirmed_by=excluded.confirmed_by,
    confirmed_at=excluded.confirmed_at,
    knowledge_version=excluded.knowledge_version,
    updated_at=now();

  insert into public.audit_logs(
    clinic_id,user_id,action,entity,entity_id,metadata
  ) values (
    v_clinic_id,auth.uid(),'save_ttm_diagnosis_atomic',
    'ttm_structured_diagnoses',v_dx_id::text,
    jsonb_build_object(
      'encounter_id',p_encounter_id,
      'practitioner_confirmed',coalesce(p_practitioner_confirmed,false),
      'knowledge_version',p_knowledge_version
    )
  );

  return v_dx_id;
end;
$$;

revoke all on function public.save_ttm_diagnosis_atomic(
  uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,
  text,text,text,text,text,text,boolean,text
) from public;
grant execute on function public.save_ttm_diagnosis_atomic(
  uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,
  text,text,text,text,text,text,boolean,text
) to authenticated, service_role;

commit;

select 'CHANANYA_TTM_DIAGNOSIS_DEFINER_HARDENED' as status;
