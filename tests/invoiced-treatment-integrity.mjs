import assert from 'node:assert/strict';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// This is a disposable synthetic regression. The database must reject a NEW
// treatment session after an encounter already has an invoice, including the
// legacy eleven-argument compatibility RPC. A replay of the already-committed
// request must remain valid so browser retry recovery cannot strand a successful
// write.
const fixture = await createPriceMasterFixture();
const { db, ids, asUser, asOwner } = fixture;

const patientId = '9a000000-0000-4000-8000-000000000001';
const encounterId = '9a000000-0000-4000-8000-000000000002';
const secondEncounterId = '9a000000-0000-4000-8000-000000000006';
const firstRequestId = '9a000000-0000-4000-8000-000000000003';
const newRequestId = '9a000000-0000-4000-8000-000000000004';

await asUser(ids.owner, `select * from public.setup_price_master_default()`);

const idempotentCall = (requestId, detail, duration = 45) => `
  select (public.create_clinical_treatment_session_idempotent(
    '${requestId}'::uuid,
    '${encounterId}'::uuid,
    array['massage']::text[],
    '${detail}',
    false,
    null::text,
    null::text,
    4::smallint,
    2::smallint,
    'Synthetic improvement',
    'Synthetic advice',
    ${duration}::integer
  )).id as id;
`;

const legacyCall = (detail, duration = 45) => `
  select (public.create_clinical_treatment_session(
    '${encounterId}'::uuid,
    array['massage']::text[],
    '${detail}',
    false,
    null::text,
    null::text,
    4::smallint,
    2::smallint,
    'Synthetic improvement',
    'Synthetic advice',
    ${duration}::integer
  )).id as id;
`;

async function expectError(promise, pattern) {
  await assert.rejects(promise, error => pattern.test(String(error?.message || error)));
}

await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
await db.query(`
  insert into public.patients(id,hn,first_name,last_name,created_by)
  values ('${patientId}','INVOICE-GUARD-SYN-001','Synthetic','Invoice Guard','${ids.owner}')
`);
await db.query(`
  insert into public.encounters(
    id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by
  ) values (
    '${encounterId}','INVOICE-GUARD-ENC-001','${patientId}','${ids.clinicA}',
    'draft','${ids.userA}','${ids.userA}'
  )
`);
await db.query(`
  insert into public.encounters(
    id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by
  ) values (
    '${secondEncounterId}','INVOICE-GUARD-ENC-002','${patientId}','${ids.clinicA}',
    'draft','${ids.userA}','${ids.userA}'
  )
`);

const first = (await asUser(ids.userA, idempotentCall(firstRequestId, 'Initial synthetic session'))).rows[0].id;
assert.ok(first, 'authenticated practitioner must create the initial session');
assert.equal(
  (await asUser(ids.userA, idempotentCall(firstRequestId, 'Initial synthetic session'))).rows[0].id,
  first,
  'same committed request must replay the same session'
);

// The fixture uses the same production lock boundary; direct service setup is
// limited to synthetic signoff preparation so the billing path can be tested.
await asOwner(`
  insert into public.clinical_record_signoffs(
    encounter_id,record_section,signer_id,signer_name,lock_record
  ) values (
    '${encounterId}','complete_record','${ids.userA}','Synthetic Practitioner',true
  )
`);

const quote = (await asUser(ids.owner, `
  select * from public.quote_treatment_invoice('${encounterId}'::uuid)
`)).rows[0];
assert.equal(Number(quote.duration_minutes), 45);
assert.ok(Number(quote.amount) > 0);

const invoice = (await asUser(ids.owner, `
  select * from public.issue_atomic_treatment_invoice(
    '9a000000-0000-4000-8000-000000000005'::uuid,
    '${encounterId}'::uuid,
    ${quote.amount},
    'Synthetic treatment invoice'
  );
`)).rows[0];
assert.ok(invoice.invoice_id, 'synthetic treatment invoice must be issued');
const issuedSnapshot = (await asOwner(`
  select i.grand_total, i.balance_due,
         li.quantity, li.unit_price, li.line_total
    from public.invoices i
    join public.invoice_items li on li.invoice_id=i.id and li.item_type='service'
   where i.id='${invoice.invoice_id}'::uuid
`)).rows[0];
assert.equal(Number(issuedSnapshot.grand_total), Number(quote.amount));
assert.equal(Number(issuedSnapshot.balance_due), Number(quote.amount));
assert.equal(Number(issuedSnapshot.quantity), 0.75);
assert.equal(Number(issuedSnapshot.unit_price), 650);
assert.equal(Number(issuedSnapshot.line_total), Number(quote.amount));

// Admin amendment unlock is intentional test setup; it must not make a billed
// encounter writable by silently creating a second chargeable session.
await asUser(ids.superAdmin, `
  select public.unlock_clinical_record_for_amendment(
    '${encounterId}'::uuid,
    'Synthetic post-invoice amendment guard test'
  );
`);
assert.equal(
  (await asOwner(`
    select lock_record from public.clinical_record_signoffs
     where encounter_id='${encounterId}'::uuid and record_section='complete_record'
  `)).rows[0].lock_record,
  false,
  'amendment setup must actually unlock the synthetic encounter'
);

const followup = (await asUser(ids.userA, `
  insert into public.clinical_followup_notes(
    encounter_id,current_symptoms,change_from_previous,pain_score,functional_status,
    outcome_status,plan_adjustment,recorded_by
  ) values (
    '${encounterId}'::uuid,'Synthetic narrative note','No chargeable treatment change',
    3,'Synthetic functional status','improved','Continue observation','${ids.userA}'::uuid
  ) returning id
`)).rows[0];
assert.ok(followup.id, 'non-chargeable narrative amendment must remain writable after unlock');

const secondSession = (await asUser(ids.userA, `
  select * from public.create_clinical_treatment_session(
    '${secondEncounterId}'::uuid,array['massage'],'Unbilled reparenting fixture',false,
    null,null,4::smallint,2::smallint,'Synthetic improvement','Synthetic advice',45
  )
`)).rows[0];
assert.ok(secondSession.id, 'unbilled control encounter must accept a treatment session');

// Both creation paths must reject a new session after unlock when the
// encounter already has an active invoice.
await expectError(
  asUser(ids.userA, idempotentCall(newRequestId, 'Must be rejected after invoice')),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asUser(ids.userA, legacyCall('Legacy write must be rejected after invoice')),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asUser(ids.userA, `select * from public.amend_treatment_session_duration(
    '${first}'::uuid, 60, 45, 'Synthetic post-invoice duration amendment'
  )`),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asOwner(`update public.clinical_treatment_sessions
              set duration_minutes=60
            where id='${first}'::uuid`),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asOwner(`delete from public.clinical_treatment_sessions where id='${first}'::uuid`),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asOwner(`update public.clinical_treatment_sessions
              set encounter_id='${secondEncounterId}'::uuid
            where id='${first}'::uuid`),
  /TREATMENT_SESSION_ALREADY_BILLED/
);
await expectError(
  asOwner(`update public.clinical_treatment_sessions
              set encounter_id='${encounterId}'::uuid
            where id='${secondSession.id}'::uuid`),
  /TREATMENT_SESSION_ALREADY_BILLED/
);

const replay = (await asUser(ids.userA, idempotentCall(firstRequestId, 'Initial synthetic session'))).rows[0].id;
assert.equal(replay, first, 'same committed request must remain replayable after invoice and amendment unlock');
assert.equal(
  (await asOwner(`
    select count(*)::int as n from public.clinical_treatment_sessions
    where encounter_id='${encounterId}'::uuid
  `)).rows[0].n,
  1,
  'post-invoice guard must prevent a second treatment session'
);
const retainedSnapshot = (await asOwner(`
  select i.grand_total, i.balance_due,
         li.quantity, li.unit_price, li.line_total
    from public.invoices i
    join public.invoice_items li on li.invoice_id=i.id and li.item_type='service'
   where i.id='${invoice.invoice_id}'::uuid
`)).rows[0];
assert.deepEqual(retainedSnapshot, issuedSnapshot, 'invoice values must remain unchanged after rejected amendments/replay');

const prescriptionCall = (key, encounter) => `select * from public.create_atomic_prescription_handoff(
  '${key}'::uuid, '${encounter}'::uuid, 'Synthetic prescription guard',
  '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น","dose":"Synthetic"}]'::jsonb
)`;
await expectError(asUser(ids.userA, prescriptionCall(
  '9a000000-0000-4000-8000-000000000010', encounterId
)), /PRESCRIPTION_ENCOUNTER_ALREADY_BILLED/);
assert.equal((await asOwner(`select count(*)::int n from public.prescriptions
  where encounter_id='${encounterId}'`)).rows[0].n, 0,
  'a rejected post-invoice handoff must not leave a prescription');
const rxKey = '9a000000-0000-4000-8000-000000000011';
const rx = (await asUser(ids.userA, prescriptionCall(rxKey, secondEncounterId))).rows[0];
assert.ok(rx.prescription_id);
assert.ok(rx.dispensing_order_id, 'unbilled encounter still accepts atomic pharmacy handoff');
assert.deepEqual((await asUser(ids.userA, prescriptionCall(rxKey, secondEncounterId))).rows[0], rx,
  'same request replays existing prescription and queue');
for (const role of ['anon', 'authenticated', 'service_role']) {
  assert.equal((await asOwner(`select has_function_privilege('${role}',
    'public.guard_invoiced_prescription_creation()', 'EXECUTE') allowed`)).rows[0].allowed, false);
}

await db.close();
console.log('invoiced-treatment-integrity: expected post-invoice treatment guard passed');
