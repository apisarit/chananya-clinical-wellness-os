import assert from 'node:assert/strict';
import { validateOwnerUserWithGoogleProof } from '../netlify/functions/_shared/owner-control.mjs';
import { handleOwnerSubscription } from '../netlify/functions/owner-subscription.mts';
import { handleOwnerDrive } from '../netlify/functions/owner-drive.mts';

// Synthetic identities and transports only. No live credentials or clinic writes.
const origin = 'https://synthetic-owner-staging.netlify.app';
const providerToken = 'synthetic-google-provider-credential-12345678';
const user = {
  id: '11111111-1111-4111-a111-111111111111',
  email: 'owner@example.com', email_confirmed_at: '2026-09-01T00:00:00Z',
  app_metadata: { provider: 'github', providers: ['github', 'google'] },
  identities: [{ provider: 'github', identity_data: { sub: 'github-owner' } },
    { provider: 'google', identity_data: { sub: 'google-owner' } }]
};
const token = (claims = {}) => ['synthetic', Buffer.from(JSON.stringify({
  sub: user.id, email: user.email, amr: [{ method: 'oauth' }], ...claims
})).toString('base64url'), 'verified-by-mocked-supabase'].join('.');
const verifiedAccessToken = token();
const profile = { sub: 'google-owner', email: 'Owner@Example.com', email_verified: true };
const request = (proof = providerToken, path = 'owner-subscription', method = 'GET', body) => new Request(`${origin}/api/${path}`, {
  method, headers: { Origin: origin, Authorization: `Bearer ${verifiedAccessToken}`,
    ...(proof == null ? {} : { 'X-Owner-Google-Token': proof }),
    ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {})
});
const googleResponse = value => new Response(JSON.stringify(value), { status: 200 });
const validate = (overrides = {}) => validateOwnerUserWithGoogleProof({
  request: request(), user, allowedEmails: [user.email], verifiedAccessToken,
  fetchImpl: async () => googleResponse(profile), ...overrides
});
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('linked GitHub/Google owner requires a matching live Google identity', async () => {
  const calls = [];
  assert.deepEqual(await validate({ fetchImpl: async (url, init) => {
    calls.push({ url, init }); return googleResponse(profile);
  } }), { id: user.id, email: user.email });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${providerToken}`, Accept: 'application/json' });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

for (const [name, overrides, expected] of [
  ['missing Google token', { request: request(null) }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['malformed Google token', { request: request('synthetic token with spaces') }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['oversized Google token', { request: request('x'.repeat(8195)) }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['password session', { verifiedAccessToken: token({ amr: [{ method: 'password' }] }) }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['non-allowlisted owner', { allowedEmails: ['another@example.com'] }, /NOT_AUTHORIZED/],
  ['unconfirmed Supabase email', { user: { ...user, email_confirmed_at: null } }, /EMAIL_UNCONFIRMED/],
  ['wrong Supabase subject', { verifiedAccessToken: token({ sub: '22222222-2222-4222-a222-222222222222' }) }, /SESSION_INVALID/],
  ['GitHub-only account', { user: { ...user, app_metadata: { provider: 'github', providers: ['github'] }, identities: [user.identities[0]] } }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['Google claimed only in editable user metadata', { user: { ...user,
    app_metadata: { provider: 'github', providers: ['github'] }, identities: [user.identities[0]],
    user_metadata: { provider: 'google', providers: ['google'], sub: 'google-owner' } } }, /GOOGLE_SIGN_IN_REQUIRED/],
  ['missing trusted Google subject', { user: { ...user, identities: [{ provider: 'google' }] } }, /GOOGLE_SIGN_IN_REQUIRED/]
]) {
  await check(`${name} fails before Google fetch`, async () => {
    let fetched = false;
    await assert.rejects(validate({ ...overrides, fetchImpl: async () => { fetched = true; return googleResponse(profile); } }), expected);
    assert.equal(fetched, false);
  });
}

for (const [name, badProfile] of [
  ['same email with another Google subject', { ...profile, sub: 'other-google-user' }],
  ['wrong email', { ...profile, email: 'someone@example.com' }],
  ['unverified Google email', { ...profile, email_verified: false }],
  ['string true verification', { ...profile, email_verified: 'true' }],
  ['missing subject', { email: user.email, email_verified: true }],
  ['null response', null], ['array response', [profile]]
]) {
  await check(`${name} cannot authorize the linked owner`, async () => {
    await assert.rejects(validate({ fetchImpl: async () => googleResponse(badProfile) }), /GOOGLE_SIGN_IN_REQUIRED/);
  });
}

for (const [name, fetchImpl] of [
  ['expired token', async () => new Response(providerToken, { status: 401 })],
  ['GitHub token sent as Google proof', async () => new Response(providerToken, { status: 403 })],
  ['provider redirect', async () => new Response('', { status: 302, headers: { Location: 'https://example.invalid/' } })],
  ['provider unavailable', async () => new Response(providerToken, { status: 503 })],
  ['invalid JSON', async () => new Response(providerToken, { status: 200 })],
  ['network failure', async () => { throw new Error(providerToken); }]
]) {
  await check(`${name} fails closed without echoing credentials`, async () => {
    await assert.rejects(validate({ fetchImpl }), error => {
      assert.equal(error.message, 'CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED');
      assert.ok(!String(error.stack).includes(providerToken)); return true;
    });
  });
}

await check('existing Google-only owner does not need an extra provider call', async () => {
  let fetched = false;
  const googleOnly = { ...user, app_metadata: { provider: 'google', providers: ['google'] }, identities: [user.identities[1]] };
  assert.deepEqual(await validate({ user: googleOnly, request: request(null), fetchImpl: async () => { fetched = true; throw new Error('Unexpected Google call'); } }), { id: user.id, email: user.email });
  assert.equal(fetched, false);
});

const values = {
  CNYOS_OWNER_CONTROL_ENABLED: 'true', CNYOS_OWNER_DRIVE_ENABLED: 'true',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key',
  CNYOS_OWNER_EXPECTED_PROJECT_REF: 'stagingprojectrefabc', BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'stagingprojectrefabc',
  CNYOS_OWNER_EMAILS: user.email, CNYOS_OWNER_CLINIC_CODES: 'CHANANYA-STG',
  BACKUP_ENVIRONMENT: 'staging', BACKUP_DEPLOYMENT_ID: 'chananya-clinical-staging',
  BACKUP_PRODUCTION_SUPABASE_URL: 'https://productionprojectxyz.supabase.co',
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010',
  CNYOS_OWNER_EXPECTED_SITE_ORIGIN: origin,
  BACKUP_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010', BACKUP_EXPECTED_SITE_ORIGIN: origin,
  GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID: 'synthetic-root-folder',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: 'synthetic-staging-key',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 2).toString('base64'),
  BACKUP_INTERNAL_DISPATCH_SECRET: 'synthetic-dispatch-secret-for-tests',
  GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL: 'backup@synthetic-staging.iam.gserviceaccount.com'
};
const context = { requestId: 'synthetic-linked-owner',
  site: { id: values.CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID, url: origin },
  deploy: { id: 'synthetic_deploy_123', context: 'production', published: true } };
for (const [path, handler, rpc] of [
  ['owner-subscription', handleOwnerSubscription, '/rest/v1/rpc/list_owner_subscription_clinics'],
  ['owner-drive', handleOwnerDrive, '/rest/v1/rpc/list_owner_drive_assignments']
]) {
  for (const valid of [true, false]) {
    await check(`${path} ${valid ? 'accepts matching' : 'rejects mismatched'} Google proof before data access`, async () => {
      const events = []; const logs = []; const original = console.error;
      console.error = (...args) => logs.push(args);
      let response;
      try {
        response = await handler(request(providerToken, path), context, {
          getEnv: name => values[name] || '',
          ownerRequest: async input => {
            events.push(input.resource);
            if (input.resource === '/auth/v1/user') {
              assert.equal(input.bearer, verifiedAccessToken); return user;
            }
            assert.equal(input.resource, rpc); assert.equal(input.bearer, undefined);
            assert.equal(input.serviceRoleKey, values.SUPABASE_SERVICE_ROLE_KEY); return [];
          },
          googleFetch: async () => { events.push('google'); return googleResponse({ ...profile, sub: valid ? profile.sub : 'another-google-account' }); },
          credentialResolver: async () => { events.push('credential'); return { serviceAccount: { clientEmail: values.GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL }, source: 'synthetic', keyId: 'synthetic' }; }
        });
      } finally { console.error = original; }
      assert.equal(response.status, valid ? 200 : 403);
      assert.deepEqual(events, ['/auth/v1/user', 'google', ...(valid ? [...(path === 'owner-drive' ? ['credential'] : []), rpc] : [])]);
      const body = await response.text();
      assert.equal(JSON.parse(body).ok, valid);
      assert.ok(!body.includes(providerToken)); assert.ok(!JSON.stringify(logs).includes(providerToken));
    });
  }
}

console.log(`Linked Google Owner proof: ${passed} checks passed`);
