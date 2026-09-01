import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBackupExportPayload,
  configuration,
  resolveClinicDriveDestination,
  resolveClinicFolderIds
} from '../netlify/functions/database-backup.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = fs.readFileSync(path.join(root, 'netlify/functions/_shared/database-backup-runtime.mjs'), 'utf8');

const baseEnvironment = Object.freeze({
  BACKUP_ENVIRONMENT: 'production',
  BACKUP_DEPLOYMENT_ID: 'synthetic-clinic-production',
  CLINICAL_OS_SOURCE_COMMIT: '7014dc9cbb5c4306dc970b419dcaf5b9b7fdd4dc',
  SUPABASE_URL: 'https://productionprojectabc.supabase.co',
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'productionprojectabc',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: 'synthetic-production-2026-09-v1',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'),
  GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL: 'backup@synthetic-production-1.iam.gserviceaccount.com',
  BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  BACKUP_INTERNAL_DISPATCH_SECRET: 'test-dispatch-secret-with-at-least-32-bytes',
  BACKUP_EXPECTED_NETLIFY_SITE_ID: '00000000-0000-4000-8000-000000000010',
  BACKUP_EXPECTED_SITE_ORIGIN: 'https://synthetic-clinic.netlify.app',
  GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID: 'root-folder-12345'
});

function configWith(overrides = {}) {
  const values = { ...baseEnvironment, ...overrides };
  globalThis.Netlify = { env: { get: name => values[name] || '' } };
  return configuration();
}

const noEnvFallback = configWith();
assert.equal(noEnvFallback.hasCompleteEnvFolderIds, false, 'DB assignments must allow folder env vars to be omitted');
const stagingTarget = Object.freeze({
  BACKUP_ENVIRONMENT: 'staging',
  BACKUP_DEPLOYMENT_ID: 'synthetic-clinic-staging',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co',
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'stagingprojectrefabc'
});
assert.throws(() => configWith({
  ...stagingTarget
}), /BACKUP_STAGING_PRODUCTION_DENYLIST_REQUIRED/);
const pinnedStaging = configWith({
  ...stagingTarget,
  BACKUP_PRODUCTION_SUPABASE_URL: baseEnvironment.SUPABASE_URL
});
assert.equal(pinnedStaging.expectedSupabaseProjectRef, 'stagingprojectrefabc');
assert.equal(
  pinnedStaging.productionSupabaseUrl,
  baseEnvironment.SUPABASE_URL,
  'staging must carry its own explicit Production project denylist'
);
assert.throws(() => configWith({
  ...stagingTarget,
  BACKUP_PRODUCTION_SUPABASE_URL: stagingTarget.SUPABASE_URL
}), /BACKUP_STAGING_CANNOT_USE_PRODUCTION_DATABASE/);

const exactExportData = {
  format: 'chananya-domain-export/v1',
  schema_version: '2026-09-01.1',
  clinic_id: '00000000-0000-4000-8000-000000000001',
  domain: 'pharmacy',
  data: Object.fromEntries([
    'counter_sales', 'counter_sale_items', 'counter_allocations', 'prescriptions',
    'prescription_items', 'dispensing_orders', 'dispensing_items'
  ].map(table => [table, []]))
};
exactExportData.included_tables = Object.keys(exactExportData.data).sort();
assert.equal(assertBackupExportPayload(exactExportData, {
  clinic_id: exactExportData.clinic_id
}, 'pharmacy'), exactExportData);
assert.throws(() => assertBackupExportPayload({
  ...exactExportData,
  data: { ...exactExportData.data, unexpected_sensitive_table: [] },
  included_tables: [...exactExportData.included_tables, 'unexpected_sensitive_table'].sort()
}, { clinic_id: exactExportData.clinic_id }, 'pharmacy'), /INCLUDED_TABLES_MISMATCH/);
assert.throws(
  () => configWith({ BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'anotherprojectrefabc' }),
  /BACKUP_SUPABASE_PROJECT_MISMATCH/,
  'the worker must pin the exact Supabase project instead of relying on a denylist alone'
);
assert.throws(
  () => configWith({ CLINICAL_OS_SOURCE_COMMIT: 'not-a-reviewed-commit' }),
  /BACKUP_SOURCE_COMMIT_INVALID/
);

assert.throws(
  () => configWith({ GOOGLE_DRIVE_PATIENTS_FOLDER_ID: 'patients-env' }),
  /BACKUP_DRIVE_ENV_FALLBACK_NOT_ALLOWED/,
  'staging/production must reject every global folder fallback'
);

const envFolderIds = Object.freeze({
  patients: 'patients-env',
  products: 'products-env',
  pharmacy: 'pharmacy-env',
  transactions: 'transactions-env',
  manifests: 'manifests-env'
});
assert.throws(() => configWith({
  GOOGLE_DRIVE_PATIENTS_FOLDER_ID: envFolderIds.patients,
  GOOGLE_DRIVE_PRODUCTS_FOLDER_ID: envFolderIds.products,
  GOOGLE_DRIVE_PHARMACY_FOLDER_ID: envFolderIds.pharmacy,
  GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID: envFolderIds.transactions,
  GOOGLE_DRIVE_MANIFESTS_FOLDER_ID: envFolderIds.manifests
}), /BACKUP_DRIVE_ENV_FALLBACK_NOT_ALLOWED/);

assert.throws(
  () => configWith({
    BACKUP_ENVIRONMENT: 'restore-test',
    BACKUP_DEPLOYMENT_ID: 'jitarsa-restore-test',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: '',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: '',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: '{"restore_test_fixture":true}',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_ALLOW_RESTORE_TEST_DIRECT_JSON: 'true',
    GOOGLE_DRIVE_PATIENTS_FOLDER_ID: 'duplicate-env',
    GOOGLE_DRIVE_PRODUCTS_FOLDER_ID: 'duplicate-env',
    GOOGLE_DRIVE_PHARMACY_FOLDER_ID: 'pharmacy-env',
    GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID: 'transactions-env',
    GOOGLE_DRIVE_MANIFESTS_FOLDER_ID: 'manifests-env'
  }),
  /BACKUP_DRIVE_FOLDER_IDS_MUST_BE_UNIQUE/
);

const clinicA = { clinic_id: '00000000-0000-4000-8000-000000000001', clinic_code: 'CLINIC-A' };
const clinicB = { clinic_id: '00000000-0000-4000-8000-000000000002', clinic_code: 'CLINIC-B' };
const calls = [];
const databaseFolders = (clinic, environment = 'production') => ({
  clinic_id: clinic.clinic_id,
  clinic_code: clinic.clinic_code,
  environment,
  patients_folder_id: `patients-${clinic.clinic_id}`,
  products_folder_id: `products-${clinic.clinic_id}`,
  pharmacy_folder_id: `pharmacy-${clinic.clinic_id}`,
  transactions_folder_id: `transactions-${clinic.clinic_id}`,
  manifests_folder_id: `manifests-${clinic.clinic_id}`,
  version: 7
});
const assignmentRpc = async (_config, name, body) => {
  calls.push({ name, body });
  const clinic = body.p_clinic_id === clinicA.clinic_id ? clinicA : clinicB;
  return [databaseFolders(clinic)];
};

const clinicAFolders = await resolveClinicFolderIds(noEnvFallback, clinicA, assignmentRpc);
const clinicBFolders = await resolveClinicFolderIds(noEnvFallback, clinicB, assignmentRpc);
assert.equal(calls[0].name, 'get_clinic_drive_backup_destination');
assert.deepEqual(calls[0].body, {
  p_clinic_id: clinicA.clinic_id,
  p_environment: 'production'
});
assert.equal(clinicAFolders.patients, `patients-${clinicA.clinic_id}`);
assert.equal(clinicBFolders.patients, `patients-${clinicB.clinic_id}`);
assert.notDeepEqual(clinicAFolders, clinicBFolders, 'folder assignments must be resolved per clinic');
const clinicADestination = await resolveClinicDriveDestination(noEnvFallback, clinicA, assignmentRpc);
assert.equal(clinicADestination.assignmentVersion, 7);
assert.equal(clinicADestination.folderIds.manifests, `manifests-${clinicA.clinic_id}`);

const missingRpc = async () => [];
await assert.rejects(
  resolveClinicFolderIds(noEnvFallback, clinicA, missingRpc),
  /BACKUP_DRIVE_DESTINATION_NOT_ASSIGNED/,
  'staging/production require an explicit per-clinic database assignment'
);

const partialRpc = async () => [{
  clinic_id: clinicA.clinic_id,
  clinic_code: clinicA.clinic_code,
  environment: 'production',
  patients_folder_id: 'patients-db-only'
}];
await assert.rejects(
  resolveClinicFolderIds(noEnvFallback, clinicA, partialRpc),
  /BACKUP_DRIVE_DESTINATION_INVALID/,
  'an incomplete database row must fail closed instead of silently using the environment fallback'
);
await assert.rejects(
  resolveClinicFolderIds(noEnvFallback, clinicA, partialRpc),
  /BACKUP_DRIVE_DESTINATION_INVALID/
);

const duplicateRpc = async () => [{
  clinic_id: clinicA.clinic_id,
  clinic_code: clinicA.clinic_code,
  environment: 'production',
  patients_folder_id: 'duplicate-db',
  products_folder_id: 'duplicate-db',
  pharmacy_folder_id: 'pharmacy-db',
  transactions_folder_id: 'transactions-db',
  manifests_folder_id: 'manifests-db',
  version: 1
}];
await assert.rejects(
  resolveClinicFolderIds(noEnvFallback, clinicA, duplicateRpc),
  /BACKUP_DRIVE_FOLDER_IDS_MUST_BE_UNIQUE/,
  'a complete but unsafe database assignment must not silently use the environment fallback'
);

const wrongTargetRpc = async () => [databaseFolders(clinicB)];
await assert.rejects(
  resolveClinicFolderIds(noEnvFallback, clinicA, wrongTargetRpc),
  /BACKUP_DRIVE_DESTINATION_TARGET_MISMATCH/,
  'a destination returned for another clinic must never be used or silently fall back'
);

const restoreConfig = configWith({
  BACKUP_ENVIRONMENT: 'restore-test',
  BACKUP_DEPLOYMENT_ID: 'jitarsa-restore-test',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: '',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: '',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: '{"restore_test_fixture":true}',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_ALLOW_RESTORE_TEST_DIRECT_JSON: 'true',
  GOOGLE_DRIVE_PATIENTS_FOLDER_ID: envFolderIds.patients,
  GOOGLE_DRIVE_PRODUCTS_FOLDER_ID: envFolderIds.products,
  GOOGLE_DRIVE_PHARMACY_FOLDER_ID: envFolderIds.pharmacy,
  GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID: envFolderIds.transactions,
  GOOGLE_DRIVE_MANIFESTS_FOLDER_ID: envFolderIds.manifests
});
let restoreRpcCalled = false;
assert.deepEqual(
  await resolveClinicFolderIds(restoreConfig, clinicA, async () => {
    restoreRpcCalled = true;
    return [];
  }),
  envFolderIds
);
assert.equal(restoreRpcCalled, false, 'restore-test must not call a staging/production destination RPC');

assert.match(worker, /const lease = firstRow[\s\S]*resolveClinicDriveDestination\(config, clinic, rpcWithDeadline\)/, 'the worker must lease and then resolve every clinic independently');
assert.match(worker, /finishRun\(config, lease\.run_id, 'failed', \{\}, \[\], code, deps, finalizationDeadlineAt\)/, 'a missing or invalid destination must leave failed database evidence inside the reserved finalization budget');
assert.match(worker, /folderId:\s*folderIds\[domain\]/, 'domain exports must use the resolved clinic destination');
assert.match(worker, /folderId:\s*folderIds\.manifests/, 'manifests must use the resolved clinic destination');
assert.match(worker, /drive_assignment_version:\s*assignmentVersion/, 'every uploaded object must bind the audited assignment version');
assert.match(worker, /destination_folder_id:\s*folderIds\[domain\]/, 'domain evidence must bind the exact destination folder');
assert.match(worker, /drive_assignment:\s*\{[\s\S]*folder_ids:\s*folderIds/, 'the non-PHI manifest must snapshot all five folders');
assert.doesNotMatch(worker, /folderId:\s*config\.folderIds/, 'uploads must not bypass per-clinic resolution');

console.log('Database-assigned Drive destination checks passed: mandatory per-clinic routing, restore-test-only env folders, and fail-closed resolution');
