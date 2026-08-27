import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';
const USER_C = '44444444-4444-4444-a444-444444444444';
const CLINIC_B = '33333333-3333-4333-a333-333333333333';
const RX_REQUEST = '55555555-5555-4555-a555-555555555555';
const RX_BAD_REQUEST = '66666666-6666-4666-a666-666666666666';
const PAYMENT_PARTIAL_REQUEST = '77777777-7777-4777-a777-777777777777';
const PAYMENT_FINAL_REQUEST = '88888888-8888-4888-a888-888888888888';
const PAYMENT_OVER_REQUEST = '99999999-9999-4999-a999-999999999999';
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

async function expectDatabaseError(promise, code) {
  await assert.rejects(promise, error => String(error.message).includes(code));
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
  insert into public.products(
    id,sku,name_th,category,stock_unit,dispense_unit
  ) values (
    '${productId}','TTM-TEST-001','ยาทดสอบ','medicine','ขวด','ขวด'
  );
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
  'PostgreSQL behavioral smoke passed: consent, HN, LINE link/revocation, QR issue/resolve/consume, atomic clinical-financial handoffs, idempotency, rollback/audit, no-phone fallback and tenant isolation'
);
