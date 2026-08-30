import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLineReplyMessages,
  classifyLineAction,
  lineEventHashes,
  lineEventTimestamp,
  parseLineWebhook,
  publicLineWebhookError,
  readLineWebhookBody,
  replyLineMessage,
  safePatientCardUrl,
  verifyLineWebhookSignature
} from '../netlify/functions/_shared/line-oa.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const secret = '0123456789abcdef0123456789abcdef';
const rawBody = JSON.stringify({ destination: 'channel', events: [] });
const signature = createHmac('sha256', secret).update(rawBody).digest('base64');

assert.equal(verifyLineWebhookSignature(rawBody, signature, secret), true);
assert.equal(verifyLineWebhookSignature(`${rawBody} `, signature, secret), false);
assert.equal(verifyLineWebhookSignature(rawBody, 'invalid', secret), false);
assert.equal(parseLineWebhook(rawBody).length, 0);
assert.throws(() => parseLineWebhook('{bad'), /LINE_WEBHOOK_JSON_INVALID/);
assert.throws(() => parseLineWebhook('{"events":{}}'), /LINE_WEBHOOK_PAYLOAD_INVALID/);

const textEvent = text => ({ type: 'message', message: { type: 'text', text } });
assert.equal(classifyLineAction(textEvent('บัตรผู้รับบริการ')), 'card');
assert.equal(classifyLineAction(textEvent('ขอดูนัดหมาย')), 'appointments');
assert.equal(classifyLineAction(textEvent('ถอนความยินยอม')), 'revoke');
assert.equal(classifyLineAction(textEvent('PDPA')), 'privacy');
assert.equal(classifyLineAction(textEvent('ดูสถานะ')), 'status');
assert.equal(classifyLineAction(textEvent('hello')), 'unknown');
assert.equal(classifyLineAction({ type: 'postback', postback: { data: 'action=card' } }), 'card');
assert.equal(classifyLineAction({ type: 'image' }), 'unknown');

const event = {
  type: 'follow',
  timestamp: 1_800_000_000_000,
  webhookEventId: '01H-EVENT-ID',
  source: { type: 'user', userId: 'U0123456789abcdef0123456789abcdef' }
};
const hashes = lineEventHashes(event);
assert.match(hashes.eventIdHash, /^[0-9a-f]{64}$/);
assert.match(hashes.payloadHash, /^[0-9a-f]{64}$/);
assert.doesNotMatch(JSON.stringify(hashes), /U0123456789/);
assert.equal(lineEventTimestamp(event), new Date(event.timestamp).toISOString());

assert.equal(safePatientCardUrl('javascript:alert(1)'), '');
assert.equal(safePatientCardUrl('http://patient.example/card'), '');
assert.equal(safePatientCardUrl('https://liff.line.me/123-test'), 'https://liff.line.me/123-test');
const replies = buildLineReplyMessages('card', {
  patientCardUrl: 'https://liff.line.me/123-test',
  brandName: 'CHANANYA'
});
assert.equal(replies.length, 1);
assert.equal(replies[0].type, 'text');
assert.equal(replies[0].quickReply.items[0].action.type, 'uri');
assert.equal(replies[0].quickReply.items[0].action.uri, 'https://liff.line.me/123-test');
assert.doesNotMatch(JSON.stringify(replies), /CHANANYA-00000001|สมชาย|โรคทดสอบ/);

let replyRequest;
await replyLineMessage({
  replyToken: 'reply-token-0123456789',
  messages: replies,
  channelAccessToken: 'channel-access-token-0123456789',
  fetchImpl: async (url, options) => {
    replyRequest = { url, options };
    return new Response('{}', { status: 200 });
  }
});
assert.equal(replyRequest.url, 'https://api.line.me/v2/bot/message/reply');
assert.equal(replyRequest.options.method, 'POST');
assert.equal(replyRequest.options.headers.Authorization, 'Bearer channel-access-token-0123456789');
assert.deepEqual(JSON.parse(replyRequest.options.body), {
  replyToken: 'reply-token-0123456789',
  messages: replies
});

assert.equal(
  await readLineWebhookBody(new Request('https://patient.example', { method: 'POST', body: rawBody })),
  rawBody
);
await assert.rejects(
  readLineWebhookBody(new Request('https://patient.example', { method: 'POST', body: '12345' }), 4),
  /LINE_WEBHOOK_REQUEST_TOO_LARGE/
);
assert.deepEqual(publicLineWebhookError(new Error('LINE_WEBHOOK_SIGNATURE_INVALID')), {
  code: 'LINE_WEBHOOK_SIGNATURE_INVALID',
  status: 401
});
assert.deepEqual(publicLineWebhookError(new Error('database secret detail')), {
  code: 'LINE_WEBHOOK_PROCESSING_FAILED',
  status: 500
});

const backend = read('netlify/functions/line-oa-webhook.mts');
const migration = read('supabase/migrations/202608292100_line_oa_messaging_gateway.sql');
const envExample = read('.env.example');

assert.match(backend, /verifyLineWebhookSignature\(rawBody, signature/);
assert.match(backend, /request\.headers\.get\('x-line-signature'\)/);
assert.match(backend, /register_line_oa_webhook_event/);
assert.match(backend, /finalize_line_oa_webhook_event/);
assert.match(backend, /hmacSha256\(subject, config\.identitySecret\)/);
assert.match(backend, /source\?\.type !== 'user'/);
assert.doesNotMatch(backend, /console\.(?:log|error)\([^\n]*(?:rawBody|userId|message\.text)/);
assert.match(migration, /create table if not exists public\.line_oa_gateway_webhook_events/i);
assert.match(migration, /unique \(provider_channel_hash, event_id_hash\)/i);
assert.match(migration, /raw LINE user IDs, message text, reply tokens/i);
assert.match(migration, /revoke all on public\.line_oa_gateway_webhook_events from public, anon, authenticated, service_role/i);
assert.match(migration, /register_line_oa_webhook_event/i);
assert.match(migration, /LINE_OA_PATIENT_CARD_REQUESTED/i);
assert.match(migration, /grant execute on function public\.line_oa_webhook_evidence\(timestamptz\) to service_role/i);
for (const key of [
  'LINE_MESSAGING_CHANNEL_ID',
  'LINE_MESSAGING_CHANNEL_SECRET',
  'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'
]) assert.match(envExample, new RegExp(`^${key}=`, 'm'));

console.log('LINE OA gateway contracts passed: signature, privacy-safe routing, idempotency, audit and Messaging API reply');
