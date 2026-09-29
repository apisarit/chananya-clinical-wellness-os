// Actual candidate SQL in disposable PGlite, real browser UI, fixed synthetic actors.
// Not PostgREST/JWT, native concurrency, production or clinical acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const fixture = await createPriceMasterFixture({permissiveDefaults:true});
const {db,ids,asOwner,asUser}=fixture;
const key=n=>`7b000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pharmacy=key(1), patient=key(2), encounter=key(3);
const literal=value=>value==null?'null':`'${String(value).replaceAll("'","''")}'`;
let browser;
try {
  await asOwner(`insert into auth.users(id,email) values('${pharmacy}','synthetic-ui-pharmacy@example.test');`);
  await asOwner(`update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}'`);
  await asOwner(`insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${pharmacy}','pharmacy',true,true) on conflict(clinic_id,profile_id)
    do update set clinic_role='pharmacy',is_primary=true,active=true`);
  await asOwner(`insert into public.patients(id,clinic_id,hn,first_name,last_name,created_by)
    values('${patient}','${ids.clinicA}','CLARIFY-UI','Synthetic','Only','${ids.owner}')`);
  await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${encounter}','CLARIFY-UI-ENC','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.owner}')`);
  await db.exec(await fs.readFile(new URL('../supabase/manual/pharmacy_clarification_candidate.sql',import.meta.url),'utf8'));
  const handoff=(await asUser(ids.userA,`select * from public.create_atomic_prescription_handoff(
    '${key(4)}','${encounter}','Synthetic UI handoff',
    '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]'::jsonb)`)).rows[0];
  const orderId=handoff.dispensing_order_id;
  assert.ok(orderId);
  browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  const scripts=await Promise.all(['clarification-action.js','clarification-history.js'].map(file=>fs.readFile(new URL(`../${file}`,import.meta.url),'utf8')));
  const calls=[]; let serial=Promise.resolve(); let loseOpenResponse=true;
  async function actorPage(actorId,mode) {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.abort());
    await context.route('https://clarification-db.invalid/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="th"><body></body></html>'}));
    const page=await context.newPage();
    await page.exposeFunction('testRpc',async(name,args)=>{
      assert.equal(name,'manage_prescription_clarification');
      assert.equal(args.p_order_id,orderId);
      assert.ok(['open','answer','acknowledge','read','history'].includes(args.p_action));
      calls.push({actorId,action:args.p_action});
      // Serialize role setup/query/reset on PGlite's one session; this is not a race test.
      const result=serial.then(async()=>{
        try {
          const value=(await asUser(actorId,`select public.manage_prescription_clarification(
            ${literal(args.p_order_id)}::uuid,${literal(args.p_request_id)}::uuid,
            ${literal(args.p_action)},${literal(args.p_text)}) result`)).rows[0].result;
          if(args.p_action==='open' && loseOpenResponse) {loseOpenResponse=false;return {error:{message:'synthetic response loss after commit'}};}
          return {data:value};
        } catch(error) {return {error:{message:error.message,code:error.code}};}
      });
      serial=result.then(()=>{},()=>{});
      return result;
    });
    async function mount() {
      await page.goto('https://clarification-db.invalid/');
      for(const content of scripts) await page.addScriptTag({content});
      await page.evaluate(({actorId,mode,orderId})=>{
        CnyosClarificationHistory.open({db:{rpc:(name,args)=>window.testRpc(name,args)},actorId,mode,orderId});
      },{actorId,mode,orderId});
    }
    await mount(); return {page,mount};
  }
  const pharm=await actorPage(pharmacy,'pharmacy');
  await pharm.page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).fill('Synthetic question from pharmacy');
  await pharm.page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
  await pharm.page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).waitFor();
  await pharm.mount(); // Full navigation clears pending Map; recover from metadata journal.
  await pharm.page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).click();
  await pharm.page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  assert.equal(calls.filter(call=>call.action==='open').length,1);
  await pharm.mount();
  await pharm.page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).fill('Synthetic second question while first is open');
  await pharm.page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
  await pharm.page.getByRole('button',{name:'กลับไปตรวจประวัติและแก้ไข',exact:true}).click();
  await pharm.page.getByText('คำถาม: Synthetic question from pharmacy',{exact:true}).waitFor();
  assert.equal((await asOwner(`select count(*)::int n from cnyos_clarification_internal.tickets where order_id='${orderId}'`)).rows[0].n,1);
  await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${orderId}','review')`),/CLARIFICATION_PENDING/);
  const doctor=await actorPage(ids.userA,'prescriber');
  await doctor.page.getByText('คำถาม: Synthetic question from pharmacy',{exact:true}).waitFor();
  await doctor.page.getByLabel('คำตอบสำหรับใบสั่งยาเดิม (ไม่แก้รายการยา)',{exact:true}).fill('Synthetic response from assigned prescriber');
  await doctor.page.getByRole('button',{name:'บันทึกคำตอบ',exact:true}).click();
  await doctor.page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  await assert.rejects(asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${orderId}','review')`),/CLARIFICATION_PENDING/);
  await pharm.mount();
  await pharm.page.getByText('คำตอบ: Synthetic response from assigned prescriber',{exact:true}).waitFor();
  await pharm.page.getByRole('button',{name:'ยืนยันคำตอบ',exact:true}).click();
  await pharm.page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  await pharm.mount();
  await pharm.page.getByText(/ยืนยันคำตอบแล้ว — ต้องตรวจทาน/).waitFor();
  const persisted=(await asOwner(`select * from cnyos_clarification_internal.tickets where order_id='${orderId}'`)).rows;
  assert.equal(persisted.length,1);
  assert.equal(persisted[0].status,'resolved');
  assert.equal(persisted[0].requested_by,pharmacy);
  assert.equal(persisted[0].answered_by,ids.userA);
  assert.equal(persisted[0].acknowledged_by,pharmacy);
  assert.equal((await asOwner(`select status from public.dispensing_orders where id='${orderId}'`)).rows[0].status,'waiting');
  await asUser(pharmacy,`select public.transition_atomic_prescription_dispensing('${orderId}','review')`);
  const foreign=await actorPage(ids.userB,'prescriber');
  await foreign.page.getByText(/โหลดประวัติไม่ได้/).waitFor();
  assert.equal(await foreign.page.locator('article').count(),0);
  assert.equal((await asOwner(`select count(*)::int n from public.audit_logs where entity='prescription_clarifications'`)).rows[0].n,3);
  console.log('Clarification browser/database passed: actual SQL ask/answer/ack, lost-response read recovery, reload persistence, correct actors/audit, hold until ack and re-review, foreign-clinic denial. PGlite only; no live data.');
} finally {if(browser) await browser.close(); await db.close();}
