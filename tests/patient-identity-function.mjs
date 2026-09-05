import assert from 'node:assert/strict';
import {
  allowedRequestOrigin,
  createOneTimeCredential,
  hmacSha256,
  normalizeClinicId,
  normalizeLinkCode,
  normalizePatientId,
  publicError,
  readJsonBody,
  sha256,
  supabaseRpc,
  validateLineIdentity,
  verifyLineIdToken
} from '../netlify/functions/_shared/patient-identity.mjs';

const secret = '0123456789abcdef0123456789abcdef';

assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(hmacSha256('subject-a', secret), hmacSha256('subject-a', secret));
assert.notEqual(hmacSha256('subject-a', secret), hmacSha256('subject-b', secret));
assert.throws(() => hmacSha256('subject', 'too-short'), /HMAC_SECRET_INVALID/);

assert.equal(normalizeLinkCode('ab-cd ef12-3456'), 'ABCDEF123456');
assert.throws(() => normalizeLinkCode('NOT-A-CODE'), /LINK_CODE_FORMAT_INVALID/);
assert.equal(normalizePatientId('a8098c1a-f86e-4a42-a72f-065ee44c9a03'), 'a8098c1a-f86e-4a42-a72f-065ee44c9a03');
assert.throws(() => normalizePatientId('patient-1'), /PATIENT_ID_INVALID/);
assert.equal(normalizeClinicId('a8098c1a-f86e-4a42-a72f-065ee44c9a03'), 'a8098c1a-f86e-4a42-a72f-065ee44c9a03');
assert.equal(normalizeClinicId('00000000-0000-0000-0000-000000000001'), '00000000-0000-0000-0000-000000000001');
assert.throws(() => normalizeClinicId('clinic-1'), /CNYOS_EXPECTED_CLINIC_ID_INVALID/);

const credential = createOneTimeCredential();
assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
assert.match(credential.displayCode, /^\d{6}$/);
assert.equal(credential.payload, `CHANANYA:PT1:${credential.token}`);
assert.equal(credential.tokenHash, sha256(credential.token));
assert.equal(credential.displayCodeHash, sha256(credential.displayCode));
assert.equal(Object.isFrozen(credential), true);
const customerCredential = createOneTimeCredential('CUSTOMER');
assert.equal(customerCredential.payload, `CUSTOMER:PT1:${customerCredential.token}`);
assert.throws(() => createOneTimeCredential('bad issuer space'), /PATIENT_QR_ISSUER_INVALID/);

const now = 1_800_000_000;
const linePayload = {
  iss: 'https://access.line.me',
  aud: 'channel-123',
  sub: 'U123456789',
  iat: now - 10,
  exp: now + 300
};
assert.deepEqual(validateLineIdentity(linePayload, 'channel-123', now), {
  subject: 'U123456789',
  expiresAt: now + 300
});
assert.throws(() => validateLineIdentity({ ...linePayload, iss: 'https://evil.example' }, 'channel-123', now), /ISSUER_INVALID/);
assert.throws(() => validateLineIdentity({ ...linePayload, aud: 'other' }, 'channel-123', now), /AUDIENCE_INVALID/);
assert.throws(() => validateLineIdentity({ ...linePayload, exp: now }, 'channel-123', now), /TOKEN_EXPIRED/);
assert.throws(() => validateLineIdentity({ ...linePayload, iat: now + 61 }, 'channel-123', now), /IAT_INVALID/);

let lineRequest;
const verified = await verifyLineIdToken('x'.repeat(100), 'channel-123', async (url, options) => {
  lineRequest = { url, options };
  return new Response(JSON.stringify({
    ...linePayload,
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 300
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
assert.equal(verified.subject, linePayload.sub);
assert.equal(lineRequest.url, 'https://api.line.me/oauth2/v2.1/verify');
assert.equal(lineRequest.options.method, 'POST');
assert.equal(new URLSearchParams(lineRequest.options.body).get('client_id'), 'channel-123');
assert.equal(new URLSearchParams(lineRequest.options.body).get('id_token'), 'x'.repeat(100));

let rpcRequest;
const rpcPayload = await supabaseRpc({
  url: 'https://db.example/',
  serviceRoleKey: 'server-secret',
  name: 'safe_rpc',
  body: { patient: 'opaque' },
  fetchImpl: async (url, options) => {
    rpcRequest = { url, options };
    return new Response(JSON.stringify([{ ok: true }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
assert.deepEqual(rpcPayload, [{ ok: true }]);
assert.equal(rpcRequest.url, 'https://db.example/rest/v1/rpc/safe_rpc');
assert.equal(rpcRequest.options.headers.apikey, 'server-secret');
assert.equal(rpcRequest.options.headers.Authorization, 'Bearer server-secret');
assert.deepEqual(JSON.parse(rpcRequest.options.body), { patient: 'opaque' });
await assert.rejects(
  supabaseRpc({
    url: 'https://db.example',
    serviceRoleKey: 'server-secret',
    name: 'safe_rpc',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'sensitive database detail', code: 'XX000' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }),
  /IDENTITY_DATABASE_REQUEST_FAILED/
);
await assert.rejects(
  supabaseRpc({ url: 'https://db.example', serviceRoleKey: 'key', name: '../unsafe' }),
  /RPC_NAME_INVALID/
);

const sameOrigin = new Request('https://patient.example/api/patient-identity', {
  headers: { origin: 'https://patient.example' }
});
assert.equal(allowedRequestOrigin(sameOrigin), true);
const foreignOrigin = new Request('https://patient.example/api/patient-identity', {
  headers: { origin: 'https://evil.example' }
});
assert.equal(allowedRequestOrigin(foreignOrigin), false);
assert.equal(allowedRequestOrigin(new Request('https://patient.example/api/patient-identity')), false);

assert.deepEqual(
  await readJsonBody(new Request('https://patient.example', { method: 'POST', body: '{"ok":true}' })),
  { ok: true }
);
await assert.rejects(
  readJsonBody(new Request('https://patient.example', { method: 'POST', body: 'x'.repeat(20) }), 10),
  /REQUEST_TOO_LARGE/
);
await assert.rejects(
  readJsonBody(new Request('https://patient.example', { method: 'POST', body: '{bad' })),
  /REQUEST_JSON_INVALID/
);

assert.deepEqual(publicError(new Error('RATE_LIMITED')), { code: 'RATE_LIMITED', status: 429 });
assert.deepEqual(publicError(new Error('LINE_ID_TOKEN_EXPIRED')), { code: 'LINE_ID_TOKEN_EXPIRED', status: 401 });
assert.deepEqual(publicError(new Error('CNYOS_SUBSCRIPTION_SUSPENDED')), {
  code: 'CNYOS_SUBSCRIPTION_SUSPENDED',
  status: 503
});
assert.deepEqual(publicError(new Error('database connection string')), {
  code: 'PATIENT_IDENTITY_REQUEST_FAILED',
  status: 500
});

// An OFF clinic is rejected before rate-limit state or LINE token verification.
const previousNetlify = globalThis.Netlify;
const previousFetch = globalThis.fetch;
const patientFetches = [];
globalThis.Netlify = {
  env: {
    get(name) {
      return {
        LINE_LIFF_ID: 'test-liff',
        LINE_LOGIN_CHANNEL_ID: 'test-login-channel',
        PATIENT_IDENTITY_HMAC_SECRET: secret,
        PATIENT_QR_ISSUER: 'TEST',
        SUPABASE_URL: 'https://db.example',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
        CNYOS_RUNTIME_EXPECTED_CLINIC_ID: '00000000-0000-0000-0000-000000000001'
      }[name] || '';
    }
  }
};
globalThis.fetch = async (url, options) => {
  patientFetches.push({ url: String(url), options });
  return new Response(JSON.stringify({ message: 'CNYOS_SUBSCRIPTION_SUSPENDED' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
};
try {
  const { default: patientIdentityHandler } = await import('../netlify/functions/patient-identity.mts?off-contract');
  const response = await patientIdentityHandler(new Request(
    'https://patient.example/api/patient-identity',
    {
      method: 'POST',
      headers: { origin: 'https://patient.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', idToken: 'must-not-be-verified' })
    }
  ), { ip: '127.0.0.1', requestId: 'off-contract' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: 'CNYOS_SUBSCRIPTION_SUSPENDED' });
  assert.equal(patientFetches.length, 1);
  assert.match(patientFetches[0].url, /\/rpc\/assert_clinic_subscription_active$/);
  assert.doesNotMatch(patientFetches[0].url, /api\.line\.me|consume_patient_identity_rate_limit/);
} finally {
  globalThis.fetch = previousFetch;
  globalThis.Netlify = previousNetlify;
}

console.log('Patient identity function tests passed: crypto, LINE verification, RPC isolation, origin, input limits and safe errors');
