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
      fail: false, failQueue: false, reads: 0, callbacks: [], notify: null,
      data: {
        ttm_concepts: [{ id: 'concept-1', concept_code: 'element.tejo', concept_type: 'element', preferred_term_th: 'Synthetic fire', foundation_layer: 1, definition: 'Before update', source_id: 'source-1', active: true, review_status: 'review_required', metadata: {} }],
        ttm_sources: [{ id: 'source-1', source_code: 'TEST', title_th: 'Synthetic source', active: true }],
        ttm_knowledge_suggestion_events: [{ id: 'event-1', event: 'knowledge_applied', suggestion_id: 'review-1', to_status: 'approved', actor_id: 'other-reviewer', created_at: '2026-09-26T00:00:00Z', before_snapshot: { definition: 'Before synthetic edit' }, after_snapshot: { definition: '<script>synthetic</script>' } }],
        ttm_concept_relations: [], ttm_diagnostic_knowledge: [], ttm_knowledge_suggestions: [
          { id: 'review-own', suggestion_no: 'SIMULATION-OWN', status: 'pending', action: 'update', requested_by: 'synthetic-user', requested_at: '2026-09-26T00:00:00Z', target_table: 'ttm_concepts', reason: 'Synthetic review only', source_ref: 'Fixture', target_snapshot: { definition: '<img src=x onerror=alert(1)>' }, payload: { definition: 'Synthetic proposal' } },
          { id: 'review-old', suggestion_no: 'SIMULATION-NO-SNAPSHOT', status: 'pending', action: 'update', requested_by: 'other-user', requested_at: '2026-09-26T00:00:00Z', target_table: 'ttm_concepts', reason: 'Synthetic legacy proposal', source_ref: 'Fixture', target_snapshot: null, payload: { definition: 'Not published' } }
        ]
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
            return window.fixture.fail || (table === 'ttm_knowledge_suggestions' && window.fixture.failQueue) ? { error: { message: 'Synthetic read failure' } } : {
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
      removeChannel: async () => {}, auth: { signOut: async () => {}, onAuthStateChange(callback) { window.syntheticAuthChange=callback; } }
    };
    window.ChananyaRuntime = { getDb: () => db, getSession: async () => ({ user: { id: 'synthetic-user' } }), getProfile: async () => ({ id: 'synthetic-user' }), can: () => true, rolesOf: () => ({ effectiveRole: 'super_admin', systemRole: 'super_admin' }) };
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
  await page.locator('[data-foundation-tab=coverage]').click();
  const queue = page.locator('#ttm-suggestion-queue');
  await queue.waitFor({ state: 'visible' });
  assert.equal(await queue.locator('[data-id="review-own"]:disabled').count(), 2);
  assert.equal(await queue.locator('[data-id="review-old"][data-ttm-suggestion-action="approve"]').isDisabled(), true);
  assert.equal(await queue.locator('[data-id="review-old"][data-ttm-suggestion-action="reject"]').isEnabled(), true);
  assert.match(await queue.textContent(), /ผู้เสนอไม่สามารถตัดสิน/);
  await queue.locator('summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await queue.locator('details').first().getAttribute('open'), '');
  assert.match(await queue.locator('details').first().textContent(), /<img src=x/);
  assert.equal(await queue.locator('img').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await queue.locator('pre').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true, 'review JSON must not overflow on mobile');
  await queue.screenshot({ path: '/tmp/cnyos-knowledge-review-simulation.png' });
  const history = page.locator('#ttm-review-history');
  await history.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.match(await history.textContent(), /Before synthetic edit/);
  assert.equal(await history.locator('script').count(), 0);
  await page.locator('#ttm-history-refresh').click();
  await history.locator('article').waitFor();
  await page.evaluate(() => { window.fixture.failQueue = true; window.fixture.callbacks[0](); });
  await page.waitForFunction(() => document.querySelector('#ttm-suggestion-queue [role=alert]'));
  assert.match(await queue.textContent(), /ยังยืนยันไม่ได้/);
  assert.equal(await queue.locator('button').count(), 0);
  await page.evaluate(() => window.syntheticAuthChange('SIGNED_OUT', null));
  assert.equal(await page.locator('#app').evaluate(node => node.inert), true);
  assert.equal(await page.locator('#app').isVisible(), false);
  assert.match(await page.locator('#boot-error').textContent(), /บัญชีเปลี่ยนแล้ว/);
  assert.equal(await queue.textContent(), '');
  assert.equal(await history.textContent(), '');
  assert.deepEqual(errors, []);
  console.log('Foundation browser passed: realtime refresh, preserved inputs, failed-read recovery, review baseline keyboard disclosure, escaped content, self-review/missing-baseline locks and queue failure. Synthetic reads only; no approval RPC.');
} finally { await browser.close(); }
