-- This manual candidate is a psql program, not migration-runner SQL. It must
-- begin in a fresh direct psql session so its COMMIT can never commit unrelated
-- caller work. A later ordered migration must use a separately reviewed,
-- migration-native transaction envelope; do not copy this wrapper into it.

\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
\unset cnyos_acl_candidate_probe_xid
\unset cnyos_acl_candidate_existing_transaction

\if :AUTOCOMMIT
\else
\warn 'CNYOS ACL candidate requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_ACL_CANDIDATE_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_acl_psql_preflight_abort$;
\endif

set search_path = pg_catalog, pg_temp;

-- Adjacent top-level XIDs distinguish a fresh AUTOCOMMIT session from an
-- included file running inside a caller transaction. On detection the caller
-- transaction is rolled back before the abort, so the tail COMMIT is unreachable
-- with pre-existing caller writes.
select pg_catalog.pg_current_xact_id()::text as cnyos_acl_candidate_probe_xid
\gset
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_acl_candidate_probe_xid'
) as cnyos_acl_candidate_existing_transaction
\gset
\if :cnyos_acl_candidate_existing_transaction
\warn 'CNYOS ACL candidate detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_acl_psql_preflight_abort$;
\endif

-- CNYOS_ACL_SQL_ACQUISITION_BEGIN
do $cnyos_acl_interlock$
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
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_ALREADY_HELD';
  end if;
  if not pg_catalog.pg_try_advisory_lock(202608302100::bigint) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_BUSY';
  end if;
end
$cnyos_acl_interlock$;

begin isolation level repeatable read read write;
set local search_path = pg_catalog, pg_temp;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local extra_float_digits = 3;
set local bytea_output = 'hex';
set local quote_all_identifiers = off;
set local standard_conforming_strings = on;
lock table pg_catalog.pg_proc, pg_catalog.pg_namespace,
  pg_catalog.pg_authid, pg_catalog.pg_auth_members,
  pg_catalog.pg_depend, pg_catalog.pg_extension, pg_catalog.pg_type,
  pg_catalog.pg_language, pg_catalog.pg_operator, pg_catalog.pg_collation
  in share mode;
lock table public.clinics in share mode;
lock table supabase_migrations.schema_migrations in share mode;
lock table supabase_migrations.cnyos_migration_ledger_repair_receipts in share mode;

-- This reviewed source is deliberately inert until an independent reviewer
-- checks the complete live public-routine raw/effective ACL manifest. The
-- unconditional gate is the first executable statement of the sole mutation
-- DO below, making every REVOKE structurally unreachable even if a client
-- recovers from the statement error through a savepoint.
-- Strict promotion is additionally blocked until the live observer classifies
-- extension-owned public routines and the project's default function ACLs;
-- this candidate deliberately makes no default-ACL mutation.

-- ============================================================
-- BROWSER RPC ACL DRIFT CLOSURE — MIGRATION CANDIDATE
--
-- Do not move into supabase/migrations or apply until the target staging
-- migration ledger has passed the guarded 45-file fingerprint verification.
-- This candidate removes only runtime grants that are outside the exact
-- browser/service allowlist already enforced by the generated ledger guard.
-- It never creates or expands a grant.
--
-- The required session authorization value is an execution interlock, not
-- endpoint attestation, change approval, or a security sign-off. The reviewed
-- Chananya staging server system ID, exact reconciled ledger evidence, and
-- clinic row are projected guard scaffolding only: the unconditional
-- live-manifest gate means no target is authorized by this revision.
-- Jitarsa remains unauthorized until a separate ordered-migration PR adapts this
-- proposal after its own independent reconciliation; the token below is not
-- approval for that promotion.
-- ============================================================

do $$
declare
  v_signature text;
  v_missing text;
  v_authorization text;
  v_system_identifier text;
  v_ledger_count bigint;
  v_ledger_manifest_count bigint;
  v_ledger_manifest_payload text;
  v_function_semantic_count bigint;
  v_function_semantic_payload text;
  v_projected_canonical_public_routine_count bigint;
  v_projected_canonical_public_routine_payload text;
  v_browser_helper_signatures constant text[] := array[
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
  ]::text[];
  v_browser_write_signatures constant text[] := array[
    'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
    'public.decide_approval_task(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)'
  ]::text[];
  v_browser_signatures constant text[] := array[
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
    'public.prescription_dispensing_healthcheck()',
    'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
    'public.decide_approval_task(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)'
  ]::text[];
  v_expected_authenticated_signatures constant text[] := array[
    'public.admin_assign_staff_role(uuid,text,text)',
    'public.admin_set_staff_membership_active(uuid,boolean,text)',
    'public.backup_restore_contract_healthcheck()',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.can_access_encounter(uuid)',
    'public.can_access_invoice(uuid)',
    'public.can_access_patient(uuid)',
    'public.can_access_prescription(uuid)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.clinical_outcomes_summary(timestamp with time zone,timestamp with time zone)',
    'public.commit_production_import(uuid)',
    'public.complete_production_order(uuid,numeric,numeric,numeric)',
    'public.confirm_patient_qr(uuid,boolean,text,jsonb)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamp with time zone,jsonb)',
    'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)',
    'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)',
    'public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)',
    'public.create_production_request(uuid,uuid,uuid,numeric,text,timestamp with time zone,text,text)',
    'public.current_access_context()',
    'public.current_clinic_id()',
    'public.current_department_role()',
    'public.current_user_role()',
    'public.decide_approval_task(uuid,text,text)',
    'public.department_can(text)',
    'public.department_persistence_healthcheck()',
    'public.dispense_pharmacy_counter_sale(uuid)',
    'public.has_role(text[])',
    'public.hybrid_patient_identity_healthcheck()',
    'public.is_admin_or_super()',
    'public.is_appointment_operator()',
    'public.is_appointment_practitioner()',
    'public.is_clinic_admin()',
    'public.is_clinic_member(uuid,text[])',
    'public.is_practitioner()',
    'public.is_reception_or_admin()',
    'public.is_super_admin()',
    'public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)',
    'public.issue_patient_line_link_code(uuid,text,text,boolean)',
    'public.issue_production_materials_fefo(uuid)',
    'public.line_oa_operational_healthcheck()',
    'public.list_patient_identity_links(uuid)',
    'public.open_production_order(uuid,uuid,numeric)',
    'public.prescription_dispensing_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_reject_production_order(uuid,text,text)',
    'public.quality_release_healthcheck()',
    'public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
    'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)',
    'public.remove_pharmacy_counter_sale_item(uuid)',
    'public.resolve_patient_qr(text,text)',
    'public.revoke_patient_identity_link(uuid,text)',
    'public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)',
    'public.search_clinical_outcomes(text,timestamp with time zone,timestamp with time zone,integer,integer)',
    'public.search_patients_for_checkin(text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.set_product_master_active(uuid,boolean,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.stage_production_import(text,text,text,jsonb)',
    'public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)',
    'public.super_admin_set_system_role(uuid,text,text)',
    'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
    'public.transition_pharmacy_counter_sale(uuid,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)',
    'public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text)',
    'public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text)',
    'public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)',
    'public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text)',
    'public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text)',
    'public.upsert_supplier_master(uuid,text,text,text,text,text,text)'
  ]::text[];
  v_expected_service_signatures constant text[] := array[
    'public.assert_clinic_subscription_active(uuid)',
    'public.backup_restore_contract_healthcheck()',
    'public.begin_backup_export_run(uuid,timestamp with time zone,text)',
    'public.can_access_encounter(uuid)',
    'public.can_access_invoice(uuid)',
    'public.can_access_patient(uuid)',
    'public.can_access_prescription(uuid)',
    'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
    'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamp with time zone,boolean,text,text,text,text,text,text,text,jsonb)',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.commit_production_import(uuid)',
    'public.complete_backup_export_run(uuid,text,jsonb,jsonb,text)',
    'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
    'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
    'public.complete_production_order(uuid,numeric,numeric,numeric)',
    'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
    'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)',
    'public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)',
    'public.create_production_request(uuid,uuid,uuid,numeric,text,timestamp with time zone,text,text)',
    'public.current_clinic_id()',
    'public.current_department_role()',
    'public.current_user_role()',
    'public.department_can(text)',
    'public.department_persistence_healthcheck()',
    'public.dispense_pharmacy_counter_sale(uuid)',
    'public.export_clinic_backup_domain(uuid,text)',
    'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
    'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
    'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
    'public.get_clinic_drive_backup_destination(uuid,text)',
    'public.get_exact_backup_restore_source(text,timestamp with time zone,text)',
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
    'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamp with time zone)',
    'public.issue_production_materials_fefo(uuid)',
    'public.line_oa_operational_healthcheck()',
    'public.line_oa_webhook_evidence(timestamp with time zone)',
    'public.list_backup_export_clinics()',
    'public.list_line_linked_patients_for_clinic(uuid,text)',
    'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
    'public.list_owner_drive_assignments()',
    'public.list_owner_subscription_clinics()',
    'public.open_production_order(uuid,uuid,numeric)',
    'public.prescription_dispensing_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_reject_production_order(uuid,text,text)',
    'public.quality_release_healthcheck()',
    'public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
    'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)',
    'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamp with time zone,boolean,text)',
    'public.reject_production_order(uuid,text,text)',
    'public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
    'public.remove_pharmacy_counter_sale_item(uuid)',
    'public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)',
    'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)',
    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
    'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
    'public.set_product_master_active(uuid,boolean,text)',
    'public.stage_production_import(text,text,text,jsonb)',
    'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
    'public.transition_pharmacy_counter_sale(uuid,text,text)',
    'public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text)',
    'public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)',
    'public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text)',
    'public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text)',
    'public.upsert_supplier_master(uuid,text,text,text,text,text,text)',
    'public.verify_clinic_restore_trace(uuid)'
  ]::text[];
  v_actual_anon_signatures text[];
  v_actual_authenticated_signatures text[];
  v_actual_service_signatures text[];
begin
  raise exception 'CNYOS_BROWSER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED';

  if current_setting('transaction_read_only') <> 'off' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_READ_WRITE_REQUIRED';
  end if;
  if current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_ISOLATION_INVALID: %',
      current_setting('transaction_isolation');
  end if;
  if current_database() <> 'postgres'
     or session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception
      'CNYOS_BROWSER_CANDIDATE_DATABASE_IDENTITY_INVALID: database=%, session=%, current=%',
      current_database(),session_user,current_user;
  end if;

  v_authorization := coalesce(
    current_setting('cnyos.browser_rpc_acl_candidate_authorization',true),''
  );
  if v_authorization = '' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_AUTHORIZATION_REQUIRED';
  end if;
  if v_authorization <>
     'chananya-staging-browser-rpc-acl-candidate-202609060710-reconciled-45' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_AUTHORIZATION_INVALID';
  end if;

  select system_identifier::text into v_system_identifier
  from pg_control_system();

  if v_system_identifier <> '7666007964130682852' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID: %',
      v_system_identifier;
  end if;
  if current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'CNYOS_BROWSER_SERVER_MAJOR_INVALID: %',
      current_setting('server_version_num');
  end if;
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception 'CNYOS_BROWSER_SERVER_ENCODING_INVALID: %',
      current_setting('server_encoding');
  end if;
  if coalesce(current_setting('cnyos.browser_rpc_acl_target_project_ref',true),'') <>
       'hsmnjwxurlmsizndjlun'
     or coalesce(current_setting('cnyos.browser_rpc_acl_target_deployment_id',true),'') <>
       'chananya-clinical-staging'
     or coalesce(current_setting('cnyos.browser_rpc_acl_target_environment',true),'') <>
       'staging'
     or coalesce(current_setting('cnyos.browser_rpc_acl_target_clinic_id',true),'') <>
       '00000000-0000-4000-8000-00000000a001'
     or coalesce(current_setting('cnyos.browser_rpc_acl_target_clinic_code',true),'') <>
       'CHANANYA-STG' then
    raise exception 'CNYOS_BROWSER_CANDIDATE_TARGET_MARKERS_INVALID';
  end if;

  if to_regclass('public.clinics') is null then
    raise exception 'CNYOS_BROWSER_CANDIDATE_CLINIC_RELATION_MISSING';
  end if;
  if (select count(*) from public.clinics) <> 1
     or not exists (
       select 1 from public.clinics
       where id='00000000-0000-4000-8000-00000000a001'::uuid
         and code='CHANANYA-STG' and active
     ) then
    raise exception 'CNYOS_BROWSER_CANDIDATE_CLINIC_INVALID';
  end if;

  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'CNYOS_BROWSER_CANDIDATE_LEDGER_MISSING';
  end if;
  if (
    select count(*)
    from information_schema.columns
    where table_schema='supabase_migrations'
      and table_name='schema_migrations'
      and (
        (column_name='version' and data_type='text')
        or (column_name='name' and data_type='text')
        or (column_name='statements' and data_type='ARRAY' and udt_name='_text')
      )
  ) <> 3 then
    raise exception 'CNYOS_BROWSER_CANDIDATE_LEDGER_SHAPE_INVALID';
  end if;

  select count(*) into v_ledger_count
  from supabase_migrations.schema_migrations;
  select count(*)::bigint,
    coalesce(string_agg(
      manifest_row,E'\n' order by version collate "C"
    ),'') || E'\n'
  into v_ledger_manifest_count,v_ledger_manifest_payload
  from (
    select actual.version,
      actual.version || E'\t' || actual.name || E'\t' ||
        marker.sha256 as manifest_row
    from supabase_migrations.schema_migrations actual
    cross join lateral (
      select
        count(*) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_count,
        min(evidence.statement) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_text,
        min(evidence.ordinality) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_ordinality,
        min(substring(evidence.statement from 'sha256=([0-9a-f]{64})$'))
          filter (
            where evidence.statement ~
              '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
          ) sha256
      from unnest(coalesce(actual.statements,array[]::text[]))
        with ordinality evidence(statement,ordinality)
    ) marker
    where actual.version is not null
      and actual.name is not null
      and marker.marker_count=1
      and marker.marker_ordinality=cardinality(actual.statements)
      and marker.marker_text=
        '-- recovered from supabase/migrations/' || actual.version || '_' ||
        actual.name || '.sql; sha256=' || marker.sha256
  ) canonical_ledger;
  if v_ledger_count <> 45
     or v_ledger_manifest_count <> 45
     or octet_length(v_ledger_manifest_payload) <> 4838
     or encode(sha256(convert_to(v_ledger_manifest_payload,'UTF8')),'hex') <>
       'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a' then
    raise exception
      'CNYOS_BROWSER_CANDIDATE_LEDGER_MANIFEST_INVALID: rows=%, canonical=%, bytes=%, sha256=%',
      v_ledger_count,v_ledger_manifest_count,
      octet_length(v_ledger_manifest_payload),
      encode(sha256(convert_to(v_ledger_manifest_payload,'UTF8')),'hex');
  end if;

  if not exists (
    select 1
    from supabase_migrations.cnyos_migration_ledger_repair_receipts receipt
    where receipt.committed_at is not null
      and receipt.gate_token ~ '^[0-9a-f]{64}$'
      and receipt.repair_xid ~ '^[0-9]+$'
      and pg_catalog.jsonb_typeof(receipt.evidence)='object'
      and (receipt.evidence->>'repair_gate_token'=receipt.gate_token
        and receipt.evidence->>'repair_run_nonce'=receipt.run_nonce::text
        and receipt.evidence->>'repair_transaction_xid'=receipt.repair_xid
        and receipt.evidence->>'status'=
          'CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING'
        and receipt.evidence->>'expected_project_ref'=
          current_setting('cnyos.browser_rpc_acl_target_project_ref')
        and receipt.evidence->>'expected_deployment_id'=
          current_setting('cnyos.browser_rpc_acl_target_deployment_id')
        and receipt.evidence->>'expected_clinic_id'=
          current_setting('cnyos.browser_rpc_acl_target_clinic_id')
        and receipt.evidence->>'expected_clinic_code'=
          current_setting('cnyos.browser_rpc_acl_target_clinic_code')
        and receipt.evidence->>'expected_current_database'=current_database()
        and receipt.evidence->>'observed_current_database'=current_database()
        and receipt.evidence->>'expected_system_identifier'=v_system_identifier
        and receipt.evidence->>'observed_system_identifier'=v_system_identifier
        and receipt.evidence->>'acl_phase'='chananya-pre-reconciliation'
        and receipt.evidence->>'migration_manifest_sha256'=
          'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a'
        and receipt.evidence->>'migration_count'='45'
        and receipt.evidence->>'ledger_reconciled'='true'
        and receipt.evidence->>'acl_remediation_pending'='true'
        and receipt.evidence->>'browser_rpc_acl_remediation_pending'='true'
        and receipt.evidence->>'trigger_function_acl_remediation_pending'='true'
        and receipt.evidence->>'production_eligible'='false'
        and receipt.evidence->>'source_revision' ~ '^[0-9a-f]{40}$') is true
  ) then
    raise exception 'CNYOS_BROWSER_CANDIDATE_DURABLE_LEDGER_RECEIPT_INVALID';
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(v_browser_signatures) expected(signature)
  where to_regprocedure(signature) is null;
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_REQUIRED_FUNCTION_MISSING: %', v_missing;
  end if;

  select string_agg(
    signature || ' -> ' || coalesce(owner_role.rolname,'MISSING'),
    ', ' order by signature
  ) into v_missing
  from unnest(v_browser_signatures) expected(signature)
  left join pg_proc procedure on procedure.oid=to_regprocedure(signature)
  left join pg_roles owner_role on owner_role.oid=procedure.proowner
  where owner_role.rolname is distinct from 'postgres';
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_OWNER_INVALID: %', v_missing;
  end if;

  select string_agg(role_name,', ' order by role_name) into v_missing
  from (values ('anon'),('authenticated'),('service_role')) runtime_role(role_name)
  where not has_schema_privilege(role_name,'public','USAGE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_PUBLIC_SCHEMA_USAGE_MISSING: %', v_missing;
  end if;

  -- Fail on an added/removed application routine before any per-function
  -- formatter can obscure the catalog drift. The complete projected manifest
  -- (including closed/owner-only routines) is still hashed below.
  select count(*)::bigint
  into v_projected_canonical_public_routine_count
  from pg_proc procedure
  join pg_namespace function_namespace
    on function_namespace.oid=procedure.pronamespace
  where function_namespace.nspname='public'
    and not exists (
      select 1
      from pg_depend dependency
      join pg_extension extension on extension.oid=dependency.refobjid
      where dependency.classid='pg_proc'::regclass
        and dependency.objid=procedure.oid
        and dependency.objsubid=0
        and dependency.refclassid='pg_extension'::regclass
        and dependency.deptype='e'
    );
  if v_projected_canonical_public_routine_count <> 146 then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID: phase=pre-catalog-count, count=%',
      v_projected_canonical_public_routine_count;
  end if;

  -- Bind every security-relevant property of the 20 reviewed browser RPCs to
  -- the ordered projected-canonical PostgreSQL 17 replay (45 migrations, then
  -- trigger closure). ACLs are fingerprinted separately so this payload must
  -- remain identical before and after the revokes. It is not a live manifest.
  select count(*)::bigint,
    coalesce(string_agg(semantic_row,E'\n' order by semantic_row collate "C"),'') || E'\n'
  into v_function_semantic_count,v_function_semantic_payload
  from (
    select jsonb_build_array(
      'cnyos-browser-rpc-function/v1',
      function_namespace.nspname,
      procedure.proname,
      pg_get_function_identity_arguments(procedure.oid),
      pg_get_function_arguments(procedure.oid),
      pg_get_function_result(procedure.oid),
      owner_role.rolname,
      language.lanname,
      procedure.prokind::text,
      procedure.prosecdef,
      procedure.proleakproof,
      procedure.proisstrict,
      procedure.proretset,
      procedure.provolatile::text,
      procedure.proparallel::text,
      procedure.procost::text,
      procedure.prorows::text,
      case when procedure.provariadic=0 then null
           else format_type(procedure.provariadic,null) end,
      case when procedure.prosupport=0 then null
           else support_namespace.nspname || '.' || support_function.proname || '(' ||
                pg_get_function_identity_arguments(support_function.oid) || ')' end,
      procedure.pronargs,
      procedure.pronargdefaults,
      to_jsonb(procedure.proargmodes),
      to_jsonb(procedure.proargnames),
      (
        select jsonb_agg(format_type(argument_type,null) order by argument.ordinality)
        from unnest(procedure.proallargtypes) with ordinality
          argument(argument_type,ordinality)
      ),
      (
        select jsonb_agg(format_type(transform_type,null) order by transform.ordinality)
        from unnest(procedure.protrftypes) with ordinality
          transform(transform_type,ordinality)
      ),
      to_jsonb(procedure)->'proargdefaults',
      procedure.prosrc,
      procedure.probin,
      to_jsonb(procedure)->'prosqlbody',
      to_jsonb(procedure.proconfig)
    )::text semantic_row
    from unnest(v_browser_signatures) expected(signature)
    join pg_proc procedure on procedure.oid=to_regprocedure(expected.signature)
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    join pg_roles owner_role on owner_role.oid=procedure.proowner
    join pg_language language on language.oid=procedure.prolang
    left join pg_proc support_function on support_function.oid=procedure.prosupport
    left join pg_namespace support_namespace
      on support_namespace.oid=support_function.pronamespace
  ) reviewed_browser_functions;
  if v_function_semantic_count <> 20
     or octet_length(v_function_semantic_payload) <> 30326
     or encode(sha256(convert_to(v_function_semantic_payload,'UTF8')),'hex') <>
        'a9d23d5e9225fd4f9a0757affdc8dbacb38d6f2efdc6fc95a59d2dcba600e4b8' then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_RPC_FUNCTION_SEMANTICS_INVALID: count=%, bytes=%, sha256=%',
      v_function_semantic_count,octet_length(v_function_semantic_payload),
      encode(sha256(convert_to(v_function_semantic_payload,'UTF8')),'hex');
  end if;

  -- Projected-canonical fixture/design scaffold only. This is not a live
  -- Chananya observation or an execution precondition; the unconditional
  -- source gate above makes it non-executable. Effective booleans include
  -- PUBLIC and role inheritance; the nested ACL array binds raw
  -- grantor/grant-option state. Extension-owned public routines are excluded
  -- only from this application-routine projection, not approved as exposed:
  -- the disabled live observer must catalog/classify them before promotion.
  select count(*)::bigint,
    coalesce(string_agg(inventory_row,E'\n' order by inventory_row collate "C"),'') || E'\n'
  into v_projected_canonical_public_routine_count,
       v_projected_canonical_public_routine_payload
  from (
    select jsonb_build_array(
      'cnyos-public-routine-acl/v2',
      function_namespace.nspname,
      procedure.proname,
      pg_get_function_identity_arguments(procedure.oid),
      owner_role.rolname,
      procedure.prokind::text,
      procedure.prosecdef,
      has_schema_privilege('anon',function_namespace.oid,'USAGE') and
        has_function_privilege('anon',procedure.oid,'EXECUTE'),
      has_schema_privilege('authenticated',function_namespace.oid,'USAGE') and
        has_function_privilege('authenticated',procedure.oid,'EXECUTE'),
      has_schema_privilege('service_role',function_namespace.oid,'USAGE') and
        has_function_privilege('service_role',procedure.oid,'EXECUTE'),
      coalesce((
        select jsonb_agg(
          jsonb_build_array(
            case when acl.grantee=0 then 'PUBLIC'
                 when grantee_role.rolname is not null then grantee_role.rolname
                 else 'OID:' || acl.grantee::text end,
            acl.privilege_type,
            acl.is_grantable,
            case when grantor_role.rolname is not null then grantor_role.rolname
                 else 'OID:' || acl.grantor::text end
          ) order by
            (case when acl.grantee=0 then 'PUBLIC'
                  when grantee_role.rolname is not null then grantee_role.rolname
                  else 'OID:' || acl.grantee::text end) collate "C",
            acl.privilege_type collate "C",
            acl.is_grantable,
            (case when grantor_role.rolname is not null then grantor_role.rolname
                  else 'OID:' || acl.grantor::text end) collate "C"
        )
        from aclexplode(coalesce(
          procedure.proacl,acldefault('f',procedure.proowner)
        )) acl
        left join pg_roles grantee_role
          on acl.grantee<>0 and grantee_role.oid=acl.grantee
        left join pg_roles grantor_role on grantor_role.oid=acl.grantor
      ),'[]'::jsonb)
    )::text inventory_row
    from pg_proc procedure
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    join pg_roles owner_role on owner_role.oid=procedure.proowner
    where function_namespace.nspname='public'
      and not exists (
        select 1
        from pg_depend dependency
        join pg_extension extension on extension.oid=dependency.refobjid
        where dependency.classid='pg_proc'::regclass
          and dependency.objid=procedure.oid
          and dependency.objsubid=0
          and dependency.refclassid='pg_extension'::regclass
          and dependency.deptype='e'
      )
  ) projected_canonical_public_routine_manifest;
  if v_projected_canonical_public_routine_count <> 146
     or octet_length(v_projected_canonical_public_routine_payload) <> 42681
     or encode(sha256(convert_to(
          v_projected_canonical_public_routine_payload,'UTF8'
        )),'hex') <>
        '3bc63c84da258f7699654d4d38c49c7bba6840aa0e9038c7714812141fddb705' then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID: phase=pre, count=%, bytes=%, sha256=%',
      v_projected_canonical_public_routine_count,
      octet_length(v_projected_canonical_public_routine_payload),
      encode(sha256(convert_to(
        v_projected_canonical_public_routine_payload,'UTF8'
      )),'hex');
  end if;

  for v_signature in
    select unnest(v_browser_signatures)
  loop
    execute format(
      'revoke all privileges on function %s from public, anon',
      v_signature
    );
  end loop;

  -- Browser workflow mutations must not become an alternative service-role
  -- bypass. Service endpoints use their dedicated tenant-bound RPCs.
  for v_signature in
    select unnest(v_browser_write_signatures)
  loop
    execute format(
      'revoke all privileges on function %s from service_role',
      v_signature
    );
  end loop;
  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(v_browser_signatures) expected(signature)
  where has_function_privilege('anon', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_ANON_EXECUTE_PRESENT: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(v_browser_write_signatures) expected(signature)
  where has_function_privilege('service_role', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_WRITE_SERVICE_EXECUTE_PRESENT: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(v_browser_signatures) expected(signature)
  where not has_function_privilege('authenticated', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_AUTHENTICATED_EXECUTE_MISSING: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(v_browser_helper_signatures) expected(signature)
  where not has_function_privilege('service_role', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_HELPER_SERVICE_EXECUTE_MISSING: %', v_missing;
  end if;

  -- Effective privilege checks above prove the runtime behavior. This raw ACL
  -- matrix additionally proves that access is direct, non-grantable, issued by
  -- the function owner, and contains no unexpected non-owner grantee.
  select string_agg(
    procedure_signature || ' -> ' || expected_grantee,
    ', ' order by procedure_signature, expected_grantee
  ) into v_missing
  from (values
    ('public.is_clinic_admin()', 'authenticated'),
    ('public.is_reception_or_admin()', 'authenticated'),
    ('public.is_practitioner()', 'authenticated'),
    ('public.is_appointment_operator()', 'authenticated'),
    ('public.is_appointment_practitioner()', 'authenticated'),
    ('public.is_admin_or_super()', 'authenticated'),
    ('public.current_user_role()', 'authenticated'),
    ('public.clinical_financial_handoffs_healthcheck()', 'authenticated'),
    ('public.department_persistence_healthcheck()', 'authenticated'),
    ('public.production_execution_healthcheck()', 'authenticated'),
    ('public.quality_release_healthcheck()', 'authenticated'),
    ('public.prescription_dispensing_healthcheck()', 'authenticated'),
    ('public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)', 'authenticated'),
    ('public.book_clinic_appointment(uuid,uuid,text,text,text)', 'authenticated'),
    ('public.cancel_clinic_appointment(uuid,text)', 'authenticated'),
    ('public.set_clinic_appointment_status(uuid,text,text)', 'authenticated'),
    ('public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)', 'authenticated'),
    ('public.decide_approval_task(uuid,text,text)', 'authenticated'),
    ('public.sign_clinical_record_complete(uuid,text,text,text)', 'authenticated'),
    ('public.unlock_clinical_record_for_amendment(uuid,text)', 'authenticated'),
    ('public.is_clinic_admin()', 'service_role'),
    ('public.is_reception_or_admin()', 'service_role'),
    ('public.is_practitioner()', 'service_role'),
    ('public.is_appointment_operator()', 'service_role'),
    ('public.is_appointment_practitioner()', 'service_role'),
    ('public.is_admin_or_super()', 'service_role'),
    ('public.current_user_role()', 'service_role'),
    ('public.clinical_financial_handoffs_healthcheck()', 'service_role'),
    ('public.department_persistence_healthcheck()', 'service_role'),
    ('public.production_execution_healthcheck()', 'service_role'),
    ('public.quality_release_healthcheck()', 'service_role'),
    ('public.prescription_dispensing_healthcheck()', 'service_role')
  ) expected(procedure_signature, expected_grantee)
  join pg_proc p on p.oid = to_regprocedure(procedure_signature)
  where not exists (
    select 1
    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    join pg_roles granted_role on granted_role.oid = acl.grantee
    where granted_role.rolname = expected_grantee
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
      and acl.grantor = p.proowner
  );
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_ACL_MISSING: %', v_missing;
  end if;

  select string_agg(
    procedure_signature || ' -> ' ||
      case when acl.grantee=0 then 'PUBLIC'
           when grantee.rolname is not null then grantee.rolname
           else 'OID:' || acl.grantee::text end ||
      ':' || acl.privilege_type,
    ', ' order by procedure_signature,
      case when acl.grantee=0 then 'PUBLIC'
           when grantee.rolname is not null then grantee.rolname
           else 'OID:' || acl.grantee::text end,
      acl.privilege_type
  ) into v_missing
  from unnest(v_browser_signatures) expected_procedure(procedure_signature)
  join pg_proc p on p.oid = to_regprocedure(procedure_signature)
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
  left join pg_roles grantee on acl.grantee<>0 and grantee.oid = acl.grantee
  where acl.grantee <> p.proowner
    and (
      acl.privilege_type <> 'EXECUTE'
      or acl.is_grantable
      or acl.grantor <> p.proowner
      or not exists (
        select 1
        from (values
          ('public.is_clinic_admin()', 'authenticated'),
          ('public.is_reception_or_admin()', 'authenticated'),
          ('public.is_practitioner()', 'authenticated'),
          ('public.is_appointment_operator()', 'authenticated'),
          ('public.is_appointment_practitioner()', 'authenticated'),
          ('public.is_admin_or_super()', 'authenticated'),
          ('public.current_user_role()', 'authenticated'),
          ('public.clinical_financial_handoffs_healthcheck()', 'authenticated'),
          ('public.department_persistence_healthcheck()', 'authenticated'),
          ('public.production_execution_healthcheck()', 'authenticated'),
          ('public.quality_release_healthcheck()', 'authenticated'),
          ('public.prescription_dispensing_healthcheck()', 'authenticated'),
          ('public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)', 'authenticated'),
          ('public.book_clinic_appointment(uuid,uuid,text,text,text)', 'authenticated'),
          ('public.cancel_clinic_appointment(uuid,text)', 'authenticated'),
          ('public.set_clinic_appointment_status(uuid,text,text)', 'authenticated'),
          ('public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)', 'authenticated'),
          ('public.decide_approval_task(uuid,text,text)', 'authenticated'),
          ('public.sign_clinical_record_complete(uuid,text,text,text)', 'authenticated'),
          ('public.unlock_clinical_record_for_amendment(uuid,text)', 'authenticated'),
          ('public.is_clinic_admin()', 'service_role'),
          ('public.is_reception_or_admin()', 'service_role'),
          ('public.is_practitioner()', 'service_role'),
          ('public.is_appointment_operator()', 'service_role'),
          ('public.is_appointment_practitioner()', 'service_role'),
          ('public.is_admin_or_super()', 'service_role'),
          ('public.current_user_role()', 'service_role'),
          ('public.clinical_financial_handoffs_healthcheck()', 'service_role'),
          ('public.department_persistence_healthcheck()', 'service_role'),
          ('public.production_execution_healthcheck()', 'service_role'),
          ('public.quality_release_healthcheck()', 'service_role'),
          ('public.prescription_dispensing_healthcheck()', 'service_role')
        ) expected_grant(expected_signature, expected_grantee)
        where expected_signature = procedure_signature
          and expected_grantee = case when acl.grantee=0 then 'PUBLIC'
            when grantee.rolname is not null then grantee.rolname
            else 'OID:' || acl.grantee::text end
      )
    );
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_ACL_INVALID: %', v_missing;
  end if;

  -- Ownership is part of the reviewed privilege boundary. Re-check it after
  -- every revoke so a passing ACL matrix cannot be minted by a rogue owner.
  select string_agg(
    signature || ' -> ' || coalesce(owner_role.rolname,'MISSING'),
    ', ' order by signature
  ) into v_missing
  from unnest(v_browser_signatures) expected(signature)
  left join pg_proc procedure on procedure.oid=to_regprocedure(signature)
  left join pg_roles owner_role on owner_role.oid=procedure.proowner
  where owner_role.rolname is distinct from 'postgres';
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_OWNER_INVALID: %', v_missing;
  end if;

  select
    coalesce(
      array_agg(signature order by signature collate "C")
        filter (where role_name='anon'),
      array[]::text[]
    ),
    coalesce(
      array_agg(signature order by signature collate "C")
        filter (where role_name='authenticated'),
      array[]::text[]
    ),
    coalesce(
      array_agg(signature order by signature collate "C")
        filter (where role_name='service_role'),
      array[]::text[]
    )
  into v_actual_anon_signatures,
       v_actual_authenticated_signatures,
       v_actual_service_signatures
  from (
    select runtime_role.role_name,
      function_namespace.nspname || '.' || procedure.proname || '(' ||
        replace(oidvectortypes(procedure.proargtypes),', ',',') || ')' signature
    from (values ('anon'),('authenticated'),('service_role'))
      runtime_role(role_name)
    join pg_proc procedure on true
    join pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where function_namespace.nspname='public'
      and has_schema_privilege(
        runtime_role.role_name,function_namespace.oid,'USAGE'
      )
      and has_function_privilege(
        runtime_role.role_name,procedure.oid,'EXECUTE'
      )
      and not exists (
        select 1
        from pg_depend dependency
        join pg_extension extension on extension.oid=dependency.refobjid
        where dependency.classid='pg_proc'::regclass
          and dependency.objid=procedure.oid
          and dependency.objsubid=0
          and dependency.refclassid='pg_extension'::regclass
          and dependency.deptype='e'
      )
  ) effective_application_routines;
  if v_actual_anon_signatures is distinct from array[]::text[] then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_ANON_EFFECTIVE_SIGNATURES_INVALID: %',
      v_actual_anon_signatures;
  end if;
  if v_actual_authenticated_signatures is distinct from
       v_expected_authenticated_signatures then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_AUTHENTICATED_EFFECTIVE_SIGNATURES_INVALID: actual=%, expected=%',
      v_actual_authenticated_signatures,v_expected_authenticated_signatures;
  end if;
  if v_actual_service_signatures is distinct from
       v_expected_service_signatures then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_SERVICE_EFFECTIVE_SIGNATURES_INVALID: actual=%, expected=%',
      v_actual_service_signatures,v_expected_service_signatures;
  end if;

  -- Re-bind function implementations after mutation.
  select count(*)::bigint,
    coalesce(string_agg(semantic_row,E'\n' order by semantic_row collate "C"),'') || E'\n'
  into v_function_semantic_count,v_function_semantic_payload
  from (
    select jsonb_build_array(
      'cnyos-browser-rpc-function/v1',
      function_namespace.nspname,
      procedure.proname,
      pg_get_function_identity_arguments(procedure.oid),
      pg_get_function_arguments(procedure.oid),
      pg_get_function_result(procedure.oid),
      owner_role.rolname,
      language.lanname,
      procedure.prokind::text,
      procedure.prosecdef,
      procedure.proleakproof,
      procedure.proisstrict,
      procedure.proretset,
      procedure.provolatile::text,
      procedure.proparallel::text,
      procedure.procost::text,
      procedure.prorows::text,
      case when procedure.provariadic=0 then null
           else format_type(procedure.provariadic,null) end,
      case when procedure.prosupport=0 then null
           else support_namespace.nspname || '.' || support_function.proname || '(' ||
                pg_get_function_identity_arguments(support_function.oid) || ')' end,
      procedure.pronargs,
      procedure.pronargdefaults,
      to_jsonb(procedure.proargmodes),
      to_jsonb(procedure.proargnames),
      (
        select jsonb_agg(format_type(argument_type,null) order by argument.ordinality)
        from unnest(procedure.proallargtypes) with ordinality
          argument(argument_type,ordinality)
      ),
      (
        select jsonb_agg(format_type(transform_type,null) order by transform.ordinality)
        from unnest(procedure.protrftypes) with ordinality
          transform(transform_type,ordinality)
      ),
      to_jsonb(procedure)->'proargdefaults',
      procedure.prosrc,
      procedure.probin,
      to_jsonb(procedure)->'prosqlbody',
      to_jsonb(procedure.proconfig)
    )::text semantic_row
    from unnest(v_browser_signatures) expected(signature)
    join pg_proc procedure on procedure.oid=to_regprocedure(expected.signature)
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    join pg_roles owner_role on owner_role.oid=procedure.proowner
    join pg_language language on language.oid=procedure.prolang
    left join pg_proc support_function on support_function.oid=procedure.prosupport
    left join pg_namespace support_namespace
      on support_namespace.oid=support_function.pronamespace
  ) reviewed_browser_functions;
  if v_function_semantic_count <> 20
     or octet_length(v_function_semantic_payload) <> 30326
     or encode(sha256(convert_to(v_function_semantic_payload,'UTF8')),'hex') <>
        'a9d23d5e9225fd4f9a0757affdc8dbacb38d6f2efdc6fc95a59d2dcba600e4b8' then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_RPC_FUNCTION_SEMANTICS_INVALID: count=%, bytes=%, sha256=%',
      v_function_semantic_count,octet_length(v_function_semantic_payload),
      encode(sha256(convert_to(v_function_semantic_payload,'UTF8')),'hex');
  end if;

  select count(*)::bigint,
    coalesce(string_agg(inventory_row,E'\n' order by inventory_row collate "C"),'') || E'\n'
  into v_projected_canonical_public_routine_count,
       v_projected_canonical_public_routine_payload
  from (
    select jsonb_build_array(
      'cnyos-public-routine-acl/v2',
      function_namespace.nspname,
      procedure.proname,
      pg_get_function_identity_arguments(procedure.oid),
      owner_role.rolname,
      procedure.prokind::text,
      procedure.prosecdef,
      has_schema_privilege('anon',function_namespace.oid,'USAGE') and
        has_function_privilege('anon',procedure.oid,'EXECUTE'),
      has_schema_privilege('authenticated',function_namespace.oid,'USAGE') and
        has_function_privilege('authenticated',procedure.oid,'EXECUTE'),
      has_schema_privilege('service_role',function_namespace.oid,'USAGE') and
        has_function_privilege('service_role',procedure.oid,'EXECUTE'),
      coalesce((
        select jsonb_agg(
          jsonb_build_array(
            case when acl.grantee=0 then 'PUBLIC'
                 when grantee_role.rolname is not null then grantee_role.rolname
                 else 'OID:' || acl.grantee::text end,
            acl.privilege_type,
            acl.is_grantable,
            case when grantor_role.rolname is not null then grantor_role.rolname
                 else 'OID:' || acl.grantor::text end
          ) order by
            (case when acl.grantee=0 then 'PUBLIC'
                  when grantee_role.rolname is not null then grantee_role.rolname
                  else 'OID:' || acl.grantee::text end) collate "C",
            acl.privilege_type collate "C",
            acl.is_grantable,
            (case when grantor_role.rolname is not null then grantor_role.rolname
                  else 'OID:' || acl.grantor::text end) collate "C"
        )
        from aclexplode(coalesce(
          procedure.proacl,acldefault('f',procedure.proowner)
        )) acl
        left join pg_roles grantee_role
          on acl.grantee<>0 and grantee_role.oid=acl.grantee
        left join pg_roles grantor_role on grantor_role.oid=acl.grantor
      ),'[]'::jsonb)
    )::text inventory_row
    from pg_proc procedure
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    join pg_roles owner_role on owner_role.oid=procedure.proowner
    where function_namespace.nspname='public'
      and not exists (
        select 1
        from pg_depend dependency
        join pg_extension extension on extension.oid=dependency.refobjid
        where dependency.classid='pg_proc'::regclass
          and dependency.objid=procedure.oid
          and dependency.objsubid=0
          and dependency.refclassid='pg_extension'::regclass
          and dependency.deptype='e'
      )
  ) projected_canonical_public_routine_manifest;
  if v_projected_canonical_public_routine_count <> 146
     or octet_length(v_projected_canonical_public_routine_payload) <> 41743
     or encode(sha256(convert_to(
          v_projected_canonical_public_routine_payload,'UTF8'
        )),'hex') <>
        '6569ee52b64662ff6fd8ccfe26ecb7e4abe4b71165213797ead3ca5f72fa7581' then
    raise exception
      'CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID: phase=post, count=%, bytes=%, sha256=%',
      v_projected_canonical_public_routine_count,
      octet_length(v_projected_canonical_public_routine_payload),
      encode(sha256(convert_to(
        v_projected_canonical_public_routine_payload,'UTF8'
      )),'hex');
  end if;

  -- Deliberately emit no success-shaped output here. A deferred constraint can
  -- still reject COMMIT, so acceptance requires a zero-exit client transcript
  -- plus an independent post-commit inventory.
exception
  when others then
    perform pg_catalog.pg_advisory_unlock(202608302100::bigint);
    raise;
end $$;

commit;

do $cnyos_acl_interlock$
begin
  if not pg_catalog.pg_advisory_unlock(202608302100::bigint) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED';
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
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED';
  end if;
end
$cnyos_acl_interlock$;
