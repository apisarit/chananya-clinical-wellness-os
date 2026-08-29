import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildNotificationMessages,
  buildWebhookReply,
  classifyTextIntent,
  decryptLineUserId,
  encryptLineUserId,
  parseWebhookBody,
  safeWebhookEvent,
  sendLinePush,
  sendLineReply,
  sha256,
  validateLineOaConfig,
  verifyLineWebhookSignature
} from '../netlify/functions/_shared/line-oa.mjs';

const key = Buffer.alloc(32, 17);
const configInput = {
  environment: 'staging',
  activationAck: 'STAGING_LINE_OA_ENABLED',
  deploymentId: 'chananya-line-oa-staging',
  clinicId: '10000000-0000-4000-a000-000000000001',
  patientCardUrl: 'https://chananya-patient-staging.example.test/patient-card.html',
  channelId: '1234567890',
  botUserId: 'U1234567890abcdef1234567890abcdef',
  channelSecret: 's'.repeat(32),
  accessToken: 'a'.repeat(80),
  identitySecret: 'i'.repeat(32),
  encryptionKey: key.toString('base64'),
  encryptionKeyId: 'line-oa-staging-v1',
  supabaseUrl: 'https://staging.supabase.co',
  serviceRoleKey: 'r'.repeat(64)
};
const config = validateLineOaConfig(configInput);
assert.equal(config.environment, 'staging');
assert.equal(config.channelHash, sha256('1234567890'));
assert.throws(() => validateLineOaConfig({
  ...configInput,
  activationAck: 'PRODUCTION_LINE_OA_ENABLED'
}), /ACTIVATION_ACK/);
assert.throws(() => validateLineOaConfig({
  ...configInput,
  patientCardUrl: 'https://chananya.example.test/patient-card.html'
}), /STAGING_BOUNDARY/);

const raw = JSON.stringify({ destination: config.botUserId, events: [] });
const signature = createHmac('sha256', config.channelSecret).update(raw).digest('base64');
assert.equal(verifyLineWebhookSignature(raw, signature, config.channelSecret), true);
assert.equal(verifyLineWebhookSignature(`${raw} `, signature, config.channelSecret), false);
assert.deepEqual(parseWebhookBody(raw).events, []);
assert.throws(() => parseWebhookBody('{bad'), /JSON_INVALID/);

const subjectHash = sha256('subject-binding');
const binding = {
  clinicId: config.clinicId,
  environment: config.environment,
  deploymentId: config.deploymentId,
  channelHash: config.channelHash,
  subjectHash,
  keyId: config.encryptionKeyId
};
const lineUserId = 'Uabcdefabcdefabcdefabcdefabcdefab';
const encrypted = encryptLineUserId(lineUserId, key, binding, { iv: Buffer.alloc(12, 3) });
assert.equal(decryptLineUserId(encrypted, key, binding), lineUserId);
assert.doesNotMatch(JSON.stringify(encrypted), new RegExp(lineUserId));
assert.throws(() => decryptLineUserId({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }, key, binding), /DECRYPT_FAILED/);
assert.throws(() => decryptLineUserId(encrypted, key, { ...binding, deploymentId: 'other-staging' }), /DECRYPT_FAILED/);

const safeEvent = safeWebhookEvent({
  type: 'message',
  mode: 'active',
  timestamp: Date.now(),
  webhookEventId: '01JLINEOAEXAMPLEEVENT00001',
  deliveryContext: { isRedelivery: true },
  source: { type: 'user', userId: lineUserId },
  replyToken: 'reply-token-value',
  message: { type: 'text', id: 'message-id', text: 'ขอดูบัตรและ QR ของฉัน' }
});
assert.equal(safeEvent.intent, 'patient_card');
assert.equal(safeEvent.isRedelivery, true);
assert.equal(safeEvent.metadata.message_type, 'text');
assert.doesNotMatch(JSON.stringify(safeEvent.metadata), /ขอดูบัตร|reply-token-value|abcdefabcdef/);
assert.equal(classifyTextIntent('ขอเลื่อนนัด'), 'appointment');
assert.equal(classifyTextIntent('PDPA และถอนความยินยอม'), 'privacy');

const replies = buildWebhookReply({
  eventType: 'follow',
  patientCardUrl: config.patientCardUrl,
  linkedPatientCount: 1
});
assert.equal(replies.length, 1);
assert.match(replies[0].text, /บัตรผู้รับบริการ/);
assert.doesNotMatch(replies[0].text, /HN\s*\d|โรค|ยา/);

const messages = buildNotificationMessages({
  notification_type: 'APPOINTMENT_REMINDER',
  appointment_no: 'APT-20260829-TEST',
  scheduled_start: '2026-08-30T03:30:00.000Z'
}, config.patientCardUrl);
assert.match(messages[0].text, /แจ้งเตือนนัดหมาย/);
assert.match(messages[0].text, /10:30/);
assert.doesNotMatch(messages[0].text, /อาการ|การวินิจฉัย|รายการยา/);

const calls = [];
const fetchImpl = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ sentMessages: [] }), {
    status: 200,
    headers: { 'x-line-request-id': 'line-request-1', 'Content-Type': 'application/json' }
  });
};
const replyResult = await sendLineReply({
  replyToken: 'reply-token-value',
  messages: replies,
  accessToken: config.accessToken,
  fetchImpl
});
assert.equal(replyResult.requestId, 'line-request-1');
assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/reply');
assert.equal(calls[0].options.headers.Authorization, `Bearer ${config.accessToken}`);
assert.equal(JSON.parse(calls[0].options.body).replyToken, 'reply-token-value');

await sendLinePush({
  to: lineUserId,
  messages,
  accessToken: config.accessToken,
  retryKey: '12345678-1234-4123-a123-123456789abc',
  fetchImpl
});
assert.equal(calls[1].url, 'https://api.line.me/v2/bot/message/push');
assert.equal(calls[1].options.headers['X-Line-Retry-Key'], '12345678-1234-4123-a123-123456789abc');
assert.equal(JSON.parse(calls[1].options.body).to, lineUserId);

const duplicateAccepted = await sendLinePush({
  to: lineUserId,
  messages,
  accessToken: config.accessToken,
  retryKey: '12345678-1234-4123-a123-123456789abc',
  fetchImpl: async () => new Response('{}', {
    status: 409,
    headers: { 'x-line-accepted-request-id': 'line-request-original' }
  })
});
assert.equal(duplicateAccepted.status, 409);
assert.equal(duplicateAccepted.requestId, 'line-request-original');
assert.equal(duplicateAccepted.duplicateAccepted, true);

await assert.rejects(
  sendLinePush({
    to: lineUserId,
    messages,
    accessToken: config.accessToken,
    retryKey: '12345678-1234-4123-a123-123456789abc',
    fetchImpl: async () => new Response('{}', { status: 429 })
  }),
  error => error.message === 'LINE_OA_API_RATE_LIMITED' && error.retryable === true
);

console.log('LINE OA function checks passed: signature, no-plaintext recipient, safe intents, replies, push retry key and operational templates');
