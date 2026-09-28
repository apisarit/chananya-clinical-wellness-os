// Actual markup + controller, synthetic API, all external traffic blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage(),errors=[],messages=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{messages.push(d.message());await d.dismiss();});
  await page.route('https://bodymap-synthetic.invalid/',route=>route.fulfill({contentType:'text/html',body:read('clinical-v3.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'')}));
  const setup=async()=>{
    await page.evaluate(()=>{
      document.querySelector('#app').classList.remove('hidden');
      document.querySelector('#encounter').innerHTML='<option value="synthetic-encounter">Synthetic case</option>';
      window.writes=0;window.mode='missing';
      window.row={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',recorded_by:'synthetic-actor',encounter_id:'synthetic-encounter',assessment_stage:'before',body_view:'front',x_percent:12.34,y_percent:56.78,symptom_type:'pain',pain_score:4,side:'left',body_region:'Synthetic region',sen_line_code:null,point_label:null,notes:'Synthetic note',pain_pattern_code:'S.00-SYNTHETIC-L-P04'};
      window.ChananyaRuntime={getSession:async()=>({user:{id:'synthetic-actor'}}),getDb:()=>({auth:{onAuthStateChange(){}},from(){const q={select(){return q;},eq(){return q;},order:async()=>({data:window.mode==='present'?[window.row]:[]}),maybeSingle:async()=>({data:window.mode==='present'?window.row:null}),insert(){window.writes++;throw new Error('Recovery must not insert');}};return q;}})};
    });
    await page.addScriptTag({content:read('body-pain-map.js').replace(/\}\)\(\);\s*$/,'window.seedMarker=async()=>{window.sessionStorage.setItem(insertKey("synthetic-encounter"),JSON.stringify({version:2,id:window.row.id,digest:await pointDigest(window.row),phase:"sent"}));};})();')});
    await page.locator('#bm-recover').waitFor();
  };
  await page.goto('https://bodymap-synthetic.invalid/');await setup();await page.evaluate(()=>window.seedMarker());
  await page.reload();await setup();
  const missingDialog=page.waitForEvent('dialog');
  await page.locator('#bm-recover').focus();await page.keyboard.press('Enter');await missingDialog;
  await page.waitForFunction(()=>window.sessionStorage.length===1);
  assert.match(messages.pop(),/ยังไม่พบรายการเดิม/);
  assert.equal(await page.evaluate(()=>window.writes),0);
  await page.evaluate(()=>{window.mode='present';});
  await page.locator('#bm-recover').click();
  await page.waitForFunction(()=>document.querySelector('#bm-status').textContent.includes('พบและยืนยันจุดเดิม'));
  assert.match(await page.locator('#bm-list').textContent(),/Synthetic region/);
  assert.equal(await page.evaluate(()=>window.sessionStorage.length),0);
  assert.equal(await page.evaluate(()=>window.writes),0);
  assert.deepEqual(errors,[]);
  console.log('Body map recovery browser passed: reload retains metadata, keyboard missing-result message, click read-only recovery renders existing point and clears marker. Synthetic API, not hosted persistence.');
} finally {await browser.close();}
