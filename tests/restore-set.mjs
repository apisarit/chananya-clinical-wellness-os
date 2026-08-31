import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_DOMAINS,
  BACKUP_REQUIRED_TABLES,
  BACKUP_SCHEMA_VERSION,
  encryptBackup,
  verifyBackupSet
} from '../netlify/functions/_shared/database-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const key = Buffer.alloc(32, 19);
const clinicId = '10000000-0000-4000-a000-000000000001';
const slot = '2026-08-28T20:00:00.000Z';
const sourceRevision = '1234567890abcdef1234567890abcdef12345678';

function payload(domain, mutate = value => value) {
  const data = Object.fromEntries(BACKUP_REQUIRED_TABLES[domain].map(table => [table, []]));
  if (domain === 'patients') data.patients.push({ id: 'synthetic-patient' });
  return mutate({
    format: 'chananya-domain-export/v1',
    schema_version: BACKUP_SCHEMA_VERSION,
    clinic_id: clinicId,
    domain,
    exported_at: '2026-08-28T20:00:02.000Z',
    included_tables: Object.keys(data).sort(),
    filtered_tables: {},
    excluded_tables: [],
    recovery_model: { full_database_restore: 'managed database backup or PITR required' },
    data
  });
}

function envelope(domain, index, mutatePayload) {
  return encryptBackup(payload(domain, mutatePayload), key, {
    environment: 'staging',
    deploymentId: 'chananya-clinical-staging',
    sourceRevision,
    clinicId,
    clinicCode: 'CHANANYA-STAGING',
    domain,
    slot
  }, {
    iv: Buffer.alloc(12, index + 1),
    createdAt: '2026-08-28T20:00:03.000Z'
  }).envelope;
}

const envelopes = BACKUP_DOMAINS.map((domain, index) => envelope(domain, index));
const verified = verifyBackupSet(envelopes, key);
assert.equal(verified.valid, true);
assert.equal(verified.schema_version, BACKUP_SCHEMA_VERSION);
assert.equal(verified.source_revision, sourceRevision);
assert.equal(verified.total_rows, 1);
assert.equal(verified.domains.patients.row_counts.patients, 1);
assert.match(verified.restore_set_sha256, /^[0-9a-f]{64}$/);
assert.equal(verified.requires_managed_database_restore, true);

assert.throws(() => verifyBackupSet(envelopes.slice(0, 3), key), /DOMAIN_COUNT_INVALID/);
assert.throws(() => verifyBackupSet([...envelopes.slice(0, 3), envelopes[0]], key), /DUPLICATE_DOMAIN/);

const wrongSource = encryptBackup(payload('transactions'), key, {
  environment: 'staging', deploymentId: 'chananya-clinical-staging',
  sourceRevision: 'ffffffffffffffffffffffffffffffffffffffff', clinicId,
  clinicCode: 'CHANANYA-STAGING', domain: 'transactions', slot
}, { iv: Buffer.alloc(12, 9) }).envelope;
assert.throws(() => verifyBackupSet([...envelopes.slice(0, 3), wrongSource], key), /SOURCE_REVISION_MISMATCH/);

const missingTable = envelope('patients', 10, value => {
  delete value.data.clinical_record_signoffs;
  value.included_tables = Object.keys(value.data).sort();
  return value;
});
assert.throws(() => verifyBackupSet([missingTable, ...envelopes.slice(1)], key), /CLINICAL_RECORD_SIGNOFFS/);

const migration = [
  'supabase/migrations/202608282000_complete_clinical_backup_and_restore_evidence.sql',
  'supabase/migrations/202608291800_line_oa_operational_messaging.sql',
  'supabase/migrations/202608311800_owner_subscription_control.sql'
].map(read).join('\n');
for (const tables of Object.values(BACKUP_REQUIRED_TABLES)) {
  for (const table of tables) assert.match(migration, new RegExp(`'${table}'`), `${table} missing from backup migration`);
}
assert.match(migration, /managed database backup or PITR required/i);
assert.match(migration, /active unused patient_qr_sessions/);
assert.match(migration, /verify_clinic_restore_trace/);
assert.match(migration, /backup_restore_contract_healthcheck/);
assert.match(migration, /admin_set_staff_membership_active/);
assert.match(migration, /SELF_DEACTIVATION_NOT_ALLOWED/);

const restoreWorkflow = read('.github/workflows/isolated-restore-drill.yml');
assert.match(restoreWorkflow, /environment: restore-test/);
assert.match(restoreWorkflow, /restore:fetch/);
assert.match(restoreWorkflow, /restore:verify-database/);
assert.match(restoreWorkflow, /RESTORE_DRILL_ACK: ISOLATED_RESTORE_TEST_ONLY/);

const ciWorkflow = read('.github/workflows/ci.yml');
assert.match(ciWorkflow, /pull_request:/);
assert.match(ciWorkflow, /npm run check/);
assert.match(ciWorkflow, /evidence:release/);

const lineWorkflow = read('.github/workflows/line-staging-e2e.yml');
assert.match(lineWorkflow, /STAGING_LINE_ID_TOKEN/);
assert.match(lineWorkflow, /DEDICATED_TEST_LINE_ACCOUNT/);
assert.match(lineWorkflow, /staging:line/);
const lineScript = read('scripts/verify-line-staging.mjs');
for (const proof of [
  'issue_patient_line_link_code','confirm_patient_qr','start_manual_patient_encounter',
  'revoke_patient_identity_link','used LINE credential was accepted again',
  'expired LINE credential was accepted'
]) assert.match(lineScript, new RegExp(proof));

console.log('Restore-set checks passed: four encrypted domains, complete table contract, source binding, managed-restore evidence and exact-commit CI');
