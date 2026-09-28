// Isolated synthetic browser: all network requests except the fixture document abort.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = (await read('outcomes.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
  await page.route('https://outcomes-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://outcomes-simulation.invalid/');
  await page.addStyleTag({ content: await read('app.css') });
  await page.evaluate(() => {
    const id = '00000000-0000-4000-8000-000000000001';
    window.ChananyaRuntime = {
      getSession: async () => ({ user: { id: 'synthetic' } }),
      getProfile: async () => ({}), can: () => true,
      getDb: () => ({ auth: { onAuthStateChange(cb) { window.testAuth = cb; } },
        rpc: async name => {
          if (name === 'clinical_outcomes_summary') return { data: [] };
          if (name === 'search_clinical_outcomes') return { data: [{ encounter_id: id,
            patient_name: 'SIMULATION ONLY', herbal_lots: ['PENDING'] }] };
          if (name !== 'clinical_outcome_lot_trace') throw Error('Unexpected RPC');
          return new Promise(resolve => { window.finishTrace = resolve; });
        } })
    };
    window.traceFixture = { encounter_id: id, scope: 'encounter', link_conflict_count: 1, entries: [{
      state: 'recorded_dispense', lot_number: '<img src=x onerror=alert(1)>',
      stock_state: 'movement_missing', production_state: 'production_source_unavailable', receipt_quantity_state: 'not_evaluable',
      prescription_quantity_state: 'under_prescribed_quantity'
    }], complete: false };
  });
  await page.addScriptTag({ content: await read('outcomes.js') });
  const button = page.locator('[data-outcome-trace]');
  await button.waitFor();
  await button.focus(); await page.keyboard.press('Enter');
  assert.equal(await button.isDisabled(), true);
  await page.evaluate(() => window.finishTrace({ data: window.traceFixture }));
  const result = page.locator('[data-trace-result]');
  await page.waitForFunction(() => document.querySelector('[data-trace-result]').textContent.includes('หลักฐานบางส่วน'));
  assert.match(await result.innerText(), /ไม่พบรายการตัดสต็อก/);
  assert.equal(await result.locator('img').count(), 0);
  assert.equal(await result.locator('li').count(), 1);
  await button.click();
  await page.evaluate(() => window.finishTrace({ error: { message: 'PRIVATE DETAIL' } }));
  await page.waitForFunction(() => document.querySelector('[data-trace-result]').textContent.includes('ยังตรวจไม่ได้'));
  assert.equal(await result.locator('li').count(), 0, 'Failure replaces old evidence');
  assert.doesNotMatch(await result.innerText(), /PRIVATE DETAIL/);
  await button.click();
  await page.evaluate(() => { window.testAuth('SIGNED_OUT', null); window.finishTrace({ data: window.traceFixture }); });
  await page.waitForFunction(() => document.querySelector('#app').inert);
  assert.equal(await page.locator('[data-trace-result]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Outcome lot trace mobile browser passed: keyboard read, partial evidence, escaping, failed-read clearing, sign-out. SIMULATION_ONLY, no live API.');
} finally { await browser.close(); }
