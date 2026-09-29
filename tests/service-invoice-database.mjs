import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// Real migrated disposable SQL and the production journal. Auth is a fixture;
// this is not hosted Supabase/PostgREST or browser evidence.
const {db,ids,asUser,asOwner}=await createPriceMasterFixture();
try {
  const billing=randomUUID(), reception=randomUUID(), patient=randomUUID();
  const literal=v=>`'${String(v).replaceAll("'","''")}'`;
  await asUser(ids.owner,'select * from public.setup_price_master_default()');
  await asOwner(`insert into auth.users(id,email) values('${billing}','service-billing@example.test')`);
  await asOwner(`update public.profiles set role='billing',system_role='staff' where id='${billing}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${billing}','billing',true,true)
    on conflict(clinic_id,profile_id) do update set clinic_role='billing',is_primary=true,active=true`);
  await asOwner(`insert into auth.users(id,email) values('${reception}','service-reception@example.test')`);
  await asOwner(`update public.profiles set role='reception',system_role='staff' where id='${reception}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${reception}','reception',true,true)
    on conflict(clinic_id,profile_id) do update set clinic_role='reception',is_primary=true,active=true`);
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await db.query(`insert into public.patients(id,hn,first_name,last_name,created_by)
    values('${patient}','SERVICE-RECOVERY-SYN','Synthetic','Recovery','${ids.owner}')`);
  const entries=new Map();
  const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
  const loadJournal=()=>{
    const window={};vm.runInNewContext(fs.readFileSync(new URL('../service-invoice-journal.js',import.meta.url),'utf8'),{window,crypto:webcrypto,TextEncoder,sessionStorage:storage});
    return window.CnyosServiceInvoiceJournal;
  };
  for(const [commitBeforeReload,minutes] of [[true,60],[false,45],[true,1]]) {
    const stockBefore=(await asOwner('select count(*)::int n from public.stock_movements')).rows[0].n;
    const schedule=(await asUser(ids.owner,`select * from public.create_practitioner_schedule(
      '${ids.userA}','Synthetic service-only',now()+interval '${minutes} days',
      now()+interval '${minutes} days 1 hour','MAIN','SYN-SERVICE',1,60,'Synthetic test only')`)).rows[0];
    const appointment=(await asUser(reception,`select * from public.book_clinic_appointment(
      '${patient}','${schedule.id}','Synthetic service-only',null,'staff')`)).rows[0];
    const checkIn=`select * from public.check_in_clinic_appointment(
      '${appointment.id}','${patient}',null,'manual_hn',true,
      'Synthetic identity confirmation',null,'{}'::jsonb)`;
    const checked=(await asUser(reception,checkIn)).rows[0];
    const encounter=checked.encounter_id;
    assert.ok(encounter);
    assert.equal(checked.patient_id,patient);
    assert.equal(checked.practitioner_id,ids.userA);
    assert.equal(checked.reused,false);
    const rechecked=(await asUser(reception,checkIn)).rows[0];
    assert.equal(rechecked.encounter_id,encounter);
    assert.equal(rechecked.reused,true);
    assert.equal((await asOwner(`select count(*)::int n from public.encounter_identity_verifications where encounter_id='${encounter}'`)).rows[0].n,1);
    await asUser(ids.userA,`select * from public.set_clinic_appointment_status('${appointment.id}','in_service',null)`);
    await asUser(ids.userA,`select * from public.create_clinical_treatment_session('${encounter}',array['massage'],'Synthetic session',false,null,null,null,null,'Completed',null,${minutes})`);
    const sign=`select * from public.sign_clinical_record_complete(
      '${encounter}','Synthetic practitioner','SYN-TEST-LICENSE','Synthetic service-only review')`;
    await assert.rejects(asUser(ids.userA,sign),/DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF/);
    await asUser(ids.userA,`select public.save_ttm_diagnosis_atomic(
      p_encounter_id => '${encounter}',
      p_analysis_summary => 'Synthetic service-only diagnosis',
      p_thai_diagnosis => 'Synthetic test only',
      p_practitioner_confirmed => true,
      p_knowledge_version => 'SYNTHETIC-SERVICE-v1')`);
    await assert.rejects(asUser(billing,sign),/PERMISSION_DENIED/);
    const signed=(await asUser(ids.userA,sign)).rows[0];
    assert.equal(signed.signer_id,ids.userA);
    assert.equal(signed.encounter_id,encounter);
    assert.equal(signed.lock_record,true);
    const signAudit=(await asUser(ids.userA,`select actor_id,reason from public.clinical_record_audit_events
      where encounter_id='${encounter}' and event_type='SIGN_AND_LOCK'`)).rows;
    assert.equal(signAudit.length,1);
    assert.equal(signAudit[0].actor_id,ids.userA);
    assert.equal(signAudit[0].reason,'Synthetic service-only review');
    await asUser(ids.userA,`select * from public.set_clinic_appointment_status('${appointment.id}','completed',null)`);
    const quote=(await asUser(billing,`select * from public.quote_treatment_invoice('${encounter}')`)).rows[0];
    assert.equal(Number(quote.amount),Math.round(650 * minutes / 60 * 100) / 100);
    const args={actorId:billing,clinicId:ids.clinicA,encounterId:encounter,amount:Number(quote.amount),description:quote.description,storage};
    const original=await loadJournal().prepare(args);
    const issue=()=>asUser(billing,`select * from public.issue_atomic_treatment_invoice('${original.requestId}','${encounter}',${Number(quote.amount)},${literal(quote.description)})`);
    if(commitBeforeReload) await issue(); // Simulate a lost response after commit.
    const journal=loadJournal();
    assert.equal(journal.restore(args).requestId,original.requestId);
    const readInvoice=async(marker,actor=billing)=>{
      const invoice=(await asUser(actor,`select id,encounter_id,created_by,source_service_request_key,grand_total from public.invoices where source_service_request_key='${marker.requestId}'`)).rows[0];
      if(!invoice) throw new Error('RECEIPT_NOT_VISIBLE');
      const enc=(await asUser(actor,`select id,clinic_id from public.encounters where id='${invoice.encounter_id}'`)).rows[0];
      const items=(await asUser(actor,`select invoice_id,item_type,quantity,unit_price,line_total,description from public.invoice_items where invoice_id='${invoice.id}'`)).rows;
      return {invoice,items,clinicId:enc?.clinic_id};
    };
    if(!commitBeforeReload) {
      await assert.rejects(journal.recover({...args,isCurrent:()=>true,readInvoice}),/RECEIPT_NOT_VISIBLE/);
      assert.equal(journal.restore(args).requestId,original.requestId);
      const resumed=await journal.prepare({...args,expectedRequestId:original.requestId});
      assert.equal(resumed.requestId,original.requestId);
      await issue();
    }
    await assert.rejects(journal.recover({...args,isCurrent:()=>true,readInvoice:marker=>readInvoice(marker,ids.userB)}),/RECEIPT_NOT_VISIBLE|permission denied/);
    assert.equal(journal.restore(args).requestId,original.requestId);
    const before=(await asOwner(`select count(*)::int n from public.invoices where encounter_id='${encounter}'`)).rows[0].n;
    const recovered=await journal.recover({...args,isCurrent:()=>true,readInvoice});
    assert.equal(recovered.source_service_request_key,original.requestId);
    assert.equal(journal.restore(args),null);
    const replay=(await issue()).rows[0];
    assert.equal(replay.invoice_id,recovered.id);
    const after=(await asOwner(`select count(*)::int n from public.invoices where encounter_id='${encounter}'`)).rows[0].n;
    assert.equal(before,1);assert.equal(after,1);
    // Continue the same no-medication visit through collection and durable
    // receipt read-back under Billing, rather than stopping at invoice creation.
    const total=Number(quote.amount);
    const partial=minutes===60?200:0;
    if(partial) {
      const partialKey=randomUUID();
      const part=()=>asUser(billing,`select * from public.record_atomic_invoice_payment(
        '${partialKey}','${recovered.id}',${partial},'cash','Synthetic partial service payment')`);
      const first=(await part()).rows[0];
      assert.equal((await part()).rows[0].payment_id,first.payment_id);
      assert.equal(Number(first.balance_due),total-partial);
      const financialState=async()=>({
        invoice:(await asUser(billing,`select status,balance_due,paid_amount from public.invoices where id='${recovered.id}'`)).rows,
        payments:(await asUser(billing,`select id,amount,payment_reference from public.payments where invoice_id='${recovered.id}' order by id`)).rows,
        encounter:(await asUser(billing,`select status from public.encounters where id='${encounter}'`)).rows
      });
      const beforeDenied=await financialState();
      await assert.rejects(asUser(billing,`select * from public.record_atomic_invoice_payment(
        '${randomUUID()}','${recovered.id}',${total-partial+1},'cash','Synthetic excessive payment')`),/PAYMENT_EXCEEDS_BALANCE/);
      assert.deepEqual(await financialState(),beforeDenied,'overpayment refusal must preserve financial state');
      await assert.rejects(asUser(billing,`select * from public.record_atomic_invoice_payment(
        '${partialKey}','${recovered.id}',${partial+1},'cash','Synthetic partial service payment')`),/IDEMPOTENCY_KEY_REUSED/);
      assert.deepEqual(await financialState(),beforeDenied,'changed retry payload must not alter the original payment');
      const outstanding=(await asUser(billing,`select balance_due,paid_amount from public.invoices where id='${recovered.id}'`)).rows[0];
      assert.equal(Number(outstanding.balance_due),total-partial);
      assert.equal(Number(outstanding.paid_amount),partial);
      assert.notEqual((await asUser(billing,`select status from public.encounters where id='${encounter}'`)).rows[0].status,'closed','partial collection cannot imply settlement');
      assert.equal((await asUser(billing,`select id from public.payments where invoice_id='${recovered.id}'`)).rows.length,1);
    }
    const paymentKey=randomUUID();
    const pay=()=>asUser(billing,`select * from public.record_atomic_invoice_payment(
      '${paymentKey}','${recovered.id}',${total-partial},'cash','Synthetic service-only payment')`);
    const collected=(await pay()).rows[0];
    const repeated=(await pay()).rows[0];
    assert.equal(repeated.payment_id,collected.payment_id);
    assert.equal(repeated.payment_reference,collected.payment_reference);
    assert.equal(Number(collected.balance_due),0);
    const savedPayments=(await asUser(billing,`select id,payment_reference,amount from public.payments where invoice_id='${recovered.id}'`)).rows;
    assert.equal(savedPayments.length,partial?2:1);
    const finalPayment=savedPayments.find(payment=>payment.id===collected.payment_id);
    assert.ok(finalPayment);
    assert.ok(finalPayment.payment_reference);
    assert.equal(Number(finalPayment.amount),total-partial);
    assert.equal(savedPayments.reduce((sum,payment)=>sum+Number(payment.amount),0),total);
    const savedInvoice=(await asUser(billing,`select balance_due,paid_amount from public.invoices where id='${recovered.id}'`)).rows[0];
    assert.equal(Number(savedInvoice.balance_due),0);
    assert.equal(Number(savedInvoice.paid_amount),Number(quote.amount));
    assert.equal((await asUser(billing,`select status from public.encounters where id='${encounter}'`)).rows[0].status,'closed');
    assert.equal((await asOwner(`select count(*)::int n from public.prescriptions where encounter_id='${encounter}'`)).rows[0].n,0);
    assert.equal((await asOwner('select count(*)::int n from public.stock_movements')).rows[0].n,stockBefore);
    assert.equal((await asUser(ids.userB,`select id from public.payments where invoice_id='${recovered.id}'`)).rows.length,0);
    const finalAppointment=(await asUser(reception,`select encounter_id,status from public.clinic_appointments where id='${appointment.id}'`)).rows[0];
    assert.equal(finalAppointment.encounter_id,encounter);
    assert.equal(finalAppointment.status,'completed');
  }
  console.log('Service invoice database recovery passed: Reception booking/check-in replay, assigned-practitioner diagnosis/signoff/audit, Billing signoff denial, full migrations, pre/post-commit reload, exact invoice/items, foreign-clinic denial, one invoice, full and partial-then-remainder payment replay, receipt read-back, outstanding-before-settlement and closed-after-settlement Encounter with no prescription or stock movement. Disposable PGlite only; users/patient are synthetic fixtures, not hosted/browser acceptance.');
} finally {await db.close();}
