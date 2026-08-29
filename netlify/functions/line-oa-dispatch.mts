import { randomUUID } from 'node:crypto';
import {
  buildNotificationMessages,
  decryptLineUserId,
  sendLinePush,
  validateLineOaConfig
} from './_shared/line-oa.mjs';
import { supabaseRpc } from './_shared/patient-identity.mjs';

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

function recipientBinding(config, notification) {
  return {
    clinicId: config.clinicId,
    environment: config.environment,
    deploymentId: config.deploymentId,
    channelHash: config.channelHash,
    subjectHash: notification.subject_hash,
    keyId: notification.encryption_key_id
  };
}

async function mark(config, notification, workerId, outcome) {
  await rpc(config, 'finish_line_oa_notification', {
    p_notification_id: notification.notification_id,
    p_worker_id: workerId,
    p_outcome: outcome.outcome,
    p_http_status: outcome.httpStatus || null,
    p_error_code: outcome.errorCode || null,
    p_line_request_id: outcome.lineRequestId || null
  });
}

async function deliver(config, notification, workerId) {
  try {
    const to = decryptLineUserId({
      ciphertext: notification.user_id_ciphertext,
      iv: notification.user_id_iv,
      authTag: notification.user_id_auth_tag,
      keyId: notification.encryption_key_id
    }, config.encryptionKey, recipientBinding(config, notification));
    const messages = buildNotificationMessages(notification, config.patientCardUrl);
    const result = await sendLinePush({
      to,
      messages,
      accessToken: config.accessToken,
      retryKey: notification.retry_key
    });
    await mark(config, notification, workerId, {
      outcome: 'sent',
      httpStatus: result.status,
      lineRequestId: result.requestId
    });
    return { sent: true };
  } catch (error) {
    await mark(config, notification, workerId, {
      outcome: error?.retryable === true || String(error?.message || '').includes('DECRYPT') ? 'retry' : 'terminal_failure',
      httpStatus: error?.status || null,
      errorCode: error?.message || 'LINE_OA_DELIVERY_FAILED'
    });
    return { sent: false };
  }
}

async function runBatches(config, notifications, workerId, size = 4) {
  const results = [];
  for (let offset = 0; offset < notifications.length; offset += size) {
    results.push(...await Promise.all(
      notifications.slice(offset, offset + size).map(item => deliver(config, item, workerId))
    ));
  }
  return results;
}

export default async (_request, context) => {
  if (env('LINE_OA_ENABLED') !== 'true') {
    console.log('line-oa dispatch disabled', { requestId: context.requestId });
    return new Response(null, { status: 204 });
  }

  const config = configuration();
  const workerId = String(context.requestId || randomUUID()).slice(0, 120);
  const notifications = await rpc(config, 'claim_line_oa_notification_batch', {
    p_clinic_id: config.clinicId,
    p_environment: config.environment,
    p_deployment_id: config.deploymentId,
    p_channel_hash: config.channelHash,
    p_worker_id: workerId,
    p_limit: 8
  });
  const rows = Array.isArray(notifications) ? notifications : [];
  const results = await runBatches(config, rows, workerId);
  console.log('line-oa dispatch complete', {
    requestId: context.requestId,
    claimed: rows.length,
    sent: results.filter(result => result.sent).length,
    failed: results.filter(result => !result.sent).length,
    environment: config.environment,
    deploymentId: config.deploymentId
  });
  return new Response(null, { status: 204 });
};

export const config = {
  schedule: '*/5 * * * *'
};
