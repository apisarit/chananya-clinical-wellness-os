-- This manual candidate is a psql program, not migration-runner SQL. It is a
-- separately reviewable proposal bound to the Chananya staging observer-v2
-- evidence. It is deliberately inert and is not authorized for any database.
-- A later ordered migration must use its own reviewed transaction envelope.

\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
\unset cnyos_complete_acl_probe_xid
\unset cnyos_complete_acl_existing_transaction

\if :AUTOCOMMIT
\else
\warn 'CNYOS complete ACL candidate requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_complete_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_complete_acl_psql_preflight_abort$;
\endif

set search_path = pg_catalog, pg_temp;

select pg_catalog.pg_current_xact_id()::text as cnyos_complete_acl_probe_xid
\gset
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_complete_acl_probe_xid'
) as cnyos_complete_acl_existing_transaction
\gset
\if :cnyos_complete_acl_existing_transaction
\warn 'CNYOS complete ACL candidate detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_complete_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_complete_acl_psql_preflight_abort$;
\endif

-- Five independent release blockers. Removing any one is insufficient. This
-- separate pre-acquisition DO is deliberately before BEGIN and every lock, so
-- the exact candidate cannot acquire relation locks or reach a snapshot. A
-- separately reviewed successor must remove each blocker for its own evidence.
do $cnyos_complete_acl_policy_blockers$
begin
  raise exception 'CNYOS_COMPLETE_ACL_REMEDIATION_NOT_AUTHORIZED';
  raise exception 'CNYOS_COMPLETE_ACL_SUPABASE_ADMIN_DEFAULT_EXCEPTION_NOT_ACCEPTED';
  raise exception 'CNYOS_COMPLETE_ACL_SECURITY_DEFINER_PATH_PLAN_NOT_APPROVED';
  raise exception 'CNYOS_COMPLETE_ACL_LEDGER_AND_FULL_147_141_NATIVE_REHEARSAL_INCOMPLETE';
  -- This blocker must be replaced by an independently reviewed hosted locking
  -- and fresh post-commit observer protocol, not merely deleted.
  raise exception 'CNYOS_COMPLETE_ACL_HOSTED_CONCURRENCY_AND_FRESH_OBSERVER_NOT_APPROVED';
end
$cnyos_complete_acl_policy_blockers$;

-- CNYOS_COMPLETE_ACL_SQL_ACQUISITION_BEGIN
do $cnyos_complete_acl_interlock$
begin
  if exists (
    select 1
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype = 'advisory'
      and lock_row.pid = pg_catalog.pg_backend_pid()
      and lock_row.granted
      and lock_row.classid::bigint = (202608302100::bigint >> 32)
      and lock_row.objid::bigint =
          (202608302100::bigint & 4294967295::bigint)
      and lock_row.objsubid = 1
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_ADVISORY_INTERLOCK_ALREADY_HELD';
  end if;
  if not pg_catalog.pg_try_advisory_lock(202608302100::bigint) then
    raise exception 'CNYOS_COMPLETE_ACL_ADVISORY_INTERLOCK_BUSY';
  end if;
end
$cnyos_complete_acl_interlock$;

begin isolation level repeatable read read write;
set local search_path = pg_catalog, pg_temp;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local extra_float_digits = 3;
set local bytea_output = 'hex';
set local quote_all_identifiers = off;
set local standard_conforming_strings = on;
set local lc_monetary = 'C';
set local lc_numeric = 'C';
set local lc_time = 'C';

-- One deterministic C-sorted statement freezes CREATE/ALTER/DROP TRIGGER,
-- relation replacement, and concurrent writes for all 91 evidence-bound
-- persistent relations before this repeatable-read transaction can establish
-- any catalog/data snapshot. ONLY avoids implicitly expanding descendants;
-- NOWAIT makes concurrent activity a deterministic abort.
lock table only
  auth.users,
  public.appointment_events,
  public.appointments,
  public.approval_actions,
  public.approval_tasks,
  public.audit_logs,
  public.backup_export_runs,
  public.barthel_assessments,
  public.body_pain_points,
  public.clinic_appointments,
  public.clinic_counters,
  public.clinic_drive_backup_destinations,
  public.clinic_drive_destination_events,
  public.clinic_memberships,
  public.clinic_specialties,
  public.clinic_state,
  public.clinic_subscription_control_events,
  public.clinical_examination_findings,
  public.clinical_followup_notes,
  public.clinical_record_audit_events,
  public.clinical_record_signoffs,
  public.clinical_treatment_plans,
  public.clinical_treatment_sessions,
  public.clinics,
  public.dispensing_items,
  public.dispensing_orders,
  public.encounter_identity_verifications,
  public.encounters,
  public.finished_goods_receipts,
  public.followups,
  public.formula_components,
  public.formulas,
  public.import_batches,
  public.import_rows,
  public.intermediate_care_assessments,
  public.inventory_lots,
  public.invoice_items,
  public.invoices,
  public.line_oa_contacts,
  public.line_oa_delivery_events,
  public.line_oa_gateway_contact_states,
  public.line_oa_gateway_webhook_events,
  public.line_oa_notification_outbox,
  public.line_oa_notification_preferences,
  public.line_oa_webhook_events,
  public.owner_control_historical_replay_guard,
  public.pain_assessments,
  public.pain_markers,
  public.patient_allergies,
  public.patient_identity_events,
  public.patient_identity_link_requests,
  public.patient_identity_links,
  public.patient_identity_rate_limits,
  public.patient_qr_sessions,
  public.patient_user_links,
  public.patients,
  public.payments,
  public.pharmacy_counter_allocations,
  public.pharmacy_counter_sale_items,
  public.pharmacy_counter_sales,
  public.practitioner_schedules,
  public.practitioner_specialties,
  public.prescription_items,
  public.prescriptions,
  public.price_list_items,
  public.price_lists,
  public.production_material_issues,
  public.production_orders,
  public.production_qc,
  public.production_requests,
  public.products,
  public.profiles,
  public.sen_line_master,
  public.services,
  public.stock_movements,
  public.suppliers,
  public.treatment_orders,
  public.treatment_sessions,
  public.ttm_concept_relations,
  public.ttm_concept_terms,
  public.ttm_concepts,
  public.ttm_diagnostic_contexts,
  public.ttm_diagnostic_knowledge,
  public.ttm_encounter_concepts,
  public.ttm_opd_histories,
  public.ttm_sources,
  public.ttm_structured_diagnoses,
  public.vital_signs,
  realtime.subscription,
  storage.buckets,
  storage.objects
in share mode nowait;

-- Hosted postgres is deliberately non-superuser and has no pg_maintain grant.
-- Therefore this candidate does not request unsupported SHARE locks on system
-- catalogs. The future enabled path instead freezes every evidence-bound
-- trigger relation before inspecting it and acquires object locks for all 147
-- routines through one batched REVOKE followed by the two batched GRANTs.
-- That cannot serialize platform-owned catalog activity globally, so an
-- unconditional concurrency/post-commit-observer blocker remains below.

-- Evidence identity (classification is complete; authorization is false):
-- source revision: 831543c2d1ed36b2d8242cc82af23c83e019e7a7
-- observer raw SHA-256: 235a2c612c78367e4c2beff0243b4bc624fd6107fbdc39b1f9c0af8ae4ace27e
-- observer SQL SHA-256: 46a226f7ab7f0d3ee4f6062c1bc223dcdbee351d7640f86592e3614cb261a777
-- observation composite SHA-256: 9a555548d810ec5bed2dc86591651ca144941687c3fd34cf8d0828708ebb9efe
-- system identifier: 7666007964130682852
-- project: chananya-staging / hsmnjwxurlmsizndjlun

do $cnyos_complete_acl_candidate$
declare
  v_authenticated_only constant text[] := array[
    'public.admin_assign_staff_role(uuid,text,text)',
    'public.admin_set_staff_membership_active(uuid,boolean,text)',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.clinical_outcomes_summary(timestamp with time zone,timestamp with time zone)',
    'public.confirm_patient_qr(uuid,boolean,text,jsonb)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamp with time zone,jsonb)',
    'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)',
    'public.current_access_context()',
    'public.decide_approval_task(uuid,text,text)',
    'public.hybrid_patient_identity_healthcheck()',
    'public.issue_patient_line_link_code(uuid,text,text,boolean)',
    'public.list_patient_identity_links(uuid)',
    'public.resolve_patient_qr(text,text)',
    'public.revoke_patient_identity_link(uuid,text)',
    'public.search_clinical_outcomes(text,timestamp with time zone,timestamp with time zone,integer,integer)',
    'public.search_patients_for_checkin(text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)',
    'public.super_admin_set_system_role(uuid,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)',
    'public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text)'
  ]::text[];
  v_authenticated_and_service constant text[] := array[
    'public.backup_restore_contract_healthcheck()',
    'public.can_access_encounter(uuid)',
    'public.can_access_invoice(uuid)',
    'public.can_access_patient(uuid)',
    'public.can_access_prescription(uuid)',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.commit_production_import(uuid)',
    'public.complete_production_order(uuid,numeric,numeric,numeric)',
    'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)',
    'public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)',
    'public.create_production_request(uuid,uuid,uuid,numeric,text,timestamp with time zone,text,text)',
    'public.current_clinic_id()',
    'public.current_department_role()',
    'public.current_user_role()',
    'public.department_can(text)',
    'public.department_persistence_healthcheck()',
    'public.dispense_pharmacy_counter_sale(uuid)',
    'public.has_role(text[])',
    'public.is_admin_or_super()',
    'public.is_appointment_operator()',
    'public.is_appointment_practitioner()',
    'public.is_clinic_admin()',
    'public.is_clinic_member(uuid,text[])',
    'public.is_practitioner()',
    'public.is_reception_or_admin()',
    'public.is_super_admin()',
    'public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)',
    'public.issue_production_materials_fefo(uuid)',
    'public.line_oa_operational_healthcheck()',
    'public.open_production_order(uuid,uuid,numeric)',
    'public.prescription_dispensing_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_reject_production_order(uuid,text,text)',
    'public.quality_release_healthcheck()',
    'public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
    'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)',
    'public.remove_pharmacy_counter_sale_item(uuid)',
    'public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)',
    'public.set_product_master_active(uuid,boolean,text)',
    'public.stage_production_import(text,text,text,jsonb)',
    'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
    'public.transition_pharmacy_counter_sale(uuid,text,text)',
    'public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text)',
    'public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)',
    'public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text)',
    'public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text)',
    'public.upsert_supplier_master(uuid,text,text,text,text,text,text)'
  ]::text[];
  v_service_only constant text[] := array[
    'public.assert_clinic_subscription_active(uuid)',
    'public.begin_backup_export_run(uuid,timestamp with time zone,text)',
    'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
    'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamp with time zone,boolean,text,text,text,text,text,text,text,jsonb)',
    'public.complete_backup_export_run(uuid,text,jsonb,jsonb,text)',
    'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
    'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
    'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
    'public.export_clinic_backup_domain(uuid,text)',
    'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
    'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
    'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
    'public.get_clinic_drive_backup_destination(uuid,text)',
    'public.get_exact_backup_restore_source(text,timestamp with time zone,text)',
    'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamp with time zone)',
    'public.line_oa_webhook_evidence(timestamp with time zone)',
    'public.list_backup_export_clinics()',
    'public.list_line_linked_patients_for_clinic(uuid,text)',
    'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
    'public.list_owner_drive_assignments()',
    'public.list_owner_subscription_clinics()',
    'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamp with time zone,boolean,text)',
    'public.reject_production_order(uuid,text,text)',
    'public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
    'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)',
    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
    'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
    'public.verify_clinic_restore_trace(uuid)'
  ]::text[];
  v_owner_only_ordinary constant text[] := array[
    'public.apply_initial_encounter_intake(uuid,jsonb)',
    'public.complete_patient_line_link(text,text,text,boolean)',
    'public.consume_patient_identity_rate_limit(text,integer,integer)',
    'public.export_clinic_backup_domain_v20260828(uuid,text)',
    'public.export_clinic_backup_domain_v20260829(uuid,text)',
    'public.export_clinic_backup_domain_v20260831(uuid,text)',
    'public.issue_patient_qr_for_subject(text,uuid,text,text,timestamp with time zone)',
    'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
    'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamp with time zone,boolean,text,text,text,text,text,text,text,jsonb)',
    'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
    'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
    'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
    'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
    'public.line_oa_queue_notification_v20260829(uuid,text,timestamp with time zone,timestamp with time zone,text)',
    'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamp with time zone,boolean,text)',
    'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
    'public.list_line_linked_patients(text)',
    'public.next_clinic_counter(uuid,text)',
    'public.next_encounter_number()',
    'public.prepare_line_subscription_off_exception(uuid,text)',
    'public.queue_line_oa_appointment_notification(uuid,text,timestamp with time zone,timestamp with time zone,text)',
    'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
    'public.verify_clinic_restore_trace_v20260828(uuid)',
    'public.verify_clinic_restore_trace_v20260829(uuid)',
    'public.verify_clinic_restore_trace_v20260831(uuid)'
  ]::text[];
  v_owner_only_trigger constant text[] := array[
    'public.apply_stock_movement()',
    'public.assign_audit_clinic()',
    'public.assign_inventory_lot_clinic()',
    'public.assign_patient_child_clinic()',
    'public.assign_patient_clinic()',
    'public.assign_pharmacy_allocation_clinic()',
    'public.assign_pharmacy_item_clinic()',
    'public.assign_pharmacy_sale_clinic()',
    'public.assign_product_clinic()',
    'public.assign_stock_movement_clinic()',
    'public.enforce_active_subscription_tenant_write()',
    'public.enforce_authenticated_subscription_statement_write()',
    'public.enforce_patient_registry_write()',
    'public.enforce_prescription_item_product_tenant()',
    'public.enqueue_line_oa_from_appointment()',
    'public.guard_owner_subscription_forward_only()',
    'public.handle_new_user()',
    'public.prevent_encounter_clinical_evidence_delete()',
    'public.prevent_locked_clinical_record_mutation()',
    'public.reject_append_only_mutation()',
    'public.set_body_pain_point_updated_at()',
    'public.set_updated_at()',
    'public.withdraw_line_oa_on_identity_revoke()'
  ]::text[];
  v_owner_only_event_trigger constant text[] := array[
    'public.rls_auto_enable()'
  ]::text[];
  v_observed_default_creators constant text[] := array[
    'pg_database_owner', 'postgres', 'supabase_admin'
  ]::text[];
  v_mutable_default_creators constant text[] := array[
    'pg_database_owner', 'postgres'
  ]::text[];
  -- Exact 91-relation closure of the 173 non-internal trigger bindings. A
  -- future enabled path must lock every relation before reading the binding
  -- catalogs; this list is set-equal to the observer-v2 disposition artifact.
  v_trigger_relations constant text[] := array[
    'auth.users',
    'public.appointment_events',
    'public.appointments',
    'public.approval_actions',
    'public.approval_tasks',
    'public.audit_logs',
    'public.backup_export_runs',
    'public.barthel_assessments',
    'public.body_pain_points',
    'public.clinic_appointments',
    'public.clinic_counters',
    'public.clinic_drive_backup_destinations',
    'public.clinic_drive_destination_events',
    'public.clinic_memberships',
    'public.clinic_specialties',
    'public.clinic_state',
    'public.clinic_subscription_control_events',
    'public.clinical_examination_findings',
    'public.clinical_followup_notes',
    'public.clinical_record_audit_events',
    'public.clinical_record_signoffs',
    'public.clinical_treatment_plans',
    'public.clinical_treatment_sessions',
    'public.clinics',
    'public.dispensing_items',
    'public.dispensing_orders',
    'public.encounter_identity_verifications',
    'public.encounters',
    'public.finished_goods_receipts',
    'public.followups',
    'public.formula_components',
    'public.formulas',
    'public.import_batches',
    'public.import_rows',
    'public.intermediate_care_assessments',
    'public.inventory_lots',
    'public.invoice_items',
    'public.invoices',
    'public.line_oa_contacts',
    'public.line_oa_delivery_events',
    'public.line_oa_gateway_contact_states',
    'public.line_oa_gateway_webhook_events',
    'public.line_oa_notification_outbox',
    'public.line_oa_notification_preferences',
    'public.line_oa_webhook_events',
    'public.owner_control_historical_replay_guard',
    'public.pain_assessments',
    'public.pain_markers',
    'public.patient_allergies',
    'public.patient_identity_events',
    'public.patient_identity_link_requests',
    'public.patient_identity_links',
    'public.patient_identity_rate_limits',
    'public.patient_qr_sessions',
    'public.patient_user_links',
    'public.patients',
    'public.payments',
    'public.pharmacy_counter_allocations',
    'public.pharmacy_counter_sale_items',
    'public.pharmacy_counter_sales',
    'public.practitioner_schedules',
    'public.practitioner_specialties',
    'public.prescription_items',
    'public.prescriptions',
    'public.price_list_items',
    'public.price_lists',
    'public.production_material_issues',
    'public.production_orders',
    'public.production_qc',
    'public.production_requests',
    'public.products',
    'public.profiles',
    'public.sen_line_master',
    'public.services',
    'public.stock_movements',
    'public.suppliers',
    'public.treatment_orders',
    'public.treatment_sessions',
    'public.ttm_concept_relations',
    'public.ttm_concept_terms',
    'public.ttm_concepts',
    'public.ttm_diagnostic_contexts',
    'public.ttm_diagnostic_knowledge',
    'public.ttm_encounter_concepts',
    'public.ttm_opd_histories',
    'public.ttm_sources',
    'public.ttm_structured_diagnoses',
    'public.vital_signs',
    'realtime.subscription',
    'storage.buckets',
    'storage.objects'
  ]::text[];
  -- Exact live-v2 SECURITY DEFINER plan. Adding pg_temp last preserves the
  -- existing pg_catalog/public resolution order while removing implicit
  -- pg_temp precedence for relations and types. The reviewed definitions contain
  -- no intentional temporary-object lookup; the only textual pg_temp reference
  -- rejects temporary schemas in the event-trigger policy.
  -- Compact JSON plan SHA-256:
  -- dd948f4f7f6baa535d26446aaba64aba3b7e79cfe2c4e2c63a2c83ee0fd0d2bb
  v_reviewed_path_plan constant jsonb := $cnyos_reviewed_path_plan$
  [
    {
      "signature": "public.admin_assign_staff_role(uuid,text,text)",
      "definition_sha256": "091d0cbbf962d0fae78967cad7fece9edbe9952989e6954a829728a2ce97f020",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.admin_set_staff_membership_active(uuid,boolean,text)",
      "definition_sha256": "54c445717a0c0e351e9bd0addc681c5e80887072b99cd3805d588b82e83673d3",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.apply_initial_encounter_intake(uuid,jsonb)",
      "definition_sha256": "39bf2c7349751f03046131c26c42fa078b0786d3b94d38c74c65a2f64822da90",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.apply_stock_movement()",
      "definition_sha256": "20d1984fd7a2cf9c53c86bcecd5638e5d390522f2200f4ded2b920b06c3027a5",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assert_clinic_subscription_active(uuid)",
      "definition_sha256": "096e9de8928960c40bfb5a1b0edf27948a80288f9649f15742cc7af8944ae591",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_inventory_lot_clinic()",
      "definition_sha256": "0cf87150aa53b388d7c74b954880ca707bd01c7ebdb78c166b0294a13c91bf45",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_pharmacy_allocation_clinic()",
      "definition_sha256": "c88e8d059a4ff4ea4706e0cf213ce299e773c9151b60b48a4892b6124a1a0ef9",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_pharmacy_item_clinic()",
      "definition_sha256": "0d0c311b3c95eb96af40c07595ba20ca12ef17ef580567eb22c43f0ae27b1e3f",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_pharmacy_sale_clinic()",
      "definition_sha256": "5cc6357859b726bc76b68816b60df7ce6246775663ad78c642fff4b8c433786e",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_product_clinic()",
      "definition_sha256": "f304b4455bccbbe73b539ee3c289e8ce8869ff79183ba6cf2d1ae541e7d02183",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.assign_stock_movement_clinic()",
      "definition_sha256": "954ff288bcc9bba298690af60773df64577773d7ff24ace040aca4e19b1b0c30",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.backup_restore_contract_healthcheck()",
      "definition_sha256": "729e87d125392d324c9b97acd113441c68c2098badc31d5fdec0636d090ca158",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.begin_backup_export_run(uuid,timestamp with time zone,text)",
      "definition_sha256": "2e6be403fa6276fc9c14448346dc1fff9c58352702133627bcba21445d6aa6fd",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.book_clinic_appointment(uuid,uuid,text,text,text)",
      "definition_sha256": "150e08d24985fd6de9ef3a3fe32182b1526261d84161f9b26d814c97003dc6db",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.can_access_encounter(uuid)",
      "definition_sha256": "272e0e899c5439f186729f7d2d8e983eee684a381d9bc37db07d8ed62b5342c3",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.can_access_invoice(uuid)",
      "definition_sha256": "d9cec0ed598ef38c6b3d03694917f8bb97c0d268bbbc0e7fbfd6249dd1716afc",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.can_access_patient(uuid)",
      "definition_sha256": "8a7a7e94e0e58fa83138f63bad8f962b7648de9c51a286812baf7d87ae5e9e0a",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.can_access_prescription(uuid)",
      "definition_sha256": "7eb71fab3cf91ed43342d9b2afe4a2d01f44cf2f1d9f2c5bf5faa161ac867570",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.cancel_clinic_appointment(uuid,text)",
      "definition_sha256": "9fdd62e85d8caf1208188e82720fa013a28700a7a24d9c7fc58935d0929b284a",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)",
      "definition_sha256": "b03aa56138973146ec0a0172a62995ec291088da48bbe446903f6296e8313365",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamp with time zone,boolean,text,text,text,text,text,text,text,jsonb)",
      "definition_sha256": "0b8d1f4bdc81d51944af1daf9563c812ff910e513f6573662e1bc3e77f1e4772",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.clinical_financial_handoffs_healthcheck()",
      "definition_sha256": "278118140e1e408f8fd005abdb141486fa2a6319b8d47d4ce6c67f389fc9228f",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.clinical_outcomes_summary(timestamp with time zone,timestamp with time zone)",
      "definition_sha256": "35f760861fc4cc182c0a49d51fa662709639c0bd2567c31594d472cc3636a060",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.commit_production_import(uuid)",
      "definition_sha256": "5bf182903d043d34e4a2ae918264c1c54d5f14668066de0179ce3da13abbbaff",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.complete_backup_export_run(uuid,text,jsonb,jsonb,text)",
      "definition_sha256": "bcc1f5676e92c2200ccaf2bd9648c12e2ca312d25b206b87f6f76ed718fba329",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.complete_patient_line_link(text,text,text,boolean)",
      "definition_sha256": "1c6aca64c35d54694bb51b08601e6d376c066086b8609c02a16787de7ec8c352",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)",
      "definition_sha256": "623aa896498b62c182d7bf40e17d4c17fc567e0591ed5669363f09c5ea2291ba",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)",
      "definition_sha256": "aa677f872ea9510b1dbcaa3db6537d716a4bc36fc6e06abb45a9ef5772478957",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.complete_production_order(uuid,numeric,numeric,numeric)",
      "definition_sha256": "7157a0fda6a98ce3440ef025f9f0813e74660b6ad3a1089740b0e1a213cec62e",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.confirm_patient_qr(uuid,boolean,text,jsonb)",
      "definition_sha256": "d3f2c8e9af3b7de2c185ce5000c618130ac154c1fee12147f9d37772b9751c12",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.consume_patient_identity_rate_limit(text,integer,integer)",
      "definition_sha256": "f7af30cd1663ca8db4245988dcfe8d1bbc649e8ea4f054d9a3ac0a4f9b020668",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)",
      "definition_sha256": "5c1c0fc38133cae897bb124dca32dfc8f0a4cf39e88a59bb6f48b225cd968fb9",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.create_approval_task(text,text,text,text,text,text,uuid,timestamp with time zone,jsonb)",
      "definition_sha256": "98f8f194b70f96fb24baa3d5c484e7d947ba82ed64673a2e15fbd9324a6d75b3",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)",
      "definition_sha256": "c78f70dfb07e188c27684d5256d989635a208fd3b7dd12bba81b6612b043f1ca",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)",
      "definition_sha256": "a3411d6d303675ea19b55d434ebb80e21579ea7dfb631ff3e7f7a930b3ee4d82",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.create_production_request(uuid,uuid,uuid,numeric,text,timestamp with time zone,text,text)",
      "definition_sha256": "c8a43cfa9b5f6114a852d1a922e41d5e95844e0e144bf506f5e5e98cc28d529b",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.current_access_context()",
      "definition_sha256": "907ad47760537a5573423b4071c40f70900cd711cfd1b651987a9cfe83f806c0",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.current_clinic_id()",
      "definition_sha256": "b53f1b1f01f74928b90ee1826ad8cbd40c3eb3b933fd39c6241a5de53f9a1306",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.current_department_role()",
      "definition_sha256": "f3163c2ce4c95d1c6308959f12d89995ccbc6549157e6716e12f4963e97a8b32",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.current_user_role()",
      "definition_sha256": "3e78f8051447640d770afd3e2cf629b48ba41e0d3a3bb7ada4960ad8ad09d314",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.decide_approval_task(uuid,text,text)",
      "definition_sha256": "27f8abc876b508fccc32d9d39ac956643f6b036b9865d3413876e21bd1b1c1a8",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.department_can(text)",
      "definition_sha256": "875efd95a5778e03a7c5835ffc08b3d7b5ca6d02af7067e4846c29c8ebebb96a",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.department_persistence_healthcheck()",
      "definition_sha256": "4b28c4edbff7dd60bd1200ac090f9d721ab5e9659638886efcb2ac0379c11125",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.dispense_pharmacy_counter_sale(uuid)",
      "definition_sha256": "ab7811e2facd31074a7c8e88bfefba48b8f3143350d5721dfb7be6ff46791156",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.enforce_active_subscription_tenant_write()",
      "definition_sha256": "de73dda0b8c45b2948263066d07e491ac716712050cadf40927aa6360b29dfbc",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.enforce_authenticated_subscription_statement_write()",
      "definition_sha256": "d937d73209c298ecf837d8898a2b141a0bcceedcea0dabcb401a70c438c5d821",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.enforce_patient_registry_write()",
      "definition_sha256": "5c56d41ef363c5f00e4fece80cc8c3ceb5537d1ba6ef198da888aef037536e3e",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.enforce_prescription_item_product_tenant()",
      "definition_sha256": "5ab5934f1e20c35b55e4f7a1e51c92d68201054e7e2166cb9e7009c354dc0624",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.enqueue_line_oa_from_appointment()",
      "definition_sha256": "1d2f4c1646312747b3aee8bd3c4bbe40349c7003e4e3e8f7816609b5d894f433",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.export_clinic_backup_domain(uuid,text)",
      "definition_sha256": "f18f213e2fc5a821815e31f08e1f1afc478d18d9f07bfbc65bc31651c83fb342",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.export_clinic_backup_domain_v20260828(uuid,text)",
      "definition_sha256": "7f148a7ebee44de31b704071383e090a7bbded3e01ab5ffb78452186be627d5e",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.export_clinic_backup_domain_v20260829(uuid,text)",
      "definition_sha256": "83bd9eb44b71da2a06a4b8783091c0a5df45ab524ab6f1b6691e29de86ea592d",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.export_clinic_backup_domain_v20260831(uuid,text)",
      "definition_sha256": "79cc1e6ce03f8a2e80745d2a22146146db9d1b73b25180fa425322183d65bdee",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.finalize_line_oa_webhook_event(text,text,text,text,text)",
      "definition_sha256": "dc6f2bbd4606ec35092af1794b4f3f7f84e9f3383696f34a01dd229e64dc5f05",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.finish_line_oa_notification(uuid,text,text,integer,text,text)",
      "definition_sha256": "f92321f691a64889ca0e428ef9546f045dc7f5dcc22904003266b8bda63e0dab",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)",
      "definition_sha256": "9f4f1865180aa983e5513f8d4fb6c1943c95e8037ddb5088bce7ed1a72eb025c",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.get_clinic_drive_backup_destination(uuid,text)",
      "definition_sha256": "742a50207e33d33aa9de6eb0278b732116068ed8321158a44a371f052b389afc",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.get_exact_backup_restore_source(text,timestamp with time zone,text)",
      "definition_sha256": "cb1cfb335c1ca59c3ae4e6915936cf5ae4fb3af08a033eb63ab2198a0f109316",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.guard_owner_subscription_forward_only()",
      "definition_sha256": "e1360c73b347ffdac0ebd97cdcb9b5e55b6649943ab803f5f9c1068d8a4b2fd5",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.handle_new_user()",
      "definition_sha256": "44d4c6e32d6bd41d34749fca0b8585a4e82ef4c80627d6016751926859e7f359",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.has_role(text[])",
      "definition_sha256": "0aa3e4b354e60375d91071d241f13662814cf73dd1290f7139c9eb173c7e0f41",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.hybrid_patient_identity_healthcheck()",
      "definition_sha256": "6db1aee958088946c532d9e6b9451b5cbc9e0e2e1765cec9e59e1fdb018395f2",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_admin_or_super()",
      "definition_sha256": "ee0d01fdfea331895a5f8cf894af1c07f9720f93d1566cae13bdccac9020da5f",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_appointment_operator()",
      "definition_sha256": "fcba9232a9e82907af7742e2ac5966a970c8742054a53f1ce05a23e1b8904f04",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_appointment_practitioner()",
      "definition_sha256": "4c30974086cc5ee787deed858711a0552bd709a4e6d33a45001c726e8b97b4d3",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_clinic_admin()",
      "definition_sha256": "32273c623b244bf6946f3a9b163235c928b23b52f18a55a5c3b38ac41413c5f5",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_clinic_member(uuid,text[])",
      "definition_sha256": "632cb4f2c0337b9d839db34d9b9fb14abbbdd273d9819cc35f30c6e8b2468ccf",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_practitioner()",
      "definition_sha256": "d267d55b248bda093032804e8423740312b42bf53c8d8c4f050caf68b12e6c4d",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_reception_or_admin()",
      "definition_sha256": "c9431e32624956e127d08454104a9da07e73d1ed58f7f8e2a90c7b7752400c5f",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.is_super_admin()",
      "definition_sha256": "fe779128b6976b2e6b440ca475009cbc42fa4e3d4dad13bcd7d6d5e3d48bbcc1",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)",
      "definition_sha256": "da2f254bca3ae8a11091cd2817f15ed196a431e58a9ab24d470ccfcd8cc3396d",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.issue_patient_line_link_code(uuid,text,text,boolean)",
      "definition_sha256": "9a575d1fc4bba42b8bc9039828cb0558d96aa3d69e42ff124fde613d5874f8bd",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.issue_patient_qr_for_subject(text,uuid,text,text,timestamp with time zone)",
      "definition_sha256": "c5283e5a74d4c3ecea2651d75bc88fc0b363d6568757eed9cd3c050bd5b13792",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamp with time zone)",
      "definition_sha256": "efb1d4dd26366e77df5c0d858837f19b3dd16383296bccc581d5dfa41a804097",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.issue_production_materials_fefo(uuid)",
      "definition_sha256": "8bdd879840984676e930dcf4446a0b2a9a08b9a686b0954e56400d00c8e7978b",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)",
      "definition_sha256": "ce081606ca441b7aa19336d8eeb516688cccd48da7380dd602d9fbc6d5c6f727",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamp with time zone,boolean,text,text,text,text,text,text,text,jsonb)",
      "definition_sha256": "a82c1c50cb38edc3fd972292ef2b86a95eb2e4c69d3a5dd87bd98700ead2dcbe",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)",
      "definition_sha256": "48de765344f41af59537863d0d76411c60d674e47bcd4b5a099e005586f5e1ba",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)",
      "definition_sha256": "47b8125cb83c3230e8f9c95c5e9bdcde229eb674be0c212877762bae01c35772",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)",
      "definition_sha256": "2391931004d9c25130740c68a9e4aa238dc6316f1564b5be9fdfd5ba3e66de6c",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)",
      "definition_sha256": "cb78a86fb3e14a6d09d30b5caf0d1ada706946a41d080df9b89de276afd22cb5",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_operational_healthcheck()",
      "definition_sha256": "470048d762a864e686b9d3c2867c3a849450778e0cf6c4ac6137f696d6f9258b",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_queue_notification_v20260829(uuid,text,timestamp with time zone,timestamp with time zone,text)",
      "definition_sha256": "8b77c53c2f5f09083987e9cbdb57142ff91d9eb762bbd0d1fdc5d8f933706d21",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamp with time zone,boolean,text)",
      "definition_sha256": "f3a56a59a11912c8c044c48d1d7323ffba521b153c1a333229afdc1ab50daa34",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)",
      "definition_sha256": "485fd9a33bce4306f6d88d44183869ae7edde7fbfc6dc4aba0f852c279b9368c",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.line_oa_webhook_evidence(timestamp with time zone)",
      "definition_sha256": "5f6f6ef7e4cef6ba8e9d6f596bbaa45f442e4fae1c56d7866a92324d949d8074",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_backup_export_clinics()",
      "definition_sha256": "1f8816ddc51bf47f33e3758afb479b45bd8ab4d65bfbf58a4d5bdefec0d78442",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_line_linked_patients(text)",
      "definition_sha256": "4e360c91c617f734f0b6328458d72de2cd1957631fa0df0a87c02caecb190aad",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_line_linked_patients_for_clinic(uuid,text)",
      "definition_sha256": "af34a5480833e4f07931229bfcfefc2ce7e90b925ebf574d5d2bacf4669b3dde",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)",
      "definition_sha256": "d45a2e16e91160e9013caa34634cf097252c38975f46cdbfdb078cdb3b92c4ee",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_owner_drive_assignments()",
      "definition_sha256": "b1aa85b9bc6cf8eeceee0e56fac62ac8b38bbe54bfe71c99198c91ecbbdfb727",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_owner_subscription_clinics()",
      "definition_sha256": "38a69ae990f6857d1044d4f1c19d62fc8f79735cea03678b2deb310444860bd9",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.list_patient_identity_links(uuid)",
      "definition_sha256": "d3174db75d67e0c14396ef4341e021aeb3f0682ccb44e1aa4e9e2a5250a4b064",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.next_clinic_counter(uuid,text)",
      "definition_sha256": "eb6bf66d343550f87d57e5ad00e77003a9c5b803dfe42d430e91f75bf07cea21",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.next_encounter_number()",
      "definition_sha256": "cea8393e7fdaab845384162dca83b20492db322bed0cae137a0e266f1c1ba759",
      "language": "sql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.open_production_order(uuid,uuid,numeric)",
      "definition_sha256": "47ca069e7dd640bc40d5d13fc003c6cc871920c2b7bb3ad42088f1121198ad32",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.prepare_line_subscription_off_exception(uuid,text)",
      "definition_sha256": "884bf117469778758071ca342b7c3f2961e1df6ac168508d251c7fd2183f0e67",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.prescription_dispensing_healthcheck()",
      "definition_sha256": "587860faed2102126ffcf0b216360a5f677cdac63e0e0797cd814bdff4e34e3f",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.prevent_encounter_clinical_evidence_delete()",
      "definition_sha256": "154e8b7bb9854038b1fe5ae380068e8db5c3d0312cf78901d74067cf49218a44",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog",
      "target_config": "search_path=pg_catalog, pg_temp"
    },
    {
      "signature": "public.prevent_locked_clinical_record_mutation()",
      "definition_sha256": "a6f62827adf2f84dfc276486dbf739c0153169c439b81529e65d53dceef88f4a",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.production_execution_healthcheck()",
      "definition_sha256": "b5d3a1eff022832aa7f73fbbd16c184f7a862a3303a61f0242683b110417eca6",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.quality_reject_production_order(uuid,text,text)",
      "definition_sha256": "42a081bc606f8c5a152419883a992ca0e59d00889f509269439a7a9250835795",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.quality_release_healthcheck()",
      "definition_sha256": "73aae20bbfe0409456d8c7e4159d95fe6344ecbd142eadc71e255471ef983297",
      "language": "sql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)",
      "definition_sha256": "9928612e8fd6d0eb9e4826d949a3ee0555826d719ec198ae7d4b2baaea8aaaf8",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.queue_line_oa_appointment_notification(uuid,text,timestamp with time zone,timestamp with time zone,text)",
      "definition_sha256": "ae90813414105465c21ae7724516353c18583db5b8cef7e8c0f50791030c88eb",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)",
      "definition_sha256": "a275d1b76a8d8c1a5f4daaeb63bd540fefeb4698980cf85596b3ab512fc49aa4",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamp with time zone,boolean,text)",
      "definition_sha256": "23822c7b6e587c96327d8d2a9e9e6cebebafd8a1fadf28f28f21d1b0ea39ec60",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.reject_append_only_mutation()",
      "definition_sha256": "bffca1e61d0bec38d281c43f0528fa725f676e5eedad23eab71fd8f17fae727a",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog",
      "target_config": "search_path=pg_catalog, pg_temp"
    },
    {
      "signature": "public.reject_production_order(uuid,text,text)",
      "definition_sha256": "9ccb6698d4036d68b51f2af3cb13076ccb1d2bec7232166143e7fb39cca229b0",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)",
      "definition_sha256": "90a897f0d8905ca920121e9bd83252b757a2770281a758022ba11bf93c2a1314",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.remove_pharmacy_counter_sale_item(uuid)",
      "definition_sha256": "b91bdb1201f6092189641b0fd5b99c5b54bb8e30848f6615ef7c43f6f07ecd27",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.resolve_patient_qr(text,text)",
      "definition_sha256": "48eca81fe57f1f2041df782adcf4236145a597dee5129702bb489ae6c8b73a17",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.revoke_patient_identity_link(uuid,text)",
      "definition_sha256": "3c6284b586eca6d5f09f037eb8e8acfd8377a0a79d77de48ad9c27538567b220",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.rls_auto_enable()",
      "definition_sha256": "dd9ce3fd3905d621611cf0ea2e7591bada6d61f827445cfa2afe27e69b03f271",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog",
      "target_config": "search_path=pg_catalog, pg_temp"
    },
    {
      "signature": "public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)",
      "definition_sha256": "871f9a31641eb28357cd7658f59b5f0cbc7d702fc136c67c7b7041f6f5d188f2",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.search_clinical_outcomes(text,timestamp with time zone,timestamp with time zone,integer,integer)",
      "definition_sha256": "1d701e49145783cbc322ec3f80191bf5232ecd860dd83b273b42ef35f211acbe",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.search_patients_for_checkin(text)",
      "definition_sha256": "4af79fbd21160aa996e1edbaf1be301063e91749205499f782e7c7cf3129381c",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_clinic_appointment_status(uuid,text,text)",
      "definition_sha256": "4870b24d26048221d21fe9b913c5901087536292bf2f8908400f5563444b46f1",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)",
      "definition_sha256": "cd743045f148b3378634cf37c0c32af8b710c6a8dd4b9c1cf504f791b6bfe2dc",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)",
      "definition_sha256": "9118067e7fb6f9910f3a35bdc8a6d96099ef07a1645296f0414bef804bb5aa15",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)",
      "definition_sha256": "524d36a62970d0d206b989ea88ba460a6fefad97748f66b40a16d5721af68ddb",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)",
      "definition_sha256": "a80d55156f2fb8840ebe2c59022d74e2dd8f04e481fc97049cd3c0eae3e13faa",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.set_product_master_active(uuid,boolean,text)",
      "definition_sha256": "a53cc5920ed2324061ede51435b368a68cec0155f336b082b0fe51099c88bc80",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.sign_clinical_record_complete(uuid,text,text,text)",
      "definition_sha256": "2aa5a3561990fe15247bbbc7f0465aa44cfe7d907e877231020901f6455ae944",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.stage_production_import(text,text,text,jsonb)",
      "definition_sha256": "642d8ac10680ea1e5f5522581d62f7eae23adf9b005db088de84bb50348e1ca6",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)",
      "definition_sha256": "eac6b36e30aa52e7bba8b0800d4090cad4f77f2958e39b56536eb32007dbd945",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.super_admin_set_system_role(uuid,text,text)",
      "definition_sha256": "ef0cd287c152e4415a18aecdf687c8d41fc2d1242c96e4e0e367a5eb51222c79",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)",
      "definition_sha256": "74a460a32eaf2f2292f9a29d2389518b0578dc77416c5694b1bf4488d2ea1589",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.transition_pharmacy_counter_sale(uuid,text,text)",
      "definition_sha256": "923c3bea994a9961350c81ca849fc3a7f69333f71ca6a8730eb57e279a88f31b",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.unlock_clinical_record_for_amendment(uuid,text)",
      "definition_sha256": "7b1b79b30a0b8c30387e8fcac5ad5f35d9286caf54a036627256c8d87ad6a217",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text)",
      "definition_sha256": "dfd36c5cb99686f9dba8d1e9b0130df8ae2281c811b89d2b1eb9761f29d845ba",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text)",
      "definition_sha256": "26edaf3df1af58e2a8e61a4a686960543ccad9f1c676244abf6085863c162276",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)",
      "definition_sha256": "9b536c908d927d186896728205ba6869b7ac69ed13d68000e59888435e9666dd",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text)",
      "definition_sha256": "912b20f6a55b086149414db366bd76e47fd841944a4e8508ecf0af6157c891c4",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text)",
      "definition_sha256": "d6e572dc7cae1bb459f203692378af00f36bf2e58011700e0bcaaabc333f165f",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.upsert_supplier_master(uuid,text,text,text,text,text,text)",
      "definition_sha256": "d6a6d501b3ff7fde29980762dfcbdd4a992f694f0df7618255ee24333a1b5419",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.verify_clinic_restore_trace(uuid)",
      "definition_sha256": "6616dbcb8a2d4bcb12d0ca11f48734bfd1a776d9dc11307d49421e00b61c157e",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.verify_clinic_restore_trace_v20260828(uuid)",
      "definition_sha256": "b1dfd252fc0511d68c0c3f97bdf5b588a2e19552c65a5b0d35c551a80fb226f2",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.verify_clinic_restore_trace_v20260829(uuid)",
      "definition_sha256": "f440d457ad92e996ff3d224cc0fe2fc67106b55c526b0072a3bf6a28fd817a11",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.verify_clinic_restore_trace_v20260831(uuid)",
      "definition_sha256": "d996bfdf0f637a17b535b998da22ef47b38072b20b3d8f381ac59a1c8d8efe8f",
      "language": "plpgsql",
      "pre_config": "search_path=pg_catalog, public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    },
    {
      "signature": "public.withdraw_line_oa_on_identity_revoke()",
      "definition_sha256": "3b70cc939ba094a8b2d8b49a3dbb8a1cb686c71c332c7ddfe8dcfbbe413032bc",
      "language": "plpgsql",
      "pre_config": "search_path=public",
      "target_config": "search_path=pg_catalog, public, pg_temp"
    }
  ]
  $cnyos_reviewed_path_plan$::jsonb;
  v_all text[];
  v_authenticated text[];
  v_service text[];
  v_owner_only text[];
  v_actual text[];
  v_expected text[];
  v_creator text;
  v_path record;
  v_missing text;
  v_expected_relation_oids oid[];
  v_locked_relation_oids oid[];
  v_system_identifier text;
  v_trigger_count bigint;
  v_event_trigger_count bigint;
  v_trigger_stable_bytes bigint;
  v_event_trigger_stable_bytes bigint;
  v_routine_definition_stable_bytes bigint;
  v_trigger_stable_sha256 text;
  v_event_trigger_stable_sha256 text;
  v_routine_definition_stable_sha256 text;
  v_trigger_bindings_before jsonb;
  v_trigger_bindings_after jsonb;
  v_event_bindings_before jsonb;
  v_event_bindings_after jsonb;
  v_routine_semantics_before jsonb;
  v_routine_semantics_after jsonb;
  v_untouched_configs_before jsonb;
  v_untouched_configs_after jsonb;
  v_supabase_admin_defaults_before jsonb;
  v_supabase_admin_defaults_after jsonb;
begin
  -- Prove the static statement above succeeded as an exact closed set before
  -- any substantive precondition establishes this repeatable-read snapshot.
  -- Filtering expected objects to ordinary tables makes a missing, renamed,
  -- replaced, partitioned, or non-table reviewed relation fail closed.
  select pg_catalog.array_agg(relation.oid order by relation.oid)
  into v_expected_relation_oids
  from pg_catalog.unnest(v_trigger_relations) reviewed(relation_name)
  join pg_catalog.pg_class relation
    on relation.oid=pg_catalog.to_regclass(reviewed.relation_name)
  where relation.relkind='r';

  select pg_catalog.array_agg(held.relation order by held.relation)
  into v_locked_relation_oids
  from (
    select distinct lock_row.relation
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype='relation'
      and lock_row.pid=pg_catalog.pg_backend_pid()
      and lock_row.database=(
        select database.oid
        from pg_catalog.pg_database database
        where database.datname=pg_catalog.current_database()
      )
      and lock_row.mode='ShareLock'
      and lock_row.granted
      and lock_row.relation is not null
  ) held;
  if coalesce(
       pg_catalog.cardinality(v_expected_relation_oids),0
     )<>91
     or coalesce(
       pg_catalog.cardinality(v_locked_relation_oids),0
     )<>91
     or v_locked_relation_oids is distinct from v_expected_relation_oids then
    raise exception
      'CNYOS_COMPLETE_ACL_TRIGGER_RELATION_LOCK_SET_INVALID: expected=%, held=%',
      coalesce(
        pg_catalog.cardinality(v_expected_relation_oids),0
      ),
      coalesce(
        pg_catalog.cardinality(v_locked_relation_oids),0
      );
  end if;

  if current_setting('transaction_read_only') <> 'off'
     or current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'CNYOS_COMPLETE_ACL_TRANSACTION_GUARANTEE_INVALID';
  end if;
  if current_database() <> 'postgres'
     or session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception 'CNYOS_COMPLETE_ACL_DATABASE_IDENTITY_INVALID';
  end if;
  if current_setting('server_version_num')::integer / 10000 <> 17
     or current_setting('server_encoding') <> 'UTF8' then
    raise exception 'CNYOS_COMPLETE_ACL_SERVER_PROFILE_INVALID';
  end if;
  if coalesce(current_setting('cnyos.complete_acl_target_project_ref',true),'') <>
       'hsmnjwxurlmsizndjlun'
     or coalesce(current_setting('cnyos.complete_acl_target_environment',true),'') <>
       'staging' then
    raise exception 'CNYOS_COMPLETE_ACL_TARGET_MARKERS_INVALID';
  end if;
  select system_identifier::text into v_system_identifier
  from pg_catalog.pg_control_system();
  if v_system_identifier <> '7666007964130682852' then
    raise exception 'CNYOS_COMPLETE_ACL_SYSTEM_IDENTIFIER_INVALID: %',
      v_system_identifier;
  end if;

  v_authenticated := v_authenticated_only || v_authenticated_and_service;
  v_service := v_authenticated_and_service || v_service_only;
  v_owner_only := v_owner_only_ordinary || v_owner_only_trigger ||
    v_owner_only_event_trigger;
  v_all := v_authenticated_only || v_authenticated_and_service ||
    v_service_only || v_owner_only;

  if cardinality(v_authenticated_only) <> 23
     or cardinality(v_authenticated_and_service) <> 47
     or cardinality(v_service_only) <> 28
     or cardinality(v_owner_only_ordinary) <> 25
     or cardinality(v_owner_only_trigger) <> 23
     or cardinality(v_owner_only_event_trigger) <> 1
     or cardinality(v_authenticated) <> 70
     or cardinality(v_service) <> 75
     or cardinality(v_owner_only) <> 49
     or cardinality(v_all) <> 147
     or (select count(distinct signature) from unnest(v_all) item(signature)) <> 147 then
    raise exception 'CNYOS_COMPLETE_ACL_DISPOSITION_CARDINALITY_INVALID';
  end if;

  select array_agg(signature order by signature collate "C") into v_actual
  from (
    select namespace.nspname || '.' || procedure.proname || '(' ||
      pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')' signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
  ) actual;
  select array_agg(signature order by signature collate "C") into v_expected
  from unnest(v_all) item(signature);
  if v_actual is distinct from v_expected then
    raise exception 'CNYOS_COMPLETE_ACL_PUBLIC_ROUTINE_SET_INVALID';
  end if;

  -- Bind every classified routine to its observer-v2 definition, including
  -- the six non-SECURITY-DEFINER routines that are absent from the path plan.
  -- This stable aggregate was derived from all 147 review rows in
  -- public_routines.all.semantic (observer payload SHA-256
  -- bb9d4c6ce985507814d2cc271e436bd9768eeba6332facabbcc3f11a37e783fa).
  -- It hashes [version, exact signature, SHA-256(pg_get_functiondef)] rows,
  -- C-sorted with a terminal LF, under the observer's pinned deparse GUCs.
  with stable_rows as (
    select stable.stable_row
    from unnest(v_all) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    cross join lateral (
      select string_agg(
        case when component.value is null then 'N'
          else 'V' || pg_catalog.encode(pg_catalog.convert_to(
            component.value,'UTF8'
          ),'hex') end,
        ':' order by component.ordinality
      ) stable_row
      from pg_catalog.unnest(array[
        'cnyos-public-routine-definition-stable/v1',
        item.signature,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
        )),'hex')
      ]::text[]) with ordinality component(value,ordinality)
    ) stable
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(
        stable_row,E'\n' order by stable_row collate "C"
      ),'') || case when count(*)=0 then '' else E'\n' end payload
    from stable_rows
  )
  select octet_length(metric.payload)::bigint,
    encode(sha256(convert_to(metric.payload,'UTF8')),'hex')
  into v_routine_definition_stable_bytes,
    v_routine_definition_stable_sha256
  from metric;
  if v_routine_definition_stable_bytes<>48546
     or v_routine_definition_stable_sha256<>
       'b5e54fb23207a99e8ebb8367b32f7d4ef7eeb53b6f5d3e29ea7c543497ba55d2' then
    raise exception
      'CNYOS_COMPLETE_ACL_ROUTINE_DEFINITION_STABLE_DIGEST_INVALID: bytes=%, sha256=%',
      v_routine_definition_stable_bytes,
      v_routine_definition_stable_sha256;
  end if;

  select string_agg(item.signature, ', ' order by item.signature collate "C")
  into v_missing
  from unnest(v_all) item(signature)
  left join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature)
  left join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
  where owner_role.rolname is distinct from 'postgres'
     or exists (
       select 1 from pg_catalog.pg_depend dependency
       where dependency.classid='pg_catalog.pg_proc'::pg_catalog.regclass
         and dependency.objid=procedure.oid
         and dependency.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass
         and dependency.deptype='e'
     );
  if v_missing is not null then
    raise exception 'CNYOS_COMPLETE_ACL_OWNER_OR_EXTENSION_CLASSIFICATION_INVALID: %',
      v_missing;
  end if;

  if exists (
    select 1 from unnest(v_owner_only_trigger) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    where procedure.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
  ) or exists (
    select 1 from unnest(v_owner_only_event_trigger) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    where procedure.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
  ) or exists (
    select 1 from unnest(v_owner_only_ordinary) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    where procedure.prorettype in (
      'pg_catalog.trigger'::pg_catalog.regtype,
      'pg_catalog.event_trigger'::pg_catalog.regtype
    )
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_HANDLER_CLASSIFICATION_INVALID';
  end if;

  select array_agg(relation_name order by relation_name collate "C")
  into v_actual
  from (
    select distinct relation_namespace.nspname || '.' || relation.relname
      relation_name
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid=relation.relnamespace
    where not trigger_row.tgisinternal
  ) bound_relation;
  if v_actual is distinct from v_trigger_relations then
    raise exception 'CNYOS_COMPLETE_ACL_TRIGGER_RELATION_SET_INVALID';
  end if;

  select count(*)::bigint,
    jsonb_agg(jsonb_build_array(
      trigger_row.oid::text,
      to_jsonb(trigger_row),
      relation_namespace.nspname,
      relation.relname,
      relation.relpersistence::text,
      function_namespace.nspname || '.' || procedure.proname || '(' ||
        pg_catalog.replace(
          pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
        ) || ')'
    ) order by trigger_row.oid)
  into v_trigger_count,v_trigger_bindings_before
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
  join pg_catalog.pg_namespace relation_namespace
    on relation_namespace.oid=relation.relnamespace
  join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
  join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid=procedure.pronamespace
  where not trigger_row.tgisinternal;
  if v_trigger_count <> 173
     or exists (
       select 1
       from pg_catalog.pg_trigger trigger_row
       join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
       join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
       where not trigger_row.tgisinternal
         and (trigger_row.tgenabled <> 'O'
           or relation.relpersistence='t'
           or namespace.nspname like 'pg_temp\_%' escape '\')
     ) then
    raise exception 'CNYOS_COMPLETE_ACL_TRIGGER_BINDING_BASELINE_INVALID';
  end if;
  select count(*)::bigint,
    jsonb_agg(to_jsonb(event_row) order by event_row.oid)
  into v_event_trigger_count,v_event_bindings_before
  from pg_catalog.pg_event_trigger event_row;
  if v_event_trigger_count <> 7
     or exists (
       select 1 from pg_catalog.pg_event_trigger event_row
       where event_row.evtenabled <> 'O'
     ) then
    raise exception 'CNYOS_COMPLETE_ACL_EVENT_TRIGGER_BINDING_BASELINE_INVALID';
  end if;

  -- Recompute stable, OID-independent semantic digests from the same catalog
  -- fields represented by the observer. These bind relation/event identity,
  -- trigger definition and condition, handler identity/owner/language/security
  -- mode/path/body hash/raw ACL, arguments, transition tables, constraints,
  -- referenced relations, indexes, parents, enabled state and event tags.
  -- The observer's complete canonical dataset digests were:
  -- trigger 2f5ffa09ed5a895733d4ba6418ae0a69ab190d3a6718bde73e17dc73118fd15d
  -- event   b0ba455cb69e75488c4c50229a387e4859c201581921c96737a313961ba6c799
  with stable_rows as (
    select stable.stable_row
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid=relation.relnamespace
    join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
    join pg_catalog.pg_roles function_owner on function_owner.oid=procedure.proowner
    join pg_catalog.pg_language language on language.oid=procedure.prolang
    left join pg_catalog.pg_constraint constraint_row
      on constraint_row.oid=trigger_row.tgconstraint
    left join pg_catalog.pg_namespace constraint_namespace
      on constraint_namespace.oid=constraint_row.connamespace
    left join pg_catalog.pg_class referenced_relation
      on referenced_relation.oid=trigger_row.tgconstrrelid
    left join pg_catalog.pg_namespace referenced_namespace
      on referenced_namespace.oid=referenced_relation.relnamespace
    left join pg_catalog.pg_class index_relation
      on index_relation.oid=trigger_row.tgconstrindid
    left join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid=index_relation.relnamespace
    left join pg_catalog.pg_trigger parent_trigger
      on parent_trigger.oid=trigger_row.tgparentid
    left join pg_catalog.pg_class parent_relation
      on parent_relation.oid=parent_trigger.tgrelid
    left join pg_catalog.pg_namespace parent_namespace
      on parent_namespace.oid=parent_relation.relnamespace
    cross join lateral (
      select string_agg(
        case when component.value is null then 'N'
          else 'V' || pg_catalog.encode(pg_catalog.convert_to(
            component.value,'UTF8'
          ),'hex') end,
        ':' order by component.ordinality
      ) stable_row
      from pg_catalog.unnest(array[
        'cnyos-trigger-binding-stable/v1',
        relation_namespace.nspname,
        relation.relname,
        relation.relkind::text,
        relation.relpersistence::text,
        trigger_row.tgname,
        procedure.oid::pg_catalog.regprocedure::text,
        pg_catalog.pg_get_triggerdef(trigger_row.oid,false),
        trigger_row.tgenabled::text,
        trigger_row.tgtype::text,
        trigger_row.tgnargs::text,
        pg_catalog.encode(trigger_row.tgargs,'hex'),
        trigger_row.tgdeferrable::text,
        trigger_row.tginitdeferred::text,
        trigger_row.tgqual::text,
        trigger_row.tgoldtable,
        trigger_row.tgnewtable,
        constraint_namespace.nspname,
        constraint_row.conname,
        referenced_namespace.nspname,
        referenced_relation.relname,
        index_namespace.nspname,
        index_relation.relname,
        parent_namespace.nspname,
        parent_relation.relname,
        parent_trigger.tgname,
        function_owner.rolname,
        language.lanname,
        procedure.prosecdef::text,
        procedure.prokind::text,
        procedure.provolatile::text,
        procedure.proleakproof::text,
        procedure.proisstrict::text,
        procedure.proparallel::text,
        procedure.proretset::text,
        pg_catalog.array_to_string(procedure.proconfig,E'\x1e'),
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
        )),'hex'),
        procedure.proacl::text,
        pg_catalog.pg_get_function_result(procedure.oid)
      ]::text[]) with ordinality component(value,ordinality)
    ) stable
    where not trigger_row.tgisinternal
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(
        stable_row,E'\n' order by stable_row collate "C"
      ),'') || case when count(*)=0 then '' else E'\n' end payload
    from stable_rows
  )
  select octet_length(metric.payload)::bigint,
    encode(sha256(convert_to(metric.payload,'UTF8')),'hex')
  into v_trigger_stable_bytes,v_trigger_stable_sha256
  from metric;
  if v_trigger_stable_bytes<>198158
     or v_trigger_stable_sha256<>
       'aa777a86a6ade0616080eb5b41680f2d4dadc0e4a686acc71459d80bd380fea6' then
    raise exception
      'CNYOS_COMPLETE_ACL_TRIGGER_BINDING_STABLE_DIGEST_INVALID: bytes=%, sha256=%',
      v_trigger_stable_bytes,v_trigger_stable_sha256;
  end if;

  with stable_rows as (
    select stable.stable_row
    from pg_catalog.pg_event_trigger event_row
    join pg_catalog.pg_roles event_owner on event_owner.oid=event_row.evtowner
    join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
    join pg_catalog.pg_roles function_owner on function_owner.oid=procedure.proowner
    join pg_catalog.pg_language language on language.oid=procedure.prolang
    cross join lateral (
      select string_agg(
        case when component.value is null then 'N'
          else 'V' || pg_catalog.encode(pg_catalog.convert_to(
            component.value,'UTF8'
          ),'hex') end,
        ':' order by component.ordinality
      ) stable_row
      from pg_catalog.unnest(array[
        'cnyos-event-trigger-binding-stable/v1',
        event_row.evtname,
        event_row.evtevent,
        event_owner.rolname,
        procedure.oid::pg_catalog.regprocedure::text,
        event_row.evtenabled::text,
        (select string_agg(tag.value,E'\x1e' order by tag.value collate "C")
         from pg_catalog.unnest(event_row.evttags) tag(value)),
        function_owner.rolname,
        language.lanname,
        procedure.prosecdef::text,
        procedure.prokind::text,
        procedure.provolatile::text,
        procedure.proleakproof::text,
        procedure.proisstrict::text,
        procedure.proparallel::text,
        procedure.proretset::text,
        pg_catalog.array_to_string(procedure.proconfig,E'\x1e'),
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
        )),'hex'),
        procedure.proacl::text,
        pg_catalog.pg_get_function_result(procedure.oid)
      ]::text[]) with ordinality component(value,ordinality)
    ) stable
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(
        stable_row,E'\n' order by stable_row collate "C"
      ),'') || case when count(*)=0 then '' else E'\n' end payload
    from stable_rows
  )
  select octet_length(metric.payload)::bigint,
    encode(sha256(convert_to(metric.payload,'UTF8')),'hex')
  into v_event_trigger_stable_bytes,v_event_trigger_stable_sha256
  from metric;
  if v_event_trigger_stable_bytes<>5122
     or v_event_trigger_stable_sha256<>
       'cbabdf241e6d6634759fd20c94ef98c4f939458397532671c1e38265b51ddddf' then
    raise exception
      'CNYOS_COMPLETE_ACL_EVENT_TRIGGER_STABLE_DIGEST_INVALID: bytes=%, sha256=%',
      v_event_trigger_stable_bytes,v_event_trigger_stable_sha256;
  end if;

  select array_agg(signature order by signature collate "C") into v_actual
  from (
    select distinct function_namespace.nspname || '.' || procedure.proname ||
      '(' || pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')' signature
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where not trigger_row.tgisinternal and function_namespace.nspname='public'
  ) bound;
  select array_agg(signature order by signature collate "C") into v_expected
  from unnest(v_owner_only_trigger) item(signature);
  if v_actual is distinct from v_expected then
    raise exception 'CNYOS_COMPLETE_ACL_PUBLIC_TRIGGER_HANDLER_SET_INVALID';
  end if;
  select array_agg(signature order by signature collate "C") into v_actual
  from (
    select distinct function_namespace.nspname || '.' || procedure.proname ||
      '(' || pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')' signature
    from pg_catalog.pg_event_trigger event_row
    join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where function_namespace.nspname='public'
  ) bound;
  if v_actual is distinct from v_owner_only_event_trigger then
    raise exception 'CNYOS_COMPLETE_ACL_PUBLIC_EVENT_HANDLER_SET_INVALID';
  end if;

  -- Current live raw grants are owner-issued, non-grantable EXECUTE grants to
  -- only these four identities. Anything else is new drift and blocks.
  if exists (
    select 1
    from unnest(v_all) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    cross join lateral pg_catalog.aclexplode(coalesce(
      procedure.proacl,
      pg_catalog.acldefault('f',procedure.proowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee<>0 and grantee_role.oid=acl.grantee
    where acl.grantee<>procedure.proowner
      and (acl.privilege_type<>'EXECUTE'
        or acl.is_grantable
        or acl.grantor<>procedure.proowner
        or coalesce(grantee_role.rolname,'PUBLIC') not in
          ('PUBLIC','anon','authenticated','service_role'))
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_UNEXPECTED_PREEXISTING_RAW_GRANT';
  end if;

  -- The proposal never expands runtime access. Every allowlisted routine must
  -- already be executable by its intended role before normalization.
  select string_agg(signature, ', ' order by signature collate "C") into v_missing
  from unnest(v_authenticated) item(signature)
  where not pg_catalog.has_function_privilege(
    'authenticated',pg_catalog.to_regprocedure(signature),'EXECUTE'
  );
  if v_missing is not null then
    raise exception 'CNYOS_COMPLETE_ACL_AUTHENTICATED_ALLOWLIST_WOULD_EXPAND: %',
      v_missing;
  end if;
  select string_agg(signature, ', ' order by signature collate "C") into v_missing
  from unnest(v_service) item(signature)
  where not pg_catalog.has_function_privilege(
    'service_role',pg_catalog.to_regprocedure(signature),'EXECUTE'
  );
  if v_missing is not null then
    raise exception 'CNYOS_COMPLETE_ACL_SERVICE_ALLOWLIST_WOULD_EXPAND: %',
      v_missing;
  end if;

  -- Exact effective creators are evidence-bound. pg_database_owner is a
  -- predefined virtual role whose implicit membership follows database
  -- ownership and is mutable here only when PostgreSQL reports SET authority.
  -- supabase_admin is a hosted-platform internal superuser, is not a Data API
  -- runtime role, and is deliberately not mutated by this candidate.
  if exists (
    select 1 from unnest(v_mutable_default_creators) item(role_name)
    left join pg_catalog.pg_roles role_row on role_row.rolname=item.role_name
    where role_row.oid is null
       or not pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE')
       or (item.role_name<>session_user
         and not pg_catalog.pg_has_role(session_user,role_row.oid,'SET'))
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_DEFAULT_CREATOR_AUTHORITY_INVALID';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles role_row
    where role_row.rolname='supabase_admin'
      and role_row.rolcanlogin and role_row.rolsuper
  )
  or exists (
    select 1
    from (values ('anon'),('authenticated'),('service_role'),('authenticator'))
      runtime_role(role_name)
    where pg_catalog.has_schema_privilege(
        runtime_role.role_name,'public','CREATE'
      )
      or pg_catalog.pg_has_role(
        runtime_role.role_name,'supabase_admin','SET'
      )
  )
  or exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner
    where namespace.nspname='public' and owner_role.rolname='supabase_admin'
  )
  or exists (
    select 1
    from pg_catalog.pg_type type_row
    join pg_catalog.pg_namespace namespace on namespace.oid=type_row.typnamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid=type_row.typowner
    where namespace.nspname='public' and owner_role.rolname='supabase_admin'
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_HOSTED_MANAGED_EXCEPTION_BASELINE_INVALID';
  end if;
  if (select datdba from pg_catalog.pg_database
      where datname=current_database()) <>
       (select oid from pg_catalog.pg_roles where rolname='postgres')
     or (select nspowner from pg_catalog.pg_namespace where nspname='public') <>
       (select oid from pg_catalog.pg_roles where rolname='pg_database_owner') then
    raise exception 'CNYOS_COMPLETE_ACL_MANAGED_OWNERSHIP_BASELINE_INVALID';
  end if;

  -- Closed-world CREATE authority matters because 138 reviewed paths retain
  -- public ahead of pg_temp. The fresh staging enumeration, pinned to the same
  -- system identifier above, contains exactly these three effective creators.
  -- Any additional role or PUBLIC CREATE grant is a blocking shadowing risk.
  select array_agg(role_row.rolname order by role_row.rolname collate "C")
  into v_actual
  from pg_catalog.pg_roles role_row
  where pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE');
  if v_actual is distinct from v_observed_default_creators
     or exists (
       select 1
       from pg_catalog.pg_namespace namespace
       cross join lateral pg_catalog.aclexplode(coalesce(
         namespace.nspacl,
         pg_catalog.acldefault('n',namespace.nspowner)
       )) acl
       where namespace.nspname='public'
         and acl.grantee=0 and acl.privilege_type='CREATE'
     )
     or exists (
       select 1 from (values
         ('pg_database_owner',false,false),
         ('postgres',true,false),
         ('supabase_admin',true,true)
       ) expected(role_name,can_login,is_super)
       left join pg_catalog.pg_roles role_row
         on role_row.rolname=expected.role_name
       where role_row.oid is null
          or role_row.rolcanlogin is distinct from expected.can_login
          or role_row.rolsuper is distinct from expected.is_super
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_PUBLIC_CREATE_CLOSED_WORLD_INVALID';
  end if;

  -- Effective CREATE alone misses roles that can SET through a non-inheriting
  -- membership path. Treat every LOGIN role plus the runtime identities as
  -- untrusted unless it is already one of the three reviewed creator roles,
  -- and fail closed on direct or transitive SET reachability to any creator.
  if exists (
    select 1
    from pg_catalog.pg_roles candidate_role
    cross join unnest(v_observed_default_creators) creator_name(role_name)
    join pg_catalog.pg_roles creator_role
      on creator_role.rolname=creator_name.role_name
    where (candidate_role.rolcanlogin
        or candidate_role.rolname in
          ('anon','authenticated','service_role','authenticator'))
      and candidate_role.rolname not in ('postgres','supabase_admin')
      and pg_catalog.pg_has_role(
        candidate_role.oid,creator_role.oid,'SET'
      )
  ) then
    raise exception
      'CNYOS_COMPLETE_ACL_UNTRUSTED_CREATOR_SET_REACHABILITY_INVALID';
  end if;

  -- A later direct read-only check after the dashboard toggle observed that
  -- postgres/public was already narrowed to its owner, while the platform-owned
  -- supabase_admin/public row still granted postgres plus all three runtime
  -- roles. None of the three creators had a global function-default row, so
  -- PostgreSQL's hard-wired PUBLIC EXECUTE default still applied. Bind that
  -- exact transition state. This check is not a substitute for the live-v2
  -- evidence pins above, and it grants no authority.
  -- Restricted post-toggle evidence: captured 2026-09-07T21:12:57.689224Z,
  -- SHA-256 1be7efa81a459ad950b1dba8602eb6e0d76c4f6f4185ba616c91fa52e3fe144a,
  -- same system identifier 7666007964130682852.
  if exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    where creator.rolname=any(v_observed_default_creators)
      and defaults.defaclobjtype='f'
      and defaults.defaclnamespace=0
  )
  or (select count(*)
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
      join pg_catalog.pg_namespace namespace
        on namespace.oid=defaults.defaclnamespace
      where creator.rolname=any(v_observed_default_creators)
        and defaults.defaclobjtype='f'
        and namespace.nspname='public') <> 2
  or exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    join pg_catalog.pg_namespace namespace
      on namespace.oid=defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid=acl.grantor
    where creator.rolname=any(v_observed_default_creators)
      and defaults.defaclobjtype='f'
      and namespace.nspname='public'
      and (acl.privilege_type<>'EXECUTE' or acl.is_grantable
        or grantor.rolname<>creator.rolname
        or not exists (
          select 1 from (values
            ('postgres','postgres'),
            ('supabase_admin','postgres'),
            ('supabase_admin','anon'),
            ('supabase_admin','authenticated'),
            ('supabase_admin','service_role')
          ) expected(creator_name,grantee_name)
          where expected.creator_name=creator.rolname
            and expected.grantee_name=grantee.rolname
        ))
  )
  or exists (
    select 1 from (values
      ('postgres','postgres'),
      ('supabase_admin','postgres'),
      ('supabase_admin','anon'),
      ('supabase_admin','authenticated'),
      ('supabase_admin','service_role')
    ) expected(creator_name,grantee_name)
    where not exists (
      select 1
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
      join pg_catalog.pg_namespace namespace
        on namespace.oid=defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
      join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
      join pg_catalog.pg_roles grantor on grantor.oid=acl.grantor
      where creator.rolname=expected.creator_name
        and grantee.rolname=expected.grantee_name
        and grantor.rolname=expected.creator_name
        and defaults.defaclobjtype='f'
        and namespace.nspname='public'
        and acl.privilege_type='EXECUTE'
        and not acl.is_grantable
    )
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_MANAGED_DEFAULT_BASELINE_INVALID';
  end if;

  select coalesce(jsonb_agg(to_jsonb(defaults) order by defaults.oid),'[]'::jsonb)
  into v_supabase_admin_defaults_before
  from pg_catalog.pg_default_acl defaults
  join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
  where creator.rolname='supabase_admin'
    and defaults.defaclobjtype='f'
    and (defaults.defaclnamespace=0
      or defaults.defaclnamespace=(
        select oid from pg_catalog.pg_namespace where nspname='public'
      ));

  -- Freeze every non-ACL/non-search-path pg_proc field. Path rows below also
  -- bind the exact pre-change function definitions observed in live-v2.
  select jsonb_agg(jsonb_build_array(
    item.signature,to_jsonb(procedure)-'proacl'-'proconfig'
  ) order by item.signature collate "C")
  into v_routine_semantics_before
  from unnest(v_all) item(signature)
  join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature);

  select array_agg(signature order by signature collate "C") into v_actual
  from (
    select namespace.nspname || '.' || procedure.proname || '(' ||
      pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')' signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public' and procedure.prosecdef
  ) security_definer;
  select array_agg(plan.signature order by plan.signature collate "C")
  into v_expected
  from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan)
    as plan(signature text);
  if pg_catalog.jsonb_array_length(v_reviewed_path_plan)<>141
     or (select count(distinct plan.signature)
         from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan)
           as plan(signature text))<>141
     or v_actual is distinct from v_expected then
    raise exception 'CNYOS_COMPLETE_ACL_SECURITY_DEFINER_PATH_SET_INVALID';
  end if;

  for v_path in
    select *
    from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan) as reviewed(
      signature text,
      definition_sha256 text,
      language text,
      pre_config text,
      target_config text
    )
  loop
    if not exists (
      select 1 from pg_catalog.pg_proc procedure
      join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
      join pg_catalog.pg_language language on language.oid=procedure.prolang
      where procedure.oid=pg_catalog.to_regprocedure(v_path.signature)
        and owner_role.rolname='postgres'
        and language.lanname=v_path.language
        and procedure.prosecdef
        and procedure.proconfig=array[v_path.pre_config]::text[]
        and v_path.language in ('plpgsql','sql')
        and v_path.target_config in (
          'search_path=pg_catalog, public, pg_temp',
          'search_path=pg_catalog, pg_temp'
        )
        and pg_catalog.right(v_path.target_config,7)='pg_temp'
        and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
        )),'hex')=v_path.definition_sha256
    ) then
      raise exception 'CNYOS_COMPLETE_ACL_REVIEWED_PATH_PRECONDITION_INVALID: %',
        v_path.signature;
    end if;
  end loop;

  select jsonb_agg(jsonb_build_array(
    item.signature,to_jsonb(procedure.proconfig)
  ) order by item.signature collate "C")
  into v_untouched_configs_before
  from unnest(v_all) item(signature)
  join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature)
  where not exists (
    select 1
    from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan)
      as plan(signature text)
    where plan.signature=item.signature
  );

  -- CNYOS_COMPLETE_ACL_MUTATION_BEGIN
  -- The unconditional blockers above make every statement below unreachable in
  -- this revision. This is reviewable proposed behavior, not run authorization.
  -- Each ACL statement resolves and locks its complete object list as one
  -- command. In particular, the first command covers all 147 routines before
  -- any path change is attempted; failures roll back the entire transaction.
  execute pg_catalog.format(
    'revoke all privileges on function %s from public, anon, authenticated, service_role',
    pg_catalog.array_to_string(v_all,', ')
  );
  execute pg_catalog.format(
    'grant execute on function %s to authenticated',
    pg_catalog.array_to_string(v_authenticated,', ')
  );
  execute pg_catalog.format(
    'grant execute on function %s to service_role',
    pg_catalog.array_to_string(v_service,', ')
  );

  -- Global revocation overrides PostgreSQL's hard-wired PUBLIC EXECUTE default.
  -- The schema-local revocation then removes the existing runtime-role additions.
  -- No mutable creator is touched unless the pre-mutation SET-role checks
  -- succeeded for both postgres and pg_database_owner. Any failure aborts this
  -- transaction atomically. supabase_admin remains byte-for-byte unchanged and
  -- the explicit release blocker above prevents describing that exception as
  -- complete creator closure without a separate reviewed acceptance decision.
  foreach v_creator in array v_mutable_default_creators loop
    execute pg_catalog.format(
      'alter default privileges for role %I revoke execute on functions from public, anon, authenticated, service_role',
      v_creator
    );
    execute pg_catalog.format(
      'alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated, service_role',
      v_creator
    );
  end loop;

  for v_path in
    select *
    from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan) as reviewed(
      signature text,target_config text
    )
  loop
    execute pg_catalog.format(
      'alter function %s set search_path to %s',
      v_path.signature,
      pg_catalog.substr(v_path.target_config,13)
    );
  end loop;
  -- CNYOS_COMPLETE_ACL_MUTATION_END

  select array_agg(signature order by signature collate "C") into v_actual
  from unnest(v_all) item(signature)
  where pg_catalog.has_function_privilege(
    'anon',pg_catalog.to_regprocedure(signature),'EXECUTE'
  );
  if coalesce(v_actual,array[]::text[]) <> array[]::text[] then
    raise exception 'CNYOS_COMPLETE_ACL_ANON_EXECUTE_REMAINS: %',v_actual;
  end if;

  select array_agg(signature order by signature collate "C") into v_actual
  from unnest(v_all) item(signature)
  where pg_catalog.has_function_privilege(
    'authenticated',pg_catalog.to_regprocedure(signature),'EXECUTE'
  );
  select array_agg(signature order by signature collate "C") into v_expected
  from unnest(v_authenticated) item(signature);
  if v_actual is distinct from v_expected then
    raise exception 'CNYOS_COMPLETE_ACL_AUTHENTICATED_EXECUTE_SET_INVALID';
  end if;
  select array_agg(signature order by signature collate "C") into v_actual
  from unnest(v_all) item(signature)
  where pg_catalog.has_function_privilege(
    'service_role',pg_catalog.to_regprocedure(signature),'EXECUTE'
  );
  select array_agg(signature order by signature collate "C") into v_expected
  from unnest(v_service) item(signature);
  if v_actual is distinct from v_expected then
    raise exception 'CNYOS_COMPLETE_ACL_SERVICE_EXECUTE_SET_INVALID';
  end if;

  -- Exactly 145 owner-issued, non-grantable non-owner ACL tuples remain:
  -- authenticated=70 and service_role=75. All 49 owner-only routines have none.
  if (select count(*)
      from unnest(v_all) item(signature)
      join pg_catalog.pg_proc procedure
        on procedure.oid=pg_catalog.to_regprocedure(item.signature)
      cross join lateral pg_catalog.aclexplode(coalesce(
        procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
      )) acl
      where acl.grantee<>procedure.proowner) <> 145
     or exists (
       select 1
       from unnest(v_all) item(signature)
       join pg_catalog.pg_proc procedure
         on procedure.oid=pg_catalog.to_regprocedure(item.signature)
       cross join lateral pg_catalog.aclexplode(coalesce(
         procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
       )) acl
       left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
       where acl.grantee<>procedure.proowner
         and (acl.privilege_type<>'EXECUTE' or acl.is_grantable
           or acl.grantor<>procedure.proowner
           or (grantee.rolname='authenticated' and not item.signature=any(v_authenticated))
           or (grantee.rolname='service_role' and not item.signature=any(v_service))
           or grantee.rolname not in ('authenticated','service_role')
           or grantee.rolname is null)
     )
     or exists (
       select 1
       from unnest(v_owner_only) item(signature)
       join pg_catalog.pg_proc procedure
         on procedure.oid=pg_catalog.to_regprocedure(item.signature)
       cross join lateral pg_catalog.aclexplode(coalesce(
         procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
       )) acl
       where acl.grantee<>procedure.proowner
     ) then
    raise exception 'CNYOS_COMPLETE_ACL_RAW_POSTCONDITION_INVALID';
  end if;

  -- All creator-global defaults must now explicitly suppress PUBLIC EXECUTE.
  -- Public-schema contribution rows may remain for trusted postgres grants but
  -- cannot contribute PUBLIC or any Data API runtime role.
  if exists (
    select 1 from unnest(v_mutable_default_creators) item(role_name)
    join pg_catalog.pg_roles creator on creator.rolname=item.role_name
    left join pg_catalog.pg_default_acl defaults
      on defaults.defaclrole=creator.oid
     and defaults.defaclnamespace=0
     and defaults.defaclobjtype='f'
    where defaults.oid is null or exists (
      select 1 from pg_catalog.aclexplode(defaults.defaclacl) acl
      left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
      where acl.grantee=0
         or grantee.rolname in ('anon','authenticated','service_role')
    )
  ) or exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    join pg_catalog.pg_namespace namespace
      on namespace.oid=defaults.defaclnamespace and namespace.nspname='public'
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
    where creator.rolname=any(v_mutable_default_creators)
      and defaults.defaclobjtype='f'
      and (acl.grantee=0
        or grantee.rolname in ('anon','authenticated','service_role'))
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_DEFAULT_ACL_POSTCONDITION_INVALID';
  end if;
  select coalesce(jsonb_agg(to_jsonb(defaults) order by defaults.oid),'[]'::jsonb)
  into v_supabase_admin_defaults_after
  from pg_catalog.pg_default_acl defaults
  join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
  where creator.rolname='supabase_admin'
    and defaults.defaclobjtype='f'
    and (defaults.defaclnamespace=0
      or defaults.defaclnamespace=(
        select oid from pg_catalog.pg_namespace where nspname='public'
      ));
  if v_supabase_admin_defaults_after is distinct from
       v_supabase_admin_defaults_before then
    raise exception 'CNYOS_COMPLETE_ACL_SUPABASE_ADMIN_DEFAULT_CHANGED';
  end if;

  for v_path in
    select *
    from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan) as reviewed(
      signature text,target_config text
    )
  loop
    if (select procedure.proconfig
        from pg_catalog.pg_proc procedure
        where procedure.oid=pg_catalog.to_regprocedure(v_path.signature))
       is distinct from array[v_path.target_config]::text[] then
      raise exception 'CNYOS_COMPLETE_ACL_REVIEWED_PATH_POSTCONDITION_INVALID: %',
        v_path.signature;
    end if;
  end loop;

  select jsonb_agg(jsonb_build_array(
    item.signature,to_jsonb(procedure)-'proacl'-'proconfig'
  ) order by item.signature collate "C")
  into v_routine_semantics_after
  from unnest(v_all) item(signature)
  join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature);
  if v_routine_semantics_after is distinct from v_routine_semantics_before then
    raise exception 'CNYOS_COMPLETE_ACL_ROUTINE_SEMANTICS_CHANGED';
  end if;
  select jsonb_agg(jsonb_build_array(
    item.signature,to_jsonb(procedure.proconfig)
  ) order by item.signature collate "C")
  into v_untouched_configs_after
  from unnest(v_all) item(signature)
  join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature)
  where not exists (
    select 1
    from pg_catalog.jsonb_to_recordset(v_reviewed_path_plan)
      as plan(signature text)
    where plan.signature=item.signature
  );
  if v_untouched_configs_after is distinct from v_untouched_configs_before then
    raise exception 'CNYOS_COMPLETE_ACL_UNREVIEWED_SEARCH_PATH_CHANGED';
  end if;

  select jsonb_agg(jsonb_build_array(
    trigger_row.oid::text,
    to_jsonb(trigger_row),
    relation_namespace.nspname,
    relation.relname,
    relation.relpersistence::text,
    function_namespace.nspname || '.' || procedure.proname || '(' ||
      pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')'
  ) order by trigger_row.oid)
  into v_trigger_bindings_after
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
  join pg_catalog.pg_namespace relation_namespace
    on relation_namespace.oid=relation.relnamespace
  join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
  join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid=procedure.pronamespace
  where not trigger_row.tgisinternal;
  select jsonb_agg(to_jsonb(event_row) order by event_row.oid)
  into v_event_bindings_after
  from pg_catalog.pg_event_trigger event_row;
  if v_trigger_bindings_after is distinct from v_trigger_bindings_before
     or v_event_bindings_after is distinct from v_event_bindings_before
     or (select count(*) from pg_catalog.pg_trigger where not tgisinternal) <> 173
     or (select count(*) from pg_catalog.pg_event_trigger) <> 7 then
    raise exception 'CNYOS_COMPLETE_ACL_BINDINGS_CHANGED';
  end if;

  -- Deliberately no success-shaped output. A zero-exit transcript and an
  -- independent post-commit observer would still be required after every gate
  -- is separately reviewed and removed in a future candidate.
exception
  when others then
    perform pg_catalog.pg_advisory_unlock(202608302100::bigint);
    raise;
end
$cnyos_complete_acl_candidate$;

commit;

do $cnyos_complete_acl_interlock$
begin
  if not pg_catalog.pg_advisory_unlock(202608302100::bigint) then
    raise exception 'CNYOS_COMPLETE_ACL_ADVISORY_INTERLOCK_RELEASE_FAILED';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype = 'advisory'
      and lock_row.pid = pg_catalog.pg_backend_pid()
      and lock_row.granted
      and lock_row.classid::bigint = (202608302100::bigint >> 32)
      and lock_row.objid::bigint =
          (202608302100::bigint & 4294967295::bigint)
      and lock_row.objsubid = 1
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_ADVISORY_INTERLOCK_RELEASE_FAILED';
  end if;
end
$cnyos_complete_acl_interlock$;
