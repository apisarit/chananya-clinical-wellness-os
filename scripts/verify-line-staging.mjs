import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadStagingCredentials,
  loadStagingTarget,
  requestJson,
  rpc,
  signInStagingRole,
  sourceCommit,
  supabaseUrl,
  writeEvidence
} from './staging-support.mjs';

if (process.env.STAGING_LINE_E2E_ACK !== 'DEDICATED_TEST_LINE_ACCOUNT') {
  throw new Error('STAGING_LINE_E2E_ACK=DEDICATED_TEST_LINE_ACCOUNT is required');
}
if (process.env.STAGING_LINE_OA_E2E_ACK !== 'DEDICATED_STAGING_OA_AND_SYNTHETIC_PUSH') {
  throw new Error('STAGING_LINE_OA_E2E_ACK=DEDICATED_STAGING_OA_AND_SYNTHETIC_PUSH is required');
}
const idToken = String(process.env.STAGING_LINE_ID_TOKEN || '').trim();
if (idToken.length < 100 || idToken.length > 4096) throw new Error('A current dedicated-test LINE ID token is required');
const lineAccessToken = String(process.env.STAGING_LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || '').trim();
if (lineAccessToken.length < 40 || lineAccessToken.length > 4096) {
  throw new Error('A protected staging Messaging API channel access token is required');
}

const target = loadStagingTarget();
const credentials = loadStagingCredentials();
const practitioner = await signInStagingRole(target, 'practitioner');
const reception = await signInStagingRole(target, 'reception');
const first = value => Array.isArray(value) ? value[0] : value;
const endpoint = `${target.siteUrl}/api/patient-identity`;
const origin = new URL(target.siteUrl).origin;
const runId = String(process.env.STAGING_LINE_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`)
  .replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20);

async function identity(body, expected = [200]) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, idToken })
  });
  const payload = await response.json().catch(() => null);
  assert.ok(expected.includes(response.status), `patient identity endpoint returned HTTP ${response.status}: ${payload?.code || 'unknown'}`);
  return payload;
}

async function serviceRequest(resource, options = {}) {
  return requestJson(supabaseUrl(target, resource), {
    key: credentials.serviceRoleKey,
    bearer: credentials.serviceRoleKey,
    ...options
  });
}

async function lineApi(resource, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.line.me${resource}`, {
    method,
    headers: {
      Authorization: `Bearer ${lineAccessToken}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.ok, true, `LINE API ${resource} returned HTTP ${response.status}`);
  return payload;
}

function lineSubjectFromVerifiedToken(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'LINE ID token is not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.match(String(payload.sub || ''), /^U[0-9a-f]{32}$/i, 'LINE ID token subject is invalid');
  return payload.sub;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForBookedPush(appointmentId, timeoutMs = 7 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = await serviceRequest(
      `/rest/v1/line_oa_notification_outbox?select=id,status,retry_key,line_request_id,attempt_count,last_error_code&appointment_id=eq.${appointmentId}&notification_type=eq.APPOINTMENT_BOOKED&limit=1`
    );
    const notification = rows[0];
    if (notification?.status === 'sent') return notification;
    if (notification?.status === 'dead') {
      throw new Error(`LINE OA booked push reached dead letter: ${notification.last_error_code || 'unknown'}`);
    }
    await delay(15_000);
  }
  throw new Error('LINE OA booked push was not sent by the published staging scheduler within seven minutes');
}

const capability = await fetch(endpoint, { headers: { Accept: 'application/json' } }).then(response => response.json());
assert.equal(capability.enabled, true, 'LINE patient identity is not enabled on staging');
assert.equal(capability.digitalOptional, true, 'manual HN fallback must remain enabled');
assert.equal(capability.qrTtlSeconds, 90, 'QR TTL changed without E2E contract update');
assert.equal(capability.operationalMessagingAvailable, true, 'LINE OA operational messaging is not fully configured on staging');

const expectedWebhookEndpoint = `${target.siteUrl}/api/line/webhook`;
const webhookConfiguration = await lineApi('/v2/bot/channel/webhook/endpoint');
assert.equal(webhookConfiguration.active, true, 'LINE webhook use is not enabled');
assert.equal(webhookConfiguration.endpoint, expectedWebhookEndpoint, 'LINE channel points to a different webhook endpoint');
const webhookTest = await lineApi('/v2/bot/channel/webhook/test', { method: 'POST', body: {} });
assert.equal(webhookTest.success, true, `LINE could not reach the staging webhook: ${webhookTest.reason || 'unknown'}`);
assert.equal(webhookTest.statusCode, 200, 'staging webhook did not return HTTP 200 to LINE');
const botInfo = await lineApi('/v2/bot/info');
assert.match(String(botInfo.userId || ''), /^U[0-9a-f]{32}$/i, 'Messaging API bot identity is invalid');

// Recover safely from a previous interrupted run of the same dedicated LINE
// test account. Human/non-synthetic links are never touched.
const existing = await identity({ action: 'status' });
const lineSubject = lineSubjectFromVerifiedToken(idToken);
const lineProfile = await lineApi(`/v2/bot/profile/${encodeURIComponent(lineSubject)}`);
assert.equal(lineProfile.userId, lineSubject, 'LINE Login and Messaging API do not resolve the same test account');
for (const linked of existing.linked || []) {
  if (!String(linked.displayName || linked.display_name || '').includes('LINEE2E')) continue;
  const links = await rpc(target, practitioner.session.access_token, 'list_patient_identity_links', {
    p_patient_id: linked.patientId || linked.patient_id
  });
  for (const link of links.filter(item => item.status === 'active')) {
    await rpc(target, practitioner.session.access_token, 'revoke_patient_identity_link', {
      p_link_id: link.link_id,
      p_reason: 'Clean interrupted synthetic LINE staging run'
    });
  }
}

const patient = first(await rpc(target, reception.session.access_token, 'upsert_patient_registration', {
  p_patient_id: null,
  p_prefix: 'คุณ',
  p_first_name: `LINEE2E${runId.slice(-6)}`,
  p_last_name: 'SYNTHETIC',
  p_national_id: null,
  p_gender: 'other',
  p_date_of_birth: '1990-01-01',
  p_phone: null,
  p_address: 'Synthetic isolated staging only',
  p_payment_right: 'STAGING-LINE-E2E',
  p_emergency_contact_name: null,
  p_allergy: 'ไม่มี — ข้อมูลสังเคราะห์'
}));
assert.ok(patient?.id && patient?.hn, 'synthetic LINE patient registration failed');

const issuedLink = first(await rpc(target, reception.session.access_token, 'issue_patient_line_link_code', {
  p_patient_id: patient.id,
  p_link_type: 'self',
  p_relation_label: null,
  p_consent_confirmed: true
}));
assert.match(issuedLink.link_code, /^[0-9A-F]{12}$/);

const linked = await identity({
  action: 'link',
  linkCode: issuedLink.link_code,
  consentConfirmed: true,
  operationalMessagingConsent: true
});
assert.equal(linked.ok, true, 'LINE link callback failed');
const status = await identity({ action: 'status' });
const linkedProfile = status.linked.find(item => (item.patientId || item.patient_id) === patient.id);
assert.ok(linkedProfile, 'linked patient missing from LINE status');
assert.equal(linkedProfile.operational_messaging_enabled, true, 'operational-message consent was not recorded independently');

const identityLinks = await serviceRequest(
  `/rest/v1/patient_identity_links?select=id,subject_hash&patient_id=eq.${patient.id}&status=eq.active&limit=1`
);
assert.equal(identityLinks.length, 1, 'active LINE identity link was not found for OA verification');
const subjectHash = identityLinks[0].subject_hash;
assert.match(subjectHash, /^[0-9a-f]{64}$/, 'LINE subject hash is invalid');
const contacts = await serviceRequest(
  `/rest/v1/line_oa_contacts?select=id,friend_status,user_id_ciphertext,user_id_iv,user_id_auth_tag,encryption_key_id,environment,last_interaction_at&clinic_id=eq.${target.config.tenant.expectedClinicId}&environment=eq.staging&subject_hash=eq.${subjectHash}&limit=1`
);
assert.equal(contacts.length, 1, 'No signed follow/message contact exists; message the staging OA from the dedicated test account, then rerun');
const lineContact = contacts[0];
assert.ok(['active', 'messaged'].includes(lineContact.friend_status), 'dedicated LINE test account is blocked or inactive');
if (lineContact.friend_status === 'messaged') {
  assert.ok(
    Date.now() - Date.parse(lineContact.last_interaction_at) <= 7 * 24 * 60 * 60_000,
    'dedicated test account must message the staging OA again before the push test'
  );
}
assert.ok(lineContact.user_id_ciphertext && lineContact.user_id_iv && lineContact.user_id_auth_tag, 'LINE recipient was not encrypted');
assert.doesNotMatch(JSON.stringify(lineContact), new RegExp(lineSubject), 'raw LINE user ID leaked into the contact row');

const scheduledStart = new Date(Date.now() + 48 * 60 * 60_000);
const scheduledEnd = new Date(scheduledStart.getTime() + 30 * 60_000);
const schedule = first(await serviceRequest('/rest/v1/practitioner_schedules?select=*', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: {
    practitioner_id: practitioner.session.user.id,
    branch_code: 'LINE-E2E',
    room_code: 'SYNTHETIC',
    title: `LINE OA ${runId}`,
    starts_at: scheduledStart.toISOString(),
    ends_at: scheduledEnd.toISOString(),
    slot_minutes: 30,
    max_patients: 1,
    booking_status: 'open',
    notes: 'Synthetic isolated staging LINE OA push verification',
    created_by: practitioner.session.user.id
  }
}));
assert.ok(schedule?.id, 'synthetic LINE OA appointment schedule was not created');
const appointment = first(await rpc(target, reception.session.access_token, 'book_clinic_appointment', {
  p_patient_id: patient.id,
  p_schedule_id: schedule.id,
  p_chief_complaint: null,
  p_notes: 'Synthetic isolated staging LINE OA push verification',
  p_booking_source: 'staff'
}));
assert.ok(appointment?.id, 'synthetic LINE OA appointment was not booked');
const bookedPush = await waitForBookedPush(appointment.id);
assert.match(String(bookedPush.retry_key || ''), /^[0-9a-f-]{36}$/i, 'booked push has no stable retry key');
assert.ok(bookedPush.line_request_id, 'LINE did not return a request ID for the booked push');
const bookedDelivery = await serviceRequest(
  `/rest/v1/line_oa_delivery_events?select=id,outcome,attempt_no,http_status,line_request_id&notification_id=eq.${bookedPush.id}&outcome=eq.sent&limit=1`
);
assert.equal(bookedDelivery.length, 1, 'sent LINE push has no append-only delivery evidence');

await identity({ action: 'preferences', patientId: patient.id, enabled: false });
const withdrawnStatus = await identity({ action: 'status' });
assert.equal(
  withdrawnStatus.linked.find(item => (item.patientId || item.patient_id) === patient.id)?.operational_messaging_enabled,
  false,
  'explicit operational-message withdrawal was not reflected'
);
await identity({ action: 'preferences', patientId: patient.id, enabled: true });
const reconsentedStatus = await identity({ action: 'status' });
assert.equal(
  reconsentedStatus.linked.find(item => (item.patientId || item.patient_id) === patient.id)?.operational_messaging_enabled,
  true,
  'operational-message re-consent did not reactivate the current reminder'
);

const firstCard = await identity({ action: 'card', patientId: patient.id });
assert.equal(firstCard.ok, true);
assert.match(firstCard.card.displayCode, /^\d{6}$/);
assert.match(firstCard.card.qrDataUrl, /^data:image\/png;base64,/);
const resolved = first(await rpc(target, practitioner.session.access_token, 'resolve_patient_qr', {
  p_token: null,
  p_display_code: firstCard.card.displayCode
}));
assert.equal(resolved.patient_id, patient.id, 'practitioner resolved the wrong LINE patient');
const confirmed = first(await rpc(target, practitioner.session.access_token, 'confirm_patient_qr', {
  p_qr_session_id: resolved.qr_session_id,
  p_patient_present_confirmed: true,
  p_chief_complaint: 'Synthetic LINE staging verification',
  p_intake: { synthetic_only: true, staging_line_run_id: runId }
}));
assert.ok(confirmed?.encounter_id, 'LINE-confirmed encounter was not created');
const replay = await rpc(target, practitioner.session.access_token, 'resolve_patient_qr', {
  p_token: null,
  p_display_code: firstCard.card.displayCode
});
assert.equal(replay.length, 0, 'used LINE credential was accepted again');

const expiryCard = await identity({ action: 'card', patientId: patient.id });
const displayCodeHash = createHash('sha256').update(expiryCard.card.displayCode).digest('hex');
const sessions = await serviceRequest(`/rest/v1/patient_qr_sessions?select=id,created_at&patient_id=eq.${patient.id}&display_code_hash=eq.${displayCodeHash}&order=created_at.desc&limit=1`);
assert.equal(sessions.length, 1, 'expiry-test QR session was not found');
const forcedExpiry = new Date(Date.parse(sessions[0].created_at) + 1).toISOString();
await serviceRequest(`/rest/v1/patient_qr_sessions?id=eq.${sessions[0].id}`, {
  method: 'PATCH',
  headers: { Prefer: 'return=minimal' },
  body: { expires_at: forcedExpiry },
  expected: [200, 204]
});
const expired = await rpc(target, practitioner.session.access_token, 'resolve_patient_qr', {
  p_token: null,
  p_display_code: expiryCard.card.displayCode
});
assert.equal(expired.length, 0, 'expired LINE credential was accepted');

const manual = first(await rpc(target, reception.session.access_token, 'start_manual_patient_encounter', {
  p_patient_id: patient.id,
  p_verification_method: 'manual_hn',
  p_patient_present_confirmed: true,
  p_verification_note: 'No-phone fallback in real LINE staging E2E',
  p_chief_complaint: 'Synthetic HN fallback verification',
  p_intake: { synthetic_only: true, staging_line_run_id: runId }
}));
assert.ok(manual?.encounter_id, 'manual HN fallback failed');

const patientLinks = await rpc(target, practitioner.session.access_token, 'list_patient_identity_links', {
  p_patient_id: patient.id
});
const activeLink = patientLinks.find(item => item.status === 'active');
assert.ok(activeLink?.link_id, 'active LINE link missing before revoke');
await rpc(target, practitioner.session.access_token, 'revoke_patient_identity_link', {
  p_link_id: activeLink.link_id,
  p_reason: 'Complete synthetic LINE staging revoke test'
});
const revokedStatus = await identity({ action: 'status' });
assert.equal(revokedStatus.linked.some(item => (item.patientId || item.patient_id) === patient.id), false, 'revoked LINE link remained active');
const revokedPreferences = await serviceRequest(
  `/rest/v1/line_oa_notification_preferences?select=operational_enabled,appointment_reminders_enabled,withdrawn_at&identity_link_id=eq.${activeLink.link_id}&limit=1`
);
assert.equal(revokedPreferences.length, 1, 'LINE OA preference disappeared during identity revoke');
assert.equal(revokedPreferences[0].operational_enabled, false, 'identity revoke did not withdraw operational messaging');
assert.ok(revokedPreferences[0].withdrawn_at, 'identity revoke has no withdrawal timestamp');
const revokedReminders = await serviceRequest(
  `/rest/v1/line_oa_notification_outbox?select=id,status&appointment_id=eq.${appointment.id}&notification_type=eq.APPOINTMENT_REMINDER`
);
assert.ok(revokedReminders.length > 0, 'appointment reminder was not queued for revoke verification');
assert.equal(revokedReminders.every(item => item.status === 'cancelled'), true, 'identity revoke did not cancel every pending reminder');

const evidence = {
  schemaVersion: 2,
  evidenceType: 'real_line_oa_identity_push_and_hybrid_hn_staging',
  syntheticOnly: true,
  sourceCommit: sourceCommit(),
  generatedAt: new Date().toISOString(),
  deploymentId: target.config.deploymentId,
  siteOrigin: target.siteUrl,
  clinicId: target.config.tenant.expectedClinicId,
  runId,
  patientId: patient.id,
  hn: patient.hn,
  lineTokenVerifiedByOfficialEndpoint: true,
  messagingApiProfileMatched: true,
  officialWebhookEndpoint: expectedWebhookEndpoint,
  officialWebhookTestPassed: true,
  encryptedContactId: lineContact.id,
  consentLinkPassed: true,
  operationalConsentPassed: true,
  explicitOperationalWithdrawalPassed: true,
  operationalReconsentPassed: true,
  appointmentId: appointment.id,
  bookedNotificationId: bookedPush.id,
  bookedDeliveryId: bookedDelivery[0].id,
  bookedPushAttemptCount: bookedPush.attempt_count,
  qrIssueAndResolvePassed: true,
  encounterId: confirmed.encounter_id,
  replayDenied: true,
  expiryDenied: true,
  revokePassed: true,
  revokeCancelledReminder: true,
  manualHnFallbackEncounterId: manual.encounter_id
};
const evidencePath = writeEvidence('line-hybrid-identity.json', evidence);
process.stdout.write(`Real LINE OA + QR + HN fallback staging E2E passed; evidence: ${evidencePath}\n`);
