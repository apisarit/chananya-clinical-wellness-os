-- Chananya Clinical OS v3.1 health check
-- Read-only verification. Safe to run repeatedly in Supabase SQL Editor.

with required_objects(object_type, object_name, is_ready) as (
  values
    ('table','encounters', to_regclass('public.encounters') is not null),
    ('table','clinical_examination_findings', to_regclass('public.clinical_examination_findings') is not null),
    ('table','body_pain_points', to_regclass('public.body_pain_points') is not null),
    ('table','ttm_structured_diagnoses', to_regclass('public.ttm_structured_diagnoses') is not null),
    ('table','ttm_diagnostic_knowledge', to_regclass('public.ttm_diagnostic_knowledge') is not null),
    ('table','ttm_diagnostic_contexts', to_regclass('public.ttm_diagnostic_contexts') is not null),
    ('table','clinical_treatment_plans', to_regclass('public.clinical_treatment_plans') is not null),
    ('table','ttm_opd_histories', to_regclass('public.ttm_opd_histories') is not null),
    ('table','clinical_treatment_sessions', to_regclass('public.clinical_treatment_sessions') is not null),
    ('function','has_role', to_regprocedure('public.has_role(text[])') is not null),
    ('function','create_clinical_treatment_session', to_regprocedure('public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)') is not null),
    ('function','save_ttm_diagnosis_atomic', to_regprocedure('public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)') is not null)
), summary as (
  select
    count(*) as total_checks,
    count(*) filter (where is_ready) as ready_checks,
    count(*) filter (where not is_ready) as missing_checks
  from required_objects
)
select
  r.object_type,
  r.object_name,
  case when r.is_ready then 'READY' else 'MISSING' end as status
from required_objects r
union all
select
  'SUMMARY',
  'CHANANYA_CLINICAL_OS_V3_1',
  case when s.missing_checks = 0
       then 'READY ' || s.ready_checks || '/' || s.total_checks
       else 'MISSING ' || s.missing_checks || ' OF ' || s.total_checks
  end
from summary s
order by object_type, object_name;
