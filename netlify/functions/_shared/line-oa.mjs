import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

const LINE_API_ORIGIN = 'https://api.line.me';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_DEPLOYMENT_MARKER = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const STAGING_HOST_MARKER = /(?:^|[-.])(staging|stage|nonprod)(?:$|[-.])/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function required(value, code, min = 1, max = 4096) {
  const clean = String(value || '').trim();
  if (clean.length < min || clean.length > max) throw new Error(code);
  return clean;
}

function httpsUrl(value, code) {
  let parsed;
  try { parsed = new URL(required(value, code, 8, 2048)); }
  catch { throw new Error(code); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(code);
  parsed.hash = '';
  return parsed.toString();
}

export function parseLineEncryptionKey(value) {
  let key;
  try { key = Buffer.from(String(value || ''), 'base64'); }
  catch { throw new Error('LINE_OA_ENCRYPTION_KEY_INVALID'); }
  if (key.length !== 32) throw new Error('LINE_OA_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  return key;
}

export function normalizeLineUserId(value) {
  const userId = String(value || '').trim();
  if (!LINE_USER_ID_PATTERN.test(userId)) throw new Error('LINE_OA_USER_ID_INVALID');
  return userId;
}

export function validateLineOaConfig(input) {
  const environment = String(input.environment || '').trim().toLowerCase();
  if (!['staging', 'production'].includes(environment)) throw new Error('LINE_OA_ENVIRONMENT_INVALID');
  const expectedAck = environment === 'staging'
    ? 'STAGING_LINE_OA_ENABLED'
    : 'PRODUCTION_LINE_OA_ENABLED';
  if (String(input.activationAck || '') !== expectedAck) throw new Error('LINE_OA_ACTIVATION_ACK_INVALID');

  const deploymentId = required(input.deploymentId, 'LINE_OA_DEPLOYMENT_ID_INVALID', 2, 80);
  const patientCardUrl = httpsUrl(input.patientCardUrl, 'LINE_PATIENT_CARD_URL_INVALID');
  const patientHost = new URL(patientCardUrl).hostname;
  if (environment === 'staging' && (!STAGING_DEPLOYMENT_MARKER.test(deploymentId) || !STAGING_HOST_MARKER.test(patientHost))) {
    throw new Error('LINE_OA_STAGING_BOUNDARY_INVALID');
  }
  if (environment === 'production' && (STAGING_DEPLOYMENT_MARKER.test(deploymentId) || STAGING_HOST_MARKER.test(patientHost))) {
    throw new Error('LINE_OA_PRODUCTION_BOUNDARY_INVALID');
  }

  const clinicId = required(input.clinicId, 'LINE_OA_CLINIC_ID_INVALID', 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(clinicId)) throw new Error('LINE_OA_CLINIC_ID_INVALID');
  const channelId = required(input.channelId, 'LINE_MESSAGING_CHANNEL_ID_INVALID', 6, 32);
  if (!/^\d{6,32}$/.test(channelId)) throw new Error('LINE_MESSAGING_CHANNEL_ID_INVALID');
  const botUserId = normalizeLineUserId(input.botUserId);
  const channelSecret = required(input.channelSecret, 'LINE_MESSAGING_CHANNEL_SECRET_INVALID', 24, 256);
  const accessToken = required(input.accessToken, 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN_INVALID', 40, 4096);
  const identitySecret = required(input.identitySecret, 'PATIENT_IDENTITY_HMAC_SECRET_INVALID', 32, 4096);
  const encryptionKey = parseLineEncryptionKey(input.encryptionKey);
  const encryptionKeyId = required(input.encryptionKeyId, 'LINE_OA_ENCRYPTION_KEY_ID_INVALID', 2, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(encryptionKeyId)) {
    throw new Error('LINE_OA_ENCRYPTION_KEY_ID_INVALID');
  }
  const supabaseUrl = httpsUrl(input.supabaseUrl, 'LINE_OA_DATABASE_CONFIG_INVALID').replace(/\/$/, '');
  const serviceRoleKey = required(input.serviceRoleKey, 'LINE_OA_DATABASE_CONFIG_INVALID', 32, 4096);

  return Object.freeze({
    environment,
    deploymentId,
    clinicId,
    patientCardUrl,
    channelId,
    channelHash: sha256(channelId),
    botUserId,
    channelSecret,
    accessToken,
    identitySecret,
    encryptionKey,
    encryptionKeyId,
    supabaseUrl,
    serviceRoleKey
  });
}

export function verifyLineWebhookSignature(rawBody, signature, channelSecret) {
  const received = String(signature || '').trim();
  if (!received || !channelSecret) return false;
  let receivedBytes;
  try { receivedBytes = Buffer.from(received, 'base64'); }
  catch { return false; }
  const expected = createHmac('sha256', channelSecret).update(String(rawBody), 'utf8').digest();
  return receivedBytes.length === expected.length && timingSafeEqual(receivedBytes, expected);
}

function recipientAad({ clinicId, environment, deploymentId, channelHash, subjectHash, keyId }) {
  if (!HASH_PATTERN.test(channelHash) || !HASH_PATTERN.test(subjectHash)) throw new Error('LINE_OA_RECIPIENT_AAD_INVALID');
  return Buffer.from([
    'chananya-line-oa-recipient/v1',
    clinicId,
    environment,
    deploymentId,
    channelHash,
    subjectHash,
    keyId
  ].join('\n'), 'utf8');
}

export function encryptLineUserId(userId, key, binding, options = {}) {
  const normalized = normalizeLineUserId(userId);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('LINE_OA_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  const iv = options.iv || randomBytes(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new Error('LINE_OA_ENCRYPTION_IV_INVALID');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(recipientAad(binding));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId: binding.keyId
  });
}

export function decryptLineUserId(envelope, key, binding) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('LINE_OA_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  if (String(envelope.keyId || '') !== String(binding.keyId || '')) throw new Error('LINE_OA_ENCRYPTION_KEY_ID_MISMATCH');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(recipientAad(binding));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return normalizeLineUserId(plaintext);
  } catch (error) {
    if (String(error?.message || '').startsWith('LINE_OA_')) throw error;
    throw new Error('LINE_OA_RECIPIENT_DECRYPT_FAILED');
  }
}

export async function readRawBody(request, maxBytes = 1_000_000) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('LINE_OA_REQUEST_TOO_LARGE');
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('LINE_OA_REQUEST_TOO_LARGE');
  return raw;
}

export function parseWebhookBody(raw) {
  let payload;
  try { payload = JSON.parse(raw || '{}'); }
  catch { throw new Error('LINE_OA_WEBHOOK_JSON_INVALID'); }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events) || payload.events.length > 100) {
    throw new Error('LINE_OA_WEBHOOK_SHAPE_INVALID');
  }
  return payload;
}

export function classifyTextIntent(value) {
  const text = String(value || '').trim().toLowerCase().slice(0, 500);
  if (/บัตร|qr|คิว|check\s*-?in|เช็กอิน|เช็คอิน/.test(text)) return 'patient_card';
  if (/นัด|จอง|เลื่อน|ยกเลิก/.test(text)) return 'appointment';
  if (/ความเป็นส่วนตัว|ข้อมูล|pdpa|ยินยอม|ถอน/.test(text)) return 'privacy';
  if (/ช่วย|เมนู|เริ่ม|สวัสดี|hello|hi/.test(text)) return 'help';
  return 'other';
}

export function postbackIntent(value) {
  const params = new URLSearchParams(String(value || '').slice(0, 1024));
  const action = params.get('action');
  return ['patient_card', 'appointment', 'privacy', 'help'].includes(action) ? action : 'other';
}

export function safeWebhookEvent(event) {
  const eventId = String(event?.webhookEventId || '').trim();
  if (!SAFE_ID.test(eventId)) throw new Error('LINE_OA_WEBHOOK_EVENT_ID_INVALID');
  const eventType = String(event?.type || 'unknown').slice(0, 40);
  const mode = ['active', 'standby'].includes(event?.mode) ? event.mode : 'unknown';
  const timestamp = Number(event?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('LINE_OA_WEBHOOK_TIMESTAMP_INVALID');
  const sourceType = String(event?.source?.type || 'none');
  const userId = sourceType === 'user' ? normalizeLineUserId(event?.source?.userId) : null;
  const messageType = eventType === 'message' ? String(event?.message?.type || 'unknown').slice(0, 40) : null;
  const intent = eventType === 'message' && messageType === 'text'
    ? classifyTextIntent(event.message.text)
    : eventType === 'postback'
      ? postbackIntent(event.postback?.data)
      : null;
  const contactState = eventType === 'follow' ? 'active'
    : eventType === 'unfollow' ? 'blocked'
      : userId ? 'interacted' : 'none';
  return Object.freeze({
    eventId,
    eventType,
    mode,
    timestamp: new Date(timestamp).toISOString(),
    isRedelivery: event?.deliveryContext?.isRedelivery === true,
    sourceType,
    userId,
    replyToken: typeof event?.replyToken === 'string' ? event.replyToken : null,
    messageType,
    intent,
    contactState,
    metadata: Object.freeze({
      source_type: sourceType,
      message_type: messageType,
      intent,
      has_reply_token: typeof event?.replyToken === 'string'
    })
  });
}

function quickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: 'บัตรผู้รับบริการ', text: 'บัตรผู้รับบริการ' } },
      { type: 'action', action: { type: 'message', label: 'นัดหมาย', text: 'นัดหมาย' } },
      { type: 'action', action: { type: 'message', label: 'ความเป็นส่วนตัว', text: 'ความเป็นส่วนตัว' } }
    ]
  };
}

export function buildWebhookReply({ eventType, intent, patientCardUrl, linkedPatientCount = 0 }) {
  const linked = Number(linkedPatientCount) > 0;
  let text;
  if (eventType === 'follow') {
    text = linked
      ? `ยินดีต้อนรับกลับสู่ CHANANYA\nเปิดบัตรผู้รับบริการและสร้าง QR แบบใช้ครั้งเดียวได้ที่ ${patientCardUrl}`
      : `ยินดีต้อนรับสู่ CHANANYA\nรับรหัสเชื่อมบัญชีจากเจ้าหน้าที่ แล้วเปิดบัตรผู้รับบริการที่ ${patientCardUrl}\nผู้ไม่มีมือถือยังใช้ HN กับเจ้าหน้าที่ได้ตามปกติ`;
  } else if (intent === 'patient_card') {
    text = `เปิดบัตรผู้รับบริการและ QR แบบใช้ครั้งเดียว: ${patientCardUrl}\nQR ไม่มีชื่อ HN หรือข้อมูลสุขภาพ และหมดอายุอัตโนมัติ`;
  } else if (intent === 'appointment') {
    text = `เรื่องนัดหมาย กรุณาติดต่อเจ้าหน้าที่ CHANANYA ในแชตนี้\nหากยินยอมรับข้อความบริการ ระบบจะส่งเฉพาะการยืนยัน เตือน หรือเปลี่ยนแปลงนัดหมาย ไม่รวมโฆษณา\nบัตรผู้รับบริการ: ${patientCardUrl}`;
  } else if (intent === 'privacy') {
    text = 'CHANANYA ไม่บันทึกข้อความแชตลงเวชระเบียนอัตโนมัติ ไม่ใส่ชื่อ HN หรือข้อมูลสุขภาพใน QR และสามารถถอนความยินยอมรับข้อความบริการจากหน้าบัตรผู้รับบริการได้ทุกเวลา';
  } else {
    text = `เมนู CHANANYA\n• บัตรผู้รับบริการ / QR\n• นัดหมาย\n• ความเป็นส่วนตัว\n\nเปิดบัตรผู้รับบริการ: ${patientCardUrl}`;
  }
  return [{ type: 'text', text, quickReply: quickReply() }];
}

function thaiAppointmentTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('LINE_OA_APPOINTMENT_TIME_INVALID');
  const day = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric'
  }).format(date);
  const time = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date);
  return `${day} เวลา ${time} น.`;
}

export function buildNotificationMessages(notification, patientCardUrl) {
  const appointmentNo = required(notification.appointment_no, 'LINE_OA_APPOINTMENT_NUMBER_INVALID', 2, 80);
  const when = thaiAppointmentTime(notification.scheduled_start);
  const suffix = `\nเลขที่นัด ${appointmentNo}\n${when}\nบัตรผู้รับบริการ: ${patientCardUrl}`;
  const prefix = {
    APPOINTMENT_BOOKED: 'CHANANYA ได้รับการนัดหมายแล้ว',
    APPOINTMENT_CONFIRMED: 'CHANANYA ยืนยันนัดหมายแล้ว',
    APPOINTMENT_REMINDER: 'แจ้งเตือนนัดหมาย CHANANYA',
    APPOINTMENT_RESCHEDULED: 'นัดหมาย CHANANYA มีการเปลี่ยนแปลง กรุณาติดต่อเจ้าหน้าที่เพื่อตรวจสอบ',
    APPOINTMENT_CANCELLED: 'นัดหมาย CHANANYA ถูกยกเลิก หากต้องการนัดใหม่กรุณาติดต่อเจ้าหน้าที่'
  }[notification.notification_type];
  if (!prefix) throw new Error('LINE_OA_NOTIFICATION_TYPE_INVALID');
  return [{ type: 'text', text: `${prefix}${suffix}` }];
}

async function lineApi(path, payload, accessToken, { retryKey, fetchImpl = fetch } = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  let response;
  try {
    response = await fetchImpl(`${LINE_API_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    const error = new Error('LINE_OA_API_UNAVAILABLE');
    error.retryable = true;
    throw error;
  }
  const acceptedRequestId = response.headers.get('x-line-accepted-request-id');
  if (retryKey && response.status === 409 && acceptedRequestId) {
    return Object.freeze({
      status: response.status,
      requestId: acceptedRequestId,
      duplicateAccepted: true
    });
  }
  if (!response.ok) {
    const error = new Error(response.status === 429 ? 'LINE_OA_API_RATE_LIMITED' : 'LINE_OA_API_REJECTED');
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return Object.freeze({
    status: response.status,
    requestId: response.headers.get('x-line-request-id') || null,
    duplicateAccepted: false
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 5) {
    throw new Error('LINE_OA_MESSAGES_INVALID');
  }
  for (const message of messages) {
    if (message?.type !== 'text' || typeof message.text !== 'string' || message.text.length < 1 || message.text.length > 5000) {
      throw new Error('LINE_OA_MESSAGE_INVALID');
    }
  }
  return messages;
}

export function sendLineReply({ replyToken, messages, accessToken, fetchImpl }) {
  const token = required(replyToken, 'LINE_OA_REPLY_TOKEN_INVALID', 8, 2048);
  return lineApi('/v2/bot/message/reply', {
    replyToken: token,
    messages: validateMessages(messages),
    notificationDisabled: false
  }, accessToken, { fetchImpl });
}

export function sendLinePush({ to, messages, accessToken, retryKey, fetchImpl }) {
  const recipient = normalizeLineUserId(to);
  if (!UUID_PATTERN.test(String(retryKey || ''))) throw new Error('LINE_OA_RETRY_KEY_INVALID');
  return lineApi('/v2/bot/message/push', {
    to: recipient,
    messages: validateMessages(messages),
    notificationDisabled: false
  }, accessToken, { retryKey, fetchImpl });
}

export function publicLineOaError(error) {
  const code = String(error?.message || '');
  if (code === 'LINE_OA_REQUEST_TOO_LARGE') return { code, status: 413 };
  if (code.includes('SIGNATURE')) return { code: 'LINE_OA_SIGNATURE_INVALID', status: 401 };
  if (code.includes('JSON') || code.includes('SHAPE') || code.includes('EVENT_ID') || code.includes('TIMESTAMP')) {
    return { code: 'LINE_OA_WEBHOOK_INVALID', status: 400 };
  }
  return { code: 'LINE_OA_REQUEST_FAILED', status: 500 };
}
