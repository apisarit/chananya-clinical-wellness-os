import assert from 'node:assert/strict';
import {
  allowedRequestOrigin,
  createOneTimeCredential,
  hmacSha256,
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

const credential = createOneTimeCredential();
assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
assert.match(credential.displayCode, /^\d{6}$/);
assert.equal(credential.payload, `CHANANYA:PT1:${credential.token}`);
assert.equal(credential.tokenHash, sha256(credential.token));
assert.equal(credential.displayCodeHash, sha256(credential.displayCode));
assert.equal(Object.isFrozen(credential), true);

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
assert.deepEqual(publicError(new Error('database connection string')), {
  code: 'PATIENT_IDENTITY_REQUEST_FAILED',
  status: 500
});

console.log('Patient identity function tests passed: crypto, LINE verification, RPC isolation, origin, input limits and safe errors');
