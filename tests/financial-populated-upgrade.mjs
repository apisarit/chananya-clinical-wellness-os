import assert from 'node:assert/strict';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// These rows model a real pre-price-master database: they are inserted after
// the last pre-2026-09-26 migration and before the first 2026-09-26 migration.
const ids = {
  product: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  encounter: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  encounterNoSource: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
  prescription: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
  prescriptionItem: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
  dispensingOrder: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
  dispensingItem: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7',
  invoice: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8',
  invoiceItem: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9',
  payment: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea',
  invoiceNoSource: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeeb',
  invoiceNoSourceItem: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeec'
};

const firstPriceMigration = '20260926090000_tenant_price_master.sql';
const { db, asOwner, asUser, asService } = await createPriceMasterFixture({
  beforeMigration: async ({ db: hookDb, file, ids: fixtureIds }) => {
    if (file !== firstPriceMigration) return;
    await hookDb.exec(`
      reset role;
      select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','service_role',false);
      insert into public.products(id,sku,name_th,category,stock_unit,dispense_unit,active,clinic_id)
      values ('${ids.product}','LEGACY-UPGRADE','Legacy product','medicine','ชิ้น','ชิ้น',true,'${fixtureIds.clinicA}');
      insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      select '${ids.encounter}','LEGACY-UPGRADE-01',p.id,'${fixtureIds.clinicA}','closed','${fixtureIds.userA}'
        from public.patients p where p.hn='CHANANYA-00009999';
      insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      select '${ids.encounterNoSource}','LEGACY-UPGRADE-02',p.id,'${fixtureIds.clinicA}','closed','${fixtureIds.userA}'
        from public.patients p where p.hn='CHANANYA-00009999';
      insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,prescriber_id,status)
      select '${ids.prescription}','LEGACY-RX-01','${ids.encounter}',p.id,'${fixtureIds.userA}','completed'
        from public.patients p where p.hn='CHANANYA-00009999';
      insert into public.prescription_items(id,prescription_id,product_id,quantity_prescribed,unit,status)
      values ('${ids.prescriptionItem}','${ids.prescription}','${ids.product}',2,'ชิ้น','dispensed');
      insert into public.dispensing_orders(id,prescription_id,queue_number,status,dispensed_by,dispensed_at)
      values ('${ids.dispensingOrder}','${ids.prescription}','LEGACY-Q-01','billed','${fixtureIds.userA}',now());
      insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status)
      values ('${ids.dispensingItem}','${ids.dispensingOrder}','${ids.prescriptionItem}',2,'ชิ้น',37.50,'dispensed');
      insert into public.invoices(id,invoice_number,patient_id,encounter_id,source_dispensing_order_id,status,subtotal,grand_total,paid_amount,balance_due,issued_at,created_by)
      select '${ids.invoice}','LEGACY-INV-01',p.id,'${ids.encounter}','${ids.dispensingOrder}','partially_paid',75,75,25,50,now(),'${fixtureIds.userA}'
        from public.patients p where p.hn='CHANANYA-00009999';
      insert into public.invoice_items(id,invoice_id,item_type,product_id,dispensing_item_id,description,quantity,unit_price,line_total)
      values ('${ids.invoiceItem}','${ids.invoice}','product','${ids.product}','${ids.dispensingItem}','Legacy product',2,37.50,75);
      insert into public.payments(id,invoice_id,payment_reference,channel,amount,status,paid_at,received_by)
      values ('${ids.payment}','${ids.invoice}','LEGACY-PAY-01','cash',25,'paid',now(),'${fixtureIds.userA}');
      insert into public.invoices(id,invoice_number,patient_id,encounter_id,status,subtotal,grand_total,paid_amount,balance_due,issued_at,created_by)
      select '${ids.invoiceNoSource}','LEGACY-INV-02',p.id,'${ids.encounterNoSource}','issued',40,40,0,40,now(),'${fixtureIds.userA}'
        from public.patients p where p.hn='CHANANYA-00009999';
      insert into public.invoice_items(id,invoice_id,item_type,description,quantity,unit_price,line_total)
      values ('${ids.invoiceNoSourceItem}','${ids.invoiceNoSource}','service','Unlinked legacy service',1,40,40);
      select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','',false);
      reset role;
    `);
  }
});

const invoice = (await db.query(`select id,status,subtotal,grand_total,paid_amount,balance_due,source_dispensing_order_id from public.invoices where id='${ids.invoice}'`)).rows[0];
assert.deepEqual(invoice, { id: ids.invoice, status: 'partially_paid', subtotal: '75.00', grand_total: '75.00', paid_amount: '25.00', balance_due: '50.00', source_dispensing_order_id: ids.dispensingOrder });
const unlinked = (await db.query(`select source_dispensing_order_id,status,grand_total,balance_due from public.invoices where id='${ids.invoiceNoSource}'`)).rows[0];
assert.deepEqual(unlinked, { source_dispensing_order_id: null, status: 'issued', grand_total: '40.00', balance_due: '40.00' });

const item = (await db.query(`select quantity,unit_price,line_total,price_list_id,price_list_version,price_list_item_id,price_item_version from public.invoice_items where id='${ids.invoiceItem}'`)).rows[0];
assert.deepEqual(item, { quantity: '2.000000000000', unit_price: '37.50', line_total: '75.00', price_list_id: null, price_list_version: null, price_list_item_id: null, price_item_version: null });
const dispensing = (await db.query(`select quantity_dispensed,unit_price,status,price_list_id,price_list_version,price_list_item_id,price_item_version from public.dispensing_items where id='${ids.dispensingItem}'`)).rows[0];
assert.deepEqual(dispensing, { quantity_dispensed: '2.0000', unit_price: '37.50', status: 'dispensed', price_list_id: null, price_list_version: null, price_list_item_id: null, price_item_version: null });
const payment = (await db.query(`select invoice_id,amount,status,payment_reference from public.payments where id='${ids.payment}'`)).rows[0];
assert.deepEqual(payment, { invoice_id: ids.invoice, amount: '25.00', status: 'paid', payment_reference: 'LEGACY-PAY-01' });

const imported = (await db.query(`select invoice_id,dispensing_order_id,prescription_id,provenance from cnyos_billing_internal.invoice_orders order by invoice_id`)).rows;
assert.deepEqual(imported, [{ invoice_id: ids.invoice, dispensing_order_id: ids.dispensingOrder, prescription_id: ids.prescription, provenance: 'historical_import' }]);
const trace = (await asService(`select public.verify_clinic_restore_trace('${'00000000-0000-0000-0000-000000000001'}') as payload`)).rows[0].payload;
assert.equal(trace.ready, true, 'historical imported invoice should not make restore trace unready');

const billing = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed';
await asOwner(`insert into auth.users(id,email,raw_user_meta_data)
  values('${billing}','upgrade-billing@example.test','{"full_name":"Synthetic Billing"}');`);
await db.exec(`update public.profiles set role='billing',system_role='staff' where id='${billing}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
  values('00000000-0000-0000-0000-000000000001','${billing}','billing',true,true)
  on conflict(clinic_id,profile_id) do update set clinic_role='billing',is_primary=true,active=true`);
const replay = (await asUser(billing, `select * from public.issue_atomic_dispensing_invoice('${ids.dispensingOrder}',0,0)`)).rows[0];
assert.deepEqual(replay, { invoice_id: ids.invoice, invoice_number: 'LEGACY-INV-01', grand_total: '75.00', balance_due: '50.00' });
assert.equal((await db.query(`select count(*)::int as n from public.invoices where source_dispensing_order_id='${ids.dispensingOrder}'`)).rows[0].n, 1);
const paymentSql = `select * from public.record_atomic_invoice_payment(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${ids.invoice}',50,'cash','Synthetic remaining balance')`;
const settled = (await asUser(billing,paymentSql)).rows[0];
const retry = (await asUser(billing,paymentSql)).rows[0];
assert.equal(retry.payment_id,settled.payment_id);
const paid = (await asUser(billing,`select status,paid_amount,balance_due from public.invoices where id='${ids.invoice}'`)).rows[0];
assert.deepEqual(paid,{status:'paid',paid_amount:'75.00',balance_due:'0.00'});
assert.equal((await asUser(billing,`select count(*)::int n from public.payments where invoice_id='${ids.invoice}'`)).rows[0].n,2);
await db.close();
console.log('Financial populated upgrade passed: historical totals/provenance preserved, no fabricated source, Billing replay and remaining payment settle once');
