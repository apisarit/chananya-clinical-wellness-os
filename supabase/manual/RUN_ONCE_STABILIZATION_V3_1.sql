-- Chananya Clinical OS v3.1
-- RUN ONCE STABILIZATION INSTALLER
-- Prerequisites already expected: Clinical v3 foundation, TTM knowledge layer, OPD workflow.

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
declare v_session_no integer; v_row public.clinical_treatment_sessions;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.has_role(array['admin','practitioner']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_treatment_detail is null or btrim(p_treatment_detail) = '' then raise exception 'TREATMENT_DETAIL_REQUIRED'; end if;
  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then raise exception 'INVALID_PAIN_BEFORE'; end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then raise exception 'INVALID_PAIN_AFTER'; end if;
  perform 1 from public.encounters where id=p_encounter_id for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  select coalesce(max(session_no),0)+1 into v_session_no from public.clinical_treatment_sessions where encounter_id=p_encounter_id;
  insert into public.clinical_treatment_sessions(encounter_id,session_no,treatment_modalities,treatment_detail,procedure_referral,procedure_referral_detail,precautions,pain_before,pain_after,outcome_summary,advice,practitioner_id)
  values(p_encounter_id,v_session_no,coalesce(p_treatment_modalities,'{}'),p_treatment_detail,coalesce(p_procedure_referral,false),p_procedure_referral_detail,p_precautions,p_pain_before,p_pain_after,p_outcome_summary,p_advice,auth.uid()) returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text) to authenticated;

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
security invoker
set search_path=public
as $$
declare v_dx_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.has_role(array['admin','practitioner']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_analysis_summary is null or btrim(p_analysis_summary)='' then raise exception 'ANALYSIS_SUMMARY_REQUIRED'; end if;
  if p_thai_diagnosis is null or btrim(p_thai_diagnosis)='' then raise exception 'THAI_DIAGNOSIS_REQUIRED'; end if;
  perform 1 from public.encounters where id=p_encounter_id for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;

  insert into public.ttm_structured_diagnoses(encounter_id,dhatu_samutthan,utu_samutthan,ayu_samutthan,kala_samutthan,pradesa_samutthan,birth_constitution,present_constitution,disease_causes,symptom_mechanism,analysis_summary,thai_diagnosis,differential_diagnosis,diagnostic_confidence,dosha_state,coordinate,mixed_coordinate,season_4,season_6,season_pitsadan,zodiac_samutthan,knowledge_version,practitioner_confirmed,diagnosed_by,diagnosed_at,updated_at)
  values(p_encounter_id,p_dhatu_samutthan,p_utu_samutthan,p_ayu_samutthan,p_kala_samutthan,p_pradesa_samutthan,p_birth_constitution,p_present_constitution,coalesce(p_disease_causes,'{}'),p_symptom_mechanism,p_analysis_summary,p_thai_diagnosis,p_differential_diagnosis,p_diagnostic_confidence,p_dosha_state,p_coordinate,p_mixed_coordinate,p_season_4,p_season_6,p_season_pitsadan,p_zodiac_samutthan,p_knowledge_version,coalesce(p_practitioner_confirmed,false),auth.uid(),now(),now())
  on conflict(encounter_id) do update set dhatu_samutthan=excluded.dhatu_samutthan,utu_samutthan=excluded.utu_samutthan,ayu_samutthan=excluded.ayu_samutthan,kala_samutthan=excluded.kala_samutthan,pradesa_samutthan=excluded.pradesa_samutthan,birth_constitution=excluded.birth_constitution,present_constitution=excluded.present_constitution,disease_causes=excluded.disease_causes,symptom_mechanism=excluded.symptom_mechanism,analysis_summary=excluded.analysis_summary,thai_diagnosis=excluded.thai_diagnosis,differential_diagnosis=excluded.differential_diagnosis,diagnostic_confidence=excluded.diagnostic_confidence,dosha_state=excluded.dosha_state,coordinate=excluded.coordinate,mixed_coordinate=excluded.mixed_coordinate,season_4=excluded.season_4,season_6=excluded.season_6,season_pitsadan=excluded.season_pitsadan,zodiac_samutthan=excluded.zodiac_samutthan,knowledge_version=excluded.knowledge_version,practitioner_confirmed=excluded.practitioner_confirmed,diagnosed_by=auth.uid(),diagnosed_at=now(),updated_at=now()
  returning id into v_dx_id;

  insert into public.ttm_diagnostic_contexts(encounter_id,birth_element,current_element,ayu_samutthan,kala_samutthan,pradesa_samutthan,dosha_state,coordinate,mixed_coordinate,season_4,season_6,season_pitsadan,zodiac_samutthan,practitioner_confirmed,confirmed_by,confirmed_at,knowledge_version,updated_at)
  values(p_encounter_id,p_birth_constitution,p_present_constitution,p_ayu_samutthan,p_kala_samutthan,p_pradesa_samutthan,p_dosha_state,p_coordinate,p_mixed_coordinate,p_season_4,p_season_6,p_season_pitsadan,p_zodiac_samutthan,coalesce(p_practitioner_confirmed,false),case when p_practitioner_confirmed then auth.uid() else null end,case when p_practitioner_confirmed then now() else null end,p_knowledge_version,now())
  on conflict(encounter_id) do update set birth_element=excluded.birth_element,current_element=excluded.current_element,ayu_samutthan=excluded.ayu_samutthan,kala_samutthan=excluded.kala_samutthan,pradesa_samutthan=excluded.pradesa_samutthan,dosha_state=excluded.dosha_state,coordinate=excluded.coordinate,mixed_coordinate=excluded.mixed_coordinate,season_4=excluded.season_4,season_6=excluded.season_6,season_pitsadan=excluded.season_pitsadan,zodiac_samutthan=excluded.zodiac_samutthan,practitioner_confirmed=excluded.practitioner_confirmed,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,knowledge_version=excluded.knowledge_version,updated_at=now();
  return v_dx_id;
end;
$$;

grant execute on function public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text) to authenticated;

commit;

with required_objects(object_type,object_name,is_ready) as (
  values
    ('table','encounters',to_regclass('public.encounters') is not null),
    ('table','clinical_examination_findings',to_regclass('public.clinical_examination_findings') is not null),
    ('table','body_pain_points',to_regclass('public.body_pain_points') is not null),
    ('table','ttm_structured_diagnoses',to_regclass('public.ttm_structured_diagnoses') is not null),
    ('table','ttm_diagnostic_knowledge',to_regclass('public.ttm_diagnostic_knowledge') is not null),
    ('table','ttm_diagnostic_contexts',to_regclass('public.ttm_diagnostic_contexts') is not null),
    ('table','clinical_treatment_plans',to_regclass('public.clinical_treatment_plans') is not null),
    ('table','ttm_opd_histories',to_regclass('public.ttm_opd_histories') is not null),
    ('table','clinical_treatment_sessions',to_regclass('public.clinical_treatment_sessions') is not null),
    ('function','create_clinical_treatment_session',to_regprocedure('public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)') is not null),
    ('function','save_ttm_diagnosis_atomic',to_regprocedure('public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)') is not null)
), summary as(select count(*) total_checks,count(*) filter(where is_ready) ready_checks,count(*) filter(where not is_ready) missing_checks from required_objects)
select object_type,object_name,case when is_ready then 'READY' else 'MISSING' end status from required_objects
union all
select 'SUMMARY','CHANANYA_CLINICAL_OS_V3_1',case when missing_checks=0 then 'READY '||ready_checks||'/'||total_checks else 'MISSING '||missing_checks||' OF '||total_checks end from summary
order by object_type,object_name;
