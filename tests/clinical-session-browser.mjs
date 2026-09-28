// Real clinical markup/controller; synthetic auth callback, no provider traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  for (const mode of ['signout', 'replacement', 'refresh', 'pagehide']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://clinical-synthetic.invalid/', route => route.fulfill({ contentType: 'text/html', body: read('clinical-v3.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '') }));
    await page.goto('https://clinical-synthetic.invalid/');
    await page.addStyleTag({ content: '.hidden { display:none!important; }' });
    const source = read('clinical-v3.js');
    assert.ok(source.includes('  init();\n})();'));
    await page.addScriptTag({ content: source.replace('  init();\n})();', `
      session={user:{id:'synthetic-actor'}};profile={clinic_id:'synthetic-clinic'};
      window.queryCount=0;window.authCallbacks=[];
      window.authEvent=(...args)=>window.authCallbacks.forEach(fn=>fn(...args));
      db={auth:{onAuthStateChange(fn){window.authCallbacks.push(fn);}},from(){window.queryCount++;throw new Error('Unexpected query');}};
      window.ChananyaRuntime={getDb:()=>db,getSession:async()=>session,getProfile:async()=>profile};
      window.ChananyaTTMContext={getValues:()=>({})};
      watchClinicalSession();window.tryPlan=()=>savePlan({});
    })();`) });
    await page.addScriptTag({ content: read('opd-workflow.js') });
    await page.addScriptTag({ content: read('clinical-signoff.js') });
    await page.addScriptTag({ content: read('body-pain-map.js') });
    await page.addScriptTag({ content: read('diagnosis-atomic-bridge.js') });
    await page.waitForFunction(()=>window.authCallbacks.length===5 && document.querySelector('#signoff-form').dataset.signoffBound==='1');
    await page.evaluate(() => {
      document.querySelector('#boot').classList.add('hidden');
      document.querySelector('#app').classList.remove('hidden');
      document.querySelector('#encounter').innerHTML='<option value="synthetic">Synthetic case</option>';
      document.querySelector('#plan-status').textContent='Synthetic private plan';
      const dialog=document.createElement('dialog');dialog.id='synthetic-dialog';dialog.textContent='Synthetic private history';document.body.append(dialog);dialog.showModal();
    });
    await page.evaluate(mode => {
      if(mode==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
      else window.authEvent(mode==='signout'?'SIGNED_OUT':'TOKEN_REFRESHED',mode==='signout'?null:{user:{id:mode==='replacement'?'other-actor':'synthetic-actor'}});
    }, mode);
    if (mode === 'refresh') {
      assert.equal(await page.locator('#app').evaluate(el=>el.inert),false);
      assert.equal(await page.locator('#synthetic-dialog').evaluate(el=>el.open),true);
    } else {
      assert.equal(await page.locator('#app').isVisible(),false);
      assert.equal(await page.locator('#app').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#opd-history-form').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#opd-session-form').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#signoff-form').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#bodymap-slot').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#diagnosis-form').evaluate(el=>el.inert),true);
      assert.equal(await page.locator('#encounter option').count(),0);
      assert.equal(await page.locator('#plan-status').textContent(),'');
      assert.equal(await page.locator('#synthetic-dialog').evaluate(el=>el.open),false);
      assert.equal(await page.locator('#synthetic-dialog').textContent(),'');
      assert.match(await page.locator('#boot-error').textContent(),/เข้าสู่ระบบใหม่/);
      assert.match(await page.evaluate(async()=>{try{await window.tryPlan();return 'UNEXPECTED_SUCCESS';}catch(e){return e.message;}}),/บัญชีเปลี่ยน/);
      assert.equal(await page.evaluate(()=>window.queryCount),0);
    }
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('Clinical browser session boundary passed: main/OPD/signoff/bodymap/diagnosis actual DOM clearing, dialog closure, inert workspace, blocked write and same-actor refresh. Synthetic auth/lifecycle events, not native BFCache or hosted revocation proof.');
} finally { await browser.close(); }
