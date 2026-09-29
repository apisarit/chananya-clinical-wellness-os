import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const previousNetlify = globalThis.Netlify;
const previousFetch = globalThis.fetch;
const previousError = console.error;
const secret = 'synthetic-identity-secret-0123456789';
const logs = [], finalizations = [];
globalThis.Netlify = { env: { get(name) {
  return { LINE_LIFF_ID: 'synthetic-liff', LINE_MESSAGING_CHANNEL_ID: 'synthetic-channel',
    LINE_MESSAGING_CHANNEL_SECRET: secret, LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'synthetic-channel-access-token',
    PATIENT_IDENTITY_HMAC_SECRET: secret, SUPABASE_URL: 'https://db.example',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    CNYOS_RUNTIME_EXPECTED_CLINIC_ID: '00000000-0000-0000-0000-000000000001' }[name] || '';
} } };
console.error = (...args) => logs.push(args);
try {
  const { default: handler } = await import('../netlify/functions/line-oa-webhook.mts?error-privacy');
  for (const mode of ['early', 'reply', 'finalization', 'known']) {
    logs.length = 0;
    finalizations.length = 0;
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
      if (url.endsWith('/assert_clinic_subscription_active')) return mode === 'early'
        ? json({ message: 'SYNTHETIC_PATIENT_HN_123456' }, 400) : json(true);
      if (url.endsWith('/register_line_oa_webhook_event_for_clinic')) return json([{ accepted: true }]);
      if (url.endsWith('/finalize_line_oa_webhook_event')) {
        finalizations.push(JSON.parse(options.body));
        if (mode === 'finalization') throw new Error('SYNTHETIC_PROVIDER_SECRET');
        return json(true);
      }
      assert.equal(url, 'https://api.line.me/v2/bot/message/reply');
      if (mode === 'known') return json({ message: 'SYNTHETIC_UNTRUSTED_PROVIDER_BODY' }, 502);
      throw new Error('SYNTHETIC_PATIENT_TOKEN_VALUE');
    };
    const body = JSON.stringify({ destination: 'synthetic-channel', events: [{
      type: 'follow', webhookEventId: `synthetic-event-${mode}`, timestamp: Date.now(),
      replyToken: 'synthetic-reply-token', source: { type: 'user', userId: 'U0123456789abcdef0123456789abcdef' }
    }] });
    const signature = createHmac('sha256', secret).update(body).digest('base64');
    const response = await handler(new Request('https://patient.example/api/line-oa-webhook', {
      method: 'POST', headers: { 'x-line-signature': signature }, body
    }), { requestId: `privacy-${mode}` });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, code: 'LINE_WEBHOOK_PROCESSING_FAILED' });
    assert.ok(logs.length > 0);
    assert.doesNotMatch(JSON.stringify({ logs, finalizations }), /SYNTHETIC_PATIENT|SYNTHETIC_PROVIDER|SYNTHETIC_UNTRUSTED/,
      'untrusted uppercase error text must not become a log or persistent result code');
    if (mode !== 'early') {
      assert.equal(finalizations.length, 1);
      assert.equal(finalizations[0].p_error_code, mode === 'known' ? 'LINE_REPLY_FAILED' : 'LINE_WEBHOOK_PROCESSING_FAILED');
    }
  }
} finally {
  console.error = previousError;
  globalThis.fetch = previousFetch;
  globalThis.Netlify = previousNetlify;
}
console.log('LINE OA error privacy passed: endpoint/event/finalizer logs and result codes reject untrusted uppercase payloads; known reply failure retained.');
