import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_DOMAINS,
  BACKUP_REQUIRED_TABLES,
  BACKUP_SCHEMA_VERSION
} from '../netlify/functions/_shared/database-backup.mjs';
import {
  BACKUP_FINALIZATION_RESERVE_MS,
  assertDispatchBinding,
  assertScheduledInvocation,
  classifyBackupSlotRuns,
  configuration,
  createSignedDispatch,
  handleBackupRecovery,
  handleBackgroundBackup,
  handleScheduledBackup,
  mostRecentBackupSlot,
  runBackupClinicJob,
  runtimeIdentity,
  validateClinicList,
  validateCredentialMaterial,
  verifySignedDispatch
} from '../netlify/functions/_shared/database-backup-runtime.mjs';
import {
  assertPublishedNetlifyOrigin,
  verifyScheduledRouteDenial
} from '../scripts/verify-netlify-scheduled-route-denial.mjs';
import {
  assertScheduledDeployMetadata
} from '../scripts/verify-netlify-scheduled-deploy-metadata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const values = {
  BACKUP_ENABLED: 'true',
  BACKUP_ENVIRONMENT: 'staging',
  BACKUP_DEPLOYMENT_ID: 'jitarsa-clinical-staging',
  CLINICAL_OS_SOURCE_COMMIT: '7014dc9cbb5c4306dc970b419dcaf5b9b7fdd4dc',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co',
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'stagingprojectrefabc',
  BACKUP_PRODUCTION_SUPABASE_URL: 'https://productionprojectabc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-service-role',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: 'jitarsa-staging-2026-09-v1',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL: 'backup@jitarsa-staging.iam.gserviceaccount.com',
  BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'),
  BACKUP_INTERNAL_DISPATCH_SECRET: 'dispatch-secret-with-more-than-thirty-two-random-bytes',
  BACKUP_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010',
  BACKUP_EXPECTED_SITE_ORIGIN: 'https://synthetic-drive-staging.netlify.app',
  GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID: 'root-folder-12345',
  BACKUP_MAX_CLINICS_PER_RUN: '10'
};
const getEnv = name => values[name] || '';
const clinic = Object.freeze({
  clinic_id: '00000000-0000-4000-8000-000000000001',
  clinic_code: 'JITARSA-STG'
});
const context = Object.freeze({
  requestId: 'scheduler-request-id',
  site: Object.freeze({
    id: '10000000-0000-4000-8000-000000000010',
    url: 'https://synthetic-drive-staging.netlify.app'
  }),
  deploy: Object.freeze({ id: 'deploy_1234567890', context: 'production', published: true })
});
const now = Date.parse('2026-09-01T20:00:05.000Z');
const scheduledRequest = (functionName, nextRun = '2026-09-02T20:00:00Z') => new Request(
  `https://synthetic-drive-staging.netlify.app/.netlify/functions/${functionName}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ next_run: nextRun })
  }
);
const testServiceAccount = Object.freeze({
  clientEmail: 'backup@jitarsa-staging.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  tokenUri: 'https://oauth2.googleapis.com/token'
});
const credentialResolver = async input => {
  assert.equal(input.siteId, context.site.id);
  assert.equal(input.siteOrigin, context.site.url);
  assert.equal(input.supabaseProjectRef, values.BACKUP_EXPECTED_SUPABASE_PROJECT_REF);
  assert.equal(input.deploymentId, values.BACKUP_DEPLOYMENT_ID);
  assert.equal(input.expectedServiceAccountEmail, values.GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL);
  assert.equal(input.directJsonValue, '');
  return { serviceAccount: testServiceAccount, source: 'test-blob', keyId: values.GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID };
};
const config = configuration(getEnv);
const runtime = runtimeIdentity(config, context, getEnv);
assert.equal(config.expectedNetlifySiteId, context.site.id);
assert.equal(config.expectedSiteOrigin, context.site.url);
assert.throws(
  () => runtimeIdentity(config, {
    ...context,
    site: { ...context.site, id: '00000000-0000-4000-8000-000000000099' }
  }, getEnv),
  /BACKUP_NETLIFY_SITE_ID_MISMATCH/,
  'copied credentials must not run on another Netlify site ID'
);
assert.throws(
  () => runtimeIdentity(config, {
    ...context,
    site: { ...context.site, url: 'https://copied-site.netlify.app' }
  }, getEnv),
  /BACKUP_NETLIFY_SITE_ORIGIN_MISMATCH/,
  'copied credentials must not run on another Netlify site origin'
);
assert.throws(
  () => configuration(name => ({ ...values, BACKUP_EXPECTED_SITE_ORIGIN: 'https://example.com' })[name] || ''),
  /BACKUP_EXPECTED_SITE_ORIGIN_INVALID/
);

const health = [{
  ready: true,
  schema_version: BACKUP_SCHEMA_VERSION,
  domain_count: BACKUP_DOMAINS.length,
  patient_table_count: BACKUP_REQUIRED_TABLES.patients.length,
  product_table_count: BACKUP_REQUIRED_TABLES.products.length,
  pharmacy_table_count: BACKUP_REQUIRED_TABLES.pharmacy.length,
  transaction_table_count: BACKUP_REQUIRED_TABLES.transactions.length
}];

assert.throws(
  () => validateClinicList(Array.from({ length: 11 }, () => clinic), 10),
  /BACKUP_CLINIC_LIST_EXCEEDS_LIMIT/
);
assert.throws(
  () => validateClinicList([clinic, clinic], 10),
  /BACKUP_CLINIC_LIST_DUPLICATE/
);
assert.throws(
  () => configuration(name => ({ ...values, BACKUP_MAX_CLINICS_PER_RUN: '26' })[name] || ''),
  /BACKUP_MAX_CLINICS_INVALID/
);
assert.throws(
  () => configuration(name => ({ ...values, GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: '{"forbidden":true}' })[name] || ''),
  /BACKUP_GOOGLE_SERVICE_ACCOUNT_DIRECT_ENV_FORBIDDEN/
);
assert.throws(
  () => configuration(name => ({
    ...values,
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: values.BACKUP_ENCRYPTION_KEY_BASE64
  })[name] || ''),
  /BACKUP_CREDENTIAL_KEYS_MUST_BE_DISTINCT/
);
assert.throws(
  () => configuration(name => ({
    ...values,
    BACKUP_ENCRYPTION_KEY_BASE64: values.GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64.replace(/=+$/, '')
  })[name] || ''),
  /BACKUP_CREDENTIAL_KEYS_MUST_BE_DISTINCT/,
  'alternate base64 spellings of identical wrap and backup key bytes must be rejected'
);
assert.throws(
  () => configuration(name => ({
    ...values,
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: Buffer.alloc(32, 255).toString('base64'),
    BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 255).toString('base64url')
  })[name] || ''),
  /BACKUP_(?:CREDENTIAL_KEYS_MUST_BE_DISTINCT|ENCRYPTION_KEY_INVALID)/,
  'base64url aliases must fail closed at configuration'
);
assert.throws(
  () => configuration(name => ({
    ...values,
    BACKUP_ENCRYPTION_KEY_BASE64: ` ${values.GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64}\n`
  })[name] || ''),
  /BACKUP_(?:CREDENTIAL_KEYS_MUST_BE_DISTINCT|ENCRYPTION_KEY_INVALID)/,
  'whitespace aliases must fail closed at configuration'
);
assert.throws(
  () => configuration(name => ({
    ...values,
    GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: ''
  })[name] || ''),
  /BACKUP_CONFIGURATION_INCOMPLETE/
);

const signed = createSignedDispatch(
  config,
  clinic,
  '2026-09-01T20:00:00.000Z',
  runtime,
  {
    now,
    makeUuid: () => '11111111-1111-4111-8111-111111111111'
  }
);
const verified = verifySignedDispatch(config, signed.rawBody, new Headers(signed.headers), new Date(now));
assert.equal(verified.clinicId, clinic.clinic_id);
assert.equal(assertDispatchBinding(verified, config, runtime).clinic.clinic_code, clinic.clinic_code);
assert.throws(
  () => verifySignedDispatch(config, `${signed.rawBody} `, new Headers(signed.headers), new Date(now)),
  /BACKUP_DISPATCH_UNAUTHORIZED/,
  'any body change must invalidate the internal dispatch signature'
);
assert.equal(
  verifySignedDispatch(
    config,
    signed.rawBody,
    new Headers(signed.headers),
    new Date(now + (29 * 60 * 1000))
  ).dispatchId,
  '11111111-1111-4111-8111-111111111111',
  'a signed background dispatch must survive a bounded queue delay'
);
assert.throws(
  () => verifySignedDispatch(
    config,
    signed.rawBody,
    new Headers(signed.headers),
    new Date(now + (30 * 60 * 1000) + 1)
  ),
  /BACKUP_DISPATCH_UNAUTHORIZED/,
  'a dispatch delayed beyond the queue-safe window must expire'
);
assert.throws(
  () => verifySignedDispatch(
    config,
    signed.rawBody,
    new Headers(signed.headers),
    new Date(now - (60 * 1000) - 1)
  ),
  /BACKUP_DISPATCH_UNAUTHORIZED/,
  'future-dated dispatches beyond bounded clock skew must fail closed'
);
assert.throws(
  () => assertDispatchBinding({ ...verified, sourceRevision: '0'.repeat(40) }, config, runtime),
  /BACKUP_DISPATCH_BINDING_MISMATCH/,
  'a signed job is still pinned to the current reviewed source revision'
);
assert.deepEqual(
  await assertScheduledInvocation(scheduledRequest('database-backup')),
  { nextRun: '2026-09-02T20:00:00.000Z' }
);
await assert.rejects(
  assertScheduledInvocation(new Request(
    'https://synthetic-drive-staging.netlify.app/.netlify/functions/database-backup',
    { method: 'POST', body: '{}' }
  )),
  /BACKUP_SCHEDULED_INVOCATION_REQUIRED/
);

let publicSchedulerReachedSecretsOrDatabase = false;
const publicSchedulerResponse = await handleScheduledBackup(
  new Request('https://synthetic-drive-staging.netlify.app/.netlify/functions/database-backup'),
  context,
  {
    getEnv,
    credentialResolver: async () => {
      publicSchedulerReachedSecretsOrDatabase = true;
      throw new Error('UNEXPECTED_CREDENTIAL_ACCESS');
    },
    rpc: async () => {
      publicSchedulerReachedSecretsOrDatabase = true;
      throw new Error('UNEXPECTED_RPC');
    }
  }
);
assert.equal(publicSchedulerResponse.status, 401);
assert.deepEqual(await publicSchedulerResponse.json(), {
  ok: false,
  code: 'BACKUP_SCHEDULED_INVOCATION_REQUIRED'
});
assert.equal(publicSchedulerReachedSecretsOrDatabase, false, 'a public-shaped request must stop before secrets and database access');
const publicRecoveryResponse = await handleBackupRecovery(
  new Request('https://synthetic-drive-staging.netlify.app/.netlify/functions/database-backup-recovery', {
    method: 'POST',
    body: JSON.stringify({ next_run: '2026-09-01T21:00:00Z', attacker: true })
  }),
  context,
  {
    getEnv,
    credentialResolver: async () => {
      publicSchedulerReachedSecretsOrDatabase = true;
      throw new Error('UNEXPECTED_CREDENTIAL_ACCESS');
    }
  }
);
assert.equal(publicRecoveryResponse.status, 401);
assert.equal((await publicRecoveryResponse.json()).code, 'BACKUP_SCHEDULED_INVOCATION_REQUIRED');
assert.equal(publicSchedulerReachedSecretsOrDatabase, false, 'a malformed recovery event must stop before secret access');

assert.equal(
  assertPublishedNetlifyOrigin('https://synthetic-drive-staging.netlify.app'),
  'https://synthetic-drive-staging.netlify.app'
);
assert.throws(() => assertPublishedNetlifyOrigin('https://example.com'), /SCHEDULED_ROUTE_ORIGIN_INVALID/);
const externalDenialCalls = [];
const externalDenialEvidence = await verifyScheduledRouteDenial(
  'https://synthetic-drive-staging.netlify.app',
  async (url, options) => {
    externalDenialCalls.push({ url: String(url), options });
    return new Response('<!doctype html><title>Not Found</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' }
    });
  }
);
assert.equal(externalDenialEvidence.length, 4);
assert.deepEqual(externalDenialCalls.map(call => call.options.method), ['GET', 'POST', 'GET', 'POST']);
assert.ok(externalDenialCalls.every(call => call.options.redirect === 'error'));
const forbiddenExternalDenialEvidence = await verifyScheduledRouteDenial(
  'https://synthetic-drive-staging.netlify.app',
  async () => new Response('', {
    status: 403,
    headers: { 'Content-Type': 'text/plain' }
  })
);
assert.equal(forbiddenExternalDenialEvidence.length, 4);
assert.ok(forbiddenExternalDenialEvidence.every(item => item.status === 403));
await assert.rejects(
  verifyScheduledRouteDenial(
    'https://synthetic-drive-staging.netlify.app',
    async () => new Response(JSON.stringify({ ok: true, enabled: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  ),
  /SCHEDULED_FUNCTION_RUNTIME_REACHED/
);
await assert.rejects(
  verifyScheduledRouteDenial(
    'https://synthetic-drive-staging.netlify.app',
    async () => new Response(JSON.stringify({ ok: false, code: 'BACKUP_SCHEDULED_INVOCATION_REQUIRED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    })
  ),
  /SCHEDULED_FUNCTION_RUNTIME_REACHED/
);
await assert.rejects(
  verifyScheduledRouteDenial(
    'https://synthetic-drive-staging.netlify.app',
    async () => new Response('', { status: 401 })
  ),
  /SCHEDULED_FUNCTION_PUBLIC_ROUTE_PRESENT/
);
await assert.rejects(
  verifyScheduledRouteDenial(
    'https://synthetic-drive-staging.netlify.app',
    async () => new Response('', {
      status: 302,
      headers: { Location: 'https://synthetic-drive-staging.netlify.app/login.html' }
    })
  ),
  /SCHEDULED_FUNCTION_PUBLIC_ROUTE_PRESENT/
);
await assert.rejects(
  verifyScheduledRouteDenial(
    'https://synthetic-drive-staging.netlify.app',
    async () => new Response('x'.repeat((16 * 1024) + 1), { status: 404 })
  ),
  /SCHEDULED_ROUTE_DENIAL_BODY_TOO_LARGE/
);
const deployMetadata = {
  function_schedules: [
    { cron: '0 20 * * *', name: 'database-backup' },
    { cron: '*/15 0-2,20-23 * * *', name: 'database-backup-recovery' }
  ],
  available_functions: [
    { n: 'database-backup' },
    { n: 'database-backup-recovery' },
    { n: 'owner-subscription', ro: [{ p: '/api/owner-subscription' }] }
  ]
};
assert.equal(assertScheduledDeployMetadata(deployMetadata).length, 2);
assert.throws(
  () => assertScheduledDeployMetadata({
    ...deployMetadata,
    function_schedules: deployMetadata.function_schedules.map(item => item.name === 'database-backup-recovery'
      ? { ...item, cron: '*/30 * * * *' }
      : item)
  }),
  /NETLIFY_SCHEDULE_METADATA_INVALID/
);
assert.throws(
  () => assertScheduledDeployMetadata({
    ...deployMetadata,
    available_functions: deployMetadata.available_functions.map(item => item.n === 'database-backup'
      ? { ...item, ro: [] }
      : item)
  }),
  /NETLIFY_SCHEDULED_FUNCTION_CUSTOM_ROUTE_PRESENT/
);

const captured = [];
const rpc = async (_config, name) => {
  if (name === 'backup_restore_contract_healthcheck') return health;
  if (name === 'list_backup_export_clinics') return [clinic];
  throw new Error(`UNEXPECTED_RPC_${name}`);
};
const scheduledResponse = await handleScheduledBackup(
  scheduledRequest('database-backup'),
  context,
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => now,
    listSlotRuns: async () => [],
    randomUuid: () => '11111111-1111-4111-8111-111111111111',
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), options });
      return new Response('', { status: 202 });
    }
  }
);
assert.equal(scheduledResponse.status, 200);
assert.deepEqual(await scheduledResponse.json(), {
  ok: true,
  environment: 'staging',
  deploymentId: 'jitarsa-clinical-staging',
  sourceRevision: values.CLINICAL_OS_SOURCE_COMMIT,
  slot: '2026-09-01T20:00:00.000Z',
  observed: 0,
  missing: 1,
  stale: 0,
  completed: 0,
  pending: 0,
  partial: 0,
  terminalFailed: 0,
  unhealthy: 0,
  enqueued: 1,
  failed: 0
});
assert.equal(captured.length, 1, 'the scheduler must enqueue exactly one background job per clinic');
assert.equal(
  captured[0].url,
  'https://synthetic-drive-staging.netlify.app/.netlify/functions/database-backup-background'
);
assert.equal(captured[0].options.method, 'POST');
assert.equal(captured[0].options.redirect, 'error');
assert.equal(JSON.parse(captured[0].options.body).siteOrigin, context.site.url);
assert.doesNotMatch(
  captured[0].options.body,
  /server-only-test-service-role|BEGIN PRIVATE KEY|dispatch-secret|BACKUP_ENCRYPTION_KEY/,
  'the internal job body must not carry credentials or key material'
);
assertDispatchBinding(
  verifySignedDispatch(
    config,
    captured[0].options.body,
    new Headers(captured[0].options.headers),
    new Date(now)
  ),
  config,
  runtime
);

const enqueueFailure = await handleScheduledBackup(
  scheduledRequest('database-backup'),
  context,
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => now,
    listSlotRuns: async () => [],
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
    fetchImpl: async () => new Response('', { status: 500 })
  }
);
assert.equal(enqueueFailure.status, 502);
assert.equal((await enqueueFailure.json()).failed, 1, 'enqueue rejection must make the scheduled run unhealthy');

const slotClinics = Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({
  clinic_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  clinic_code: `SLOT-${index + 1}`
})));
const slotRuns = Object.freeze([
  Object.freeze({
    clinicId: slotClinics[1].clinic_id,
    slot: '2026-09-01T20:00:00.000Z',
    startedAt: '2026-09-01T20:01:00.000Z',
    status: 'completed'
  }),
  Object.freeze({
    clinicId: slotClinics[2].clinic_id,
    slot: '2026-09-01T20:00:00.000Z',
    startedAt: '2026-09-01T20:01:00.000Z',
    status: 'partial'
  }),
  Object.freeze({
    clinicId: slotClinics[3].clinic_id,
    slot: '2026-09-01T20:00:00.000Z',
    startedAt: '2026-09-01T20:01:00.000Z',
    status: 'failed'
  }),
  Object.freeze({
    clinicId: slotClinics[4].clinic_id,
    slot: '2026-09-01T20:00:00.000Z',
    startedAt: '2026-09-01T20:01:00.000Z',
    status: 'started'
  }),
  Object.freeze({
    clinicId: slotClinics[5].clinic_id,
    slot: '2026-09-01T20:00:00.000Z',
    startedAt: '2026-09-01T20:30:00.000Z',
    status: 'started'
  })
]);
const slotClassification = classifyBackupSlotRuns(
  slotClinics,
  slotRuns,
  Date.parse('2026-09-01T20:45:00.000Z')
);
assert.deepEqual(
  slotClassification.retryClinics.map(item => item.clinic_code),
  ['SLOT-1', 'SLOT-5'],
  'only missing and stale-started clinics are automatic retry candidates'
);
const filteredDispatches = [];
let filteredDispatchIndex = 0;
const filteredScheduledResponse = await handleScheduledBackup(
  scheduledRequest('database-backup'),
  context,
  {
    getEnv,
    credentialResolver,
    rpc: async (_config, name) => {
      if (name === 'backup_restore_contract_healthcheck') return health;
      if (name === 'list_backup_export_clinics') return slotClinics;
      throw new Error(`UNEXPECTED_RPC_${name}`);
    },
    nowMs: () => Date.parse('2026-09-01T20:45:00.000Z'),
    listSlotRuns: async () => slotRuns,
    randomUuid: () => [
      '99999999-9999-4999-8999-999999999991',
      '99999999-9999-4999-8999-999999999992'
    ][filteredDispatchIndex++],
    fetchImpl: async (_url, options) => {
      filteredDispatches.push(JSON.parse(options.body));
      return new Response('', { status: 202 });
    }
  }
);
const filteredScheduledResult = await filteredScheduledResponse.json();
assert.equal(filteredScheduledResponse.status, 503, 'terminal partial/failed evidence must keep the exact slot unhealthy');
assert.deepEqual({
  observed: filteredScheduledResult.observed,
  missing: filteredScheduledResult.missing,
  stale: filteredScheduledResult.stale,
  completed: filteredScheduledResult.completed,
  pending: filteredScheduledResult.pending,
  partial: filteredScheduledResult.partial,
  terminalFailed: filteredScheduledResult.terminalFailed,
  unhealthy: filteredScheduledResult.unhealthy,
  enqueued: filteredScheduledResult.enqueued
}, {
  observed: 5,
  missing: 1,
  stale: 1,
  completed: 1,
  pending: 1,
  partial: 1,
  terminalFailed: 1,
  unhealthy: 2,
  enqueued: 2
});
assert.deepEqual(
  filteredDispatches.map(job => job.clinicCode),
  ['SLOT-1', 'SLOT-5'],
  'the primary scheduler must never reacquire terminal, completed, or fresh-started rows'
);

let unauthorizedRpcCalled = false;
const unauthorized = await handleBackgroundBackup(
  new Request('https://synthetic-drive-staging.netlify.app/.netlify/functions/database-backup-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }),
  context,
  {
    getEnv,
    rpc: async () => {
      unauthorizedRpcCalled = true;
      throw new Error('UNEXPECTED_RPC');
    },
    nowMs: () => now
  }
);
assert.equal(unauthorized.status, 401);
assert.deepEqual(await unauthorized.json(), { ok: false, code: 'BACKUP_DISPATCH_UNAUTHORIZED' });
assert.equal(unauthorizedRpcCalled, false, 'unauthorized direct calls must stop before database access');

const disabled = await handleBackgroundBackup(
  new Request('https://example.netlify.app/.netlify/functions/database-backup-background', {
    method: 'POST',
    body: '{}'
  }),
  {},
  { getEnv: name => name === 'BACKUP_ENABLED' ? 'false' : '' }
);
assert.equal(disabled.status, 200);
assert.deepEqual(await disabled.json(), { ok: true, enabled: false });

const credentials = await validateCredentialMaterial(config, runtime, { credentialResolver });
assert.equal(credentials.credentialSource, 'test-blob');
const leaseCalls = [];
const skipped = await runBackupClinicJob({
  config,
  clinic,
  slot: '2026-09-01T20:00:00.000Z',
  requestId: '33333333-3333-4333-8333-333333333333',
  credentials,
  deps: {
    nowMs: () => now,
    rpc: async (_config, name, body) => {
      leaseCalls.push({ name, body });
      return [{ run_id: '44444444-4444-4444-8444-444444444444', acquired: false }];
    }
  }
});
assert.equal(skipped.status, 'skipped');
assert.deepEqual(leaseCalls.map(call => call.name), ['begin_backup_export_run']);

let deadlineClock = now;
const finalizationCalls = [];
const reservedFinalization = await runBackupClinicJob({
  config,
  clinic,
  slot: '2026-09-01T20:00:00.000Z',
  requestId: '55555555-5555-4555-8555-555555555555',
  credentials,
  deps: {
    nowMs: () => deadlineClock,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    rpc: async (_config, name, body, timedFetch) => {
      if (name === 'begin_backup_export_run') {
        return [{ run_id: '66666666-6666-4666-8666-666666666666', acquired: true }];
      }
      if (name === 'get_clinic_drive_backup_destination') {
        deadlineClock = now + (14 * 60 * 1000) - BACKUP_FINALIZATION_RESERVE_MS + 1000;
        throw new Error('BACKUP_DESTINATION_TEST_FAILURE');
      }
      if (name === 'complete_backup_export_run') {
        await timedFetch('https://timeout-check.invalid/finalize');
        finalizationCalls.push(body);
        return null;
      }
      throw new Error(`UNEXPECTED_RPC_${name}`);
    }
  }
});
assert.equal(reservedFinalization.status, 'failed');
assert.equal(finalizationCalls.length, 1, 'a work-deadline failure must retain time to commit failed evidence');
assert.equal(finalizationCalls[0].p_status, 'failed');
assert.equal(finalizationCalls[0].p_error_code, 'BACKUP_DESTINATION_TEST_FAILURE');

assert.equal(
  mostRecentBackupSlot(new Date('2026-09-02T00:30:00.000Z')),
  '2026-09-01T20:00:00.000Z',
  'after UTC midnight recovery must still monitor the preceding 20:00 UTC slot'
);
const recoveryFetches = [];
const recoveryResponse = await handleBackupRecovery(
  scheduledRequest('database-backup-recovery', '2026-09-01T21:00:00Z'),
  { ...context, requestId: 'recovery-request-id' },
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => Date.parse('2026-09-01T20:45:00.000Z'),
    randomUuid: () => '77777777-7777-4777-8777-777777777777',
    fetchImpl: async (url, options) => {
      recoveryFetches.push({ url: String(url), options });
      if (String(url).includes('/rest/v1/backup_export_runs')) {
        return new Response(JSON.stringify([{
          clinic_id: clinic.clinic_id,
          scheduled_for: '2026-09-01T20:00:00.000Z',
          started_at: '2026-09-01T20:01:00.000Z',
          status: 'started'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('', { status: 202 });
    }
  }
);
assert.equal(recoveryResponse.status, 200);
assert.deepEqual(await recoveryResponse.json(), {
  ok: true,
  monitored: true,
  recoveryWindow: true,
  environment: 'staging',
  deploymentId: 'jitarsa-clinical-staging',
  sourceRevision: values.CLINICAL_OS_SOURCE_COMMIT,
  slot: '2026-09-01T20:00:00.000Z',
  observed: 1,
  missing: 0,
  stale: 1,
  partial: 0,
  terminalFailed: 0,
  unhealthy: 0,
  enqueued: 1,
  failed: 0
});
const staleQuery = recoveryFetches.find(call => call.url.includes('/rest/v1/backup_export_runs'));
const recoveryDispatch = recoveryFetches.find(call => call.url.endsWith('/database-backup-background'));
assert.ok(staleQuery, 'recovery monitor must query bounded stale-run evidence');
assert.match(staleQuery.url, /scheduled_for=eq\.2026-09-01T20%3A00%3A00\.000Z/);
assert.match(staleQuery.url, /limit=11/);
assert.ok(recoveryDispatch, 'a stale same-slot run must be re-enqueued to the background worker');
assert.equal(JSON.parse(recoveryDispatch.options.body).slot, '2026-09-01T20:00:00.000Z');

const missingRecovery = await handleBackupRecovery(
  scheduledRequest('database-backup-recovery', '2026-09-01T21:00:00Z'),
  { ...context, requestId: 'missing-recovery-request-id' },
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => Date.parse('2026-09-01T20:45:00.000Z'),
    randomUuid: () => '88888888-8888-4888-8888-888888888888',
    fetchImpl: async url => String(url).includes('/rest/v1/backup_export_runs')
      ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 202 })
  }
);
const missingRecoveryResult = await missingRecovery.json();
assert.equal(missingRecovery.status, 200);
assert.equal(missingRecoveryResult.observed, 0);
assert.equal(missingRecoveryResult.missing, 1);
assert.equal(missingRecoveryResult.enqueued, 1, 'the monitor must recover a scheduler enqueue that produced no lease row');

const terminalRecovery = await handleBackupRecovery(
  scheduledRequest('database-backup-recovery', '2026-09-01T21:00:00Z'),
  { ...context, requestId: 'terminal-recovery-request-id' },
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => Date.parse('2026-09-01T20:45:00.000Z'),
    fetchImpl: async url => String(url).includes('/rest/v1/backup_export_runs')
      ? new Response(JSON.stringify([{
        clinic_id: clinic.clinic_id,
        scheduled_for: '2026-09-01T20:00:00.000Z',
        started_at: '2026-09-01T20:02:00.000Z',
        status: 'partial'
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 202 })
  }
);
const terminalRecoveryResult = await terminalRecovery.json();
assert.equal(terminalRecovery.status, 503);
assert.equal(terminalRecoveryResult.ok, false);
assert.equal(terminalRecoveryResult.partial, 1);
assert.equal(terminalRecoveryResult.terminalFailed, 0);
assert.equal(terminalRecoveryResult.unhealthy, 1);
assert.equal(terminalRecoveryResult.enqueued, 0, 'terminal evidence must not be reset by an automatic retry loop');

const beforeSlotDispatches = [];
const beforeSlotResponse = await handleScheduledBackup(
  scheduledRequest('database-backup'),
  context,
  {
    getEnv,
    credentialResolver,
    rpc,
    nowMs: () => Date.parse('2026-09-02T09:00:00.000Z'),
    listSlotRuns: async () => [],
    randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fetchImpl: async (_url, options) => {
      beforeSlotDispatches.push(JSON.parse(options.body));
      return new Response('', { status: 202 });
    }
  }
);
assert.equal(beforeSlotResponse.status, 200);
assert.equal(
  beforeSlotDispatches[0].slot,
  '2026-09-01T20:00:00.000Z',
  'a pre-20:00 Run-now must target the preceding completed slot, never a future slot'
);

const schedulerSource = read('netlify/functions/database-backup.mts');
const backgroundSource = read('netlify/functions/database-backup-background.mts');
const recoverySource = read('netlify/functions/database-backup-recovery.mts');
const runtimeSource = read('netlify/functions/_shared/database-backup-runtime.mjs');
const leaseMigration = read('supabase/migrations/202609010900_backup_restore_source_binding.sql');
const terminalRunGuardMigration = read('supabase/migrations/202609011200_backup_terminal_run_guard.sql');
assert.match(schedulerSource, /schedule:\s*'0 20 \* \* \*'/);
assert.match(backgroundSource, /handleBackgroundBackup/);
assert.match(recoverySource, /schedule:\s*'\*\/15 0-2,20-23 \* \* \*'/);
assert.match(runtimeSource, /BACKUP_WORKER_BUDGET_MS\s*=\s*14 \* 60 \* 1000/);
assert.match(runtimeSource, /BACKUP_FINALIZATION_RESERVE_MS\s*=\s*90 \* 1000/);
assert.match(runtimeSource, /BACKUP_DISPATCH_MAX_AGE_MS\s*=\s*30 \* 60 \* 1000/);
assert.match(runtimeSource, /finishRun\(config, lease\.run_id, status, counts, objects, code, deps, finalizationDeadlineAt\)/);
assert.match(runtimeSource, /AbortSignal\.timeout\(boundedTimeout\)/);
assert.match(runtimeSource, /begin_backup_export_run/);
assert.match(runtimeSource, /BACKUP_BACKGROUND_ENQUEUE_REJECTED/);
assert.match(runtimeSource, /BACKUP_EXPECTED_NETLIFY_SITE_ID/);
assert.match(runtimeSource, /BACKUP_EXPECTED_SITE_ORIGIN/);
assert.match(runtimeSource, /resolveGoogleServiceAccountCredential/);
assert.match(runtimeSource, /BACKUP_GOOGLE_SERVICE_ACCOUNT_DIRECT_ENV_FORBIDDEN/);
assert.match(leaseMigration, /started_at\s*>\s*pg_catalog\.now\(\)\s*-\s*interval '30 minutes'/);
assert.match(leaseMigration, /set status = 'started'[\s\S]*started_at = pg_catalog\.now\(\)/);
assert.match(terminalRunGuardMigration, /v_run\.status in \('completed', 'partial', 'failed'\)/);
assert.match(terminalRunGuardMigration, /v_run\.request_id is not distinct from v_request_id/);
assert.match(terminalRunGuardMigration, /BACKUP_REQUEST_ID_INVALID/);

console.log('Netlify backup split checks passed: protected scheduled-event shape, missing/stale-only dispatch, signed one-clinic background work, immutable terminal evidence, exact runtime binding and bounded deadlines');
