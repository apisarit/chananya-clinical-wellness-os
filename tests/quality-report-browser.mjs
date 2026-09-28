// SIMULATION_ONLY: no backend, outbound requests blocked, no release decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [], downloads = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const html = read('quality.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.route('https://cnyos-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cnyos-simulation.invalid/');
  await page.addStyleTag({ content: read('app.css') });
  await page.evaluate(() => {
    document.querySelector('#boot').remove();
    document.querySelector('#app').classList.remove('hidden');
  });
  const source = read('quality.js');
  assert.ok(source.includes('  init();\n})();'));
  await page.addScriptTag({ content: source.replace('  init();\n})();', `
    session = {user:{id:'synthetic-inspector'}};
    window.simulatedReadFailure = false;
    window.simulatedSummary = 'SIMULATION_ONLY initial result';
    window.simulatedDecisions = [];
    db = {from(table) {
      const request = {select(){return this}, order(){return this}, then(resolve,reject){
        const rows = {
          products: [], formulas: [],
          production_orders: [{id:'synthetic-order',clinic_id:'synthetic-clinic',status:'released',
            production_order_no:'SIMULATION_ONLY',batch_number:'BATCH-TEST',finished_product_id:'synthetic-product',
            formula_id:'synthetic-formula',produced_by:'synthetic-producer',actual_quantity:10,planned_unit:'bottle'},
            {id:'synthetic-self',status:'awaiting_qc',produced_by:'synthetic-inspector',actual_quantity:10},
            {id:'synthetic-independent',status:'awaiting_qc',produced_by:'synthetic-other',actual_quantity:10}],
          production_qc: [{id:'synthetic-qc',production_order_id:'synthetic-order',clinic_id:'synthetic-clinic',
            status:'passed',result_summary:window.simulatedSummary,tested_by:'synthetic-inspector',
            tested_at:'2026-09-26T08:00:00Z',approved_by:'synthetic-inspector',approved_at:'2026-09-26T08:00:00Z'}]
        };
        return Promise.resolve(window.simulatedReadFailure ? {error:new Error('SIMULATION_ONLY read failed')}
          : {data:rows[table] || [],error:null}).then(resolve,reject);
      }};
      return request;
    },rpc(name,args){
      if(!window.allowSimulatedDecision || name !== 'quality_release_production_order')
        throw new Error('NO_SIMULATION_WRITES_ALLOWED');
      window.simulatedDecisions.push({name,args});
      return new Promise(resolve => { window.finishSimulatedDecision = () => resolve({data:{status:'released'},error:null}); });
    }};
    window.reloadSyntheticQuality=load;
    window.replaceSyntheticIdentity=()=>{session={user:{id:'synthetic-replacement'}};profile={clinic_id:'synthetic-other-clinic'};};
    load();
  })();`) });
  const button = page.locator('[data-quality-report="synthetic-order"]');
  await button.waitFor();
  assert.equal(await page.locator('[data-quality-act="release"][data-id="synthetic-self"]').isDisabled(), true);
  assert.equal(await page.locator('[data-quality-act="reject"][data-id="synthetic-self"]').isDisabled(), true);
  assert.match(await page.locator('#quality-queue').textContent(), /ห้ามเป็นผู้อนุมัติ Quality/);
  assert.equal(await page.locator('[data-quality-act="release"][data-id="synthetic-independent"]').isEnabled(), true);
  assert.equal(await page.locator('#stat-blocked').textContent(), '1');
  await page.evaluate(() => { window.simulatedSummary = 'SIMULATION_ONLY refreshed <script>alert(1)</script>'; });
  const pendingDownload = page.waitForEvent('download');
  await button.focus();
  await page.keyboard.press('Enter');
  const download = await pendingDownload;
  assert.equal(download.suggestedFilename(), 'quality-record-synthetic-order.html');
  const report = fs.readFileSync(await download.path(), 'utf8');
  assert.match(report, /SIMULATION_ONLY refreshed/);
  assert.doesNotMatch(report, /initial result|<script>/);
  assert.match(report, /ไม่ใช่ COA ที่รับรองภายนอก/);
  await page.evaluate(() => { window.simulatedReadFailure = true; });
  await button.click();
  await page.waitForFunction(() => document.querySelector('#quality-history').textContent.includes('ยังอ่านหลักฐานล่าสุดไม่ได้'));
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /SIMULATION_ONLY read failed/);
  assert.equal(downloads.length, 1, 'failed fresh read must not export stale report');
  assert.equal(await page.locator('[data-quality-act]').count(),0,'failed latest read must remove stale decision actions');
  await page.evaluate(async()=>{window.simulatedReadFailure=false;await window.reloadSyntheticQuality();});
  // UI-only simulated acknowledgement; there is no remote API behind this stub.
  await page.evaluate(() => { window.allowSimulatedDecision = true; });
  await page.locator('[data-quality-act="release"][data-id="synthetic-independent"]').click();
  await page.locator('#qc-summary').fill('SIMULATION_ONLY quality decision');
  await page.evaluate(()=>{window.simulatedReadFailure=true;});
  await page.locator('#release-form button[type="submit"]').click();
  assert.equal(await page.locator('#release-form button[type="submit"]').isDisabled(), true);
  assert.equal(await page.locator('#reject-form button[type="submit"]').isDisabled(), true);
  await page.evaluate(() => document.querySelector('#release-form').requestSubmit());
  const decisions = await page.evaluate(() => window.simulatedDecisions);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].args.p_production_order_id, 'synthetic-independent');
  await page.evaluate(() => window.finishSimulatedDecision());
  await page.locator('#release-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(() => document.querySelector('#quality-action-status').textContent.includes('โหลดรายการล่าสุดไม่สำเร็จ'));
  assert.match(await page.locator('#quality-action-status').textContent(), /Quality Release.*สำเร็จ.*โหลดรายการล่าสุดไม่สำเร็จ/);
  assert.equal(await page.locator('#release-form button[type="submit"]').isEnabled(), true);
  assert.equal(dialogs.length, 1, 'acknowledged decision must not produce a second failure alert');
  assert.equal((await page.evaluate(() => window.simulatedDecisions)).length, 1);
  await page.evaluate(async()=>{window.simulatedReadFailure=false;await window.reloadSyntheticQuality();});
  await page.locator('[data-quality-act="release"][data-id="synthetic-independent"]').click();
  await page.locator('#qc-summary').fill('SIMULATION_ONLY superseded identity');
  await page.locator('#release-form button[type="submit"]').click();
  await page.evaluate(()=>{
    window.replaceSyntheticIdentity();
    document.querySelector('#quality-action-status').textContent='SIMULATION_ONLY replacement context';
    window.finishSimulatedDecision();
  });
  await page.waitForFunction(()=>!document.querySelector('#release-form button[type="submit"]').disabled);
  assert.equal(await page.locator('#quality-action-status').textContent(),'SIMULATION_ONLY replacement context');
  assert.equal(await page.locator('#release-dialog').isVisible(),true,'old acknowledgement must not close another identity context');
  assert.equal(dialogs.length,1);
  const reportPage = await context.newPage();
  await reportPage.setContent(report);
  assert.equal(await reportPage.locator('h1').textContent(), 'บันทึกผลตรวจคุณภาพภายใน');
  assert.equal(await reportPage.locator('script').count(), 0);
  assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await reportPage.screenshot({ path: '/tmp/cnyos-quality-report-simulation.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('SIMULATION_ONLY QC browser passed: report download/freshness/escaping, self-review lock, decision duplicate suppression and acknowledged-write refresh warning; no real approval or persistence claim');
} finally { await browser.close(); }
