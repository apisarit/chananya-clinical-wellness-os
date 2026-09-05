begin;

-- Supabase projects with "Automatically expose new tables" disabled do not
-- receive implicit Data API privileges. Grant only the operations exercised by
-- the guarded staging provision/import/verification tools. Netlify production
-- Functions continue to use explicitly granted SECURITY DEFINER RPCs.
grant usage on schema public to service_role;

grant select on table
  public.profiles,
  public.audit_logs
to authenticated;

grant select, insert, update on table
  public.profiles,
  public.clinic_memberships,
  public.ttm_sources,
  public.ttm_concepts,
  public.ttm_concept_relations,
  public.ttm_diagnostic_knowledge
to service_role;

grant select, insert on table
  public.audit_logs
to service_role;

grant select, update on table
  public.patient_qr_sessions
to service_role;

revoke all on table
  public.profiles,
  public.clinic_memberships,
  public.ttm_sources,
  public.ttm_concepts,
  public.ttm_concept_relations,
  public.ttm_diagnostic_knowledge,
  public.audit_logs,
  public.patient_qr_sessions
from anon;

commit;

select 'CLINICAL_OS_EXPLICIT_SERVICE_ROLE_DATA_API_READY' as status;
