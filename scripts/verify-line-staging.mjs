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
const idToken = String(process.env.STAGING_LINE_ID_TOKEN || '').trim();
if (idToken.length < 100 || idToken.length > 4096) throw new Error('A current dedicated-test LINE ID token is required');

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

const capability = await fetch(endpoint, { headers: { Accept: 'application/json' } }).then(response => response.json());
assert.equal(capability.enabled, true, 'LINE patient identity is not enabled on staging');
assert.equal(capability.digitalOptional, true, 'manual HN fallback must remain enabled');
assert.equal(capability.qrTtlSeconds, 90, 'QR TTL changed without E2E contract update');

// Recover safely from a previous interrupted run of the same dedicated LINE
// test account. Human/non-synthetic links are never touched.
const existing = await identity({ action: 'status' });
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
  consentConfirmed: true
});
assert.equal(linked.ok, true, 'LINE link callback failed');
const status = await identity({ action: 'status' });
assert.equal(status.linked.some(item => (item.patientId || item.patient_id) === patient.id), true, 'linked patient missing from LINE status');

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

const evidence = {
  schemaVersion: 1,
  evidenceType: 'real_line_identity_and_hybrid_hn_staging',
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
  consentLinkPassed: true,
  qrIssueAndResolvePassed: true,
  encounterId: confirmed.encounter_id,
  replayDenied: true,
  expiryDenied: true,
  revokePassed: true,
  manualHnFallbackEncounterId: manual.encounter_id
};
const evidencePath = writeEvidence('line-hybrid-identity.json', evidence);
process.stdout.write(`Real LINE + QR + HN fallback staging E2E passed; evidence: ${evidencePath}\n`);
