import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sql = read('supabase/migrations/202608291800_line_oa_operational_messaging.sql');
const webhook = read('netlify/functions/line-oa-webhook.mts');
const dispatcher = read('netlify/functions/line-oa-dispatch.mts');
const patientBackend = read('netlify/functions/patient-identity.mts');
const patientHtml = read('patient-card.html');
const patientJs = read('patient-card.js');
const env = read('.env.example');

assert.match(sql, /^begin;/m);
assert.match(sql, /^commit;/m);
for (const table of [
  'line_oa_contacts',
  'line_oa_notification_preferences',
  'line_oa_webhook_events',
  'line_oa_notification_outbox',
  'line_oa_delivery_events'
]) {
  assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'), `${table} must exist`);
  assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'), `${table} must enable RLS`);
  assert.match(sql, new RegExp(`revoke all on public\\.${table} from public,anon,authenticated`, 'i'), `${table} must fail closed to browsers`);
}
assert.match(sql, /user_id_ciphertext text/i);
assert.match(sql, /friend_status='blocked'[\s\S]*?user_id_ciphertext is null/i);
assert.match(sql, /last_event_at timestamptz not null/i);
assert.match(sql, /line_oa_contacts\.last_event_at<excluded\.last_event_at/i, 'stale redelivery must not reverse contact state');
assert.doesNotMatch(sql, /\bline_user_id\b|\buser_id_plaintext\b/i);
assert.match(sql, /metadata \?\| array\['text','message','replyToken'/i, 'stored webhook metadata must reject chat text and credentials');
assert.match(sql, /marketing_enabled boolean not null default false check \(not marketing_enabled\)/i);
assert.match(sql, /consent_version text not null default 'line-oa-operational-v1'/i);
assert.match(sql, /LINE_OA_OPERATIONAL_CONSENT_GRANTED/);
assert.match(sql, /LINE_OA_OPERATIONAL_CONSENT_WITHDRAWN/);
assert.match(sql, /LINE_OA_OPERATIONAL_CONSENT_DECLINED/);
assert.match(sql, /complete_patient_line_link_with_oa_consent/);
assert.match(sql, /LINE_OA_CLINIC_MISMATCH/);
assert.match(sql, /l\.clinic_id=p_clinic_id/, 'operational consent must be bound to the configured clinic');
assert.match(sql, /trg_withdraw_line_oa_on_identity_revoke/);
assert.match(sql, /'reason','oa_blocked'/, 'blocking the OA must withdraw operational messaging');
assert.match(sql, /unique \(clinic_id,environment,deployment_id,channel_hash,webhook_event_id\)/i);
assert.match(sql, /for update of o skip locked/i);
assert.match(sql, /retry_key uuid not null default gen_random_uuid\(\)/i);
assert.match(sql, /APPOINTMENT_REMINDER/);
assert.match(sql, /trg_enqueue_line_oa_from_appointment/);
assert.match(sql, /line_oa_delivery_events_append_only/);
assert.match(sql, /export_clinic_backup_domain_v20260828/);
assert.match(sql, /'2026-08-29\.1'/);
assert.match(sql, /chat_text_persisted',false/);

assert.match(webhook, /verifyLineWebhookSignature\(rawBody[\s\S]*?parseWebhookBody\(rawBody\)/, 'signature must be verified before JSON parsing');
assert.match(webhook, /hmacSha256\(event\.userId/);
assert.match(webhook, /encryptLineUserId/);
assert.match(webhook, /claim_line_oa_webhook_event/);
assert.match(webhook, /finish_line_oa_webhook_event/);
assert.match(webhook, /path: '\/api\/line\/webhook'/);
assert.doesNotMatch(webhook, /console\.(?:log|error)\([^\n]*(?:rawBody|replyToken|userId|accessToken)/, 'webhook logs must not contain credentials or raw messages');

assert.match(dispatcher, /claim_line_oa_notification_batch/);
assert.match(dispatcher, /decryptLineUserId/);
assert.match(dispatcher, /sendLinePush/);
assert.match(dispatcher, /finish_line_oa_notification/);
assert.match(dispatcher, /schedule: '\*\/5 \* \* \* \*'/);
assert.doesNotMatch(dispatcher, /console\.(?:log|error)\([^\n]*(?:ciphertext|user_id|accessToken)/, 'dispatcher logs must not contain recipient data');

assert.match(patientBackend, /set_line_oa_notification_preference_for_subject/);
assert.match(patientBackend, /complete_patient_line_link_with_oa_consent/);
assert.match(patientBackend, /list_line_oa_notification_preferences_for_subject/);
assert.match(patientHtml, /patient-notification-consent/);
assert.match(patientHtml, /ไม่รวมโฆษณา/);
assert.match(patientHtml, /ถอนความยินยอม/);
assert.match(patientJs, /action, idToken/);
assert.match(patientJs, /api\('preferences'/);
assert.doesNotMatch(patientJs, /localStorage|sessionStorage/);

for (const variable of [
  'LINE_OA_ENABLED','LINE_OA_ENVIRONMENT','LINE_OA_ACTIVATION_ACK',
  'LINE_MESSAGING_CHANNEL_SECRET','LINE_MESSAGING_CHANNEL_ACCESS_TOKEN',
  'LINE_OA_ENCRYPTION_KEY_BASE64','LINE_OA_ENCRYPTION_KEY_ID'
]) assert.match(env, new RegExp(`^${variable}=`, 'm'), `${variable} missing from environment contract`);

for (const source of [webhook, dispatcher]) {
  const stripped = source.replace(/^import[\s\S]*?from '[^']+';\n/gm, '');
  assert.doesNotThrow(() => new vm.Script(stripped.replace(/export default async\s*\(/, 'const handler = async (').replace(/export const config\s*=/, 'const config ='), {
    filename: 'line-oa-function.mts'
  }));
}

console.log('LINE OA contracts passed: consent, signature-first webhook, encrypted recipients, dedupe, outbox, retry and Drive audit coverage');
