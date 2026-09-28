import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const f = await createPriceMasterFixture();
const { db, ids, asUser } = f;
const owner = ids.owner;
const encounter = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const incompleteEncounter = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const patient = '66666666-6666-4666-a666-666666666666';
const rx1 = '11111111-1111-4111-a111-111111111101';
const rx2 = '22222222-2222-4222-a222-222222222202';
const order1 = '31111111-1111-4111-a111-111111111101';
const order2 = '32222222-2222-4222-a222-222222222202';

async function ownerSql(sql) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','${owner}',false), set_config('request.jwt.claim.role','service_role',false);`);
  try {
    return (sql.match(/;/g) || []).length > 1 ? await db.exec(sql) : await db.query(sql);
  } finally { await db.exec('reset role;'); }
}

const setup = (await asUser(owner, `select * from public.setup_price_master_default()`)).rows[0];
await ownerSql(`insert into public.price_list_items(clinic_id,price_list_id,item_type,product_id,unit_code,unit_price,version) values ('${ids.clinicA}','${setup.price_list_id}','product','${ids.productA}','ชิ้น',100,1) on conflict do nothing`);
const productQuote = await asUser(ids.userA, `select * from public.resolve_price_master_item('product','${ids.productA}',null,current_date,null)`);
const productPrice = productQuote.rows[0]?.unit_price;
if (!productPrice) {
  const diagnostic = await asUser(ids.userA, `select public.current_clinic_id() as clinic, p.clinic_id as product_clinic, i.clinic_id as item_clinic, i.unit_price from public.products p left join public.price_list_items i on i.product_id=p.id where p.id='${ids.productA}'`);
  assert.ok(productPrice, `fixture must provide a server-owned product price: ${JSON.stringify(productQuote)} diagnostic=${JSON.stringify(diagnostic)}`);
}
await ownerSql(`
  insert into public.patients(id,hn,first_name,last_name,created_by)
  values ('${patient}','AGG-HN-01','Aggregate','Fixture','${owner}') on conflict (id) do nothing;
  insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
  values ('${encounter}','AGG-ENC-01','${patient}','${ids.clinicA}','draft','${ids.userA}','${owner}');
  insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,prescriber_id,status)
  values ('${rx1}','AGG-RX-01','${encounter}','${patient}','${ids.userA}','completed'),
         ('${rx2}','AGG-RX-02','${encounter}','${patient}','${ids.userA}','completed');
  insert into public.prescription_items(id,prescription_id,product_id,quantity_prescribed,unit,status)
  values ('41111111-1111-4111-a111-111111111101','${rx1}','${ids.productA}',1,'ชิ้น','ordered'),
         ('42222222-2222-4222-a222-222222222202','${rx2}','${ids.productA}',1,'ชิ้น','ordered');
  insert into public.dispensing_orders(id,prescription_id,queue_number,status)
  values ('${order1}','${rx1}','Q-01','submitted_to_billing'),('${order2}','${rx2}','Q-02','submitted_to_billing');
  insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status)
  values ('51111111-1111-4111-a111-111111111101','${order1}','41111111-1111-4111-a111-111111111101',1,'ชิ้น',${productPrice},'dispensed');
  insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status)
  values ('52222222-2222-4222-a222-222222222202','${order2}','42222222-2222-4222-a222-222222222202',1,'ชิ้น',${productPrice},'dispensed');
  insert into public.clinical_treatment_sessions(encounter_id,session_no,treatment_detail,duration_minutes,practitioner_id)
  values ('${encounter}',1,'Aggregate fixture session',60,'${ids.userA}');
  insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
  values ('${encounter}','complete_record','${ids.userA}','Aggregate Fixture',true);
`);

const debugSources = await ownerSql(`select (select count(*) from public.prescription_items pi join public.prescriptions rx on rx.id=pi.prescription_id where rx.encounter_id='${encounter}') as prescribed, (select count(*) from public.dispensing_items di join public.dispensing_orders d on d.id=di.dispensing_order_id join public.prescriptions rx on rx.id=d.prescription_id where rx.encounter_id='${encounter}') as dispensed`);
assert.equal(debugSources.rows?.[0]?.dispensed ?? 0, 2, JSON.stringify(debugSources));
const quote = (await asUser(owner, `select public.quote_encounter_invoice('${encounter}')`)).rows[0].quote_encounter_invoice;
assert.equal(quote.orders.length, 2, 'quote contains every dispensing order');
assert.equal(quote.lines.filter(line => line.kind === 'service').length, 1, 'treatment service is quoted once');
assert.equal(Number(quote.medicine_total), 200, 'both medicine sets are included');
assert.equal(Number(quote.grand_total), 850, 'medicine plus one treatment charge');
assert.match(quote.quote_fingerprint, /^[0-9a-f]{64}$/);

const requestKey = randomUUID();
const issued = (await asUser(owner, `select * from public.issue_atomic_encounter_invoice('${requestKey}','${encounter}','${quote.quote_fingerprint}')`)).rows[0];
assert.equal(Number(issued.grand_total), 850);
assert.equal((await ownerSql(`select count(*)::int as n from cnyos_billing_internal.invoice_orders where invoice_id='${issued.invoice_id}'`)).rows[0].n, 2);
assert.equal((await ownerSql(`select count(*)::int as n from cnyos_billing_internal.invoice_source_charges where invoice_id='${issued.invoice_id}' and source_kind='treatment_charge'`)).rows[0].n, 1, 'service source is recorded once');
const replay = (await asUser(owner, `select * from public.issue_atomic_encounter_invoice('${requestKey}','${encounter}','${quote.quote_fingerprint}')`)).rows[0];
assert.equal(replay.invoice_id, issued.invoice_id, 'same request replays the committed invoice');
await assert.rejects(asUser(ids.userA, `select public.quote_encounter_invoice('${encounter}')`), /PERMISSION_DENIED/);
for (const role of ['anon','authenticated','service_role']) {
  assert.equal((await ownerSql(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='cnyos_billing_internal' and has_function_privilege('${role}',p.oid,'EXECUTE')`)).rows[0].n,0,
    'private billing routines have no direct runtime execute grant');
}
await assert.rejects(ownerSql(`delete from cnyos_billing_internal.invoice_orders where invoice_id='${issued.invoice_id}'`), /INVOICE_SOURCE_IMMUTABLE/);
await ownerSql(`update public.clinic_memberships set clinic_role='billing' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}'`);
await assert.rejects(asUser(ids.userB, `select public.quote_encounter_invoice('${encounter}')`), /ENCOUNTER_NOT_FOUND/);

await ownerSql(`
  insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
  values ('${incompleteEncounter}','AGG-ENC-02','${patient}','${ids.clinicA}','draft','${ids.userA}','${owner}');
  insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,status)
  values ('33333333-3333-4333-a333-333333333303','AGG-RX-03','${incompleteEncounter}','${patient}','in_pharmacy');
  insert into public.prescription_items(id,prescription_id,product_id,quantity_prescribed,unit)
  values ('43333333-3333-4333-a333-333333333303','33333333-3333-4333-a333-333333333303','${ids.productA}',1,'ชิ้น');
  insert into public.dispensing_orders(id,prescription_id,queue_number,status)
  values ('33333333-3333-4333-a333-333333333303','33333333-3333-4333-a333-333333333303','Q-03','waiting');
`);
await assert.rejects(asUser(owner, `select public.quote_encounter_invoice('${incompleteEncounter}')`), /DISPENSING_ORDER_NOT_READY_FOR_BILLING/);
await assert.rejects(asUser(ids.userB, `select public.quote_encounter_invoice('${encounter}')`), /ENCOUNTER_NOT_FOUND|PERMISSION_DENIED/);

// Queue changes preserve the total but invalidate the canonical quote.
const staleEncounter = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
await ownerSql(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,created_by) values ('${staleEncounter}','AGG-ENC-03','${patient}','${ids.clinicA}','draft','${owner}');
  insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,status) values ('33333333-3333-4333-a333-333333333304','AGG-RX-04','${staleEncounter}','${patient}','completed');
  insert into public.prescription_items(id,prescription_id,product_id,quantity_prescribed,unit) values ('43333333-3333-4333-a333-333333333304','33333333-3333-4333-a333-333333333304','${ids.productA}',1,'ชิ้น');
  insert into public.dispensing_orders(id,prescription_id,queue_number,status) values ('33333333-3333-4333-a333-333333333304','33333333-3333-4333-a333-333333333304','Q-04','submitted_to_billing');
  insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status) values ('53333333-3333-4333-a333-333333333304','33333333-3333-4333-a333-333333333304','43333333-3333-4333-a333-333333333304',1,'ชิ้น',${productPrice},'dispensed');`);
const stale = (await asUser(owner, `select public.quote_encounter_invoice('${staleEncounter}')`)).rows[0].quote_encounter_invoice;
await ownerSql(`update public.dispensing_orders set queue_number='Q-04B' where id='33333333-3333-4333-a333-333333333304'`);
await assert.rejects(asUser(owner, `select * from public.issue_atomic_encounter_invoice('${randomUUID()}','${staleEncounter}','${stale.quote_fingerprint}')`), /STALE_INVOICE_QUOTE/);

// Source allocations must reconcile to the rounded aggregate service charge.
// Two one-minute sessions at 650/hour would lose 0.01 if rounded independently.
const roundingEncounter='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4';
await ownerSql(`
  insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${roundingEncounter}','AGG-ROUND-04','${patient}','${ids.clinicA}','draft','${ids.userA}','${owner}');
  insert into public.clinical_treatment_sessions(encounter_id,session_no,treatment_detail,duration_minutes,practitioner_id)
    values('${roundingEncounter}',1,'Synthetic minute one',1,'${ids.userA}'),
          ('${roundingEncounter}',2,'Synthetic minute two',1,'${ids.userA}');
  insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
    values('${roundingEncounter}','complete_record','${ids.userA}','Synthetic',true);
`);
const roundingQuote=(await asUser(owner,`select public.quote_encounter_invoice('${roundingEncounter}') quote`)).rows[0].quote;
assert.equal(Number(roundingQuote.service_total),21.67);
const roundingInvoice=(await asUser(owner,`select * from public.issue_atomic_encounter_invoice('${randomUUID()}','${roundingEncounter}','${roundingQuote.quote_fingerprint}')`)).rows[0];
const allocations=(await ownerSql(`select count(*)::int n,sum(line_total) total from cnyos_billing_internal.invoice_source_charges where invoice_id='${roundingInvoice.invoice_id}'`)).rows[0];
assert.equal(allocations.n,2);
assert.equal(Number(allocations.total),Number(roundingInvoice.grand_total));

await db.close();
console.log('encounter-invoice-aggregation: quote, two-order issue, treatment-once, stale, replay, incompleteness, and tenant denial passed');
