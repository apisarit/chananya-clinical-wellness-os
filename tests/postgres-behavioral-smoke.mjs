import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { SYNTHETIC_UAT_CASES } from './fixtures/synthetic-uat-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';
const USER_C = '44444444-4444-4444-a444-444444444444';
const USER_PHARMACY = 'aaaaaaaa-1111-4111-a111-111111111111';
const USER_PRODUCTION = 'bbbbbbbb-2222-4222-a222-222222222222';
const USER_QUALITY = 'abababab-7777-4777-a777-777777777777';
const USER_RECEPTION = 'cccccccc-3333-4333-a333-333333333333';
const USER_ADMIN = 'dddddddd-4444-4444-a444-444444444444';
const USER_ROLE_TARGET = 'eeeeeeee-5555-4555-a555-555555555555';
const USER_BILLING = 'f0f0f0f0-6666-4666-a666-666666666666';
const CLINIC_B = '33333333-3333-4333-a333-333333333333';
const RX_REQUEST = '55555555-5555-4555-a555-555555555555';
const RX_BAD_REQUEST = '66666666-6666-4666-a666-666666666666';
const PAYMENT_PARTIAL_REQUEST = '77777777-7777-4777-a777-777777777777';
const PAYMENT_FINAL_REQUEST = '88888888-8888-4888-a888-888888888888';
const PAYMENT_OVER_REQUEST = '99999999-9999-4999-a999-999999999999';
const PRODUCTION_RX_REQUEST = '10101010-1010-4010-a010-101010101010';
const PRODUCTION_REQUEST_KEY = '20202020-2020-4020-a020-202020202020';
const PRODUCTION_ROLLBACK_RX_REQUEST = '30303030-3030-4030-a030-303030303030';
const PRODUCTION_ROLLBACK_REQUEST_KEY = '40404040-4040-4040-a040-404040404040';
const QR_TOKEN = 'A'.repeat(43);
const db = new PGlite();

// PGlite validates PostgreSQL DDL, PL/pgSQL, RLS, triggers, FKs and
// transactions. These test-only functions mimic pgcrypto signatures; crypto
// strength is covered by the Node helper tests and real Supabase must provide
// pgcrypto before this migration is activated.
await db.exec(`
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
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      'authenticated'
    )::text
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
`);

const migrationFiles = (await fs.readdir(migrationsDir))
  .filter(file => file.endsWith('.sql'))
  .sort();

for (const file of migrationFiles) {
  if (file === '202608270300_hybrid_patient_identity.sql') {
    await db.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${USER_A}','a@example.test','{"full_name":"Practitioner A"}'),
        ('${USER_B}','b@example.test','{"full_name":"Practitioner B"}'),
        ('${USER_C}','c@example.test','{"full_name":"Platform Support"}');
      update public.profiles
      set role='practitioner', system_role='staff'
      where id in ('${USER_A}','${USER_B}');
      update public.profiles
      set role='viewer', system_role='super_admin'
      where id='${USER_C}';
      insert into public.patients(
        hn,prefix,first_name,last_name,created_by
      ) values (
        'CHANANYA-00009999','นาย','ข้อมูล','เดิม','${USER_A}'
      );
    `);
  }
  const source = await fs.readFile(path.join(migrationsDir, file), 'utf8');
  const compatibleSource = source.replace(
    /create extension if not exists pgcrypto\s*;/gi,
    ''
  );
  await db.exec(compatibleSource);
}

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

async function expectDatabaseError(promise, code) {
  await assert.rejects(promise, error => String(error.message).includes(code));
}

function sqlQuote(value) {
  if (value == null) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

await expectDatabaseError(
  asUser(USER_A, `select * from public.issue_patient_line_link_code(null,'self',null,false)`),
  'CONSENT_REQUIRED'
);

const createdA = await asUser(USER_A, `
  select (public.upsert_patient_registration(
    null,'นาง','ทดสอบ','หนึ่ง',null,'female','1990-01-02',
    '0812345678',null,null,null,'penicillin'
  )).*;
`);
const patientA = createdA.rows[0];
assert.match(patientA.hn, /^CHANANYA-\d{8,}$/);
assert.ok(Number(patientA.hn.split('-').at(-1)) > 9999);
await expectDatabaseError(
  asUser(USER_A, `
    update public.patients set first_name='Bypass' where id='${patientA.id}'
  `),
  'permission denied'
);
await expectDatabaseError(
  asUser(USER_A, `
    insert into public.audit_logs(
      clinic_id,user_id,action,entity,metadata
    ) values (
      '00000000-0000-0000-0000-000000000001','${USER_A}',
      'forged','patients','{}'::jsonb
    )
  `),
  'permission denied'
);

const linkResult = await asUser(USER_A, `
  select * from public.issue_patient_line_link_code(
    '${patientA.id}','self',null,true
  )
`);
const linkCode = linkResult.rows[0].link_code;
assert.match(linkCode, /^[0-9A-F]{12}$/);

await db.exec(`
  select set_config('request.jwt.claim.sub','',false);
  set role service_role;
`);
const subjectHash = 'a'.repeat(64);
await db.query(`
  select * from public.complete_patient_line_link(
    '${linkCode}','${subjectHash}','line-channel',true
  )
`);
const hashes = await db.query(`
  select
    encode(digest('${QR_TOKEN}','sha256'),'hex') token_hash,
    encode(digest('123456','sha256'),'hex') code_hash
`);
const { token_hash: tokenHash, code_hash: codeHash } = hashes.rows[0];
const qrIssued = await db.query(`
  select * from public.issue_patient_qr_for_subject(
    '${subjectHash}','${patientA.id}','${tokenHash}','${codeHash}',
    now()+interval '90 seconds'
  )
`);
assert.equal(qrIssued.rows[0].patient_id, patientA.id);
await db.exec('reset role;');

const lineOaChannelHash = 'b'.repeat(64);
const lineOaEventHash = 'c'.repeat(64);
const lineOaPayloadHash = 'd'.repeat(64);
const lineOaClaim = await asService(`
  select * from public.register_line_oa_webhook_event(
    '${lineOaChannelHash}','${lineOaEventHash}','${subjectHash}',
    'follow','none',now(),false,'${lineOaPayloadHash}'
  )
`);
assert.equal(lineOaClaim.rows[0].accepted, true);
assert.equal(lineOaClaim.rows[0].linked_count, 1);
const lineOaFinalized = await asService(`
  select public.finalize_line_oa_webhook_event(
    '${lineOaChannelHash}','${lineOaEventHash}','processed','sent',null
  ) finalized
`);
assert.equal(lineOaFinalized.rows[0].finalized, true);
const lineOaDuplicate = await asService(`
  select * from public.register_line_oa_webhook_event(
    '${lineOaChannelHash}','${lineOaEventHash}','${subjectHash}',
    'follow','none',now(),true,'${lineOaPayloadHash}'
  )
`);
assert.equal(lineOaDuplicate.rows[0].accepted, false);
const lineOaEvidence = await asService(`
  select * from public.line_oa_webhook_evidence(now()-interval '1 hour')
`);
assert.deepEqual(
  {
    total: Number(lineOaEvidence.rows[0].total_events),
    processed: Number(lineOaEvidence.rows[0].processed_events),
    failed: Number(lineOaEvidence.rows[0].failed_events),
    replied: Number(lineOaEvidence.rows[0].replied_events)
  },
  { total: 1, processed: 1, failed: 0, replied: 1 }
);
const lineOaStored = await db.query(`
  select event_type,action_code,processing_status,reply_status,linked_patient_count
  from public.line_oa_gateway_webhook_events
  where event_id_hash='${lineOaEventHash}'
`);
assert.deepEqual(lineOaStored.rows[0], {
  event_type: 'follow',
  action_code: 'none',
  processing_status: 'processed',
  reply_status: 'sent',
  linked_patient_count: 1
});
const lineOaIdentityAudit = await db.query(`
  select count(*)::int count
  from public.patient_identity_events
  where patient_id='${patientA.id}' and event_type='LINE_OA_FOLLOWED'
`);
assert.equal(lineOaIdentityAudit.rows[0].count, 1);
await expectDatabaseError(
  asUser(USER_A, `select * from public.line_oa_webhook_evidence(now()-interval '1 hour')`),
  'permission denied'
);

const resolved = await asUser(USER_A, `
  select * from public.resolve_patient_qr('CHANANYA:PT1:${QR_TOKEN}',null)
`);
assert.equal(resolved.rows[0].patient_id, patientA.id);
assert.equal(resolved.rows[0].active_allergies[0].name, 'penicillin');
const qrSession = resolved.rows[0].qr_session_id;
await assert.rejects(
  asUser(USER_A, `
    select * from public.confirm_patient_qr(
      '${qrSession}',true,'ข้อมูลทดสอบที่ต้อง rollback',
      '{"pain_before":99}'::jsonb
    )
  `)
);
const rolledBackEncounter = await asUser(USER_A, `
  select count(*)::int count
  from public.encounters
  where patient_id='${patientA.id}'
`);
assert.equal(rolledBackEncounter.rows[0].count, 0);
const confirmed = await asUser(USER_A, `
  select * from public.confirm_patient_qr(
    '${qrSession}',true,'ปวดหลัง','{"pain_before":6,"pulse":72}'::jsonb
  )
`);
assert.equal(confirmed.rows[0].patient_id, patientA.id);
const encounterA = confirmed.rows[0].encounter_id;
assert.ok(encounterA);
const outcomeSession = await db.query(`
  insert into public.clinical_treatment_sessions(
    encounter_id,session_no,treatment_modalities,treatment_detail,
    pain_before,pain_after,outcome_summary,advice,practitioner_id
  ) values (
    '${encounterA}',1,array['นวดราชสำนัก','ประคบสมุนไพร'],
    'รักษาตามสมุฏฐานที่ผู้ประกอบวิชาชีพยืนยัน',7,3,
    'อาการปวดลดลงและเคลื่อนไหวดีขึ้น','ติดตามใน 7 วัน','${USER_A}'
  ) returning *
`);
assert.equal(outcomeSession.rows[0].pain_before, 7);
assert.equal(outcomeSession.rows[0].pain_after, 3);
await db.query(`
  insert into public.clinical_followup_notes(
    encounter_id,followup_date,current_symptoms,change_from_previous,
    outcome_status,next_appointment_at,recorded_by
  ) values (
    '${encounterA}',current_date,'ปวดลดลง','เคลื่อนไหวดีขึ้น',
    'improved',now()+interval '7 days','${USER_A}'
  )
`);
const outcomeSummary = await asUser(USER_A, `
  select * from public.clinical_outcomes_summary(now()-interval '1 day',now()+interval '1 day')
`);
assert.equal(outcomeSummary.rows[0].total_sessions, 1);
assert.equal(outcomeSummary.rows[0].measured_sessions, 1);
assert.equal(outcomeSummary.rows[0].improved_sessions, 1);
assert.equal(outcomeSummary.rows[0].followup_encounters, 1);
const outcomePatient = await asUser(USER_A, `
  select patient.hn
  from public.encounters encounter
  join public.patients patient on patient.id=encounter.patient_id
  where encounter.id='${encounterA}'
`);
const outcomeHn = outcomePatient.rows[0].hn;
const outcomeSearch = await asUser(USER_A, `
  select * from public.search_clinical_outcomes(
    '${outcomeHn}',now()-interval '1 day',now()+interval '1 day',100,0
  )
`);
assert.equal(outcomeSearch.rows.length, 1);
assert.equal(outcomeSearch.rows[0].encounter_id, encounterA);
assert.equal(outcomeSearch.rows[0].pain_change, 4);
assert.equal(outcomeSearch.rows[0].followup_status, 'improved');
assert.ok(outcomeSearch.rows[0].next_followup_at instanceof Date);
await expectDatabaseError(
  asUser(USER_A, `
    select * from public.confirm_patient_qr(
      '${qrSession}',true,null,'{}'::jsonb
    )
  `),
  'QR_INVALID_EXPIRED_OR_USED'
);

const intakeCounts = await db.query(`
  select
    (select count(*)::int from public.vital_signs where encounter_id='${encounterA}') vitals,
    (select count(*)::int from public.pain_assessments where encounter_id='${encounterA}') pain,
    (select count(*)::int from public.encounter_identity_verifications where encounter_id='${encounterA}') verification,
    (select count(*)::int from public.audit_logs where entity_id='${encounterA}') audit
`);
assert.deepEqual(
  intakeCounts.rows[0],
  { vitals: 1, pain: 1, verification: 1, audit: 1 }
);

const linksBeforeRevoke = await asUser(USER_A, `
  select * from public.list_patient_identity_links('${patientA.id}')
`);
assert.equal(linksBeforeRevoke.rows.length, 1);
assert.equal(linksBeforeRevoke.rows[0].status, 'active');
assert.equal('subject_hash' in linksBeforeRevoke.rows[0], false);
const revoked = await asUser(USER_A, `
  select public.revoke_patient_identity_link(
    '${linksBeforeRevoke.rows[0].link_id}',
    'ผู้รับบริการขอยกเลิกบัญชีทดสอบ'
  ) revoked
`);
assert.equal(revoked.rows[0].revoked, true);
const linksAfterRevoke = await asUser(USER_A, `
  select * from public.list_patient_identity_links('${patientA.id}')
`);
assert.equal(linksAfterRevoke.rows[0].status, 'revoked');

await asUser(USER_A, `
  do $rate_limit_test$
  begin
    for attempt in 1..20 loop
      perform * from public.resolve_patient_qr(null,'999999');
    end loop;
  end
  $rate_limit_test$;
`);
const failedLookups = await db.query(`
  select count(*)::int count
  from public.patient_identity_events
  where event_type='PATIENT_QR_LOOKUP_FAILED'
`);
assert.equal(failedLookups.rows[0].count, 20);
await expectDatabaseError(
  asUser(USER_A, `select * from public.resolve_patient_qr(null,'999999')`),
  'RATE_LIMITED'
);

const createdManual = await asUser(USER_A, `
  select (public.upsert_patient_registration(
    null,'นาย','ไม่มี','มือถือ',null,'male','1960-02-03',
    null,null,null,null,null
  )).*;
`);
const manualEncounter = await asUser(USER_A, `
  select * from public.start_manual_patient_encounter(
    '${createdManual.rows[0].id}','manual_hn',true,null,
    'ติดตามอาการ','{}'::jsonb
  )
`);
assert.equal(manualEncounter.rows[0].patient_id, createdManual.rows[0].id);

// Clinical -> Pharmacy is one transaction, server-numbered and idempotent.
const productId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
await db.exec(`
  select set_config('request.jwt.claim.role','service_role',false);
  set role service_role;
  insert into public.products(
    id,sku,name_th,category,stock_unit,dispense_unit
  ) values (
    '${productId}','TTM-TEST-001','ยาทดสอบ','medicine','ขวด','ขวด'
  );
  reset role;
`);
const prescription = await asUser(USER_A, `
  select * from public.create_atomic_prescription_handoff(
    '${RX_REQUEST}',
    '${manualEncounter.rows[0].encounter_id}',
    'ทดสอบ atomic handoff',
    '[{"product_id":"${productId}","quantity_prescribed":2,"unit":"ขวด","dose":"1 ขวด"}]'::jsonb
  )
`);
assert.match(prescription.rows[0].prescription_no, /^RX-CHANANYA-\d{8}-\d{8}$/);
assert.match(prescription.rows[0].queue_number, /^Q-CHANANYA-\d{8}-\d{6}$/);
const prescriptionRetry = await asUser(USER_A, `
  select * from public.create_atomic_prescription_handoff(
    '${RX_REQUEST}',
    '${manualEncounter.rows[0].encounter_id}',
    'ทดสอบ atomic handoff',
    '[{"product_id":"${productId}","quantity_prescribed":2,"unit":"ขวด","dose":"1 ขวด"}]'::jsonb
  )
`);
assert.equal(prescriptionRetry.rows[0].prescription_id, prescription.rows[0].prescription_id);
const handoffCounts = await db.query(`
  select
    (select count(*)::int from public.prescriptions where id='${prescription.rows[0].prescription_id}') prescriptions,
    (select count(*)::int from public.prescription_items where prescription_id='${prescription.rows[0].prescription_id}') items,
    (select count(*)::int from public.dispensing_orders where prescription_id='${prescription.rows[0].prescription_id}') orders
`);
assert.deepEqual(handoffCounts.rows[0], { prescriptions: 1, items: 1, orders: 1 });

const prescriptionCountBeforeFailure = await db.query(`
  select count(*)::int count from public.prescriptions
`);
await expectDatabaseError(
  asUser(USER_A, `
    select * from public.create_atomic_prescription_handoff(
      '${RX_BAD_REQUEST}',
      '${manualEncounter.rows[0].encounter_id}',
      null,
      '[
        {"product_id":"${productId}","quantity_prescribed":1,"unit":"ขวด"},
        {"product_id":"bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb","quantity_prescribed":1,"unit":"ขวด"}
      ]'::jsonb
    )
  `),
  'PRODUCT_NOT_AVAILABLE'
);
const prescriptionCountAfterFailure = await db.query(`
  select count(*)::int count from public.prescriptions
`);
assert.equal(
  prescriptionCountAfterFailure.rows[0].count,
  prescriptionCountBeforeFailure.rows[0].count
);
await expectDatabaseError(
  asUser(USER_A, `
    insert into public.prescriptions(
      prescription_no,encounter_id,patient_id,status
    ) values (
      'RX-BYPASS','${manualEncounter.rows[0].encounter_id}',
      '${createdManual.rows[0].id}','draft'
    )
  `),
  'permission denied'
);

// Pharmacy test fixture: the billing RPC independently derives medicine
// totals from dispensed quantities/prices and never trusts browser totals.
await db.exec(`
  insert into public.dispensing_items(
    dispensing_order_id,prescription_item_id,quantity_dispensed,unit,
    unit_price,status
  )
  select
    '${prescription.rows[0].dispensing_order_id}',pi.id,2,'ขวด',120,'dispensed'
  from public.prescription_items pi
  where pi.prescription_id='${prescription.rows[0].prescription_id}';
  update public.dispensing_orders
  set status='submitted_to_billing'
  where id='${prescription.rows[0].dispensing_order_id}';
`);

const invoice = await asUser(USER_C, `
  select * from public.issue_atomic_dispensing_invoice(
    '${prescription.rows[0].dispensing_order_id}',300,50
  )
`);
assert.match(invoice.rows[0].invoice_number, /^INV-CHANANYA-\d{8}-\d{8}$/);
assert.equal(Number(invoice.rows[0].grand_total), 490);
assert.equal(Number(invoice.rows[0].balance_due), 490);
const invoiceRetry = await asUser(USER_C, `
  select * from public.issue_atomic_dispensing_invoice(
    '${prescription.rows[0].dispensing_order_id}',300,50
  )
`);
assert.equal(invoiceRetry.rows[0].invoice_id, invoice.rows[0].invoice_id);
await expectDatabaseError(
  asUser(USER_C, `
    select * from public.issue_atomic_dispensing_invoice(
      '${prescription.rows[0].dispensing_order_id}',0,50
    )
  `),
  'DISPENSING_ORDER_ALREADY_BILLED'
);
const invoiceEvidence = await db.query(`
  select
    (select count(*)::int from public.invoices where id='${invoice.rows[0].invoice_id}') invoices,
    (select count(*)::int from public.invoice_items where invoice_id='${invoice.rows[0].invoice_id}') lines,
    (select status from public.dispensing_orders where id='${prescription.rows[0].dispensing_order_id}') order_status
`);
assert.deepEqual(invoiceEvidence.rows[0], { invoices: 1, lines: 2, order_status: 'billed' });

const partialPayment = await asUser(USER_C, `
  select * from public.record_atomic_invoice_payment(
    '${PAYMENT_PARTIAL_REQUEST}','${invoice.rows[0].invoice_id}',200,
    'cash','receipt-test-1'
  )
`);
assert.equal(partialPayment.rows[0].invoice_status, 'partially_paid');
assert.equal(Number(partialPayment.rows[0].paid_amount), 200);
assert.equal(Number(partialPayment.rows[0].balance_due), 290);
assert.equal(partialPayment.rows[0].encounter_closed, false);
const partialRetry = await asUser(USER_C, `
  select * from public.record_atomic_invoice_payment(
    '${PAYMENT_PARTIAL_REQUEST}','${invoice.rows[0].invoice_id}',200,
    'cash','receipt-test-1'
  )
`);
assert.equal(partialRetry.rows[0].payment_id, partialPayment.rows[0].payment_id);

const paymentCountBeforeOverpay = await db.query(`
  select count(*)::int count from public.payments
  where invoice_id='${invoice.rows[0].invoice_id}'
`);
await expectDatabaseError(
  asUser(USER_C, `
    select * from public.record_atomic_invoice_payment(
      '${PAYMENT_OVER_REQUEST}','${invoice.rows[0].invoice_id}',300,
      'cash',null
    )
  `),
  'PAYMENT_EXCEEDS_BALANCE'
);
const paymentCountAfterOverpay = await db.query(`
  select count(*)::int count from public.payments
  where invoice_id='${invoice.rows[0].invoice_id}'
`);
assert.equal(paymentCountAfterOverpay.rows[0].count, paymentCountBeforeOverpay.rows[0].count);

const finalPayment = await asUser(USER_C, `
  select * from public.record_atomic_invoice_payment(
    '${PAYMENT_FINAL_REQUEST}','${invoice.rows[0].invoice_id}',290,
    'qr','receipt-test-2'
  )
`);
assert.equal(finalPayment.rows[0].invoice_status, 'paid');
assert.equal(Number(finalPayment.rows[0].balance_due), 0);
assert.equal(finalPayment.rows[0].encounter_closed, true);
const closedEncounter = await db.query(`
  select status,completed_at is not null completed
  from public.encounters
  where id='${manualEncounter.rows[0].encounter_id}'
`);
assert.deepEqual(closedEncounter.rows[0], { status: 'closed', completed: true });

await expectDatabaseError(
  asUser(USER_C, `
    insert into public.payments(
      invoice_id,payment_reference,channel,amount,status
    ) values ('${invoice.rows[0].invoice_id}','PAY-BYPASS','cash',1,'paid')
  `),
  'permission denied'
);

const handoffAudit = await db.query(`
  select action,count(*)::int count
  from public.audit_logs
  where action in (
    'create_prescription_handoff','issue_dispensing_invoice','record_invoice_payment'
  )
  group by action
  order by action
`);
assert.deepEqual(handoffAudit.rows, [
  { action: 'create_prescription_handoff', count: 1 },
  { action: 'issue_dispensing_invoice', count: 1 },
  { action: 'record_invoice_payment', count: 2 }
]);

await db.exec(`
  insert into public.clinics(id,code,name_th)
  values ('${CLINIC_B}','CLINICB','คลินิกบี');
  update public.clinic_memberships
  set is_primary=false
  where profile_id='${USER_B}';
  insert into public.clinic_memberships(
    clinic_id,profile_id,clinic_role,is_primary
  ) values ('${CLINIC_B}','${USER_B}','practitioner',true);
`);
const createdB = await asUser(USER_B, `
  select (public.upsert_patient_registration(
    null,'นาง','ต่าง','คลินิก',null,'female','1988-03-04',
    '0899999999',null,null,null,null
  )).*;
`);
assert.match(createdB.rows[0].hn, /^CLINICB-\d{8}$/);
const visibleA = await asUser(
  USER_A,
  `select count(*)::int count from public.patients where id='${createdB.rows[0].id}'`
);
assert.equal(visibleA.rows[0].count, 0);
const oldTenantHiddenAfterSwitch = await asUser(
  USER_B,
  `select count(*)::int count from public.patients where id='${patientA.id}'`
);
assert.equal(
  oldTenantHiddenAfterSwitch.rows[0].count,
  0,
  'only the primary active tenant may be visible even when another membership remains active'
);
const visibleToUnassignedSuperAdmin = await asUser(
  USER_C,
  `select count(*)::int count from public.patients where id='${createdB.rows[0].id}'`
);
assert.equal(visibleToUnassignedSuperAdmin.rows[0].count, 0);
const crossSearch = await asUser(
  USER_A,
  `select * from public.search_patients_for_checkin('ต่าง')`
);
assert.equal(crossSearch.rows.length, 0);
const crossTenantOutcomes = await asUser(USER_B, `
  select * from public.search_clinical_outcomes(
    '${outcomeHn}',now()-interval '1 day',now()+interval '1 day',100,0
  )
`);
assert.equal(crossTenantOutcomes.rows.length, 0, 'outcome search must not cross the active clinic boundary');

// Department separation is enforced by both RPCs and restrictive RLS. An
// account has one active department; only super_admin has the explicit
// cross-workspace override, still inside its active clinic tenant.
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data) values
    ('${USER_PHARMACY}','pharmacy@example.test','{"full_name":"Pharmacist"}'),
    ('${USER_PRODUCTION}','production@example.test','{"full_name":"Production"}'),
    ('${USER_QUALITY}','quality@example.test','{"full_name":"Quality"}'),
    ('${USER_RECEPTION}','reception@example.test','{"full_name":"Reception"}'),
    ('${USER_ADMIN}','admin@example.test','{"full_name":"Governance Admin"}'),
    ('${USER_ROLE_TARGET}','role-target@example.test','{"full_name":"Role Target"}'),
    ('${USER_BILLING}','billing@example.test','{"full_name":"Billing"}');
  update public.profiles set role='pharmacy',system_role='staff' where id='${USER_PHARMACY}';
  update public.profiles set role='production',system_role='staff' where id='${USER_PRODUCTION}';
  update public.profiles set role='quality',system_role='staff' where id='${USER_QUALITY}';
  update public.profiles set role='reception',system_role='staff' where id='${USER_RECEPTION}';
  update public.profiles set role='viewer',system_role='admin' where id='${USER_ADMIN}';
  update public.profiles set role='doctor',system_role='staff' where id='${USER_ROLE_TARGET}';
  update public.profiles set role='billing',system_role='staff' where id='${USER_BILLING}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary) values
    ('00000000-0000-0000-0000-000000000001','${USER_PHARMACY}','pharmacy',true),
    ('00000000-0000-0000-0000-000000000001','${USER_PRODUCTION}','production',true),
    ('00000000-0000-0000-0000-000000000001','${USER_QUALITY}','quality',true),
    ('00000000-0000-0000-0000-000000000001','${USER_RECEPTION}','reception',true),
    ('00000000-0000-0000-0000-000000000001','${USER_ADMIN}','viewer',true),
    ('00000000-0000-0000-0000-000000000001','${USER_ROLE_TARGET}','doctor',true),
    ('00000000-0000-0000-0000-000000000001','${USER_BILLING}','billing',true);
`);

const governanceCapabilities = await asUser(USER_ADMIN, `
  select
    public.department_can('governance') governance,
    public.department_can('clinical') clinical,
    public.department_can('pharmacy') pharmacy,
    public.department_can('production') production
`);
assert.deepEqual(governanceCapabilities.rows[0], {
  governance: true,
  clinical: false,
  pharmacy: false,
  production: false
});

const pharmacyBoundaries = await asUser(USER_PHARMACY, `
  select
    public.department_can('pharmacy') pharmacy,
    public.department_can('product_write') product_write,
    public.department_can('clinical') clinical,
    public.department_can('production') production,
    public.department_can('billing') billing
`);
assert.deepEqual(pharmacyBoundaries.rows[0], {
  pharmacy: true,
  product_write: true,
  clinical: false,
  production: false,
  billing: false
});
await expectDatabaseError(
  asUser(USER_PHARMACY, `select * from public.clinical_outcomes_summary(null,null)`),
  'PERMISSION_DENIED'
);
await expectDatabaseError(
  asUser(USER_ADMIN, `select * from public.search_clinical_outcomes(null,null,null,100,0)`),
  'PERMISSION_DENIED'
);

const productionBoundaries = await asUser(USER_PRODUCTION, `
  select
    public.department_can('production') production,
    public.department_can('product_write') product_write,
    public.department_can('pharmacy') pharmacy,
    public.department_can('clinical') clinical,
    public.department_can('billing') billing
`);
assert.deepEqual(productionBoundaries.rows[0], {
  production: true,
  product_write: true,
  pharmacy: false,
  clinical: false,
  billing: false
});

const qualityBoundaries = await asUser(USER_QUALITY, `
  select
    public.department_can('quality') quality,
    public.department_can('production_read') production_read,
    public.department_can('production') production,
    public.department_can('product_write') product_write,
    public.department_can('patient_read') patient_read,
    public.department_can('pharmacy') pharmacy
`);
assert.deepEqual(qualityBoundaries.rows[0], {
  quality: true,
  production_read: true,
  production: false,
  product_write: false,
  patient_read: false,
  pharmacy: false
});

const receptionBoundaries = await asUser(USER_RECEPTION, `
  select
    public.department_can('patient_registry') patient_registry,
    public.department_can('clinical') clinical,
    public.department_can('pharmacy') pharmacy,
    public.department_can('product_write') product_write
`);
assert.deepEqual(receptionBoundaries.rows[0], {
  patient_registry: true,
  clinical: false,
  pharmacy: false,
  product_write: false
});

const billingBoundaries = await asUser(USER_BILLING, `
  select
    public.department_can('billing') billing,
    public.department_can('patient_read') patient_read,
    public.department_can('clinical') clinical,
    public.department_can('pharmacy') pharmacy,
    public.department_can('production') production
`);
assert.deepEqual(billingBoundaries.rows[0], {
  billing: true,
  patient_read: true,
  clinical: false,
  pharmacy: false,
  production: false
});

const superAdminCapabilities = await asUser(USER_C, `
  select
    public.department_can('clinical') clinical,
    public.department_can('pharmacy') pharmacy,
    public.department_can('production') production,
    public.department_can('billing') billing
`);
assert.deepEqual(superAdminCapabilities.rows[0], {
  clinical: true,
  pharmacy: true,
  production: true,
  billing: true
});

const doctorLegacyPolicyCompatibility = await asUser(USER_ROLE_TARGET, `
  select
    public.current_department_role() department,
    public.has_role(array['practitioner']) practitioner_compatible,
    public.department_can('clinical') clinical,
    public.department_can('pharmacy') pharmacy
`);
assert.deepEqual(doctorLegacyPolicyCompatibility.rows[0], {
  department: 'doctor',
  practitioner_compatible: true,
  clinical: true,
  pharmacy: false
});

await asUser(USER_ADMIN, `
  select public.admin_assign_staff_role(
    '${USER_ROLE_TARGET}','pharmacy','department boundary test'
  )
`);
const assignedDepartment = await asUser(USER_ROLE_TARGET, `
  select
    public.current_department_role() department,
    public.department_can('pharmacy') pharmacy,
    public.department_can('clinical') clinical
`);
assert.deepEqual(assignedDepartment.rows[0], {
  department: 'pharmacy',
  pharmacy: true,
  clinical: false
});
await expectDatabaseError(
  asUser(USER_ROLE_TARGET, `
    select public.admin_assign_staff_role(
      '${USER_ROLE_TARGET}','practitioner','self escalation attempt'
    )
  `),
  'GOVERNANCE_DEPARTMENT_REQUIRED'
);
const assignmentAudit = await db.query(`
  select count(*)::int count
  from public.audit_logs
  where action='assign_department_role'
    and entity_id='${USER_ROLE_TARGET}'
    and metadata->>'new_clinic_role'='pharmacy'
`);
assert.equal(assignmentAudit.rows[0].count, 1);

await expectDatabaseError(
  asUser(USER_A, `
    select * from public.upsert_product_master(
      null,'ROLE-DENIED','ห้ามสร้าง',null,'medicine',null,
      'กล่อง','กล่อง','กล่อง',1,0,0,0
    )
  `),
  'PRODUCT_DEPARTMENT_REQUIRED'
);

const departmentProduct = await asUser(USER_PHARMACY, `
  select * from public.upsert_product_master(
    null,'TTM-DEPT-001','ยาสำหรับทดสอบแผนก',null,'medicine','capsule',
    'กล่อง','แคปซูล','แคปซูล',10,2.50,20,40
  )
`);
assert.equal(departmentProduct.rows[0].clinic_id, '00000000-0000-0000-0000-000000000001');
assert.equal(departmentProduct.rows[0].created_by, USER_PHARMACY);

const updatedByProduction = await asUser(USER_PRODUCTION, `
  select * from public.upsert_product_master(
    '${departmentProduct.rows[0].id}','TTM-DEPT-001','ยาสำหรับทดสอบแผนก',null,
    'medicine','capsule','กล่อง','แคปซูล','แคปซูล',10,2.75,25,45
  )
`);
assert.equal(Number(updatedByProduction.rows[0].standard_cost), 2.75);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    update public.products set name_th='DIRECT BYPASS' where id='${departmentProduct.rows[0].id}'
  `),
  'permission denied'
);

const receptionPatient = await asUser(USER_RECEPTION, `
  select (public.upsert_patient_registration(
    null,'นาง','ฝ่าย','ต้อนรับ',null,'female','1992-05-06',
    '0800000000',null,null,null,null
  )).*
`);
assert.ok(receptionPatient.rows[0].id);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select (public.upsert_patient_registration(
      null,'นาย','ห้าม','ลงทะเบียน',null,'male',null,null,null,null,null,null
    )).*
  `),
  'PERMISSION_DENIED'
);

const counterSale = await asUser(USER_PHARMACY, `
  select * from public.create_pharmacy_counter_sale(
    '${receptionPatient.rows[0].id}',null,null,'ปวดกล้ามเนื้อ',null,null,null,
    'ประเมินแล้วไม่มี red flag','แนะนำติดตามอาการ'
  )
`);
assert.match(counterSale.rows[0].sale_no, /^PS-CHANANYA-\d{8}-\d{8}$/);
const counterItem = await asUser(USER_PHARMACY, `
  select * from public.upsert_pharmacy_counter_sale_item(
    null,'${counterSale.rows[0].id}','${departmentProduct.rows[0].id}',
    2,15,'ครั้งละ 1 แคปซูล','วันละ 2 ครั้ง','3 วัน','หยุดใช้เมื่อมีอาการแพ้'
  )
`);
assert.equal(counterItem.rows[0].unit, 'แคปซูล');
const reviewedSale = await asUser(USER_PHARMACY, `
  select * from public.transition_pharmacy_counter_sale(
    '${counterSale.rows[0].id}','review',null
  )
`);
assert.equal(reviewedSale.rows[0].status, 'reviewed');
await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select * from public.create_pharmacy_counter_sale(
      null,'Bypass',null,'อาการ',null,null,null,'assessment',null
    )
  `),
  'PHARMACY_DEPARTMENT_REQUIRED'
);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    insert into public.pharmacy_counter_sales(sale_no,presenting_symptoms,pharmacist_assessment)
    values ('PS-BYPASS','อาการ','assessment')
  `),
  'permission denied'
);

// Pharmacy -> Production -> FEFO -> QC -> Finished Goods is server-owned.
// Browser calls are idempotent, department scoped and roll back as one unit.
const productionPrescription = await asUser(USER_A, `
  select * from public.create_atomic_prescription_handoff(
    '${PRODUCTION_RX_REQUEST}',
    '${encounterA}',
    'ส่งผลิตจาก Pharmacy',
    '[{"product_id":"${departmentProduct.rows[0].id}","quantity_prescribed":12,"unit":"แคปซูล","dose":"ตามแผนการรักษา"}]'::jsonb
  )
`);
const productionPrescriptionItem = await db.query(`
  select id from public.prescription_items
  where prescription_id='${productionPrescription.rows[0].prescription_id}'
`);
const productionItemId = productionPrescriptionItem.rows[0].id;

await asService(`
  insert into public.products(
    id,clinic_id,sku,name_th,category,stock_unit,dispense_unit
  ) values (
    '60606060-6060-4060-a060-606060606060','${CLINIC_B}',
    'CROSS-TENANT-001','สินค้าต่างคลินิก','medicine','กล่อง','กล่อง'
  )
`);
await expectDatabaseError(
  asService(`
    insert into public.prescription_items(
      prescription_id,product_id,quantity_prescribed,unit
    ) values (
      '${productionPrescription.rows[0].prescription_id}',
      '60606060-6060-4060-a060-606060606060',1,'กล่อง'
    )
  `),
  'PRESCRIPTION_PRODUCT_TENANT_MISMATCH'
);

await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select * from public.create_production_request(
      '${PRODUCTION_REQUEST_KEY}',
      '${productionPrescription.rows[0].dispensing_order_id}',
      '${productionItemId}',12,'แคปซูล',null,'urgent','stock not enough'
    )
  `),
  'PHARMACY_DEPARTMENT_REQUIRED'
);
const productionRequest = await asUser(USER_PHARMACY, `
  select * from public.create_production_request(
    '${PRODUCTION_REQUEST_KEY}',
    '${productionPrescription.rows[0].dispensing_order_id}',
    '${productionItemId}',12,'แคปซูล',null,'urgent','stock not enough'
  )
`);
assert.match(productionRequest.rows[0].request_no, /^PR-CHANANYA-\d{8}-\d{8}$/);
assert.equal(productionRequest.rows[0].status, 'requested');
const productionRequestRetry = await asUser(USER_PHARMACY, `
  select * from public.create_production_request(
    '${PRODUCTION_REQUEST_KEY}',
    '${productionPrescription.rows[0].dispensing_order_id}',
    '${productionItemId}',12,'แคปซูล',null,'urgent','stock not enough'
  )
`);
assert.equal(productionRequestRetry.rows[0].id, productionRequest.rows[0].id);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select * from public.create_production_request(
      '${PRODUCTION_REQUEST_KEY}',
      '${productionPrescription.rows[0].dispensing_order_id}',
      '${productionItemId}',13,'แคปซูล',null,'urgent','stock not enough'
    )
  `),
  'IDEMPOTENCY_KEY_REUSED'
);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select * from public.create_production_request(
      '50505050-5050-4050-a050-505050505050',
      '${prescription.rows[0].dispensing_order_id}',
      (select id from public.prescription_items where prescription_id='${prescription.rows[0].prescription_id}' limit 1),
      1,'ขวด',null,'normal','finalized order must fail'
    )
  `),
  'PHARMACY_PRESCRIPTION_ITEM_NOT_FOUND'
);
await expectDatabaseError(
  asUser(USER_PHARMACY, `
    insert into public.production_requests(
      request_no,source_type,requested_product_id,requested_quantity,unit,status
    ) values ('PR-BYPASS','pharmacy','${departmentProduct.rows[0].id}',1,'แคปซูล','requested')
  `),
  'permission denied'
);

const rawMaterial = await asUser(USER_PRODUCTION, `
  select * from public.upsert_product_master(
    null,'RAW-PROD-001','วัตถุดิบทดสอบ FEFO',null,'raw_material',null,
    'กิโลกรัม','กิโลกรัม','กิโลกรัม',1,100,0,0
  )
`);
const productionFormula = await asUser(USER_PRODUCTION, `
  select * from public.upsert_production_formula(
    null,'FORM-PROD-001','00','สูตรทดสอบ Atomic Production',
    '${departmentProduct.rows[0].id}',10,'แคปซูล',100,365,
    'ทดสอบตาม batch record','approved'
  )
`);
const formulaComponent = await asUser(USER_PRODUCTION, `
  select * from public.upsert_production_formula_component(
    null,'${productionFormula.rows[0].id}','${rawMaterial.rows[0].id}',
    1,1,'กิโลกรัม','ชั่งวัตถุดิบ',null
  )
`);
assert.equal(formulaComponent.rows[0].clinic_id, '00000000-0000-0000-0000-000000000001');

await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select * from public.stage_production_import(
      'inventory_lots','forbidden.xlsx','Lots','[]'::jsonb
    )
  `),
  'PRODUCTION_DEPARTMENT_REQUIRED'
);
const lotImport = await asUser(USER_PRODUCTION, `
  select * from public.stage_production_import(
    'inventory_lots','raw-lots.xlsx','Lots',
    '[
      {"row_number":2,"raw_data":{},"normalized_data":{"sku":"RAW-PROD-001","lot_number":"RAW-EARLY","expiry_date":"2027-01-01","current_quantity":"0.6","unit":"กิโลกรัม","location":"RM-A"}},
      {"row_number":3,"raw_data":{},"normalized_data":{"sku":"RAW-PROD-001","lot_number":"RAW-LATE","expiry_date":"2028-01-01","current_quantity":"1.0","unit":"กิโลกรัม","location":"RM-B"}}
    ]'::jsonb
  )
`);
assert.equal(lotImport.rows[0].valid_rows, 2);
const committedLotImport = await asUser(USER_PRODUCTION, `
  select public.commit_production_import('${lotImport.rows[0].id}') result
`);
assert.equal(committedLotImport.rows[0].result.imported_rows, 2);
const importRetry = await asUser(USER_PRODUCTION, `
  select public.commit_production_import('${lotImport.rows[0].id}') result
`);
assert.equal(importRetry.rows[0].result.imported_rows, 2);

const rollbackImport = await asUser(USER_PRODUCTION, `
  select * from public.stage_production_import(
    'inventory_lots','rollback-lots.xlsx','Lots',
    '[
      {"row_number":2,"raw_data":{},"normalized_data":{"sku":"RAW-PROD-001","lot_number":"RAW-ROLLBACK-NEW","expiry_date":"2029-01-01","current_quantity":"0.1","unit":"กิโลกรัม"}},
      {"row_number":3,"raw_data":{},"normalized_data":{"sku":"RAW-PROD-001","lot_number":"RAW-LATE","expiry_date":"2028-01-01","current_quantity":"0.1","unit":"กิโลกรัม"}}
    ]'::jsonb
  )
`);
await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select public.commit_production_import('${rollbackImport.rows[0].id}')
  `),
  'IMPORT_LOT_ALREADY_EXISTS'
);
const rollbackImportEvidence = await db.query(`
  select
    (select count(*)::int from public.inventory_lots where lot_number='RAW-ROLLBACK-NEW') new_lot,
    (select status from public.import_batches where id='${rollbackImport.rows[0].id}') batch_status,
    (select count(*)::int from public.import_rows where import_batch_id='${rollbackImport.rows[0].id}' and validation_status='imported') imported_rows
`);
assert.deepEqual(rollbackImportEvidence.rows[0], {
  new_lot: 0, batch_status: 'validated', imported_rows: 0
});

await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select * from public.open_production_order(
      '${productionRequest.rows[0].id}','${productionFormula.rows[0].id}',null
    )
  `),
  'PRODUCTION_DEPARTMENT_REQUIRED'
);
const productionOrder = await asUser(USER_PRODUCTION, `
  select * from public.open_production_order(
    '${productionRequest.rows[0].id}','${productionFormula.rows[0].id}',null
  )
`);
assert.match(productionOrder.rows[0].production_order_no, /^PO-CHANANYA-\d{8}-\d{8}$/);
assert.equal(Number(productionOrder.rows[0].planned_quantity), 12);
const productionOrderRetry = await asUser(USER_PRODUCTION, `
  select * from public.open_production_order(
    '${productionRequest.rows[0].id}','${productionFormula.rows[0].id}',null
  )
`);
assert.equal(productionOrderRetry.rows[0].id, productionOrder.rows[0].id);

await asUser(USER_PRODUCTION, `
  select public.issue_production_materials_fefo('${productionOrder.rows[0].id}')
`);
const issuedFefo = await db.query(`
  select l.lot_number,i.issued_quantity,l.current_quantity
  from public.production_material_issues i
  join public.inventory_lots l on l.id=i.inventory_lot_id
  where i.production_order_id='${productionOrder.rows[0].id}'
  order by l.expiry_date
`);
assert.deepEqual(issuedFefo.rows.map(row => ({
  lot_number: row.lot_number,
  issued_quantity: Number(row.issued_quantity),
  current_quantity: Number(row.current_quantity)
})), [
  { lot_number: 'RAW-EARLY', issued_quantity: 0.6, current_quantity: 0 },
  { lot_number: 'RAW-LATE', issued_quantity: 0.6, current_quantity: 0.4 }
]);
const issueEvidenceBeforeRetry = await db.query(`
  select
    (select count(*)::int from public.production_material_issues where production_order_id='${productionOrder.rows[0].id}') issues,
    (select count(*)::int from public.stock_movements where reference_type='production_material_issue') movements
`);
await asUser(USER_PRODUCTION, `
  select public.issue_production_materials_fefo('${productionOrder.rows[0].id}')
`);
const issueEvidenceAfterRetry = await db.query(`
  select
    (select count(*)::int from public.production_material_issues where production_order_id='${productionOrder.rows[0].id}') issues,
    (select count(*)::int from public.stock_movements where reference_type='production_material_issue') movements
`);
assert.deepEqual(issueEvidenceAfterRetry.rows[0], issueEvidenceBeforeRetry.rows[0]);

const completedProduction = await asUser(USER_PRODUCTION, `
  select * from public.complete_production_order(
    '${productionOrder.rows[0].id}',11.5,0.3,0.2
  )
`);
assert.equal(completedProduction.rows[0].status, 'awaiting_qc');
assert.equal(Number(completedProduction.rows[0].yield_percent), 95.83);
const completedProductionRetry = await asUser(USER_PRODUCTION, `
  select * from public.complete_production_order(
    '${productionOrder.rows[0].id}',11.5,0.3,0.2
  )
`);
assert.equal(completedProductionRetry.rows[0].id, completedProduction.rows[0].id);

await db.exec(`
  update public.production_orders
  set produced_by='${USER_QUALITY}'
  where id='${productionOrder.rows[0].id}'
`);
await expectDatabaseError(
  asUser(USER_QUALITY, `
    select public.quality_release_production_order(
      '${productionOrder.rows[0].id}','ผ่านข้อกำหนดการทดสอบ',
      'SAMPLE-001','ลักษณะปกติ',5.1,0.45,11.5
    )
  `),
  'QC_INDEPENDENCE_REQUIRED'
);
await db.exec(`
  update public.production_orders
  set produced_by='${USER_PRODUCTION}'
  where id='${productionOrder.rows[0].id}'
`);

await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select public.quality_release_production_order(
      '${productionOrder.rows[0].id}','ผ่านข้อกำหนดการทดสอบ',
      'SAMPLE-001','ลักษณะปกติ',5.1,0.45,11.5
    )
  `),
  'QUALITY_DEPARTMENT_REQUIRED'
);
await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select public.release_production_order(
      '${productionOrder.rows[0].id}','ผ่านข้อกำหนดการทดสอบ',
      'SAMPLE-001','ลักษณะปกติ',5.1,0.45,11.5
    )
  `),
  'permission denied'
);
const releasedProduction = await asUser(USER_QUALITY, `
  select public.quality_release_production_order(
    '${productionOrder.rows[0].id}','ผ่านข้อกำหนดการทดสอบ',
    'SAMPLE-001','ลักษณะปกติ',5.1,0.45,11.5
  ) result
`);
assert.equal(releasedProduction.rows[0].result.status, 'released');
assert.equal(Number(releasedProduction.rows[0].result.received_quantity), 11.5);
const releaseRetry = await asUser(USER_QUALITY, `
  select public.quality_release_production_order(
    '${productionOrder.rows[0].id}','ผ่านข้อกำหนดการทดสอบ',
    'SAMPLE-001','ลักษณะปกติ',5.1,0.45,11.5
  ) result
`);
assert.equal(releaseRetry.rows[0].result.inventory_lot_id, releasedProduction.rows[0].result.inventory_lot_id);
const releaseEvidence = await db.query(`
  select
    (select status from public.production_requests where id='${productionRequest.rows[0].id}') request_status,
    (select status from public.dispensing_orders where id='${productionPrescription.rows[0].dispensing_order_id}') dispensing_status,
    (select count(*)::int from public.production_qc where production_order_id='${productionOrder.rows[0].id}') qc_rows,
    (select count(*)::int from public.finished_goods_receipts where production_order_id='${productionOrder.rows[0].id}') receipts,
    (select current_quantity from public.inventory_lots where id='${releasedProduction.rows[0].result.inventory_lot_id}') finished_quantity
`);
assert.deepEqual({
  ...releaseEvidence.rows[0],
  finished_quantity: Number(releaseEvidence.rows[0].finished_quantity)
}, {
  request_status: 'fulfilled', dispensing_status: 'waiting',
  qc_rows: 1, receipts: 1, finished_quantity: 11.5
});

// Deliberately under-stock the next order. The first FEFO insert would occur
// before the shortage is discovered; the raised exception must roll it back.
const rollbackPrescription = await asUser(USER_A, `
  select * from public.create_atomic_prescription_handoff(
    '${PRODUCTION_ROLLBACK_RX_REQUEST}','${encounterA}',
    'ทดสอบ rollback เมื่อวัตถุดิบไม่พอ',
    '[{"product_id":"${departmentProduct.rows[0].id}","quantity_prescribed":10,"unit":"แคปซูล"}]'::jsonb
  )
`);
const rollbackItem = await db.query(`
  select id from public.prescription_items
  where prescription_id='${rollbackPrescription.rows[0].prescription_id}'
`);
const rollbackRequest = await asUser(USER_PHARMACY, `
  select * from public.create_production_request(
    '${PRODUCTION_ROLLBACK_REQUEST_KEY}',
    '${rollbackPrescription.rows[0].dispensing_order_id}',
    '${rollbackItem.rows[0].id}',10,'แคปซูล',null,'normal','rollback test'
  )
`);
const rollbackOrder = await asUser(USER_PRODUCTION, `
  select * from public.open_production_order(
    '${rollbackRequest.rows[0].id}','${productionFormula.rows[0].id}',null
  )
`);
await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    select public.issue_production_materials_fefo('${rollbackOrder.rows[0].id}')
  `),
  'PRODUCTION_MATERIAL_INSUFFICIENT'
);
const rollbackEvidence = await db.query(`
  select
    (select count(*)::int from public.production_material_issues where production_order_id='${rollbackOrder.rows[0].id}') issues,
    (select status from public.production_orders where id='${rollbackOrder.rows[0].id}') order_status,
    (select current_quantity from public.inventory_lots where lot_number='RAW-LATE') remaining
`);
assert.deepEqual({
  ...rollbackEvidence.rows[0],
  remaining: Number(rollbackEvidence.rows[0].remaining)
}, { issues: 0, order_status: 'planned', remaining: 0.4 });
await expectDatabaseError(
  asUser(USER_PRODUCTION, `
    insert into public.stock_movements(
      inventory_lot_id,movement_type,quantity,direction
    ) values ('${releasedProduction.rows[0].result.inventory_lot_id}','adjustment',1,'in')
  `),
  'permission denied'
);

const productionAudit = await db.query(`
  select action,count(*)::int count
  from public.audit_logs
  where action in (
    'create_production_request','open_production_order',
    'issue_production_materials_fefo','complete_production_order',
    'quality_release_production_order','stage_production_import','commit_production_import'
  )
  group by action
  order by action
`);
assert.deepEqual(productionAudit.rows, [
  { action: 'commit_production_import', count: 1 },
  { action: 'complete_production_order', count: 1 },
  { action: 'create_production_request', count: 2 },
  { action: 'issue_production_materials_fefo', count: 1 },
  { action: 'open_production_order', count: 2 },
  { action: 'quality_release_production_order', count: 1 },
  { action: 'stage_production_import', count: 2 }
]);

await expectDatabaseError(
  asUser(USER_PHARMACY, `
    select public.export_clinic_backup_domain(
      '00000000-0000-0000-0000-000000000001','patients'
    )
  `),
  'permission denied'
);
const backupPayload = await asService(`
  select public.export_clinic_backup_domain(
    '00000000-0000-0000-0000-000000000001','products'
  ) payload
`);
assert.equal(backupPayload.rows[0].payload.format, 'chananya-domain-export/v1');
assert.equal(backupPayload.rows[0].payload.domain, 'products');
assert.ok(backupPayload.rows[0].payload.data.products.length >= 2);
assert.equal(backupPayload.rows[0].payload.schema_version, '2026-08-31.1');
for (const table of [
  'services','price_lists','price_list_items','products','suppliers','inventory_lots',
  'stock_movements','formulas','formula_components','production_requests',
  'production_orders','production_material_issues','production_qc',
  'finished_goods_receipts','import_batches','import_rows'
]) {
  assert.ok(Array.isArray(backupPayload.rows[0].payload.data[table]), `${table} must be exported as an array`);
}
assert.equal(backupPayload.rows[0].payload.data.production_orders.length, 2);
assert.equal(backupPayload.rows[0].payload.data.finished_goods_receipts.length, 1);
assert.equal(backupPayload.rows[0].payload.data.production_material_issues.length, 2);

const transactionBackup = await asService(`
  select public.export_clinic_backup_domain(
    '00000000-0000-0000-0000-000000000001','transactions'
  ) payload
`);
assert.equal(transactionBackup.rows[0].payload.domain, 'transactions');
assert.equal(transactionBackup.rows[0].payload.schema_version, '2026-08-31.1');
for (const table of [
  'audit_logs','clinical_record_audit_events','appointment_events',
  'patient_identity_events','invoices','invoice_items','payments',
  'line_oa_webhook_events','line_oa_notification_outbox','line_oa_delivery_events',
  'clinic_subscription_control_events'
]) {
  assert.ok(Array.isArray(transactionBackup.rows[0].payload.data[table]), `${table} must be exported as an array`);
}
assert.ok(transactionBackup.rows[0].payload.data.audit_logs.length > 0);
assert.ok(
  transactionBackup.rows[0].payload.data.audit_logs.every(
    row => row.clinic_id === '00000000-0000-0000-0000-000000000001'
  ),
  'transaction audit export must not cross the active clinic tenant'
);

const patientBackup = await asService(`
  select public.export_clinic_backup_domain(
    '00000000-0000-0000-0000-000000000001','patients'
  ) payload
`);
for (const table of [
  'patients','patient_allergies','appointments','encounters','vital_signs',
  'clinical_examination_findings','ttm_opd_histories','ttm_diagnostic_contexts',
  'ttm_structured_diagnoses','ttm_encounter_concepts','body_pain_points',
  'clinical_treatment_plans','treatment_orders','treatment_sessions',
  'clinical_treatment_sessions','clinical_followup_notes','clinical_record_signoffs',
  'patient_identity_links','encounter_identity_verifications',
  'line_oa_contacts','line_oa_notification_preferences'
]) {
  assert.ok(Array.isArray(patientBackup.rows[0].payload.data[table]), `${table} must be exported as an array`);
}
assert.deepEqual(
  [...patientBackup.rows[0].payload.included_tables].sort(),
  Object.keys(patientBackup.rows[0].payload.data).sort(),
  'backup included_tables must exactly describe the encrypted payload'
);
assert.match(patientBackup.rows[0].payload.recovery_model.full_database_restore, /managed database backup or PITR required/i);

const backupContract = await asUser(USER_C, `select * from public.backup_restore_contract_healthcheck()`);
assert.equal(backupContract.rows[0].ready, true);
assert.equal(backupContract.rows[0].schema_version, '2026-08-31.1');
const restoreTrace = await asService(`
  select public.verify_clinic_restore_trace(
    '00000000-0000-0000-0000-000000000001'
  ) trace
`);
assert.equal(restoreTrace.rows[0].trace.ready, true);
assert.equal(restoreTrace.rows[0].trace.schema_version, '2026-08-31.1');
assert.equal(restoreTrace.rows[0].trace.referential_integrity_anomalies, 0);

await asUser(USER_C, `
  select public.admin_set_staff_membership_active(
    '${USER_A}',false,'Behavioral account disable test'
  )
`);
const disabledContext = await asUser(USER_A, `select * from public.current_access_context()`);
assert.equal(disabledContext.rows.length, 0, 'disabled membership retained an access context');
const disabledClinical = await asUser(USER_A, `select public.department_can('clinical') allowed`);
assert.equal(disabledClinical.rows[0].allowed, false, 'existing JWT retained clinical access after membership disable');
await asUser(USER_C, `
  select public.admin_set_staff_membership_active(
    '${USER_A}',true,'Restore synthetic practitioner membership'
  )
`);
const restoredContext = await asUser(USER_A, `select * from public.current_access_context()`);
assert.equal(restoredContext.rows[0].ready, true, 'synthetic practitioner was not reactivated');

const backupSlot = '2026-08-27T20:00:00Z';
const firstBackupLease = await asService(`
  select * from public.begin_backup_export_run(
    '00000000-0000-0000-0000-000000000001','${backupSlot}','test-run-1'
  )
`);
assert.equal(firstBackupLease.rows[0].acquired, true);
const duplicateBackupLease = await asService(`
  select * from public.begin_backup_export_run(
    '00000000-0000-0000-0000-000000000001','${backupSlot}','test-run-2'
  )
`);
assert.equal(duplicateBackupLease.rows[0].acquired, false);
await asService(`
  select public.complete_backup_export_run(
    '${firstBackupLease.rows[0].run_id}','completed',
    '{"products":2}'::jsonb,'[{"domain":"products","sha256":"test"}]'::jsonb,null
  )
`);
const completedBackupLease = await asService(`
  select * from public.begin_backup_export_run(
    '00000000-0000-0000-0000-000000000001','${backupSlot}','test-run-3'
  )
`);
assert.equal(completedBackupLease.rows[0].acquired, false);

// Ten fully synthetic account journeys exercise the exact operational handoff
// the release candidate must support: Practitioner -> Pharmacy FEFO -> Billing
// -> full payment/Encounter closure. No production or human data is used.
const demoCases = SYNTHETIC_UAT_CASES;
const uatResults = [];

for (const [index, demo] of demoCases.entries()) {
  const sku = `UAT-TTM-${String(index + 1).padStart(3, '0')}`;
  const product = await asUser(USER_PHARMACY, `
    select * from public.upsert_product_master(
      null,${sqlQuote(sku)},${sqlQuote(demo.product)},null,'medicine','demo',
      'ขวด','ขวด','ขวด',1,25,0,0
    )
  `);
  const productId = product.rows[0].id;
  const lots = await asService(`
    insert into public.inventory_lots(
      clinic_id,product_id,lot_number,expiry_date,received_quantity,
      current_quantity,unit,purchase_cost,status
    ) values
      ('00000000-0000-0000-0000-000000000001','${productId}',${sqlQuote(`${demo.id}-FEFO-1`)},current_date+30,1,1,'ขวด',25,'active'),
      ('00000000-0000-0000-0000-000000000001','${productId}',${sqlQuote(`${demo.id}-FEFO-2`)},current_date+180,20,20,'ขวด',25,'active')
    returning id,lot_number,expiry_date,current_quantity
  `);

  const patient = await asUser(USER_A, `
    select (public.upsert_patient_registration(
      null,${sqlQuote(demo.prefix)},${sqlQuote(demo.first)},${sqlQuote(demo.last)},
      null,${sqlQuote(demo.gender)},${sqlQuote(demo.dob)},null,null,null,null,
      'ไม่มี — ข้อมูลสังเคราะห์'
    )).*;
  `);
  const encounter = await asUser(USER_A, `
    select * from public.start_manual_patient_encounter(
      '${patient.rows[0].id}','manual_hn',true,null,${sqlQuote(demo.symptom)},
      '{"pulse":72,"pain_before":3}'::jsonb
    )
  `);
  await asUser(USER_A, `
    select public.save_ttm_diagnosis_atomic(
      p_encounter_id => '${encounter.rows[0].encounter_id}',
      p_dhatu_samutthan => 'วาโย',
      p_present_constitution => ${sqlQuote(demo.dosha)},
      p_analysis_summary => ${sqlQuote(`Synthetic UAT ${demo.id}: ${demo.symptom}`)},
      p_thai_diagnosis => ${sqlQuote(demo.diagnosis)},
      p_dosha_state => ${sqlQuote(demo.dosha)},
      p_practitioner_confirmed => true,
      p_knowledge_version => 'TTM-DEMO-UAT-v1'
    ) diagnosis_id
  `);

  const rxRequestKey = randomUUID();
  const prescriptionPayload = JSON.stringify([{
    product_id: productId,
    quantity_prescribed: demo.qty,
    unit: 'ขวด',
    dose: 'ตามฉลากสาธิต',
    frequency: 'demo only',
    duration: 'demo only',
    instructions: 'ข้อมูลสังเคราะห์ ห้ามใช้เป็นคำแนะนำการรักษา'
  }]);
  const prescription = await asUser(USER_A, `
    select * from public.create_atomic_prescription_handoff(
      '${rxRequestKey}','${encounter.rows[0].encounter_id}',
      ${sqlQuote(`${demo.id} synthetic practitioner handoff`)},
      ${sqlQuote(prescriptionPayload)}::jsonb
    )
  `);

  if (index === 0) {
    await expectDatabaseError(
      asUser(USER_A, `
        select public.transition_atomic_prescription_dispensing(
          '${prescription.rows[0].dispensing_order_id}','review','[]'::jsonb,null
        )
      `),
      'PHARMACY_DEPARTMENT_REQUIRED'
    );
  }

  await asUser(USER_PHARMACY, `
    select public.transition_atomic_prescription_dispensing(
      '${prescription.rows[0].dispensing_order_id}','review','[]'::jsonb,
      'Synthetic UAT pharmacist review'
    )
  `);
  const prescriptionItems = await asUser(USER_PHARMACY, `
    select id,product_id,quantity_prescribed,unit
    from public.prescription_items
    where prescription_id='${prescription.rows[0].prescription_id}'
    order by created_at,id
  `);
  assert.equal(prescriptionItems.rows.length, 1);
  const pricePayload = JSON.stringify([{
    prescription_item_id: prescriptionItems.rows[0].id,
    unit_price: demo.price
  }]);
  const dispensed = await asUser(USER_PHARMACY, `
    select public.transition_atomic_prescription_dispensing(
      '${prescription.rows[0].dispensing_order_id}','dispense',
      ${sqlQuote(pricePayload)}::jsonb,'Synthetic UAT FEFO dispense'
    ) result
  `);
  assert.equal(dispensed.rows[0].result.status, 'dispensed');
  if (demo.qty > 1) assert.equal(dispensed.rows[0].result.allocation_count, 2);

  const dispenseRetry = await asUser(USER_PHARMACY, `
    select public.transition_atomic_prescription_dispensing(
      '${prescription.rows[0].dispensing_order_id}','dispense',
      ${sqlQuote(pricePayload)}::jsonb,'Synthetic UAT retry'
    ) result
  `);
  assert.equal(dispenseRetry.rows[0].result.idempotent, true);

  await asUser(USER_PHARMACY, `
    select public.transition_atomic_prescription_dispensing(
      '${prescription.rows[0].dispensing_order_id}','submit_billing',
      '[]'::jsonb,'Synthetic UAT checkout handoff'
    )
  `);

  if (index === 0) {
    await expectDatabaseError(
      asUser(USER_PHARMACY, `
        select * from public.issue_atomic_dispensing_invoice(
          '${prescription.rows[0].dispensing_order_id}',${demo.serviceFee},${demo.discount}
        )
      `),
      'PERMISSION_DENIED'
    );
  }

  const invoice = await asUser(USER_BILLING, `
    select * from public.issue_atomic_dispensing_invoice(
      '${prescription.rows[0].dispensing_order_id}',${demo.serviceFee},${demo.discount}
    )
  `);
  const grandTotal = Number(invoice.rows[0].grand_total);
  assert.equal(grandTotal, demo.qty * demo.price + demo.serviceFee - demo.discount);
  const payment = await asUser(USER_BILLING, `
    select * from public.record_atomic_invoice_payment(
      '${randomUUID()}','${invoice.rows[0].invoice_id}',${grandTotal},
      ${sqlQuote(demo.channel)},${sqlQuote(`${demo.id}-FULL-PAYMENT`)}
    )
  `);
  assert.equal(payment.rows[0].invoice_status, 'paid');
  assert.equal(payment.rows[0].encounter_closed, true);

  const evidence = await db.query(`
    select
      p.hn,e.encounter_no,e.status encounter_status,
      dx.thai_diagnosis,rx.prescription_no,d.queue_number,d.status dispensing_status,
      i.invoice_number,i.grand_total,i.status invoice_status,
      pay.payment_reference,pay.channel payment_channel,pay.amount payment_amount,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'lot_number',l.lot_number,
          'expiry_date',l.expiry_date,
          'quantity_dispensed',di.quantity_dispensed,
          'unit_price',di.unit_price
        ) order by l.expiry_date,l.lot_number)
        from public.dispensing_items di
        join public.inventory_lots l on l.id=di.inventory_lot_id
        where di.dispensing_order_id=d.id
      ),'[]'::jsonb) allocations,
      coalesce((
        select jsonb_agg(a.action order by a.occurred_at,a.id)
        from public.audit_logs a
        where a.entity_id in (
          rx.id::text,d.id::text,i.id::text,pay.id::text
        )
      ),'[]'::jsonb) audit_actions
    from public.patients p
    join public.encounters e on e.patient_id=p.id
    join public.ttm_structured_diagnoses dx on dx.encounter_id=e.id
    join public.prescriptions rx on rx.encounter_id=e.id
    join public.dispensing_orders d on d.prescription_id=rx.id
    join public.invoices i on i.source_dispensing_order_id=d.id
    join public.payments pay on pay.invoice_id=i.id
    where p.id='${patient.rows[0].id}'
      and e.id='${encounter.rows[0].encounter_id}'
  `);
  assert.equal(evidence.rows.length, 1);
  assert.equal(evidence.rows[0].encounter_status, 'closed');
  assert.equal(evidence.rows[0].dispensing_status, 'billed');
  assert.equal(evidence.rows[0].invoice_status, 'paid');
  assert.equal(evidence.rows[0].allocations.length, demo.qty > 1 ? 2 : 1);
  assert.ok(evidence.rows[0].audit_actions.includes('create_prescription_handoff'));
  assert.ok(evidence.rows[0].audit_actions.includes('dispense_prescription_order'));
  assert.ok(evidence.rows[0].audit_actions.includes('record_invoice_payment'));

  uatResults.push({
    case_id: demo.id,
    synthetic_only: true,
    patient_name: `${demo.prefix}${demo.first} ${demo.last}`,
    hn: evidence.rows[0].hn,
    symptom: demo.symptom,
    thai_diagnosis: evidence.rows[0].thai_diagnosis,
    product_sku: sku,
    product_name: demo.product,
    quantity: demo.qty,
    unit: 'ขวด',
    unit_price: demo.price,
    service_fee: demo.serviceFee,
    discount: demo.discount,
    expected_total: demo.qty * demo.price + demo.serviceFee - demo.discount,
    practitioner_account: 'practitioner@example.test',
    pharmacy_account: 'pharmacy@example.test',
    billing_account: 'billing@example.test',
    encounter_no: evidence.rows[0].encounter_no,
    prescription_no: evidence.rows[0].prescription_no,
    queue_number: evidence.rows[0].queue_number,
    lot_allocations: evidence.rows[0].allocations,
    invoice_number: evidence.rows[0].invoice_number,
    grand_total: Number(evidence.rows[0].grand_total),
    payment_reference: evidence.rows[0].payment_reference,
    payment_channel: evidence.rows[0].payment_channel,
    final_status: `${evidence.rows[0].encounter_status}/${evidence.rows[0].invoice_status}`,
    audit_actions: evidence.rows[0].audit_actions
  });
}

assert.equal(uatResults.length, 10);
const uatReport = {
  schema_version: 'chananya-synthetic-uat/v1',
  generated_at: new Date().toISOString(),
  source_revision: process.env.CHANANYA_SOURCE_REVISION || 'working-tree',
  environment: 'isolated-pglite-postgresql-behavioral-test',
  production_data_touched: false,
  disclaimer: 'All identities, symptoms, diagnoses and products are synthetic. Medicines are test labels and are not clinical recommendations.',
  workflow: ['practitioner','prescription','pharmacy_review','fefo_dispense','billing','full_payment','encounter_closed'],
  role_denials_verified: ['practitioner_cannot_dispense','pharmacy_cannot_issue_invoice'],
  summary: {
    total_cases: uatResults.length,
    passed_cases: uatResults.filter(item => item.final_status === 'closed/paid').length,
    failed_cases: uatResults.filter(item => item.final_status !== 'closed/paid').length,
    total_billed: uatResults.reduce((total,item) => total + item.grand_total,0)
  },
  cases: uatResults
};
assert.deepEqual(uatReport.summary, {
  total_cases: 10,
  passed_cases: 10,
  failed_cases: 0,
  total_billed: uatResults.reduce((total,item) => total + item.grand_total,0)
});
if (process.env.CHANANYA_UAT_REPORT_PATH) {
  const reportPath = path.resolve(process.env.CHANANYA_UAT_REPORT_PATH);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(uatReport,null,2)}\n`, 'utf8');
}
console.log(
  `Synthetic 10-case Practitioner -> Pharmacy -> Checkout UAT passed: ${uatReport.summary.passed_cases}/10, billed THB ${uatReport.summary.total_billed.toFixed(2)}`
);

const auditEvents = await db.query(`
  select event_type,count(*)::int count
  from public.patient_identity_events
  group by event_type
  order by event_type
`);
assert.ok(
  auditEvents.rows.some(row => row.event_type === 'PATIENT_IDENTITY_CONFIRMED')
);

for (const statement of [
  `delete from public.patient_identity_events where id=(select min(id) from public.patient_identity_events)`,
  `update public.encounter_identity_verifications set verification_note='tampered' where encounter_id='${encounterA}'`,
  `delete from public.audit_logs where entity_id='${encounterA}'`
]) {
  await expectDatabaseError(db.query(statement), 'APPEND_ONLY_RECORD_MUTATION_DENIED');
}

await db.close();
console.log(
  'PostgreSQL behavioral smoke passed: consent, HN, LINE identity/OA callback, clinical outcomes, atomic clinical/billing/production handoffs, department/RLS boundaries, FEFO, QC release, idempotency, encrypted-export leases, rollback, no-phone fallback and tenant isolation'
);
