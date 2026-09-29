// SIMULATION_ONLY: actual page/load/render, synthetic reads, no external traffic.
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.route('https://cnyos-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cnyos-simulation.invalid/');
  await page.addStyleTag({ content: read('app.css') });
  await page.evaluate(() => {
    document.querySelector('#boot').classList.add('hidden');
    document.querySelector('#app').classList.remove('hidden');
    document.querySelectorAll('.view').forEach(node => node.classList.remove('active'));
    document.querySelector('#billing').classList.add('active');
    window.ChananyaRuntime = { can: (_profile, permission) => permission === 'billing_operate' };
  });
  const source = read('app.js');
  assert.ok(source.includes('  init();\n})();'));
  await page.addScriptTag({ content: source.replace('  init();\n})();', `
    session={user:{id:'synthetic'}};profile={id:'synthetic',clinic_id:'synthetic-clinic'};role='billing';
    paymentRequest=Object.freeze({p_request_key:'synthetic-uncertain'});
    window.failRead=true;window.readCalls=0;
    db={async rpc(name){if(name!=='list_billable_treatment_encounters')throw new Error('UNEXPECTED_RPC');return {data:[]};}};
    query=async table=>{window.readCalls++;if(window.failRead&&table==='prescriptions')throw new Error('SYNTHETIC_READ_FAILURE');return [];};
    window.pendingIdentity=()=>paymentRequest.p_request_key;
  })();`) });
  const button = page.locator('#billing-refresh');
  await button.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#billing-refresh-status').textContent.includes('โหลดไม่สำเร็จ'));
  assert.match(await page.locator('#billing-queue').textContent(), /ไม่ใช่การยืนยันว่าไม่มีงาน/);
  assert.equal(await button.isEnabled(), true);
  assert.equal(await page.locator('[data-action="invoice"]').count(), 0);
  await page.evaluate(() => { window.failRead = false; });
  await button.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#billing-refresh-status').textContent.includes('โหลดข้อมูลแล้ว'));
  assert.equal(await button.isEnabled(), true);
  assert.equal(await page.evaluate(() => window.pendingIdentity()), 'synthetic-uncertain');
  assert.ok(await page.evaluate(() => window.readCalls > 9));
  assert.deepEqual(errors, []);
  console.log('SIMULATION_ONLY Billing refresh browser passed: actual loader/render, keyboard retry, explicit failure, preserved uncertain identity; no mutation RPC permitted.');
} finally { await browser.close(); }
