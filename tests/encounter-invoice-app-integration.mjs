import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const strictOwnerReadback = process.argv.includes('--require-owner-readback');

// Real application handlers -> real migrated disposable SQL -> exact read-back.
// Dispensing uses the authenticated pharmacy RPC and disposable FEFO lots.
const {db,ids,asUser,asOwner} = await createPriceMasterFixture();
if (process.argv.includes('--signoff-candidate')) {
  const candidate=fs.readFileSync(new URL('../supabase/manual/clinical_signoff_assignment_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'CLINICAL_SIGNOFF_ASSIGNMENT_REVIEW_REQUIRED'; end $$;";
  assert.equal(candidate.split(blocker).length,2);
  await db.exec(candidate.replace(blocker,'-- Disposable integrated fixture only.'));
}
const patient='8b000000-0000-4000-8000-000000000001';
let encounter;
const billing='8b000000-0000-4000-8000-000000000003';
const financeActor=process.argv.includes('--owner-operations') ? ids.owner : billing;
const pharmacy='8b000000-0000-4000-8000-000000000004';
const reception='8b000000-0000-4000-8000-000000000005';
const literal = value => `'${String(value).replaceAll("'","''")}'`;
const setup=(await asUser(ids.owner,'select * from public.setup_price_master_default()')).rows[0];
await asOwner('select 1');
await db.exec(`insert into auth.users(id,email,raw_user_meta_data)
  values('${billing}','aggregate-billing@example.test','{"full_name":"Synthetic Billing"}');
  update public.profiles set role='billing',system_role='staff' where id='${billing}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
  values('${ids.clinicA}','${billing}','billing',true,true)
  on conflict(clinic_id,profile_id) do update set clinic_role='billing',is_primary=true,active=true;
  insert into auth.users(id,email,raw_user_meta_data)
  values('${pharmacy}','aggregate-pharmacy@example.test','{"full_name":"Synthetic Pharmacy"}');
  update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
  values('${ids.clinicA}','${pharmacy}','pharmacy',true,true)
  on conflict(clinic_id,profile_id) do update set clinic_role='pharmacy',is_primary=true,active=true;
  insert into auth.users(id,email,raw_user_meta_data)
  values('${reception}','aggregate-reception@example.test','{"full_name":"Synthetic Reception"}');
  update public.profiles set role='reception',system_role='staff' where id='${reception}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
  values('${ids.clinicA}','${reception}','reception',true,true)
  on conflict(clinic_id,profile_id) do update set clinic_role='reception',is_primary=true,active=true`);
await asUser(ids.owner,`select * from public.set_price_master_item('${setup.price_list_id}',
  'product','${ids.productA}',null,'ชิ้น',100,0,'Synthetic integration price')`);
await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
await db.query(`insert into public.patients(id,hn,first_name,last_name,created_by)
  values('${patient}','APP-AGG-SYN','Synthetic','Billing','${ids.owner}')`);
// Do not bypass the Reception-to-clinical handoff by inserting an Encounter.
const schedule=(await asUser(ids.owner,`select * from public.create_practitioner_schedule(
  '${ids.userA}','Synthetic integrated journey',now()+interval '1 day',
  now()+interval '1 day 1 hour','MAIN','SYN-ROOM',1,60,'Synthetic test only')`)).rows[0];
const appointment=(await asUser(reception,`select * from public.book_clinic_appointment(
  '${patient}','${schedule.id}','Synthetic integrated journey',null,'staff')`)).rows[0];
const checkInSql=`select * from public.check_in_clinic_appointment(
  '${appointment.id}','${patient}',null,'manual_hn',true,
  'Synthetic identity confirmation',null,'{}'::jsonb)`;
const checkedIn=(await asUser(reception,checkInSql)).rows[0];
encounter=checkedIn.encounter_id;
assert.ok(encounter);
assert.equal(checkedIn.patient_id,patient);
assert.equal(checkedIn.practitioner_id,ids.userA);
assert.equal(checkedIn.reused,false);
const repeated=(await asUser(reception,checkInSql)).rows[0];
assert.equal(repeated.encounter_id,encounter);
assert.equal(repeated.reused,true);
const linkage=(await asOwner(`select
  (select count(*)::int from public.encounters where id='${encounter}' and patient_id='${patient}' and clinic_id='${ids.clinicA}') encounters,
  (select count(*)::int from public.clinic_appointments where id='${appointment.id}' and encounter_id='${encounter}') appointments,
  (select count(*)::int from public.encounter_identity_verifications where encounter_id='${encounter}') verifications`)).rows[0];
assert.deepEqual(linkage,{encounters:1,appointments:1,verifications:1});
await asUser(ids.userA,`select * from public.set_clinic_appointment_status('${appointment.id}','in_service',null)`);
await assert.rejects(asUser(reception,`select * from public.create_clinical_treatment_session(
  '${encounter}',array['massage'],'Reception must not treat',false,null,null,4::smallint,2::smallint,'Synthetic','Synthetic',60)`),/PERMISSION_DENIED/);
await asOwner('select 1');
await db.query(`insert into public.inventory_lots(
    clinic_id,product_id,lot_number,expiry_date,received_quantity,current_quantity,unit,purchase_cost,status
  ) values
    ('${ids.clinicA}','${ids.productA}','APP-AGG-EXPIRED',current_date-1,10,10,'ชิ้น',25,'active'),
    ('${ids.clinicA}','${ids.productA}','APP-AGG-FEFO-1',current_date+1,1,1,'ชิ้น',25,'active'),
    ('${ids.clinicA}','${ids.productA}','APP-AGG-FEFO-2',current_date+30,1,1,'ชิ้น',25,'active')`);
await asUser(ids.userA,`select * from public.create_clinical_treatment_session(
  '${encounter}',array['massage'],'Synthetic session',false,null,null,4::smallint,2::smallint,'Synthetic','Synthetic',60)`);
const receipts=[];
for(let i=1;i<=2;i++) {
  const result=(await asUser(ids.userA,`select * from public.create_atomic_prescription_handoff(
    '8b000000-0000-4000-8000-00000000001${i}','${encounter}','Synthetic',
    '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]'::jsonb)`)).rows[0];
  receipts.push(result);
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
    '${result.dispensing_order_id}','review','[]'::jsonb,'Synthetic integration pharmacy review')`);
  const prescriptionItem=(await asUser(pharmacy,`select id from public.prescription_items
    where prescription_id='${result.prescription_id}' order by created_at,id`)).rows[0];
  const pricePayload=`[{"prescription_item_id":"${prescriptionItem.id}","unit_price":100}]`;
  if (i === 1) {
    // Synthetic shortage after partial FEFO allocation: only two valid units
    // exist, while the expired ten units must remain unusable.
    await asOwner(`update public.prescription_items set quantity_prescribed=3 where id='${prescriptionItem.id}'`);
    await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
      '${result.dispensing_order_id}','dispense','${pricePayload}'::jsonb,'Synthetic shortage')`), /PRESCRIPTION_STOCK_INSUFFICIENT/);
    const unchanged=(await asOwner(`select lot_number,current_quantity from public.inventory_lots
      where product_id='${ids.productA}' order by lot_number`)).rows;
    assert.deepEqual(unchanged.map(row=>[row.lot_number,Number(row.current_quantity)]),[
      ['APP-AGG-EXPIRED',10],['APP-AGG-FEFO-1',1],['APP-AGG-FEFO-2',1]
    ], 'failed partial allocation must restore all lot balances');
    assert.equal(Number((await asOwner(`select count(*) n from public.dispensing_items where dispensing_order_id='${result.dispensing_order_id}'`)).rows[0].n),0);
    assert.equal(Number((await asOwner(`select count(*) n from public.stock_movements where reference_id='${result.dispensing_order_id}'`)).rows[0].n),0);
    assert.equal((await asOwner(`select status from public.dispensing_orders where id='${result.dispensing_order_id}'`)).rows[0].status,'reviewed');
    await asOwner(`update public.prescription_items set quantity_prescribed=1 where id='${prescriptionItem.id}'`);
  }
  const dispensed=(await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
    '${result.dispensing_order_id}','dispense','${pricePayload}'::jsonb,
    'Synthetic integration FEFO dispense') result`)).rows[0].result;
  assert.equal(dispensed.status,'dispensed');
  const allocation=(await asUser(pharmacy,`select l.lot_number,di.quantity_dispensed,di.unit_price
    from public.dispensing_items di join public.inventory_lots l on l.id=di.inventory_lot_id
    where di.dispensing_order_id='${result.dispensing_order_id}'`)).rows;
  assert.equal(allocation.length,1);
  assert.equal(allocation[0].lot_number,`APP-AGG-FEFO-${i}`, 'earliest valid lot must be allocated first');
  assert.equal(Number(allocation[0].quantity_dispensed),1);
  assert.equal(Number(allocation[0].unit_price),100);
  const replay=(await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
    '${result.dispensing_order_id}','dispense','${pricePayload}'::jsonb,
    'Synthetic integration FEFO replay') result`)).rows[0].result;
  assert.equal(replay.idempotent,true);
  if(i===1) await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
    '${result.dispensing_order_id}','submit_billing','[]'::jsonb,
    'Synthetic integration billing handoff')`);
}
const lotBalances=(await asUser(pharmacy,`select lot_number,current_quantity from public.inventory_lots
  where product_id='${ids.productA}' and lot_number like 'APP-AGG-%' order by lot_number`)).rows;
assert.deepEqual(lotBalances.map(row=>[row.lot_number,Number(row.current_quantity)]),[
  ['APP-AGG-EXPIRED',10],['APP-AGG-FEFO-1',0],['APP-AGG-FEFO-2',0]
], 'FEFO must skip expired stock and replay must not consume again');
const signSql=`select * from public.sign_clinical_record_complete(
  '${encounter}','Synthetic Practitioner','SYN-TEST-LICENSE','Synthetic complete-record review')`;
await assert.rejects(asUser(ids.userA,signSql),/DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF/);
await asUser(ids.userA,`select public.save_ttm_diagnosis_atomic(
  p_encounter_id => '${encounter}',
  p_analysis_summary => 'Synthetic integrated diagnosis',
  p_thai_diagnosis => 'Synthetic test only',
  p_practitioner_confirmed => true,
  p_knowledge_version => 'SYNTHETIC-INTEGRATED-v1')`);
await assert.rejects(asUser(reception,signSql),/PERMISSION_DENIED/);
const signoff=(await asUser(ids.userA,signSql)).rows[0];
assert.equal(signoff.signer_id,ids.userA);
assert.equal(signoff.encounter_id,encounter);
assert.equal(signoff.lock_record,true);
const signedAudit=(await asUser(ids.userA,`select actor_id,reason from public.clinical_record_audit_events
  where encounter_id='${encounter}' and event_type='SIGN_AND_LOCK'`)).rows;
assert.equal(signedAudit.length,1);
assert.equal(signedAudit[0].actor_id,ids.userA);
assert.equal(signedAudit[0].reason,'Synthetic complete-record review');
await assert.rejects(asUser(ids.userA,`select * from public.create_clinical_treatment_session(
  '${encounter}',array['massage'],'Must not add after signing',false,null,null,4::smallint,2::smallint,'Synthetic','Synthetic',60)`),/CLINICAL_RECORD_LOCKED/);
const completedAppointment=(await asUser(ids.userA,`select * from public.set_clinic_appointment_status(
  '${appointment.id}','completed',null)`)).rows[0];
assert.equal(completedAppointment.status,'completed');
await assert.rejects(asUser(financeActor,`select public.quote_encounter_invoice('${encounter}')`),
  /DISPENSING_ORDER_NOT_READY_FOR_BILLING/, 'one ready order must not hide another waiting order');
await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing(
  '${receipts[1].dispensing_order_id}','submit_billing','[]'::jsonb,
  'Synthetic integration delayed billing handoff')`);
const quote=(await asUser(financeActor,`select public.quote_encounter_invoice('${encounter}') quote`)).rows[0].quote;
const ownerQuote=(await asUser(ids.owner,`select public.quote_encounter_invoice('${encounter}') quote`)).rows[0].quote;
assert.equal(Number(quote.grand_total),850);
assert.equal(quote.orders.length,2);
const nodes=new Map();
const node=selector=>{
  if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',dataset:{},
    classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelectorAll:()=>[],reset(){},showModal(){this.open=true;},close(){this.open=false;},replaceChildren(){this.innerHTML='';}});
  return nodes.get(selector);
};
let loseResponse=true;
let losePaymentResponse=true;
const paymentRequests=[];
const requests=[];
const api={
  async rpc(name,args){
    if(name==='get_owner_invoice_context') return {data:(await asUser(financeActor,
      'select * from public.get_owner_invoice_context($1::uuid)',[args.p_invoice_id])).rows};
    if(name==='record_atomic_invoice_payment') {
      assert.equal(journalRecords.size,1,'request marker must be durable before the payment RPC');
      paymentRequests.push({...args});
      const result=await asUser(financeActor,`select * from public.record_atomic_invoice_payment(
        ${literal(args.p_request_key)}::uuid,${literal(args.p_invoice_id)}::uuid,${Number(args.p_amount)},
        ${literal(args.p_channel)},${literal(args.p_reference_note || '')})`);
      if(losePaymentResponse){losePaymentResponse=false;throw new Error('Synthetic lost payment response after commit');}
      return {data:result.rows};
    }
    assert.equal(name,'issue_atomic_encounter_invoice');
    requests.push({...args});
    const result=await asUser(financeActor,`select * from public.issue_atomic_encounter_invoice(
      ${literal(args.p_request_key)}::uuid,${literal(args.p_encounter_id)}::uuid,${literal(args.p_quote_fingerprint)})`);
    if(loseResponse){loseResponse=false;throw new Error('Synthetic lost response after commit');}
    return {data:result.rows};
  },
  from(table){
    assert.ok(['invoices','payments','patients'].includes(table));
    let id,field;
    return {select(){return this;},eq(key,value){assert.ok(key==='id'||(table==='payments'&&key==='request_key'));field=key;id=value;return this;},async single(){
      const row=(await asUser(financeActor,`select * from public.${table} where ${field}=${literal(id)}::uuid`)).rows[0];
      return {data:row?JSON.parse(JSON.stringify(row)):null}; // Match JSON REST timestamp serialization.
    }};
  }
};
const journalRecords=new Map();
const sandbox={console,setTimeout:()=>0,clearTimeout(){},URL,URLSearchParams,TextEncoder,
  sessionStorage:{getItem:k=>journalRecords.get(k)??null,setItem:(k,v)=>journalRecords.set(k,v),removeItem:k=>journalRecords.delete(k)},
  crypto:{subtle:webcrypto.subtle,randomUUID:()=> '8b000000-0000-4000-8000-000000000099'},
  window:{addEventListener(){}},document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}}};
vm.runInNewContext(fs.readFileSync(new URL('../payment-journal.js',import.meta.url),'utf8'),sandbox);
vm.runInNewContext(fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace('  init();\n})();',`
  globalThis.hooks={createInvoice,savePayment,showReceipt,setFinancial(invoices,payments){data.invoices=invoices;data.payments=payments;},init(database,quote){session={user:{id:'${financeActor}'}};profile={clinic_id:'${ids.clinicA}',clinic_role:'${financeActor===ids.owner ? 'owner' : 'billing'}',access_context_ready:true};db=database;atomicHandoffsReady=true;loadAll=async()=>{};
    encounterInvoiceQuotes.set(quote.encounter_id,quote);},request(id){return encounterInvoiceRequests.get(id);}};
})();`),sandbox);
sandbox.hooks.init(api,quote);
await assert.rejects(sandbox.hooks.createInvoice(encounter),/Synthetic lost response/);
assert.ok(sandbox.hooks.request(encounter));
await sandbox.hooks.createInvoice(encounter);
assert.equal(sandbox.hooks.request(encounter),undefined);
assert.deepEqual(requests[1],requests[0]);
const invoices=(await asUser(financeActor,`select * from public.invoices where encounter_id='${encounter}'`)).rows;
assert.equal(invoices.length,1);
assert.equal(invoices[0].patient_id,patient);
assert.equal(Number(invoices[0].grand_total),850);
// Report the unresolved owner/department policy mismatch without treating it as
// a passing authorization requirement or broadening financial access in a test.
const ownerRead = (await asUser(ids.owner,`select id from public.invoices where id='${invoices[0].id}'`)).rows;
const ownerReadbackGap = Boolean(ownerQuote) && ownerRead.length !== 1;
if (ownerReadbackGap) {
  console.warn('OPEN_ACCEPTANCE_GAP: owner clinic membership can quote this encounter but cannot read its invoice; financial role policy must be aligned before owner live acceptance');
}
const lines=(await asUser(financeActor,`select item_type,line_total from public.invoice_items where invoice_id='${invoices[0].id}'`)).rows;
assert.equal(lines.filter(x=>x.item_type==='product').length,2);
assert.equal(lines.filter(x=>x.item_type==='service').length,1);
sandbox.hooks.setFinancial(invoices,[]);
node('#pay-invoice').value=invoices[0].id;
node('#pay-amount').value='850';
node('#pay-channel').value='cash';
node('#pay-note').value='Synthetic integration receipt';
const form=node('#pay-form');
await assert.rejects(sandbox.hooks.savePayment({preventDefault(){},currentTarget:form,target:form}), /Synthetic lost payment response/);
assert.equal(journalRecords.size,1,'lost response must retain request identity');
const committedInvoices=(await asUser(financeActor,`select * from public.invoices where id='${invoices[0].id}'`)).rows;
assert.equal(Number(committedInvoices[0].balance_due),0);
sandbox.hooks.setFinancial(committedInvoices,[]);
node('#pay-invoice').value='';
node('#pay-amount').value='';
await sandbox.hooks.savePayment({preventDefault(){},currentTarget:form,target:form},true);
assert.equal(journalRecords.size,0,'only verified recovery clears the request');
assert.deepEqual(paymentRequests[1],paymentRequests[0], 'payment recovery must reuse the exact committed request');
assert.equal(form.dataset.requestKey,undefined);
assert.match(node('#toast').textContent,/ปิด Encounter/);
const finalInvoices=(await asUser(financeActor,`select * from public.invoices where id='${invoices[0].id}'`)).rows;
const payments=(await asUser(financeActor,`select * from public.payments where invoice_id='${invoices[0].id}'`)).rows;
assert.equal(Number(finalInvoices[0].balance_due),0);
assert.equal(payments.length,1);
sandbox.hooks.setFinancial(finalInvoices,payments);
await sandbox.hooks.showReceipt(payments[0].id);
assert.ok(node('#receipt-body').innerHTML.includes(payments[0].payment_reference));
assert.match(node('#receipt-body').innerHTML,/850\.00/);
const completed=(await asUser(ids.userA,`select id,patient_id,status from public.encounters where id='${encounter}'`)).rows[0];
assert.equal(completed.patient_id,patient);
assert.equal(completed.status,'closed');
const finalLink=(await asUser(reception,`select encounter_id from public.clinic_appointments where id='${appointment.id}'`)).rows[0];
assert.equal(finalLink.encounter_id,encounter,'paid journey must retain the original appointment-to-Encounter link');
await db.close();
// Finish the Billing journey and close the fixture even when this separate
// acceptance check is blocked. Never change authorization to make this pass.
if (strictOwnerReadback && ownerReadbackGap) {
  console.error('OWNER_FINANCE_ACCEPTANCE_BLOCKED: Owner quote/read-back mismatch reproduced. An explicit role decision and aligned UI/RPC/RLS tests are required; no permission change was made. Billing regression completed, but this acceptance command fails.');
  process.exitCode = 1;
} else {
console.log('Encounter invoice app/SQL integration passed: Reception booking/check-in replay, assigned practitioner, two Rx plus service, FEFO, diagnosis-required signoff/audit, completed appointment, lost-response recovery, one invoice, receipt and closed original Encounter. Disposable SQL/handler evidence, not hosted browser acceptance.');
}
