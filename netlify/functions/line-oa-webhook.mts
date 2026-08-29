import {
  buildWebhookReply,
  encryptLineUserId,
  parseWebhookBody,
  publicLineOaError,
  readRawBody,
  safeWebhookEvent,
  sendLineReply,
  validateLineOaConfig,
  verifyLineWebhookSignature
} from './_shared/line-oa.mjs';
import { hmacSha256, supabaseRpc } from './_shared/patient-identity.mjs';

const responseHeaders = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: responseHeaders
});

const env = name => Netlify.env.get(name) || '';

function configuration() {
  return validateLineOaConfig({
    environment: env('LINE_OA_ENVIRONMENT'),
    activationAck: env('LINE_OA_ACTIVATION_ACK'),
    deploymentId: env('LINE_OA_DEPLOYMENT_ID'),
    clinicId: env('LINE_OA_CLINIC_ID'),
    patientCardUrl: env('LINE_PATIENT_CARD_URL'),
    channelId: env('LINE_MESSAGING_CHANNEL_ID'),
    botUserId: env('LINE_MESSAGING_BOT_USER_ID'),
    channelSecret: env('LINE_MESSAGING_CHANNEL_SECRET'),
    accessToken: env('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'),
    identitySecret: env('PATIENT_IDENTITY_HMAC_SECRET'),
    encryptionKey: env('LINE_OA_ENCRYPTION_KEY_BASE64'),
    encryptionKeyId: env('LINE_OA_ENCRYPTION_KEY_ID'),
    supabaseUrl: env('SUPABASE_URL'),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY')
  });
}

async function rpc(config, name, body) {
  return supabaseRpc({
    url: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    name,
    body
  });
}

const first = value => Array.isArray(value) ? value[0] || null : value || null;

function recipientBinding(config, subjectHash) {
  return {
    clinicId: config.clinicId,
    environment: config.environment,
    deploymentId: config.deploymentId,
    channelHash: config.channelHash,
    subjectHash,
    keyId: config.encryptionKeyId
  };
}

async function finish(config, eventId, outcome, { retryable = false, errorCode = null } = {}) {
  await rpc(config, 'finish_line_oa_webhook_event', {
    p_clinic_id: config.clinicId,
    p_environment: config.environment,
    p_deployment_id: config.deploymentId,
    p_channel_hash: config.channelHash,
    p_webhook_event_id: eventId,
    p_outcome: outcome,
    p_error_code: errorCode,
    p_retryable: retryable
  });
}

async function processEvent(config, rawEvent) {
  const event = safeWebhookEvent(rawEvent);
  const subjectHash = event.userId ? hmacSha256(event.userId, config.identitySecret) : null;
  const encrypted = event.userId && event.contactState !== 'blocked'
    ? encryptLineUserId(event.userId, config.encryptionKey, recipientBinding(config, subjectHash))
    : null;

  const claim = first(await rpc(config, 'claim_line_oa_webhook_event', {
    p_clinic_id: config.clinicId,
    p_environment: config.environment,
    p_deployment_id: config.deploymentId,
    p_channel_hash: config.channelHash,
    p_webhook_event_id: event.eventId,
    p_event_type: event.eventType,
    p_event_timestamp: event.timestamp,
    p_is_redelivery: event.isRedelivery,
    p_mode: event.mode,
    p_subject_hash: subjectHash,
    p_contact_state: event.contactState,
    p_user_id_ciphertext: encrypted?.ciphertext || null,
    p_user_id_iv: encrypted?.iv || null,
    p_user_id_auth_tag: encrypted?.authTag || null,
    p_encryption_key_id: encrypted?.keyId || null,
    p_metadata: event.metadata
  }));

  if (!claim?.claimed) return { processed: false, duplicate: true };

  if (event.mode === 'standby') {
    await finish(config, event.eventId, 'standby_ignored');
    return { processed: true };
  }
  if (event.eventType === 'unfollow') {
    await finish(config, event.eventId, 'contact_blocked');
    return { processed: true };
  }
  if (!event.userId || !['follow', 'message', 'postback'].includes(event.eventType)) {
    await finish(config, event.eventId, 'unsupported_event_ignored');
    return { processed: true };
  }
  if (!event.replyToken) {
    await finish(config, event.eventId, 'no_reply_token');
    return { processed: true };
  }

  const messages = buildWebhookReply({
    eventType: event.eventType,
    intent: event.intent,
    patientCardUrl: config.patientCardUrl,
    linkedPatientCount: claim.linked_patient_count || 0
  });
  try {
    await sendLineReply({
      replyToken: event.replyToken,
      messages,
      accessToken: config.accessToken
    });
    await finish(config, event.eventId, 'reply_sent');
    return { processed: true };
  } catch (error) {
    const retryable = error?.retryable === true;
    await finish(config, event.eventId, retryable ? 'reply_retryable_failure' : 'reply_terminal_failure', {
      retryable,
      errorCode: error?.message || 'LINE_OA_REPLY_FAILED'
    });
    if (retryable) throw error;
    return { processed: true, terminalReplyFailure: true };
  }
}

async function processInBatches(config, events, size = 5) {
  const results = [];
  for (let offset = 0; offset < events.length; offset += size) {
    const batch = await Promise.allSettled(events.slice(offset, offset + size).map(event => processEvent(config, event)));
    results.push(...batch);
  }
  return results;
}

export default async (request, context) => {
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  if (env('LINE_OA_ENABLED') !== 'true') return json({ ok: false, code: 'LINE_OA_NOT_CONFIGURED' }, 503);

  let config;
  let rawBody;
  try {
    config = configuration();
    rawBody = await readRawBody(request);
    if (!verifyLineWebhookSignature(rawBody, request.headers.get('x-line-signature'), config.channelSecret)) {
      throw new Error('LINE_OA_SIGNATURE_INVALID');
    }
    const body = parseWebhookBody(rawBody);
    if (String(body.destination || '') !== config.botUserId) throw new Error('LINE_OA_DESTINATION_INVALID');
    if (body.events.length === 0) return json({ ok: true, verified: true });

    const results = await processInBatches(config, body.events);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      console.error('line-oa webhook transient failure', {
        requestId: context.requestId,
        eventCount: body.events.length,
        failureCount: failures.length
      });
      return json({ ok: false, code: 'LINE_OA_RETRY_REQUIRED' }, 500);
    }
    return json({ ok: true, eventCount: body.events.length });
  } catch (error) {
    const safe = publicLineOaError(error);
    console.error('line-oa webhook rejected', {
      requestId: context.requestId,
      code: safe.code,
      internalCode: error?.message || 'UNKNOWN'
    });
    return json({ ok: false, code: safe.code }, safe.status);
  }
};

export const config = {
  path: '/api/line/webhook',
  method: ['POST']
};
