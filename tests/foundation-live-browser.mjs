// Browser integration using synthetic read-only responses, never a live database.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.env.FOUNDATION_TEST_BROWSER_CHANNEL ? { channel: process.env.FOUNDATION_TEST_BROWSER_CHANNEL } : {});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = {
      fail: false, reads: 0, callbacks: [], notify: null,
      data: {
        ttm_concepts: [{ id: 'concept-1', concept_code: 'element.tejo', concept_type: 'element', preferred_term_th: 'Synthetic fire', foundation_layer: 1, definition: 'Before update', source_id: 'source-1', active: true, review_status: 'review_required', metadata: {} }],
        ttm_sources: [{ id: 'source-1', source_code: 'TEST', title_th: 'Synthetic source', active: true }],
        ttm_concept_relations: [], ttm_diagnostic_knowledge: [], ttm_knowledge_suggestions: []
      }
    };
    const db = {
      from(table) {
        const filters = [];
        const query = {
          select() { return this; }, order() { return this; },
          eq(key, value) { filters.push([key, value]); return this; },
          async range(start, end) {
            window.fixture.reads++;
            return window.fixture.fail ? { error: { message: 'Synthetic read failure' } } : {
              data: structuredClone((window.fixture.data[table] || []).filter(row => filters.every(([key, value]) => row[key] === value)).slice(start, end + 1))
            };
          }
        };
        return query;
      },
      channel() {
        return {
          on(type, filter, callback) { if (type === 'postgres_changes') window.fixture.callbacks.push(callback); return this; },
          subscribe(callback) { window.fixture.notify = callback; setTimeout(() => callback('SUBSCRIBED'), 10); return this; }
        };
      },
      removeChannel: async () => {}, auth: { signOut: async () => {} }
    };
    window.ChananyaRuntime = { getDb: () => db, getSession: async () => ({ user: { id: 'synthetic-user' } }), getProfile: async () => ({ id: 'synthetic-user' }), can: () => true, rolesOf: () => ({ effectiveRole: 'practitioner', systemRole: 'staff' }) };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const filename = url.pathname.slice(1);
    if (url.origin === 'http://foundation.test' && ['foundation.html', 'foundation.js', 'foundation-live.js', 'ttm-reasoning.js', 'app.css'].includes(filename)) {
      return route.fulfill({ body: await fs.readFile(new URL(`../${filename}`, import.meta.url)), contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    return route.fulfill({ body: '', contentType: 'application/javascript' });
  });
  await page.goto('http://foundation.test/foundation.html');
  await page.waitForFunction(() => document.querySelector('#foundation-live-status').textContent.includes('อัปเดตอัตโนมัติ'));
  await page.locator('#ttm-observation-text').fill('Synthetic unsaved observation');
  await page.locator('#ttm-case-form button[type=submit]').click();
  await page.locator('[data-foundation-tab=knowledge]').click();
  await page.locator('#foundation-search').fill('Synthetic');
  await page.locator('#foundation-type').selectOption('element');
  await page.locator('[data-foundation-concept]').click();
  await page.evaluate(() => {
    window.fixture.data.ttm_concepts[0].definition = 'After realtime update';
    window.fixture.data.ttm_concepts[0].review_status = 'approved';
    for (let i = 0; i < 30; i++) window.fixture.callbacks[0]();
  });
  await page.waitForFunction(() => document.querySelector('#foundation-detail-content').textContent.includes('After realtime update'));
  assert.equal(await page.locator('#foundation-search').inputValue(), 'Synthetic');
  assert.equal(await page.locator('#foundation-type').inputValue(), 'element');
  assert.equal(await page.locator('#ttm-observation-text').inputValue(), 'Synthetic unsaved observation');
  assert.match(await page.locator('#ttm-case-status').textContent(), /ฐานความรู้เปลี่ยนแล้ว/);
  assert.equal(await page.locator('#foundation-approved-count').textContent(), '1');
  await page.evaluate(() => { window.fixture.fail = true; window.fixture.callbacks[0](); });
  await page.waitForFunction(() => document.querySelector('#foundation-live-status').textContent.includes('อัปเดตไม่สำเร็จ'));
  assert.match(await page.locator('#foundation-detail-content').textContent(), /After realtime update/);
  await page.evaluate(() => { window.fixture.fail = false; window.fixture.data.ttm_concepts[0].active = false; window.fixture.notify('SUBSCRIBED'); });
  await page.waitForFunction(() => document.querySelector('#foundation-detail-content').textContent.includes('ถูกลบ'));
  assert.equal(await page.locator('[data-foundation-concept]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Foundation browser passed: realtime graph refresh, preserved inputs/filters, detail deactivation, analysis invalidation, failed-read recovery.');
} finally { await browser.close(); }
