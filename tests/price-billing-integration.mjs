import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const migration = await fs.readFile(new URL('../supabase/migrations/20260926091000_enforce_server_price_snapshots.sql', import.meta.url), 'utf8');
assert.match(migration, /resolve_price_master_item\(/u);
assert.match(migration, /TREATMENT_DURATION_REQUIRED/u);
assert.match(migration, /TREATMENT_PRICE_MISMATCH/u);
assert.match(migration, /price_list_version/u);

// This is an isolated executable SQL harness for the price boundary. It uses
// the same resolver and trigger shape as production, with a tenant GUC standing
// in for current_clinic_id() so no patient or live database writes are needed.
const db = new PGlite();
await db.exec(`
  create schema cnyos_billing_internal;
  create table clinics(id uuid primary key);
  create table products(id uuid primary key, clinic_id uuid not null, dispense_unit text not null default 'ชิ้น', active boolean not null default true);
  create table prescription_items(id uuid primary key, product_id uuid not null);
  create table price_list_items(
    id uuid primary key, clinic_id uuid not null, product_id uuid not null,
    price numeric(18,2) not null, price_list_version bigint not null default 1
  );
  create table dispensing_items(
    id uuid primary key, product_id uuid not null, prescription_item_id uuid, unit text default 'ชิ้น', unit_price numeric(18,2),
    price_list_id uuid, price_list_version bigint, price_list_item_id uuid,
    price_item_version bigint
  );
  create table pharmacy_counter_sale_items(
    id uuid primary key, product_id uuid not null, unit_price numeric(18,2),
    price_list_id uuid, price_list_version bigint, price_list_item_id uuid
  );
  create or replace function current_clinic_id() returns uuid language sql stable as $$
    select nullif(current_setting('cnyos.clinic', true),'')::uuid
  $$;
  create or replace function resolve_price_master_item(p_item_type text, p_product_id uuid default null, p_service_id uuid default null, p_as_of date default current_date, p_customer_type text default null)
  returns table(price_list_id uuid, price_list_version bigint, item_id uuid, unit_code text, unit_price numeric, item_version bigint)
  language sql stable as $$
    select null::uuid, i.price_list_version, i.id, 'unit', i.price, i.price_list_version
      from price_list_items i
     where i.clinic_id=current_clinic_id() and i.product_id=p_product_id
     limit 1
  $$;
`);

const triggerSql = migration.slice(
  migration.indexOf('create or replace function public.enforce_product_price_snapshot()'),
  migration.indexOf('revoke all on function public.enforce_product_price_snapshot()')
).replaceAll('public.resolve_price_master_item', 'resolve_price_master_item')
  .replace('public.enforce_product_price_snapshot()', 'enforce_product_price_snapshot()')
  .replace('set search_path = pg_catalog, public, pg_temp', 'set search_path = public');
await db.exec(triggerSql);
await db.exec(`
  create trigger dispensing_price_boundary before insert or update of unit_price, prescription_item_id
  on dispensing_items for each row execute function enforce_product_price_snapshot();
  create trigger counter_price_boundary before insert or update of unit_price, product_id
  on pharmacy_counter_sale_items for each row execute function enforce_product_price_snapshot();
  insert into clinics values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
  insert into products(id,clinic_id,active) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',true),
                                                   ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',true);
  insert into price_list_items values ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',150,7);
  insert into prescription_items values ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
                                        ('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001');
  set cnyos.clinic = '00000000-0000-0000-0000-000000000001';
`);

await db.exec(`insert into dispensing_items(id,product_id,prescription_item_id,unit_price) values ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',150)`);
const snap = await db.query('select unit_price, price_list_version, price_list_item_id from dispensing_items');
assert.deepEqual(snap.rows[0], { unit_price: '150.00', price_list_version: 7, price_list_item_id: '30000000-0000-0000-0000-000000000001' });

await assert.rejects(
  db.exec(`insert into dispensing_items(id,product_id,prescription_item_id,unit_price) values ('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',149)`),
  /PRICE_MISMATCH/
);
await assert.rejects(
  db.exec(`insert into dispensing_items(id,product_id,prescription_item_id,unit_price) values ('40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002',150)`),
  /PRICE_REQUIRED|PRICE_PRODUCT_REQUIRED/
);
await db.exec(`update price_list_items set price=175, price_list_version=8;`);
await assert.rejects(
  db.exec(`insert into dispensing_items(id,product_id,prescription_item_id,unit_price) values ('40000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',150)`),
  /PRICE_MISMATCH/
);
const oldSnapshot = await db.query('select unit_price, price_list_version from dispensing_items where id=$1', ['40000000-0000-0000-0000-000000000001']);
assert.deepEqual(oldSnapshot.rows[0], { unit_price: '150.00', price_list_version: 7 });
console.log('Price/billing integration SQL boundary passed: tenant scope, missing/mismatched prices, and immutable snapshots');

// Execute the real migration stack as well: no synthetic resolver replacement
// is used for the treatment quote/session boundary.
const live = await createPriceMasterFixture();
const { db: liveDb, ids: liveIds, asUser: liveAsUser, asOwner: liveAsOwner } = live;
const liveSetup = (await liveAsUser(liveIds.owner, `select * from public.setup_price_master_default()`)).rows[0];
const patientId = '66666666-6666-4666-a666-666666666666';
const encounterId = '77777777-7777-4777-a777-777777777777';
await liveAsOwner(`select set_config('request.jwt.claim.sub','${liveIds.owner}',false)`);
await liveDb.query(`insert into public.patients(id,hn,first_name,last_name,created_by)
  values ('${patientId}','PRICE-HN-0001','Price','Fixture','${liveIds.owner}')`);
await liveDb.query(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
  values ('${encounterId}','PRICE-ENC-0001','${patientId}','${liveIds.clinicA}','draft','${liveIds.userA}','${liveIds.userA}')`);
const noSessionQuote = await liveAsUser(liveIds.owner, `select * from public.quote_treatment_invoice('${encounterId}')`);
assert.deepEqual(noSessionQuote.rows[0], {
  amount: '0', duration_minutes: 0, unit_price: '0',
  description: 'ไม่มีค่าบริการรักษา', item_id: null, item_version: null
});
await liveAsUser(liveIds.userA, `select * from public.create_clinical_treatment_session(
  '${encounterId}', array['massage'], 'Synthetic completed session', false, null, null,
  null, null, 'Completed', null, 45
)`);
const sessionQuote = await liveAsUser(liveIds.owner, `select * from public.quote_treatment_invoice('${encounterId}')`);
assert.equal(Number(sessionQuote.rows[0].amount), 487.5);
assert.equal(sessionQuote.rows[0].duration_minutes, 45);
await assert.rejects(
  liveAsUser(liveIds.userB, `select * from public.quote_treatment_invoice('${encounterId}')`),
  /ENCOUNTER_NOT_FOUND|PERMISSION_DENIED/
);
await liveAsOwner(`update public.clinical_treatment_sessions set duration_minutes=null where encounter_id='${encounterId}'`);
await assert.rejects(
  liveAsUser(liveIds.owner, `select * from public.quote_treatment_invoice('${encounterId}')`),
  /TREATMENT_DURATION_REQUIRED/
);
const amended = await liveAsUser(liveIds.userA, `select * from public.amend_treatment_session_duration(
  (select id from public.clinical_treatment_sessions where encounter_id='${encounterId}'),45,null,'Recovery of recorded duration'
)`);
assert.equal(amended.rows[0].duration_minutes, 45);
await liveAsOwner(`select set_config('request.jwt.claim.sub','${liveIds.owner}',false)`);
await liveDb.query(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
  values ('${encounterId}','complete_record','${liveIds.userA}','Fixture Practitioner',true)`);
await assert.rejects(
  liveAsUser(liveIds.userA, `select * from public.amend_treatment_session_duration(
    (select id from public.clinical_treatment_sessions where encounter_id='${encounterId}'),46,45,'Attempt after signoff'
  )`),
  /CLINICAL_RECORD_LOCKED/
);
const requestKey = '88888888-8888-4888-a888-888888888888';
const invoice = await liveAsUser(liveIds.owner, `select * from public.issue_atomic_treatment_invoice('${requestKey}','${encounterId}',487.50,'Treatment session')`);
assert.equal(Number(invoice.rows[0].grand_total), 487.5);
await assert.rejects(
  liveAsUser(liveIds.userA, `select * from public.amend_treatment_session_duration(
    (select id from public.clinical_treatment_sessions where encounter_id='${encounterId}'),46,45,'Attempt after billing'
  )`),
  /CLINICAL_RECORD_LOCKED|TREATMENT_SESSION_ALREADY_BILLED/
);
const retry = await liveAsUser(liveIds.owner, `select * from public.issue_atomic_treatment_invoice('${requestKey}','${encounterId}',487.50,'Treatment session')`);
assert.equal(retry.rows[0].invoice_id, invoice.rows[0].invoice_id);
await liveAsUser(liveIds.owner, `select * from public.set_price_master_item('${liveSetup.price_list_id}','service',null,'${liveSetup.service_id}'::uuid,'hour',700,1,'Price change after invoice')`);
const preserved = await liveAsUser(liveIds.owner, `select * from public.issue_atomic_treatment_invoice('${requestKey}','${encounterId}',487.50,'Treatment session')`);
assert.equal(preserved.rows[0].invoice_id, invoice.rows[0].invoice_id);
const paymentKey = randomUUID();
const partial = await liveAsUser(liveIds.owner, `select * from public.record_atomic_invoice_payment('${paymentKey}','${invoice.rows[0].invoice_id}',200,'cash','Synthetic partial payment')`);
assert.equal(Number(partial.rows[0].balance_due), 287.5);
const duplicatePayment = await liveAsUser(liveIds.owner, `select * from public.record_atomic_invoice_payment('${paymentKey}','${invoice.rows[0].invoice_id}',200,'cash','Synthetic partial payment')`);
assert.equal(duplicatePayment.rows[0].payment_id, partial.rows[0].payment_id);
const paid = await liveAsUser(liveIds.owner, `select * from public.record_atomic_invoice_payment('${randomUUID()}','${invoice.rows[0].invoice_id}',287.50,'cash','Synthetic final payment')`);
assert.equal(Number(paid.rows[0].balance_due), 0);
assert.equal(paid.rows[0].encounter_closed, true);

// Exercise actual invoice DDL precision, not floating-point arithmetic alone.
for (const [rate, expectedVersion] of [[650, 2], [10000000, 3]]) {
  await liveAsUser(liveIds.owner, `select * from public.set_price_master_item('${liveSetup.price_list_id}','service',null,'${liveSetup.service_id}'::uuid,'hour',${rate},${expectedVersion},'Precision regression fixture')`);
  for (const minutes of [1, 20, 45, 60]) {
    const id = randomUUID();
    await liveAsOwner(`select set_config('request.jwt.claim.sub','${liveIds.owner}',false)`);
    await liveDb.query(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by) values ('${id}','PRECISION-${id}','${patientId}','${liveIds.clinicA}','draft','${liveIds.userA}','${liveIds.userA}')`);
    await liveAsUser(liveIds.userA, `select * from public.create_clinical_treatment_session('${id}',array['massage'],'Precision fixture session',false,null,null,null,null,'Completed',null,${minutes})`);
    await liveAsOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record) values ('${id}','complete_record','${liveIds.userA}','Fixture Practitioner',true)`);
    const quote = (await liveAsUser(liveIds.owner, `select * from public.quote_treatment_invoice('${id}')`)).rows[0];
    assert.equal(Number(quote.amount), Math.round(rate * minutes / 60 * 100) / 100);
    const issued = (await liveAsUser(liveIds.owner, `select * from public.issue_atomic_treatment_invoice('${randomUUID()}','${id}',${quote.amount},'Precision session')`)).rows[0];
    assert.equal(Number(issued.grand_total), Number(quote.amount));
  }
}
await db.close();
await liveDb.close();
console.log('Price/billing full-migration checks passed: treatment quote/invoice, immutable prices, partial/final/idempotent payment, 1/20/45/60-minute precision, tenant and signed-amendment denial');
