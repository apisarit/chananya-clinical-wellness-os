import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowedOwnerOrigin,
  assertOwnerProject,
  extractBearerToken,
  normalizeOwnerClinicCodes,
  normalizeOwnerEmails,
  normalizeSubscriptionRequest,
  ownerPublicError,
  supabaseOwnerRequest,
  validateOwnerUser
} from '../netlify/functions/_shared/owner-control.mjs';

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
assert.equal(assertOwnerProject('https://hsmnjwxurlmsizndjlun.supabase.co', 'hsmnjwxurlmsizndjlun'), 'hsmnjwxurlmsizndjlun');
assert.throws(
  () => assertOwnerProject('https://qptxnrldzzinlcabudjv.supabase.co', 'hsmnjwxurlmsizndjlun'),
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
assert.deepEqual(validateOwnerUser(ownerUser, ['owner@example.com']), {
  id: ownerUser.id,
  email: 'owner@example.com'
});
assert.throws(() => validateOwnerUser({ ...ownerUser, app_metadata: { provider: 'github' }, identities: [] }, ['owner@example.com']), /GOOGLE_SIGN_IN_REQUIRED/);
assert.throws(() => validateOwnerUser(ownerUser, ['other@example.com']), /NOT_AUTHORIZED/);

const normalized = normalizeSubscriptionRequest({
  requestId: '22222222-2222-4222-a222-222222222222',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'chananya-stg',
  enabled: false,
  reason: 'Reviewed commercial suspension'
});
assert.equal(normalized.clinicCode, 'CHANANYA-STG');
assert.equal(normalized.enabled, false);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, enabled: 'false' }), /STATE_INVALID/);
assert.throws(() => normalizeSubscriptionRequest({ ...normalized, reason: 'short' }), /REASON_INVALID/);

const calls = [];
const payload = await supabaseOwnerRequest({
  url: 'https://hsmnjwxurlmsizndjlun.supabase.co',
  serviceRoleKey: 'server-service-role-test-key',
  bearer: 'user-session-test-token',
  resource: '/auth/v1/user',
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(ownerUser), { status: 200 });
  }
});
assert.equal(payload.email, ownerUser.email);
assert.equal(calls[0].options.headers.apikey, 'server-service-role-test-key');
assert.equal(calls[0].options.headers.Authorization, 'Bearer user-session-test-token');
await assert.rejects(
  supabaseOwnerRequest({
    url: 'https://hsmnjwxurlmsizndjlun.supabase.co',
    serviceRoleKey: 'key',
    resource: '/rest/v1/clinics?select=*'
  }),
  /RESOURCE_INVALID/
);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_NOT_AUTHORIZED')).status, 403);
assert.equal(ownerPublicError(new Error('CNYOS_OWNER_PROJECT_MISMATCH')).status, 503);

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

const worker = read('netlify/functions/owner-subscription.mts');
assert.match(worker, /CNYOS_OWNER_CONTROL_ENABLED/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_PROJECT_REF/);
assert.match(worker, /CNYOS_OWNER_CLINIC_CODES/);
assert.match(worker, /validateOwnerUser/);
assert.match(worker, /path:\s*'\/api\/owner-subscription'/);
assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:serviceRoleKey|access_token|Authorization)/);

const consoleHtml = read('owner-control.html');
const consoleJs = read('owner-control.js');
assert.match(consoleHtml, /Subscription Safety Console/);
assert.match(consoleHtml, /subscription_state='suspended'/);
assert.match(consoleJs, /crypto\.randomUUID\(\)/);
assert.match(consoleJs, /confirmCode\.value/);
assert.match(consoleJs, /Authorization:\s*`Bearer \$\{session\.access_token\}`/);
assert.match(consoleJs, /sessionStorage\.setItem\('cnyos:post_auth_path', '\/owner-control\.html'\)/);
assert.match(read('auth-callback.js'), /candidate === '\/owner-control\.html'/);
assert.match(read('scripts/generate-tenant-bootstrap-sql.mjs'), /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
assert.doesNotMatch(read('scripts/generate-tenant-bootstrap-sql.mjs'), /`  active = true,/);
assert.match(read('.env.example'), /CNYOS_OWNER_EXPECTED_PROJECT_REF=/);
assert.match(read('docs/CNYOS_OWNER_CONTROL.md'), /current_clinic_id\(\).*RLS/s);

console.log('CNYOS Owner Control contracts passed: Google allowlist, exact target guards, audited service-role RPC and database-enforced ON/OFF');
