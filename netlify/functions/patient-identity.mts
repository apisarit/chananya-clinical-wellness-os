import QRCode from 'qrcode';
import {
  allowedRequestOrigin,
  createOneTimeCredential,
  hmacSha256,
  normalizeLinkCode,
  normalizePatientId,
  publicError,
  readJsonBody,
  supabaseRpc,
  verifyLineIdToken
} from './_shared/patient-identity.mjs';
import { sha256 as lineOaSha256, validateLineOaConfig } from './_shared/line-oa.mjs';

const noStoreHeaders = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: noStoreHeaders });
}

function env(name) {
  return Netlify.env.get(name) || '';
}

function configuration() {
  const config = {
    liffId: env('LINE_LIFF_ID'),
    lineChannelId: env('LINE_LOGIN_CHANNEL_ID'),
    lineMessagingChannelId: env('LINE_MESSAGING_CHANNEL_ID'),
    lineOaEnvironment: env('LINE_OA_ENVIRONMENT').toLowerCase(),
    lineOaDeploymentId: env('LINE_OA_DEPLOYMENT_ID'),
    lineOaClinicId: env('LINE_OA_CLINIC_ID'),
    lineOaEnabled: env('LINE_OA_ENABLED') === 'true',
    identitySecret: env('PATIENT_IDENTITY_HMAC_SECRET'),
    qrIssuer: env('PATIENT_QR_ISSUER') || 'CHANANYA',
    supabaseUrl: env('SUPABASE_URL'),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY')
  };
  const enabled = Boolean(
    config.liffId
    && config.lineChannelId
    && config.identitySecret.length >= 32
    && config.supabaseUrl
    && config.serviceRoleKey
  );
  let operationalMessagingAvailable = false;
  if (config.lineOaEnabled) {
    try {
      validateLineOaConfig({
        environment: config.lineOaEnvironment,
        activationAck: env('LINE_OA_ACTIVATION_ACK'),
        deploymentId: config.lineOaDeploymentId,
        clinicId: config.lineOaClinicId,
        patientCardUrl: env('LINE_PATIENT_CARD_URL'),
        channelId: config.lineMessagingChannelId,
        botUserId: env('LINE_MESSAGING_BOT_USER_ID'),
        channelSecret: env('LINE_MESSAGING_CHANNEL_SECRET'),
        accessToken: env('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'),
        identitySecret: config.identitySecret,
        encryptionKey: env('LINE_OA_ENCRYPTION_KEY_BASE64'),
        encryptionKeyId: env('LINE_OA_ENCRYPTION_KEY_ID'),
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.serviceRoleKey
      });
      operationalMessagingAvailable = true;
    } catch {
      operationalMessagingAvailable = false;
    }
  }
  return Object.freeze({ ...config, enabled, operationalMessagingAvailable });
}

async function rpc(config, name, body) {
  return supabaseRpc({
    url: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    name,
    body
  });
}

function firstRow(payload) {
  return Array.isArray(payload) ? payload[0] || null : payload || null;
}

async function consumeRateLimit(config, action, subjectHash, request, context) {
  const ip = context.ip || request.headers.get('x-nf-client-connection-ip') || 'unknown';
  const bucketKey = hmacSha256(`${action}:${subjectHash}:${ip}`, config.identitySecret);
  const limits = {
    preauth: { count: 60, seconds: 60 },
    link: { count: 8, seconds: 300 },
    status: { count: 30, seconds: 60 },
    card: { count: 12, seconds: 60 },
    preferences: { count: 8, seconds: 300 }
  };
  const limit = limits[action] || { count: 6, seconds: 60 };
  const allowed = await rpc(config, 'consume_patient_identity_rate_limit', {
    p_bucket_key: bucketKey,
    p_limit: limit.count,
    p_window_seconds: limit.seconds
  });
  if (allowed !== true) throw new Error('RATE_LIMITED');
}

async function handlePatientAction(request, context, config) {
  if (!allowedRequestOrigin(request)) {
    return json({ ok: false, code: 'ORIGIN_NOT_ALLOWED' }, 403);
  }

  const body = await readJsonBody(request);
  const action = String(body.action || 'status');
  if (!['link', 'status', 'card', 'preferences'].includes(action)) {
    return json({ ok: false, code: 'ACTION_NOT_ALLOWED' }, 400);
  }

  await consumeRateLimit(config, 'preauth', 'anonymous', request, context);
  const lineIdentity = await verifyLineIdToken(String(body.idToken || ''), config.lineChannelId);
  const subjectHash = hmacSha256(lineIdentity.subject, config.identitySecret);
  await consumeRateLimit(config, action, subjectHash, request, context);

  const channelHash = config.operationalMessagingAvailable
    ? lineOaSha256(config.lineMessagingChannelId)
    : null;

  if (action === 'link') {
    const linkCode = normalizeLinkCode(body.linkCode);
    const operationalConsent = config.operationalMessagingAvailable
      && body.operationalMessagingConsent === true;
    await rpc(config, operationalConsent
      ? 'complete_patient_line_link_with_oa_consent'
      : 'complete_patient_line_link', operationalConsent ? {
        p_link_code: linkCode,
        p_subject_hash: subjectHash,
        p_provider_channel: config.lineChannelId,
        p_subject_consent_confirmed: body.consentConfirmed === true,
        p_clinic_id: config.lineOaClinicId,
        p_environment: config.lineOaEnvironment,
        p_deployment_id: config.lineOaDeploymentId,
        p_channel_hash: channelHash
      } : {
        p_link_code: linkCode,
        p_subject_hash: subjectHash,
        p_provider_channel: config.lineChannelId,
        p_subject_consent_confirmed: body.consentConfirmed === true
      });
  }

  if (action === 'preferences') {
    if (!config.operationalMessagingAvailable) throw new Error('LINE_OA_PREFERENCE_NOT_CONFIGURED');
    const patientId = normalizePatientId(body.patientId);
    await rpc(config, 'set_line_oa_notification_preference_for_subject', {
      p_subject_hash: subjectHash,
      p_patient_id: patientId,
      p_clinic_id: config.lineOaClinicId,
      p_environment: config.lineOaEnvironment,
      p_deployment_id: config.lineOaDeploymentId,
      p_channel_hash: channelHash,
      p_enabled: body.enabled === true
    });
    return json({ ok: true, patientId, operationalMessagingEnabled: body.enabled === true });
  }

  if (action === 'card') {
    const patientId = normalizePatientId(body.patientId);
    let credential;
    let issued;
    for (let attempt = 0; attempt < 5 && !issued; attempt += 1) {
      credential = createOneTimeCredential(config.qrIssuer);
      const expiresAt = new Date(Date.now() + 90_000).toISOString();
      try {
        issued = firstRow(await rpc(config, 'issue_patient_qr_for_subject', {
          p_subject_hash: subjectHash,
          p_patient_id: patientId,
          p_token_hash: credential.tokenHash,
          p_display_code_hash: credential.displayCodeHash,
          p_expires_at: expiresAt
        }));
      } catch (error) {
        if (error?.message !== 'DISPLAY_CODE_COLLISION') throw error;
      }
    }
    if (!issued || !credential) throw new Error('QR_CREDENTIAL_GENERATION_FAILED');

    const qrDataUrl = await QRCode.toDataURL(credential.payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 360,
      color: { dark: '#123b2e', light: '#fffefa' }
    });

    return json({
      ok: true,
      card: {
        patientId: issued.patient_id,
        clinicId: issued.clinic_id,
        hn: issued.hn,
        displayName: issued.display_name,
        displayCode: credential.displayCode,
        qrDataUrl,
        expiresAt: issued.expires_at
      }
    });
  }

  const patients = await rpc(config, 'list_line_linked_patients', {
    p_subject_hash: subjectHash
  });
  let preferences = [];
  if (config.operationalMessagingAvailable) {
    preferences = await rpc(config, 'list_line_oa_notification_preferences_for_subject', {
      p_subject_hash: subjectHash,
      p_clinic_id: config.lineOaClinicId,
      p_environment: config.lineOaEnvironment,
      p_deployment_id: config.lineOaDeploymentId,
      p_channel_hash: channelHash
    });
  }
  const preferenceByPatient = new Map((Array.isArray(preferences) ? preferences : []).map(item => [
    item.patient_id,
    item.operational_messaging_enabled === true
  ]));
  const linked = (Array.isArray(patients) ? patients : []).map(patient => ({
    ...patient,
    operational_messaging_enabled: preferenceByPatient.get(patient.patient_id) === true
  }));
  return json({
    ok: true,
    linked,
    operationalMessagingAvailable: config.operationalMessagingAvailable
  });
}

export default async (request, context) => {
  const config = configuration();

  if (request.method === 'GET') {
    return json({
      enabled: config.enabled,
      liffId: config.enabled ? config.liffId : null,
      qrTtlSeconds: 90,
      digitalOptional: true,
      operationalMessagingAvailable: config.enabled && config.operationalMessagingAvailable
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  }

  if (!config.enabled) {
    return json({ ok: false, code: 'PATIENT_IDENTITY_NOT_CONFIGURED' }, 503);
  }

  try {
    return await handlePatientAction(request, context, config);
  } catch (error) {
    const safe = publicError(error);
    console.error('patient-identity request failed', {
      requestId: context.requestId,
      code: safe.code,
      internalCode: error?.message || 'UNKNOWN'
    });
    return json({ ok: false, code: safe.code }, safe.status);
  }
};

export const config = {
  path: '/api/patient-identity',
  method: ['GET', 'POST']
};
