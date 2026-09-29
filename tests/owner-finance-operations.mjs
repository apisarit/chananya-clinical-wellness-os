import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// Focused RLS regression: Owner financial reads are explicit and tenant-bound;
// writes remain RPC-only. The end-to-end issue/payment/replay journey is covered
// by encounter-invoice-app-integration.mjs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(path.join(root, 'supabase/migrations/20260927145517_owner_finance_select_rls.sql'), 'utf8');
for (const policy of ['invoices_read_owner_finance', 'invoice_items_read_owner_finance', 'payments_read_owner_finance']) {
  assert.match(migration, new RegExp(`create policy ${policy}`));
  assert.match(migration, new RegExp(`${policy}[\\s\\S]*array\\['owner'\\]`));
}
assert.match(migration, /for select to authenticated/gi);
assert.doesNotMatch(migration, /for all|for insert|for update|for delete/i);

const { db, ids, asUser, asOwner, asService } = await createPriceMasterFixture();
const admin = 'eeeeeeee-4444-4444-a444-444444444444';
const clinicAInvoice = 'eeeeeeee-0000-4000-8000-000000000001';
const clinicBInvoice = 'eeeeeeee-0000-4000-8000-000000000002';
const clinicAPatient = 'eeeeeeee-0000-4000-8000-000000000011';
const clinicBPatient = 'eeeeeeee-0000-4000-8000-000000000012';
const clinicAItem = 'eeeeeeee-0000-4000-8000-000000000021';
const clinicAPayment = 'eeeeeeee-0000-4000-8000-000000000031';

await asUser(ids.owner,'select * from public.setup_price_master_default()');
await asOwner('select 1');
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data)
    values ('${admin}','governance-admin@example.test','{}');
  update public.profiles set role='viewer', system_role='admin' where id='${admin}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values ('${ids.clinicA}','${admin}','viewer',true,true);
  insert into public.patients(id,hn,first_name,last_name,created_by,clinic_id)
    values
      ('${clinicAPatient}','OWNER-FIN-A','Owner','Finance','${ids.owner}','${ids.clinicA}'),
      ('${clinicBPatient}','OWNER-FIN-B','Other','Clinic','${ids.userB}','${ids.clinicB}');
  insert into public.invoices(id,invoice_number,patient_id,status,subtotal,grand_total,balance_due,created_by)
    values
      ('${clinicAInvoice}','INV-OWNER-FIN-A','${clinicAPatient}','issued',100,100,100,'${ids.owner}'),
      ('${clinicBInvoice}','INV-OWNER-FIN-B','${clinicBPatient}','issued',200,200,200,'${ids.userB}');
  select set_config('request.jwt.claim.sub','${ids.owner}',false);
  insert into public.invoice_items(id,invoice_id,item_type,description,quantity,unit_price,line_total)
    values ('${clinicAItem}','${clinicAInvoice}','service','Owner finance test',1,650,650);
  insert into public.payments(id,invoice_id,payment_reference,channel,amount,status,received_by)
    values ('${clinicAPayment}','${clinicAInvoice}','PAY-OWNER-FIN-A','cash',100,'paid','${ids.owner}');
`);

const ownerInvoice = await asUser(ids.owner, `select id from public.invoices where id in ('${clinicAInvoice}','${clinicBInvoice}') order by id`);
assert.deepEqual(ownerInvoice.rows.map(row => row.id), [clinicAInvoice], 'Owner reads only current-clinic invoices');
const ownerContext = await asUser(ids.owner, `select * from public.get_owner_invoice_context('${clinicAInvoice}')`);
const queue = await asUser(ids.owner, 'select * from public.list_owner_finance_context()');
assert.deepEqual(queue.rows.map(row => row.patient_id), [clinicAPatient]);
assert.equal(queue.rows[0].has_prescription, false);
assert.equal(queue.rows[0].encounter_id, null);
assert.deepEqual(Object.keys(queue.rows[0]).sort(), ['clinic_id','encounter_id','encounter_no','patient_id','hn','prefix','first_name','last_name','has_prescription'].sort());
const queueEncounter='eeeeeeee-0000-4000-8000-000000000041';
await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
  values('${queueEncounter}','OWNER-FIN-ENC','${clinicAPatient}','${ids.clinicA}','open','${ids.userA}')`);
await asOwner(`insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,prescriber_id,status)
  values('eeeeeeee-0000-4000-8000-000000000042','OWNER-FIN-RX','${queueEncounter}','${clinicAPatient}','${ids.userA}','pending')`);
const encounterQueue=(await asUser(ids.owner,'select * from public.list_owner_finance_context()')).rows;
assert.equal(encounterQueue.length,2);
assert.equal(encounterQueue.find(row=>row.encounter_id===queueEncounter)?.has_prescription,true);
assert.ok(encounterQueue.every(row=>row.clinic_id===ids.clinicA));
assert.deepEqual(ownerContext.rows.map(row => [row.invoice_id, row.clinic_id, row.patient_id]), [[clinicAInvoice, ids.clinicA, clinicAPatient]],
  'Owner read-back RPC returns only narrow current-clinic identity context');
assert.equal((await asUser(ids.owner, `select * from public.get_owner_invoice_context('${clinicBInvoice}')`)).rows.length, 0,
  'Owner read-back RPC must not cross tenant boundaries');
assert.equal((await asUser(ids.owner, `select id from public.invoice_items where invoice_id='${clinicAInvoice}'`)).rows.length, 1);
assert.equal((await asUser(ids.owner, `select id from public.payments where invoice_id='${clinicAInvoice}'`)).rows.length, 1);

assert.equal((await asUser(admin, `select id from public.invoices where id='${clinicAInvoice}'`)).rows.length, 0,
  'governance Admin must not inherit Owner finance reads');
await assert.rejects(asUser(admin, `select * from public.get_owner_invoice_context('${clinicAInvoice}')`), /PERMISSION_DENIED/i,
  'governance Admin must not call the Owner read-back RPC');
await assert.rejects(asUser(admin, 'select * from public.list_owner_finance_context()'), /PERMISSION_DENIED/i);
await assert.rejects(asUser(ids.owner, `insert into public.invoices(id,invoice_number,patient_id) values ('${clinicAInvoice}','INV-DIRECT','${clinicAPatient}')`), /permission denied/,
  'Owner must not bypass the invoice RPC');
await assert.rejects(asUser(ids.owner, `insert into public.invoice_items(id,invoice_id,item_type,description) values ('${clinicAItem}','${clinicAInvoice}','service','direct')`), /permission denied/,
  'Owner must not bypass the invoice-item RPC');
await assert.rejects(asUser(ids.owner, `insert into public.payments(id,invoice_id,payment_reference,channel,amount) values ('${clinicAPayment}','${clinicAInvoice}','PAY-DIRECT','cash',1)`), /permission denied/,
  'Owner must not bypass the payment RPC');

await asOwner(`update public.clinic_memberships set active=false where clinic_id='${ids.clinicA}' and profile_id='${ids.owner}'`);
assert.equal((await asUser(ids.owner, `select id from public.invoices where id='${clinicAInvoice}'`)).rows.length, 0,
  'inactive Owner membership must lose financial reads');
await assert.rejects(asUser(ids.owner, 'select * from public.list_owner_finance_context()'), /CLINIC_CONTEXT_REQUIRED|PERMISSION_DENIED/i);
await assert.rejects(asUser(ids.owner, `select * from public.get_owner_invoice_context('${clinicAInvoice}')`), /PERMISSION_DENIED|CLINIC_CONTEXT_REQUIRED/i,
  'inactive Owner membership must lose read-back context');
await asOwner(`update public.clinic_memberships set active=true where clinic_id='${ids.clinicA}' and profile_id='${ids.owner}'`);
async function subscription(enabled, requestId) {
  const clinic=(await asOwner(`select code as clinic_code,subscription_version from public.clinics where id='${ids.clinicA}'`)).rows[0];
  return asService('select public.set_clinic_subscription_state($1::uuid,$2::uuid,$3,$4,$5::bigint,$6,$7::uuid,$8)',
    [requestId,ids.clinicA,clinic.clinic_code,enabled,clinic.subscription_version,'Synthetic Owner finance denial test',ids.owner,'owner@example.test']);
}
await subscription(false,'eeeeeeee-0000-4000-8000-000000000051');
assert.equal((await asUser(ids.owner, `select id from public.invoices where id='${clinicAInvoice}'`)).rows.length, 0);
await assert.rejects(asUser(ids.owner, 'select * from public.list_owner_finance_context()'), /CLINIC_CONTEXT_REQUIRED|SUBSCRIPTION|PERMISSION_DENIED/i);
await subscription(true,'eeeeeeee-0000-4000-8000-000000000052');
await asOwner(`update public.clinics set active=false where id='${ids.clinicA}'`);
assert.equal((await asUser(ids.owner, `select id from public.invoices where id='${clinicAInvoice}'`)).rows.length, 0,
  'subscription/clinic OFF must lose financial reads');
await assert.rejects(asUser(ids.owner, `select * from public.get_owner_invoice_context('${clinicAInvoice}')`), /permission denied|CLINIC_CONTEXT_REQUIRED/,
  'subscription/clinic OFF must lose read-back context');

await db.close();
console.log('Owner finance SELECT RLS passed: current tenant only, no governance-admin inheritance, no direct writes, inactive/OFF denied');
