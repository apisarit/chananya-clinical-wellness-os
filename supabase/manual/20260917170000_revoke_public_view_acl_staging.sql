-- Staging-only view ACL closure.
-- Views do not have RLS; they must not retain default PUBLIC/anon grants.
-- This manual change is intentionally scoped to the isolated staging project.
revoke all on table
  public.admin_task_summary,
  public.available_practitioner_schedules,
  public.user_access_summary,
  public.v_clinical_herbal_traceability,
  public.v_ttm_dkr_v1_review_coverage,
  public.v_ttm_foundation_coverage,
  public.v_ttm_foundation_graph
from public, anon;

grant select on table
  public.admin_task_summary,
  public.available_practitioner_schedules,
  public.user_access_summary,
  public.v_clinical_herbal_traceability,
  public.v_ttm_dkr_v1_review_coverage,
  public.v_ttm_foundation_coverage,
  public.v_ttm_foundation_graph
to authenticated;
