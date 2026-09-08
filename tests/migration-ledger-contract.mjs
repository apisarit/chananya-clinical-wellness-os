import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST,
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST,
  MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION,
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST,
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';
import { buildTenantBootstrapSql } from '../scripts/generate-tenant-bootstrap-sql.mjs';
import {
  buildMigrationLedgerVerificationSql,
  preReconciliationVerificationStatus,
  strictVerificationStatus
} from '../scripts/generate-migration-ledger-verification-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'tenant.cnyos-staging.json'), 'utf8'));
const chananyaConfig = JSON.parse(await fs.readFile(path.join(root, 'config', 'tenant.chananya.json'), 'utf8'));
const entries = loadMigrationEntries(root);
const expectedOwnerControlMigrationHashes = new Map([
  ['202608311800_owner_subscription_control.sql', 'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'],
  ['202609010500_owner_drive_assignment.sql', '4dd57c65339b37a9e17aa388e65768a4de29949a3671cf2d9a07d6b65d63ccc7'],
  ['202609010600_owner_drive_backup_evidence.sql', '804b59ca0bc08e045683ba961b3af83ddcb07447e0932f6d765cfc42a6123de8'],
  ['202609010700_owner_control_historical_replay_guard.sql', '4d53620ca1cd20bf8d9288faf684ddf6d8fac5033ff0fd99da76a0e701d5d157'],
  ['202609010800_owner_subscription_concurrency.sql', '6d107c39307fc714fcf2b50425b5df6792b1063ac130969312975356b2a2378a'],
  ['202609010900_backup_restore_source_binding.sql', '4c2a4f2fb65eba3865825884f3e669ff59a03fcf4a271765b8cde8cd044fc234'],
  ['202609011000_owner_subscription_kill_switch_closure.sql', 'd94d5e83e22f7c88c43f1fbd5bf4d75dcc9cb2ec7618c14c4344eefd4dfe590a'],
  ['202609011100_owner_subscription_forward_only_guard.sql', '8d82eb555bf8e311aeb762ff597e5d896a1158fce78bfc410613665d3d7debf8'],
  ['202609011200_backup_terminal_run_guard.sql', 'a2ce8e32895e37952543debdd19f76df2b87706fbef05c987f56f7f1fbb51407'],
  ['202609011300_archive_delegate_execution_hardening.sql', 'f3bbdf8e9e8527dc1125c143e2bc8de6da42d5e1c3d6b19f0cb2db3ec9df89f7']
]);

assert.equal(entries.length, 45);
assert.deepEqual(entries, [...entries].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
assert.equal(config.tenant.expectedClinicId, '00000000-0000-4000-8000-00000000a001');
assert.ok(entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));
for (const [file, sha256] of expectedOwnerControlMigrationHashes) {
  assert.equal(
    entries.find(entry => entry.file === file)?.sha256,
    sha256,
    `${file} must keep its reviewed migration-ledger fingerprint`
  );
}

const repairAuthorizationBlockerStatement =
  "  raise exception 'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED: classified live ACL evidence is complete, but independent security review and explicit ledger repair authorization are required before any ledger repair';\n";

// Generated repair artifacts are deliberately inert until independent review,
// explicit authorization and hosted-like native rehearsal are complete.
// Behavioral tests may execute only an exact disposable copy with both
// independently enforced blockers removed.
function unblockRepairForDisposableTest(artifact, label) {
  assert.equal(
    artifact.split(repairAuthorizationBlockerStatement).length - 1,
    2,
    `${label} must carry the identical guard and mutation blockers`
  );
  return artifact.replaceAll(repairAuthorizationBlockerStatement, '');
}

const blockedStrictRecoverySql = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40)
});
const recoverySql = unblockRepairForDisposableTest(
  blockedStrictRecoverySql,
  'strict repair source artifact'
);
const preReconciliationRecoverySql = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40),
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});

const repairRunNonceGuc = 'cnyos.migration_ledger_repair_run_nonce';
const repairCommittedNonceGuc = 'cnyos.migration_ledger_repair_committed_nonce';
const repairCommittedXidGuc = 'cnyos.migration_ledger_repair_committed_xid';
const repairEvidenceMarker = 'cnyos_migration_ledger_repair_evidence';
const repairReceiptTable = 'cnyos_migration_ledger_repair_receipts';
const reviewedChananyaSystemIdentifier = '7666007964130682852';
const clinicalTreatmentSessionProcedure =
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.procedureSignature;
const canonicalCatalogOutputGucStatements = [
  "set local timezone = 'UTC';",
  "set local datestyle = 'ISO, YMD';",
  "set local intervalstyle = 'postgres';",
  'set local extra_float_digits = 3;',
  "set local bytea_output = 'hex';",
  'set local quote_all_identifiers = off;',
  'set local standard_conforming_strings = on;'
];
let pgliteSystemIdentifier;
let pgliteDatabaseIdentity;
let repairTestNonceOrdinal = 0;
const nextRepairTestNonce = () =>
  `00000000-0000-4000-8000-${String(++repairTestNonceOrdinal).padStart(12, '0')}`;
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

// The production artifacts must stay pinned to database/session/current user
// "postgres" and to the reviewed Chananya cluster. PGlite uses template1 as
// its database name, so bind only those exact identity comparisons/evidence
// literals in the disposable executable copy.
function bindProductionDatabaseIdentityForPGlite(artifact) {
  assert.ok(pgliteDatabaseIdentity);
  const database = sqlLiteral(pgliteDatabaseIdentity.database);
  const sessionUser = sqlLiteral(pgliteDatabaseIdentity.sessionUser);
  const currentUser = sqlLiteral(pgliteDatabaseIdentity.currentUser);
  return artifact
    .replaceAll(reviewedChananyaSystemIdentifier, pgliteSystemIdentifier)
    .replaceAll("pg_catalog.current_database() = 'postgres'", `pg_catalog.current_database() = ${database}`)
    .replaceAll("pg_catalog.current_database()='postgres'", `pg_catalog.current_database()=${database}`)
    .replaceAll("v_observed_current_database is distinct from 'postgres'", `v_observed_current_database is distinct from ${database}`)
    .replaceAll("v_observed_session_user is distinct from 'postgres'", `v_observed_session_user is distinct from ${sessionUser}`)
    .replaceAll("v_observed_current_user is distinct from 'postgres'", `v_observed_current_user is distinct from ${currentUser}`)
    .replaceAll("'expected_current_database','postgres'", `'expected_current_database',${database}`)
    .replaceAll("'expected_session_user','postgres'", `'expected_session_user',${sessionUser}`)
    .replaceAll("'expected_current_user','postgres'", `'expected_current_user',${currentUser}`)
    .replaceAll("receipt.evidence->>'expected_current_database'='postgres'", `receipt.evidence->>'expected_current_database'=${database}`)
    .replaceAll("receipt.evidence->>'expected_session_user'='postgres'", `receipt.evidence->>'expected_session_user'=${sessionUser}`)
    .replaceAll("receipt.evidence->>'expected_current_user'='postgres'", `receipt.evidence->>'expected_current_user'=${currentUser}`)
    .replaceAll("receipt.evidence->>'observed_current_database'='postgres'", `receipt.evidence->>'observed_current_database'=${database}`)
    .replaceAll("receipt.evidence->>'observed_session_user'='postgres'", `receipt.evidence->>'observed_session_user'=${sessionUser}`)
    .replaceAll("receipt.evidence->>'observed_current_user'='postgres'", `receipt.evidence->>'observed_current_user'=${currentUser}`)
    .replaceAll('"expected_current_database":"postgres"', `"expected_current_database":"${pgliteDatabaseIdentity.database}"`)
    .replaceAll('"expected_session_user":"postgres"', `"expected_session_user":"${pgliteDatabaseIdentity.sessionUser}"`)
    .replaceAll('"expected_current_user":"postgres"', `"expected_current_user":"${pgliteDatabaseIdentity.currentUser}"`);
}

// PGlite executes PostgreSQL, not psql metacommands. Preserve the generated
// artifact verbatim for the envelope assertions below, while materializing its
// SQL-bearing repair path with the client-generated nonce and session GUCs that
// psql would establish before entering the repair transaction.
function materializePsqlRepairArtifactForPGlite(artifact, runNonce) {
  assert.match(runNonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(pgliteSystemIdentifier, /^\d+$/);

  // PGlite has its own real PostgreSQL cluster identity. The source artifact
  // remains pinned to Chananya above; only the in-memory behavioral fixture is
  // rebound to the disposable cluster that is actually executing the SQL.
  const executableArtifact = bindProductionDatabaseIdentityForPGlite(artifact);

  const generatedStart = executableArtifact.indexOf('-- Generated one-time staging migration ledger recovery');
  const beginStart = executableArtifact.indexOf('begin isolation level repeatable read read write;', generatedStart);
  const guardStart = executableArtifact.indexOf('do $ledger_guard$', generatedStart);
  const guardEnd = executableArtifact.indexOf('end\n$ledger_guard$;\n', guardStart) +
    'end\n$ledger_guard$;\n'.length;
  const writeStart = executableArtifact.indexOf('do $ledger_repair$', guardEnd);
  const writeEnd = executableArtifact.indexOf('end\n$ledger_repair$;\n', writeStart) +
    'end\n$ledger_repair$;\n'.length;
  const commitStart = executableArtifact.indexOf('commit;\n', writeEnd);
  const commitEnd = commitStart + 'commit;\n'.length;
  const proofBeginStart = executableArtifact.indexOf(
    'begin isolation level repeatable read read only;',
    commitEnd
  );
  const proofQueryStart = executableArtifact.indexOf(
    'select case when count(*)=1 then min(receipt.evidence::text) end as cnyos_repair_evidence',
    proofBeginStart
  );
  const proofQueryEnd = executableArtifact.indexOf('\n\\gset\n', proofQueryStart);
  const gateToken = executableArtifact.slice(writeStart, writeEnd).match(
    /where gate_token='([0-9a-f]{64})' and run_nonce=v_run_nonce\n/
  )?.[1];

  assert.ok(
    generatedStart > 0 && beginStart > generatedStart && guardStart > beginStart &&
    guardEnd > guardStart &&
    writeStart > guardEnd && writeEnd > writeStart && commitStart === writeEnd &&
    proofBeginStart === commitEnd && proofQueryStart > proofBeginStart &&
    proofQueryEnd > proofQueryStart && gateToken,
    'generated psql repair artifact must retain its expected SQL envelope'
  );

  const setupSessionSql = `
    select pg_catalog.set_config('${repairRunNonceGuc}','${runNonce}',false);
    select pg_catalog.set_config('${repairCommittedNonceGuc}','',false);
    select pg_catalog.set_config('${repairCommittedXidGuc}','',false);
    select pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_host','db.hsmnjwxurlmsizndjlun.supabase.co',false);
    select pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_port','5432',false);
    select pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_user','postgres',false);
    select pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_database','postgres',false);
  `;
  const beforeTransactionSql = executableArtifact.slice(generatedStart, beginStart);
  const transactionPrefix = executableArtifact.slice(beginStart, guardStart);
  const guardStatement = executableArtifact.slice(guardStart, guardEnd);
  const writeStatement = executableArtifact.slice(writeStart, writeEnd);
  const commitStatement = executableArtifact.slice(commitStart, commitEnd);
  const proofPrefixSql = executableArtifact.slice(proofBeginStart, proofQueryStart)
    .replace(`\\unset cnyos_repair_evidence\n`, '');
  const exactProofQuery = executableArtifact.slice(proofQueryStart, proofQueryEnd)
    .replaceAll(":'cnyos_repair_run_nonce'", sqlLiteral(runNonce));
  const coreSql = executableArtifact.slice(generatedStart, commitEnd);
  const successEvidenceQuery = `
    select evidence as migration_ledger_evidence
    from supabase_migrations.${repairReceiptTable}
    where gate_token='${gateToken}'
      and run_nonce='${runNonce}'::uuid
      and evidence is not null
      and coalesce(current_setting('${repairCommittedNonceGuc}',true),'')='${runNonce}'
      and repair_xid=coalesce(current_setting('${repairCommittedXidGuc}',true),'')
      and evidence->>'repair_run_nonce'='${runNonce}'
      and evidence->>'repair_transaction_xid'=repair_xid
  `;
  assert.doesNotMatch(coreSql, /^\\/m);
  assert.doesNotMatch(coreSql, /:'cnyos_repair_/);
  assert.doesNotMatch(proofPrefixSql, /^\\/m);
  return {
    artifact,
    runNonce,
    gateToken,
    setupSessionSql,
    beforeTransactionSql,
    transactionPrefix,
    guardStatement,
    writeStatement,
    commitStatement,
    proofPrefixSql,
    exactProofQuery,
    successEvidenceQuery
  };
}

function materializePsqlVerificationArtifactForPGlite(artifact) {
  const executableArtifact = bindProductionDatabaseIdentityForPGlite(artifact);
  const generatedStart = executableArtifact.indexOf(
    '-- Generated read-only staging schema verification'
  );
  const guardStart = executableArtifact.indexOf('do $ledger_guard$', generatedStart);
  const guardEnd = executableArtifact.indexOf('end\n$ledger_guard$;\n', guardStart) +
    'end\n$ledger_guard$;\n'.length;
  assert.ok(
    generatedStart > 0 && guardStart > generatedStart && guardEnd > guardStart,
    'generated psql verification artifact must retain its expected SQL envelope'
  );
  // Execute the exact generated guard in PGlite, then append the same rollback
  // boundary. The subsequent evidence capture and psql lifecycle gate are
  // covered statically here and end-to-end by the PostgreSQL 17 psql test.
  const coreSql = executableArtifact.slice(generatedStart, guardEnd) + 'rollback;\n';
  assert.doesNotMatch(coreSql, /^\\/m);
  assert.doesNotMatch(coreSql, /:'cnyos_verification_/);
  return coreSql;
}

async function exactMaterializedRepairEvidenceRows(targetDb, materialized) {
  await targetDb.exec(materialized.proofPrefixSql);
  try {
    const rows = (await targetDb.query(materialized.exactProofQuery)).rows;
    assert.equal(rows.length, 1, 'the exact proof query must always return one row for psql \\gset');
    return rows[0].cnyos_repair_evidence === null
      ? []
      : [{ migration_ledger_evidence: JSON.parse(rows[0].cnyos_repair_evidence) }];
  } finally {
    await targetDb.exec('rollback;');
  }
}

async function executeMaterializedPsqlRepair(targetDb, artifact, runNonce) {
  const materialized = materializePsqlRepairArtifactForPGlite(artifact, runNonce);
  await targetDb.exec(materialized.setupSessionSql);
  await targetDb.exec(materialized.beforeTransactionSql);
  await targetDb.exec(materialized.transactionPrefix);
  await targetDb.exec(materialized.guardStatement);
  await targetDb.exec(materialized.writeStatement);
  await targetDb.exec(materialized.commitStatement);
  const evidenceRows = await exactMaterializedRepairEvidenceRows(targetDb, materialized);
  assert.equal(evidenceRows.length, 1, 'a committed repair must emit exactly one nonce-bound evidence row');
  assert.equal(evidenceRows[0].migration_ledger_evidence.repair_run_nonce, runNonce);
  assert.match(evidenceRows[0].migration_ledger_evidence.repair_transaction_xid, /^\d+$/);
  return evidenceRows[0].migration_ledger_evidence;
}

async function materializedRepairEvidenceRows(targetDb, materialized) {
  const receipt = (await targetDb.query(
    `select to_regclass('supabase_migrations.${repairReceiptTable}')::text receipt`
  )).rows[0].receipt;
  if (receipt === null) return [];
  return (await targetDb.query(materialized.successEvidenceQuery)).rows;
}

function injectMidRepairFailure(materialized, message = 'TEST_LEDGER_REPAIR_ABORT') {
  const anchor = '\nset constraints all immediate;\n  if (';
  const injectionOffset = materialized.writeStatement.indexOf(anchor);
  assert.ok(
    injectionOffset > materialized.writeStatement.indexOf(
      'insert into supabase_migrations.schema_migrations as ledger'
    ),
    'the test-only failure must be injected after the ledger upsert'
  );
  return {
    ...materialized,
    writeStatement:
      materialized.writeStatement.slice(0, injectionOffset) +
      `\nraise exception '${message}';` +
      materialized.writeStatement.slice(injectionOffset)
  };
}

const bootstrapSql = buildTenantBootstrapSql(config);
const chananyaBootstrapSql = buildTenantBootstrapSql(chananyaConfig);
assert.match(bootstrapSql, /insert into public\.clinics/i);
assert.match(bootstrapSql, /on conflict \(id\) do update/i);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
assert.match(bootstrapSql, /where clinics\.code = excluded\.code/i);
assert.match(bootstrapSql, /CLINICAL_OS_TENANT_BOOTSTRAP_READY/);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
assert.doesNotMatch(bootstrapSql, /^update public\.clinics/im);
assert.doesNotMatch(bootstrapSql, /`  active = true,/);
assert.match(recoverySql, /STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA/);
assert.match(recoverySql, /STAGING_SCHEMA_RELATIONS_MISSING/);
assert.match(recoverySql, /STAGING_SECURITY_DEFINERS_MISSING/);
assert.match(recoverySql, /public\.clinic_drive_backup_destinations/);
assert.match(recoverySql, /public\.clinic_drive_destination_events/);
assert.match(recoverySql, /public\.owner_control_historical_replay_guard/);
assert.match(recoverySql, /public\.list_owner_drive_assignments\(\)/);
assert.match(recoverySql, /public\.get_clinic_drive_backup_destination\(uuid,text\)/);
assert.match(recoverySql, /public\.set_clinic_drive_assignment\(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260831\(uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260829\(uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260828\(uuid,text\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260831\(uuid\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260829\(uuid\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260828\(uuid\)/);
assert.match(recoverySql, /public\.set_clinic_subscription_state\(uuid,uuid,text,boolean,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.set_clinic_subscription_state_v20260901\(uuid,uuid,text,boolean,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.guard_owner_subscription_forward_only\(\)/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_CONCURRENCY_IMPLEMENTATION_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_GUARD_INVALID/);
assert.match(recoverySql, /trg_clinics_owner_subscription_forward_only/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_TRIGGER_INVALID/);
assert.match(recoverySql, /public\.practitioner_schedules/);
assert.match(recoverySql, /public\.appointment_events/);
assert.match(recoverySql, /public\.approval_actions/);
assert.match(recoverySql, /practitioner_schedules\.clinic_id/);
assert.match(recoverySql, /clinic_appointments\.clinic_id/);
assert.match(recoverySql, /appointment_events\.clinic_id/);
assert.match(recoverySql, /approval_tasks\.clinic_id/);
assert.match(recoverySql, /approval_actions\.clinic_id/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID/);
assert.match(recoverySql, /public\.assert_clinic_subscription_active\(uuid\)/);
assert.match(recoverySql, /public\.prepare_line_subscription_off_exception\(uuid,text\)/);
assert.match(recoverySql, /public\.enforce_active_subscription_tenant_write\(\)/);
assert.match(recoverySql, /public\.book_clinic_appointment\(uuid,uuid,text,text,text\)/);
assert.match(recoverySql, /public\.create_approval_task\(text,text,text,text,text,text,uuid,timestamptz,jsonb\)/);
assert.ok(recoverySql.includes(clinicalTreatmentSessionProcedure));
assert.match(recoverySql, /STAGING_CLINICAL_TREATMENT_SESSION_SEMANTIC_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_CLINICAL_TREATMENT_SESSION_ACL_MISSING/);
assert.match(recoverySql, /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/);
assert.match(recoverySql, /STAGING_CLINICAL_TREATMENT_SESSION_ACL_INVALID/);
assert.match(recoverySql, /public\.consume_patient_identity_rate_limit_for_clinic\(uuid,text,integer,integer\)/);
assert.match(recoverySql, /public\.register_line_oa_webhook_event_for_clinic\(uuid,text,text,text,text,text,timestamptz,boolean,text\)/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_KILL_SWITCH_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_UNEXPECTED_ANON_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_LEGACY_PROCEDURE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT/);
assert.match(recoverySql, /public\.line_oa_queue_notification_v20260829\(uuid,text,timestamptz,timestamptz,text\)/);
assert.match(recoverySql, /public\.line_oa_register_gateway_v20260829\(text,text,text,text,text,timestamptz,boolean,text\)/);
assert.match(recoverySql, /STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/);
assert.match(recoverySql, /STAGING_SENSITIVE_CLOSED_PROCEDURE_RUNTIME_OWNER/);
assert.match(recoverySql, /STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER/);
assert.match(recoverySql, /STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_SENSITIVE_RELATION_OWNER_MISMATCH/);
assert.match(recoverySql, /public\.line_oa_operational_healthcheck\(\)/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_UNEXPECTED_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_BODY_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_RPC_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_SERVICE_RPC_GATE_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING/);
assert.match(recoverySql, /STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING/);
assert.match(recoverySql, /trg_cnyos_authenticated_subscription_statement_write/);
assert.match(recoverySql, /public\.enforce_authenticated_subscription_statement_write\(\)/);
assert.match(recoverySql, /STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_TRIGGER_INVALID/);
assert.match(recoverySql, /trg_cnyos_active_subscription_write/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_WRITE_TRIGGER_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_SEQUENCE_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_COLUMN_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_OWNER_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_RUNTIME_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/);
assert.match(recoverySql, /STAGING_UNGUARDED_SERVICE_ROLE_DML_PRESENT/);
assert.match(recoverySql, /STAGING_CURRENT_CLINIC_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_CURRENT_DEPARTMENT_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_CURRENT_ACCESS_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_WRITE_GUARD_INVALID/);
assert.match(recoverySql, /STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_GUARD_INVALID/);
assert.match(recoverySql, /STAGING_LINE_OFF_EXCEPTION_CAPABILITY_INVALID/);
assert.match(recoverySql, /STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_LINE_FINISH_WEBHOOK_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_LINE_FINISH_NOTIFICATION_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_BROWSER_SECURITY_DEFINER_SUBSCRIPTION_GATE_MISSING/);
assert.match(recoverySql, /public\.begin_backup_export_run\(uuid,timestamptz,text\)/);
assert.match(recoverySql, /public\.get_exact_backup_restore_source\(text,timestamptz,text\)/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_BACKUP_EXPORT_EVIDENCE_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_EVIDENCE_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID/);
assert.match(recoverySql, /STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT/);
assert.match(recoverySql, /clinic_subscription_control_events\.expected_version/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_EXPECTED_VERSION_INVALID/);
assert.match(recoverySql, /trg_clinic_subscription_control_events_append_only/);
assert.match(recoverySql, /trg_clinic_drive_destination_events_append_only/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_TRIGGER_INVALID/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_FUNCTION_INVALID/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_FUNCTION_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_RLS_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_ROW_MISSING/);
assert.match(recoverySql, /schema_version='2026-09-01\.1'/);
assert.match(recoverySql, /transaction_table_count=12/);
assert.match(recoverySql, /BACKUP_RESTORE_CONTRACT_MISMATCH/);
assert.match(recoverySql, /MIGRATION_LEDGER_SHA256_CONFLICT/);
assert.doesNotMatch(recoverySql, /statements=coalesce/);
assert.match(recoverySql, /supabase_migrations\.schema_migrations/);
assert.match(recoverySql, /statements text\[\]/);
assert.match(recoverySql, /name text/);
assert.match(recoverySql, /CNYOS_STAGING_MIGRATION_LEDGER_RECONCILED/);
assert.match(recoverySql, /'expected_deployment_id','chananya-clinical-staging'/);
assert.match(recoverySql, /'acl_phase','strict-post-remediation'/);
assert.match(recoverySql, /'acl_remediation_pending',false/);
assert.doesNotMatch(recoverySql, /\bREADY\b/);
assert.match(
  preReconciliationRecoverySql,
  /CNYOS_CHANANYA_CLASSIFIED_COMPLETE_LEDGER_REPAIR_NOT_AUTHORIZED/
);
assert.match(preReconciliationRecoverySql, /'acl_remediation_pending',true/);
assert.match(preReconciliationRecoverySql, /'ledger_reconciled',false/);
assert.match(preReconciliationRecoverySql, /'production_eligible',false/);
assert.match(
  preReconciliationRecoverySql,
  /CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED/
);
for (const [label, blockedArtifact] of [
  ['strict', blockedStrictRecoverySql],
  ['pre-reconciliation', preReconciliationRecoverySql]
]) {
  assert.equal(
    blockedArtifact.split(repairAuthorizationBlockerStatement).length - 1,
    2,
    `both the guard and repair DO blocks must independently refuse ${label} writes`
  );
  const blockedWriteBlock = blockedArtifact.slice(
    blockedArtifact.indexOf('do $ledger_repair$'),
    blockedArtifact.indexOf('end\n$ledger_repair$;')
  );
  assert.match(
    blockedWriteBlock,
    /^do \$ledger_repair\$\ndeclare\n(?:  v_[^\n]+;\n)+begin\n  raise exception 'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED:/
  );
  assert.doesNotMatch(
    blockedWriteBlock.slice(
      0,
      blockedWriteBlock.indexOf(
        'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED'
      )
    ),
    /:=|\b(?:select|perform|execute|insert|update|delete|create|alter|drop)\b/i,
    `${label} repair refusal must precede declaration initializers and every SQL action`
  );
}
assert.doesNotMatch(
  recoverySql,
  /CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED/
);
assert.match(preReconciliationRecoverySql, /'live_callable_acl_inventory_complete',true/);
assert.match(preReconciliationRecoverySql, /'classification_coverage_complete',true/);
assert.match(preReconciliationRecoverySql, /'authorization',false/);
assert.doesNotMatch(preReconciliationRecoverySql, /'authorization',true/);
assert.match(preReconciliationRecoverySql, /'hosted_concurrency_protocol_approved',false/);
assert.match(
  preReconciliationRecoverySql,
  /'hosted_trigger_relation_lock_plan_rehearsed',false/
);
assert.match(preReconciliationRecoverySql, /'fresh_post_commit_observer_required',true/);
assert.match(preReconciliationRecoverySql, /'fresh_post_commit_observer_completed',false/);
assert.match(
  preReconciliationRecoverySql,
  /'classified_public_routine_count',147/
);
assert.match(
  preReconciliationRecoverySql,
  new RegExp(
    `'trigger_relation_lock_plan_count',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanCount}`
  )
);
assert.match(
  preReconciliationRecoverySql,
  new RegExp(
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanSha256
  )
);
assert.doesNotMatch(preReconciliationRecoverySql, /transitional_observation_manifest_sha256/);
assert.match(
  preReconciliationRecoverySql,
  /'ledger_reconciliation_blocked_pending_independent_review_and_authorization',true/
);
assert.match(
  preReconciliationRecoverySql,
  /'repository_derived_treatment_session_public_execute_debt_pending',true/
);
assert.match(
  recoverySql,
  /'repository_derived_treatment_session_public_execute_debt_pending',false/
);
assert.match(
  preReconciliationRecoverySql,
  new RegExp(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.currentRawAclMatrix.sha256)
);
assert.doesNotMatch(preReconciliationRecoverySql, /\bREADY\b/);
assert.match(recoverySql, /STAGING_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_TRIGGER_FUNCTION_INVENTORY_OR_STATE_INVALID/);
assert.match(preReconciliationRecoverySql, /CNYOS_CLASSIFIED_ACL_CURRENT_RAW_MATRIX_INVALID/);
assert.match(preReconciliationRecoverySql, /CNYOS_CLASSIFIED_ACL_CURRENT_EFFECTIVE_MATRIX_INVALID/);
assert.match(preReconciliationRecoverySql, /CNYOS_CLASSIFIED_ACL_DESIRED_MATRIX_INVALID/);
assert.match(
  recoverySql,
  /execute 'drop table if exists pg_temp\.cnyos_migration_ledger_repair_evidence';/
);
assert.match(recoverySql, /do \$ledger_repair\$/);
assert.match(recoverySql, /STAGING_LEDGER_REPAIR_GUARD_REQUIRED/);
assert.match(
  recoverySql,
  /select case when count\(\*\)=1 then min\(receipt\.evidence::text\) end as cnyos_repair_evidence/
);
assert.match(recoverySql, /select :'cnyos_repair_evidence'::jsonb as migration_ledger_evidence/);
assert.match(
  recoverySql.slice(recoverySql.lastIndexOf('\ncommit;\n')),
  /from supabase_migrations\.schema_migrations/
);
for (const [repairPhase, repairArtifact] of [
  ['strict', blockedStrictRecoverySql],
  ['pre-reconciliation', preReconciliationRecoverySql]
]) {
  assert.match(repairArtifact, /^\\set ON_ERROR_STOP 1$/m);
  assert.match(repairArtifact, /^\\set ON_ERROR_ROLLBACK off$/m);
  assert.match(repairArtifact, /^\\if :AUTOCOMMIT$/m);
  assert.match(repairArtifact, /CNYOS ledger repair requires psql AUTOCOMMIT=on/);
  assert.match(repairArtifact, /pg_catalog\.pg_current_xact_id\(\)::text as cnyos_repair_probe_xid/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED/);
  assert.match(repairArtifact, /pg_catalog\.gen_random_uuid\(\)::text as cnyos_repair_run_nonce/);
  assert.match(repairArtifact, /'cnyos\.migration_ledger_repair_run_nonce'/);
  assert.match(repairArtifact, /'cnyos\.migration_ledger_repair_committed_nonce'/);
  assert.match(repairArtifact, /'cnyos\.migration_ledger_repair_committed_xid'/);
  assert.match(repairArtifact, /primary key \(gate_token,run_nonce,repair_xid\)/);
  assert.match(repairArtifact, new RegExp(reviewedChananyaSystemIdentifier));
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_WRONG_CLUSTER/);
  assert.match(repairArtifact, /v_observed_current_database is distinct from 'postgres'/);
  assert.match(repairArtifact, /'expected_project_ref','hsmnjwxurlmsizndjlun'/);
  assert.match(repairArtifact, /'expected_database_origin','https:\/\/hsmnjwxurlmsizndjlun\.supabase\.co'/);
  assert.match(repairArtifact, /'expected_clinic_code','CHANANYA-STG'/);
  assert.match(repairArtifact, /'expected_clinic_id','00000000-0000-4000-8000-00000000a001'/);
  assert.match(repairArtifact, /'observed_system_identifier',v_observed_system_identifier/);
  assert.match(repairArtifact, /'observed_ssl',\(select ssl from pg_catalog\.pg_stat_ssl/);
  assert.match(repairArtifact, /'repair_transaction_xid',v_repair_xid/);
  assert.doesNotMatch(repairArtifact, /'project_ref','hsmnjwxurlmsizndjlun'/);
  assert.doesNotMatch(repairArtifact, /'database_origin','https:\/\/hsmnjwxurlmsizndjlun\.supabase\.co'/);
  assert.doesNotMatch(repairArtifact, /'deployment_id','chananya-clinical-staging'/);
  assert.doesNotMatch(repairArtifact, /'clinic_code','CHANANYA-STG'/);
  assert.doesNotMatch(
    repairArtifact,
    /'clinic_id','00000000-0000-4000-8000-00000000a001'/
  );
  assert.match(
    repairArtifact,
    /perform set_config\('cnyos\.migration_ledger_repair_committed_nonce',v_run_nonce::text,false\);/
  );
  assert.match(
    repairArtifact,
    /perform set_config\('cnyos\.migration_ledger_repair_committed_xid',v_repair_xid,false\);/
  );
  assert.match(repairArtifact, /evidence->>'repair_transaction_xid'=repair_xid/);
  assert.match(repairArtifact, /CNYOS ledger repair committed state failed durable proof/);
  const autocommitCheck = repairArtifact.indexOf('\\if :AUTOCOMMIT');
  for (const variable of [
    'cnyos_repair_probe_xid',
    'cnyos_repair_existing_transaction',
    'cnyos_repair_session_nonce',
    'cnyos_repair_committed_nonce',
    'cnyos_repair_committed_xid',
    'cnyos_repair_connection_ok',
    'cnyos_repair_server_identity_ok',
    'cnyos_repair_evidence',
    'cnyos_repair_lock_unheld',
    'cnyos_repair_lock_acquired',
    'cnyos_repair_lock_released',
    'cnyos_repair_lock_fully_released',
    'cnyos_repair_run_nonce'
  ]) {
    const firstUnset = repairArtifact.indexOf(`\\unset ${variable}`);
    assert.ok(
      firstUnset >= 0 && firstUnset < autocommitCheck,
      `${variable} must be cleared before every psql refusal branch`
    );
  }
  assert.match(
    repairArtifact,
    /\\else\n\\warn 'CNYOS ledger repair requires psql AUTOCOMMIT=on; rolling back and refusing execution'\nrollback;\ndo \$cnyos_psql_preflight_abort\$\nbegin\n  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED';\nend\n\$cnyos_psql_preflight_abort\$;\n\\endif/
  );
  assert.match(
    repairArtifact,
    /\\if :cnyos_repair_existing_transaction\n\\warn 'CNYOS ledger repair detected and rolled back an existing transaction; refusing execution'\nrollback;\ndo \$cnyos_psql_preflight_abort\$\nbegin\n  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED';\nend\n\$cnyos_psql_preflight_abort\$;\n\\endif/
  );
  assert.match(
    repairArtifact,
    /select not exists \([\s\S]*from pg_catalog\.pg_locks[\s\S]*pid=pg_catalog\.pg_backend_pid\(\)[\s\S]*objsubid=1\n\) as cnyos_repair_lock_unheld\n\\gset\n\\if :cnyos_repair_lock_unheld\n\\else[\s\S]*CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD[\s\S]*\\endif/
  );
  assert.match(
    repairArtifact,
    /select pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\) as cnyos_repair_lock_acquired\n\\gset\n\\if :cnyos_repair_lock_acquired\n\\else[\s\S]*CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_BUSY[\s\S]*\\endif/
  );
  assert.equal(
    (repairArtifact.match(/pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\)/g) ?? []).length,
    1,
    `${repairPhase} repair must attempt its session lock exactly once without waiting`
  );
  assert.equal(
    (repairArtifact.match(/pg_catalog\.pg_advisory_lock\(202608302100::bigint\)/g) ?? []).length,
    0,
    `${repairPhase} repair must not use a blocking session advisory lock`
  );
  assert.equal(
    (repairArtifact.match(/pg_catalog\.pg_advisory_unlock\(202608302100::bigint\)/g) ?? []).length,
    2,
    `${repairPhase} repair must unlock in both post-COMMIT proof branches`
  );
  assert.equal(
    (repairArtifact.match(/\) as cnyos_repair_lock_fully_released/g) ?? []).length,
    2,
    `${repairPhase} repair must prove zero own holds after either unlock`
  );
  assert.match(
    repairArtifact,
    /\\if :cnyos_repair_lock_fully_released\nselect :'cnyos_repair_evidence'::jsonb as migration_ledger_evidence;/,
    `${repairPhase} repair must not emit evidence before proving zero own lock holds`
  );
  assert.doesNotMatch(repairArtifact, /^\\q(?:uit)?(?:\s|$)/m);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID/);
  assert.match(repairArtifact, /supabase_migrations\.cnyos_migration_ledger_repair_receipts/);
  assert.match(repairArtifact, /CNYOS_LEDGER_REPAIR_NONCE_REPLAY/);
  assert.match(
    repairArtifact,
    /pg_catalog\.pg_get_constraintdef\(actual\.oid,true\)=expected\.constraint_definition/
  );
  assert.match(repairArtifact, /CHECK \(gate_token ~ ''\^\[0-9a-f\]\{64\}\$''::text\)/);
  assert.match(repairArtifact, /CHECK \(repair_xid ~ ''\^\[0-9\]\+\$''::text\)/);
  assert.match(
    repairArtifact,
    /CHECK \(\(jsonb_typeof\(evidence\) = ''object''::text AND \(evidence ->> ''repair_gate_token''::text\) = gate_token AND \(evidence ->> ''repair_run_nonce''::text\) = run_nonce::text AND \(evidence ->> ''repair_transaction_xid''::text\) = repair_xid\) IS TRUE\)/
  );
  assert.match(repairArtifact, /begin isolation level repeatable read read only;/);
  assert.match(repairArtifact, /or actual\.statements is null/);
  assert.match(repairArtifact, /where statement\.value is null/);
  const repairBegin = repairArtifact.indexOf(
    'begin isolation level repeatable read read write;'
  );
  const transactionalMarkerReset = repairArtifact.indexOf(
    `drop table if exists pg_temp.${repairEvidenceMarker}`
  );
  const repairCommit = repairArtifact.indexOf('\ncommit;\n', repairBegin);
  const exactProofBegin = repairArtifact.indexOf(
    'begin isolation level repeatable read read only;',
    repairCommit
  );
  const guard = repairArtifact.indexOf('do $ledger_guard$', repairBegin);
  const exactProofCatalogRead = repairArtifact.indexOf(
    'lock table only supabase_migrations.schema_migrations in share mode;',
    exactProofBegin
  );
  let previousRepairSetting = repairBegin;
  let previousProofSetting = exactProofBegin;
  for (const setting of canonicalCatalogOutputGucStatements) {
    assert.equal(
      repairArtifact.split(setting).length - 1,
      2,
      `${repairPhase} repair must pin ${setting} in both repeatable-read transactions`
    );
    const repairSetting = repairArtifact.indexOf(setting, repairBegin);
    const proofSetting = repairArtifact.indexOf(setting, exactProofBegin);
    assert.ok(
      previousRepairSetting < repairSetting && repairSetting < guard,
      `${repairPhase} repair must pin ${setting} before guard catalog evidence and hashing`
    );
    assert.ok(
      previousProofSetting < proofSetting && proofSetting < exactProofCatalogRead,
      `${repairPhase} repair must pin ${setting} before post-COMMIT proof catalog reads`
    );
    previousRepairSetting = repairSetting;
    previousProofSetting = proofSetting;
  }
  const transactionModeCheck = repairArtifact.indexOf(
    "current_setting('transaction_isolation') <> 'repeatable read'",
    guard
  );
  const systemIdentityCheck = repairArtifact.indexOf(
    'if v_observed_system_identifier is distinct from',
    guard
  );
  const blocker = repairArtifact.indexOf(
    'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED',
    guard
  );
  const nonceCheck = repairArtifact.indexOf(
    'STAGING_LEDGER_REPAIR_RUN_NONCE_REQUIRED',
    guard
  );
  const writeBlock = repairArtifact.indexOf('do $ledger_repair$', guard);
  const mutationBlocker = repairArtifact.indexOf(
    'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED',
    writeBlock
  );
  const firstRepairDdl = repairArtifact.indexOf(
    "execute 'create schema if not exists supabase_migrations'",
    writeBlock
  );
  const firstRepairInsert = repairArtifact.indexOf(
    'insert into supabase_migrations.schema_migrations',
    writeBlock
  );
  assert.ok(
    repairArtifact.indexOf('CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED') <
      transactionalMarkerReset,
    'outer-transaction refusal must precede the destructive stale-marker reset'
  );
  assert.ok(
    guard < transactionModeCheck &&
      transactionModeCheck < systemIdentityCheck &&
      systemIdentityCheck < blocker &&
      blocker < nonceCheck &&
      blocker < repairArtifact.indexOf('v_repair_xid := pg_catalog.pg_current_xact_id()', guard) &&
      blocker < repairArtifact.indexOf('perform pg_catalog.pg_advisory_xact_lock', guard) &&
      blocker < transactionalMarkerReset &&
      blocker < repairArtifact.indexOf('select string_agg(procedure_signature', guard) &&
      blocker < repairArtifact.indexOf('from public.hybrid_patient_identity_healthcheck()', guard) &&
      blocker < repairArtifact.indexOf(`create temporary table ${repairEvidenceMarker}`, guard) &&
      blocker < writeBlock &&
      writeBlock < mutationBlocker &&
      mutationBlocker < firstRepairDdl &&
      mutationBlocker < firstRepairInsert,
    `${repairPhase} blockers must precede temp/durable DDL, DML, catalog/application checks, healthchecks, and every repair mutation`
  );
  assert.ok(
    repairArtifact.includes(
      `create temporary table ${repairEvidenceMarker} (gate_token text not null, run_nonce uuid not null, repair_xid text not null, evidence jsonb, primary key (gate_token,run_nonce,repair_xid)) on commit drop`
    ),
    'the transaction-bound evidence marker must be dropped automatically at commit'
  );
  assert.equal(
    repairArtifact.slice(repairCommit + '\ncommit;\n'.length, exactProofBegin),
    '',
    'no DDL may run between the repair commit and exact read-only proof'
  );
}
assert.match(recoverySql, /set local search_path = pg_catalog, pg_temp, public;/i);
for (const entry of entries) {
  assert.match(recoverySql, new RegExp(entry.version));
  assert.match(recoverySql, new RegExp(entry.sha256));
}
assert.doesNotMatch(recoverySql, /qptxnrldzzinlcabudjv|sb_secret_|service_role\s*[:=]\s*['"][A-Za-z0-9_.-]{10,}/i);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: { ...config, deploymentId: 'chananya-clinical-production' },
    entries
  }),
  /staging\/non-production/
);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config,
    entries: entries.map(entry => entry.file === '202608311800_owner_subscription_control.sql'
      ? { ...entry, sha256: '0'.repeat(64) }
      : entry)
  }),
  /Immutable historical migration SHA mismatch/
);

const db = new PGlite();
const pgliteIdentityRow = (await db.query(`
  select pg_catalog.current_database() database,
    session_user::text session_user,
    current_user::text current_user,
    (select system_identifier::text from pg_catalog.pg_control_system()) system_identifier
`)).rows[0];
pgliteSystemIdentifier = pgliteIdentityRow.system_identifier;
pgliteDatabaseIdentity = {
  database: pgliteIdentityRow.database,
  sessionUser: pgliteIdentityRow.session_user,
  currentUser: pgliteIdentityRow.current_user
};
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role authenticator login noinherit;
  grant anon,authenticated,service_role to authenticator;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to authenticated, service_role;
  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (
      substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||
      '-a'||substr(x,18,3)||'-'||substr(x,21,12)
    )::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2), 'hex')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`);

for (const entry of entries) {
  const source = (await fs.readFile(path.join(migrationsDir, entry.file), 'utf8'))
    .replace(/create extension if not exists pgcrypto\s*;/gi, '');
  await db.exec(source);
}

const trustedMigrationOwner = (await db.query(`
  select owner_role.rolname
  from pg_class c
  join pg_roles owner_role on owner_role.oid=c.relowner
  where c.oid=to_regclass('public.clinics')
`)).rows[0].rolname;
assert.match(trustedMigrationOwner, /^[a-z_][a-z0-9_$]*$/i);
const trustedMigrationOwnerSql = `"${trustedMigrationOwner.replaceAll('"', '""')}"`;
const trustedPublicSchemaOwner = (await db.query(`
  select owner_role.rolname
  from pg_namespace n
  join pg_roles owner_role on owner_role.oid=n.nspowner
  where n.nspname='public'
`)).rows[0].rolname;
assert.match(trustedPublicSchemaOwner, /^[a-z_][a-z0-9_$]*$/i);
const trustedPublicSchemaOwnerSql = `"${trustedPublicSchemaOwner.replaceAll('"', '""')}"`;

const LEGACY_CLINIC_ID = '00000000-0000-0000-0000-000000000001';
assert.equal(
  (await db.query('select count(*)::int count from public.clinics')).rows[0].count,
  0,
  'a pristine fresh migration chain must remove the historical clinic seed before tenant bootstrap'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_state where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  0,
  'a pristine fresh migration chain must remove the historical clinic-state seed'
);

await db.exec(chananyaBootstrapSql);
await db.exec(chananyaBootstrapSql);
assert.deepEqual(
  (await db.query('select id,code from public.clinics order by code')).rows,
  [{ id: LEGACY_CLINIC_ID, code: 'CHANANYA' }],
  'a fresh canonical deployment must still bootstrap exactly one CHANANYA clinic'
);
await db.exec(`
  delete from public.clinic_state where id='${LEGACY_CLINIC_ID}';
  delete from public.clinics where id='${LEGACY_CLINIC_ID}';
`);

const requiredServiceRolePrivileges = [
  ['profiles', ['SELECT', 'INSERT', 'UPDATE']],
  ['clinic_memberships', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_sources', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_concepts', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_concept_relations', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_diagnostic_knowledge', ['SELECT', 'INSERT', 'UPDATE']],
  ['audit_logs', ['SELECT', 'INSERT']],
  ['inventory_lots', ['SELECT', 'INSERT']],
  ['patient_qr_sessions', ['SELECT', 'UPDATE']]
];
for (const [table, privileges] of requiredServiceRolePrivileges) {
  for (const privilege of privileges) {
    assert.equal(
      (await db.query(`select has_table_privilege('service_role','public.${table}','${privilege}') allowed`)).rows[0].allowed,
      true,
      `service_role must receive ${privilege} on ${table}`
    );
  }
  for (const privilege of ['DELETE', 'TRUNCATE']) {
    assert.equal(
      (await db.query(`select has_table_privilege('service_role','public.${table}','${privilege}') allowed`)).rows[0].allowed,
      false,
      `service_role must not receive ${privilege} on ${table}`
    );
  }
  assert.equal(
    (await db.query(`select has_table_privilege('anon','public.${table}','SELECT') allowed`)).rows[0].allowed,
    false,
    `anon must not read ${table}`
  );
}
for (const table of ['profiles', 'audit_logs']) {
  assert.equal(
    (await db.query(`select has_table_privilege('authenticated','public.${table}','SELECT') allowed`)).rows[0].allowed,
    true,
    `authenticated browser runtime must read ${table} through RLS`
  );
}

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${LEGACY_CLINIC_ID}','CHANANYA','Legacy seed','Legacy seed');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_LEGACY_SEED_PRESENT/);
await db.exec('rollback;');
await db.exec(`delete from public.clinics where id='${LEGACY_CLINIC_ID}'`);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('00000000-0000-4000-8000-00000000b002','${config.tenant.expectedClinicCode}','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select count(*)::int count from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].count, 0);
await db.exec(`delete from public.clinics where id='00000000-0000-4000-8000-00000000b002'`);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${config.tenant.expectedClinicId}','OTHER-STG','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select code from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].code, 'OTHER-STG');
await db.exec(`delete from public.clinics where id='${config.tenant.expectedClinicId}'`);

await db.exec(bootstrapSql);
await db.exec(bootstrapSql);
const stagingClinic = await db.query(`
  select id,code,active
  from public.clinics
  where id='${config.tenant.expectedClinicId}'
`);
assert.deepEqual(stagingClinic.rows, [{
  id: config.tenant.expectedClinicId,
  code: config.tenant.expectedClinicCode,
  active: true
}]);
assert.equal(
  (await db.query('select count(*)::int count from public.clinics')).rows[0].count,
  1,
  'an isolated white-label database must contain exactly one bootstrapped clinic'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinics where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  0,
  'the historical clinic seed must not survive a fresh white-label bootstrap'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_state where id='${config.tenant.expectedClinicId}'`)).rows[0].count,
  1,
  'tenant bootstrap must create the isolated clinic-state row'
);

const ADMIN_ID = '33333333-3333-4333-a333-333333333333';
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data)
  values ('${ADMIN_ID}','staging-admin@example.test','{"full_name":"Staging Admin"}');
  update public.profiles
  set role='viewer',system_role='super_admin'
  where id='${ADMIN_ID}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary)
  values ('${config.tenant.expectedClinicId}','${ADMIN_ID}','owner',true);
`);

const cleanupMigration = (await fs.readFile(
  path.join(migrationsDir, '202609010100_fresh_white_label_seed_cleanup.sql'),
  'utf8'
)).replace(/create extension if not exists pgcrypto\s*;/gi, '');
const ownerDriveAssignmentMigration = await fs.readFile(
  path.join(migrationsDir, '202609010500_owner_drive_assignment.sql'),
  'utf8'
);
const beginBackupFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.begin_backup_export_run(uuid,timestamptz,text)')
  ) definition
`)).rows[0].definition;
const beginBackupWithoutTerminalGuardDefinition = beginBackupFunctionDefinition.replace(
  /\n    if v_run\.status in \('completed', 'partial', 'failed'\) then\n      return query select v_run\.id, false;\n      return;\n    end if;\n/i,
  '\n'
);
assert.notEqual(
  beginBackupWithoutTerminalGuardDefinition,
  beginBackupFunctionDefinition,
  'the terminal-outcome negative fixture must remove the reviewed terminal guard'
);
const beginBackupReplayAndCorruptionDefinition = beginBackupFunctionDefinition.replace(
  'or v_run.request_id is not distinct from v_request_id',
  'and v_run.request_id is not distinct from v_request_id'
);
assert.notEqual(
  beginBackupReplayAndCorruptionDefinition,
  beginBackupFunctionDefinition,
  'the stale replay negative fixture must weaken OR to AND'
);
const exactRestoreSourceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.get_exact_backup_restore_source(text,timestamptz,text)')
  ) definition
`)).rows[0].definition;
const subscriptionAssertionFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.assert_clinic_subscription_active(uuid)')
  ) definition
`)).rows[0].definition;
const subscriptionAssertionAndCorruptionDefinition = subscriptionAssertionFunctionDefinition.replace(
  "if not v_clinic.active or v_clinic.subscription_state <> 'active' then",
  "if not v_clinic.active and v_clinic.subscription_state <> 'active' then"
);
assert.notEqual(
  subscriptionAssertionAndCorruptionDefinition,
  subscriptionAssertionFunctionDefinition,
  'the subscription assertion negative fixture must weaken OR to AND'
);
const appendOnlyFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.reject_append_only_mutation()')
  ) definition
`)).rows[0].definition;
const finalizeLineGatewayFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.finalize_line_oa_webhook_event(text,text,text,text,text)')
  ) definition
`)).rows[0].definition;
const finalizeLineGatewayWithoutRoleGateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /\n\s*if\s+auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'(?:::text)?\s+then\s+raise\s+exception\s+'SERVICE_ROLE_REQUIRED';\s+end\s+if;\s*/i,
  '\n'
);
assert.notEqual(
  finalizeLineGatewayWithoutRoleGateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE gateway negative fixture must remove the explicit service-role body gate'
);
const finalizeLineGatewayFalseAndRoleGateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /if\s+auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'(?:::text)?\s+then/i,
  "if false and auth.role() is distinct from 'service_role' then"
);
assert.notEqual(
  finalizeLineGatewayFalseAndRoleGateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE gateway negative fixture must preserve gate tokens while making the gate unreachable'
);
const finalizeLineGatewayOrTrueStateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /and\s+processing_status\s*=\s*'processing'(?:::text)?/i,
  "and (processing_status = 'processing' or true)"
);
assert.notEqual(
  finalizeLineGatewayOrTrueStateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE finalizer negative fixture must preserve state tokens while allowing terminal replay'
);
const lineGatewayEvidenceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.line_oa_webhook_evidence(timestamptz)')
  ) definition
`)).rows[0].definition;
const lineGatewayEvidenceOrTrueWindowDefinition = lineGatewayEvidenceFunctionDefinition.replace(
  /where\s+e\.created_at\s*>=\s*greatest\s*\(/i,
  'where true or e.created_at >= greatest('
);
assert.notEqual(
  lineGatewayEvidenceOrTrueWindowDefinition,
  lineGatewayEvidenceFunctionDefinition,
  'the LINE evidence negative fixture must preserve window tokens while bypassing retention'
);
const lineOperationalHealthcheckFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.line_oa_operational_healthcheck()')
  ) definition
`)).rows[0].definition;
const lineOperationalHealthcheckOrTrueDefinition = lineOperationalHealthcheckFunctionDefinition.replace(
  /or\s+public\.is_super_admin\(\)/i,
  'or true'
);
assert.notEqual(
  lineOperationalHealthcheckOrTrueDefinition,
  lineOperationalHealthcheckFunctionDefinition,
  'the LINE healthcheck negative fixture must remove the exact admin gate'
);
const linePreferenceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure(
      'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'
    )
  ) definition
`)).rows[0].definition;
await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${LEGACY_CLINIC_ID}','CHANANYA','Existing Chananya','Existing Chananya');
  insert into public.clinic_state(id) values ('${LEGACY_CLINIC_ID}');
`);
await db.exec(cleanupMigration);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinics where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  1,
  'the fresh-seed cleanup must preserve populated existing installations'
);
await db.exec(`
  delete from public.clinic_state where id='${LEGACY_CLINIC_ID}';
  delete from public.clinics where id='${LEGACY_CLINIC_ID}';
`);

const applyStrictTriggerAclFixture = async () => {
  const revokes = CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
    .triggerHandlerSignatures
    .map(procedureSignature =>
      `revoke all on function ${procedureSignature} from public,anon,authenticated,service_role;`)
    .join('\n');
  await db.exec(`${revokes}\nalter function public.set_updated_at() set search_path=pg_catalog,public;`);
};
const triggerBindingsBeforeInitialClosure = (await db.query(
  'select oid,tgfoid,tgenabled from pg_trigger where not tgisinternal order by oid'
)).rows;
const wrongClusterRepairSql = preReconciliationRecoverySql.replaceAll(
  reviewedChananyaSystemIdentifier,
  '1'
);
await assert.rejects(
  executeMaterializedPsqlRepair(db, wrongClusterRepairSql, nextRepairTestNonce()),
  /CNYOS_LEDGER_REPAIR_WRONG_CLUSTER/
);
await db.exec('rollback;');
await applyStrictTriggerAclFixture();
assert.deepEqual(
  (await db.query('select oid,tgfoid,tgenabled from pg_trigger where not tgisinternal order by oid')).rows,
  triggerBindingsBeforeInitialClosure,
  'strict trigger ACL closure must preserve every trigger binding'
);
const clinicalTreatmentSessionFunctionDefinition = (await db.query(`
  select pg_get_functiondef(to_regprocedure('${clinicalTreatmentSessionProcedure}')) definition
`)).rows[0].definition;
const clinicalTreatmentSessionDirectAcl = async () => (await db.query(`
  select coalesce(grantee.rolname,'PUBLIC') grantee,
    acl.privilege_type privilege_type,
    acl.is_grantable,
    acl.grantor=p.proowner owner_granted
  from pg_proc p
  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
  left join pg_roles grantee on grantee.oid=acl.grantee
  where p.oid=to_regprocedure('${clinicalTreatmentSessionProcedure}')
    and acl.grantee<>p.proowner
  order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type
`)).rows;
const clinicalTreatmentSessionRuntimeAcl = async () => (await db.query(`
  select runtime_role,
    has_function_privilege(runtime_role,'${clinicalTreatmentSessionProcedure}','EXECUTE') can_execute
  from unnest(array['anon','authenticated','service_role']::text[]) runtime(runtime_role)
  order by runtime_role
`)).rows;
assert.deepEqual(await clinicalTreatmentSessionDirectAcl(), [
  { grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false, owner_granted: true },
  { grantee: 'authenticated', privilege_type: 'EXECUTE', is_grantable: false, owner_granted: true }
]);
assert.deepEqual(await clinicalTreatmentSessionRuntimeAcl(), [
  { runtime_role: 'anon', can_execute: true },
  { runtime_role: 'authenticated', can_execute: true },
  { runtime_role: 'service_role', can_execute: true }
]);
await db.exec(`revoke execute on function ${clinicalTreatmentSessionProcedure} from public`);
assert.deepEqual(await clinicalTreatmentSessionDirectAcl(), [
  { grantee: 'authenticated', privilege_type: 'EXECUTE', is_grantable: false, owner_granted: true }
]);
assert.deepEqual(await clinicalTreatmentSessionRuntimeAcl(), [
  { runtime_role: 'anon', can_execute: false },
  { runtime_role: 'authenticated', can_execute: true },
  { runtime_role: 'service_role', can_execute: false }
]);
async function assertRecoveryGuard({ setup, expected, repair }) {
  await db.exec(setup);
  const materialized = materializePsqlRepairArtifactForPGlite(
    recoverySql,
    nextRepairTestNonce()
  );
  await assert.rejects(
    executeMaterializedPsqlRepair(db, materialized.artifact, materialized.runNonce),
    expected
  );
  await db.exec('rollback;');
  await db.exec(repair);
}

await assertRecoveryGuard({
  setup: `grant execute on function ${clinicalTreatmentSessionProcedure} to service_role`,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/,
  repair: `revoke execute on function ${clinicalTreatmentSessionProcedure} from service_role`
});
await assertRecoveryGuard({
  setup: `grant execute on function ${clinicalTreatmentSessionProcedure} to anon`,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/,
  repair: `revoke execute on function ${clinicalTreatmentSessionProcedure} from anon`
});
await assertRecoveryGuard({
  setup: `grant execute on function ${clinicalTreatmentSessionProcedure}
    to authenticated with grant option`,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_ACL_MISSING/,
  repair: `revoke grant option for execute on function
    ${clinicalTreatmentSessionProcedure} from authenticated`
});
await assertRecoveryGuard({
  setup: `
    create role treatment_session_rogue_executor;
    grant execute on function ${clinicalTreatmentSessionProcedure}
      to treatment_session_rogue_executor
  `,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_ACL_INVALID/,
  repair: `
    revoke execute on function ${clinicalTreatmentSessionProcedure}
      from treatment_session_rogue_executor;
    drop role treatment_session_rogue_executor
  `
});
await assertRecoveryGuard({
  setup: `
    create role treatment_session_inherited_executor;
    grant execute on function ${clinicalTreatmentSessionProcedure}
      to treatment_session_inherited_executor;
    grant treatment_session_inherited_executor to service_role
  `,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/,
  repair: `
    revoke treatment_session_inherited_executor from service_role;
    revoke execute on function ${clinicalTreatmentSessionProcedure}
      from treatment_session_inherited_executor;
    drop role treatment_session_inherited_executor
  `
});
await assertRecoveryGuard({
  setup: `
    create role treatment_session_owner_drift;
    alter function ${clinicalTreatmentSessionProcedure} owner to treatment_session_owner_drift
  `,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_SEMANTIC_CONTRACT_INVALID/,
  repair: `
    alter function ${clinicalTreatmentSessionProcedure} owner to ${trustedMigrationOwnerSql};
    drop role treatment_session_owner_drift
  `
});
await assertRecoveryGuard({
  setup: `
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
    ) returns public.clinical_treatment_sessions
    language plpgsql security invoker set search_path=public as $$
    begin
      raise exception 'DRIFTED_TREATMENT_SESSION_BODY';
    end
    $$
  `,
  expected: /STAGING_CLINICAL_TREATMENT_SESSION_SEMANTIC_CONTRACT_INVALID/,
  repair: clinicalTreatmentSessionFunctionDefinition
});

await assertRecoveryGuard({
  setup: 'alter table public.clinic_drive_destination_events disable row level security',
  expected: /STAGING_OWNER_DRIVE_RLS_MISSING/,
  repair: 'alter table public.clinic_drive_destination_events enable row level security'
});
await assertRecoveryGuard({
  setup: 'alter table public.owner_control_historical_replay_guard no force row level security',
  expected: /STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING/,
  repair: 'alter table public.owner_control_historical_replay_guard force row level security'
});
await assertRecoveryGuard({
  setup: 'grant select on public.owner_control_historical_replay_guard to service_role',
  expected: /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke all on public.owner_control_historical_replay_guard from service_role'
});
await assertRecoveryGuard({
  setup: 'grant select(historical_sha256) on public.owner_control_historical_replay_guard to service_role',
  expected: /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke select(historical_sha256) on public.owner_control_historical_replay_guard from service_role'
});
await assertRecoveryGuard({
  setup: `
    create policy corrupted_owner_replay_guard_policy
    on public.owner_control_historical_replay_guard
    for select to authenticated using (false)
  `,
  expected: /STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT/,
  repair: 'drop policy corrupted_owner_replay_guard_policy on public.owner_control_historical_replay_guard'
});
await assertRecoveryGuard({
  setup: 'delete from public.owner_control_historical_replay_guard',
  expected: /STAGING_OWNER_REPLAY_GUARD_ROW_MISSING/,
  repair: `
    insert into public.owner_control_historical_replay_guard(
      singleton,protected_migration,historical_sha256
    ) values (
      true,
      '202608311800_owner_subscription_control',
      'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
    )
  `
});
await assertRecoveryGuard({
  setup: `
    drop policy appointment_events_read on public.appointment_events;
    create policy appointment_events_read on public.appointment_events
      for select to authenticated
      using (
        (
          clinic_id=public.current_clinic_id()
          and (
            public.is_clinic_admin()
            or exists (
              select 1 from public.clinic_appointments a
              where a.id=appointment_events.appointment_id
                and a.clinic_id=appointment_events.clinic_id
                and a.practitioner_id=auth.uid()
            )
          )
        )
        or true
      )
  `,
  expected: /STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID/,
  repair: `
    drop policy appointment_events_read on public.appointment_events;
    create policy appointment_events_read on public.appointment_events
      for select to authenticated
      using (
        clinic_id=public.current_clinic_id()
        and (
          public.is_clinic_admin()
          or exists (
            select 1 from public.clinic_appointments a
            where a.id=appointment_events.appointment_id
              and a.clinic_id=appointment_events.clinic_id
              and a.practitioner_id=auth.uid()
          )
        )
      )
  `
});
await assertRecoveryGuard({
  setup: 'grant select on public.clinic_drive_backup_destinations to authenticated',
  expected: /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke all on public.clinic_drive_backup_destinations from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant update(environment) on public.clinic_drive_backup_destinations to authenticated',
  expected: /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke update(environment) on public.clinic_drive_backup_destinations from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.list_owner_drive_assignments() to authenticated',
  expected: /STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.list_owner_drive_assignments() from authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) from service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) to authenticated',
  expected: /STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text) to service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text) from service_role'
});
await assertRecoveryGuard({
  setup: 'alter table public.approval_actions alter column clinic_id drop not null',
  expected: /STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID/,
  repair: 'alter table public.approval_actions alter column clinic_id set not null'
});
await assertRecoveryGuard({
  setup: 'alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey',
  expected: /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/,
  repair: `
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (task_id,clinic_id)
      references public.approval_tasks(id,clinic_id) on delete cascade
  `
});
await assertRecoveryGuard({
  setup: `
    alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey;
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (clinic_id)
      references public.clinics(id) on delete restrict
  `,
  expected: /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/,
  repair: `
    alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey;
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (task_id,clinic_id)
      references public.approval_tasks(id,clinic_id) on delete cascade
  `
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) from service_role',
  expected: /STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text) to service_role',
  expected: /STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text) from service_role'
});
await assertRecoveryGuard({
  setup: `
    alter function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)
      rename to corrupted_line_oa_register_gateway_v20260829
  `,
  expected: /STAGING_SCHEMA_FUNCTIONS_MISSING/,
  repair: `
    alter function public.corrupted_line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)
      rename to line_oa_register_gateway_v20260829
  `
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.export_clinic_backup_domain_v20260828(uuid,text) to service_role',
  expected: /STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.export_clinic_backup_domain_v20260828(uuid,text) from service_role'
});
await assertRecoveryGuard({
  setup: 'alter function public.export_clinic_backup_domain_v20260831(uuid,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.export_clinic_backup_domain_v20260831(uuid,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: 'alter function public.verify_clinic_restore_trace_v20260829(uuid) security invoker',
  expected: /STAGING_SECURITY_DEFINERS_MISSING/,
  repair: 'alter function public.verify_clinic_restore_trace_v20260829(uuid) security definer'
});
await assertRecoveryGuard({
  setup: `
    create role archive_drift_owner nologin;
    grant create on schema public to archive_drift_owner;
    alter function public.export_clinic_backup_domain_v20260829(uuid,text)
      owner to archive_drift_owner
  `,
  expected: /STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH/,
  repair: `
    alter function public.export_clinic_backup_domain_v20260829(uuid,text) owner to postgres;
    revoke all on schema public from archive_drift_owner;
    drop role archive_drift_owner
  `
});
await assertRecoveryGuard({
  setup: `
    grant create on schema public to authenticated;
    alter function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      owner to authenticated
  `,
  expected: /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/,
  repair: `
    alter function public.finalize_line_oa_webhook_event(text,text,text,text,text) owner to postgres;
    revoke create on schema public from authenticated;
    revoke all on function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      from public,anon,authenticated,service_role;
    grant execute on function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      to service_role
  `
});
await assertRecoveryGuard({
  setup: `
    grant create on schema public to service_role;
    alter table public.owner_control_historical_replay_guard owner to service_role
  `,
  expected: /STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER/,
  repair: `
    alter table public.owner_control_historical_replay_guard owner to postgres;
    revoke create on schema public from service_role
  `
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.line_oa_webhook_evidence(timestamptz) from service_role',
  expected: /STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.line_oa_webhook_evidence(timestamptz) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.finalize_line_oa_webhook_event(text,text,text,text,text) to authenticated',
  expected: /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.finalize_line_oa_webhook_event(text,text,text,text,text) from authenticated'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_webhook_evidence(timestamptz) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.line_oa_webhook_evidence(timestamptz) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayWithoutRoleGateDefinition,
  expected: /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayFalseAndRoleGateDefinition,
  expected: /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayOrTrueStateDefinition,
  expected: /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: lineGatewayEvidenceOrTrueWindowDefinition,
  expected: /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/,
  repair: lineGatewayEvidenceFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create role sensitive_function_drift_owner nologin;
    grant create on schema public to sensitive_function_drift_owner;
    alter function public.begin_backup_export_run(uuid,timestamptz,text)
      owner to sensitive_function_drift_owner
  `,
  expected: /STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH/,
  repair: `
    alter function public.begin_backup_export_run(uuid,timestamptz,text)
      owner to ${trustedMigrationOwnerSql};
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role;
    revoke all on schema public from sensitive_function_drift_owner;
    drop role sensitive_function_drift_owner
  `
});
await assertRecoveryGuard({
  setup: `
    create role sensitive_relation_drift_owner nologin;
    grant create on schema public to sensitive_relation_drift_owner;
    alter table public.clinic_drive_backup_destinations
      owner to sensitive_relation_drift_owner
  `,
  expected: /STAGING_SENSITIVE_RELATION_OWNER_MISMATCH/,
  repair: `
    alter table public.clinic_drive_backup_destinations
      owner to ${trustedMigrationOwnerSql};
    revoke all on schema public from sensitive_relation_drift_owner;
    drop role sensitive_relation_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() security invoker',
  expected: /STAGING_SECURITY_DEFINERS_MISSING/,
  repair: 'alter function public.line_oa_operational_healthcheck() security definer'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() volatile',
  expected: /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/,
  repair: 'alter function public.line_oa_operational_healthcheck() stable'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() reset search_path',
  expected: /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/,
  repair: 'alter function public.line_oa_operational_healthcheck() set search_path=public'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.line_oa_operational_healthcheck() from service_role',
  expected: /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/,
  repair: 'grant execute on function public.line_oa_operational_healthcheck() to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.line_oa_operational_healthcheck() to anon',
  expected: /STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.line_oa_operational_healthcheck() from anon'
});
await assertRecoveryGuard({
  setup: lineOperationalHealthcheckOrTrueDefinition,
  expected: /STAGING_LINE_HEALTHCHECK_BODY_INVALID/,
  repair: lineOperationalHealthcheckFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create role unauthorized_executor login;
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to unauthorized_executor
  `,
  expected: /STAGING_SERVICE_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.begin_backup_export_run(uuid,timestamptz,text)
      from unauthorized_executor;
    drop role unauthorized_executor
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role with grant option
  `,
  expected: /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/,
  repair: `
    revoke all on function public.begin_backup_export_run(uuid,timestamptz,text)
      from service_role;
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.line_oa_operational_healthcheck()
      to authenticated with grant option
  `,
  expected: /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/,
  repair: `
    revoke all on function public.line_oa_operational_healthcheck()
      from authenticated;
    grant execute on function public.line_oa_operational_healthcheck()
      to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    create role browser_rpc_drift_executor login;
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to browser_rpc_drift_executor
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from browser_rpc_drift_executor;
    drop role browser_rpc_drift_executor
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to authenticated with grant option
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from authenticated;
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to service_role
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from service_role
  `
});
await assertRecoveryGuard({
  setup: 'alter function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: 'alter function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.set_line_oa_notification_preference_for_subject(
      p_subject_hash text,p_patient_id uuid,p_clinic_id uuid,p_environment text,
      p_deployment_id text,p_channel_hash text,p_enabled boolean
    )
    returns table (
      patient_id uuid,operational_messaging_enabled boolean,
      appointment_reminders_enabled boolean
    )
    language plpgsql volatile security definer
    set search_path=pg_catalog,public
    as $$
    begin
      if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
      if p_enabled then
        perform public.assert_clinic_subscription_active(p_clinic_id);
      else
        perform public.prepare_line_subscription_off_exception(
          p_clinic_id,'line-consent-withdrawal/v1'
        );
      end if;
      return query select * from public.line_oa_set_preference_v20260829(
        p_subject_hash,p_patient_id,p_clinic_id,p_environment,
        p_deployment_id,p_channel_hash,p_enabled
      );
    end;
    $$;
  `,
  expected: /STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID/,
  repair: linePreferenceFunctionDefinition
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_appointments disable trigger trg_cnyos_active_subscription_write',
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: 'alter table public.clinic_appointments enable trigger trg_cnyos_active_subscription_write'
});
await assertRecoveryGuard({
  setup: 'alter table public.products disable trigger trg_cnyos_authenticated_subscription_statement_write',
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: 'alter table public.products enable trigger trg_cnyos_authenticated_subscription_statement_write'
});
await assertRecoveryGuard({
  setup: 'alter function public.assert_clinic_subscription_active(uuid) stable',
  expected: /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/,
  repair: 'alter function public.assert_clinic_subscription_active(uuid) volatile'
});
await assertRecoveryGuard({
  setup: subscriptionAssertionAndCorruptionDefinition,
  expected: /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/,
  repair: subscriptionAssertionFunctionDefinition
});
await assertRecoveryGuard({
  setup: 'revoke insert on public.inventory_lots from service_role',
  expected: /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/,
  repair: 'grant insert on public.inventory_lots to service_role'
});
await assertRecoveryGuard({
  setup: 'grant insert on public.inventory_lots to service_role with grant option',
  expected: /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/,
  repair: `
    revoke insert on public.inventory_lots from service_role;
    grant insert on public.inventory_lots to service_role
  `
});
await assertRecoveryGuard({
  setup: 'grant update(id) on public.inventory_lots to service_role',
  expected: /STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID/,
  repair: 'revoke update(id) on public.inventory_lots from service_role'
});
await assertRecoveryGuard({
  setup: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.appointment_events','id');
    begin execute format('grant usage on sequence %s to service_role',v_sequence::regclass); end;
    $$;
  `,
  expected: /STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID/,
  repair: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.appointment_events','id');
    begin execute format('revoke all on sequence %s from service_role',v_sequence::regclass); end;
    $$;
  `
});
await assertRecoveryGuard({
  setup: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.audit_logs','id');
    begin
      execute format(
        'grant usage on sequence %s to service_role with grant option',
        v_sequence::regclass
      );
    end;
    $$;
  `,
  expected: /STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING/,
  repair: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.audit_logs','id');
    begin
      execute format('revoke all on sequence %s from service_role',v_sequence::regclass);
      execute format('grant usage on sequence %s to service_role',v_sequence::regclass);
    end;
    $$;
  `
});
await assertRecoveryGuard({
  setup: 'grant insert on public.audit_logs to authenticated',
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: 'revoke insert on public.audit_logs from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant update on public.patients to authenticated',
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: 'revoke update on public.patients from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.reject_production_order(uuid,text,text) to authenticated',
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID/,
  repair: 'revoke all on function public.reject_production_order(uuid,text,text) from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create role pdpa_acl_drift_reader login bypassrls;
    grant select on public.patients to pdpa_acl_drift_reader
  `,
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: `
    revoke all on public.patients from pdpa_acl_drift_reader;
    drop role pdpa_acl_drift_reader
  `
});
await assertRecoveryGuard({
  setup: `
    create role inherited_acl_attack login bypassrls;
    grant authenticated to inherited_acl_attack;
    do $$
    begin
      if not has_table_privilege('inherited_acl_attack','public.patients','SELECT') then
        raise exception 'membership attack fixture did not inherit patient read';
      end if;
    end
    $$;
  `,
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/,
  repair: `
    revoke authenticated from inherited_acl_attack;
    do $$
    begin
      if has_table_privilege('inherited_acl_attack','public.patients','SELECT') then
        raise exception 'membership repair retained patient read';
      end if;
    end
    $$;
    drop role inherited_acl_attack
  `
});
await assertRecoveryGuard({
  setup: 'alter role authenticated bypassrls',
  expected: /STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID/,
  repair: 'alter role authenticated nobypassrls'
});
await assertRecoveryGuard({
  setup: 'grant create on schema public to authenticated',
  expected: /STAGING_PUBLIC_SCHEMA_ACL_INVALID/,
  repair: 'revoke create on schema public from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create role authenticator_child_attack login bypassrls;
    grant authenticator to authenticator_child_attack
  `,
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/,
  repair: `
    revoke authenticator from authenticator_child_attack;
    drop role authenticator_child_attack
  `
});
await assertRecoveryGuard({
  setup: `
    create role public_schema_drift_owner nologin;
    alter schema public owner to public_schema_drift_owner
  `,
  expected: /STAGING_PUBLIC_SCHEMA_OWNER_INVALID/,
  repair: `
    alter schema public owner to ${trustedPublicSchemaOwnerSql};
    drop role public_schema_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'revoke usage on schema public from authenticated',
  expected: /STAGING_PUBLIC_SCHEMA_ACL_MISSING/,
  repair: 'grant usage on schema public to authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke authenticated from authenticator',
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING/,
  repair: 'grant authenticated to authenticator'
});
await assertRecoveryGuard({
  setup: 'grant update(id) on public.patients to authenticated',
  expected: /STAGING_PUBLIC_COLUMN_ACL_INVALID/,
  repair: 'revoke update(id) on public.patients from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant select on public.patients to authenticated with grant option',
  expected: /STAGING_PUBLIC_RELATION_ACL_MISSING/,
  repair: `
    revoke select on public.patients from authenticated;
    grant select on public.patients to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    create role sequence_acl_drift login;
    grant usage on sequence public.audit_logs_id_seq to sequence_acl_drift
  `,
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: `
    revoke all on sequence public.audit_logs_id_seq from sequence_acl_drift;
    drop role sequence_acl_drift
  `
});
await assertRecoveryGuard({
  setup: 'revoke execute on function public.search_patients_for_checkin(text) from authenticated',
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING/,
  repair: 'grant execute on function public.search_patients_for_checkin(text) to authenticated'
});
await assertRecoveryGuard({
  setup: `
    create function public.unreviewed_security_definer_rpc()
    returns boolean language sql stable security definer
    set search_path=pg_catalog,public as $$ select true $$;
    revoke all on function public.unreviewed_security_definer_rpc() from public
  `,
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID/,
  repair: 'drop function public.unreviewed_security_definer_rpc()'
});
await assertRecoveryGuard({
  setup: `
    create role public_acl_drift_owner nologin;
    grant create on schema public to public_acl_drift_owner;
    alter table public.patients owner to public_acl_drift_owner
  `,
  expected: /STAGING_PUBLIC_RELATION_OWNER_MISMATCH/,
  repair: `
    alter table public.patients owner to ${trustedMigrationOwnerSql};
    revoke all on schema public from public_acl_drift_owner;
    drop role public_acl_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'grant update on public.appointments to service_role',
  expected: /STAGING_SERVICE_ROLE_DML_ACL_INVALID/,
  repair: 'revoke update on public.appointments from service_role'
});
await assertRecoveryGuard({
  setup: 'drop policy cnyos_active_subscription_boundary on public.products',
  expected: /STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING/,
  repair: `
    create policy cnyos_active_subscription_boundary on public.products
    as restrictive for all to authenticated
    using (public.current_clinic_id() is not null)
    with check (public.current_clinic_id() is not null)
  `
});
await assertRecoveryGuard({
  setup: 'alter view public.admin_task_summary set (security_invoker=false)',
  expected: /STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING/,
  repair: 'alter view public.admin_task_summary set (security_invoker=true)'
});
await assertRecoveryGuard({
  setup: 'alter table public.products disable row level security',
  expected: /STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS/,
  repair: 'alter table public.products enable row level security'
});
await assertRecoveryGuard({
  setup: 'alter table public.clinics disable trigger trg_clinics_owner_subscription_forward_only',
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: 'alter table public.clinics enable trigger trg_clinics_owner_subscription_forward_only'
});
await assertRecoveryGuard({
  setup: 'grant update on public.clinics to service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/,
  repair: 'revoke update on public.clinics from service_role'
});
await assertRecoveryGuard({
  setup: 'grant update(subscription_state) on public.clinics to authenticated',
  expected: /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/,
  repair: 'revoke update(subscription_state) on public.clinics from authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.begin_backup_export_run(uuid,timestamptz,text) from service_role',
  expected: /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/,
  repair: 'grant execute on function public.begin_backup_export_run(uuid,timestamptz,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.get_exact_backup_restore_source(text,timestamptz,text) to authenticated',
  expected: /STAGING_SERVICE_RPC_ACL_INVALID/,
  repair: 'revoke all on function public.get_exact_backup_restore_source(text,timestamptz,text) from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.begin_backup_export_run(
      p_clinic_id uuid,
      p_scheduled_for timestamptz,
      p_request_id text
    ) returns table(run_id uuid, acquired boolean)
    language sql volatile security definer
    set search_path=pg_catalog,public
    as $$ select null::uuid,false $$
  `,
  expected: /STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: beginBackupWithoutTerminalGuardDefinition,
  expected: /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: beginBackupReplayAndCorruptionDefinition,
  expected: /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.set_clinic_drive_assignment(
      p_request_id uuid,
      p_clinic_id uuid,
      p_expected_clinic_code text,
      p_environment text,
      p_patients_folder_id text,
      p_products_folder_id text,
      p_pharmacy_folder_id text,
      p_transactions_folder_id text,
      p_manifests_folder_id text,
      p_expected_version bigint,
      p_reason text,
      p_actor_user_id uuid,
      p_actor_email text
    ) returns jsonb
    language sql volatile security definer
    set search_path=pg_catalog,public
    as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID/,
  repair: ownerDriveAssignmentMigration
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.get_exact_backup_restore_source(
      p_clinic_code text,
      p_scheduled_for timestamptz,
      p_environment text
    ) returns jsonb
    language sql stable security definer
    set search_path=pg_catalog,public
    as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID/,
  repair: exactRestoreSourceFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create function public.set_clinic_subscription_state(
      uuid,uuid,text,boolean,text,uuid,text
    ) returns jsonb language sql as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT/,
  repair: 'drop function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_drive_destination_events disable trigger trg_clinic_drive_destination_events_append_only',
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: 'alter table public.clinic_drive_destination_events enable trigger trg_clinic_drive_destination_events_append_only'
});
await assertRecoveryGuard({
  setup: `
    create function public.corrupted_append_only_trigger()
    returns trigger language plpgsql as $$ begin return old; end $$;
    drop trigger trg_clinic_drive_destination_events_append_only
      on public.clinic_drive_destination_events;
    create trigger trg_clinic_drive_destination_events_append_only
    before update or delete on public.clinic_drive_destination_events
    for each row execute function public.corrupted_append_only_trigger()
  `,
  expected: /STAGING_TRIGGER_FUNCTION_INVENTORY_OR_STATE_INVALID/,
  repair: `
    drop trigger trg_clinic_drive_destination_events_append_only
      on public.clinic_drive_destination_events;
    drop function public.corrupted_append_only_trigger();
    create trigger trg_clinic_drive_destination_events_append_only
    before update or delete on public.clinic_drive_destination_events
    for each row execute function public.reject_append_only_mutation()
  `
});
await assertRecoveryGuard({
  setup: `
    drop trigger stock_movement_apply on public.stock_movements;
    drop trigger trg_assign_audit_clinic on public.audit_logs;
    create trigger stock_movement_apply
    after insert on public.stock_movements
    for each row execute function public.assign_audit_clinic();
    create trigger trg_assign_audit_clinic
    before insert on public.audit_logs
    for each row execute function public.apply_stock_movement()
  `,
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: `
    drop trigger stock_movement_apply on public.stock_movements;
    drop trigger trg_assign_audit_clinic on public.audit_logs;
    create trigger stock_movement_apply
    after insert on public.stock_movements
    for each row execute function public.apply_stock_movement();
    create trigger trg_assign_audit_clinic
    before insert on public.audit_logs
    for each row execute function public.assign_audit_clinic()
  `
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_subscription_control_events disable trigger trg_clinic_subscription_control_events_append_only',
  expected: /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/,
  repair: 'alter table public.clinic_subscription_control_events enable trigger trg_clinic_subscription_control_events_append_only'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.reject_append_only_mutation()
    returns trigger language plpgsql volatile security definer
    set search_path=pg_catalog
    as $$ begin return old; end $$
  `,
  expected: /STAGING_TRIGGER_FUNCTION_SEMANTICS_INVALID/,
  repair: appendOnlyFunctionDefinition
});

const reviewedTriggerCost = Number((await db.query(`
  select procost::text cost
  from pg_catalog.pg_proc
  where oid='public.handle_new_user()'::regprocedure
`)).rows[0].cost);
await db.exec(`
  set extra_float_digits = -1;
  alter function public.handle_new_user() cost ${reviewedTriggerCost + 0.001};
`);
assert.equal(
  (await db.query(`
    select procost::text cost
    from pg_catalog.pg_proc
    where oid='public.handle_new_user()'::regprocedure
  `)).rows[0].cost,
  String(reviewedTriggerCost),
  'hostile float formatting must mask the tiny procost/prorows-class drift outside repair'
);
const hostileFloatRepair = materializePsqlRepairArtifactForPGlite(
  recoverySql,
  nextRepairTestNonce()
);
await assert.rejects(
  executeMaterializedPsqlRepair(
    db,
    hostileFloatRepair.artifact,
    hostileFloatRepair.runNonce
  ),
  /STAGING_TRIGGER_FUNCTION_SEMANTICS_INVALID/
);
await db.exec('rollback;');
await db.exec(`
  alter function public.handle_new_user() cost ${reviewedTriggerCost};
  reset extra_float_digits;
`);

const archivedBackupDirectCalls = [
  `select public.export_clinic_backup_domain_v20260831('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.export_clinic_backup_domain_v20260829('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.export_clinic_backup_domain_v20260828('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.verify_clinic_restore_trace_v20260831('${config.tenant.expectedClinicId}'::uuid)`,
  `select public.verify_clinic_restore_trace_v20260829('${config.tenant.expectedClinicId}'::uuid)`,
  `select public.verify_clinic_restore_trace_v20260828('${config.tenant.expectedClinicId}'::uuid)`
];
const archivedLineDirectCalls = [
  'select public.line_oa_queue_notification_v20260829(null::uuid,null::text,null::timestamptz,null::timestamptz,null::text)',
  'select * from public.line_oa_set_preference_v20260829(null::text,null::uuid,null::uuid,null::text,null::text,null::text,null::boolean)',
  'select * from public.line_oa_complete_link_consent_v20260829(null::text,null::text,null::text,null::boolean,null::uuid,null::text,null::text,null::text)',
  'select * from public.line_oa_list_preferences_v20260829(null::text,null::uuid,null::text,null::text,null::text)',
  'select * from public.line_oa_claim_webhook_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::text,null::timestamptz,null::boolean,null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::jsonb)',
  'select public.line_oa_finish_webhook_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::text,null::text,null::boolean)',
  'select * from public.line_oa_claim_batch_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::integer)',
  'select public.line_oa_finish_notification_v20260829(null::uuid,null::text,null::text,null::integer,null::text,null::text)',
  'select * from public.line_oa_register_gateway_v20260829(null::text,null::text,null::text,null::text,null::text,null::timestamptz,null::boolean,null::text)'
];

await db.exec(`
  reset role;
  select set_config('request.jwt.claim.role','service_role',false);
  set role service_role;
`);
try {
  for (const statement of [...archivedBackupDirectCalls, ...archivedLineDirectCalls]) {
    await assert.rejects(
      db.query(statement),
      /permission denied for function/i,
      `service_role must not directly execute archived delegate: ${statement}`
    );
  }

  const currentExport = (await db.query(`
    select public.export_clinic_backup_domain(
      '${config.tenant.expectedClinicId}'::uuid,
      'transactions'
    ) result
  `)).rows[0].result;
  assert.equal(currentExport.schema_version, '2026-09-01.1');
  assert.ok(
    currentExport.included_tables.includes('clinic_drive_destination_events'),
    'the current exporter must traverse its owner-only archives and retain Drive evidence'
  );

  const currentRestoreTrace = (await db.query(`
    select public.verify_clinic_restore_trace(
      '${config.tenant.expectedClinicId}'::uuid
    ) result
  `)).rows[0].result;
  assert.equal(currentRestoreTrace.schema_version, '2026-09-01.1');
  assert.equal(
    currentRestoreTrace.counts.clinic_drive_destination_events,
    0,
    'the current restore verifier must traverse its owner-only archive chain'
  );

  const currentLineWrapper = await db.query(`
    select * from public.list_line_oa_notification_preferences_for_subject(
      '${'a'.repeat(64)}',
      '${config.tenant.expectedClinicId}'::uuid,
      'staging',
      '${config.deploymentId}',
      '${'b'.repeat(64)}'
    )
  `);
  assert.equal(
    currentLineWrapper.rows.length,
    0,
    'the current LINE wrapper must remain able to execute its owner-only delegate'
  );

  assert.equal(
    (await db.query(`
      select public.finalize_line_oa_webhook_event(
        '${'c'.repeat(64)}','${'d'.repeat(64)}','ignored','not_applicable',null
      ) finalized
    `)).rows[0].finalized,
    false,
    'the service-only current LINE finalizer must remain callable'
  );
  assert.equal(
    (await db.query('select * from public.line_oa_webhook_evidence(null)')).rows.length,
    1,
    'the service-only LINE evidence RPC must return one aggregate row'
  );

  await db.exec(`select set_config('request.jwt.claim.role','',false)`);
  await assert.rejects(
    db.query(`
      select public.finalize_line_oa_webhook_event(
        '${'c'.repeat(64)}','${'d'.repeat(64)}','ignored','not_applicable',null
      )
    `),
    /SERVICE_ROLE_REQUIRED/,
    'the current LINE gateway body gate must reject a no-claim service-role session'
  );
} finally {
  await db.exec('reset role;');
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
}

await assertRecoveryGuard({
  setup: `
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values (
      '202608311800',
      'owner_subscription_control',
      array['-- recovered from supabase/migrations/202608311800_owner_subscription_control.sql; sha256 = d08745109128a0da763fd2c177933b7df21026fdb027b900bc62fec932076d39']::text[]
    )
  `,
  expected: /MIGRATION_LEDGER_SHA256_CONFLICT/,
  repair: `delete from supabase_migrations.schema_migrations where version='202608311800'`
});
await assertRecoveryGuard({
  setup: `
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values (
      '202608311800',
      'owner_subscription_control',
      array['  -- recovered from supabase/migrations/202608311800_owner_subscription_control.sql; sha256=d08745109128a0da763fd2c177933b7df21026fdb027b900bc62fec932076d39']::text[]
    )
  `,
  expected: /MIGRATION_LEDGER_SHA256_CONFLICT/,
  repair: `delete from supabase_migrations.schema_migrations where version='202608311800'`
});

await db.exec(`
  insert into supabase_migrations.schema_migrations(version,name,statements)
  values (
    '202608311800',
    'owner_subscription_control',
    array['select ''pre-existing raw Supabase ledger statement''::text']::text[]
  )
`);
await db.exec('set search_path=pg_catalog');
const productionVerificationSql = buildMigrationLedgerVerificationSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40)
});
const productionPreReconciliationVerificationSql = buildMigrationLedgerVerificationSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40),
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});
for (const artifact of [
  productionVerificationSql,
  productionPreReconciliationVerificationSql
]) {
  assert.equal(
    artifact.split(reviewedChananyaSystemIdentifier).length - 1,
    2,
    'each production CNYOS verifier must pin and report the reviewed cluster identity'
  );
}
assert.ok(productionVerificationSql.includes(`"status":"${strictVerificationStatus}"`));
assert.ok(productionPreReconciliationVerificationSql.includes(
  `"status":"${preReconciliationVerificationStatus}"`
));
for (const artifact of [
  productionVerificationSql,
  productionPreReconciliationVerificationSql
]) {
  assert.doesNotMatch(artifact, /raise notice/i);
  assert.match(
    artifact,
    /\)::text as cnyos_verification_evidence\n\\gset\nrollback;\n\\unset cnyos_verification_lock_released/
  );
  assert.match(
    artifact,
    /\\if :cnyos_verification_lock_released\n\\unset cnyos_verification_lock_fully_released\nselect not exists \([\s\S]*\) as cnyos_verification_lock_fully_released\n\\gset\n\\if :cnyos_verification_lock_fully_released\nselect \([\s\S]*'verification_transaction_rolled_back',true,[\s\S]*'advisory_lock_released',true[\s\S]*\) as migration_ledger_verification_evidence;\n\\else\n/
  );
}
// Execution remains confined to the disposable PGlite cluster. Preserve the
// generated production SQL above and rebind only the in-memory behavioral
// fixtures to the cluster identity they actually observe.
const verificationSql = materializePsqlVerificationArtifactForPGlite(
  productionVerificationSql
);
const preReconciliationVerificationSql =
  materializePsqlVerificationArtifactForPGlite(
    productionPreReconciliationVerificationSql
  );
const verificationNotices = [];
const verificationOptions = { onNotice: notice => verificationNotices.push(notice.message) };
const verificationSnapshot = async () => ({
  ledger: (await db.query('select * from supabase_migrations.schema_migrations order by version')).rows,
  clinics: (await db.query('select * from public.clinics order by id')).rows,
  patients: (await db.query('select * from public.patients order by id')).rows,
  functionAcls: (await db.query("select oid,proacl::text from pg_proc where pronamespace='public'::regnamespace order by oid")).rows,
  sequences: (await db.query("select schemaname,sequencename,last_value from pg_sequences where schemaname='public' order by sequencename")).rows
});
const beforeVerification = await verificationSnapshot();
await db.exec(verificationSql, verificationOptions);
assert.deepEqual(await verificationSnapshot(), beforeVerification, 'valid catalog verification must preserve ledger, rows, ACLs and sequences');
assert.equal((await db.query('show transaction_read_only')).rows[0].transaction_read_only, 'off', 'verification must finish its rollback');
assert.equal(verificationNotices.length, 0, 'verification must not emit success inside its transaction');

for (const drift of [
  { setup: 'alter table public.clinic_drive_destination_events disable row level security', repair: 'alter table public.clinic_drive_destination_events enable row level security' },
  { setup: 'revoke execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) from authenticated', repair: 'grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) to authenticated' }
]) {
  verificationNotices.length = 0;
  await db.exec(drift.setup);
  await assert.rejects(db.exec(verificationSql, verificationOptions), /STAGING_/);
  await db.exec('rollback;');
  assert.equal(verificationNotices.length, 0);
  await db.exec(drift.repair);
}
console.log('Full-schema verification passed: exact 45-migration fixture, unchanged state, and RLS/ACL drift denied without a success notice');

// The classified-complete verifier is bound to hosted Chananya catalog and
// role facts. A local superuser fixture must not be accepted as a native live
// rehearsal, and the generated verifier must not attempt unsupported system-
// catalog SHARE locks to manufacture serialization.
assert.match(
  productionPreReconciliationVerificationSql,
  /CNYOS_CLASSIFIED_ACL_HOSTED_NON_SUPER_PROFILE_REQUIRED/
);
assert.doesNotMatch(
  productionPreReconciliationVerificationSql,
  /lock table pg_catalog\./i
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanCount,
  91
);
assert.match(
  productionPreReconciliationVerificationSql,
  /"hosted_concurrency_protocol_approved":false/
);
assert.match(
  productionPreReconciliationVerificationSql,
  /"fresh_post_commit_observer_required":true/
);
assert.match(
  productionPreReconciliationVerificationSql,
  /CNYOS_CLASSIFIED_ACL_CURRENT_RAW_MATRIX_INVALID/
);
assert.match(
  productionPreReconciliationVerificationSql,
  /CNYOS_CLASSIFIED_ACL_SECURITY_DEFINER_PATH_OR_DEFINITION_INVALID/
);

await db.exec(`grant execute on function ${clinicalTreatmentSessionProcedure} to public`);
assert.deepEqual(await clinicalTreatmentSessionDirectAcl(), [
  { grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false, owner_granted: true },
  { grantee: 'authenticated', privilege_type: 'EXECUTE', is_grantable: false, owner_granted: true }
]);
assert.deepEqual(await clinicalTreatmentSessionRuntimeAcl(), [
  { runtime_role: 'anon', can_execute: true },
  { runtime_role: 'authenticated', can_execute: true },
  { runtime_role: 'service_role', can_execute: true }
]);

// Classification is complete, but the write-capable artifact remains blocked
// until independent review, explicit authorization and hosted-like native
// rehearsal have all completed.
const blockedPreReconciliationRepair = materializePsqlRepairArtifactForPGlite(
  preReconciliationRecoverySql,
  nextRepairTestNonce()
);
const beforeBlockedPreReconciliationRepair = await verificationSnapshot();
await db.exec(blockedPreReconciliationRepair.setupSessionSql);
await db.exec(blockedPreReconciliationRepair.beforeTransactionSql);
await db.exec(blockedPreReconciliationRepair.transactionPrefix);
await assert.rejects(
  db.exec(blockedPreReconciliationRepair.guardStatement),
  /CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED/
);
await db.exec('rollback;');
assert.deepEqual(
  await verificationSnapshot(),
  beforeBlockedPreReconciliationRepair,
  'the independent-review blocker must fire before any durable repair mutation'
);

await applyStrictTriggerAclFixture();
verificationNotices.length = 0;
await assert.rejects(
  db.exec(verificationSql, verificationOptions),
  /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/
);
await db.exec('rollback;');
assert.equal(verificationNotices.length, 0);
await db.exec(`revoke execute on function ${clinicalTreatmentSessionProcedure} from public`);
verificationNotices.length = 0;
await db.exec(verificationSql, verificationOptions);
assert.equal(
  verificationNotices.length,
  0,
  'strict post-remediation verification must accept the direct authenticated-only ACL'
);

// The psql two-statement XID probe distinguishes normal autocommit from an
// already-open transaction before the artifact drops any prior temp marker.
const firstAutocommitProbeXid = (await db.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
const secondAutocommitProbeXid = (await db.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
assert.notEqual(
  firstAutocommitProbeXid,
  secondAutocommitProbeXid,
  'separate autocommit statements must receive different transaction IDs'
);
await db.exec('begin;');
const firstOuterTransactionProbeXid = (await db.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
const secondOuterTransactionProbeXid = (await db.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
assert.equal(
  firstOuterTransactionProbeXid,
  secondOuterTransactionProbeXid,
  'an existing outer transaction must be visible to the psql XID probe'
);
await db.exec('rollback;');

const repairDurableSnapshot = async () => {
  const receiptExists = (await db.query(
    `select to_regclass('supabase_migrations.${repairReceiptTable}') is not null present`
  )).rows[0].present;
  return {
  ledger: (await db.query(`
    select version,name,statements
    from supabase_migrations.schema_migrations
    order by version
  `)).rows,
  schema: (await db.query(`
    select nspname,nspowner::regrole::text owner,nspacl::text acl
    from pg_namespace
    where nspname='supabase_migrations'
  `)).rows,
  receipts: receiptExists ? (await db.query(`
    select run_nonce::text run_nonce,gate_token,repair_xid,evidence,committed_at
    from supabase_migrations.${repairReceiptTable}
    order by committed_at,run_nonce
  `)).rows : [],
  relation: (await db.query(`
    select n.nspname,c.relname,c.relowner::regrole::text owner,c.relacl::text acl,
      obj_description(c.oid,'pg_class') description
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='supabase_migrations'
      and c.relname in ('schema_migrations','${repairReceiptTable}')
    order by c.relname
  `)).rows,
  columns: (await db.query(`
    select a.attname,format_type(a.atttypid,a.atttypmod) data_type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) default_expression
    from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where n.nspname='supabase_migrations'
      and c.relname in ('schema_migrations','${repairReceiptTable}')
      and a.attnum > 0 and not a.attisdropped
    order by c.relname,a.attnum
  `)).rows,
  constraints: (await db.query(`
    select constraint_definition.conname,
      constraint_definition.contype::text constraint_type,
      constraint_definition.condeferrable,
      constraint_definition.condeferred,
      constraint_definition.convalidated,
      constraint_definition.conislocal,
      constraint_definition.coninhcount,
      constraint_definition.connoinherit,
      pg_get_constraintdef(constraint_definition.oid,true) definition
    from pg_constraint constraint_definition
    join pg_class relation on relation.oid=constraint_definition.conrelid
    join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
    where relation_namespace.nspname='supabase_migrations'
      and relation.relname in ('schema_migrations','${repairReceiptTable}')
    order by relation.relname collate "C",constraint_definition.conname collate "C",
      constraint_definition.contype::text collate "C",
      pg_get_constraintdef(constraint_definition.oid,true) collate "C"
  `)).rows,
  sequences: (await db.query(`
    select schemaname,sequencename,sequenceowner,data_type,
      start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
    from pg_sequences
    where schemaname in ('public','supabase_migrations')
    order by schemaname collate "C",sequencename collate "C"
  `)).rows
  };
};

const canonicalReceiptEvidenceCheck = `(
  pg_catalog.jsonb_typeof(evidence)='object'
  and evidence->>'repair_gate_token'=gate_token
  and evidence->>'repair_run_nonce'=run_nonce::text
  and evidence->>'repair_transaction_xid'=repair_xid
) is true`;
const nullableReceiptEvidenceCheck = `
  pg_catalog.jsonb_typeof(evidence)='object'
  and evidence->>'repair_gate_token'=gate_token
  and evidence->>'repair_run_nonce'=run_nonce::text
  and evidence->>'repair_transaction_xid'=repair_xid
`;

async function createRepairReceiptFixture({
  evidenceCheck = canonicalReceiptEvidenceCheck,
  committedAtDefault = 'pg_catalog.clock_timestamp()'
} = {}) {
  await db.exec(`
    create table supabase_migrations.${repairReceiptTable} (
      run_nonce uuid not null primary key,
      gate_token text not null,
      repair_xid text not null,
      evidence jsonb not null,
      committed_at timestamptz not null default ${committedAtDefault},
      unique (gate_token,repair_xid),
      constraint cnyos_repair_receipt_gate_token_check
        check (gate_token ~ '^[0-9a-f]{64}$'),
      constraint cnyos_repair_receipt_xid_check
        check (repair_xid ~ '^[0-9]+$'),
      constraint cnyos_repair_receipt_evidence_check check (${evidenceCheck})
    );
    comment on table supabase_migrations.${repairReceiptTable} is
      'Committed CNYOS migration-ledger repair receipts. UUID and top-level XID replay guard; not migration provenance.';
    revoke all on table supabase_migrations.${repairReceiptTable}
      from public,anon,authenticated,service_role
  `);
}

async function rebuildMigrationLedgerFixture() {
  await db.exec(`
    create temporary table cnyos_ledger_repair_rows as
      select version,name,statements
      from supabase_migrations.schema_migrations;
    drop table supabase_migrations.schema_migrations;
    create table supabase_migrations.schema_migrations (
      version text not null primary key,
      statements text[],
      name text
    );
    insert into supabase_migrations.schema_migrations(version,name,statements)
    select version,name,statements from pg_temp.cnyos_ledger_repair_rows;
    drop table pg_temp.cnyos_ledger_repair_rows
  `);
}

async function assertRepairWriteRejectedBeforeMutation({ expected, message }) {
  const materialized = materializePsqlRepairArtifactForPGlite(
    recoverySql,
    nextRepairTestNonce()
  );
  const durableBefore = await repairDurableSnapshot();
  const notices = [];
  await db.exec(materialized.setupSessionSql);
  await db.exec(materialized.beforeTransactionSql);
  await db.exec(materialized.transactionPrefix);
  await db.exec(materialized.guardStatement);
  await assert.rejects(
    db.exec(materialized.writeStatement, {
      onNotice: notice => notices.push(notice.message)
    }),
    expected
  );
  await db.exec('rollback;');
  assert.deepEqual(await repairDurableSnapshot(), durableBefore, message);
  assert.equal(
    notices.some(notice => /LEDGER_RECONCILED|MIGRATION_LEDGER_RECONCILED/.test(notice)),
    false,
    'a pre-mutation refusal must not emit success-shaped evidence'
  );
}

// A client may recover the guard statement with a savepoint and keep sending
// statements in the same transaction. The pre-reconciliation repair DO must
// independently refuse before evaluating declarations or touching any object.
{
  const materialized = materializePsqlRepairArtifactForPGlite(
    preReconciliationRecoverySql,
    nextRepairTestNonce()
  );
  const durableBeforeBypassAttempt = await repairDurableSnapshot();
  const notices = [];

  assert.equal((await db.query(
    `select to_regclass('pg_temp.${repairEvidenceMarker}')::text marker`
  )).rows[0].marker, null);
  await db.exec(materialized.setupSessionSql);
  await db.exec(materialized.beforeTransactionSql);
  await db.exec(materialized.transactionPrefix);

  await db.exec('savepoint recover_pre_reconciliation_guard;');
  await assert.rejects(
    db.exec(materialized.guardStatement, {
      onNotice: notice => notices.push(notice.message)
    }),
    /CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED/
  );
  await db.exec('rollback to savepoint recover_pre_reconciliation_guard;');
  await db.exec('release savepoint recover_pre_reconciliation_guard;');

  await db.exec('savepoint recover_pre_reconciliation_repair;');
  await assert.rejects(
    db.exec(materialized.writeStatement, {
      onNotice: notice => notices.push(notice.message)
    }),
    /CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED/
  );
  await db.exec('rollback to savepoint recover_pre_reconciliation_repair;');
  await db.exec('release savepoint recover_pre_reconciliation_repair;');

  assert.equal((await db.query(
    `select to_regclass('pg_temp.${repairEvidenceMarker}')::text marker`
  )).rows[0].marker, null, 'savepoint recovery must not leave a repair marker');
  await db.exec(materialized.commitStatement);
  assert.deepEqual(
    await repairDurableSnapshot(),
    durableBeforeBypassAttempt,
    'guard recovery followed by the repair DO must not mutate ledger, receipt, or schema state'
  );
  assert.deepEqual(
    await materializedRepairEvidenceRows(db, materialized),
    [],
    'guard recovery followed by the repair DO must not expose success evidence'
  );
  assert.equal(
    notices.some(notice => /LEDGER_RECONCILED|MIGRATION_LEDGER_RECONCILED/.test(notice)),
    false,
    'guard recovery followed by the repair DO must not emit success-shaped notices'
  );
  assert.equal(
    (await db.query(
      `select current_setting('${repairCommittedNonceGuc}',true) committed_nonce`
    )).rows[0].committed_nonce,
    '',
    'guard recovery followed by the repair DO must not set a committed nonce'
  );
  assert.equal(
    (await db.query(
      `select current_setting('${repairCommittedXidGuc}',true) committed_xid`
    )).rows[0].committed_xid,
    '',
    'guard recovery followed by the repair DO must not set a committed XID'
  );
}

// A client that continues after an error must not turn an aborted repair into
// success-shaped evidence. Exercise both ordinary transaction abort and a
// client savepoint recovery, beginning each run with plausible stale evidence
// from a different nonce. Inject after the ledger upsert so the production
// artifact remains free to reject every durable ledger/receipt trigger.
for (const useSavepoint of [false, true]) {
  const staleNonce = nextRepairTestNonce();
  const materialized = injectMidRepairFailure(
    materializePsqlRepairArtifactForPGlite(
      recoverySql,
      nextRepairTestNonce()
    )
  );
  await db.exec(`
    drop table if exists pg_temp.${repairEvidenceMarker};
    create temporary table ${repairEvidenceMarker} (
      gate_token text not null,
      run_nonce uuid not null,
      repair_xid text not null,
      evidence jsonb,
      primary key (gate_token,run_nonce,repair_xid)
    ) on commit preserve rows;
    insert into pg_temp.${repairEvidenceMarker}(gate_token,run_nonce,repair_xid,evidence)
    values (
      '${materialized.gateToken}',
      '${staleNonce}'::uuid,
      '7000001',
      jsonb_build_object(
        'status','PRIOR_TEST_SUCCESS',
        'repair_run_nonce','${staleNonce}'::uuid,
        'repair_transaction_xid','7000001'
      )
    );
    select set_config('${repairRunNonceGuc}','${staleNonce}',false);
    select set_config('${repairCommittedNonceGuc}','${staleNonce}',false);
    select set_config('${repairCommittedXidGuc}','7000001',false);
  `);
  const durableBeforeFailure = await repairDurableSnapshot();

  await db.exec(materialized.setupSessionSql);
  assert.deepEqual((await db.query(`
    select current_setting('${repairRunNonceGuc}',true) run_nonce,
      current_setting('${repairCommittedNonceGuc}',true) committed_nonce
  `)).rows, [{ run_nonce: materialized.runNonce, committed_nonce: '' }]);
  await db.exec(materialized.beforeTransactionSql);
  await db.exec(materialized.transactionPrefix);
  await db.exec(materialized.guardStatement);
  if (useSavepoint) await db.exec('savepoint client_statement;');
  await assert.rejects(db.exec(materialized.writeStatement), /TEST_LEDGER_REPAIR_ABORT/);
  if (useSavepoint) await db.exec('rollback to savepoint client_statement;');
  await db.exec(materialized.commitStatement);

  assert.deepEqual(
    await repairDurableSnapshot(),
    durableBeforeFailure,
    'failed repair must preserve durable rows, ACLs, comment, columns, constraints, and sequences'
  );
  assert.deepEqual(
    await materializedRepairEvidenceRows(db, materialized),
    [],
    'a failed repair must not expose nonce-bound success evidence'
  );
  assert.notEqual(
    (await db.query(
      `select current_setting('${repairCommittedNonceGuc}',true) committed_nonce`
    )).rows[0].committed_nonce,
    materialized.runNonce,
    'a failed repair must not retain its transactional commit nonce'
  );
  assert.equal(
    (await db.query(
      `select current_setting('${repairCommittedXidGuc}',true) committed_xid`
    )).rows[0].committed_xid,
    '',
    'a failed repair must not retain a committed top-level XID'
  );
  const marker = (await db.query(
    `select to_regclass('pg_temp.${repairEvidenceMarker}')::text marker`
  )).rows[0].marker;
  const survivingMarkers = marker === null ? [] : (await db.query(`
    select run_nonce::text run_nonce,repair_xid,evidence
    from pg_temp.${repairEvidenceMarker}
    order by run_nonce
  `)).rows;
  if (useSavepoint) {
    assert.deepEqual(
      survivingMarkers,
      [],
      'savepoint recovery must drop this run\'s empty guard marker at commit'
    );
  } else {
    assert.deepEqual(
      survivingMarkers,
      [{
        run_nonce: staleNonce,
        repair_xid: '7000001',
        evidence: {
          status: 'PRIOR_TEST_SUCCESS',
          repair_run_nonce: staleNonce,
          repair_transaction_xid: '7000001'
        }
      }],
      'ordinary abort must restore the stale marker dropped inside the failed transaction'
    );
  }
  await db.exec(`drop table if exists pg_temp.${repairEvidenceMarker};`);
}

// A complete marker and commit nonce from a prior run cannot satisfy a new
// run. This is the status-laundering case that a deterministic marker allowed.
const priorSuccessfulNonce = nextRepairTestNonce();
const currentRepair = materializePsqlRepairArtifactForPGlite(
  recoverySql,
  nextRepairTestNonce()
);
await db.exec(`
  create temporary table ${repairEvidenceMarker} (
    gate_token text not null,
    run_nonce uuid not null,
    repair_xid text not null,
    evidence jsonb,
    primary key (gate_token,run_nonce,repair_xid)
  ) on commit preserve rows;
  insert into pg_temp.${repairEvidenceMarker}(gate_token,run_nonce,repair_xid,evidence)
  values (
    '${currentRepair.gateToken}',
    '${priorSuccessfulNonce}'::uuid,
    '7000002',
    jsonb_build_object(
      'status','PRIOR_TEST_SUCCESS',
      'repair_run_nonce','${priorSuccessfulNonce}'::uuid,
      'repair_transaction_xid','7000002'
    )
  );
  select set_config('${repairRunNonceGuc}','${currentRepair.runNonce}',false);
  select set_config('${repairCommittedNonceGuc}','${priorSuccessfulNonce}',false);
  select set_config('${repairCommittedXidGuc}','7000002',false);
`);
assert.deepEqual(
  await materializedRepairEvidenceRows(db, currentRepair),
  [],
  'prior success evidence and its committed nonce must not authenticate a new run nonce'
);
await db.exec(`
  select set_config('${repairCommittedNonceGuc}','${currentRepair.runNonce}',false);
`);
assert.deepEqual(
  await materializedRepairEvidenceRows(db, currentRepair),
  [],
  'even a matching commit GUC must not authenticate a marker belonging to another nonce'
);
await db.exec(`
  update pg_temp.${repairEvidenceMarker}
  set run_nonce='${currentRepair.runNonce}'::uuid,
      evidence=jsonb_build_object(
        'status','STALE_REPLAY',
        'repair_run_nonce','${currentRepair.runNonce}'::uuid,
        'repair_transaction_xid','7000002'
      );
  select set_config('${repairCommittedXidGuc}','7000003',false);
`);
assert.deepEqual(
  await materializedRepairEvidenceRows(db, currentRepair),
  [],
  'a replayed nonce must still fail when the committed top-level XID differs'
);
await db.exec(`
  drop table pg_temp.${repairEvidenceMarker};
  select set_config('${repairCommittedNonceGuc}','',false);
  select set_config('${repairCommittedXidGuc}','',false);
`);

// A test-only deferred foreign key fails at COMMIT, after the repair statement
// has populated its marker and transactional commit GUC. This preserves the
// commit-time atomicity check without adding a now-forbidden ledger trigger.
await db.exec(`
  create temporary table cnyos_ledger_repair_commit_parent (
    id integer primary key
  ) on commit preserve rows;
  create temporary table cnyos_ledger_repair_commit_child (
    parent_id integer,
    constraint cnyos_ledger_repair_commit_fk foreign key (parent_id)
      references cnyos_ledger_repair_commit_parent(id)
      deferrable initially deferred
  ) on commit preserve rows
`);
const commitFailureRepair = materializePsqlRepairArtifactForPGlite(
  recoverySql,
  nextRepairTestNonce()
);
const durableBeforeCommitFailure = await repairDurableSnapshot();
await db.exec(commitFailureRepair.setupSessionSql);
await db.exec(commitFailureRepair.beforeTransactionSql);
await db.exec(commitFailureRepair.transactionPrefix);
await db.exec(commitFailureRepair.guardStatement);
await db.exec(commitFailureRepair.writeStatement);
await db.exec(`
  set constraints cnyos_ledger_repair_commit_fk deferred;
  insert into pg_temp.cnyos_ledger_repair_commit_child(parent_id) values (1)
`);
assert.equal(
  (await db.query(
    `select current_setting('${repairCommittedNonceGuc}',true) committed_nonce`
  )).rows[0].committed_nonce,
  commitFailureRepair.runNonce,
  'commit nonce should be provisional inside the still-uncommitted repair transaction'
);
assert.match(
  (await db.query(
    `select current_setting('${repairCommittedXidGuc}',true) committed_xid`
  )).rows[0].committed_xid,
  /^\d+$/,
  'top-level XID should be provisional inside the still-uncommitted repair transaction'
);
await assert.rejects(
  db.exec(commitFailureRepair.commitStatement),
  /cnyos_ledger_repair_commit_fk/
);
assert.deepEqual(
  await repairDurableSnapshot(),
  durableBeforeCommitFailure,
  'commit-time failure must roll back every durable repair mutation'
);
assert.deepEqual(
  await materializedRepairEvidenceRows(db, commitFailureRepair),
  [],
  'commit-time failure must leave no success evidence marker'
);
assert.notEqual(
  (await db.query(
    `select current_setting('${repairCommittedNonceGuc}',true) committed_nonce`
  )).rows[0].committed_nonce,
  commitFailureRepair.runNonce,
  'commit-time failure must roll back the transactional commit nonce'
);
assert.equal(
  (await db.query(
    `select current_setting('${repairCommittedXidGuc}',true) committed_xid`
  )).rows[0].committed_xid,
  '',
  'commit-time failure must roll back the transactional top-level XID'
);
await db.exec(`
  drop table pg_temp.cnyos_ledger_repair_commit_child;
  drop table pg_temp.cnyos_ledger_repair_commit_parent
`);

// Same-named permissive checks must not impersonate the locked receipt
// registry. Validate definitions before any ledger write and roll back cleanly.
await createRepairReceiptFixture({ evidenceCheck: 'true' });
await assertRepairWriteRejectedBeforeMutation({
  expected: /CNYOS_LEDGER_REPAIR_RECEIPT_CONSTRAINT_INVALID/,
  message: 'same-named permissive receipt constraints must fail before durable mutation'
});
await db.exec(`drop table supabase_migrations.${repairReceiptTable};`);

// The earlier three-valued CHECK accepted missing/JSON-null binding keys.
// Its exact definition must be rejected even though all other receipt catalog
// properties are canonical.
await createRepairReceiptFixture({ evidenceCheck: nullableReceiptEvidenceCheck });
await assertRepairWriteRejectedBeforeMutation({
  expected: /CNYOS_LEDGER_REPAIR_RECEIPT_CONSTRAINT_INVALID/,
  message: 'the old nullable evidence CHECK must fail before ledger mutation'
});
await db.exec(`drop table supabase_migrations.${repairReceiptTable};`);

// A stable transaction timestamp is not the reviewed receipt timestamp.
await createRepairReceiptFixture({ committedAtDefault: 'pg_catalog.now()' });
await assertRepairWriteRejectedBeforeMutation({
  expected: /CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID/,
  message: 'a noncanonical committed_at default must fail before ledger mutation'
});
await db.exec(`drop table supabase_migrations.${repairReceiptTable};`);

// Durable relation hooks can rewrite, suppress, or add ledger/receipt writes.
// Reject both trigger and rule mechanisms on both protected relations.
await createRepairReceiptFixture();
await db.exec(`
  create function supabase_migrations.cnyos_ledger_repair_hook_test()
  returns trigger language plpgsql set search_path=pg_catalog as $$
  begin
    return new;
  end $$
`);
for (const hook of [
  {
    setup: `create trigger cnyos_ledger_repair_hook_test before insert
      on supabase_migrations.schema_migrations for each row
      execute function supabase_migrations.cnyos_ledger_repair_hook_test()`,
    cleanup: `drop trigger cnyos_ledger_repair_hook_test
      on supabase_migrations.schema_migrations`,
    label: 'ledger trigger'
  },
  {
    setup: `create trigger cnyos_ledger_repair_hook_test before insert
      on supabase_migrations.${repairReceiptTable} for each row
      execute function supabase_migrations.cnyos_ledger_repair_hook_test()`,
    cleanup: `drop trigger cnyos_ledger_repair_hook_test
      on supabase_migrations.${repairReceiptTable}`,
    label: 'receipt trigger'
  },
  {
    setup: `create rule cnyos_ledger_repair_hook_test as on delete
      to supabase_migrations.schema_migrations do also nothing`,
    cleanup: `drop rule cnyos_ledger_repair_hook_test
      on supabase_migrations.schema_migrations`,
    label: 'ledger rule'
  },
  {
    setup: `create rule cnyos_ledger_repair_hook_test as on delete
      to supabase_migrations.${repairReceiptTable} do also nothing`,
    cleanup: `drop rule cnyos_ledger_repair_hook_test
      on supabase_migrations.${repairReceiptTable}`,
    label: 'receipt rule'
  }
]) {
  await db.exec(hook.setup);
  await assertRepairWriteRejectedBeforeMutation({
    expected: /CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID/,
    message: `${hook.label} must be rejected before ledger mutation`
  });
  await db.exec(hook.cleanup);
  if (hook.label.startsWith('ledger')) {
    await rebuildMigrationLedgerFixture();
  } else {
    await db.exec(`drop table supabase_migrations.${repairReceiptTable}`);
    await createRepairReceiptFixture();
  }
}
await db.exec(`
  drop function supabase_migrations.cnyos_ledger_repair_hook_test();
  drop table supabase_migrations.${repairReceiptTable}
`);

// Write-path atomicity is exercised only after the strict ACL end-state has
// passed. The transitional artifact is intentionally hard-blocked above.
const firstStrictRepairNonce = nextRepairTestNonce();
const firstStrictRepairEvidence = await executeMaterializedPsqlRepair(
  db,
  recoverySql,
  firstStrictRepairNonce
);
assert.equal(
  firstStrictRepairEvidence.status,
  'CNYOS_STAGING_MIGRATION_LEDGER_RECONCILED'
);
assert.equal(firstStrictRepairEvidence.ledger_reconciled, true);
assert.equal(firstStrictRepairEvidence.acl_remediation_pending, false);
assert.equal(
  firstStrictRepairEvidence.repository_derived_treatment_session_public_execute_debt_pending,
  false
);
assert.equal(firstStrictRepairEvidence.production_eligible, false);
assert.equal(firstStrictRepairEvidence.expected_project_ref, 'hsmnjwxurlmsizndjlun');
assert.equal(
  firstStrictRepairEvidence.expected_database_host,
  'db.hsmnjwxurlmsizndjlun.supabase.co'
);
assert.equal(firstStrictRepairEvidence.expected_system_identifier, pgliteSystemIdentifier);
assert.equal(firstStrictRepairEvidence.observed_system_identifier, pgliteSystemIdentifier);
assert.equal(
  firstStrictRepairEvidence.observed_psql_host,
  'db.hsmnjwxurlmsizndjlun.supabase.co'
);
assert.match(firstStrictRepairEvidence.repair_transaction_xid, /^\d+$/);
assert.match(firstStrictRepairEvidence.repair_gate_token, /^[0-9a-f]{64}$/);
const committedReceipt = (await db.query(`
  select run_nonce::text run_nonce,gate_token,repair_xid,evidence,
    committed_at is not null has_committed_at
  from supabase_migrations.${repairReceiptTable}
  where run_nonce='${firstStrictRepairNonce}'::uuid
`)).rows;
assert.equal(committedReceipt.length, 1);
assert.equal(committedReceipt[0].gate_token, firstStrictRepairEvidence.repair_gate_token);
assert.equal(committedReceipt[0].repair_xid, firstStrictRepairEvidence.repair_transaction_xid);
assert.deepEqual(committedReceipt[0].evidence, firstStrictRepairEvidence);
assert.equal(committedReceipt[0].has_committed_at, true);
const receiptRelation = (await db.query(`
  select relation.relowner::regrole::text owner,relation.relacl::text acl,
    pg_catalog.obj_description(relation.oid,'pg_class') description
  from pg_catalog.pg_class relation
  where relation.oid='supabase_migrations.${repairReceiptTable}'::regclass
`)).rows[0];
assert.equal(receiptRelation.owner, 'postgres');
assert.equal(receiptRelation.acl, '{postgres=arwdDxtm/postgres}');
assert.equal(
  receiptRelation.description,
  'Committed CNYOS migration-ledger repair receipts. UUID and top-level XID replay guard; not migration provenance.'
);
assert.deepEqual(
  (await db.query(`
    select conname
    from pg_catalog.pg_constraint
    where conrelid='supabase_migrations.${repairReceiptTable}'::regclass
    order by conname
  `)).rows.map(row => row.conname),
  [
    'cnyos_migration_ledger_repair_receipt_gate_token_repair_xid_key',
    'cnyos_migration_ledger_repair_receipts_pkey',
    'cnyos_repair_receipt_evidence_check',
    'cnyos_repair_receipt_gate_token_check',
    'cnyos_repair_receipt_xid_check'
  ]
);
assert.equal(
  (await db.query(`
    select pg_catalog.pg_get_constraintdef(oid,true) definition
    from pg_catalog.pg_constraint
    where conrelid='supabase_migrations.${repairReceiptTable}'::regclass
      and conname='cnyos_repair_receipt_evidence_check'
  `)).rows[0].definition,
  "CHECK ((jsonb_typeof(evidence) = 'object'::text AND (evidence ->> 'repair_gate_token'::text) = gate_token AND (evidence ->> 'repair_run_nonce'::text) = run_nonce::text AND (evidence ->> 'repair_transaction_xid'::text) = repair_xid) IS TRUE)"
);

// SQL CHECK accepts UNKNOWN unless the predicate is explicitly IS TRUE.
// Every receipt binding key must therefore reject both absence and JSON null.
for (const invalidKey of [
  'repair_gate_token',
  'repair_run_nonce',
  'repair_transaction_xid'
]) {
  for (const invalidValue of ['missing', 'json-null']) {
    const runNonce = nextRepairTestNonce();
    const evidence = {
      repair_gate_token: 'e'.repeat(64),
      repair_run_nonce: runNonce,
      repair_transaction_xid: '9000001'
    };
    if (invalidValue === 'missing') delete evidence[invalidKey];
    else evidence[invalidKey] = null;
    await assert.rejects(
      db.query(`
        insert into supabase_migrations.${repairReceiptTable}(
          run_nonce,gate_token,repair_xid,evidence
        ) values ($1::uuid,$2,$3,$4::jsonb)
      `, [runNonce, 'e'.repeat(64), '9000001', JSON.stringify(evidence)]),
      /cnyos_repair_receipt_evidence_check/,
      `${invalidValue} ${invalidKey} must violate the exact receipt evidence CHECK`
    );
  }
}
assert.equal(
  (await db.query(`
    select count(*)::int count
    from supabase_migrations.${repairReceiptTable}
  `)).rows[0].count,
  1,
  'rejected malformed evidence must not add a durable receipt'
);

// The post-commit proof must re-read an exact ledger snapshot. It may not
// authenticate a receipt after a nullable statements row or any committed
// name drift appears between the repair commit and proof transaction.
const committedRepairProof = materializePsqlRepairArtifactForPGlite(
  recoverySql,
  firstStrictRepairNonce
);
const nullableStatementEntry = entries[1];
await db.exec(`
  update supabase_migrations.schema_migrations
  set statements=null
  where version='${nullableStatementEntry.version}'
`);
assert.deepEqual(
  await exactMaterializedRepairEvidenceRows(db, committedRepairProof),
  [],
  'the durable exact proof must reject a NULL statements array'
);
await db.exec(`
  update supabase_migrations.schema_migrations
  set statements=array[${sqlLiteral(
    `-- recovered from supabase/migrations/${nullableStatementEntry.file}; sha256=${nullableStatementEntry.sha256}`
  )}]::text[]
  where version='${nullableStatementEntry.version}'
`);
const committedDriftEntry = entries[2];
await db.exec(`
  update supabase_migrations.schema_migrations
  set name='committed_drift'
  where version='${committedDriftEntry.version}'
`);
assert.deepEqual(
  await exactMaterializedRepairEvidenceRows(db, committedRepairProof),
  [],
  'the durable exact proof must reject committed ledger drift'
);
await db.exec(`
  update supabase_migrations.schema_migrations
  set name='${committedDriftEntry.name}'
  where version='${committedDriftEntry.version}'
`);
assert.equal(
  (await exactMaterializedRepairEvidenceRows(db, committedRepairProof)).length,
  1,
  'the durable exact proof must recover only after the exact ledger is restored'
);
assert.equal(
  (await db.query(`
    select coalesce(array_to_string(proconfig,','),'') function_config
    from pg_proc
    where oid='public.set_updated_at()'::regprocedure
  `)).rows[0].function_config,
  'search_path=pg_catalog, public',
  'strict repair must preserve the remediated set_updated_at configuration'
);
assert.equal(
  (await db.query('select count(*)::int count from supabase_migrations.schema_migrations')).rows[0].count,
  entries.length
);

// The durable UUID registry is the replay control. Canonical migration SHA
// comments prove ledger provenance, but cannot authorize reuse of a run nonce.
const replayRepair = materializePsqlRepairArtifactForPGlite(
  recoverySql,
  firstStrictRepairNonce
);
const durableBeforeNonceReplay = await repairDurableSnapshot();
await db.exec(replayRepair.setupSessionSql);
await db.exec(replayRepair.beforeTransactionSql);
await db.exec(replayRepair.transactionPrefix);
await db.exec(replayRepair.guardStatement);
await assert.rejects(
  db.exec(replayRepair.writeStatement),
  /CNYOS_LEDGER_REPAIR_NONCE_REPLAY/
);
await db.exec('rollback;');
assert.deepEqual(
  await repairDurableSnapshot(),
  durableBeforeNonceReplay,
  'replaying a committed nonce must preserve ledger rows and the durable receipt registry exactly'
);
assert.deepEqual(
  await materializedRepairEvidenceRows(db, replayRepair),
  [],
  'a refused nonce replay must not satisfy the current invocation commit proof'
);
assert.equal(
  (await db.query(`
    select count(*)::int count
    from supabase_migrations.${repairReceiptTable}
    where run_nonce='${firstStrictRepairNonce}'::uuid
  `)).rows[0].count,
  1,
  'nonce replay must not duplicate or replace its original durable receipt'
);

await applyStrictTriggerAclFixture();
verificationNotices.length = 0;
await db.exec(verificationSql, verificationOptions);
assert.equal(
  verificationNotices.length,
  0,
  'strict post-remediation verification must pass without an in-transaction success notice'
);

for (let run = 0; run < 2; run += 1) {
  const strictRepairEvidence = await executeMaterializedPsqlRepair(
    db,
    recoverySql,
    nextRepairTestNonce()
  );
  assert.equal(strictRepairEvidence.status, 'CNYOS_STAGING_MIGRATION_LEDGER_RECONCILED');
  assert.equal(strictRepairEvidence.ledger_reconciled, true);
  assert.equal(strictRepairEvidence.acl_remediation_pending, false);
  assert.equal(strictRepairEvidence.production_eligible, false);
}
const ledger = await db.query(`
  select version,name,statements
  from supabase_migrations.schema_migrations
  order by version
`);
assert.equal(ledger.rows.length, entries.length);
assert.deepEqual(ledger.rows.map(row => row.version), entries.map(entry => entry.version));
assert.deepEqual(ledger.rows.map(row => row.name), entries.map(entry => entry.name));
for (const [index, row] of ledger.rows.entries()) {
  const entry = entries[index];
  const canonicalEvidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
  assert.ok(Array.isArray(row.statements));
  assert.equal(
    row.statements.filter(statement => /^\s*-- recovered from supabase\/migrations\/[^;]+;\s*sha256\s*=/i.test(statement)).length,
    1,
    `${entry.file} must have exactly one canonical SHA evidence statement`
  );
  assert.equal(
    row.statements.filter(statement => statement === canonicalEvidence).length,
    1,
    `${entry.file} must carry the exact repository SHA evidence`
  );
}
assert.ok(
  ledger.rows.find(row => row.version === '202608311800').statements
    .includes("select 'pre-existing raw Supabase ledger statement'::text"),
  'ledger recovery must preserve pre-existing raw statements while appending canonical SHA evidence'
);

// The dedicated ACL contract owns candidate-source execution. Reapply only the
// reviewed browser ACL end-state here; Owner OFF/ON must work in the closed state.
const triggerBindingsBeforeBrowserClosure = (await db.query(
  'select oid,tgfoid,tgenabled from pg_trigger where not tgisinternal order by oid'
)).rows;
assert.deepEqual(
  (await db.query('select oid,tgfoid,tgenabled from pg_trigger where not tgisinternal order by oid')).rows,
  triggerBindingsBeforeBrowserClosure
);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const offRequestId = '44444444-4444-4444-a444-444444444444';
const onRequestId = '55555555-5555-4555-a555-555555555555';
const offSql = `
  select public.set_clinic_subscription_state(
    '${offRequestId}'::uuid,
    '${config.tenant.expectedClinicId}'::uuid,
    '${config.tenant.expectedClinicCode}',
    false,
    1,
    'Reviewed synthetic staging suspension',
    '${ADMIN_ID}'::uuid,
    'staging-admin@example.test'
  ) result
`;
await db.query(offSql);
await db.query(offSql);
assert.deepEqual(
  (await db.query(`select active,subscription_state,subscription_version from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows,
  [{ active: true, subscription_state: 'suspended', subscription_version: 2 }]
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_subscription_control_events where request_id='${offRequestId}'`)).rows[0].count,
  1,
  'retrying the same Owner request must be idempotent'
);
assert.equal(
  (await db.query(`select expected_version from public.clinic_subscription_control_events where request_id='${offRequestId}'`)).rows[0].expected_version,
  1,
  'the OFF evidence must bind the authoritative version observed by the Owner'
);

await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
await db.exec('rollback;');
assert.equal(
  (await db.query(`select subscription_state from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].subscription_state,
  'suspended',
  'tenant bootstrap must never reactivate a suspended subscription'
);

await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','${ADMIN_ID}',false);
`);
assert.equal((await db.query('select public.current_clinic_id() clinic_id')).rows[0].clinic_id, null);
assert.equal(
  (await db.query(`select public.is_clinic_member('${config.tenant.expectedClinicId}'::uuid) allowed`)).rows[0].allowed,
  false,
  'an already-issued staff identity must lose database tenant access while OFF'
);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`
  select public.set_clinic_subscription_state(
    '${onRequestId}'::uuid,
    '${config.tenant.expectedClinicId}'::uuid,
    '${config.tenant.expectedClinicCode}',
    true,
    2,
    'Reviewed synthetic staging reactivation',
    '${ADMIN_ID}'::uuid,
    'staging-admin@example.test'
  ) result
`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
assert.equal(
  (await db.query('select public.current_clinic_id() clinic_id')).rows[0].clinic_id,
  config.tenant.expectedClinicId,
  'ON must restore only the original active membership boundary'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_subscription_control_events where clinic_id='${config.tenant.expectedClinicId}'`)).rows[0].count,
  2
);
assert.deepEqual(
  (await db.query(`
    select request_id,expected_version
    from public.clinic_subscription_control_events
    where request_id in ('${offRequestId}'::uuid,'${onRequestId}'::uuid)
    order by expected_version
  `)).rows,
  [
    { request_id: offRequestId, expected_version: 1 },
    { request_id: onRequestId, expected_version: 2 }
  ]
);

await db.close();
console.log(`Migration ledger contract passed: ${entries.length} exact migrations, staging guards, schema fingerprint and non-null SHA-256 evidence`);
