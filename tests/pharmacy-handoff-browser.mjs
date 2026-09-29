// SIMULATION_ONLY: actual markup/controller, isolated synthetic API, no live writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const html = read('pharmacy.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.route('https://cnyos-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cnyos-simulation.invalid/');
  await page.addStyleTag({ content: read('app.css') });
  await page.evaluate(() => {
    document.querySelector('#boot').remove();
    document.querySelector('#app').classList.remove('hidden');
  });
  await page.addScriptTag({ content: read('price-master-client.js') });
  const source = read('pharmacy.js');
  assert.ok(source.includes('  init();\n})();'));
  await page.addScriptTag({ content: source.replace('  init();\n})();', `
    persistenceReady = true;
    Object.assign(data, {
      dispensing: [{id:'synthetic-order',prescription_id:'synthetic-rx',status:'dispensed',queue_number:'SIMULATION_ONLY Q1'}],
      prescriptions: [{id:'synthetic-rx',prescription_no:'SIMULATION_ONLY RX1'}],
      prescriptionItems: [], dispensingItems: []
    });
    window.simulatedCalls = [];
    let committed = false;
    let firstRefresh = true;
    db = { async rpc(name, payload) {
      if(name !== 'transition_atomic_prescription_dispensing' || payload.p_action !== 'submit_billing')
        throw new Error('UNEXPECTED_SIMULATION_RPC');
      window.simulatedCalls.push({...payload});
      committed = true;
      return {data:{status:'submitted_to_billing'},error:null};
    }};
    query = async table => {
      if(table === 'products' && firstRefresh) { firstRefresh=false; throw new Error('SIMULATION_ONLY refresh failure'); }
      if(table === 'dispensing_orders') return [{id:'synthetic-order',prescription_id:'synthetic-rx',status:committed?'submitted_to_billing':'dispensed',queue_number:'SIMULATION_ONLY Q1'}];
      if(table === 'prescriptions') return [{id:'synthetic-rx',prescription_no:'SIMULATION_ONLY RX1'}];
      return [];
    };
    renderPrescriptionQueue(); bindActions();
  })();`) });
  const submit = page.locator('[data-act="rx-billing"]');
  await submit.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#rx-refresh-status').textContent.includes('โหลดรายการล่าสุดไม่สำเร็จ'));
  assert.match(await page.locator('#rx-refresh-status').textContent(), /ส่ง Checkout.*แล้ว.*รีเฟรชคิว/);
  assert.deepEqual(dialogs, [], 'successful write with failed refresh must not show failed-action alert');
  assert.equal((await page.evaluate(() => window.simulatedCalls)).length, 1);
  assert.equal(await page.locator('[data-act="rx-billing"]').count(), 0, 'failed read removes stale write controls');
  assert.match(await page.locator('#rx-list').textContent(), /ไม่ได้หมายความว่าไม่มีงาน/);
  await page.locator('#refresh-rx-queue').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#rx-list').textContent.includes('ส่งฝ่ายการเงินแล้ว'));
  assert.match(await page.locator('#rx-list').textContent(), /ยังไม่ใช่การรับชำระเงิน/);
  assert.equal(await page.locator('[data-act="rx-billing"]').count(), 0);
  assert.equal((await page.evaluate(() => window.simulatedCalls)).length, 1, 'refresh is read-only');
  assert.deepEqual(errors, []);
  console.log('SIMULATION_ONLY Pharmacy browser passed: mobile keyboard submit, acknowledged-write/refresh-failure distinction, read-only refresh, submitted-not-paid status; no live persistence claim');
} finally { await browser.close(); }
