import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertProductionRuntimeBinding,
  REQUIRED_BINDING_KEYS,
  REQUIRED_SECRET_KEYS,
  LINE_KEYS,
  BACKUP_BINDING_KEYS,
  verifyProductionRuntime
} from '../scripts/verify-production-runtime-binding.mjs';

const siteId = '7da5e39e-580d-44f1-8623-605313e2fb2b';
const config = {
  deploymentId: 'cnyos-production',
  brand: { shortName: 'CNYOS', productName: 'Clinical', nameTh: 'คลินิก', nameEn: 'Clinic', descriptor: 'Clinical', mark: 'C', colors: { primary950:'#000000', primary900:'#111111', primary800:'#222222', primary700:'#333333', primary100:'#eeeeee', primary50:'#fafafa', accent:'#123456', accentSoft:'#abcdef', surface:'#ffffff', background:'#ffffff' } },
  tenant: { expectedClinicId: '00000000-0000-4000-8000-000000000001', expectedClinicCode: 'CHANANYA' },
  database: { url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiJ9.sig' },
  auth: { redirectOrigin: 'https://cnyos.cloud' }, identity: { qrIssuer: 'CHANANYA' }
};

const expected = {
  SUPABASE_URL: config.database.url,
  CNYOS_OWNER_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
  CNYOS_RUNTIME_EXPECTED_CLINIC_ID: config.tenant.expectedClinicId,
  CNYOS_ACCOUNT_CLINIC_ID: config.tenant.expectedClinicId,
  CNYOS_ACCOUNT_CLINIC_CODE: config.tenant.expectedClinicCode,
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: siteId,
  CNYOS_OWNER_EXPECTED_SITE_ORIGIN: config.auth.redirectOrigin,
  PATIENT_QR_ISSUER: config.identity.qrIssuer,
  BACKUP_PRODUCTION_SUPABASE_URL: config.database.url,
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  BACKUP_EXPECTED_NETLIFY_SITE_ID: siteId,
  BACKUP_EXPECTED_SITE_ORIGIN: config.auth.redirectOrigin,
  BACKUP_ENVIRONMENT: 'production',
  BACKUP_DEPLOYMENT_ID: config.deploymentId, CNYOS_OWNER_CONTROL_ENABLED: 'true', CNYOS_OWNER_DRIVE_ENABLED: 'true',
  BACKUP_ENABLED: 'true', CLINICAL_OS_SOURCE_COMMIT: 'a'.repeat(40),
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-secret', PATIENT_IDENTITY_HMAC_SECRET: 'synthetic-secret',
  LINE_LIFF_ID: '1234567890-Synthetic', LINE_LOGIN_CHANNEL_ID: '1234567891', LINE_MESSAGING_CHANNEL_ID: '1234567892',
  LINE_MESSAGING_CHANNEL_SECRET: 'synthetic-secret', LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'synthetic-secret'
};
function metadata(overrides = {}) {
  return Object.entries({ ...expected, ...overrides }).map(([key, value]) => ({ key, scopes: ['functions'], is_secret: key.includes('SECRET') || key.includes('TOKEN'), values: [{ value, context: 'production' }] }));
}
function check(overrides = {}, options = {}) {
  return assertProductionRuntimeBinding({ metadata: metadata(overrides), config, siteId, siteOrigin: config.auth.redirectOrigin, releaseCommit: 'a'.repeat(40), requireLine: true, ...options });
}

assert.equal(check().context, 'production');
assert.throws(() => check({ SUPABASE_URL: 'https://hsmnjwxurlmsizndjlun.supabase.co' }), /SUPABASE_URL_MISMATCH/);
assert.throws(() => check({ BACKUP_ENVIRONMENT: 'staging' }), /BACKUP_ENVIRONMENT_MISMATCH/);
assert.throws(() => check({}, { siteId: '10000000-0000-4000-8000-000000000010' }), /SITE_ID_MISMATCH/);
assert.throws(() => check({ CNYOS_OWNER_CONTROL_ENABLED: 'false' }), /OWNER_CONTROL_ENABLED_MISMATCH/);
assert.throws(() => check({}, { metadata: metadata().filter(item => item.key !== 'LINE_MESSAGING_CHANNEL_SECRET') }), /LINE_MESSAGING_CHANNEL_SECRET_MISSING/);
assert.throws(() => check({}, { metadata: [{ key: 'SUPABASE_URL', scopes: ['functions'], values: [{ value: expected.SUPABASE_URL, context: 'production' }, { value: 'stale', context: 'production' }] }, ...metadata().slice(1)] }), /CONTEXT_AMBIGUOUS/);
assert.deepEqual(REQUIRED_BINDING_KEYS.length > 0, true);
assert.deepEqual(REQUIRED_SECRET_KEYS.includes('SUPABASE_SERVICE_ROLE_KEY'), true);
assert.deepEqual(LINE_KEYS.includes('LINE_MESSAGING_CHANNEL_SECRET'), true);
assert.deepEqual(BACKUP_BINDING_KEYS.includes('BACKUP_ENVIRONMENT'), true);
assert.equal(check({}, { metadata: metadata().map(item => ({ ...item, values: item.values.map(v => ({ ...v, context: 'all' })) })) }).context, 'production');
assert.equal(check({}, { metadata: metadata().map(item => ({ ...item, values: [{ context: 'all', value: 'stale' }, ...item.values, { context: 'deploy-preview', value: '' }] })) }).context, 'production');
assert.equal(check({}, { metadata: [...metadata(), { key: 'UNRELATED_BUILD', scopes: ['builds'], values: [] }, { key: 'unrelated_var', scopes: ['functions'], values: [{ context: 'dev', value: null }] }] }).context, 'production');
assert.throws(() => check({}, { metadata: metadata().map(item => item.key === 'SUPABASE_URL' ? { ...item, scopes: ['builds'] } : item) }), /SUPABASE_URL_MISSING/);
assert.throws(() => check({}, { metadata: [...metadata(), metadata()[0]] }), /CONFLICT/);
for (const secret of [...REQUIRED_SECRET_KEYS, 'LINE_MESSAGING_CHANNEL_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN']) {
  for (const absent of ['', null, undefined]) assert.throws(() => check({ [secret]: absent }), /METADATA_INVALID/);
  for (const extraScope of ['builds', 'runtime', 'post-processing', 'build']) {
    assert.throws(() => check({}, { metadata: metadata().map(item => item.key === secret ? { ...item, scopes: ['functions', extraScope] } : item) }), /SCOPE_INVALID/);
  }
}
for (const flag of ['BACKUP_ENABLED', 'CNYOS_OWNER_DRIVE_ENABLED']) assert.throws(() => check({ [flag]: 'false' }), /MISMATCH/);
assert.throws(() => check({ BACKUP_DEPLOYMENT_ID: 'staging-backup' }), /MISMATCH/);
assert.throws(() => check({ CLINICAL_OS_SOURCE_COMMIT: 'b'.repeat(40) }), /MISMATCH/);
assert.throws(() => check({ LINE_LOGIN_CHANNEL_ID: 'secret-like-value' }), /INVALID/);
assert.throws(() => check({}, { metadata: metadata().map(item => item.key === 'LINE_LOGIN_CHANNEL_ID' ? { ...item, is_secret: true } : item) }), /INVALID/);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-runtime-binding-'));
const snapshotPath = path.join(temp, 'binding.json');
const env = {
  NETLIFY_SITE_ID: siteId, NETLIFY_AUTH_TOKEN: 'synthetic-token', EXPECTED_PRODUCTION_HOST: 'cnyos.cloud',
  EXPECTED_RELEASE_COMMIT: 'a'.repeat(40), CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(config),
  NETLIFY_RUNTIME_BINDING_SNAPSHOT_PATH: snapshotPath, RELEASE_REQUIRES_LINE: 'true'
};
const site = { id: siteId, account_id: 'acct-synthetic', ssl_url: 'https://cnyos.cloud', published_deploy: { context: 'production' } };
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = async (url) => url.includes('/sites/') ? response(site) : response(metadata());
try {
await verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: fetchMock });
const snapshotText = await fs.readFile(snapshotPath, 'utf8');
assert.ok(!snapshotText.includes('synthetic-secret') && !snapshotText.includes('synthetic-token'));
for (const secret of [...REQUIRED_SECRET_KEYS, 'LINE_MESSAGING_CHANNEL_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN']) assert.ok(!snapshotText.includes(secret));
await verifyProductionRuntime({ env, phase: 'post-upload', fetchImpl: fetchMock });
await fs.writeFile(snapshotPath, (await fs.readFile(snapshotPath, 'utf8')).replace(env.EXPECTED_RELEASE_COMMIT, 'b'.repeat(40)));
await assert.rejects(verifyProductionRuntime({ env, phase: 'post-upload', fetchImpl: fetchMock }), /NETLIFY_RUNTIME_BINDING_DRIFT/);
await assert.rejects(verifyProductionRuntime({ env: { ...env, NETLIFY_RUNTIME_BINDING_SNAPSHOT_PATH: path.join(temp, 'bad.json') }, phase: 'invalid', fetchImpl: fetchMock }), /NETLIFY_RUNTIME_PHASE_INVALID/);
await assert.rejects(verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: async () => { throw new Error('SECRET_PROVIDER_PAYLOAD'); } }), error => error.message === 'NETLIFY_API_REQUEST_FAILED' && !error.message.includes('SECRET'));
for (const field of ['schemaVersion', 'context', 'siteId', 'origin', 'configDigest', 'lineRequired']) {
  const tampered = { ...JSON.parse(snapshotText), [field]: 'tampered' };
  await fs.writeFile(snapshotPath, JSON.stringify(tampered));
  await assert.rejects(verifyProductionRuntime({ env, phase: 'post-upload', fetchImpl: fetchMock }), /BINDING_DRIFT/);
}
await fs.writeFile(snapshotPath, snapshotText);
const driftMock = async url => url.includes('/sites/') ? response(site) : response(metadata({ LINE_MESSAGING_CHANNEL_ID: '9876543210' }));
await assert.rejects(verifyProductionRuntime({ env, phase: 'post-upload', fetchImpl: driftMock }), /BINDING_DRIFT/);
const calls = [];
await verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: async (url, options) => {
  calls.push(url);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  return fetchMock(url);
} });
assert.equal(calls.length, 2);
assert.equal(calls[1], `https://api.netlify.com/api/v1/accounts/acct-synthetic/env?site_id=${siteId}&scope=functions`);
for (const failResponse of [new Response('SECRET_PROVIDER_PAYLOAD', {status:403}), new Response('not-json SECRET_PROVIDER_PAYLOAD', {status:200})]) {
  await assert.rejects(verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: async () => failResponse }), e => e.message === 'NETLIFY_API_REQUEST_FAILED');
}
await assert.rejects(verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: async () => response(null) }), /SITE_METADATA_INVALID/);
await assert.rejects(verifyProductionRuntime({ env, phase: 'pre-upload', fetchImpl: async url => url.includes('/sites/') ? response(site) : response({ wrong: [] }) }), /ENV_METADATA_INVALID/);
await assert.rejects(verifyProductionRuntime({ env: { ...env, NETLIFY_RUNTIME_BINDING_SNAPSHOT_PATH: path.join(temp, 'missing.json') }, phase: 'post-upload', fetchImpl: fetchMock }), /PRE_SNAPSHOT_MISSING/);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log('Production runtime binding contract passed: positive production binding and stale/ambiguous/missing integration rejection');
