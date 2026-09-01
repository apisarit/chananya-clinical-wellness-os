import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_DOMAINS,
  BACKUP_FORMAT,
  backupFileName,
  backupSlot,
  countDomainRows,
  createServiceAccountAssertion,
  decryptBackup,
  downloadDriveFile,
  encryptBackup,
  parseBackupEnvironment,
  parseEncryptionKey,
  parseServiceAccount,
  upsertDriveFile
} from '../netlify/functions/_shared/database-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
assert.deepEqual(parseEncryptionKey(key.toString('base64')), key);
assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString('base64')), /32_BYTES/);
assert.throws(
  () => parseEncryptionKey(key.toString('base64url')),
  /BACKUP_ENCRYPTION_KEY_INVALID/,
  'base64url aliases must not bypass canonical key comparison'
);
assert.throws(
  () => parseEncryptionKey(` ${key.toString('base64')}\n`),
  /BACKUP_ENCRYPTION_KEY_INVALID/,
  'whitespace aliases must not bypass canonical key comparison'
);
assert.equal(parseBackupEnvironment('STAGING'), 'staging');
assert.throws(() => parseBackupEnvironment('preview'), /ENVIRONMENT_INVALID/);
assert.deepEqual(BACKUP_DOMAINS, ['patients', 'products', 'pharmacy', 'transactions']);

const payload = {
  format: 'chananya-domain-export/v1',
  schema_version: '2026-08-27.1',
  clinic_id: '00000000-0000-0000-0000-000000000001',
  domain: 'patients',
  data: {
    patients: [{ id: 'patient-1', first_name: 'ข้อมูลทดสอบ' }],
    patient_allergies: [{ patient_id: 'patient-1', allergen_name: 'penicillin' }],
    encounters: []
  }
};
const encrypted = encryptBackup(payload, key, {
  environment: 'staging',
  deploymentId: 'chananya-clinical-staging',
  sourceRevision: '03cff43fda88292a6d88028ce1aeb2e861f76757',
  clinicId: payload.clinic_id,
  clinicCode: 'CHANANYA',
  domain: 'patients',
  slot: '2026-08-27T20:00:00.000Z'
}, {
  iv: Buffer.alloc(12, 7),
  createdAt: '2026-08-27T20:00:01.000Z'
});
assert.equal(encrypted.envelope.format, BACKUP_FORMAT);
assert.equal(encrypted.envelope.algorithm, 'AES-256-GCM');
assert.equal(encrypted.envelope.metadata.environment, 'staging');
assert.equal(encrypted.envelope.metadata.deployment_id, 'chananya-clinical-staging');
assert.equal(encrypted.envelope.metadata.source_revision, '03cff43fda88292a6d88028ce1aeb2e861f76757');
assert.deepEqual(decryptBackup(encrypted.envelope, key), payload);
assert.doesNotMatch(encrypted.bytes.toString('utf8'), /ข้อมูลทดสอบ|penicillin|first_name/);

const tampered = { ...encrypted.envelope, ciphertext: `${encrypted.envelope.ciphertext.slice(0, -2)}AA` };
assert.throws(() => decryptBackup(tampered, key), /INTEGRITY|authenticate/i);
assert.throws(() => decryptBackup({ ...encrypted.envelope, key_id: '0000000000000000' }, key), /KEY_ID_MISMATCH/);
assert.deepEqual(countDomainRows(payload), { patients: 1, patient_allergies: 1, encounters: 0 });
assert.equal(
  backupFileName('CHANANYA', 'transactions', '2026-08-27T20:00:00.000Z', 'cdb.json.enc', 'staging'),
  'STAGING_CHANANYA_transactions_20260827T200000Z.cdb.json.enc'
);
assert.equal(backupSlot(new Date('2026-08-27T21:14:00Z')), '2026-08-27T20:00:00.000Z');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = parseServiceAccount(JSON.stringify({
  client_email: 'backup@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
}));
const assertion = createServiceAccountAssertion(serviceAccount, Date.parse('2026-08-27T20:00:00Z'));
const [, encodedClaims] = assertion.split('.');
const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
assert.equal(claims.iss, 'backup@example.iam.gserviceaccount.com');
assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
assert.equal(claims.exp - claims.iat, 3600);
assert.match(claims.scope, /drive\.file/);

const createdCalls = [];
const createFetch = async (url, options = {}) => {
  createdCalls.push({ url: String(url), options });
  if (String(url).includes('/drive/v3/files?') && !String(url).includes('/upload/')) {
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: 'drive-created', name: 'backup.enc', size: '123' }), { status: 200 });
};
const created = await upsertDriveFile({
  accessToken: 'access-token',
  folderId: 'folder-patients',
  name: 'backup.enc',
  bytes: encrypted.bytes,
  fetchImpl: createFetch
});
assert.equal(created.operation, 'created');
assert.equal(createdCalls[0].options.method, undefined);
assert.equal(createdCalls[1].options.method, 'POST');
assert.match(createdCalls[1].options.headers['Content-Type'], /^multipart\/related/);

const updatedCalls = [];
const updateFetch = async (url, options = {}) => {
  updatedCalls.push({ url: String(url), options });
  if (String(url).includes('/drive/v3/files?') && !String(url).includes('/upload/')) {
    return new Response(JSON.stringify({ files: [{ id: 'drive-existing', name: 'backup.enc' }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: 'drive-existing', name: 'backup.enc', size: '124' }), { status: 200 });
};
const updated = await upsertDriveFile({
  accessToken: 'access-token',
  folderId: 'folder-patients',
  name: 'backup.enc',
  bytes: encrypted.bytes,
  fetchImpl: updateFetch
});
assert.equal(updated.operation, 'updated');
assert.equal(updatedCalls[1].options.method, 'PATCH');
assert.match(updatedCalls[1].url, /drive-existing/);

const downloaded = await downloadDriveFile({
  accessToken: 'access-token',
  fileId: 'drive-existing',
  fetchImpl: async (url, options) => {
    assert.match(String(url), /drive-existing\?alt=media/);
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    return new Response(encrypted.bytes, { status: 200 });
  }
});
assert.deepEqual(downloaded, encrypted.bytes);
await assert.rejects(
  downloadDriveFile({
    accessToken: 'access-token',
    fileId: 'missing',
    fetchImpl: async () => new Response('not found', { status: 404 })
  }),
  /DOWNLOAD_FAILED/
);

const scheduler = read('netlify/functions/database-backup.mts');
const background = read('netlify/functions/database-backup-background.mts');
const runtime = read('netlify/functions/_shared/database-backup-runtime.mjs');
assert.match(scheduler, /schedule:\s*'0 20 \* \* \*'/, 'backup must run daily at 03:00 Asia/Bangkok');
assert.match(background, /handleBackgroundBackup/, 'heavy work must run in a Netlify background function');
assert.match(runtime, /begin_backup_export_run/, 'background worker must acquire an idempotent database lease');
assert.match(runtime, /complete_backup_export_run/, 'background worker must commit a non-PHI audit manifest');
assert.match(runtime, /BACKUP_DOMAINS/, 'background worker must export the four isolated domains');
assert.match(runtime, /BACKUP_ENVIRONMENT/, 'worker must bind every object to an explicit environment');
assert.match(runtime, /BACKUP_EXPECTED_SUPABASE_PROJECT_REF/, 'backup must pin the exact Supabase project for this deployment');
assert.match(runtime, /BACKUP_SUPABASE_PROJECT_MISMATCH/, 'backup must fail closed on a cross-project target');
assert.match(runtime, /GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID/, 'worker must isolate transaction and audit evidence');
assert.match(runtime, /BACKUP_STAGING_PRODUCTION_DENYLIST_REQUIRED/, 'staging backup must require an explicit customer Production denylist');
assert.match(runtime, /BACKUP_STAGING_CANNOT_USE_PRODUCTION_DATABASE/, 'staging backup must reject the Production database');
assert.match(runtime, /BACKUP_DRIVE_FOLDER_IDS_MUST_BE_UNIQUE/, 'domain folders must not collapse into one destination');
assert.doesNotMatch(runtime, /console\.(?:log|error)\([^\n]*(?:payload|ciphertext|serviceRoleKey)/, 'worker logs must not include backup payloads or secrets');

console.log('Encrypted Google Drive backup checks passed: environment-bound AES-256-GCM, transaction audit domain, JWT, stable upsert and idempotent audit lease');
