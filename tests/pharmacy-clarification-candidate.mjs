import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
// Component-upgrade test starts before the bundled release migration.
// Full migration installation is separately exercised by the replacement suite.
const { db, ids, asUser, asOwner, asAnon, asService } = await createPriceMasterFixture({
  permissiveDefaults: true, stopBeforeMigration: '20260926214550_pharmacy_clarification_replacement_bundle.sql'
});
const pharmacy='8b000000-0000-4000-8000-000000000004';
const patient='8b000000-0000-4000-8000-000000000005';
const encounter='8b000000-0000-4000-8000-000000000006';
const rx='8b000000-0000-4000-8000-000000000007';
const order='8b000000-0000-4000-8000-000000000008';
const request='8b000000-0000-4000-8000-000000000009';
try {
  await asOwner(`insert into auth.users(id,email) values('${pharmacy}','synthetic-pharmacy@example.test')`);
  await asOwner(`update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${pharmacy}','pharmacy',true,true) on conflict(clinic_id,profile_id)
    do update set clinic_role='pharmacy',is_primary=true,active=true`);
  await asOwner(`insert into public.patients(id,clinic_id,hn,first_name,last_name,created_by) values('${patient}','${ids.clinicA}','CLARIFY-SYNTHETIC','Synthetic','Only','${ids.owner}')`);
  await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${encounter}','CLARIFY-ENC','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.owner}')`);
  await asOwner(`insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,prescriber_id,status)
    values('${rx}','CLARIFY-RX','${encounter}','${patient}','${ids.userA}','in_pharmacy')`);
  await asOwner(`insert into public.prescription_items(prescription_id,product_id,quantity_prescribed,unit,dose)
    values('${rx}','${ids.productA}',1,'ชิ้น','synthetic dose')`);
  await asOwner(`insert into public.dispensing_orders(id,prescription_id,status) values('${order}','${rx}','reviewed')`);
  const prices=(await asUser(ids.owner,'select * from public.setup_price_master_default()')).rows[0];
  await asUser(ids.owner,`select * from public.set_price_master_item('${prices.price_list_id}',
    'product','${ids.productA}',null,'ชิ้น',100,0,'Synthetic clarification price')`);
  await asOwner(`insert into public.inventory_lots(clinic_id,product_id,lot_number,expiry_date,
    received_quantity,current_quantity,unit,purchase_cost,status) values
    ('${ids.clinicA}','${ids.productA}','CLARIFY-LOT',current_date+30,2,2,'ชิ้น',25,'active')`);
  const item=(await asOwner(`select id from public.prescription_items where prescription_id='${rx}'`)).rows[0];
  const dispense=`select public.transition_atomic_prescription_dispensing('${order}','dispense',
    '[{"prescription_item_id":"${item.id}","unit_price":100}]'::jsonb) result`;
  const stock=async()=> (await asOwner(`select
    (select current_quantity from public.inventory_lots where lot_number='CLARIFY-LOT') balance,
    (select count(*)::int from public.dispensing_items where dispensing_order_id='${order}') allocations,
    (select count(*)::int from public.stock_movements where reference_id='${order}') movements`)).rows[0];
  const assertUntouched=async()=>assert.deepEqual(await stock(),{balance:'2.0000',allocations:0,movements:0});
  const sql = await fs.readFile(new URL('../supabase/manual/pharmacy_clarification_candidate.sql',import.meta.url),'utf8');
  await db.exec(sql); await db.exec(sql);
  // An inactive prescription must not be resurrected by a stale reviewed queue.
  // Only privileged synthetic setup creates this deliberately inconsistent state.
  for (const inactive of ['cancelled','void']) {
    await asOwner(`update public.prescriptions set status='${inactive}' where id='${rx}'`);
    for (const action of ['review','dispense','submit_billing']) {
      await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
        '${order}','${action}','[{"prescription_item_id":"${item.id}","unit_price":100}]'::jsonb)`),/PRESCRIPTION_INACTIVE/);
    }
    await assert.rejects(asOwner(`update public.dispensing_orders set status='dispensed' where id='${order}'`),/PRESCRIPTION_INACTIVE/);
    await assert.rejects(asUser(pharmacy,`select public.manage_prescription_clarification(
      '${order}','${request}','open','Synthetic inactive question')`),/CLARIFICATION_PRESCRIPTION_INACTIVE/);
    assert.equal((await asOwner(`select status from public.prescriptions where id='${rx}'`)).rows[0].status,inactive);
    assert.equal((await asOwner(`select status from public.dispensing_orders where id='${order}'`)).rows[0].status,'reviewed');
    await assertUntouched();
  }
  await asOwner(`update public.prescriptions set status='in_pharmacy' where id='${rx}'`);
  const grants = (await asOwner(`select n.nspname, p.proname,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_role
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='cnyos_clarification_internal'
       or (n.nspname='public' and p.proname='manage_prescription_clarification')`)).rows;
  assert.equal(grants.length,4);
  for (const grant of grants) {
    assert.equal(grant.anon,false,grant.proname);
    assert.equal(grant.service_role,false,grant.proname);
    assert.equal(grant.authenticated,grant.nspname==='public',grant.proname);
  }
  const call=(action,text='synthetic question',key=request)=>`select public.manage_prescription_clarification('${order}','${key}','${action}','${text}') as result`;
  const history=(cursor=null)=>`select public.manage_prescription_clarification('${order}',${cursor ? `'${cursor}'` : 'null'},'history',null) result`;
  assert.deepEqual((await asUser(pharmacy,history())).rows[0].result,{tickets:[],next_cursor:null});
  await assert.rejects(asAnon(history()),/permission denied/);
  await assert.rejects(asService(history()),/permission denied/);
  await assert.rejects(asUser(ids.userB,history()),/ORDER_NOT_FOUND/);
  await assert.rejects(asAnon(call('open')),/permission denied/);
  await assert.rejects(asService(call('open')),/permission denied/);
  await assert.rejects(asUser(ids.userB,call('open')),/ORDER_NOT_FOUND/);
  await assert.rejects(asUser(ids.userA,call('open')),/PHARMACY_REQUIRED/);
  const ticket=(await asUser(pharmacy,call('open'))).rows[0].result;
  assert.equal(ticket.status,'open');
  assert.deepEqual((await asUser(ids.userA,history())).rows[0].result.tickets,[ticket]);
  assert.equal((await asUser(ids.userA,call('read'))).rows[0].result.id,ticket.id);
  await assert.rejects(asUser(ids.userB,call('read')),/ORDER_NOT_FOUND/);
  // Existing sessions must lose access when their membership is suspended.
  await asOwner(`update public.clinic_memberships set active=false where profile_id='${pharmacy}'`);
  for (const action of ['read','open','answer','acknowledge','history']) {
    await assert.rejects(asUser(pharmacy,call(action)),/ACCESS_DENIED/);
  }
  await asOwner(`update public.clinic_memberships set active=true where profile_id='${pharmacy}' and clinic_id='${ids.clinicA}'`);
  const clinic = (await asOwner(`select code,subscription_version from public.clinics where id='${ids.clinicA}'`)).rows[0];
  const off = (await asService(`select public.set_clinic_subscription_state(
    '8b000000-0000-4000-8000-000000000021','${ids.clinicA}','${clinic.code}',false,
    ${clinic.subscription_version},'Synthetic clarification suspension test','${ids.owner}','owner@example.test') result`)).rows[0].result;
  for (const action of ['read','open','answer','acknowledge','history']) {
    // Suspended clinics may already be excluded by current_clinic_id().
    await assert.rejects(asUser(pharmacy,call(action)),/CLARIFICATION_ACCESS_DENIED|CNYOS_SUBSCRIPTION_SUSPENDED/);
  }
  await asService(`select public.set_clinic_subscription_state(
    '8b000000-0000-4000-8000-000000000022','${ids.clinicA}','${clinic.code}',true,
    ${off.version},'Synthetic clarification resume test','${ids.owner}','owner@example.test')`);
  assert.equal((await asUser(pharmacy,call('read'))).rows[0].result.status,'open');
  assert.equal((await asUser(pharmacy,call('open'))).rows[0].result.id,ticket.id);
  await assert.rejects(asUser(pharmacy,call('open','changed question')),/REQUEST_CONFLICT/);
  await assert.rejects(asUser(pharmacy,call('open','second question','8b000000-0000-4000-8000-000000000010')),/ALREADY_OPEN/);
  await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','review')`),/CLARIFICATION_PENDING/);
  await assert.rejects(asUser(pharmacy,dispense),/PRESCRIPTION_ORDER_NOT_REVIEWED/);
  await assertUntouched();
  await assert.rejects(asUser(pharmacy,call('acknowledge')),/ANSWER_REQUIRED/);
  await assert.rejects(asUser(pharmacy,call('answer','synthetic answer')),/PRESCRIBER_REQUIRED/);
  assert.equal((await asUser(ids.userA,call('answer','synthetic answer'))).rows[0].result.status,'answered');
  await assert.rejects(asUser(pharmacy,dispense),/PRESCRIPTION_ORDER_NOT_REVIEWED/);
  await assertUntouched();
  assert.equal((await asUser(ids.userA,call('answer','synthetic answer'))).rows[0].result.id,ticket.id);
  await assert.rejects(asUser(ids.userA,call('answer','different answer')),/ANSWER_CONFLICT/);
  await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','review')`),/CLARIFICATION_PENDING/);
  const result=(await asUser(pharmacy,call('acknowledge'))).rows[0].result;
  assert.equal(result.status,'resolved');
  assert.equal(result.answered_by,ids.userA);
  assert.equal(result.acknowledged_by,pharmacy);
  assert.equal((await asOwner(`select status from public.dispensing_orders where id='${order}'`)).rows[0].status,'waiting');
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','review')`);
  await asUser(pharmacy,call('acknowledge'));
  assert.equal((await asOwner(`select count(*)::int n from public.audit_logs where entity='prescription_clarifications'`)).rows[0].n,3);
  await assert.rejects(asUser(pharmacy,`select * from cnyos_clarification_internal.tickets`),/permission denied/);
  const next='8b000000-0000-4000-8000-000000000011';
  await asUser(pharmacy,call('open','another question',next));
  await asOwner(`update public.prescription_items set dose='changed synthetic dose' where prescription_id='${rx}'`);
  await assert.rejects(asUser(ids.userA,call('answer','synthetic answer',next)),/REVISION_CHANGED/);
  assert.equal((await asOwner(`select count(*)::int n from public.dispensing_items where dispensing_order_id='${order}'`)).rows[0].n,0);
  // Restore only the synthetic fixture mutation; no production correction path is implied.
  await asOwner(`update public.prescription_items set dose='synthetic dose' where prescription_id='${rx}'`);
  await asUser(ids.userA,call('answer','synthetic answer',next));
  await asUser(pharmacy,call('acknowledge','',next));
  await assert.rejects(asUser(pharmacy,dispense),/PRESCRIPTION_ORDER_NOT_REVIEWED/);
  await assertUntouched();
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','review')`);
  // The final transition guard must roll back allocations made earlier in the RPC.
  await asOwner(`update public.prescription_items set dose='post-ack synthetic change' where prescription_id='${rx}'`);
  await assert.rejects(asUser(pharmacy,dispense),/PRESCRIPTION_CLARIFICATION_REVISION_CHANGED/);
  await assertUntouched();
  assert.equal((await asOwner(`select status from public.prescription_items where id='${item.id}'`)).rows[0].status,'ordered');
  const revised='8b000000-0000-4000-8000-000000000031';
  await asUser(pharmacy,call('open','confirm changed content',revised));
  await asUser(ids.userA,call('answer','confirmed changed content',revised));
  const revisedTicket=(await asUser(pharmacy,call('acknowledge','',revised))).rows[0].result;
  // Replaying an older receipt must not move the active clearance backwards.
  await asUser(pharmacy,call('acknowledge','',next));
  assert.equal((await asOwner(`select ticket_id from cnyos_clarification_internal.clearances where order_id='${order}'`)).rows[0].ticket_id,revisedTicket.id);
  await assert.rejects(asUser(pharmacy,`select * from cnyos_clarification_internal.clearances`),/permission denied/);
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','review')`);
  assert.equal((await asUser(pharmacy,dispense)).rows[0].result.status,'dispensed');
  const after=await stock();
  assert.equal(Number(after.balance),1);
  assert.equal(after.allocations,1);
  assert.equal(after.movements,1);
  assert.equal((await asUser(pharmacy,dispense)).rows[0].result.idempotent,true);
  assert.deepEqual(await stock(),after,'retry must not deduct stock twice');
  await assert.rejects(asUser(pharmacy,call('open','after dispensing','8b000000-0000-4000-8000-000000000030')),/CORRECTION_WORKFLOW_REQUIRED/);
  assert.deepEqual(await stock(),after,'rejected reopening must preserve dispensed stock');
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${order}','submit_billing')`);
  const quote=(await asUser(ids.owner,`select public.quote_encounter_invoice('${encounter}') result`)).rows[0].result;
  assert.equal(Number(quote.grand_total),100);
  await asOwner(`update public.prescription_items set dose='changed after billing handoff' where id='${item.id}'`);
  await assert.rejects(asUser(ids.owner,`select public.quote_encounter_invoice('${encounter}')`),/PRESCRIPTION_CLARIFICATION_REVISION_CHANGED/);
  await asOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
    values('${encounter}','complete_record','${ids.userA}','Synthetic Practitioner',true)`);
  await assert.rejects(asUser(ids.owner,`select * from public.issue_atomic_encounter_invoice(
    '8b000000-0000-4000-8000-000000000040','${encounter}','${quote.quote_fingerprint}')`),/PRESCRIPTION_CLARIFICATION_REVISION_CHANGED/);
  assert.equal((await asOwner(`select count(*)::int n from public.invoices where encounter_id='${encounter}'`)).rows[0].n,0);
  assert.deepEqual(await stock(),after,'quote refusal must leave stock untouched');
  const exported=(await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions') result`)).rows[0].result;
  const restoredTrace=(await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') result`)).rows[0].result;
  for (const table of ['cnyos_clarification_internal.tickets','cnyos_clarification_internal.clearances']) {
    assert.equal(Object.hasOwn(exported.data,table),false,'update this diagnostic when backup integration is implemented');
    assert.equal(Object.hasOwn(restoredTrace.counts,table),false);
  }
  const backupSql=await fs.readFile(new URL('../supabase/manual/pharmacy_clarification_backup_candidate.sql',import.meta.url),'utf8');
  await db.exec(backupSql); await db.exec(backupSql);
  const fullExport=(await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions') result`)).rows[0].result;
  const fullTrace=(await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') result`)).rows[0].result;
  assert.equal(fullExport.schema_version,'2026-09-26.2');
  assert.equal(fullTrace.schema_version,fullExport.schema_version);
  for (const [table,count] of [['cnyos_clarification_internal.tickets',3],['cnyos_clarification_internal.clearances',1]]) {
    assert.equal(fullExport.data[table].length,count);
    assert.equal(fullTrace.counts[table],count);
    assert.ok(fullExport.included_tables.includes(table));
    assert.match(fullExport.table_sha256[table],/^[a-f0-9]{64}$/);
    assert.equal(fullTrace.table_sha256[table],fullExport.table_sha256[table]);
  }
  const foreign=(await asService(`select public.export_clinic_backup_domain('${ids.clinicB}','transactions') result`)).rows[0].result;
  assert.deepEqual(foreign.data['cnyos_clarification_internal.tickets'],[]);
  assert.deepEqual(foreign.data['cnyos_clarification_internal.clearances'],[]);
  await assert.rejects(asService(`select cnyos_clarification_internal.backup_projection('${ids.clinicA}')`),/permission denied/);
  await assert.rejects(asUser(pharmacy,`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`),/permission denied/);
  await asOwner(`update cnyos_clarification_internal.tickets set clinic_id='${ids.clinicB}' where id='${revisedTicket.id}'`);
  for (const clinicId of [ids.clinicA,ids.clinicB]) {
    await assert.rejects(asService(`select public.export_clinic_backup_domain('${clinicId}','transactions')`),/BACKUP_CLARIFICATION_INTEGRITY_ANOMALY/);
  }
  await asOwner(`update cnyos_clarification_internal.tickets set clinic_id='${ids.clinicA}' where id='${revisedTicket.id}'`);
  // Populate only the disposable fixture to prove bounded history pagination.
  await asOwner(`insert into cnyos_clarification_internal.tickets
    (clinic_id,order_id,request_id,requested_by,question,snapshot,status)
    select '${ids.clinicA}','${order}',gen_random_uuid(),'${pharmacy}',
      'Synthetic history '||n,'{}'::jsonb,'resolved' from generate_series(1,102) n`);
  const first=(await asUser(pharmacy,history())).rows[0].result;
  assert.equal(first.tickets.length,100);
  assert.equal(first.next_cursor,first.tickets.at(-1).id);
  const second=(await asUser(ids.userA,history(first.next_cursor))).rows[0].result;
  assert.equal(second.tickets.length,5);
  assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.tickets,...second.tickets].map(row=>row.id)).size,105);
  assert.ok([...first.tickets,...second.tickets].every(row=>row.order_id===order && row.clinic_id===ids.clinicA));
  console.log('Clarification history: authorized discovery, empty results, bounded pagination without duplicates, tenant and suspended-session denial passed.');
  console.log('Clarification backup SQL candidate passed: populated tenant export, matching trace counts/hashes, foreign clinic exclusion and malformed tenant-link refusal. Live activation remains pending.');
  console.log('Local clarification candidate passed: role/tenant/ACL/suspension denial, replay/content conflict, unresolved hold, prescriber answer, Pharmacy acknowledgement, re-review, changed content rejection, stock unchanged while held, single deduction with replay, post-dispense reopening denied. Not deployment-ready.');
} finally { await db.close(); }
