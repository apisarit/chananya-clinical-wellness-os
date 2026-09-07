import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANANYA_REVIEWED_SYSTEM_IDENTIFIER,
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST,
  CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE,
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST,
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST,
  MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION,
  MIGRATION_LEDGER_ACL_PHASE_STRICT,
  buildMigrationLedgerSchemaGuardSql,
  isExactReviewedChananyaStagingTarget,
  loadMigrationEntries
} from './generate-migration-ledger-repair-sql.mjs';
import { validateTenantConfig } from './generate-tenant-config.mjs';

export const strictVerificationStatus =
  'CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_NOT_AUTHORIZED';
export const targetUnverifiedStrictVerificationStatus =
  'CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_' +
  'TARGET_UNVERIFIED_NOT_AUTHORIZED';
export const preReconciliationVerificationStatus =
  'CNYOS_CHANANYA_PUBLIC_ROUTINE_ACL_CLASSIFIED_COMPLETE_NOT_AUTHORIZED';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerGuardTerminator = 'end\n$ledger_guard$;\n';
const blockingVerificationSessionLock =
  'select pg_catalog.pg_advisory_lock(202608302100::bigint);\n';
const verificationSessionLockAbsentPredicate = `not exists (
  select 1
  from pg_catalog.pg_locks
  where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted
    and classid::bigint=(202608302100::bigint >> 32)
    and objid::bigint=(202608302100::bigint & 4294967295::bigint)
    and objsubid=1
)`;
const boundedVerificationSessionLock = `\\unset cnyos_verification_lock_unheld
\\unset cnyos_verification_lock_acquired
select ${verificationSessionLockAbsentPredicate} as cnyos_verification_lock_unheld
\\gset
\\if :cnyos_verification_lock_unheld
\\else
\\warn 'CNYOS staging verification requires the advisory key to be unheld by this session'
do $cnyos_verification_lock_state_abort$
begin
  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_ALREADY_HELD';
end
$cnyos_verification_lock_state_abort$;
\\endif
select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_verification_lock_acquired
\\gset
\\if :cnyos_verification_lock_acquired
\\else
\\warn 'CNYOS staging verification advisory key is busy; refusing rather than waiting'
do $cnyos_verification_lock_abort$
begin
  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_UNAVAILABLE';
end
$cnyos_verification_lock_abort$;
\\endif
`;

export function buildMigrationLedgerVerificationSql({
  config,
  entries = loadMigrationEntries(root),
  sourceRevision = '',
  aclPhase = MIGRATION_LEDGER_ACL_PHASE_STRICT
}) {
  const target = validateTenantConfig(config);
  const targetDatabaseUrl = new URL(target.database.url);
  const rawGuardSql = buildMigrationLedgerSchemaGuardSql({
    config: target,
    entries,
    sourceRevision,
    aclPhase
  });
  const blockingSessionLockCount =
    rawGuardSql.split(blockingVerificationSessionLock).length - 1;
  if (blockingSessionLockCount !== 1) {
    throw new Error(
      'Generated verification SQL does not contain exactly one expected session lock'
    );
  }
  const guardSql = rawGuardSql.replace(
    blockingVerificationSessionLock,
    boundedVerificationSessionLock
  );
  const guardEnd = guardSql.indexOf(ledgerGuardTerminator);
  if (guardEnd < 0) {
    throw new Error('Generated schema SQL does not contain the expected guard terminator');
  }

  const isChananyaPreReconciliation =
    aclPhase === MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION;
  const expectedProjectRef = targetDatabaseUrl.hostname.replace(/\.supabase\.co$/, '');
  const expectedDatabaseName = 'postgres';
  const expectedDatabaseUser = 'postgres';
  const hasReviewedSystemIdentifier = isExactReviewedChananyaStagingTarget(target);
  const status = isChananyaPreReconciliation
    ? preReconciliationVerificationStatus
    : hasReviewedSystemIdentifier
      ? strictVerificationStatus
      : targetUnverifiedStrictVerificationStatus;
  const evidence = {
    status,
    expected_deployment_id: target.deploymentId,
    expected_clinic_code: target.tenant.expectedClinicCode,
    expected_clinic_id: target.tenant.expectedClinicId,
    expected_project_ref: expectedProjectRef,
    expected_database_origin: targetDatabaseUrl.origin,
    expected_database_host: `db.${expectedProjectRef}.supabase.co`,
    expected_current_database: expectedDatabaseName,
    expected_session_user: expectedDatabaseUser,
    expected_current_user: expectedDatabaseUser,
    migration_count: entries.length,
    source_revision: String(sourceRevision).trim().toLowerCase(),
    acl_phase: aclPhase,
    acl_remediation_pending: isChananyaPreReconciliation,
    browser_rpc_acl_remediation_pending: isChananyaPreReconciliation,
    trigger_function_acl_remediation_pending: isChananyaPreReconciliation,
    repository_derived_treatment_session_acl_manifest_sha256:
      REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256,
    repository_derived_treatment_session_acl_provenance:
      REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.provenance,
    repository_derived_treatment_session_public_execute_debt_pending:
      isChananyaPreReconciliation,
    target_identity_verified: hasReviewedSystemIdentifier,
    target_identity_verification: hasReviewedSystemIdentifier
      ? 'system-identifier-enforced'
      : 'target-unverified-system-identifier-unpinned',
    authorization: false,
    ledger_reconciliation_authorized: false,
    live_callable_acl_inventory_complete: isChananyaPreReconciliation,
    classification_coverage_complete: isChananyaPreReconciliation,
    independent_security_review_complete: false,
    managed_supabase_admin_exception_accepted: false,
    security_definer_path_plan_approved: false,
    hosted_concurrency_protocol_approved: false,
    hosted_trigger_relation_lock_plan_rehearsed: false,
    fresh_post_commit_observer_required: isChananyaPreReconciliation,
    fresh_post_commit_observer_completed: false,
    ledger_reconciliation_blocked_pending_independent_review_and_authorization: true,
    ledger_reconciled: false,
    production_eligible: false,
    rollback_required: true
  };
  if (isChananyaPreReconciliation) {
    evidence.reviewed_pre_reconciliation_evidence_bundle_sha256 =
      CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.sha256;
    evidence.evidence_source_revision =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationSourceRevision;
    evidence.observer_raw_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerRawSha256;
    evidence.observer_source_sql_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerSourceSqlSha256;
    evidence.observation_composite_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationCompositeSha256;
    evidence.disposition_artifact_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionArtifactSha256;
    evidence.disposition_payload_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionPayloadSha256;
    evidence.complete_acl_candidate_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.completeAclCandidateSha256;
    evidence.classified_public_routine_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.routineCount;
    evidence.classified_authenticated_only_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.authenticated_only.length;
    evidence.classified_authenticated_and_service_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.authenticated_and_service.length;
    evidence.classified_service_only_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.service_only.length;
    evidence.classified_owner_only_ordinary_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.owner_only_ordinary.length;
    evidence.classified_owner_only_trigger_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.owner_only_trigger.length;
    evidence.classified_owner_only_event_trigger_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .routineDispositions.owner_only_event_trigger.length;
    evidence.desired_effective_authenticated_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .desiredEffectiveExecute.authenticated;
    evidence.desired_effective_service_role_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .desiredEffectiveExecute.service_role;
    evidence.current_raw_acl_matrix_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.currentRawAclMatrix.sha256;
    evidence.current_effective_access_matrix_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .currentEffectiveAccessMatrix.sha256;
    evidence.desired_effective_access_matrix_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .desiredEffectiveAccessMatrix.sha256;
    evidence.security_definer_path_plan_count =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.count;
    evidence.security_definer_path_plan_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.sha256;
    evidence.reviewed_trigger_binding_count =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingCount;
    evidence.reviewed_trigger_binding_dataset_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingDatasetSha256;
    evidence.reviewed_trigger_binding_identity_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingIdentitySha256;
    evidence.reviewed_trigger_binding_stable_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingStableSha256;
    evidence.trigger_relation_lock_plan_count =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanCount;
    evidence.trigger_relation_lock_plan_payload_bytes =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .triggerRelationLockPlanPayloadBytes;
    evidence.trigger_relation_lock_plan_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanSha256;
    evidence.reviewed_event_trigger_binding_count =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingCount;
    evidence.reviewed_event_trigger_binding_dataset_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .eventTriggerBindingDatasetSha256;
    evidence.reviewed_event_trigger_binding_identity_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .eventTriggerBindingIdentitySha256;
    evidence.reviewed_event_trigger_binding_stable_sha256 =
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .eventTriggerBindingStableSha256;
    evidence.post_toggle_default_acl_evidence_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .postToggleDefaultAclBaseline.externalEvidenceSha256;
    evidence.ledger_target_baseline_evidence_sha256 =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .ledgerTargetBaseline.externalEvidenceSha256;
    evidence.observed_ledger_migration_count_at_baseline =
      CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
        .ledgerTargetBaseline.chananyaObservedMigrationCount;
    evidence.hosted_postgres_superuser = false;
    evidence.protected_catalog_share_lock_supported = false;
  }

  // Capture evidence inside the verified read-only snapshot, but do not emit a
  // success-shaped result until ROLLBACK and the checked session-lock release.
  return guardSql.slice(0, guardEnd) +
    ledgerGuardTerminator +
    `\\unset cnyos_verification_evidence\n` +
    `select (\n` +
    `  ${quote(JSON.stringify(evidence))}::jsonb || pg_catalog.jsonb_build_object(\n` +
    `    'expected_system_identifier',${hasReviewedSystemIdentifier ? quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER) : 'null'},\n` +
    `    'observed_system_identifier',(select system_identifier::text from pg_catalog.pg_control_system()),\n` +
    `    'observed_current_database',pg_catalog.current_database(),\n` +
    `    'observed_session_user',session_user,\n` +
    `    'observed_current_user',current_user,\n` +
    `    'observed_server_address',pg_catalog.inet_server_addr()::text,\n` +
    `    'observed_server_port',pg_catalog.inet_server_port(),\n` +
    `    'observed_ssl',(select ssl from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()),\n` +
    `    'observed_ssl_version',(select version from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()),\n` +
    `    'observed_ssl_cipher',(select cipher from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid())\n` +
    `  )\n` +
    `)::text as cnyos_verification_evidence\n` +
    `\\gset\n` +
    `rollback;\n` +
    `\\unset cnyos_verification_lock_released\n` +
    `select pg_catalog.pg_advisory_unlock(202608302100::bigint) as cnyos_verification_lock_released\n` +
    `\\gset\n` +
    `\\if :cnyos_verification_lock_released\n` +
    `\\unset cnyos_verification_lock_fully_released\n` +
    `select ${verificationSessionLockAbsentPredicate} as cnyos_verification_lock_fully_released\n` +
    `\\gset\n` +
    `\\if :cnyos_verification_lock_fully_released\n` +
    `select (\n` +
    `  :'cnyos_verification_evidence'::jsonb || pg_catalog.jsonb_build_object(\n` +
    `    'verification_transaction_rolled_back',true,\n` +
    `    'advisory_lock_released',true\n` +
    `  )\n` +
    `) as migration_ledger_verification_evidence;\n` +
    `\\else\n` +
    `do $cnyos_verification_unlock_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_UNLOCK_FAILED';\n` +
    `end\n` +
    `$cnyos_verification_unlock_abort$;\n` +
    `\\endif\n` +
    `\\else\n` +
    `do $cnyos_verification_unlock_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_UNLOCK_FAILED';\n` +
    `end\n` +
    `$cnyos_verification_unlock_abort$;\n` +
    `\\endif\n` +
    `\\unset cnyos_verification_probe_xid\n` +
    `\\unset cnyos_verification_existing_transaction\n` +
    `\\unset cnyos_verification_server_identity_ok\n` +
    `\\unset cnyos_verification_lock_unheld\n` +
    `\\unset cnyos_verification_lock_acquired\n` +
    `\\unset cnyos_verification_lock_released\n` +
    `\\unset cnyos_verification_lock_fully_released\n` +
    `\\unset cnyos_verification_evidence\n`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function main() {
  const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH;
  if (!source) {
    throw new Error('Pass an explicit staging tenant config path');
  }
  const configPath = path.resolve(root, source);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(buildMigrationLedgerVerificationSql({
    config,
    entries: loadMigrationEntries(root),
    sourceRevision: process.env.CLINICAL_OS_SOURCE_COMMIT || '',
    aclPhase: process.argv[3] || process.env.CNYOS_MIGRATION_LEDGER_ACL_PHASE ||
      MIGRATION_LEDGER_ACL_PHASE_STRICT
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
