#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';
import { parseEncryptionKey } from '../netlify/functions/_shared/database-backup.mjs';
import {
  createGoogleServiceAccountBinding,
  encryptGoogleServiceAccountCredential,
  GOOGLE_SERVICE_ACCOUNT_BLOB_STORE,
  GOOGLE_SERVICE_ACCOUNT_MAX_PLAINTEXT_BYTES,
  googleServiceAccountBlobKey,
  googleServiceAccountBlobMetadata,
  googleServiceAccountWrapKeyReused,
  parseGoogleServiceAccountWrapKey,
  resolveGoogleServiceAccountCredential
} from '../netlify/functions/_shared/google-service-account-credential.mjs';

function env(name) {
  return String(process.env[name] || '').trim();
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function readProtectedSource(fileName) {
  if (!path.isAbsolute(fileName)) fail('GOOGLE_SERVICE_ACCOUNT_SOURCE_PATH_MUST_BE_ABSOLUTE');
  const sourcePath = await fs.realpath(fileName).catch(() => fail('GOOGLE_SERVICE_ACCOUNT_SOURCE_NOT_FOUND'));
  const repositoryPath = await fs.realpath(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  ));
  if (sourcePath === repositoryPath || sourcePath.startsWith(`${repositoryPath}${path.sep}`)) {
    fail('GOOGLE_SERVICE_ACCOUNT_SOURCE_MUST_BE_OUTSIDE_REPOSITORY');
  }
  const stats = await fs.stat(sourcePath);
  if (!stats.isFile() || stats.size < 2 || stats.size > GOOGLE_SERVICE_ACCOUNT_MAX_PLAINTEXT_BYTES) {
    fail('GOOGLE_SERVICE_ACCOUNT_SOURCE_SIZE_INVALID');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    fail('GOOGLE_SERVICE_ACCOUNT_SOURCE_PERMISSIONS_INVALID');
  }
  return fs.readFile(sourcePath);
}

async function main() {
  const dryRun = process.argv[2] === '--dry-run';
  const sourceArgument = process.argv[dryRun ? 3 : 2];
  if (!sourceArgument || process.argv.length !== (dryRun ? 4 : 3)) {
    fail('USAGE_PROVISION_GOOGLE_SERVICE_ACCOUNT_BLOB');
  }

  const binding = createGoogleServiceAccountBinding({
    siteId: env('BACKUP_EXPECTED_NETLIFY_SITE_ID'),
    siteOrigin: env('BACKUP_EXPECTED_SITE_ORIGIN'),
    supabaseProjectRef: env('BACKUP_EXPECTED_SUPABASE_PROJECT_REF'),
    deploymentId: env('BACKUP_DEPLOYMENT_ID'),
    environment: env('BACKUP_ENVIRONMENT'),
    wrapKeyId: env('GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID'),
    expectedServiceAccountEmail: env('GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL')
  });
  const wrapKeyValue = env('GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64');
  const backupEncryptionKeyValue = env('BACKUP_ENCRYPTION_KEY_BASE64');
  if (backupEncryptionKeyValue) {
    const backupEncryptionKey = parseEncryptionKey(backupEncryptionKeyValue);
    backupEncryptionKey.fill(0);
  }
  if (googleServiceAccountWrapKeyReused(wrapKeyValue, backupEncryptionKeyValue)
    || googleServiceAccountWrapKeyReused(wrapKeyValue, env('BACKUP_INTERNAL_DISPATCH_SECRET'))) {
    fail('GOOGLE_SERVICE_ACCOUNT_WRAP_KEY_REUSE');
  }
  const source = await readProtectedSource(sourceArgument);
  const wrapKey = parseGoogleServiceAccountWrapKey(wrapKeyValue);
  let serialized;
  try {
    serialized = JSON.stringify(encryptGoogleServiceAccountCredential(source, wrapKey, binding));
  } finally {
    source.fill(0);
    wrapKey.fill(0);
  }

  if (dryRun) {
    console.log('Google service-account credential validated and encrypted locally; no blob was written.');
    return;
  }

  const token = env('NETLIFY_AUTH_TOKEN');
  const siteId = env('NETLIFY_SITE_ID');
  if (!token || siteId !== binding.netlify_site_id) fail('NETLIFY_BLOB_ADMIN_CONTEXT_INVALID');
  const store = getStore({
    name: GOOGLE_SERVICE_ACCOUNT_BLOB_STORE,
    consistency: 'strong',
    siteID: siteId,
    token
  });
  const blobKey = googleServiceAccountBlobKey(binding.wrap_key_id);
  let write;
  try {
    write = await store.set(blobKey, serialized, {
      onlyIfNew: true,
      metadata: googleServiceAccountBlobMetadata(binding)
    });
  } catch {
    fail('GOOGLE_SERVICE_ACCOUNT_BLOB_WRITE_FAILED');
  }
  if (!write?.modified) fail('GOOGLE_SERVICE_ACCOUNT_BLOB_KEY_ID_ALREADY_EXISTS');

  await resolveGoogleServiceAccountCredential({
    environment: binding.environment,
    deploymentId: binding.deployment_id,
    supabaseProjectRef: binding.supabase_project_ref,
    siteId: binding.netlify_site_id,
    siteOrigin: binding.site_origin,
    wrapKeyId: binding.wrap_key_id,
    wrapKeyValue,
    expectedServiceAccountEmail: binding.service_account_client_email,
    storeFactory: () => store
  });
  serialized = '';
  console.log('Encrypted credential blob was created and decrypted after a strong read. Google token and folder access were not tested; keep Owner Drive and backup disabled until separate live proof succeeds.');
}

main().catch(error => {
  const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(String(error?.message || ''))
    ? error.message
    : 'GOOGLE_SERVICE_ACCOUNT_BLOB_PROVISION_FAILED';
  console.error(code);
  process.exitCode = 1;
});
