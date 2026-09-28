// SIMULATION_ONLY: real Admin HTML/CSS/controller, in-memory API, no live writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = read('admin.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.route('https://price-master.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  const item = { price_list_id: 'synthetic-list', item_id: 'synthetic-item', item_type: 'product', product_id: 'synthetic-product', service_id: null,
    item_description: 'SIMULATION_ONLY <script>window.bad=true</script>', price_list_name: 'Synthetic', unit_code: 'capsule', unit_price: 100, item_version: 1 };
  const history = [], writes = [];
  let releaseSave, hold = true, readFailure = false, denySave = false;
  await page.exposeFunction('syntheticPriceRpc', async (name, args) => {
    if (name === 'list_price_master') return readFailure ? { error: { message: 'SIMULATION_ONLY read failure' } } : { data: [{ ...item }] };
    if (name === 'list_price_master_history') return { data: history };
    assert.equal(name, 'set_price_master_item');
    writes.push(args);
    if (hold) await new Promise(resolve => { releaseSave = resolve; });
    if (denySave) return { error: { message: 'ADMIN_REQUIRED' } };
    if (args.p_expected_version !== item.item_version) return { error: { message: 'VERSION_CONFLICT' } };
    history.unshift({ action: 'update', before_state: { unit_price: item.unit_price }, after_state: { unit_price: args.p_unit_price },
      actor_id: 'synthetic-admin', reason: args.p_reason, created_at: '2026-09-26T00:00:00Z' });
    item.unit_price = args.p_unit_price;
    item.item_version++;
    return { data: { ...item } };
  });
  async function open() {
    await page.goto('https://price-master.test/');
    await page.addStyleTag({ content: read('app.css') });
    await page.evaluate(() => {
      document.querySelector('#boot')?.remove();
      document.querySelector('#app')?.classList.remove('hidden');
      document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'price-master'));
      window.ChananyaRuntime = { getSession: async () => ({ user: { id: 'synthetic-admin' } }), getDb: () => ({
        auth: { onAuthStateChange(callback) { window.syntheticAuthChange = callback; } }, rpc: window.syntheticPriceRpc }) };
    });
    await page.addScriptTag({ content: read('admin-price-master.js') });
    await page.locator('#price-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-price-index]'));
    await page.locator('[data-price-index]').click();
  }
  await open();
  assert.equal(await page.locator('#price-unit').getAttribute('readonly'), '');
  assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.locator('#price-amount').fill('125.50');
  await page.locator('#price-reason').fill('SIMULATION_ONLY rate change');
  await page.locator('#price-save').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#price-save').disabled);
  assert.equal(await page.locator('#price-amount').isDisabled(), true);
  assert.equal(await page.locator('#price-reason').isDisabled(), true);
  assert.match(await page.locator('#price-status').textContent(), /กำลังบันทึก/);
  await page.locator('#price-edit-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  // The disabled guard is synchronous, while the exposed API bridge is asynchronous.
  await page.waitForFunction(() => document.querySelector('#price-refresh').disabled);
  for (let attempt = 0; !releaseSave && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(writes.length, 1);
  assert.ok(releaseSave);
  releaseSave(); hold = false;
  await page.waitForFunction(() => document.querySelector('#price-status').textContent.includes('บันทึกราคากลางแล้ว'));
  assert.equal(await page.inputValue('#price-amount'), '125.5');
  assert.match(await page.locator('#price-history').textContent(), /100\.00.*125\.50/);
  await open();
  assert.equal(await page.inputValue('#price-amount'), '125.5', 'fresh controller must read saved API state');
  readFailure = true;
  await page.locator('#price-amount').fill('130');
  await page.locator('#price-reason').fill('SIMULATION_ONLY read failure');
  await page.locator('#price-save').click();
  await page.waitForFunction(() => document.querySelector('#price-status').textContent.includes('บันทึกราคาแล้ว แต่โหลดกลับไม่สำเร็จ'));
  assert.equal(writes.length, 2);
  assert.equal(item.unit_price, 130);
  assert.equal(await page.locator('#price-save').isDisabled(), true);
  readFailure = false;
  await page.locator('#price-refresh').click();
  await page.locator('[data-price-index]').click();
  assert.equal(await page.inputValue('#price-amount'), '130');
  assert.equal(writes.length, 2, 'read-only recovery cannot repeat mutation');
  item.unit_price = 140; item.item_version++; // Another synthetic operator won.
  await page.locator('#price-amount').fill('150');
  await page.locator('#price-reason').fill('SIMULATION_ONLY stale version');
  await page.locator('#price-save').click();
  await page.waitForFunction(() => document.querySelector('#price-status').textContent.includes('ราคาถูกแก้โดยผู้อื่น'));
  assert.equal(item.unit_price, 140, 'conflict must not overwrite newer price');
  assert.equal(await page.inputValue('#price-amount'), '150', 'rejected draft remains visible');
  assert.equal(await page.locator('#price-amount').isDisabled(), false);
  assert.equal(writes.length, 3, 'no automatic conflict retry');
  await page.locator('#price-refresh').click();
  await page.locator('[data-price-index]').click();
  assert.equal(await page.inputValue('#price-amount'), '140');
  denySave = true;
  await page.locator('#price-amount').fill('160');
  await page.locator('#price-reason').fill('SIMULATION_ONLY denied');
  await page.locator('#price-save').click();
  await page.waitForFunction(() => document.querySelector('#price-status').textContent.includes('เฉพาะ Owner/Admin'));
  assert.equal(item.unit_price, 140);
  assert.equal(history.length, 2, 'rejected attempts must not claim a recorded change');
  assert.equal(writes.length, 4);
  assert.equal(await page.inputValue('#price-reason'), 'SIMULATION_ONLY denied');
  await page.evaluate(() => window.syntheticAuthChange('SIGNED_IN',{user:{id:'synthetic-other-admin'}}));
  assert.equal(await page.locator('#price-list').textContent(),'');
  assert.equal(await page.locator('#price-history').textContent(),'');
  assert.equal(await page.inputValue('#price-amount'),'');
  assert.equal(await page.inputValue('#price-reason'),'');
  assert.equal(await page.locator('#price-save').isDisabled(),true);
  assert.equal(await page.locator('#price-refresh').isDisabled(),true);
  assert.match(await page.locator('#price-status').textContent(),/บัญชีผู้ใช้เปลี่ยน/);
  await page.locator('#price-edit-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(writes.length,4,'old page cannot write after account replacement');
  assert.deepEqual(errors, []);
  console.log('SIMULATION_ONLY Price Master browser passed: keyboard save, duplicate guard, reload, old/new history, escaping, read-failure recovery and account replacement clearing/denial; no live persistence proof.');
} finally { await browser.close(); }
