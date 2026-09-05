import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGoogleServiceAccountBinding,
  decryptGoogleServiceAccountCredential,
  encryptGoogleServiceAccountCredential,
  GOOGLE_SERVICE_ACCOUNT_BLOB_FORMAT,
  GOOGLE_SERVICE_ACCOUNT_BLOB_STORE,
  GOOGLE_SERVICE_ACCOUNT_MAX_BLOB_BYTES,
  googleServiceAccountBlobKey,
  googleServiceAccountBlobMetadata,
  googleServiceAccountWrapKeyReused,
  parseGoogleServiceAccountWrapKey,
  resolveGoogleServiceAccountCredential,
  validateGoogleServiceAccountDocument
} from '../netlify/functions/_shared/google-service-account-credential.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const projectId = 'jitarsa-staging-123';
const clientEmail = `backup@${projectId}.iam.gserviceaccount.com`;
const serviceAccountDocument = Object.freeze({
  type: 'service_account',
  project_id: projectId,
  private_key_id: '0123456789abcdef0123456789abcdef01234567',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: clientEmail,
  client_id: '123456789012345678901',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(clientEmail)}`,
  universe_domain: 'googleapis.com'
});
const source = JSON.stringify(serviceAccountDocument);
const wrapKeyValue = Buffer.alloc(32, 19).toString('base64');
const wrapKey = parseGoogleServiceAccountWrapKey(wrapKeyValue);
const binding = createGoogleServiceAccountBinding({
  siteId: '10000000-0000-4000-8000-000000000010',
  siteOrigin: 'https://synthetic-drive-staging.netlify.app',
  supabaseProjectRef: 'stagingprojectrefabc',
  deploymentId: 'jitarsa-clinical-staging',
  environment: 'staging',
  wrapKeyId: 'jitarsa-staging-2026-09-v1',
  expectedServiceAccountEmail: clientEmail
});

assert.deepEqual(validateGoogleServiceAccountDocument(source), {
  clientEmail,
  privateKey: serviceAccountDocument.private_key,
  tokenUri: serviceAccountDocument.token_uri,
  projectId,
  privateKeyId: serviceAccountDocument.private_key_id
});
assert.throws(
  () => validateGoogleServiceAccountDocument(JSON.stringify({ ...serviceAccountDocument, unexpected: 'rejected' })),
  /DOCUMENT_SCHEMA_INVALID/
);
assert.throws(
  () => validateGoogleServiceAccountDocument(JSON.stringify({ ...serviceAccountDocument, token_uri: 'https://attacker.example/token' })),
  /TOKEN_URI_INVALID/
);
assert.throws(
  () => validateGoogleServiceAccountDocument(JSON.stringify({ ...serviceAccountDocument, client_email: 'backup@another-project.iam.gserviceaccount.com' })),
  /DOCUMENT_PROJECT_MISMATCH/
);
assert.throws(
  () => validateGoogleServiceAccountDocument(`{"padding":"${'x'.repeat(17 * 1024)}"}`),
  /DOCUMENT_TOO_LARGE/
);
assert.throws(() => parseGoogleServiceAccountWrapKey(Buffer.alloc(31).toString('base64')), /WRAP_KEY_INVALID/);
assert.equal(
  googleServiceAccountWrapKeyReused(wrapKeyValue, wrapKeyValue.replace(/=+$/, '')),
  true,
  'alternate base64 spellings of the same 32-byte key must still count as reuse'
);
assert.equal(googleServiceAccountWrapKeyReused(wrapKeyValue, Buffer.alloc(32, 20).toString('base64')), false);

const otherProjectId = 'other-valid-project-1';
const otherClientEmail = `backup@${otherProjectId}.iam.gserviceaccount.com`;
const otherServiceAccountDocument = {
  ...serviceAccountDocument,
  project_id: otherProjectId,
  client_email: otherClientEmail,
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(otherClientEmail)}`
};
assert.throws(
  () => encryptGoogleServiceAccountCredential(JSON.stringify(otherServiceAccountDocument), wrapKey, binding),
  /EXPECTED_IDENTITY_MISMATCH/,
  'a valid credential for another Google project must not be provisioned for this tenant'
);

const envelope = encryptGoogleServiceAccountCredential(source, wrapKey, binding, {
  iv: Buffer.alloc(12, 7),
  createdAt: '2026-09-01T12:00:00.000Z'
});
assert.equal(envelope.format, GOOGLE_SERVICE_ACCOUNT_BLOB_FORMAT);
assert.equal(envelope.algorithm, 'AES-256-GCM');
assert.deepEqual(decryptGoogleServiceAccountCredential(JSON.stringify(envelope), wrapKey, binding), {
  clientEmail,
  privateKey: serviceAccountDocument.private_key,
  tokenUri: serviceAccountDocument.token_uri,
  projectId,
  privateKeyId: serviceAccountDocument.private_key_id
});

for (const changed of [
  { siteId: '20000000-0000-4000-8000-000000000020' },
  { siteOrigin: 'https://another-staging.netlify.app' },
  { supabaseProjectRef: 'anotherprojectrefabc' },
  { deploymentId: 'another-clinic-staging' },
  { environment: 'production' },
  { wrapKeyId: 'jitarsa-staging-2026-09-v2' },
  { expectedServiceAccountEmail: otherClientEmail }
]) {
  const wrongBinding = createGoogleServiceAccountBinding({
    siteId: changed.siteId || binding.netlify_site_id,
    siteOrigin: changed.siteOrigin || binding.site_origin,
    supabaseProjectRef: changed.supabaseProjectRef || binding.supabase_project_ref,
    deploymentId: changed.deploymentId || binding.deployment_id,
    environment: changed.environment || binding.environment,
    wrapKeyId: changed.wrapKeyId || binding.wrap_key_id,
    expectedServiceAccountEmail: changed.expectedServiceAccountEmail || binding.service_account_client_email
  });
  assert.throws(
    () => decryptGoogleServiceAccountCredential(JSON.stringify(envelope), wrapKey, wrongBinding),
    /BLOB_BINDING_MISMATCH/
  );
}

const tamperedTag = Buffer.from(envelope.tag, 'base64');
tamperedTag[0] ^= 1;
assert.throws(
  () => decryptGoogleServiceAccountCredential(JSON.stringify({
    ...envelope,
    tag: tamperedTag.toString('base64')
  }), wrapKey, binding),
  /BLOB_DECRYPT_FAILED/
);
assert.throws(
  () => decryptGoogleServiceAccountCredential(JSON.stringify({
    ...envelope,
    created_at: '2026-09-01T12:00:01.000Z'
  }), wrapKey, binding),
  /BLOB_DECRYPT_FAILED/
);
assert.throws(
  () => decryptGoogleServiceAccountCredential(JSON.stringify(envelope), Buffer.alloc(32, 20), binding),
  /BLOB_DECRYPT_FAILED/
);
assert.throws(() => decryptGoogleServiceAccountCredential('{broken', wrapKey, binding), /BLOB_JSON_INVALID/);
assert.throws(
  () => decryptGoogleServiceAccountCredential('x'.repeat(GOOGLE_SERVICE_ACCOUNT_MAX_BLOB_BYTES + 1), wrapKey, binding),
  /BLOB_TOO_LARGE/
);
assert.throws(
  () => decryptGoogleServiceAccountCredential(JSON.stringify({ ...envelope, extra: true }), wrapKey, binding),
  /BLOB_SCHEMA_INVALID/
);

const storeCalls = [];
const store = {
  async getWithMetadata(key, options) {
    storeCalls.push({ key, options });
    return {
      data: JSON.stringify(envelope),
      metadata: googleServiceAccountBlobMetadata(binding),
      etag: 'test-etag'
    };
  }
};
const resolved = await resolveGoogleServiceAccountCredential({
  environment: binding.environment,
  deploymentId: binding.deployment_id,
  supabaseProjectRef: binding.supabase_project_ref,
  siteId: binding.netlify_site_id,
  siteOrigin: binding.site_origin,
  wrapKeyId: binding.wrap_key_id,
  wrapKeyValue,
  expectedServiceAccountEmail: binding.service_account_client_email,
  storeFactory: options => {
    assert.deepEqual(options, { name: GOOGLE_SERVICE_ACCOUNT_BLOB_STORE, consistency: 'strong' });
    return store;
  }
});
assert.equal(resolved.source, 'netlify-blob');
assert.equal(resolved.keyId, binding.wrap_key_id);
assert.equal(resolved.serviceAccount.clientEmail, clientEmail);
assert.deepEqual(storeCalls, [{
  key: googleServiceAccountBlobKey(binding.wrap_key_id),
  options: { type: 'text', consistency: 'strong' }
}]);

await assert.rejects(
  resolveGoogleServiceAccountCredential({
    environment: binding.environment,
    deploymentId: binding.deployment_id,
    supabaseProjectRef: binding.supabase_project_ref,
    siteId: binding.netlify_site_id,
    siteOrigin: binding.site_origin,
    wrapKeyId: binding.wrap_key_id,
    wrapKeyValue,
    expectedServiceAccountEmail: binding.service_account_client_email,
    storeFactory: () => ({ getWithMetadata: async () => null })
  }),
  /BLOB_MISSING/
);
await assert.rejects(
  resolveGoogleServiceAccountCredential({
    environment: binding.environment,
    deploymentId: binding.deployment_id,
    supabaseProjectRef: binding.supabase_project_ref,
    siteId: binding.netlify_site_id,
    siteOrigin: binding.site_origin,
    wrapKeyId: binding.wrap_key_id,
    wrapKeyValue,
    expectedServiceAccountEmail: binding.service_account_client_email,
    directJsonValue: source,
    storeFactory: () => store
  }),
  /DIRECT_ENV_FORBIDDEN/
);
await assert.rejects(
  resolveGoogleServiceAccountCredential({
    environment: binding.environment,
    deploymentId: binding.deployment_id,
    supabaseProjectRef: binding.supabase_project_ref,
    siteId: binding.netlify_site_id,
    siteOrigin: binding.site_origin,
    wrapKeyId: binding.wrap_key_id,
    wrapKeyValue,
    expectedServiceAccountEmail: binding.service_account_client_email,
    storeFactory: () => ({ getWithMetadata: async () => ({
      data: JSON.stringify(envelope),
      metadata: { ...googleServiceAccountBlobMetadata(binding), deploymentId: 'wrong-deployment' }
    }) })
  }),
  /BLOB_METADATA_MISMATCH/
);
const restoreTest = await resolveGoogleServiceAccountCredential({
  environment: 'restore-test',
  directJsonValue: source,
  allowRestoreTestDirectJson: true,
  expectedServiceAccountEmail: clientEmail
});
assert.equal(restoreTest.source, 'restore-test-direct');
assert.equal(restoreTest.serviceAccount.clientEmail, clientEmail);
await assert.rejects(
  resolveGoogleServiceAccountCredential({
    environment: 'restore-test',
    directJsonValue: source,
    expectedServiceAccountEmail: clientEmail
  }),
  /RESTORE_TEST_DIRECT_JSON_REQUIRED/
);

const provisioner = read('scripts/provision-google-service-account-blob.mjs');
assert.match(provisioner, /getStore\(\{[\s\S]*name:\s*GOOGLE_SERVICE_ACCOUNT_BLOB_STORE,[\s\S]*consistency:\s*'strong'/);
assert.match(provisioner, /onlyIfNew:\s*true/);
assert.match(provisioner, /SOURCE_MUST_BE_OUTSIDE_REPOSITORY/);
assert.match(provisioner, /fileURLToPath\(import\.meta\.url\)/);
assert.doesNotMatch(provisioner, /realpath\(process\.cwd\(\)\)/);
assert.doesNotMatch(provisioner, /console\.(?:log|error)\([^\n]*(?:private_key|NETLIFY_AUTH_TOKEN|wrapKeyValue|serialized)/);
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const netlifyBlobsVersion = packageJson.dependencies['@netlify/blobs'];
assert.match(netlifyBlobsVersion, /^\d+\.\d+\.\d+$/, '@netlify/blobs must remain pinned to an exact version');
assert.equal(packageLock.packages[''].dependencies['@netlify/blobs'], netlifyBlobsVersion, 'package.json and package-lock root dependency must match');
assert.equal(packageLock.packages['node_modules/@netlify/blobs'].version, netlifyBlobsVersion, 'resolved @netlify/blobs version must match the declared exact version');
const [blobsMajor, blobsMinor, blobsPatch] = netlifyBlobsVersion.split('.').map(Number);
assert.ok(
  blobsMajor > 10 || (blobsMajor === 10 && (blobsMinor > 7 || (blobsMinor === 7 && blobsPatch >= 13))),
  '@netlify/blobs must not regress below the audited 10.7.13 security floor'
);
const foreignCwdRun = spawnSync(process.execPath, [
  path.join(root, 'scripts/provision-google-service-account-blob.mjs'),
  '--dry-run',
  path.join(root, 'package.json')
], {
  cwd: tmpdir(),
  encoding: 'utf8',
  env: {
    ...process.env,
    BACKUP_EXPECTED_NETLIFY_SITE_ID: binding.netlify_site_id,
    BACKUP_EXPECTED_SITE_ORIGIN: binding.site_origin,
    BACKUP_EXPECTED_SUPABASE_PROJECT_REF: binding.supabase_project_ref,
    BACKUP_DEPLOYMENT_ID: binding.deployment_id,
    BACKUP_ENVIRONMENT: binding.environment,
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: binding.wrap_key_id,
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: wrapKeyValue,
    GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL: clientEmail
  }
});
assert.equal(foreignCwdRun.status, 1);
assert.match(foreignCwdRun.stderr, /SOURCE_MUST_BE_OUTSIDE_REPOSITORY/);

console.log('Encrypted service-account credential contracts passed: site-scoped strong Blob, exact AAD binding, schema limits, tamper rejection and immutable rotation key');
