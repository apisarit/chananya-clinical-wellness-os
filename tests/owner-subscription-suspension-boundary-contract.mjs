import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const db = new PGlite();

const pgliteBootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to authenticated, service_role;
  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (
      substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||
      '-a'||substr(x,18,3)||'-'||substr(x,21,12)
    )::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(
      substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2),
      'hex'
    )
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`;
await db.exec(pgliteBootstrap);

const migrationFiles = (await fs.readdir(migrationsDir))
  .filter(file => file.endsWith('.sql'))
  .sort();

for (const file of migrationFiles) {
  if (file === '202608270300_hybrid_patient_identity.sql') {
    await db.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('11111111-1111-4111-a111-111111111111','a@example.test','{"full_name":"Practitioner A"}'),
        ('22222222-2222-4222-a222-222222222222','b@example.test','{"full_name":"Practitioner B"}'),
        ('44444444-4444-4444-a444-444444444444','c@example.test','{"full_name":"Platform Support"}');
      update public.profiles
      set role='practitioner', system_role='staff'
      where id in (
        '11111111-1111-4111-a111-111111111111',
        '22222222-2222-4222-a222-222222222222'
      );
      update public.profiles
      set role='viewer', system_role='super_admin'
      where id='44444444-4444-4444-a444-444444444444';
      insert into public.patients(hn,prefix,first_name,last_name,created_by)
      values (
        'CHANANYA-00009999','นาย','ข้อมูล','เดิม',
        '11111111-1111-4111-a111-111111111111'
      );
    `);
  }
  const source = await fs.readFile(path.join(migrationsDir, file), 'utf8');
  await db.exec(source.replace(/create extension if not exists pgcrypto\s*;/gi, ''));
}

const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';
const OWNER = '44444444-4444-4444-a444-444444444444';
const CLINIC_A = '00000000-0000-0000-0000-000000000001';
const CLINIC_B = '33333333-3333-4333-a333-333333333333';
const SUBJECT_HASH = 'a'.repeat(64);
const CHANNEL_HASH = 'b'.repeat(64);

async function asUser(userId, sql) {
  await db.exec(`
    reset role;
    select
      set_config('request.jwt.claim.sub','${userId}',false),
      set_config('request.jwt.claim.role','authenticated',false);
    set role authenticated;
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

async function asService(sql) {
  await db.exec(`
    reset role;
    select
      set_config('request.jwt.claim.sub','',false),
      set_config('request.jwt.claim.role','service_role',false);
    set role service_role;
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

async function asDatabaseOwnerWithServiceClaim(sql) {
  await db.exec(`
    reset role;
    select
      set_config('request.jwt.claim.sub','',false),
      set_config('request.jwt.claim.role','service_role',false);
  `);
  return db.query(sql);
}

async function expectDatabaseError(promise, code) {
  await assert.rejects(promise, error => String(error.message).includes(code));
}

// Build two active tenants under trusted service request context. The exact
// tenant write triggers intentionally reject owner setup that inherits a stale
// authenticated JWT claim.
await asDatabaseOwnerWithServiceClaim('select true');
await db.exec(`
  update public.profiles set role='reception',system_role='admin' where id='${USER_A}';
  update public.clinic_memberships
  set clinic_role='admin',is_primary=true,active=true
  where clinic_id='${CLINIC_A}' and profile_id='${USER_A}';

  insert into public.clinics(id,code,name_th,name_en)
  values('${CLINIC_B}','SECOND','คลินิกที่สอง','Second Clinic');
  delete from public.clinic_memberships
  where clinic_id='${CLINIC_A}' and profile_id='${USER_B}';
  update public.profiles set role='reception',system_role='admin' where id='${USER_B}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
  values('${CLINIC_B}','${USER_B}','admin',true,true);
`);

const patientA = (await db.query(`
  select id from public.patients where hn='CHANANYA-00009999'
`)).rows[0].id;
const patientB = (await asDatabaseOwnerWithServiceClaim(`
  insert into public.patients(
    clinic_id,hn,prefix,first_name,last_name,created_by
  ) values (
    '${CLINIC_B}','SECOND-00000001','นาย','ผู้รับบริการ','คลินิกสอง','${USER_B}'
  ) returning id
`)).rows[0].id;

const scheduleA = (await asDatabaseOwnerWithServiceClaim(`
  insert into public.practitioner_schedules(
    clinic_id,practitioner_id,title,starts_at,ends_at,max_patients,
    booking_status,created_by
  ) values (
    '${CLINIC_A}','${USER_A}','A schedule',now()+interval '2 days',
    now()+interval '2 days 1 hour',4,'open','${USER_A}'
  ) returning id
`)).rows[0].id;
const scheduleB = (await asDatabaseOwnerWithServiceClaim(`
  insert into public.practitioner_schedules(
    clinic_id,practitioner_id,title,starts_at,ends_at,max_patients,
    booking_status,created_by
  ) values (
    '${CLINIC_B}','${USER_B}','B schedule',now()+interval '3 days',
    now()+interval '3 days 1 hour',4,'open','${USER_B}'
  ) returning id
`)).rows[0].id;

const appointmentA = (await asUser(USER_A, `
  select (public.book_clinic_appointment(
    '${patientA}','${scheduleA}','test','active tenant booking','staff'
  )).id id
`)).rows[0].id;
const appointmentB = (await asUser(USER_B, `
  select (public.book_clinic_appointment(
    '${patientB}','${scheduleB}','test','second tenant booking','staff'
  )).id id
`)).rows[0].id;

const approvalA = (await asUser(USER_A, `
  select public.create_approval_task(
    'clinical_review','clinical','Tenant A review',null,'normal',
    'clinic_appointments','${appointmentA}',null,'{}'::jsonb
  ) id
`)).rows[0].id;
await asUser(USER_A, `
  select (public.decide_approval_task('${approvalA}','take','Assigned')).id
`);
await assert.rejects(asUser(USER_A, `
  insert into public.approval_tasks(
    clinic_id,task_no,task_type,module,title,requested_by
  ) values (
    '${CLINIC_A}','AT-FORGED','forged','clinical','Forged task','${USER_A}'
  )
`));
await assert.rejects(asUser(USER_A, `
  update public.approval_tasks set status='approved' where id='${approvalA}'
`));
await assert.rejects(asUser(USER_A, `
  insert into public.approval_actions(
    clinic_id,task_id,action,from_status,to_status,action_by
  ) values (
    '${CLINIC_A}','${approvalA}','approve','in_review','approved','${USER_A}'
  )
`));
const approvalB = (await asUser(USER_B, `
  select public.create_approval_task(
    'clinical_review','clinical','Tenant B review',null,'normal',
    'clinic_appointments','${appointmentB}',null,'{}'::jsonb
  ) id
`)).rows[0].id;

// Clinical sign-off SECURITY DEFINER routines must bind the encounter to the
// caller's exact clinic rather than trusting a role-only check.
await asDatabaseOwnerWithServiceClaim(`
  update public.profiles
  set role='practitioner',system_role='staff'
  where id='${USER_B}'
`);
await asDatabaseOwnerWithServiceClaim(`
  update public.clinic_memberships
  set clinic_role='practitioner'
  where clinic_id='${CLINIC_B}' and profile_id='${USER_B}'
`);
const encounterB = (await asDatabaseOwnerWithServiceClaim(`
  insert into public.encounters(
    clinic_id,encounter_no,patient_id,status,practitioner_id,created_by
  ) values (
    '${CLINIC_B}','ENC-SECOND-SIGNOFF','${patientB}','draft','${USER_B}','${USER_B}'
  ) returning id
`)).rows[0].id;
await asDatabaseOwnerWithServiceClaim(`
  insert into public.ttm_structured_diagnoses(
    encounter_id,analysis_summary,thai_diagnosis,diagnosed_by
  ) values (
    '${encounterB}','Synthetic tenant-isolation diagnosis','ทดสอบ','${USER_B}'
  )
`);
await asDatabaseOwnerWithServiceClaim(`
  insert into public.clinical_treatment_plans(
    encounter_id,plan_number,status,planned_by
  ) values ('${encounterB}','PLAN-SECOND-SIGNOFF','active','${USER_B}')
`);
const signoffB = (await asUser(USER_B, `
  select (public.sign_clinical_record_complete(
    '${encounterB}','Tenant B signer','TEST-LICENSE','Tenant B complete record'
  )).id id
`)).rows[0].id;
assert.ok(signoffB);
await asDatabaseOwnerWithServiceClaim(`
  update public.profiles set system_role='super_admin' where id='${USER_A}'
`);
await expectDatabaseError(
  asUser(USER_A, `select public.sign_clinical_record_complete('${encounterB}',null,null,'cross tenant')`),
  'ENCOUNTER_NOT_FOUND'
);
await expectDatabaseError(
  asUser(USER_A, `select public.unlock_clinical_record_for_amendment('${encounterB}','cross tenant attempt')`),
  'SIGNED_RECORD_NOT_FOUND'
);
await asDatabaseOwnerWithServiceClaim(`
  update public.profiles set system_role='admin' where id='${USER_A}'
`);
await assert.rejects(asService(`
  select public.sign_clinical_record_complete('${encounterB}',null,null,'service role denied')
`));
await assert.rejects(asService(`
  insert into public.patients(
    clinic_id,hn,prefix,first_name,last_name,created_by
  ) values (
    '${CLINIC_A}','FORGED-SERVICE-DML','นาย','ห้าม','เขียน','${USER_A}'
  )
`));

// Create realistic LINE identity/outbox state while active so OFF delivery and
// finalization tests target existing rows rather than no-op identifiers.
const linkCode = (await asUser(USER_A, `
  select link_code from public.issue_patient_line_link_code(
    '${patientA}','self',null,true
  )
`)).rows[0].link_code;
await asService(`
  select * from public.complete_patient_line_link_for_clinic(
    '${CLINIC_A}','${linkCode}','${SUBJECT_HASH}','line-test-channel',true
  )
`);
await asService(`
  select * from public.set_line_oa_notification_preference_for_subject(
    '${SUBJECT_HASH}','${patientA}','${CLINIC_A}','staging','test-deploy',
    '${CHANNEL_HASH}',true
  )
`);
const operationalWebhookId = 'event-before-suspension';
const activeWebhookClaim = await asService(`
  select * from public.claim_line_oa_webhook_event(
    '${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}',
    '${operationalWebhookId}','message',now(),false,'active','${SUBJECT_HASH}',
    'active','ciphertext','iv','tag','key-v1','{}'::jsonb
  )
`);
assert.equal(activeWebhookClaim.rows[0].claimed, true);
await asDatabaseOwnerWithServiceClaim(`
  select public.queue_line_oa_appointment_notification(
    '${appointmentA}','APPOINTMENT_BOOKED',now(),now()+interval '1 day',
    'finish-after-off-fixture'
  )
`);
const activeNotificationClaim = await asService(`
  select * from public.claim_line_oa_notification_batch(
    '${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}','worker-before-off',8
  )
`);
assert.equal(activeNotificationClaim.rows.length, 1);
const notificationA = activeNotificationClaim.rows[0].notification_id;

// Cross-tenant behavior remains denied while both subscriptions are active.
assert.equal((await asUser(USER_A, `
  select count(*)::int count from public.practitioner_schedules where id='${scheduleB}'
`)).rows[0].count, 0);
assert.equal((await asUser(USER_A, `
  select count(*)::int count from public.clinic_appointments where id='${appointmentB}'
`)).rows[0].count, 0);
assert.equal((await asUser(USER_A, `
  select count(*)::int count from public.appointment_events where appointment_id='${appointmentB}'
`)).rows[0].count, 0);
assert.equal((await asUser(USER_A, `
  select count(*)::int count from public.approval_tasks where id='${approvalB}'
`)).rows[0].count, 0);
await expectDatabaseError(
  asUser(USER_A, `select public.cancel_clinic_appointment('${appointmentB}','cross tenant')`),
  'APPOINTMENT_NOT_FOUND'
);
await expectDatabaseError(
  asUser(USER_A, `select public.decide_approval_task('${approvalB}','take','cross tenant')`),
  'APPROVAL_TASK_NOT_FOUND'
);

const activeVisibility = await asUser(USER_A, `
  select
    (select count(*)::int from public.profiles where id='${USER_A}') profile_rows,
    (select count(*)::int from public.clinic_memberships where profile_id='${USER_A}') membership_rows,
    (select count(*)::int from public.practitioner_schedules where id='${scheduleA}') schedule_rows,
    (select count(*)::int from public.clinic_appointments where id='${appointmentA}') appointment_rows,
    (select count(*)::int from public.appointment_events where appointment_id='${appointmentA}') event_rows,
    (select count(*)::int from public.approval_tasks where id='${approvalA}') approval_rows,
    (select count(*)::int from public.approval_actions where task_id='${approvalA}') action_rows,
    (select count(*)::int from public.sen_line_master) sen_rows,
    (select count(*)::int from public.v_ttm_foundation_graph) graph_rows
`);
for (const [name, count] of Object.entries(activeVisibility.rows[0])) {
  assert.ok(count > 0, `${name} fixture must be visible before suspension`);
}

const lineCounts = async () => (await db.query(`
  select
    (select count(*)::int from public.patient_identity_rate_limits) rate_limits,
    (select count(*)::int from public.patient_identity_link_requests) link_requests,
    (select count(*)::int from public.patient_identity_links) links,
    (select count(*)::int from public.patient_qr_sessions) qr_sessions,
    (select count(*)::int from public.patient_identity_events) identity_events,
    (select count(*)::int from public.line_oa_contacts) contacts,
    (select count(*)::int from public.line_oa_notification_preferences) preferences,
    (select count(*)::int from public.line_oa_webhook_events) operational_webhooks,
    (select count(*)::int from public.line_oa_notification_outbox) outbox,
    (select count(*)::int from public.line_oa_delivery_events) delivery_events,
    (select count(*)::int from public.line_oa_gateway_contact_states) gateway_contacts,
    (select count(*)::int from public.line_oa_gateway_webhook_events) gateway_events
`)).rows[0];
const beforeOffLineCounts = await lineCounts();

const offResult = (await asService(`
  select public.set_clinic_subscription_state(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','${CLINIC_A}','CHANANYA',false,1,
    'Focused suspension boundary test','${OWNER}','owner@example.test'
  ) result
`)).rows[0].result;
assert.equal(offResult.state, 'suspended');
assert.equal(Number(offResult.version), 2);

// Narrow cleanup/evidence exceptions: a row claimed while active can be
// finalized after a concurrent OFF, and consent can still be withdrawn. They
// make no external send and cannot create a new claim, link, queue or consent.
assert.equal((await asService(`
  select public.finish_line_oa_webhook_event(
    '${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}',
    '${operationalWebhookId}','processed',null,false
  ) finished
`)).rows[0].finished, true);
assert.equal((await asService(`
  select public.finish_line_oa_notification(
    '${notificationA}','worker-before-off','sent',200,null,'line-request-before-off'
  ) finished
`)).rows[0].finished, true);
const withdrawn = await asService(`
  select * from public.set_line_oa_notification_preference_for_subject(
    '${SUBJECT_HASH}','${patientA}','${CLINIC_A}','staging','test-deploy',
    '${CHANNEL_HASH}',false
  )
`);
assert.equal(withdrawn.rows[0].operational_messaging_enabled, false);
const cleanupState = await db.query(`
  select
    (select processing_status from public.line_oa_webhook_events
      where clinic_id='${CLINIC_A}' and webhook_event_id='${operationalWebhookId}') webhook_status,
    (select status from public.line_oa_notification_outbox where id='${notificationA}') notification_status,
    (select operational_enabled from public.line_oa_notification_preferences
      where clinic_id='${CLINIC_A}' and patient_id='${patientA}' limit 1) operational_enabled,
    (select count(*)::int from public.line_oa_delivery_events
      where notification_id='${notificationA}') delivery_evidence,
    (select count(*)::int from public.patient_identity_events
      where clinic_id='${CLINIC_A}' and event_type='LINE_OA_OPERATIONAL_CONSENT_WITHDRAWN') withdrawal_evidence
`);
assert.deepEqual(cleanupState.rows[0], {
  webhook_status: 'processed',
  notification_status: 'sent',
  operational_enabled: false,
  delivery_evidence: 1,
  withdrawal_evidence: 1
});

// The narrow exception is cleared before the wrapper returns, even when the
// caller keeps the outer SQL transaction open. It cannot authorize a later
// direct evidence-table mutation.
await db.exec(`
  reset role;
  select
    set_config('request.jwt.claim.sub','',false),
    set_config('request.jwt.claim.role','service_role',false);
  set role service_role;
  begin;
`);
try {
  await db.query(`
    select * from public.set_line_oa_notification_preference_for_subject(
      '${SUBJECT_HASH}','${patientA}','${CLINIC_A}','staging','test-deploy',
      '${CHANNEL_HASH}',false
    )
  `);
  const clearedCapability = await db.query(`
    select
      coalesce(current_setting('cnyos.subscription_off_exception',true),'') capability,
      coalesce(current_setting('cnyos.subscription_off_exception_clinic',true),'') clinic
  `);
  assert.deepEqual(clearedCapability.rows[0], { capability: '', clinic: '' });
  await expectDatabaseError(db.query(`
    insert into public.audit_logs(clinic_id,user_id,action,entity,metadata)
    values('${CLINIC_A}',null,'forged_after_cleanup','subscription','{}'::jsonb)
  `), 'CNYOS_SUBSCRIPTION_SUSPENDED');
} finally {
  await db.exec('rollback; reset role;');
}

// An existing authenticated session loses direct reads across patient-facing,
// metadata/master-data and legacy self-access policies without signing out.
const offVisibility = await asUser(USER_A, `
  select
    public.current_clinic_id() current_clinic,
    public.current_user_role() current_role,
    public.is_appointment_operator() appointment_operator,
    public.is_appointment_practitioner() appointment_practitioner,
    public.is_admin_or_super() approval_admin,
    (select count(*)::int from public.profiles) profile_rows,
    (select count(*)::int from public.clinic_memberships) membership_rows,
    (select count(*)::int from public.clinic_specialties) specialty_rows,
    (select count(*)::int from public.practitioner_specialties) practitioner_specialty_rows,
    (select count(*)::int from public.practitioner_schedules) schedule_rows,
    (select count(*)::int from public.clinic_appointments) appointment_rows,
    (select count(*)::int from public.appointment_events) event_rows,
    (select count(*)::int from public.approval_tasks) approval_rows,
    (select count(*)::int from public.approval_actions) action_rows,
    (select count(*)::int from public.audit_logs) audit_rows,
    (select count(*)::int from public.sen_line_master) sen_rows,
    (select count(*)::int from public.ttm_concepts) ttm_rows,
    (select count(*)::int from public.v_ttm_foundation_graph) graph_rows,
    (select count(*)::int from public.v_ttm_foundation_coverage) coverage_rows,
    (select count(*)::int from public.v_clinical_herbal_traceability) trace_rows,
    (select count(*)::int from public.available_practitioner_schedules) available_rows,
    (select count(*)::int from public.admin_task_summary) task_summary_rows,
    (select count(*)::int from public.clinical_financial_handoffs_healthcheck()) handoff_health_rows,
    (select count(*)::int from public.department_persistence_healthcheck()) persistence_health_rows,
    (select count(*)::int from public.production_execution_healthcheck()) production_health_rows,
    (select count(*)::int from public.quality_release_healthcheck()) quality_health_rows,
    (select count(*)::int from public.prescription_dispensing_healthcheck()) dispensing_health_rows
`);
const off = offVisibility.rows[0];
assert.equal(off.current_clinic, null);
assert.equal(off.current_role, 'viewer');
assert.equal(off.appointment_operator, false);
assert.equal(off.appointment_practitioner, false);
assert.equal(off.approval_admin, false);
for (const [name, count] of Object.entries(off)) {
  if (name.endsWith('_rows')) assert.equal(count, 0, `${name} must be hidden while OFF`);
}

// Trusted migration/restore maintenance has no request JWT and remains able to
// repair a suspended tenant. The same direct mutation through the service key
// is still rejected by the subscription row lock.
await db.exec(`
  reset role;
  select
    set_config('request.jwt.claim.sub','',false),
    set_config('request.jwt.claim.role','',false);
  update public.clinic_memberships
  set updated_at=updated_at
  where clinic_id='${CLINIC_A}' and profile_id='${USER_A}';
`);
await expectDatabaseError(asService(`
  update public.clinic_memberships
  set updated_at=updated_at
  where clinic_id='${CLINIC_A}' and profile_id='${USER_A}'
`), 'CNYOS_SUBSCRIPTION_SUSPENDED');

// The explicit global profile provisioning exception cannot manufacture an
// active tenant while the authoritative clinic subscription remains OFF.
await asService(`
  update public.profiles
  set role='admin',system_role='super_admin'
  where id='${USER_A}'
`);
const offAfterProfileEdit = await asUser(USER_A, `
  select public.current_clinic_id() current_clinic,
    (select count(*)::int from public.profiles) profile_rows,
    (select count(*)::int from public.clinic_appointments) appointment_rows
`);
assert.deepEqual(offAfterProfileEdit.rows[0], {
  current_clinic: null,
  profile_rows: 0,
  appointment_rows: 0
});
await asService(`
  update public.profiles
  set role='reception',system_role='admin'
  where id='${USER_A}'
`);

for (const [promise, code] of [
  [asUser(USER_A, `select public.book_clinic_appointment('${patientA}','${scheduleA}',null,null,'staff')`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.cancel_clinic_appointment('${appointmentA}','suspended')`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.set_clinic_appointment_status('${appointmentA}','confirmed',null)`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.create_approval_task('test','test','suspended')`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.decide_approval_task('${approvalA}','approve','suspended')`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.sign_clinical_record_complete('${encounterB}',null,null,'suspended')`), 'CNYOS_SUBSCRIPTION_SUSPENDED'],
  [asUser(USER_A, `select public.unlock_clinical_record_for_amendment('${encounterB}','suspended attempt')`), 'CNYOS_SUBSCRIPTION_SUSPENDED']
]) await expectDatabaseError(promise, code);

await assert.rejects(asUser(USER_A, `
  insert into public.practitioner_schedules(
    clinic_id,practitioner_id,title,starts_at,ends_at,created_by
  ) values (
    '${CLINIC_A}','${USER_A}','blocked',now()+interval '1 day',
    now()+interval '1 day 1 hour','${USER_A}'
  )
`));
await assert.rejects(asUser(USER_A, `
  insert into public.audit_logs(clinic_id,user_id,action,entity,metadata)
  values('${CLINIC_A}','${USER_A}','forged','subscription','{}'::jsonb)
`));

// Every Netlify-granted LINE write/read/claim/send path checks subscription
// before input lookup. Failed OFF requests leave tenant and gateway rows exact.
const afterAllowedCleanupLineCounts = await lineCounts();
const suspendedServiceCalls = [
  `select public.assert_clinic_subscription_active('${CLINIC_A}')`,
  `select public.consume_patient_identity_rate_limit_for_clinic('${CLINIC_A}','${'c'.repeat(64)}',1,60)`,
  `select * from public.complete_patient_line_link_for_clinic('${CLINIC_A}','BAD','${SUBJECT_HASH}','line',true)`,
  `select * from public.list_line_linked_patients_for_clinic('${CLINIC_A}','${SUBJECT_HASH}')`,
  `select * from public.issue_patient_qr_for_subject_in_clinic('${CLINIC_A}','${SUBJECT_HASH}','${patientA}','${'d'.repeat(64)}','${'e'.repeat(64)}',now()+interval '90 seconds')`,
  `select * from public.set_line_oa_notification_preference_for_subject('${SUBJECT_HASH}','${patientA}','${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}',true)`,
  `select * from public.complete_patient_line_link_with_oa_consent('BAD','${SUBJECT_HASH}','line',true,'${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}')`,
  `select * from public.list_line_oa_notification_preferences_for_subject('${SUBJECT_HASH}','${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}')`,
  `select * from public.claim_line_oa_webhook_event('${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}','event-off','message',now(),false,'active','${SUBJECT_HASH}','active','cipher','iv','tag','key','{}'::jsonb)`,
  `select * from public.claim_line_oa_notification_batch('${CLINIC_A}','staging','test-deploy','${CHANNEL_HASH}','worker-off',8)`,
  `select * from public.register_line_oa_webhook_event_for_clinic('${CLINIC_A}','${CHANNEL_HASH}','${'f'.repeat(64)}','${SUBJECT_HASH}','message','card',now(),false,'${'1'.repeat(64)}')`
];
for (const sql of suspendedServiceCalls) {
  await expectDatabaseError(asService(sql), 'CNYOS_SUBSCRIPTION_SUSPENDED');
}
assert.notDeepEqual(afterAllowedCleanupLineCounts, beforeOffLineCounts);
assert.deepEqual(await lineCounts(), afterAllowedCleanupLineCounts);

const onResult = (await asService(`
  select public.set_clinic_subscription_state(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','${CLINIC_A}','CHANANYA',true,2,
    'Focused reactivation boundary test','${OWNER}','owner@example.test'
  ) result
`)).rows[0].result;
assert.equal(onResult.state, 'active');
assert.equal(Number(onResult.version), 3);
assert.equal((await asUser(USER_A, `
  select count(*)::int count from public.clinic_appointments where id='${appointmentA}'
`)).rows[0].count, 1);

const browserDefiners = await db.query(`
  select
    p.proname function_name,
    pg_get_function_identity_arguments(p.oid) identity_arguments,
    t.typname return_type,
    p.prosrc source
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_type t on t.oid=p.prorettype
  where n.nspname='public'
    and p.prosecdef
    and t.typname not in ('trigger','event_trigger')
    and has_function_privilege('authenticated',p.oid,'EXECUTE')
  order by p.proname, pg_get_function_identity_arguments(p.oid)
`);

const authenticatedPolicies = await db.query(`
  select
    schemaname,
    tablename,
    policyname,
    cmd,
    qual,
    with_check
  from pg_policies
  where schemaname='public'
    and 'authenticated'=any(roles)
  order by tablename, policyname
`);

assert.ok(browserDefiners.rows.length > 0);
assert.ok(authenticatedPolicies.rows.length > 0);
const missingObviousGate = browserDefiners.rows.filter(row => !/current_clinic_id|subscription_state|is_clinic_member|department_can|has_role|can_access_|is_super_admin/i.test(row.source));
assert.deepEqual(
  missingObviousGate.map(row => row.function_name),
  [],
  'every browser-granted SECURITY DEFINER routine must include a subscription-aware gate'
);
const directTablesWithoutRls = await db.query(`
  select c.relname table_name
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('r','p')
    and not c.relrowsecurity
    and (
      has_table_privilege('authenticated',c.oid,'SELECT')
      or has_table_privilege('authenticated',c.oid,'INSERT')
      or has_table_privilege('authenticated',c.oid,'UPDATE')
      or has_table_privilege('authenticated',c.oid,'DELETE')
    )
  order by c.relname
`);
const browserViews = await db.query(`
  select c.relname view_name, coalesce(c.reloptions,'{}'::text[]) options
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('v','m')
    and has_table_privilege('authenticated',c.oid,'SELECT')
  order by c.relname
`);
assert.deepEqual(directTablesWithoutRls.rows, []);
for (const view of browserViews.rows) {
  assert.ok(
    view.options.includes('security_invoker=true'),
    `${view.view_name} must not execute with the view owner's RLS rights`
  );
}

const missingRestrictiveBoundary = await db.query(`
  select c.relname table_name
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('r','p')
    and c.relrowsecurity
    and (
      has_table_privilege('authenticated',c.oid,'SELECT')
      or has_table_privilege('authenticated',c.oid,'INSERT')
      or has_table_privilege('authenticated',c.oid,'UPDATE')
      or has_table_privilege('authenticated',c.oid,'DELETE')
    )
    and not exists (
      select 1 from pg_policy p
      where p.polrelid=c.oid
        and p.polname='cnyos_active_subscription_boundary'
        and not p.polpermissive
        and 'authenticated'::regrole=any(p.polroles)
    )
  order by c.relname
`);
assert.deepEqual(missingRestrictiveBoundary.rows, []);
const sentinelPolicies = await db.query(`
  select count(*)::int count
  from pg_policy
  where polrelid='public.owner_control_historical_replay_guard'::regclass
`);
assert.equal(sentinelPolicies.rows[0].count, 0, 'closed replay sentinel must retain zero policies');

const tenantColumns = await db.query(`
  select table_name,column_name,is_nullable
  from information_schema.columns
  where table_schema='public'
    and table_name in (
      'practitioner_schedules','clinic_appointments','appointment_events',
      'approval_tasks','approval_actions'
    )
    and column_name='clinic_id'
  order by table_name
`);
assert.equal(tenantColumns.rows.length, 5);
assert.ok(tenantColumns.rows.every(row => row.is_nullable === 'NO'));

const activeWriteTriggers = await db.query(`
  select c.relname table_name
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and t.tgname='trg_cnyos_active_subscription_write'
    and not t.tgisinternal
    and t.tgenabled<>'D'
    and (t.tgtype & 1)=1
    and (t.tgtype & 2)=2
    and (t.tgtype & 28)=28
  order by c.relname
`);
assert.deepEqual(activeWriteTriggers.rows.map(row => row.table_name), [
  'appointment_events',
  'approval_actions',
  'approval_tasks',
  'audit_logs',
  'clinic_appointments',
  'clinic_memberships',
  'inventory_lots',
  'line_oa_contacts',
  'line_oa_delivery_events',
  'line_oa_notification_outbox',
  'line_oa_notification_preferences',
  'line_oa_webhook_events',
  'patient_identity_events',
  'patient_identity_link_requests',
  'patient_identity_links',
  'patient_qr_sessions',
  'practitioner_schedules'
]);

const missingAuthenticatedStatementLocks = await db.query(`
  select c.relname table_name
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('r','p')
    and not exists (
      select 1
      from pg_trigger t
      join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid=c.oid
        and t.tgname='trg_cnyos_authenticated_subscription_statement_write'
        and not t.tgisinternal
        and t.tgenabled<>'D'
        and (t.tgtype & 1)=0
        and (t.tgtype & 2)=2
        and (t.tgtype & 28)=28
        and p.oid='public.enforce_authenticated_subscription_statement_write()'::regprocedure
    )
  order by c.relname
`);
assert.deepEqual(missingAuthenticatedStatementLocks.rows, []);

const lockContract = await db.query(`
  select
    (select provolatile from pg_proc
      where oid='public.assert_clinic_subscription_active(uuid)'::regprocedure) assert_volatility,
    (select prosrc from pg_proc
      where oid='public.assert_clinic_subscription_active(uuid)'::regprocedure) assert_source,
    (select provolatile from pg_proc
      where oid='public.prepare_line_subscription_off_exception(uuid,text)'::regprocedure) exception_volatility,
    (select prosrc from pg_proc
      where oid='public.prepare_line_subscription_off_exception(uuid,text)'::regprocedure) exception_source,
    (select prosrc from pg_proc
      where oid='public.enforce_authenticated_subscription_statement_write()'::regprocedure) statement_source,
    (select prosrc from pg_proc
      where oid='public.enforce_active_subscription_tenant_write()'::regprocedure) row_source,
    (select prosrc from pg_proc
      where oid='public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)'::regprocedure) owner_source
`);
assert.equal(lockContract.rows[0].assert_volatility, 'v');
assert.equal(lockContract.rows[0].exception_volatility, 'v');
assert.match(lockContract.rows[0].assert_source, /for\s+share/i);
assert.match(lockContract.rows[0].exception_source, /for\s+share/i);
assert.match(lockContract.rows[0].statement_source, /assert_clinic_subscription_active/i);
assert.match(lockContract.rows[0].statement_source, /auth\.role\(\) is distinct from 'authenticated'/i);
assert.match(lockContract.rows[0].statement_source, /auth\.uid\(\) is null/i);
assert.match(
  lockContract.rows[0].row_source,
  /auth\.role\(\) is null[\s\S]*auth\.uid\(\) is null[\s\S]*session_user=current_user/i
);
assert.match(lockContract.rows[0].owner_source, /for\s+update/i);

const serviceDml = await db.query(`
  select c.relname table_name,
    has_table_privilege('service_role',c.oid,'INSERT') can_insert,
    has_table_privilege('service_role',c.oid,'UPDATE') can_update,
    has_table_privilege('service_role',c.oid,'DELETE') can_delete,
    has_table_privilege('service_role',c.oid,'TRUNCATE') can_truncate
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('r','p')
    and (
      has_table_privilege('service_role',c.oid,'INSERT')
      or has_table_privilege('service_role',c.oid,'UPDATE')
      or has_table_privilege('service_role',c.oid,'DELETE')
      or has_table_privilege('service_role',c.oid,'TRUNCATE')
    )
  order by c.relname
`);
assert.deepEqual(serviceDml.rows, [
  { table_name: 'audit_logs', can_insert: true, can_update: false, can_delete: false, can_truncate: false },
  { table_name: 'clinic_memberships', can_insert: true, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'inventory_lots', can_insert: true, can_update: false, can_delete: false, can_truncate: false },
  { table_name: 'patient_qr_sessions', can_insert: false, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'profiles', can_insert: true, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'ttm_concept_relations', can_insert: true, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'ttm_concepts', can_insert: true, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'ttm_diagnostic_knowledge', can_insert: true, can_update: true, can_delete: false, can_truncate: false },
  { table_name: 'ttm_sources', can_insert: true, can_update: true, can_delete: false, can_truncate: false }
]);
const unexpectedColumnDml = await db.query(`
  select c.relname table_name
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind in ('r','p')
    and (
      has_any_column_privilege('service_role',c.oid,'INSERT')
      or has_any_column_privilege('service_role',c.oid,'UPDATE')
    )
    and c.relname not in (
      'audit_logs','clinic_memberships','inventory_lots','patient_qr_sessions',
      'profiles','ttm_concept_relations','ttm_concepts',
      'ttm_diagnostic_knowledge','ttm_sources'
    )
  order by c.relname
`);
assert.deepEqual(unexpectedColumnDml.rows, []);
const serviceSequences = await db.query(`
  select c.relname sequence_name,
    has_sequence_privilege('service_role',c.oid,'USAGE') can_use,
    has_sequence_privilege('service_role',c.oid,'SELECT') can_select,
    has_sequence_privilege('service_role',c.oid,'UPDATE') can_update
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and c.relkind='S'
    and (
      has_sequence_privilege('service_role',c.oid,'USAGE')
      or has_sequence_privilege('service_role',c.oid,'SELECT')
      or has_sequence_privilege('service_role',c.oid,'UPDATE')
    )
  order by c.relname
`);
assert.deepEqual(serviceSequences.rows, [
  { sequence_name: 'audit_logs_id_seq', can_use: true, can_select: false, can_update: false }
]);
for (const table of ['audit_logs','clinic_memberships','inventory_lots','patient_qr_sessions']) {
  assert.ok(
    activeWriteTriggers.rows.some(row => row.table_name === table),
    `${table} direct service DML must hold the exact-clinic subscription lock`
  );
}

const acl = await db.query(`
  select
    has_function_privilege('service_role','public.complete_patient_line_link(text,text,text,boolean)','EXECUTE') old_link,
    has_function_privilege('service_role','public.list_line_linked_patients(text)','EXECUTE') old_list,
    has_function_privilege('service_role','public.issue_patient_qr_for_subject(text,uuid,text,text,timestamp with time zone)','EXECUTE') old_qr,
    has_function_privilege('service_role','public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamp with time zone,boolean,text)','EXECUTE') archived_gateway,
    has_function_privilege('service_role','public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamp with time zone,boolean,text)','EXECUTE') guarded_gateway,
    has_function_privilege('anon','public.sign_clinical_record_complete(uuid,text,text,text)','EXECUTE') anon_signoff,
    has_function_privilege('service_role','public.sign_clinical_record_complete(uuid,text,text,text)','EXECUTE') service_signoff,
    has_function_privilege('authenticated','public.sign_clinical_record_complete(uuid,text,text,text)','EXECUTE') authenticated_signoff,
    has_function_privilege('anon','public.unlock_clinical_record_for_amendment(uuid,text)','EXECUTE') anon_unlock,
    has_function_privilege('service_role','public.unlock_clinical_record_for_amendment(uuid,text)','EXECUTE') service_unlock,
    has_function_privilege('authenticated','public.unlock_clinical_record_for_amendment(uuid,text)','EXECUTE') authenticated_unlock
`);
assert.deepEqual(acl.rows[0], {
  old_link: false,
  old_list: false,
  old_qr: false,
  archived_gateway: false,
  guarded_gateway: true,
  anon_signoff: false,
  service_signoff: false,
  authenticated_signoff: true,
  anon_unlock: false,
  service_unlock: false,
  authenticated_unlock: true
});

const signoffSources = await db.query(`
  select proname,prosrc
  from pg_proc
  where oid in (
    'public.sign_clinical_record_complete(uuid,text,text,text)'::regprocedure,
    'public.unlock_clinical_record_for_amendment(uuid,text)'::regprocedure
  )
  order by proname
`);
for (const routine of signoffSources.rows) {
  assert.match(routine.prosrc, /assert_clinic_subscription_active/i);
  assert.match(routine.prosrc, /e\.clinic_id=v_clinic_id/i);
}

// A database login that is not the SECURITY DEFINER owner cannot obtain the
// maintenance bypass merely by omitting JWT claims.
const finalOffResult = (await asService(`
  select public.set_clinic_subscription_state(
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3','${CLINIC_A}','CHANANYA',false,3,
    'Untrusted no-JWT maintenance bypass negative','${OWNER}','owner@example.test'
  ) result
`)).rows[0].result;
assert.equal(finalOffResult.state, 'suspended');
await db.exec(`
  select
    set_config('request.jwt.claim.sub','',false),
    set_config('request.jwt.claim.role','',false);
  set session authorization service_role;
`);
await expectDatabaseError(db.query(`
  update public.clinic_memberships
  set updated_at=updated_at
  where clinic_id='${CLINIC_A}' and profile_id='${USER_A}'
`), 'CNYOS_SUBSCRIPTION_SUSPENDED');

await db.close();

async function expectAmbiguousBackfillFailure(
  fixture,
  expectedCode,
  { inactiveOriginal = false } = {}
) {
  const fixtureDb = new PGlite();
  await fixtureDb.exec(pgliteBootstrap);
  let attempted = false;
  try {
    for (const file of migrationFiles) {
      if (file === '202608270300_hybrid_patient_identity.sql') {
        await fixtureDb.exec(`
          insert into auth.users(id,email,raw_user_meta_data)
          values('${USER_A}','ambiguous@example.test','{"full_name":"Ambiguous User"}');
          update public.profiles
          set role='practitioner',system_role='staff'
          where id='${USER_A}';
        `);
      }
      const source = (await fs.readFile(path.join(migrationsDir,file),'utf8'))
        .replace(/create extension if not exists pgcrypto\s*;/gi,'');
      if (file !== '202609011000_owner_subscription_kill_switch_closure.sql') {
        await fixtureDb.exec(source);
        continue;
      }

      attempted = true;
      if (inactiveOriginal) {
        await fixtureDb.exec(`
          update public.clinic_memberships
          set active=false,is_primary=false
          where clinic_id='${CLINIC_A}' and profile_id='${USER_A}'
        `);
      }
      await fixtureDb.exec(`
        insert into public.clinics(id,code,name_th,name_en)
        values('${CLINIC_B}','AMBIGUOUS','คลินิกกำกวม','Ambiguous Clinic');
        insert into public.clinic_memberships(
          clinic_id,profile_id,clinic_role,is_primary,active
        ) values ('${CLINIC_B}','${USER_A}','practitioner',false,true);
      `);
      if (fixture === 'schedule') {
        await fixtureDb.exec(`
          insert into public.practitioner_schedules(
            practitioner_id,title,starts_at,ends_at,created_by
          ) values (
            '${USER_A}','Ambiguous historical schedule',now()+interval '1 day',
            now()+interval '1 day 1 hour','${USER_A}'
          );
        `);
      } else {
        await fixtureDb.exec(`
          insert into public.approval_tasks(
            task_no,task_type,module,title,requested_by
          ) values (
            'AT-AMBIGUOUS','clinical_review','clinical',
            'Ambiguous historical approval','${USER_A}'
          );
        `);
      }
      await expectDatabaseError(fixtureDb.exec(source),expectedCode);
      break;
    }
  } finally {
    await fixtureDb.close();
  }
  assert.equal(attempted,true,`${fixture} ambiguity migration must be attempted`);
}

await expectAmbiguousBackfillFailure(
  'schedule','APPOINTMENT_SCHEDULE_CLINIC_BACKFILL_REQUIRED'
);
await expectAmbiguousBackfillFailure(
  'approval','APPROVAL_TASK_CLINIC_BACKFILL_REQUIRED'
);
await expectAmbiguousBackfillFailure(
  'schedule','APPOINTMENT_SCHEDULE_CLINIC_BACKFILL_REQUIRED',
  { inactiveOriginal: true }
);
await expectAmbiguousBackfillFailure(
  'approval','APPROVAL_TASK_CLINIC_BACKFILL_REQUIRED',
  { inactiveOriginal: true }
);

console.log('Owner subscription suspension boundary passed: OFF RLS/RPC/LINE deny, cross-tenant isolation, no mutation, reversible ON');
