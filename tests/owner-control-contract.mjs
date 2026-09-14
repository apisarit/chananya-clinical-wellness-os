import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowedOwnerOrigin,
  assertOwnerProject,
  assertOwnerRuntime,
  extractBearerToken,
  normalizeOwnerClinicCodes,
  normalizeOwnerEmails,
  normalizeSubscriptionRequest,
  ownerPublicError,
  supabaseOwnerRequest,
  validateOwnerUser
} from '../netlify/functions/_shared/owner-control.mjs';
import { handleOwnerSubscription } from '../netlify/functions/owner-subscription.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

assert.deepEqual(normalizeOwnerEmails('Owner@Example.com, owner@example.com second@example.com'), [
  'owner@example.com',
  'second@example.com'
]);
assert.throws(() => normalizeOwnerEmails(''), /EMAILS_INVALID/);
assert.throws(() => normalizeOwnerEmails('not-an-email'), /EMAILS_INVALID/);
assert.deepEqual(normalizeOwnerClinicCodes('chananya-stg, TEST_02'), ['CHANANYA-STG', 'TEST_02']);
assert.throws(() => normalizeOwnerClinicCodes('bad$code'), /CLINIC_CODES_INVALID/);
assert.equal(assertOwnerProject('https://stagingprojectrefabc.supabase.co', 'stagingprojectrefabc'), 'stagingprojectrefabc');
assert.throws(
  () => assertOwnerProject('https://qptxnrldzzinlcabudjv.supabase.co', 'stagingprojectrefabc'),
  /PROJECT_MISMATCH/
);

const bearer = `header.${'a'.repeat(40)}.signature`;
assert.equal(extractBearerToken(new Request('https://cnyos.example/api', {
  headers: { Authorization: `Bearer ${bearer}` }
})), bearer);
assert.throws(() => extractBearerToken(new Request('https://cnyos.example/api')), /SESSION_REQUIRED/);
assert.equal(allowedOwnerOrigin(new Request('https://cnyos.example/api', {
  headers: { Origin: 'https://cnyos.example' }
})), true);

const exactOwnerContext = Object.freeze({
  site: Object.freeze({
    id: '10000000-0000-4000-8000-000000000010',
    url: 'https://synthetic-owner-staging.netlify.app'
  }),
  deploy: Object.freeze({
    id: 'deploy_1234567890',
    context: 'production',
    published: true
  })
});
assert.deepEqual(assertOwnerRuntime(
  new Request('https://synthetic-owner-staging.netlify.app/api/owner-subscription'),
  exactOwnerContext,
  exactOwnerContext.site.id,
  exactOwnerContext.site.url
), {
  siteId: exactOwnerContext.site.id,
  siteOrigin: exactOwnerContext.site.url,
  deployId: exactOwnerContext.deploy.id
});
assert.throws(() => assertOwnerRuntime(
  new Request('https://deploy-preview-8--synthetic-owner-staging.netlify.app/api/owner-subscription'),
  exactOwnerContext,
  exactOwnerContext.site.id,
  exactOwnerContext.site.url
), /RUNTIME_MISMATCH/);
assert.throws(() => assertOwnerRuntime(
  new Request('https://synthetic-owner-staging.netlify.app/api/owner-subscription'),
  { ...exactOwnerContext, site: { ...exactOwnerContext.site, id: '20000000-0000-4000-8000-000000000020' } },
  exactOwnerContext.site.id,
  exactOwnerContext.site.url
), /RUNTIME_MISMATCH/);
assert.throws(() => assertOwnerRuntime(
  new Request('https://synthetic-owner-staging.netlify.app/api/owner-subscription'),
  { ...exactOwnerContext, deploy: { ...exactOwnerContext.deploy, context: 'deploy-preview', published: false } },
  exactOwnerContext.site.id,
  exactOwnerContext.site.url
), /DEPLOY_CONTEXT_DENIED/);
assert.equal(allowedOwnerOrigin(new Request('https://cnyos.example/api', {
  headers: { Origin: 'https://attacker.example' }
})), false);
assert.equal(allowedOwnerOrigin(new Request('https://cnyos.example/api', {
  headers: { 'Sec-Fetch-Site': 'same-origin' }
})), true);

const ownerUser = {
  id: '11111111-1111-4111-a111-111111111111',
  email: 'Owner@Example.com',
  email_confirmed_at: '2026-08-31T00:00:00Z',
  app_metadata: { provider: 'google', providers: ['google'] },
  identities: [{ provider: 'google' }]
};
const ownerToken = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: ownerUser.id,
    email: 'owner@example.com',
    amr: [{ method: 'oauth', timestamp: 1788220800 }]
  })).toString('base64url'),
  'verified-by-supabase-user-endpoint'
].join('.');
assert.deepEqual(validateOwnerUser(ownerUser, ['owner@example.com'], ownerToken), {
  id: ownerUser.id,
  email: 'owner@example.com'
});
const passwordToken = [
  ownerToken.split('.')[0],
  Buffer.from(JSON.stringify({
    sub: ownerUser.id,
    email: 'owner@example.com',
    amr: [{ method: 'password', timestamp: 1788220800 }]
  })).toString('base64url'),
  ownerToken.split('.')[2]
].join('.');
assert.throws(() => validateOwnerUser(ownerUser, ['owner@example.com'], passwordToken), /GOOGLE_SIGN_IN_REQUIRED/);
assert.throws(
  () => validateOwnerUser({
    ...ownerUser,
    app_metadata: { provider: 'google', providers: ['email', 'google'] },
    identities: [{ provider: 'email' }, { provider: 'google' }]
  }, ['owner@example.com'], ownerToken),
  /GOOGLE_SIGN_IN_REQUIRED/
);
assert.throws(() => validateOwnerUser({ ...ownerUser, app_metadata: { provider: 'github' }, identities: [] }, ['owner@example.com'], ownerToken), /GOOGLE_SIGN_IN_REQUIRED/);
assert.throws(() => validateOwnerUser(ownerUser, ['other@example.com'], ownerToken), /NOT_AUTHORIZED/);

const normalized = normalizeSubscriptionRequest({
  requestId: '22222222-2222-4222-a222-222222222222',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'chananya-stg',
  enabled: false,
  expectedVersion: 7,
  reason: 'Reviewed commercial suspension'
});
assert.equal(normalized.clinicCode, 'CHANANYA-STG');
assert.equal(normalized.enabled, false);
assert.equal(normalized.expectedVersion, 7);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, enabled: 'false' }), /STATE_INVALID/);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, expectedVersion: 0 }), /VERSION_INVALID/);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, expectedVersion: 1.5 }), /VERSION_INVALID/);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, reason: 'short' }), /REASON_INVALID/);

const calls = [];
const payload = await supabaseOwnerRequest({
  url: 'https://stagingprojectrefabc.supabase.co',
  serviceRoleKey: 'server-service-role-test-key',
  bearer: 'user-session-test-token',
  resource: '/auth/v1/user',
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(ownerUser), { status: 200 });
  }
});
assert.equal(payload.email, ownerUser.email);

for (const status of [401, 403]) {
  await assert.rejects(supabaseOwnerRequest({
    url: 'https://stagingprojectrefabc.supabase.co',
    serviceRoleKey: 'server-service-role-test-key',
    bearer: 'expired-user-session', resource: '/auth/v1/user',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Invalid JWT' }), { status })
  }), /CNYOS_OWNER_SESSION_INVALID/, 'Auth rejection must be recoverable, not a database failure');
}

assert.equal(calls[0].options.headers.apikey, 'server-service-role-test-key');
assert.equal(calls[0].options.headers.Authorization, 'Bearer user-session-test-token');
const rpcCalls = [];
await supabaseOwnerRequest({
  url: 'https://stagingprojectrefabc.supabase.co',
  serviceRoleKey: 'server-service-role-test-key',
  resource: '/rest/v1/rpc/list_owner_subscription_clinics',
  method: 'POST',
  body: {},
  fetchImpl: async (url, options) => {
    rpcCalls.push({ url: String(url), options });
    return new Response(JSON.stringify([]), { status: 200 });
  }
});
assert.equal(rpcCalls[0].options.headers.apikey, 'server-service-role-test-key');
assert.equal(
  rpcCalls[0].options.headers.Authorization,
  'Bearer server-service-role-test-key',
  'Owner data RPCs must use the service role rather than forwarding the Google Owner JWT'
);
await assert.rejects(
  supabaseOwnerRequest({
    url: 'https://stagingprojectrefabc.supabase.co',
    serviceRoleKey: 'key',
    resource: '/rest/v1/clinics?select=*'
  }),
  /RESOURCE_INVALID/
);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_NOT_AUTHORIZED')).status, 403);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_PROJECT_MISMATCH')).status, 503);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT')).status, 409);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_REQUEST_ID_CONFLICT')).status, 409);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_RUNTIME_MISMATCH')).status, 503);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_DEPLOY_CONTEXT_DENIED')).status, 403);

const endpointValues = Object.freeze({
  CNYOS_OWNER_CONTROL_ENABLED: 'true',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-owner-service-role-test-key',
  CNYOS_OWNER_EXPECTED_PROJECT_REF: 'stagingprojectrefabc',
  CNYOS_OWNER_EMAILS: 'owner@example.com',
  CNYOS_OWNER_CLINIC_CODES: 'CHANANYA-STG',
  BACKUP_ENVIRONMENT: 'staging',
  BACKUP_DEPLOYMENT_ID: 'chananya-clinical-staging',
  BACKUP_PRODUCTION_SUPABASE_URL: 'https://productionprojectxyz.supabase.co',
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: exactOwnerContext.site.id,
  CNYOS_OWNER_EXPECTED_SITE_ORIGIN: exactOwnerContext.site.url
});
const endpointInput = Object.freeze({
  requestId: '33333333-3333-4333-a333-333333333333',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'CHANANYA-STG',
  enabled: true,
  expectedVersion: 8,
  reason: 'Restore reviewed staging subscription'
});
const simulatedOnResult = Object.freeze({
  clinic_id: endpointInput.clinicId,
  clinic_code: endpointInput.clinicCode,
  previous_state: 'suspended',
  subscription_state: 'active',
  subscription_version: 9,
  changed: true,
  idempotent: false
});
const endpointCalls = [];
const endpointResponse = await handleOwnerSubscription(
  new Request('https://synthetic-owner-staging.netlify.app/api/owner-subscription', {
    method: 'POST',
    headers: {
      Origin: exactOwnerContext.site.url,
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(endpointInput)
  }),
  { ...exactOwnerContext, requestId: 'owner-subscription-on-test' },
  {
    getEnv: name => endpointValues[name] || '',
    ownerRequest: async options => {
      endpointCalls.push(options);
      assert.equal(options.url, endpointValues.SUPABASE_URL);
      assert.equal(options.serviceRoleKey, endpointValues.SUPABASE_SERVICE_ROLE_KEY);
      if (options.resource === '/auth/v1/user') {
        assert.equal(options.bearer, ownerToken);
        return ownerUser;
      }
      assert.equal(options.resource, '/rest/v1/rpc/set_clinic_subscription_state');
      assert.equal(options.method, 'POST');
      assert.equal(options.bearer, undefined, 'Owner ON must execute as service_role, not as the Google JWT');
      assert.deepEqual(options.body, {
        p_request_id: endpointInput.requestId,
        p_clinic_id: endpointInput.clinicId,
        p_expected_clinic_code: endpointInput.clinicCode,
        p_enabled: true,
        p_expected_version: endpointInput.expectedVersion,
        p_reason: endpointInput.reason,
        p_actor_user_id: ownerUser.id,
        p_actor_email: 'owner@example.com'
      });
      return simulatedOnResult;
    }
  }
);
assert.equal(endpointResponse.status, 200);
assert.deepEqual(await endpointResponse.json(), { ok: true, result: simulatedOnResult });
assert.deepEqual(endpointCalls.map(call => call.resource), [
  '/auth/v1/user',
  '/rest/v1/rpc/set_clinic_subscription_state'
]);

let unauthorizedDataAccessed = false;
const originalConsoleError = console.error;
console.error = () => {};
let unauthorizedResponse;
try {
  unauthorizedResponse = await handleOwnerSubscription(
    new Request('https://synthetic-owner-staging.netlify.app/api/owner-subscription', {
      method: 'POST',
      headers: {
        Origin: exactOwnerContext.site.url,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(endpointInput)
    }),
    { ...exactOwnerContext, requestId: 'owner-subscription-unauthorized-test' },
    {
      getEnv: name => endpointValues[name] || '',
      ownerRequest: async () => {
        unauthorizedDataAccessed = true;
        throw new Error('UNEXPECTED_OWNER_DATA_ACCESS');
      }
    }
  );
} finally {
  console.error = originalConsoleError;
}
assert.equal(unauthorizedResponse.status, 401);
assert.deepEqual(await unauthorizedResponse.json(), {
  ok: false,
  code: 'CNYOS_OWNER_SESSION_REQUIRED'
});
assert.equal(unauthorizedDataAccessed, false, 'missing Google session must fail before Supabase access');

const migration = read('supabase/migrations/202608311800_owner_subscription_control.sql');
assert.match(migration, /current_clinic_id\(\)[\s\S]*subscription_state = 'active'/);
assert.match(migration, /current_department_role\(\)[\s\S]*subscription_state = 'active'/);
assert.match(migration, /when auth\.uid\(\) is null or public\.current_clinic_id\(\) is null then false/);
assert.match(migration, /clinic_subscription_control_events/);
assert.match(migration, /set_clinic_subscription_state/);
assert.match(migration, /auth\.role\(\) <> 'service_role'/);
assert.match(migration, /for update/);
assert.match(migration, /request_id uuid not null unique/);
assert.match(migration, /revoke all on public\.clinic_subscription_control_events from public, anon, authenticated, service_role/);
assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*clinic_subscription_control_events[^;]*service_role/i);
assert.match(migration, /v_existing\.reason <> v_reason/);
assert.match(migration, /clinic_subscription_control_events[\s\S]*2026-08-31\.1/);
assert.match(migration, /grant execute on function public\.set_clinic_subscription_state[\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant execute on function public\.set_clinic_subscription_state[^;\n]*to authenticated/);

const concurrencyMigration = read('supabase/migrations/202609010800_owner_subscription_concurrency.sql');
assert.match(concurrencyMigration, /p_expected_version bigint/);
assert.match(concurrencyMigration, /pg_advisory_xact_lock/);
assert.match(concurrencyMigration, /for v_lock_attempt in 1\.\.2 loop/);
assert.match(concurrencyMigration, /CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT/);
assert.match(concurrencyMigration, /trg_clinic_subscription_control_events_append_only/);
assert.match(concurrencyMigration, /drop function public\.set_clinic_subscription_state\(uuid,uuid,text,boolean,text,uuid,text\)/);
assert.match(concurrencyMigration, /grant execute on function public\.set_clinic_subscription_state\(uuid,uuid,text,boolean,bigint,text,uuid,text\)[\s\S]*to service_role/);
assert.doesNotMatch(concurrencyMigration, /grant execute on function public\.set_clinic_subscription_state[^;\n]*to authenticated/);

const worker = read('netlify/functions/owner-subscription.mts');
assert.match(worker, /CNYOS_OWNER_CONTROL_ENABLED/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_PROJECT_REF/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_SITE_ORIGIN/);
assert.match(worker, /assertOwnerRuntime/);
assert.match(worker, /const config = configuration\(deps\.getEnv \|\| env\);[\s\S]*assertOwnerRuntime\([\s\S]*authenticateOwner\(request, config, deps\.ownerRequest, deps\.googleFetch\)/);
assert.match(worker, /CNYOS_OWNER_CLINIC_CODES/);
assert.match(worker, /BACKUP_ENVIRONMENT/);
assert.match(worker, /BACKUP_DEPLOYMENT_ID/);
assert.match(worker, /BACKUP_PRODUCTION_SUPABASE_URL/);
assert.match(worker, /CNYOS_OWNER_PRODUCTION_DENYLIST_REQUIRED/);
assert.match(worker, /validateOwnerUser/);
assert.match(worker, /p_expected_version:\s*input\.expectedVersion/);
assert.match(worker, /path:\s*'\/api\/owner-subscription'/);
assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:serviceRoleKey|access_token|Authorization)/);

const consoleHtml = read('owner-control.html');
const consoleJs = read('owner-control.js');
assert.match(consoleHtml, /Subscription Safety Console/);
assert.match(consoleHtml, /subscription_state='suspended'/);
assert.match(consoleJs, /crypto\.randomUUID\(\)/);
assert.match(consoleJs, /expectedVersion/);
assert.match(consoleJs, /CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT/);
assert.match(consoleJs, /confirmCode\.value/);
assert.match(consoleJs, /Authorization:\s*`Bearer \$\{session\.access_token\}`/);
assert.match(consoleJs, /sessionStorage\.setItem\('cnyos:post_auth_path', '\/owner-control\.html'\)/);
// The logout implementation delegates navigation to a storage-safe helper.
// Verify both scopes, not their relative declaration order; behavioral coverage
// in owner-session-lifecycle.mjs also asserts the exact return-path write.
const returnStart = consoleJs.indexOf('function loginAgain()');
const returnEnd = consoleJs.indexOf('function clearOwnerSession(', returnStart);
assert.ok(returnStart >= 0 && returnEnd > returnStart, 'Owner login helper must exist');
const returnBlock = consoleJs.slice(returnStart, returnEnd);
assert.match(
  returnBlock,
  /sessionStorage\.setItem\('cnyos:post_auth_path', '\/owner-control\.html'\)[\s\S]*location\.replace\('\/login\.html'\)/,
  'Owner login helper must preserve the protected return path before navigation'
);
const logoutStart = consoleJs.indexOf("$('#owner-logout').addEventListener('click'");
const logoutEnd = consoleJs.indexOf("clinicSelect.addEventListener('change'", logoutStart);
assert.ok(logoutStart >= 0 && logoutEnd > logoutStart, 'Owner logout handler must exist');
assert.match(
  consoleJs.slice(logoutStart, logoutEnd),
  /clearOwnerSession\(\)[\s\S]*await db\.auth\.signOut\(\)[\s\S]*if \(signedOut\?\.error\) throw signedOut\.error;[\s\S]*loginAgain\(\)/,
  'Owner logout must clear the console, complete sign-out, then use protected return navigation'
);
assert.match(read('auth-callback.js'), /candidate === '\/owner-control\.html'/);
assert.match(read('scripts/generate-tenant-bootstrap-sql.mjs'), /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
assert.doesNotMatch(read('scripts/generate-tenant-bootstrap-sql.mjs'), /`  active = true,/);
assert.match(read('.env.example'), /CNYOS_OWNER_EXPECTED_PROJECT_REF=/);
assert.match(read('docs/CNYOS_OWNER_CONTROL.md'), /current_clinic_id\(\).*RLS/s);

console.log('CNYOS Owner Control contracts passed: Google allowlist, exact target guards, audited service-role RPC and database-enforced ON/OFF');
