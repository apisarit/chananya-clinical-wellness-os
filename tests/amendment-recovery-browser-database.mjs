// Real local controller + candidate SQL, synthetic PGlite. Not hosted/JWT evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
const read=file=>fs.readFile(new URL('../'+file,import.meta.url),'utf8');
const {db,ids,asOwner,asUser}=await createPriceMasterFixture();
const encounter='9e000000-0000-4000-8000-000000000001';
const reason='เหตุผลทดสอบการแก้ไข ไม่ใช่ข้อมูลผู้ป่วย';
let browser;
try {
  await asOwner('select 1');
  await db.exec(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select '${encounter}','SYN-AMEND-BROWSER',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;
    insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
      values('${encounter}','Synthetic analysis','Synthetic diagnosis','${ids.userA}');
    insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
      values('${encounter}','Synthetic goal','${ids.userA}');`);
  const sign=()=>asUser(ids.userA,'select * from public.sign_clinical_record_complete($1,$2,null,$3)',[encounter,'Synthetic signer','Synthetic browser sign']);
  await sign();
  await asOwner('select 1');
  const sql=await read('supabase/manual/clinical_amendment_recovery_candidate.sql');
  const blocker="do $$ begin raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'; end $$;";
  assert.equal(sql.split(blocker).length,2);
  await db.exec(sql.replace(blocker,'-- Disposable browser integration fixture only.'));
  browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('**/*',route=>route.abort());
  const html=(await read('admin.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
  await context.route('https://amendment-synthetic.invalid/',route=>route.fulfill({contentType:'text/html',body:html}));
  const page=await context.newPage(),errors=[],messages=[],calls=[];
  let serial=Promise.resolve(),loseReply=true;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{messages.push(dialog.message());if(dialog.type()==='confirm')await dialog.accept();else await dialog.dismiss();});
  const enqueue=fn=>{const result=serial.then(fn);serial=result.then(()=>{},()=>{});return result;};
  await page.exposeFunction('syntheticQuery',(table,single,value)=>enqueue(async()=>{
    assert.equal(value,encounter);
    assert.ok(['encounters','clinical_record_signoffs','clinical_record_audit_events'].includes(table));
    const filter=table==='encounters'?'id':'encounter_id';
    try {
      const rows=(await asUser(ids.superAdmin,`select * from public.${table} where ${filter}=$1`,[value])).rows;
      return {data:JSON.parse(JSON.stringify(single?rows[0]??null:rows))};
    }catch(error){return {error:{code:error.code,message:error.message}};}
  }));
  await page.exposeFunction('syntheticRpc',(name,args)=>enqueue(async()=>{
    calls.push({name,args});
    try {
      if(name==='unlock_clinical_record_for_amendment_v2') {
        assert.equal(args.p_encounter_id,encounter);
        const result=await asUser(ids.superAdmin,'select public.unlock_clinical_record_for_amendment_v2($1,$2,$3,$4,$5) receipt',
          [args.p_request_id,args.p_encounter_id,args.p_signoff_id,args.p_signature_generation,args.p_reason]);
        if(loseReply){loseReply=false;return {error:{message:'Synthetic response lost after database commit'}};}
        return {data:result.rows[0].receipt};
      }
      assert.equal(name,'read_clinical_amendment_receipt');
      return {data:(await asUser(ids.superAdmin,'select public.read_clinical_amendment_receipt($1) receipt',[args.p_request_id])).rows[0].receipt};
    }catch(error){return {error:{code:error.code,message:error.message}};}
  }));
  async function mount() {
    await page.goto('https://amendment-synthetic.invalid/');
    await page.addStyleTag({content:await read('app.css')});
    await page.evaluate(({actor,clinic})=>{
      document.querySelector('#boot').classList.add('hidden');document.querySelector('#app').classList.remove('hidden');
      document.querySelectorAll('.view').forEach(node=>node.classList.remove('active'));
      document.querySelector('#clinical-audit').classList.add('active');
      window.ChananyaRuntime={getDb:()=>({auth:{onAuthStateChange(){}},rpc:(name,args)=>window.syntheticRpc(name,args),from(table){
        let single=false,value;
        const q={select(){return q;},eq(field,v){value=v;return q;},order(){return q;},maybeSingle(){single=true;return q;},
          then(ok,bad){return window.syntheticQuery(table,single,value).then(ok,bad);}};return q;
      }}),getSession:async()=>({user:{id:actor}}),getProfile:async()=>({clinic_id:clinic}),can:()=>true};
    },{actor:ids.superAdmin,clinic:ids.clinicA});
    await page.addScriptTag({content:await read('amendment-journal.js')});
    await page.addScriptTag({content:await read('admin-clinical-audit.js')});
    await page.waitForFunction(()=>document.querySelector('#amend-recovery-status').textContent!=='กำลังตรวจคำขอค้างในแท็บนี้…');
  }
  const count=async()=>Number((await asOwner('select count(*) n from public.clinical_record_audit_events where encounter_id=$1 and event_type=$2',[encounter,'UNLOCK_FOR_AMENDMENT'])).rows[0].n);
  await mount();
  await page.locator('#audit-query').fill(encounter);await page.locator('#audit-search-form button').click();
  await page.waitForFunction(()=>document.querySelector('#amend-encounter').value.length===36);
  await page.locator('#amend-reason').fill(reason);await page.locator('#amend-submit').click();
  await page.getByText('ยังยืนยันผลไม่ได้ กรุณาตรวจผลคำขอเดิมก่อนส่งอีกครั้ง',{exact:true}).waitFor();
  assert.equal(await count(),1);
  const stored=await page.evaluate(()=>Object.values(sessionStorage));
  assert.equal(stored.length,1);assert.equal(stored[0].includes(reason),false);
  const oldRequest=JSON.parse(stored[0]).requestId;
  const resigned=(await sign()).rows[0];assert.equal(resigned.lock_record,true);
  await mount(); // Navigation resets controller but retains metadata-only recovery.
  await page.locator('#amend-recover').focus();await page.keyboard.press('Enter');
  await page.getByText('ไม่มีคำขอค้างในแท็บนี้',{exact:true}).waitFor();
  assert.equal(calls.filter(call=>call.name==='unlock_clinical_record_for_amendment_v2').length,1);
  assert.equal(calls.find(call=>call.name==='read_clinical_amendment_receipt').args.p_request_id,oldRequest);
  assert.equal((await asOwner('select lock_record from public.clinical_record_signoffs where encounter_id=$1',[encounter])).rows[0].lock_record,true);
  assert.equal(await count(),1,'read-only recovery must not repeat unlock or audit');
  await page.locator('#audit-query').fill(encounter);await page.locator('#audit-search-form button').click();
  await page.waitForFunction(()=>document.querySelector('#amend-encounter').value.length===36);
  await page.locator('#amend-reason').fill('เหตุผลทดสอบใหม่ หลังตรวจลายเซ็นใหม่');
  await page.locator('#amend-submit').click();
  await page.waitForFunction(()=>document.querySelector('#amend-reason').value==='');
  assert.equal(await count(),2);
  const second=calls.filter(call=>call.name==='unlock_clinical_record_for_amendment_v2')[1];
  assert.notEqual(second.args.p_request_id,oldRequest);assert.equal(second.args.p_signature_generation,String(resigned.signature_generation));
  assert.deepEqual(errors,[]);
  assert.ok(messages.some(message=>message.includes('ไม่มีการปลดล็อกซ้ำ')));
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'/tmp/cnyos-amendment-recovery-mobile.png',fullPage:true});
  console.log('Amendment browser/database passed: actual mobile controls, Thai reason digest, committed response loss, reload/read-only recovery, re-signed record preserved and explicit new generation unlock. Synthetic PGlite only.');
} finally {if(browser)await browser.close();await db.close();}
