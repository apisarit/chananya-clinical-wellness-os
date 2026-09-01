import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const migrationName = /^(\d{12,14})_([a-z0-9_]+)\.sql$/i;
const immutableMigrationHashes = new Map([
  [
    '202608311800_owner_subscription_control.sql',
    'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
  ]
]);

const requiredRelations = [
  'public.profiles',
  'public.audit_logs',
  'public.patients',
  'public.products',
  'public.inventory_lots',
  'public.encounters',
  'public.payments',
  'public.production_orders',
  'public.pharmacy_counter_sales',
  'public.approval_tasks',
  'public.clinical_examination_findings',
  'public.clinic_appointments',
  'public.sen_line_master',
  'public.ttm_diagnostic_knowledge',
  'public.ttm_opd_histories',
  'public.clinical_record_audit_events',
  'public.ttm_sources',
  'public.clinics',
  'public.clinic_memberships',
  'public.patient_user_links',
  'public.practitioner_schedules',
  'public.appointment_events',
  'public.patient_identity_links',
  'public.backup_export_runs',
  'public.approval_actions',
  'public.line_oa_contacts',
  'public.line_oa_notification_preferences',
  'public.line_oa_webhook_events',
  'public.line_oa_notification_outbox',
  'public.line_oa_delivery_events',
  'public.line_oa_gateway_contact_states',
  'public.line_oa_gateway_webhook_events',
  'public.clinic_subscription_control_events',
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events',
  'public.owner_control_historical_replay_guard',
  'public.user_access_summary',
  'public.admin_task_summary',
  'public.v_clinical_herbal_traceability',
  'public.available_practitioner_schedules',
  'public.v_ttm_foundation_graph'
];

const requiredFunctions = [
  'has_role',
  'dispense_pharmacy_counter_sale',
  'current_access_context',
  'save_ttm_diagnosis_atomic',
  'create_clinical_treatment_session',
  'sign_clinical_record_complete',
  'unlock_clinical_record_for_amendment',
  'hybrid_patient_identity_healthcheck',
  'clinical_financial_handoffs_healthcheck',
  'department_persistence_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'clinical_outcomes_summary',
  'prescription_dispensing_healthcheck',
  'backup_restore_contract_healthcheck',
  'export_clinic_backup_domain',
  'export_clinic_backup_domain_v20260831',
  'export_clinic_backup_domain_v20260829',
  'export_clinic_backup_domain_v20260828',
  'verify_clinic_restore_trace',
  'verify_clinic_restore_trace_v20260831',
  'verify_clinic_restore_trace_v20260829',
  'verify_clinic_restore_trace_v20260828',
  'begin_backup_export_run',
  'get_exact_backup_restore_source',
  'line_oa_operational_healthcheck',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence',
  'list_owner_subscription_clinics',
  'set_clinic_subscription_state',
  'set_clinic_subscription_state_v20260901',
  'guard_owner_subscription_forward_only',
  'reject_append_only_mutation',
  'assert_clinic_subscription_active',
  'prepare_line_subscription_off_exception',
  'enforce_active_subscription_tenant_write',
  'enforce_authenticated_subscription_statement_write',
  'is_clinic_admin',
  'is_reception_or_admin',
  'is_practitioner',
  'is_appointment_operator',
  'is_appointment_practitioner',
  'book_clinic_appointment',
  'cancel_clinic_appointment',
  'set_clinic_appointment_status',
  'is_admin_or_super',
  'current_user_role',
  'create_approval_task',
  'decide_approval_task',
  'consume_patient_identity_rate_limit_for_clinic',
  'complete_patient_line_link_for_clinic',
  'list_line_linked_patients_for_clinic',
  'issue_patient_qr_for_subject_in_clinic',
  'queue_line_oa_appointment_notification',
  'set_line_oa_notification_preference_for_subject',
  'complete_patient_line_link_with_oa_consent',
  'list_line_oa_notification_preferences_for_subject',
  'claim_line_oa_webhook_event',
  'finish_line_oa_webhook_event',
  'claim_line_oa_notification_batch',
  'finish_line_oa_notification',
  'register_line_oa_webhook_event_for_clinic',
  'line_oa_queue_notification_v20260829',
  'line_oa_set_preference_v20260829',
  'line_oa_complete_link_consent_v20260829',
  'line_oa_list_preferences_v20260829',
  'line_oa_claim_webhook_v20260829',
  'line_oa_finish_webhook_v20260829',
  'line_oa_claim_batch_v20260829',
  'line_oa_finish_notification_v20260829',
  'line_oa_register_gateway_v20260829',
  'list_owner_drive_assignments',
  'get_clinic_drive_backup_destination',
  'set_clinic_drive_assignment'
];

const requiredSecurityDefiners = [
  'save_ttm_diagnosis_atomic',
  'backup_restore_contract_healthcheck',
  'export_clinic_backup_domain',
  'export_clinic_backup_domain_v20260831',
  'export_clinic_backup_domain_v20260829',
  'export_clinic_backup_domain_v20260828',
  'verify_clinic_restore_trace',
  'verify_clinic_restore_trace_v20260831',
  'verify_clinic_restore_trace_v20260829',
  'verify_clinic_restore_trace_v20260828',
  'begin_backup_export_run',
  'get_exact_backup_restore_source',
  'line_oa_operational_healthcheck',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence',
  'list_owner_subscription_clinics',
  'set_clinic_subscription_state',
  'set_clinic_subscription_state_v20260901',
  'guard_owner_subscription_forward_only',
  'reject_append_only_mutation',
  'assert_clinic_subscription_active',
  'prepare_line_subscription_off_exception',
  'enforce_active_subscription_tenant_write',
  'enforce_authenticated_subscription_statement_write',
  'is_clinic_admin',
  'is_reception_or_admin',
  'is_practitioner',
  'is_appointment_operator',
  'is_appointment_practitioner',
  'book_clinic_appointment',
  'cancel_clinic_appointment',
  'set_clinic_appointment_status',
  'is_admin_or_super',
  'current_user_role',
  'create_approval_task',
  'decide_approval_task',
  'sign_clinical_record_complete',
  'unlock_clinical_record_for_amendment',
  'clinical_financial_handoffs_healthcheck',
  'department_persistence_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'prescription_dispensing_healthcheck',
  'consume_patient_identity_rate_limit_for_clinic',
  'complete_patient_line_link_for_clinic',
  'list_line_linked_patients_for_clinic',
  'issue_patient_qr_for_subject_in_clinic',
  'queue_line_oa_appointment_notification',
  'set_line_oa_notification_preference_for_subject',
  'complete_patient_line_link_with_oa_consent',
  'list_line_oa_notification_preferences_for_subject',
  'claim_line_oa_webhook_event',
  'finish_line_oa_webhook_event',
  'claim_line_oa_notification_batch',
  'finish_line_oa_notification',
  'register_line_oa_webhook_event_for_clinic',
  'line_oa_queue_notification_v20260829',
  'line_oa_set_preference_v20260829',
  'line_oa_complete_link_consent_v20260829',
  'line_oa_list_preferences_v20260829',
  'line_oa_claim_webhook_v20260829',
  'line_oa_finish_webhook_v20260829',
  'line_oa_claim_batch_v20260829',
  'line_oa_finish_notification_v20260829',
  'line_oa_register_gateway_v20260829',
  'list_owner_drive_assignments',
  'get_clinic_drive_backup_destination',
  'set_clinic_drive_assignment'
];

const requiredProcedures = [
  'public.backup_restore_contract_healthcheck()',
  'public.export_clinic_backup_domain(uuid,text)',
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.verify_clinic_restore_trace(uuid)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260828(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)',
  'public.line_oa_operational_healthcheck()',
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.line_oa_webhook_evidence(timestamptz)',
  'public.list_owner_subscription_clinics()',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.guard_owner_subscription_forward_only()',
  'public.reject_append_only_mutation()',
  'public.assert_clinic_subscription_active(uuid)',
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)',
  'public.list_owner_drive_assignments()',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)'
];

const requiredRlsRelations = [
  'public.patient_user_links',
  'public.practitioner_schedules',
  'public.clinic_appointments',
  'public.appointment_events',
  'public.approval_tasks',
  'public.approval_actions',
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events',
  'public.owner_control_historical_replay_guard'
];

const requiredTenantPolicies = [
  [
    'public.practitioner_schedules', 'practitioner_schedules_read', 'r',
    "((clinic_id=current_clinic_id())and((booking_status='open'::text)or(practitioner_id=auth.uid())oris_reception_or_admin()))",
    ''
  ],
  [
    'public.practitioner_schedules', 'practitioner_schedules_manage_own', '*',
    '((clinic_id=current_clinic_id())and((practitioner_id=auth.uid())oris_clinic_admin()))',
    '((clinic_id=current_clinic_id())and((practitioner_id=auth.uid())oris_clinic_admin()))'
  ],
  [
    'public.patient_user_links', 'patient_user_links_own', 'r',
    '((exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id()))))and((user_id=auth.uid())oris_clinic_admin()))',
    ''
  ],
  [
    'public.patient_user_links', 'patient_user_links_manage', '*',
    '(is_clinic_admin()and(exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id())))))',
    '(is_clinic_admin()and(exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id())))))'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_staff_read', 'r',
    '((clinic_id=current_clinic_id())and(is_reception_or_admin()or(practitioner_id=auth.uid())or(exists(select1frompatient_user_linkslwhere((l.patient_id=clinic_appointments.patient_id)and(l.user_id=auth.uid())andl.active)))))',
    ''
  ],
  [
    'public.appointment_events', 'appointment_events_read', 'r',
    '((clinic_id=current_clinic_id())and(is_clinic_admin()or(exists(select1fromclinic_appointmentsawhere((a.id=appointment_events.appointment_id)and(a.clinic_id=appointment_events.clinic_id)and(a.practitioner_id=auth.uid()))))))',
    ''
  ],
  [
    'public.approval_tasks', 'approval_tasks_read_participant', 'r',
    '((clinic_id=current_clinic_id())and(is_admin_or_super()or(requested_by=auth.uid())or(assigned_to=auth.uid())))',
    ''
  ],
  [
    'public.approval_actions', 'approval_actions_read_participant', 'r',
    '((clinic_id=current_clinic_id())and(is_admin_or_super()or(exists(select1fromapproval_taskstwhere((t.id=approval_actions.task_id)and(t.clinic_id=approval_actions.clinic_id)and((t.requested_by=auth.uid())or(t.assigned_to=auth.uid())))))))',
    ''
  ]
];

const requiredForceRlsRelations = [
  'public.owner_control_historical_replay_guard'
];

const ownerDriveClosedRelations = [
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events'
];

const ownerReplayGuardClosedRelations = [
  'public.owner_control_historical_replay_guard'
];

const requiredAppendOnlyTriggers = [
  [
    'public.appointment_events',
    'trg_appointment_events_append_only'
  ],
  [
    'public.approval_actions',
    'trg_approval_actions_append_only'
  ],
  [
    'public.clinic_drive_destination_events',
    'trg_clinic_drive_destination_events_append_only'
  ],
  [
    'public.clinic_subscription_control_events',
    'trg_clinic_subscription_control_events_append_only'
  ]
];

const ownerDriveServiceRoleOnlyProcedures = [
  'public.list_owner_drive_assignments()',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)'
];

const ownerSubscriptionServiceRoleOnlyProcedures = [
  'public.list_owner_subscription_clinics()',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)'
];

const ownerSubscriptionClosedProcedures = [
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.guard_owner_subscription_forward_only()'
];

const appendOnlyClosedProcedures = [
  'public.reject_append_only_mutation()'
];

const backupRestoreServiceRoleOnlyProcedures = [
  'public.export_clinic_backup_domain(uuid,text)',
  'public.verify_clinic_restore_trace(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)'
];

const backupArchiveClosedProcedures = [
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260828(uuid)'
];

const lineGatewayServiceRoleOnlyProcedures = [
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.line_oa_webhook_evidence(timestamptz)'
];

const lineGatewayExactBodyContracts = [
  [
    'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
    `begin if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if; if p_provider_channel_hash !~ '^[0-9a-f]{64}$' or p_event_id_hash !~ '^[0-9a-f]{64}$' or p_processing_status not in ('processed', 'ignored', 'failed') or p_reply_status not in ('sent', 'not_applicable', 'failed') or ( p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{2,80}$' ) then raise exception 'line_oa_finalization_invalid'; end if; update public.line_oa_gateway_webhook_events set processing_status = p_processing_status, reply_status = p_reply_status, error_code = p_error_code, processed_at = pg_catalog.now() where provider_channel_hash = p_provider_channel_hash and event_id_hash = p_event_id_hash and processing_status = 'processing'; return found; end;`
  ],
  [
    'public.line_oa_webhook_evidence(timestamptz)',
    `begin if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if; return query select pg_catalog.count(*)::bigint, pg_catalog.count(*) filter ( where e.processing_status in ('processed', 'ignored') )::bigint, pg_catalog.count(*) filter ( where e.processing_status = 'failed' )::bigint, pg_catalog.count(*) filter ( where e.reply_status = 'sent' )::bigint, pg_catalog.max(e.created_at) from public.line_oa_gateway_webhook_events e where e.created_at >= greatest( coalesce(p_since, pg_catalog.now() - interval '1 hour'), pg_catalog.now() - interval '7 days' ); end;`
  ]
];

const lineOperationalHealthcheckProcedure = 'public.line_oa_operational_healthcheck()';
const lineOperationalHealthcheckExactBody = `select true, (select count(*) from public.line_oa_contacts c where c.clinic_id=public.current_clinic_id()), (select count(*) from public.line_oa_notification_preferences p where p.clinic_id=public.current_clinic_id() and p.operational_enabled), (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status in ('pending','retry','sending')), (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status='dead') where auth.role()='service_role' or public.is_super_admin();`;

const lineArchiveClosedProcedures = [
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)'
];

const archiveClosedProcedures = [
  ...backupArchiveClosedProcedures,
  ...lineArchiveClosedProcedures
];

const archiveOwnerPairs = [
  ['public.export_clinic_backup_domain_v20260831(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.export_clinic_backup_domain_v20260829(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.export_clinic_backup_domain_v20260828(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.verify_clinic_restore_trace_v20260831(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.verify_clinic_restore_trace_v20260829(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.verify_clinic_restore_trace_v20260828(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)', 'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)'],
  ['public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)', 'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'],
  ['public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)', 'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)'],
  ['public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)', 'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)'],
  ['public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)', 'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)'],
  ['public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)', 'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)'],
  ['public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)', 'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)'],
  ['public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)', 'public.finish_line_oa_notification(uuid,text,text,integer,text,text)'],
  ['public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)', 'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)']
];

const subscriptionKillSwitchServiceRoleOnlyProcedures = [
  'public.assert_clinic_subscription_active(uuid)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)'
];

const exactServiceRoleOnlyProcedures = [...new Set([
  ...ownerDriveServiceRoleOnlyProcedures,
  ...ownerSubscriptionServiceRoleOnlyProcedures,
  ...backupRestoreServiceRoleOnlyProcedures,
  ...lineGatewayServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchServiceRoleOnlyProcedures
])];

const subscriptionKillSwitchAuthenticatedAndServiceProcedures = [
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.clinical_financial_handoffs_healthcheck()',
  'public.department_persistence_healthcheck()',
  'public.production_execution_healthcheck()',
  'public.quality_release_healthcheck()',
  'public.prescription_dispensing_healthcheck()'
];

const subscriptionKillSwitchAuthenticatedOnlyProcedures = [
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)'
];

const subscriptionKillSwitchBrowserProcedures = [
  ...subscriptionKillSwitchAuthenticatedAndServiceProcedures,
  ...subscriptionKillSwitchAuthenticatedOnlyProcedures
];

const subscriptionKillSwitchBrowserProcedureGrants = [
  ...subscriptionKillSwitchBrowserProcedures.map(procedureSignature => [
    procedureSignature,
    'authenticated'
  ]),
  ...subscriptionKillSwitchAuthenticatedAndServiceProcedures.map(procedureSignature => [
    procedureSignature,
    'service_role'
  ])
];

// Exact callable SECURITY DEFINER inventory for the reviewed 45-migration
// chain. Trigger/event-trigger functions are intentionally excluded because
// PostgreSQL cannot invoke them as ordinary RPCs and nine historical trigger
// functions retain their default PUBLIC catalog ACL.
const callableSecurityDefinerAuthenticatedOnlyProcedures = [
  'public.admin_assign_staff_role(uuid,text,text)',
  'public.admin_set_staff_membership_active(uuid,boolean,text)',
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.clinical_outcomes_summary(timestamptz,timestamptz)',
  'public.confirm_patient_qr(uuid,boolean,text,jsonb)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.current_access_context()',
  'public.decide_approval_task(uuid,text,text)',
  'public.hybrid_patient_identity_healthcheck()',
  'public.issue_patient_line_link_code(uuid,text,text,boolean)',
  'public.list_patient_identity_links(uuid)',
  'public.resolve_patient_qr(text,text)',
  'public.revoke_patient_identity_link(uuid,text)',
  'public.search_clinical_outcomes(text,timestamptz,timestamptz,integer,integer)',
  'public.search_patients_for_checkin(text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)',
  'public.super_admin_set_system_role(uuid,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)',
  'public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text)'
];

const callableSecurityDefinerServiceRoleOnlyProcedures = [
  'public.assert_clinic_subscription_active(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.complete_backup_export_run(uuid,text,jsonb,jsonb,text)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.export_clinic_backup_domain(uuid,text)',
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.line_oa_webhook_evidence(timestamptz)',
  'public.list_backup_export_clinics()',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.list_owner_drive_assignments()',
  'public.list_owner_subscription_clinics()',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)',
  'public.reject_production_order(uuid,text,text)',
  'public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.verify_clinic_restore_trace(uuid)'
];

const callableSecurityDefinerAuthenticatedAndServiceProcedures = [
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
  'public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text)',
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
];

const callableSecurityDefinerOwnerOnlyProcedures = [
  'public.apply_initial_encounter_intake(uuid,jsonb)',
  'public.complete_patient_line_link(text,text,text,boolean)',
  'public.consume_patient_identity_rate_limit(text,integer,integer)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.list_line_linked_patients(text)',
  'public.next_clinic_counter(uuid,text)',
  'public.next_encounter_number()',
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.verify_clinic_restore_trace_v20260828(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
];

const callableSecurityDefinerProcedures = [...new Set([
  ...callableSecurityDefinerAuthenticatedOnlyProcedures,
  ...callableSecurityDefinerServiceRoleOnlyProcedures,
  ...callableSecurityDefinerAuthenticatedAndServiceProcedures,
  ...callableSecurityDefinerOwnerOnlyProcedures
])];

const callableSecurityDefinerProcedureGrants = [
  ...callableSecurityDefinerAuthenticatedOnlyProcedures.map(procedureSignature => [
    procedureSignature,
    'authenticated'
  ]),
  ...callableSecurityDefinerServiceRoleOnlyProcedures.map(procedureSignature => [
    procedureSignature,
    'service_role'
  ]),
  ...callableSecurityDefinerAuthenticatedAndServiceProcedures.flatMap(procedureSignature => [
    [procedureSignature, 'authenticated'],
    [procedureSignature, 'service_role']
  ])
];

const authenticatedCrudRelations = [
  'public.body_pain_points',
  'public.clinical_examination_findings',
  'public.clinical_followup_notes',
  'public.clinical_treatment_plans',
  'public.clinical_treatment_sessions',
  'public.ttm_concept_terms',
  'public.ttm_diagnostic_contexts',
  'public.ttm_encounter_concepts',
  'public.ttm_opd_histories',
  'public.ttm_structured_diagnoses'
];

const authenticatedCrudServiceControlPlaneRelations = [
  'public.ttm_concept_relations',
  'public.ttm_concepts',
  'public.ttm_sources'
];

const authenticatedCrudServiceReadMaintainRelations = [
  'public.appointments',
  'public.barthel_assessments',
  'public.followups',
  'public.intermediate_care_assessments',
  'public.pain_assessments',
  'public.pain_markers',
  'public.price_list_items',
  'public.price_lists',
  'public.services',
  'public.treatment_orders',
  'public.treatment_sessions',
  'public.vital_signs'
];

const authenticatedReadOnlyRelations = [
  'public.admin_task_summary',
  'public.appointment_events',
  'public.approval_actions',
  'public.approval_tasks',
  'public.available_practitioner_schedules',
  'public.clinic_appointments',
  'public.clinic_specialties',
  'public.clinical_record_audit_events',
  'public.clinics',
  'public.encounter_identity_verifications',
  'public.finished_goods_receipts',
  'public.formula_components',
  'public.formulas',
  'public.import_batches',
  'public.import_rows',
  'public.patient_identity_events',
  'public.patient_user_links',
  'public.pharmacy_counter_allocations',
  'public.pharmacy_counter_sale_items',
  'public.pharmacy_counter_sales',
  'public.practitioner_schedules',
  'public.practitioner_specialties',
  'public.production_material_issues',
  'public.production_orders',
  'public.production_qc',
  'public.production_requests',
  'public.user_access_summary',
  'public.v_clinical_herbal_traceability',
  'public.v_ttm_foundation_coverage',
  'public.v_ttm_foundation_graph'
];

const authenticatedReadServiceReadMaintainRelations = [
  'public.backup_export_runs',
  'public.dispensing_items',
  'public.dispensing_orders',
  'public.encounters',
  'public.invoice_items',
  'public.invoices',
  'public.patient_allergies',
  'public.patients',
  'public.payments',
  'public.prescription_items',
  'public.prescriptions',
  'public.products',
  'public.stock_movements',
  'public.suppliers'
];

const exactPublicRelationAclGrants = [
  ...authenticatedCrudRelations.flatMap(relationName =>
    ['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege])
  ),
  ...authenticatedCrudServiceControlPlaneRelations.flatMap(relationName => [
    ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege]),
    ...['INSERT','SELECT','UPDATE'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ...authenticatedCrudServiceReadMaintainRelations.flatMap(relationName => [
    ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege]),
    ...['MAINTAIN','SELECT'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [
    'public.sen_line_master','authenticated',privilege
  ]),
  ['public.sen_line_master','service_role','SELECT'],
  ...['INSERT','SELECT','UPDATE'].map(privilege => [
    'public.clinical_record_signoffs','authenticated',privilege
  ]),
  ...authenticatedReadOnlyRelations.map(relationName => [
    relationName,'authenticated','SELECT'
  ]),
  ['public.inventory_lots','authenticated','SELECT'],
  ...['INSERT','MAINTAIN','SELECT'].map(privilege => [
    'public.inventory_lots','service_role',privilege
  ]),
  ['public.audit_logs','authenticated','SELECT'],
  ...['INSERT','SELECT'].map(privilege => ['public.audit_logs','service_role',privilege]),
  ...['public.clinic_memberships','public.profiles','public.ttm_diagnostic_knowledge'].flatMap(
    relationName => [
      [relationName,'authenticated','SELECT'],
      ...['INSERT','SELECT','UPDATE'].map(privilege => [relationName,'service_role',privilege])
    ]
  ),
  ...authenticatedReadServiceReadMaintainRelations.flatMap(relationName => [
    [relationName,'authenticated','SELECT'],
    ...['MAINTAIN','SELECT'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ['public.clinic_subscription_control_events','service_role','SELECT'],
  ['public.patient_qr_sessions','service_role','SELECT'],
  ['public.patient_qr_sessions','service_role','UPDATE']
];

const exactPublicSequenceAclGrants = [
  ['public.audit_logs_id_seq','authenticated','SELECT'],
  ['public.audit_logs_id_seq','authenticated','USAGE'],
  ['public.audit_logs_id_seq','service_role','USAGE']
];

const publicViewRelations = new Set([
  'public.admin_task_summary',
  'public.available_practitioner_schedules',
  'public.user_access_summary',
  'public.v_clinical_herbal_traceability',
  'public.v_ttm_foundation_coverage',
  'public.v_ttm_foundation_graph'
]);

const exactPublicRelationAndSequenceAclTuples = [
  ...exactPublicRelationAclGrants.map(([relationName,grantee,privilege]) => [
    relationName,
    publicViewRelations.has(relationName) ? 'v' : 'r',
    grantee,
    privilege
  ]),
  ...exactPublicSequenceAclGrants.map(([relationName,grantee,privilege]) => [
    relationName,
    'S',
    grantee,
    privilege
  ])
];

const expectedRuntimeRoleSecurityAttributes = [
  // role, superuser, create-role, create-db, login, replication, bypass-RLS
  ['anon',false,false,false,false,false,false],
  ['authenticated',false,false,false,false,false,false],
  ['service_role',false,false,false,false,false,true],
  ['authenticator',false,false,false,true,false,false]
];

const runtimeJwtRoles = ['anon','authenticated','service_role'];

const exactPublicSchemaAclGrants = [
  ['PUBLIC','USAGE'],
  ['authenticated','USAGE'],
  ['service_role','USAGE']
];

if (callableSecurityDefinerProcedures.length !== 122 ||
    callableSecurityDefinerProcedureGrants.length !== 144 ||
    exactPublicRelationAclGrants.length !== 235 ||
    exactPublicSequenceAclGrants.length !== 3 ||
    exactPublicRelationAndSequenceAclTuples.length !== 238) {
  throw new Error('Reviewed public ACL inventory cardinality changed');
}

const subscriptionKillSwitchClosedProcedures = [
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.consume_patient_identity_rate_limit(text,integer,integer)',
  'public.complete_patient_line_link(text,text,text,boolean)',
  'public.list_line_linked_patients(text)',
  'public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)'
];

const sensitiveClosedProcedures = [...new Set([
  ...appendOnlyClosedProcedures,
  ...ownerSubscriptionClosedProcedures,
  ...subscriptionKillSwitchClosedProcedures,
  ...archiveClosedProcedures
])];

const sensitiveOwnedProcedures = [...new Set([
  ...sensitiveClosedProcedures,
  ...exactServiceRoleOnlyProcedures,
  lineOperationalHealthcheckProcedure
])];

const sensitiveClosedRelations = [...new Set([
  ...ownerDriveClosedRelations,
  ...ownerReplayGuardClosedRelations
])];

const subscriptionKillSwitchHardenedProcedures = [...new Set([
  ...subscriptionKillSwitchServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchBrowserProcedures,
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)'
])];

const hardenedSearchPathProcedures = [...new Set([
  ...ownerDriveServiceRoleOnlyProcedures,
  ...backupRestoreServiceRoleOnlyProcedures,
  ...archiveClosedProcedures,
  ...lineGatewayServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchHardenedProcedures,
  'public.backup_restore_contract_healthcheck()',
  ...ownerSubscriptionServiceRoleOnlyProcedures,
  ...ownerSubscriptionClosedProcedures
])];

const activeSubscriptionWriteRelations = [
  'public.clinic_memberships',
  'public.audit_logs',
  'public.inventory_lots',
  'public.practitioner_schedules',
  'public.clinic_appointments',
  'public.appointment_events',
  'public.approval_tasks',
  'public.approval_actions',
  'public.patient_identity_link_requests',
  'public.patient_identity_links',
  'public.patient_qr_sessions',
  'public.patient_identity_events',
  'public.line_oa_contacts',
  'public.line_oa_notification_preferences',
  'public.line_oa_webhook_events',
  'public.line_oa_notification_outbox',
  'public.line_oa_delivery_events'
];

const serviceRoleDmlWithoutSubscriptionGuardAllowlist = [
  'public.profiles',
  'public.ttm_sources',
  'public.ttm_concepts',
  'public.ttm_concept_relations',
  'public.ttm_diagnostic_knowledge'
];

const exactServiceRoleDmlPrivileges = [
  ['public.audit_logs', 'INSERT'],
  ['public.clinic_memberships', 'INSERT'],
  ['public.clinic_memberships', 'UPDATE'],
  ['public.inventory_lots', 'INSERT'],
  ['public.patient_qr_sessions', 'UPDATE'],
  ['public.profiles', 'INSERT'],
  ['public.profiles', 'UPDATE'],
  ['public.ttm_sources', 'INSERT'],
  ['public.ttm_sources', 'UPDATE'],
  ['public.ttm_concepts', 'INSERT'],
  ['public.ttm_concepts', 'UPDATE'],
  ['public.ttm_concept_relations', 'INSERT'],
  ['public.ttm_concept_relations', 'UPDATE'],
  ['public.ttm_diagnostic_knowledge', 'INSERT'],
  ['public.ttm_diagnostic_knowledge', 'UPDATE']
];

const requiredNotNullUuidColumns = [
  'practitioner_schedules.clinic_id',
  'clinic_appointments.clinic_id',
  'appointment_events.clinic_id',
  'approval_tasks.clinic_id',
  'approval_actions.clinic_id'
];

const requiredTenantForeignKeys = [
  [
    'public.practitioner_schedules', 'practitioner_schedules_clinic_id_fkey',
    'public.clinics', 'clinic_id', 'id', 'r'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_schedule_clinic_fkey',
    'public.practitioner_schedules', 'schedule_id,clinic_id', 'id,clinic_id', 'r'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_patient_clinic_fkey',
    'public.patients', 'patient_id,clinic_id', 'id,clinic_id', 'r'
  ],
  [
    'public.appointment_events', 'appointment_events_appointment_clinic_fkey',
    'public.clinic_appointments', 'appointment_id,clinic_id', 'id,clinic_id', 'c'
  ],
  [
    'public.approval_tasks', 'approval_tasks_clinic_id_fkey',
    'public.clinics', 'clinic_id', 'id', 'r'
  ],
  [
    'public.approval_actions', 'approval_actions_task_clinic_fkey',
    'public.approval_tasks', 'task_id,clinic_id', 'id,clinic_id', 'c'
  ]
];

const requiredColumns = [
  'body_pain_points.side',
  'body_pain_points.body_region',
  'body_pain_points.sen_line_code',
  'body_pain_points.point_label',
  'body_pain_points.pain_pattern_code',
  'body_pain_points.updated_at',
  'profiles.system_role',
  'patients.clinic_id',
  'encounters.clinic_id',
  'products.clinic_id',
  'inventory_lots.clinic_id',
  'line_oa_webhook_events.locked_until',
  'line_oa_notification_outbox.next_attempt_at',
  'line_oa_gateway_webhook_events.last_attempt_at',
  'clinics.subscription_state',
  'clinics.subscription_version',
  'clinic_subscription_control_events.expected_version',
  'practitioner_schedules.clinic_id',
  'clinic_appointments.clinic_id',
  'appointment_events.clinic_id',
  'approval_tasks.clinic_id',
  'approval_actions.clinic_id',
  'clinic_drive_backup_destinations.environment',
  'clinic_drive_backup_destinations.patients_folder_id',
  'clinic_drive_backup_destinations.products_folder_id',
  'clinic_drive_backup_destinations.pharmacy_folder_id',
  'clinic_drive_backup_destinations.transactions_folder_id',
  'clinic_drive_backup_destinations.manifests_folder_id',
  'clinic_drive_backup_destinations.version',
  'clinic_drive_destination_events.request_id',
  'clinic_drive_destination_events.assignment_version',
  'clinic_drive_destination_events.previous_assignment',
  'clinic_drive_destination_events.new_assignment',
  'owner_control_historical_replay_guard.protected_migration',
  'owner_control_historical_replay_guard.historical_sha256'
];

const lineOffExceptionCleanupFingerprint = [
  'exception when others then',
  "perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);",
  "perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);",
  'raise;',
  'end;',
  "perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);",
  "perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);"
].join(' ');

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlArray = values => `array[${values.map(quote).join(',')}]::text[]`;
const sqlRows = rows => rows.map(row => `(${row.map(quote).join(',')})`).join(',');

export function loadMigrationEntries(cwd = root) {
  const directory = path.join(cwd, 'supabase', 'migrations');
  const entries = fs.readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => {
      const parsed = file.match(migrationName);
      if (!parsed) throw new Error(`Migration filename is not canonical: ${file}`);
      const source = fs.readFileSync(path.join(directory, file), 'utf8');
      return {
        version: parsed[1],
        name: parsed[2],
        file,
        sha256: createHash('sha256').update(source).digest('hex')
      };
    });
  if (!entries.length) throw new Error('No ordered Supabase migrations were found');
  if (new Set(entries.map(entry => entry.version)).size !== entries.length) {
    throw new Error('Migration versions must be unique');
  }
  return entries;
}

export function buildMigrationLedgerRepairSql({ config, entries = loadMigrationEntries(), sourceRevision = '' }) {
  const target = validateTenantConfig(config);
  if (!stagingMarker.test(target.deploymentId)) {
    throw new Error('Migration ledger recovery is restricted to a staging/non-production deployment');
  }
  if (!/(?:STG|STAGING|TEST|NONPROD)/i.test(target.tenant.expectedClinicCode)) {
    throw new Error('Migration ledger recovery requires an explicit staging clinic code');
  }
  if (!entries.length) throw new Error('Migration ledger recovery requires at least one migration');
  for (const [file, sha256] of immutableMigrationHashes) {
    if (entries.find(entry => entry.file === file)?.sha256 !== sha256) {
      throw new Error(`Immutable historical migration SHA mismatch: ${file}`);
    }
  }

  const expectedRows = entries
    .map(entry => {
      const evidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
      return `(${quote(entry.version)},${quote(entry.name)},${quote(entry.sha256)},${quote(evidence)})`;
    })
    .join(',\n      ');
  const inserts = entries
    .map(entry => {
      const evidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
      return `(${quote(entry.version)},${quote(entry.name)},array[${quote(evidence)}]::text[])`;
    })
    .join(',\n  ');
  const revision = String(sourceRevision || '').trim().toLowerCase();
  if (revision && !/^[0-9a-f]{7,40}$/.test(revision)) {
    throw new Error('Source revision must be a 7-40 character hexadecimal Git revision');
  }

  return `-- Generated one-time staging migration ledger recovery.\n` +
    `-- Target: ${target.deploymentId} / ${target.tenant.expectedClinicCode}.\n` +
    `-- Source revision: ${revision || 'not-supplied'}; migration count: ${entries.length}.\n` +
    `-- Run only after every ordered migration has been applied to the isolated, empty staging database.\n` +
    `begin;\n` +
    `set local search_path = pg_catalog, public;\n` +
    `select pg_advisory_xact_lock(202608302100::bigint);\n` +
    `do $ledger_guard$\n` +
    `declare\n` +
    `  v_missing text;\n` +
    `  v_function_body text;\n` +
    `  v_transactional_rows bigint;\n` +
    `begin\n` +
    `  select string_agg(object_name, ', ' order by object_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredRelations)}) expected(object_name)\n` +
    `  where to_regclass(object_name) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_RELATIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredFunctions)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_FUNCTIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(requiredProcedures)}) expected(procedure_signature)\n` +
    `  where to_regprocedure(procedure_signature) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_PROCEDURES_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(column_ref, ', ' order by column_ref) into v_missing\n` +
    `  from unnest(${sqlArray(requiredColumns)}) expected(column_ref)\n` +
    `  where not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name=split_part(column_ref,'.',1)\n` +
    `      and c.column_name=split_part(column_ref,'.',2)\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_COLUMNS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(column_ref, ', ' order by column_ref) into v_missing\n` +
    `  from unnest(${sqlArray(requiredNotNullUuidColumns)}) expected(column_ref)\n` +
    `  where not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name=split_part(column_ref,'.',1)\n` +
    `      and c.column_name=split_part(column_ref,'.',2)\n` +
    `      and c.data_type='uuid' and c.is_nullable='NO'\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || constraint_name, ', ' order by relation_name,constraint_name) into v_missing\n` +
    `  from (values ${sqlRows(requiredTenantForeignKeys)}) expected(\n` +
    `    relation_name,constraint_name,referenced_relation,local_columns,referenced_columns,delete_action\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1 from pg_constraint c\n` +
    `    where c.conrelid=to_regclass(relation_name)\n` +
    `      and c.conname=constraint_name and c.contype='f' and c.convalidated\n` +
    `      and c.confrelid=to_regclass(referenced_relation)\n` +
    `      and c.confdeltype=delete_action::\"char\"\n` +
    `      and (\n` +
    `        select array_agg(a.attname::text order by key.ordinality)\n` +
    `        from unnest(c.conkey) with ordinality key(attnum,ordinality)\n` +
    `        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum\n` +
    `      )=string_to_array(local_columns,',')\n` +
    `      and (\n` +
    `        select array_agg(a.attname::text order by key.ordinality)\n` +
    `        from unnest(c.confkey) with ordinality key(attnum,ordinality)\n` +
    `        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=key.attnum\n` +
    `      )=string_to_array(referenced_columns,',')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredSecurityDefiners)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name and p.prosecdef\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SECURITY_DEFINERS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(requiredProcedures)}) expected(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    where p.oid=to_regprocedure(procedure_signature) and p.prosecdef\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_EXACT_SECURITY_DEFINERS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredRlsRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2) and c.relrowsecurity\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_RLS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredForceRlsRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2) and c.relforcerowsecurity\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || policy_name, ', ' order by relation_name,policy_name) into v_missing\n` +
    `  from (values ${sqlRows(requiredTenantPolicies)}) expected(\n` +
    `    relation_name,policy_name,policy_command,exact_qual,exact_with_check\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1 from pg_policy p\n` +
    `    where p.polrelid=to_regclass(relation_name)\n` +
    `      and p.polname=policy_name and p.polpermissive\n` +
    `      and p.polcmd=policy_command::\"char\"\n` +
    `      and p.polroles=array[(select oid from pg_roles where rolname='authenticated')]\n` +
    `      and regexp_replace(lower(pg_get_expr(p.polqual,p.polrelid)),'[[:space:]]+','','g')=exact_qual\n` +
    `      and regexp_replace(lower(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')),'[[:space:]]+','','g')=exact_with_check\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by relation_name,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerReplayGuardClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || '.' || a.attname || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by relation_name,a.attname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerReplayGuardClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  if exists (\n` +
    `    select 1 from pg_policies\n` +
    `    where schemaname='public' and tablename='owner_control_historical_replay_guard'\n` +
    `  ) then raise exception 'STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT'; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ' -> ' || grantee || ':' || privilege,\n` +
    `    ', ' order by relation_name,grantee,privilege\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveClosedRelations)}) expected(relation_name)\n` +
    `  cross join unnest(array['anon','authenticated','service_role']::text[]) target(grantee)\n` +
    `  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) action(privilege)\n` +
    `  where has_table_privilege(grantee, relation_name, privilege)\n` +
    `     or case when privilege in ('SELECT','INSERT','UPDATE','REFERENCES')\n` +
    `       then has_any_column_privilege(grantee,relation_name,privilege)\n` +
    `       else false end;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ' -> ' || owner_role.rolname, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  join pg_roles owner_role on owner_role.oid=c.relowner\n` +
    `  where owner_role.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  where c.relowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_RELATION_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(target.grantee, ', ' order by target.grantee) into v_missing\n` +
    `  from unnest(array['anon','authenticated','service_role']::text[]) target(grantee)\n` +
    `  where has_table_privilege(grantee, 'public.clinics', 'UPDATE')\n` +
    `     or has_any_column_privilege(grantee, 'public.clinics', 'UPDATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('pg_catalog.set_config' in v_function_body)=0\n` +
    `     or position('cnyos.owner_subscription_forward_guard' in v_function_body)=0\n` +
    `     or position('service-role-rpc/v1' in v_function_body)=0\n` +
    `     or position('v_result := public.set_clinic_subscription_state_v20260901' in v_function_body)=0\n` +
    `     or position('return v_result' in v_function_body)=0\n` +
    `     or position('exception when others then' in v_function_body)=0\n` +
    `     or (\n` +
    `       length(v_function_body)-length(replace(v_function_body,'cnyos.owner_subscription_forward_guard',''))\n` +
    `     )/length('cnyos.owner_subscription_forward_guard') <> 3 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('pg_catalog.pg_advisory_xact_lock' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('v_existing.expected_version <> p_expected_version' in v_function_body)=0\n` +
    `     or position('subscription_version = p_expected_version' in v_function_body)=0\n` +
    `     or position('insert into public.clinic_subscription_control_events' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_CONCURRENCY_IMPLEMENTATION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.guard_owner_subscription_forward_only()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('pg_catalog.current_setting' in v_function_body)=0\n` +
    `     or position('cnyos.owner_subscription_forward_guard' in v_function_body)=0\n` +
    `     or position('service-role-rpc/v1' in v_function_body)=0\n` +
    `     or position('cnyos_owner_subscription_historical_replay_blocked' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_KILL_SWITCH_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || expected_grantee, ', ' order by procedure_signature,expected_grantee) into v_missing\n` +
    `  from (values ${sqlRows(subscriptionKillSwitchBrowserProcedureGrants)}) expected(procedure_signature,expected_grantee)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected_procedure(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      acl.privilege_type <> 'EXECUTE' or acl.is_grantable or acl.grantor <> p.proowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(subscriptionKillSwitchBrowserProcedureGrants)}) expected_grant(expected_signature,expected_grantee)\n` +
    `        where expected_signature=procedure_signature\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('authenticated', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected(procedure_signature)\n` +
    `  where has_function_privilege('anon', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_ANON_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchClosedProcedures)}) expected(procedure_signature)\n` +
    `  where to_regprocedure(procedure_signature) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_LEGACY_PROCEDURE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(archiveClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(archive_signature || ' -> ' || wrapper_signature, ', ' order by archive_signature) into v_missing\n` +
    `  from (values ${sqlRows(archiveOwnerPairs)}) expected(archive_signature,wrapper_signature)\n` +
    `  join pg_proc archive_proc on archive_proc.oid=to_regprocedure(archive_signature)\n` +
    `  join pg_proc wrapper_proc on wrapper_proc.oid=to_regprocedure(wrapper_signature)\n` +
    `  join pg_roles archive_owner on archive_owner.oid=archive_proc.proowner\n` +
    `  where archive_proc.proowner <> wrapper_proc.proowner\n` +
    `     or archive_owner.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and coalesce(grantee.rolname,'PUBLIC') <> 'service_role';\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || grantee, ', ' order by procedure_signature,grantee) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || owner_role.rolname, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveOwnedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `  where owner_role.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_CLOSED_PROCEDURE_RUNTIME_OWNER: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveOwnedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where p.proowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(hardenedSearchPathProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting(value)\n` +
    `    where replace(lower(setting.value),' ','')='search_path=pg_catalog,public'\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values\n` +
    `    ('public.finalize_line_oa_webhook_event(text,text,text,text,text)','v',false,'bool'),\n` +
    `    ('public.line_oa_webhook_evidence(timestamptz)','s',true,'record')\n` +
    `  ) expected(procedure_signature,expected_volatility,expected_set,expected_result)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(procedure_signature) and p.prosecdef\n` +
    `      and p.provolatile=expected_volatility::\"char\"\n` +
    `      and p.proretset=expected_set and t.typname=expected_result\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_CONTRACT_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values\n` +
    `    ('public.finalize_line_oa_webhook_event(text,text,text,text,text)','update public.line_oa_gateway_webhook_events','processing_status = ''processing'''),\n` +
    `    ('public.line_oa_webhook_evidence(timestamptz)','from public.line_oa_gateway_webhook_events','created_at >= greatest')\n` +
    `  ) expected(procedure_signature,required_token_one,required_token_two)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) source\n` +
    `  ) body\n` +
    `  where position(\n` +
    `    'begin if auth.role() is distinct from ''service_role'' then raise exception ''service_role_required''; end if;'\n` +
    `    in body.source\n` +
    `  ) <> 1\n` +
    `     or position(required_token_one in body.source)=0\n` +
    `     or position(required_token_two in body.source)=0;\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_ROLE_GATE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values ${sqlRows(lineGatewayExactBodyContracts)}) expected(procedure_signature,exact_body)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) source\n` +
    `  ) body\n` +
    `  where body.source <> exact_body;\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    join pg_language l on l.oid=p.prolang\n` +
    `    join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `      and p.prokind='f' and l.lanname='sql' and p.provolatile='s'\n` +
    `      and p.prosecdef and p.proretset and t.typname='record'\n` +
    `      and pg_get_function_result(p.oid)=\n` +
    `        'TABLE(ready boolean, contact_count bigint, consent_count bigint, pending_count bigint, dead_count bigint)'\n` +
    `      and cardinality(coalesce(p.proconfig,array[]::text[]))=1\n` +
    `      and replace(lower(p.proconfig[1]),' ','')='search_path=public'\n` +
    `  ) then raise exception 'STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(target.grantee, ', ' order by target.grantee) into v_missing\n` +
    `  from unnest(array['authenticated','service_role']::text[]) target(grantee)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `      and granted_role.rolname=target.grantee and acl.privilege_type='EXECUTE'\n` +
    `      and not acl.is_grantable and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  if has_function_privilege('anon', ${quote(lineOperationalHealthcheckProcedure)}, 'EXECUTE') then\n` +
    `    raise exception 'STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(expected_grantee || ':' || expected_privilege, ', ' order by expected_grantee,expected_privilege) into v_missing\n` +
    `  from (values ${sqlRows(exactPublicSchemaAclGrants)}) expected(expected_grantee,expected_privilege)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_namespace public_schema\n` +
    `    cross join lateral aclexplode(coalesce(\n` +
    `      public_schema.nspacl,acldefault('n',public_schema.nspowner)\n` +
    `    )) acl\n` +
    `    left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `    where public_schema.nspname='public'\n` +
    `      and acl.grantee <> public_schema.nspowner\n` +
    `      and coalesce(grantee.rolname,'PUBLIC')=expected_grantee\n` +
    `      and acl.privilege_type=expected_privilege\n` +
    `      and not acl.is_grantable and acl.grantor=public_schema.nspowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type, ', ' order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type) into v_missing\n` +
    `  from pg_proc p\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `    and acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      coalesce(grantee.rolname,'PUBLIC') not in ('authenticated','service_role')\n` +
    `      or acl.privilege_type <> 'EXECUTE' or acl.is_grantable\n` +
    `      or acl.grantor <> p.proowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_HEALTHCHECK_UNEXPECTED_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)});\n` +
    `  if v_function_body is distinct from ${quote(lineOperationalHealthcheckExactBody)} then\n` +
    `    raise exception 'STAGING_LINE_HEALTHCHECK_BODY_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname='service_role'\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      coalesce(grantee.rolname,'PUBLIC') <> 'service_role'\n` +
    `      or acl.privilege_type <> 'EXECUTE' or acl.is_grantable\n` +
    `      or acl.grantor <> p.proowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_RPC_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') source\n` +
    `  ) body\n` +
    `  where procedure_signature <> 'public.assert_clinic_subscription_active(uuid)'\n` +
    `    and (\n` +
    `      position('auth.role()' in body.source)=0\n` +
    `      or position('service_role' in body.source)=0\n` +
    `      or (\n` +
    `        position('assert_clinic_subscription_active' in body.source)=0\n` +
    `        and position('prepare_line_subscription_off_exception' in body.source)=0\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_SERVICE_RPC_GATE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not c.relrowsecurity\n` +
    `    and (\n` +
    `      has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('authenticated',c.oid,'DELETE')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'UPDATE')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity\n` +
    `    and (\n` +
    `      has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('authenticated',c.oid,'DELETE')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'UPDATE')\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1 from pg_policy p\n` +
    `      where p.polrelid=c.oid\n` +
    `        and p.polname='cnyos_active_subscription_boundary'\n` +
    `        and not p.polpermissive and p.polcmd='*'\n` +
    `        and p.polroles=array[(select oid from pg_roles where rolname='authenticated')]\n` +
    `        and replace(lower(pg_get_expr(p.polqual,p.polrelid)),' ','')\n` +
    `          in ('(current_clinic_id()isnotnull)','(public.current_clinic_id()isnotnull)')\n` +
    `        and replace(lower(pg_get_expr(p.polwithcheck,p.polrelid)),' ','')\n` +
    `          in ('(current_clinic_id()isnotnull)','(public.current_clinic_id()isnotnull)')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind='v'\n` +
    `    and (has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT'))\n` +
    `    and not coalesce(c.reloptions,array[]::text[]) @> array['security_invoker=true']::text[];\n` +
    `  if v_missing is not null then raise exception 'STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not exists (\n` +
    `      select 1 from pg_trigger t\n` +
    `      where t.tgrelid=c.oid\n` +
    `        and t.tgname='trg_cnyos_authenticated_subscription_statement_write'\n` +
    `        and not t.tgisinternal and t.tgenabled='O' and t.tgtype=30\n` +
    `        and t.tgfoid=to_regprocedure('public.enforce_authenticated_subscription_statement_write()')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(activeSubscriptionWriteRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_trigger t\n` +
    `    where t.tgrelid=to_regclass(relation_name)\n` +
    `      and t.tgname='trg_cnyos_active_subscription_write'\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=31\n` +
    `      and t.tgfoid=to_regprocedure('public.enforce_active_subscription_tenant_write()')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_ACTIVE_SUBSCRIPTION_WRITE_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || privilege, ', ' order by relation_name,privilege) into v_missing\n` +
    `  from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c\n` +
    `    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where c.oid=to_regclass(relation_name) and granted_role.rolname='service_role'\n` +
    `      and acl.privilege_type=privilege and not acl.is_grantable\n` +
    `      and acl.grantor=c.relowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and grantee.rolname='service_role'\n` +
    `    and acl.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> c.relowner\n` +
    `      or not exists (\n` +
    `        select 1 from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `        where relation_name=n.nspname || '.' || c.relname\n` +
    `          and privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || '.' || a.attname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,a.attname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and grantee.rolname='service_role'\n` +
    `    and acl.privilege_type in ('INSERT','UPDATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || action.privilege, ', ' order by n.nspname,c.relname,action.privilege) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']::text[]) action(privilege)\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and (\n` +
    `      has_table_privilege('service_role',c.oid,action.privilege)\n` +
    `      or (action.privilege in ('INSERT','UPDATE')\n` +
    `        and has_any_column_privilege('service_role',c.oid,action.privilege))\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `      where relation_name=n.nspname || '.' || c.relname\n` +
    `        and privilege=action.privilege\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if pg_get_serial_sequence('public.audit_logs','id') is null\n` +
    `     or not exists (\n` +
    `       select 1 from pg_class c\n` +
    `       cross join lateral aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) acl\n` +
    `       join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `       where c.oid=pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `         and grantee.rolname='service_role' and acl.privilege_type='USAGE'\n` +
    `         and not acl.is_grantable and acl.grantor=c.relowner\n` +
    `     ) then\n` +
    `    raise exception 'STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind='S' and grantee.rolname='service_role'\n` +
    `    and (\n` +
    `      c.oid <> pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `      or acl.privilege_type <> 'USAGE' or acl.is_grantable\n` +
    `      or acl.grantor <> c.relowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || action.privilege, ', ' order by n.nspname,c.relname,action.privilege) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join unnest(array['USAGE','SELECT','UPDATE']::text[]) action(privilege)\n` +
    `  where n.nspname='public' and c.relkind='S'\n` +
    `    and has_sequence_privilege('service_role',c.oid,action.privilege)\n` +
    `    and not (\n` +
    `      c.oid=pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `      and action.privilege='USAGE'\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_SEQUENCE_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not (n.nspname || '.' || c.relname = any(${sqlArray(serviceRoleDmlWithoutSubscriptionGuardAllowlist)}))\n` +
    `    and (\n` +
    `      has_table_privilege('service_role',c.oid,'INSERT')\n` +
    `      or has_table_privilege('service_role',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('service_role',c.oid,'DELETE')\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1 from pg_trigger t\n` +
    `      where t.tgrelid=c.oid\n` +
    `        and t.tgname='trg_cnyos_active_subscription_write'\n` +
    `        and not t.tgisinternal and t.tgenabled='O' and t.tgtype=31\n` +
    `        and t.tgfoid=to_regprocedure('public.enforce_active_subscription_tenant_write()')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_UNGUARDED_SERVICE_ROLE_DML_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_clinic_id()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_CLINIC_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_department_role()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_DEPARTMENT_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_access_context()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_ACCESS_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.assert_clinic_subscription_active(uuid)');\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    where p.oid=to_regprocedure('public.assert_clinic_subscription_active(uuid)')\n` +
    `      and p.provolatile='v'\n` +
    `  ) or v_function_body is null\n` +
    `     or position('auth.role()' in v_function_body)=0\n` +
    `     or position('service_role' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)=0\n` +
    `     or position('if not found then raise exception ''cnyos_clinic_not_found''' in v_function_body)=0\n` +
    `     or position('if not v_clinic.active or v_clinic.subscription_state <> ''active'' then' in v_function_body)=0\n` +
    `     or position('cnyos_subscription_suspended' in v_function_body)=0\n` +
    `     or position('public.current_clinic_id() is distinct from p_clinic_id' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)\n` +
    `        >= position('not v_clinic.active' in v_function_body) then\n` +
    `    raise exception 'STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.enforce_active_subscription_tenant_write()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() is null' in v_function_body)=0\n` +
    `     or position('auth.uid() is null' in v_function_body)=0\n` +
    `     or v_function_body !~ 'session_user[[:space:]]*=[[:space:]]*current_user'\n` +
    `     or position('auth.role()=''service_role''' in v_function_body)=0\n` +
    `     or position('pg_catalog.current_setting' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception_clinic' in v_function_body)=0\n` +
    `     or position('v_capability_clinic' in v_function_body)=0\n` +
    `     or position('coalesce(v_new_clinic,v_old_clinic)=v_capability_clinic' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('line_oa_notification_preferences' in v_function_body)=0\n` +
    `     or position('line_oa_webhook_events' in v_function_body)=0\n` +
    `     or position('line_oa_notification_outbox' in v_function_body)=0\n` +
    `     or position('old.clinic_id' in v_function_body)=0\n` +
    `     or position('new.clinic_id' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_ACTIVE_SUBSCRIPTION_WRITE_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.enforce_authenticated_subscription_statement_write()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() is distinct from ''authenticated''' in v_function_body)=0\n` +
    `     or position('auth.uid() is null' in v_function_body)=0\n` +
    `     or position('v_clinic_id := public.current_clinic_id()' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active(v_clinic_id)' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.prepare_line_subscription_off_exception(uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role()<>''service_role''' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)=0\n` +
    `     or position('v_clinic.subscription_state=''active''' in v_function_body)=0\n` +
    `     or position('pg_catalog.set_config' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception_clinic' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_OFF_EXCEPTION_CAPABILITY_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('if p_enabled then' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active(p_clinic_id)' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line_oa_set_preference_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('processing_status=''processing''' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line_oa_finish_webhook_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_FINISH_WEBHOOK_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.finish_line_oa_notification(uuid,text,text,integer,text,text)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('o.status=''sending''' in v_function_body)=0\n` +
    `     or position('o.locked_by=p_worker_id' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('line_oa_finish_notification_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_FINISH_NOTIFICATION_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',\n` +
    `    ', ' order by p.proname,pg_get_function_identity_arguments(p.oid)\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type t on t.oid=p.prorettype\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and t.typname not in ('trigger','event_trigger')\n` +
    `    and has_function_privilege('authenticated',p.oid,'EXECUTE')\n` +
    `    and not exists (\n` +
    `      select 1 from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `      where to_regprocedure(procedure_signature)=p.oid\n` +
    `    )\n` +
    `    and p.proname not in ('current_clinic_id','current_department_role','current_access_context')\n` +
    `    and p.prosrc !~* 'current_clinic_id|is_clinic_member|department_can|has_role|can_access_|is_super_admin|assert_clinic_subscription_active';\n` +
    `  if v_missing is not null then raise exception 'STAGING_BROWSER_SECURITY_DEFINER_SUBSCRIPTION_GATE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(backupRestoreServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_BACKUP_RESTORE_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(backupRestoreServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_BACKUP_RESTORE_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.export_clinic_backup_domain(uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('export_clinic_backup_domain_v20260831' in v_function_body)=0\n` +
    `     or position('p_domain = ''transactions''' in v_function_body)=0\n` +
    `     or position('clinic_drive_destination_events' in v_function_body)=0\n` +
    `     or position('2026-09-01.1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_BACKUP_EXPORT_EVIDENCE_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.verify_clinic_restore_trace(uuid)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('verify_clinic_restore_trace_v20260831' in v_function_body)=0\n` +
    `     or position('clinic_drive_destination_events' in v_function_body)=0\n` +
    `     or position('2026-09-01.1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_BACKUP_RESTORE_EVIDENCE_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.begin_backup_export_run(uuid,timestamptz,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)=0\n` +
    `     or position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)=0\n` +
    `     or position('select * into v_run from public.backup_export_runs r' in v_function_body)=0\n` +
    `     or position('v_run.status = ''started''' in v_function_body)=0\n` +
    `     or position('interval ''30 minutes''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)\n` +
    `        >= position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)\n` +
    `     or position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)\n` +
    `        >= position('select * into v_run from public.backup_export_runs r' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  if position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)=0\n` +
    `     or position('v_request_id text := pg_catalog.btrim(p_request_id)' in v_function_body)=0\n` +
    `     or position('p_request_id is distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' in v_function_body)=0\n` +
    `     or position('backup_request_id_invalid' in v_function_body)=0\n` +
    `     or position('v_run.request_id is not distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('or v_run.request_id is not distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('update public.backup_export_runs' in v_function_body)=0\n` +
    `     or position('domain_counts = ''{}''::jsonb' in v_function_body)=0\n` +
    `     or position('object_manifest = ''[]''::jsonb' in v_function_body)=0\n` +
    `     or position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)\n` +
    `        >= position('v_run.status = ''started''' in v_function_body)\n` +
    `     or position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)\n` +
    `        >= position('update public.backup_export_runs' in v_function_body)\n` +
    `     or position('v_run.request_id is not distinct from v_request_id' in v_function_body)\n` +
    `        >= position('update public.backup_export_runs' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)=0\n` +
    `     or position('from public.backup_export_runs r where r.clinic_id = p_clinic_id and r.status = ''started'' and r.started_at > pg_catalog.now() - interval ''30 minutes''' in v_function_body)=0\n` +
    `     or position('raise exception ''cnyos_drive_backup_run_active''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)\n` +
    `        >= position('from public.backup_export_runs r where r.clinic_id = p_clinic_id' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.get_exact_backup_restore_source(text,timestamptz,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('r.status = ''completed''' in v_function_body)=0\n` +
    `     or position('r.destination = ''google_drive''' in v_function_body)=0\n` +
    `     or position('v_run.completed_at is null or v_run.error_code is not null' in v_function_body)=0\n` +
    `     or position('jsonb_array_length(v_run.object_manifest) <> 5' in v_function_body)=0\n` +
    `     or position('jsonb_object_keys(v_run.domain_counts)) <> 4' in v_function_body)=0\n` +
    `     or position('v_objects ? v_domain' in v_function_body)=0\n` +
    `     or position('v_file_id = any(v_file_ids) or v_folder_id = any(v_folder_ids)' in v_function_body)=0\n` +
    `     or position('restore_source_root_folder_mismatch' in v_function_body)=0\n` +
    `     or position('restore_source_assignment_version_mismatch' in v_function_body)=0\n` +
    `     or position('restore_source_file_name_mismatch' in v_function_body)=0\n` +
    `     or position('plaintext_sha256' in v_function_body)=0\n` +
    `     or position('ciphertext_sha256' in v_function_body)=0\n` +
    `     or position('key_id' in v_function_body)=0\n` +
    `     or position('restore_source_domain_evidence_invalid' in v_function_body)=0\n` +
    `     or position('v_objects ?& v_domains' in v_function_body)=0\n` +
    `     or position('chananya-exact-restore-source/v1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  if to_regprocedure(\n` +
    `    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'\n` +
    `  ) is not null then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT';\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name='clinic_subscription_control_events'\n` +
    `      and c.column_name='expected_version'\n` +
    `      and c.data_type='bigint'\n` +
    `      and c.is_nullable='NO'\n` +
    `  ) then raise exception 'STAGING_OWNER_SUBSCRIPTION_EXPECTED_VERSION_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ':' || trigger_name,\n` +
    `    ', ' order by relation_name,trigger_name\n` +
    `  ) into v_missing\n` +
    `  from (values ${sqlRows(requiredAppendOnlyTriggers)}) expected(relation_name,trigger_name)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_trigger t\n` +
    `    join pg_class c on c.oid=t.tgrelid\n` +
    `    join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2)\n` +
    `      and t.tgname=trigger_name\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=27\n` +
    `      and t.tgfoid=to_regprocedure('public.reject_append_only_mutation()')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_APPEND_ONLY_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.reject_append_only_mutation()');\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure('public.reject_append_only_mutation()')\n` +
    `      and p.prosecdef and p.provolatile='v' and t.typname='trigger'\n` +
    `      and exists (\n` +
    `        select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting(value)\n` +
    `        where replace(lower(setting.value),' ','')='search_path=pg_catalog'\n` +
    `      )\n` +
    `  ) or v_function_body is null\n` +
    `     or position('raise exception ''append_only_record_mutation_denied''' in v_function_body)=0\n` +
    `     or position('errcode = ''55000''' in v_function_body)=0\n` +
    `     or position('detail = tg_table_schema || ''.'' || tg_table_name' in v_function_body)=0\n` +
    `     or position('return' in v_function_body)>0 then\n` +
    `    raise exception 'STAGING_APPEND_ONLY_FUNCTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(appendOnlyClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_APPEND_ONLY_FUNCTION_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1\n` +
    `    from pg_trigger t\n` +
    `    where t.tgrelid=to_regclass('public.clinics')\n` +
    `      and t.tgname='trg_clinics_owner_subscription_forward_only'\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=18\n` +
    `      and t.tgfoid=to_regprocedure('public.guard_owner_subscription_forward_only()')\n` +
    `      and position('subscription_state' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_version' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_changed_at' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_changed_by' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_reason' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `  ) then raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_TRIGGER_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ' -> ' || owner_role.rolname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_roles owner_role on owner_role.oid=c.relowner\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')\n` +
    `    and c.relowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || '[' || expected_relkind || '] -> ' || expected_grantee || ':' || expected_privilege,\n` +
    `    ', ' order by relation_name,expected_grantee,expected_privilege\n` +
    `  ) into v_missing\n` +
    `  from (values ${sqlRows(exactPublicRelationAndSequenceAclTuples)}) expected(\n` +
    `    relation_name,expected_relkind,expected_grantee,expected_privilege\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_class c\n` +
    `    cross join lateral aclexplode(coalesce(\n` +
    `      c.relacl,\n` +
    `      acldefault((case when c.relkind='S' then 's' else 'r' end)::\"char\",c.relowner)\n` +
    `    )) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where c.oid=to_regclass(relation_name)\n` +
    `      and c.relkind=expected_relkind::\"char\"\n` +
    `      and granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type=expected_privilege\n` +
    `      and not acl.is_grantable and acl.grantor=c.relowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || c.relname || '[' || c.relkind::text || '] -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by n.nspname,c.relname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(\n` +
    `    c.relacl,\n` +
    `    acldefault((case when c.relkind='S' then 's' else 'r' end)::\"char\",c.relowner)\n` +
    `  )) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')\n` +
    `    and acl.grantee <> c.relowner\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> c.relowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(exactPublicRelationAndSequenceAclTuples)}) expected(\n` +
    `          relation_name,expected_relkind,expected_grantee,expected_privilege\n` +
    `        )\n` +
    `        where relation_name=n.nspname || '.' || c.relname\n` +
    `          and expected_relkind=c.relkind::text\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `          and expected_privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || c.relname || '.' || a.attname || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by n.nspname,c.relname,a.attname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f')\n` +
    `    and acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_COLUMN_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(p.oid::regprocedure::text || ' -> ' || owner_role.rolname, ', ' order by p.oid::regprocedure::text) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and p.proowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(callableSecurityDefinerProcedures)}) expected(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_proc p\n` +
    `    join pg_namespace n on n.oid=p.pronamespace\n` +
    `    join pg_type result_type on result_type.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(procedure_signature)\n` +
    `      and n.nspname='public' and p.prosecdef\n` +
    `      and result_type.typname not in ('trigger','event_trigger')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID: missing %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',\n` +
    `    ', ' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from unnest(${sqlArray(callableSecurityDefinerProcedures)}) expected(procedure_signature)\n` +
    `      where to_regprocedure(procedure_signature)=p.oid\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID: unexpected %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || expected_grantee, ', ' order by procedure_signature,expected_grantee) into v_missing\n` +
    `  from (values ${sqlRows(callableSecurityDefinerProcedureGrants)}) expected(procedure_signature,expected_grantee)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    p.oid::regprocedure::text || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by p.oid::regprocedure::text,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      acl.privilege_type <> 'EXECUTE' or acl.is_grantable or acl.grantor <> p.proowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(callableSecurityDefinerProcedureGrants)}) expected(\n` +
    `          procedure_signature,expected_grantee\n` +
    `        )\n` +
    `        where to_regprocedure(procedure_signature)=p.oid\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(expected.role_name, ', ' order by expected.role_name) into v_missing\n` +
    `  from (values ${sqlRows(expectedRuntimeRoleSecurityAttributes)}) expected(\n` +
    `    role_name,expected_super,expected_create_role,expected_create_db,\n` +
    `    expected_login,expected_replication,expected_bypass_rls\n` +
    `  )\n` +
    `  left join pg_roles role_state on role_state.rolname=expected.role_name\n` +
    `  where role_state.oid is null\n` +
    `     or role_state.rolsuper is distinct from expected.expected_super::boolean\n` +
    `     or role_state.rolcreaterole is distinct from expected.expected_create_role::boolean\n` +
    `     or role_state.rolcreatedb is distinct from expected.expected_create_db::boolean\n` +
    `     or role_state.rolcanlogin is distinct from expected.expected_login::boolean\n` +
    `     or role_state.rolreplication is distinct from expected.expected_replication::boolean\n` +
    `     or role_state.rolbypassrls is distinct from expected.expected_bypass_rls::boolean\n` +
    `     or (expected.role_name='authenticator' and role_state.rolinherit);\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1\n` +
    `    from pg_namespace public_schema\n` +
    `    where public_schema.nspname='public'\n` +
    `      and public_schema.nspowner in (\n` +
    `        (select relowner from pg_class where oid=to_regclass('public.clinics')),\n` +
    `        (select oid from pg_roles where rolname='pg_database_owner')\n` +
    `      )\n` +
    `  ) then raise exception 'STAGING_PUBLIC_SCHEMA_OWNER_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type, ', ' order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type) into v_missing\n` +
    `  from pg_namespace public_schema\n` +
    `  cross join lateral aclexplode(coalesce(\n` +
    `    public_schema.nspacl,acldefault('n',public_schema.nspowner)\n` +
    `  )) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where public_schema.nspname='public' and acl.grantee <> public_schema.nspowner\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> public_schema.nspowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(exactPublicSchemaAclGrants)}) expected(\n` +
    `          expected_grantee,expected_privilege\n` +
    `        )\n` +
    `        where expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `          and expected_privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(runtime_role, ', ' order by runtime_role) into v_missing\n` +
    `  from unnest(${sqlArray(runtimeJwtRoles)}) expected(runtime_role)\n` +
    `  where not has_schema_privilege(runtime_role,'public','USAGE')\n` +
    `     or has_schema_privilege(runtime_role,'public','CREATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_RUNTIME_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(runtime_role, ', ' order by runtime_role) into v_missing\n` +
    `  from unnest(${sqlArray(runtimeJwtRoles)}) expected(runtime_role)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_auth_members membership\n` +
    `    join pg_roles granted_role on granted_role.oid=membership.roleid\n` +
    `    join pg_roles member_role on member_role.oid=membership.member\n` +
    `    where granted_role.rolname=runtime_role\n` +
    `      and member_role.rolname='authenticator'\n` +
    `      and not membership.admin_option\n` +
    `      and not coalesce(\n` +
    `        (to_jsonb(membership)->>'inherit_option')::boolean,\n` +
    `        member_role.rolinherit\n` +
    `      )\n` +
    `      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(granted_role.rolname || ' -> ' || member_role.rolname, ', ' order by granted_role.rolname,member_role.rolname) into v_missing\n` +
    `  from pg_auth_members membership\n` +
    `  join pg_roles granted_role on granted_role.oid=membership.roleid\n` +
    `  join pg_roles member_role on member_role.oid=membership.member\n` +
    `  where (\n` +
    `    granted_role.rolname in ('anon','authenticated','service_role','authenticator')\n` +
    `    or member_role.rolname in ('anon','authenticated','service_role','authenticator')\n` +
    `  )\n` +
    `    and not (\n` +
    `      granted_role.rolname in ('anon','authenticated','service_role')\n` +
    `      and member_role.rolname='authenticator'\n` +
    `      and not membership.admin_option\n` +
    `      and not member_role.rolsuper\n` +
    `      and not member_role.rolbypassrls\n` +
    `      and not member_role.rolcreaterole\n` +
    `      and not coalesce(\n` +
    `        (to_jsonb(membership)->>'inherit_option')::boolean,\n` +
    `        member_role.rolinherit\n` +
    `      )\n` +
    `      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from public.owner_control_historical_replay_guard\n` +
    `    where singleton\n` +
    `      and protected_migration='202608311800_owner_subscription_control'\n` +
    `      and historical_sha256='f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'\n` +
    `  ) then raise exception 'STAGING_OWNER_REPLAY_GUARD_ROW_MISSING'; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and code=${quote(target.tenant.expectedClinicCode)} and active and subscription_state='active'\n` +
    `  ) then raise exception 'STAGING_CLINIC_MISMATCH'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinic_memberships m\n` +
    `    join public.profiles p on p.id=m.profile_id\n` +
    `    where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and m.active and p.system_role='super_admin'\n` +
    `  ) then raise exception 'STAGING_ACTIVE_MEMBERSHIP_REQUIRED'; end if;\n` +
    `  if not exists (select 1 from public.profiles where system_role='super_admin') then\n` +
    `    raise exception 'STAGING_SUPER_ADMIN_REQUIRED';\n` +
    `  end if;\n` +
    `  perform set_config(\n` +
    `    'request.jwt.claim.sub',\n` +
    `    (select m.profile_id::text from public.clinic_memberships m\n` +
    `     join public.profiles p on p.id=m.profile_id\n` +
    `     where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `       and m.active and p.system_role='super_admin'\n` +
    `     order by m.is_primary desc,m.joined_at limit 1),\n` +
    `    true\n` +
    `  );\n` +
    `  perform set_config('request.jwt.claim.role','authenticated',true);\n` +
    `\n` +
    `  select (select count(*) from public.patients)\n` +
    `       + (select count(*) from public.encounters)\n` +
    `       + (select count(*) from public.invoices)\n` +
    `       + (select count(*) from public.payments)\n` +
    `  into v_transactional_rows;\n` +
    `  if v_transactional_rows <> 0 then\n` +
    `    raise exception 'STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA: %', v_transactional_rows;\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='products_read_staff') then\n` +
    `    raise exception 'STAGING_PRODUCTS_READ_POLICY_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_OPERATIONAL_RLS_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_gateway_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_GATEWAY_RLS_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='clinic_subscription_control_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_RLS_MISSING';\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (select 1 from public.hybrid_patient_identity_healthcheck() where ready) then raise exception 'HYBRID_IDENTITY_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.clinical_financial_handoffs_healthcheck() where ready) then raise exception 'CLINICAL_HANDOFF_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.department_persistence_healthcheck() where ready) then raise exception 'DEPARTMENT_PERSISTENCE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.production_execution_healthcheck() where ready) then raise exception 'PRODUCTION_EXECUTION_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.quality_release_healthcheck() where ready) then raise exception 'QUALITY_RELEASE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.prescription_dispensing_healthcheck() where ready) then raise exception 'PRESCRIPTION_DISPENSING_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.backup_restore_contract_healthcheck()\n` +
    `    where ready\n` +
    `      and schema_version='2026-09-01.1'\n` +
    `      and domain_count=4\n` +
    `      and patient_table_count=31\n` +
    `      and product_table_count=16\n` +
    `      and pharmacy_table_count=7\n` +
    `      and transaction_table_count=12\n` +
    `      and managed_database_restore_required\n` +
    `  ) then raise exception 'BACKUP_RESTORE_CONTRACT_MISMATCH'; end if;\n` +
    `  if not exists (select 1 from public.line_oa_operational_healthcheck() where ready) then raise exception 'LINE_OA_OPERATIONAL_HEALTHCHECK_FAILED'; end if;\n` +
    `end\n` +
    `$ledger_guard$;\n` +
    `\n` +
    `create schema if not exists supabase_migrations;\n` +
    `create table if not exists supabase_migrations.schema_migrations (\n` +
    `  version text not null primary key\n` +
    `);\n` +
    `alter table supabase_migrations.schema_migrations add column if not exists statements text[];\n` +
    `alter table supabase_migrations.schema_migrations add column if not exists name text;\n` +
    `\n` +
    `do $ledger_conflict_guard$\n` +
    `begin\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    left join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name,sha256,evidence) on expected.version=actual.version\n` +
    `    where expected.version is null\n` +
    `       or (actual.name is not null and actual.name is distinct from expected.name)\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_CONFLICT'; end if;\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name,sha256,expected_evidence) on expected.version=actual.version\n` +
    `    cross join lateral unnest(coalesce(actual.statements,array[]::text[])) evidence(statement)\n` +
    `    where evidence.statement ~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `      and (\n` +
    `        substring(evidence.statement from '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*=[[:space:]]*([0-9A-Fa-f]{64})[[:space:]]*$') is null\n` +
    `        or lower(substring(evidence.statement from '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*=[[:space:]]*([0-9A-Fa-f]{64})[[:space:]]*$')) <> expected.sha256\n` +
    `      )\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_SHA256_CONFLICT'; end if;\n` +
    `end\n` +
    `$ledger_conflict_guard$;\n` +
    `\n` +
    `insert into supabase_migrations.schema_migrations as ledger(version,name,statements) values\n  ${inserts}\n` +
    `on conflict (version) do update set\n` +
    `  name=excluded.name,\n` +
    `  statements=(\n` +
    `    select coalesce(\n` +
    `      array_agg(evidence.statement order by evidence.ordinality) filter (\n` +
    `        where evidence.statement !~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `      ),\n` +
    `      array[]::text[]\n` +
    `    ) || excluded.statements\n` +
    `    from unnest(coalesce(ledger.statements,array[]::text[]))\n` +
    `      with ordinality evidence(statement,ordinality)\n` +
    `  );\n` +
    `\n` +
    `do $ledger_verify$\n` +
    `begin\n` +
    `  if (select count(*) from supabase_migrations.schema_migrations) <> ${entries.length} then\n` +
    `    raise exception 'MIGRATION_LEDGER_ROW_COUNT_MISMATCH';\n` +
    `  end if;\n` +
    `  if exists (select 1 from supabase_migrations.schema_migrations where name is null or statements is null or cardinality(statements)=0) then\n` +
    `    raise exception 'MIGRATION_LEDGER_INCOMPLETE_ROW';\n` +
    `  end if;\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name,sha256,evidence) on expected.version=actual.version\n` +
    `    where actual.name is distinct from expected.name\n` +
    `       or not (expected.evidence = any(actual.statements))\n` +
    `       or (\n` +
    `         select count(*)\n` +
    `         from unnest(actual.statements) statement(value)\n` +
    `         where statement.value ~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `       ) <> 1\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_SHA256_EVIDENCE_INVALID'; end if;\n` +
    `end\n` +
    `$ledger_verify$;\n` +
    `\n` +
    `comment on table supabase_migrations.schema_migrations is\n` +
    `  'Canonical Supabase CLI migration history. Recovered only after staging schema fingerprint and empty-data guards passed.';\n` +
    `revoke all on schema supabase_migrations from public, anon, authenticated, service_role;\n` +
    `revoke all on table supabase_migrations.schema_migrations from public, anon, authenticated, service_role;\n` +
    `commit;\n` +
    `\n` +
    `select jsonb_build_object(\n` +
    `  'status','CHANANYA_STAGING_MIGRATION_LEDGER_READY',\n` +
    `  'migration_count',count(*),\n` +
    `  'first_version',min(version),\n` +
    `  'last_version',max(version),\n` +
    `  'source_revision',${quote(revision || 'not-supplied')}\n` +
    `) as migration_ledger_evidence\n` +
    `from supabase_migrations.schema_migrations;\n`;
}

function main() {
  const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH;
  if (!source) {
    throw new Error('Pass an explicit staging tenant config path');
  }
  const configPath = path.resolve(root, source);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(buildMigrationLedgerRepairSql({
    config,
    entries: loadMigrationEntries(root),
    sourceRevision: process.env.CLINICAL_OS_SOURCE_COMMIT || ''
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
