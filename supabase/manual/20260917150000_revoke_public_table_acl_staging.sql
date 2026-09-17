begin;

-- Staging-only ACL closure.  These tables have RLS policies for
-- authenticated users and no policy for PUBLIC/anon.  The default PUBLIC
-- table grant is therefore unnecessary and can otherwise make the API surface
-- appear writable to anon even though RLS currently denies rows.  Keep the
-- reviewed authenticated/service_role grants unchanged.
revoke all on table
  public.appointment_events,
  public.approval_actions,
  public.approval_tasks,
  public.body_pain_points,
  public.clinic_appointments,
  public.clinic_specialties,
  public.clinic_state,
  public.clinical_examination_findings,
  public.clinical_followup_notes,
  public.clinical_record_audit_events,
  public.clinical_record_signoffs,
  public.clinical_treatment_plans,
  public.clinical_treatment_sessions,
  public.clinics,
  public.encounter_identity_verifications,
  public.finished_goods_receipts,
  public.formula_components,
  public.formulas,
  public.import_batches,
  public.import_rows,
  public.patient_identity_events,
  public.patient_user_links,
  public.pharmacy_counter_allocations,
  public.pharmacy_counter_sale_items,
  public.pharmacy_counter_sales,
  public.practitioner_schedules,
  public.practitioner_specialties,
  public.production_material_issues,
  public.production_orders,
  public.production_qc,
  public.production_requests,
  public.sen_line_master,
  public.ttm_concept_terms,
  public.ttm_diagnostic_contexts,
  public.ttm_encounter_concepts,
  public.ttm_opd_histories,
  public.ttm_structured_diagnoses
from public, anon;

commit;
