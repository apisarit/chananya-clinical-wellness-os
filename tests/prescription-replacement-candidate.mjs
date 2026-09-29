import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const migrationOnly=process.argv.includes('--migration-only');
const {db,ids,asUser,asOwner,asAnon,asService}=await createPriceMasterFixture({permissiveDefaults:true,
  stopBeforeMigration:migrationOnly?null:'20260926214550_pharmacy_clarification_replacement_bundle.sql'});
const key=n=>`ab000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pharmacy=key(1), patient=key(2), encounter=key(3);
try {
  await asOwner(`insert into auth.users(id,email) values('${pharmacy}','replacement-pharmacy@example.test')`);
  await asOwner(`update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${pharmacy}','pharmacy',true,true) on conflict(clinic_id,profile_id)
    do update set clinic_role='pharmacy',active=true,is_primary=true`);
  await asOwner(`insert into public.patients(id,clinic_id,hn,first_name,last_name,created_by)
    values('${patient}','${ids.clinicA}','REPLACEMENT-SYNTHETIC','Synthetic','Only','${ids.owner}')`);
  await asOwner(`insert into public.encounters(id,encounter_no,clinic_id,patient_id,practitioner_id,created_by,status)
    values('${encounter}','REPLACEMENT-ENC','${ids.clinicA}','${patient}','${ids.userA}','${ids.userA}','draft')`);
  for (const file of migrationOnly?[]:['pharmacy_clarification_candidate.sql','pharmacy_clarification_backup_candidate.sql','prescription_replacement_candidate.sql']) {
    const sql=await fs.readFile(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
    await db.exec(sql);
    if(file==='prescription_replacement_candidate.sql') await db.exec(sql);
  }
  const items=JSON.stringify([{product_id:ids.productA,quantity_prescribed:1,unit:'ชิ้น',dose:'Synthetic original dose'}]);
  const original=(await asUser(ids.userA,`select * from public.create_atomic_prescription_handoff('${key(4)}','${encounter}','Original synthetic notes','${items}')`)).rows[0];
  const ticket=(await asUser(pharmacy,`select public.manage_prescription_clarification('${original.dispensing_order_id}','${key(5)}','open','Synthetic clarification question') result`)).rows[0].result;
  const revised=items.replace('original dose','replacement dose');
  const call=(action='replace',body=revised,reason='Synthetic replacement reason')=>`select public.manage_prescription_replacement(
    '${key(6)}','${ticket.id}','${action}','${reason}','New synthetic notes','${body}') result`;
  await assert.rejects(asAnon(call()),/permission denied/);
  await assert.rejects(asService(call()),/permission denied/);
  await assert.rejects(asUser(ids.userB,call()),/TICKET_NOT_FOUND/);
  await assert.rejects(asUser(pharmacy,call()),/PRESCRIBER_REQUIRED/);
  await assert.rejects(asUser(ids.owner,call()),/ACCESS_DENIED/);
  await asOwner(`update public.clinic_memberships set active=false where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await assert.rejects(asUser(ids.userA,call()),/ACCESS_DENIED/);
  await asOwner(`update public.clinic_memberships set active=true where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await asOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
    values('${encounter}','complete_record','${ids.userA}',true)`);
  await assert.rejects(asUser(ids.userA,call()),/CLINICAL_RECORD_LOCKED/);
  // Remove only the synthetic test signoff; application code never unlocks it.
  await asOwner(`delete from public.clinical_record_signoffs where encounter_id='${encounter}'`);
  await assert.rejects(asUser(ids.userA,call('replace',revised.replace(ids.productA,key(99)))),/PRODUCT_NOT_AVAILABLE/);
  assert.equal((await asOwner(`select count(*)::int n from public.prescriptions where encounter_id='${encounter}'`)).rows[0].n,1);
  assert.equal((await asOwner(`select status from public.prescriptions where id='${original.prescription_id}'`)).rows[0].status,'sent_to_pharmacy');
  // Failure at the final audit insert must roll back issuance, linkage and
  // retirement together. The injection exists only in this disposable fixture.
  await asOwner(`create function public.synthetic_replacement_audit_failure() returns trigger language plpgsql as $$
    begin if new.entity='prescription_replacements' then raise exception 'SYNTHETIC_AUDIT_FAILURE'; end if; return new; end $$`);
  await asOwner(`create trigger synthetic_replacement_audit_failure before insert on public.audit_logs
    for each row execute function public.synthetic_replacement_audit_failure()`);
  await assert.rejects(asUser(ids.userA,call()),/SYNTHETIC_AUDIT_FAILURE/);
  await asOwner(`drop trigger synthetic_replacement_audit_failure on public.audit_logs`);
  await asOwner(`drop function public.synthetic_replacement_audit_failure()`);
  assert.equal((await asOwner(`select count(*)::int n from public.prescriptions where encounter_id='${encounter}'`)).rows[0].n,1);
  assert.equal((await asOwner(`select count(*)::int n from cnyos_clarification_internal.replacements`)).rows[0].n,0);
  assert.equal((await asOwner(`select status from public.prescriptions where id='${original.prescription_id}'`)).rows[0].status,'sent_to_pharmacy');
  assert.equal((await asOwner(`select status from public.dispensing_orders where id='${original.dispensing_order_id}'`)).rows[0].status,'waiting');
  let receipt;
  if(process.env.CNYOS_TEST_REPLACEMENT_BROWSER==='1') {
    const {verifyReplacementAuthoring}=await import('./helpers/replacement-browser-database.mjs');
    receipt=await verifyReplacementAuthoring({asUser,actorId:ids.userA,ticketId:ticket.id,oldOrderId:original.dispensing_order_id,
      requestId:key(6),items:JSON.parse(revised),call});
  } else receipt=(await asUser(ids.userA,call())).rows[0].result;
  assert.equal(receipt.old_rx_id,original.prescription_id);
  assert.notEqual(receipt.new_rx_id,receipt.old_rx_id);
  assert.equal(receipt.acknowledged_by,null);
  assert.deepEqual((await asUser(ids.userA,call())).rows[0].result,receipt);
  await assert.rejects(asUser(ids.userA,call('replace',items)),/REQUEST_CONFLICT/);
  assert.equal((await asOwner(`select count(*)::int n from public.prescriptions where encounter_id='${encounter}'`)).rows[0].n,2);
  assert.equal((await asOwner(`select status from public.prescriptions where id='${receipt.old_rx_id}'`)).rows[0].status,'cancelled');
  assert.equal((await asOwner(`select status from public.dispensing_orders where id='${receipt.old_order_id}'`)).rows[0].status,'cancelled');
  for(const action of ['review','dispense','submit_billing']) {
    await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${receipt.old_order_id}','${action}')`),/PRESCRIPTION_INACTIVE|SUPERSEDED/);
    await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','${action}')`),/REPLACEMENT_ACK_REQUIRED/);
  }
  await assert.rejects(asUser(ids.userA,call('acknowledge')),/PHARMACY_REQUIRED/);
  if(process.env.CNYOS_TEST_REPLACEMENT_BROWSER==='1') {
    const {verifyReplacementAcknowledgement}=await import('./helpers/replacement-browser-database.mjs');
    await verifyReplacementAcknowledgement({asUser,pharmacy,receipt,ticket});
    assert.equal((await asOwner(`select status from public.dispensing_orders where id='${receipt.new_order_id}'`)).rows[0].status,'waiting');
  }
  const acknowledged=(await asUser(pharmacy,call('acknowledge'))).rows[0].result;
  assert.equal(acknowledged.acknowledged_by,pharmacy);
  for(const order of [receipt.old_order_id,receipt.new_order_id]) {
    const lookup=`select public.read_prescription_replacements('${order}') result`;
    for(const actor of [ids.userA,pharmacy]) {
      const linked=(await asUser(actor,lookup)).rows[0].result;
      assert.equal(linked.order_id,order);
      assert.deepEqual(linked.replacements,[acknowledged]);
    }
    await assert.rejects(asUser(ids.userB,lookup),/ORDER_NOT_FOUND|ACCESS_DENIED/);
    await assert.rejects(asAnon(lookup),/permission denied/);
    await assert.rejects(asService(lookup),/permission denied/);
  }
  assert.deepEqual((await asUser(pharmacy,call('acknowledge'))).rows[0].result,acknowledged);
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','review')`);
  await asOwner(`update public.prescription_items set dose='Unexpected synthetic edit' where prescription_id='${receipt.new_rx_id}'`);
  await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','review')`),/REPLACEMENT_REVISION_CHANGED/);
  await assert.rejects(asUser(pharmacy,`select * from cnyos_clarification_internal.replacements`),/permission denied/);
  const acl=(await asOwner(`select n.nspname,p.proname,
    has_function_privilege('anon',p.oid,'execute') anon,
    has_function_privilege('authenticated',p.oid,'execute') authenticated,
    has_function_privilege('service_role',p.oid,'execute') service_role
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('manage_prescription_replacement','read_prescription_replacements','guard_replacement_receipt','check_replacement_clearance')`)).rows;
  assert.equal(acl.length,4);
  for(const entry of acl) {
    assert.equal(entry.anon,false); assert.equal(entry.service_role,false);
    assert.equal(entry.authenticated,entry.nspname==='public');
  }
  await assert.rejects(asOwner(`update cnyos_clarification_internal.replacements set actor_id='${pharmacy}' where request_id='${key(6)}'`),/RECEIPT_IMMUTABLE/);
  if(!migrationOnly) await assert.rejects(asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`),/BACKUP_REPLACEMENT_CONTRACT_REQUIRED/);
  assert.equal((await asOwner(`select count(*)::int n from public.audit_logs where entity='prescription_replacements'`)).rows[0].n,2);
  const backupSql=await fs.readFile(new URL('../supabase/manual/prescription_replacement_backup_candidate.sql',import.meta.url),'utf8');
  if(!migrationOnly) {await db.exec(backupSql); await db.exec(backupSql);}
  await assert.rejects(asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`),/BACKUP_REPLACEMENT_INTEGRITY_ANOMALY/);
  await asOwner(`update public.prescription_items set dose='Synthetic replacement dose' where prescription_id='${receipt.new_rx_id}'`);
  const table='cnyos_clarification_internal.replacements';
  const exported=(await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions') result`)).rows[0].result;
  const trace=(await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') result`)).rows[0].result;
  assert.equal(exported.schema_version,'2026-09-27.1');
  assert.equal(trace.schema_version,exported.schema_version);
  assert.deepEqual(exported.data[table],[acknowledged]);
  assert.equal(trace.counts[table],1);
  assert.match(exported.table_sha256[table],/^[a-f0-9]{64}$/);
  assert.equal(trace.table_sha256[table],exported.table_sha256[table]);
  const other=(await asService(`select public.export_clinic_backup_domain('${ids.clinicB}','transactions') result`)).rows[0].result;
  assert.deepEqual(other.data[table],[]);
  const health=(await asService(`select * from public.backup_restore_contract_healthcheck()`)).rows[0];
  assert.equal(health.schema_version,'2026-09-27.1');
  assert.equal(health.transaction_table_count,20);
  for(const actor of [asAnon,asService,sql=>asUser(pharmacy,sql)]) {
    await assert.rejects(actor(`select cnyos_clarification_internal.replacement_backup_rows('${ids.clinicA}')`),/permission denied/);
  }
  // Reapplying the prerequisite must not remove the newer projection.
  if(!migrationOnly) await db.exec(await fs.readFile(new URL('../supabase/manual/prescription_replacement_candidate.sql',import.meta.url),'utf8'));
  assert.deepEqual((await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions') result`)).rows[0].result.data[table],[acknowledged]);
  if(!migrationOnly) {
    // Upgrade a populated manual installation through the exact release file.
    // Compare all domain contents, not timestamps on the export envelopes.
    const capture=async()=>{
      const domains={};
      for(const domain of ['patients','products','pharmacy','transactions']) {
        const result=(await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','${domain}') result`)).rows[0].result;
        domains[domain]={data:result.data,hashes:result.table_sha256,version:result.schema_version};
      }
      return domains;
    };
    const beforeUpgrade=await capture();
    const bundle=await fs.readFile(new URL('../supabase/migrations/20260926214550_pharmacy_clarification_replacement_bundle.sql',import.meta.url),'utf8');
    await db.exec(bundle);
    assert.deepEqual(await capture(),beforeUpgrade,'bundle upgrade changed existing domain data');
    assert.deepEqual((await asUser(ids.userA,call('read'))).rows[0].result,acknowledged);
    await assert.rejects(asUser(ids.userB,call('read')),/TICKET_NOT_FOUND/);
    console.log('Populated manual-to-bundle upgrade passed: all four domain contents/hashes and acknowledged replacement readback preserved; foreign-clinic read denied.');
  }
  // Complete the successor handoff using real pricing, stock and invoice RPCs.
  // These prices and stock belong only to this disposable synthetic fixture.
  const price=(await asUser(ids.owner,`select * from public.setup_price_master_default()`)).rows[0];
  await asUser(ids.owner,`select * from public.set_price_master_item('${price.price_list_id}','product','${ids.productA}',null,'ชิ้น',125,0,'Synthetic replacement integration price')`);
  await asOwner(`insert into public.inventory_lots(clinic_id,product_id,lot_number,expiry_date,received_quantity,current_quantity,unit,purchase_cost,status)
    values('${ids.clinicA}','${ids.productA}','REPLACEMENT-INTEGRATION',current_date+30,2,2,'ชิ้น',25,'active')`);
  const item=(await asOwner(`select id from public.prescription_items where prescription_id='${receipt.new_rx_id}'`)).rows[0].id;
  const itemPrice=(await asUser(pharmacy,`select * from public.resolve_price_master_item('product','${ids.productA}',null,current_date,null)`)).rows[0].unit_price;
  assert.equal(Number(itemPrice),125);
  const dispense=`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','dispense','[{"prescription_item_id":"${item}","unit_price":${itemPrice}}]')`;
  await asUser(pharmacy,dispense);
  await asUser(pharmacy,dispense);
  assert.equal(Number((await asOwner(`select current_quantity from public.inventory_lots where lot_number='REPLACEMENT-INTEGRATION'`)).rows[0].current_quantity),1);
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','submit_billing')`);
  await asOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
    values('${encounter}','complete_record','${ids.userA}',true)`);
  const quote=(await asUser(ids.owner,`select public.quote_encounter_invoice('${encounter}') result`)).rows[0].result;
  assert.equal(quote.orders.length,1);
  assert.equal(quote.orders[0].id,receipt.new_order_id);
  assert.equal(Number(quote.grand_total),125);
  const bill=`select * from public.issue_atomic_encounter_invoice('${key(20)}','${encounter}','${quote.quote_fingerprint}')`;
  const invoice=(await asUser(ids.owner,bill)).rows[0];
  assert.equal(Number(invoice.grand_total),125);
  assert.deepEqual((await asUser(ids.owner,bill)).rows[0],invoice);
  assert.equal((await asOwner(`select count(*)::int n from public.invoices where encounter_id='${encounter}'`)).rows[0].n,1);
  assert.deepEqual((await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions') result`)).rows[0].result.data[table],[acknowledged]);
  const billing=key(30);
  await asOwner(`insert into auth.users(id,email) values('${billing}','replacement-billing@example.test')`);
  await asOwner(`update public.profiles set role='billing',system_role='staff' where id='${billing}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${billing}','billing',true,true) on conflict(clinic_id,profile_id)
    do update set clinic_role='billing',active=true,is_primary=true`);
  const pay=(request,amount)=>`select * from public.record_atomic_invoice_payment('${request}','${invoice.invoice_id}',${amount},'cash','Synthetic replacement payment')`;
  for(const denied of [ids.userA,pharmacy,ids.userB]) {
    await assert.rejects(asUser(denied,pay(key(31),50)),/PERMISSION_DENIED|INVOICE_NOT_FOUND/);
  }
  const verifyPartialRecovery=await (await import('./helpers/payment-journal-database.mjs')).preparePaymentRecovery({actorId:billing,clinicId:ids.clinicA,invoiceId:invoice.invoice_id,requestId:key(31),amount:50});
  const partial=process.env.CNYOS_TEST_REPLACEMENT_BROWSER==='1'
    ? await (await import('./helpers/replacement-browser-database.mjs')).verifyBillingPayment({asUser,actorId:billing,invoiceId:invoice.invoice_id,requestId:key(31),pay})
    : (await asUser(billing,pay(key(31),50))).rows[0];
  assert.equal(Number(partial.balance_due),75);
  assert.equal(partial.invoice_status,'partially_paid');
  assert.equal(partial.encounter_closed,false);
  await verifyPartialRecovery({asUser,foreignActor:ids.userB});
  assert.deepEqual((await asUser(billing,pay(key(31),50))).rows[0],partial);
  await assert.rejects(asUser(billing,pay(key(31),51)),/IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(asUser(billing,pay(key(32),76)),/PAYMENT_EXCEEDS_BALANCE/);
  const paid=process.env.CNYOS_TEST_REPLACEMENT_BROWSER==='1'
    ? await (await import('./helpers/replacement-browser-database.mjs')).verifyBillingPayment({asUser,actorId:billing,invoiceId:invoice.invoice_id,requestId:key(32),pay,amount:75,balanceBefore:75,lossBeforeCommit:process.env.CNYOS_TEST_PAYMENT_BEFORE_COMMIT==='1'})
    : (await asUser(billing,pay(key(32),75))).rows[0];
  assert.equal(Number(paid.balance_due),0);
  assert.equal(paid.invoice_status,'paid');
  assert.equal(paid.encounter_closed,true);
  assert.deepEqual((await asUser(billing,pay(key(32),75))).rows[0],paid);
  await assert.rejects(asUser(billing,pay(key(33),1)),/INVOICE_NOT_PAYABLE/);
  const receipts=(await asUser(billing,`select id,payment_reference,amount,received_by,status from public.payments where invoice_id='${invoice.invoice_id}' order by amount`)).rows;
  assert.equal(receipts.length,2);
  assert.deepEqual(receipts.map(row=>Number(row.amount)),[50,75]);
  assert.equal(new Set(receipts.map(row=>row.payment_reference)).size,2);
  assert.ok(receipts.every(row=>row.received_by===billing && row.status==='paid' && row.payment_reference));
  await asOwner(`update public.clinic_memberships set clinic_role='billing' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}'`);
  await assert.rejects(asUser(ids.userB,pay(key(34),1)),/INVOICE_NOT_FOUND/);
  assert.equal((await asUser(ids.userB,`select id from public.payments where invoice_id='${invoice.invoice_id}'`)).rows.length,0);
  assert.equal((await asOwner(`select status from public.encounters where id='${encounter}'`)).rows[0].status,'closed');
  console.log('Replacement local candidate passed: successor-only invoice, single stock deduction; separate Billing actor partial/final payment, receipt readback, replay/conflict/overpayment denial and encounter closure.');
} finally {await db.close();}
