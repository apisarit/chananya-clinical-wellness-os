// Isolated browser proof for the clinical encounter worklist controller.
// All requests are aborted and all identities/encounters are synthetic. This
// test deliberately does not exercise a live runtime, database, or patient
// record; it proves the bounded DOM/controller contract only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const modulePath = new URL('../clinical-worklist.js', import.meta.url);
if (!fs.existsSync(modulePath)) {
  console.error('NOT RUN fixture/controller blocker: clinical-worklist.js is not present; browser harness is ready.');
  process.exitCode = 2;
} else {
  const source = fs.readFileSync(modulePath, 'utf8');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {})
  });

  const patients = [
    { id: 'patient-a', hn: 'SYN-A-001', first_name: 'Synthetic', last_name: 'Ada' },
    { id: 'patient-b', hn: 'SYN-B-002', first_name: 'Synthetic', last_name: 'Bee' },
    { id: 'patient-x', hn: 'SYN-X-009', first_name: '<img src=x onerror=window.__xss=1>', last_name: 'Danger' }
  ];
  const encounters = [
    // 2026-10-01 00:30 Bangkok (UTC previous day): catches local-calendar conversion.
    { id: 'enc-bkk-boundary', encounter_no: 'SYN-BOUNDARY', patient_id: 'patient-a', chief_complaint: 'boundary', started_at: '2026-09-30T17:30:00Z', status: 'draft' },
    { id: 'enc-complete', encounter_no: 'SYN-COMPLETE', patient_id: 'patient-b', chief_complaint: 'follow-up', started_at: '2026-10-01T03:00:00Z', status: 'completed' },
    { id: 'enc-unknown', encounter_no: 'SYN-UNKNOWN', patient_id: 'patient-missing', chief_complaint: 'unknown status', started_at: '2026-10-01T04:00:00Z', status: 'mystery_status' },
    { id: 'enc/special?x=1#frag', encounter_no: 'SYN-DANGER', patient_id: 'patient-x', chief_complaint: '<script>window.__xss=1</script>', started_at: '2026-10-01T05:00:00Z', status: null }
  ];

  const shell = fs.readFileSync(new URL('../clinical-v3.html', import.meta.url), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace('</head>', '<base href="http://cnyos.synthetic/"></head>');
  const css = fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8');

  async function makePage({ viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport });
    const requests = [];
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    await page.setContent(shell, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: css });
    await page.evaluate(() => { document.querySelector('#app')?.classList.remove('hidden'); document.querySelector('#boot')?.remove(); });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      window.__xss = 0;
      window.__refreshCalls = 0;
      window.__refreshQueue = [];
      document.querySelector('#role').textContent = 'ข้อมูลจำลอง / component test';
    });
    return { context, page, requests };
  }

  async function mount(page, rows = encounters, loadedAt = '2026-10-01T06:00:00Z') {
    return page.evaluate(({ rows, patients, loadedAt }) => {
      window.__worklist = window.ChananyaClinicalWorklist.mount({
        host: document.querySelector('#clinical-worklist'),
        onRefresh: () => {
          window.__refreshCalls += 1;
          return window.__refreshQueue.shift() || Promise.resolve({ encounters: rows, patients, loadedAt });
        }
      });
      window.__worklist.update({ encounters: rows, patients, loadedAt });
      document.querySelector('#clinical-worklist details')?.setAttribute('open', '');
    }, { rows, patients, loadedAt });
  }
  async function text(page, id) { return page.locator(`#${id}`).innerText(); }
  async function waitRefresh(page) { await page.waitForFunction(() => window.__refreshCalls > 0); }

  try {
    {
      const h = await makePage();
      await mount(h.page);
      assert.equal(await h.page.locator('#clinical-worklist').getAttribute('aria-labelledby'), 'clinical-worklist-title');
      await h.page.fill('#worklist-date', '2026-10-01');
      assert.match(await text(h.page, 'worklist-rows'), /SYN-BOUNDARY/); // Bangkok, not UTC date, includes boundary.
      await h.page.fill('#worklist-search', 'SYN-COMPLETE');
      assert.match(await text(h.page, 'worklist-rows'), /SYN-COMPLETE/);
      assert.doesNotMatch(await text(h.page, 'worklist-rows'), /SYN-BOUNDARY/);
      await h.page.fill('#worklist-search', 'Synthetic Bee');
      assert.match(await text(h.page, 'worklist-rows'), /SYN-COMPLETE/);
      await h.page.fill('#worklist-search', 'SYN-B-002');
      assert.match(await text(h.page, 'worklist-rows'), /SYN-COMPLETE/);
      await h.page.fill('#worklist-search', 'SYN-BOUNDARY');
      assert.match(await text(h.page, 'worklist-rows'), /SYN-BOUNDARY/);
      await h.page.fill('#worklist-search', 'SYN-UNKNOWN');
      assert.match(await text(h.page, 'worklist-rows'), /mystery_status/);
      assert.match(await text(h.page, 'worklist-rows'), /ไม่พบข้อมูลผู้รับบริการในชุดข้อมูลที่โหลด/);
      await h.page.fill('#worklist-search', 'SYN-DANGER');
      const danger = await text(h.page, 'worklist-rows');
      assert.match(danger, /<script>|<img/i, 'fixture value should remain visible as text');
      assert.doesNotMatch(await h.page.locator('#worklist-rows').innerHTML(), /<script>|<img/i, 'malicious values must be text, never executable markup');
      assert.equal(await h.page.evaluate(() => window.__xss), 0);
      await h.page.fill('#worklist-search', '');
      await h.page.selectOption('#worklist-status', 'completed');
      assert.match(await text(h.page, 'worklist-summary'), /1/);
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      const link = h.page.locator('#worklist-rows a').first();
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('rel') || '', /noopener/);
      const href = await link.getAttribute('href');
      assert.match(href, /clinical-v3\.html\?encounter=/);
      const specialHref = await h.page.locator('#worklist-rows a[href*="enc%2Fspecial"]').getAttribute('href');
      assert.equal(specialHref, '/clinical-v3.html?encounter=enc%2Fspecial%3Fx%3D1%23frag&step=history');
      await h.page.fill('#worklist-search', 'SYN-MISSING');
      assert.equal(await h.page.locator('#worklist-rows').innerText(), '');
      assert.match(await text(h.page, 'worklist-summary'), /แสดง 0|0/);
      assert.doesNotMatch(await text(h.page, 'worklist-feedback'), /failed|error/i);
      await h.context.close();
    }

    {
      const many = Array.from({ length: 250 }, (_, i) => ({ ...encounters[0], id: `enc-${i}`, encounter_no: `SYN-${i}` }));
      const h = await makePage();
      await mount(h.page, many);
      assert.match(await text(h.page, 'worklist-summary'), /250 รายการแรก อาจมีรายการเพิ่มเติม/);
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      const before = await h.page.inputValue('#worklist-search');
      await h.page.fill('#worklist-search', 'SYN-COMPLETE');
      await h.page.fill('#enc-history', 'still unsaved');
      await h.page.evaluate(() => { window.__refreshQueue = []; });
      await h.page.evaluate(() => { window.__refreshQueue.push(new Promise(r => { window.__releaseRefresh = r; })); });
      await h.page.click('#worklist-refresh');
      await waitRefresh(h.page);
      assert.equal(await h.page.locator('#worklist-refresh').isDisabled(), true);
      await h.page.locator('#worklist-refresh').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await h.page.waitForTimeout(30);
      assert.equal(await h.page.evaluate(() => window.__refreshCalls), 1, 'pending refresh must be bounded/deduplicated');
      await h.page.evaluate(({ encounters, patients }) => window.__releaseRefresh({ encounters, patients, loadedAt: '2026-10-01T07:00:00Z' }), { encounters, patients });
      await h.page.waitForTimeout(50);
      assert.equal(await h.page.inputValue('#worklist-search'), 'SYN-COMPLETE');
      assert.equal(await h.page.inputValue('#enc-history'), 'still unsaved');
      assert.equal(before, '', 'fixture starts with empty search');
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      await h.page.evaluate(() => { window.__refreshQueue.push(new Promise((_, reject) => { window.__rejectRefresh = reject; })); });
      await h.page.click('#worklist-refresh');
      await h.page.evaluate(() => window.__rejectRefresh(new Error('synthetic denied')));
      await h.page.waitForFunction(() => /ไม่สำเร็จ/.test(document.querySelector('#worklist-feedback')?.textContent || ''));
      assert.equal(await h.page.locator('#worklist-rows').innerText(), '');
      assert.match(await text(h.page, 'worklist-summary'), /ยังไม่มีข้อมูล|no data/i);
      assert.doesNotMatch(await text(h.page, 'worklist-rows'), /SYN-BOUNDARY/);
      await h.page.evaluate(({ encounters, patients }) => { window.__refreshQueue.push(Promise.resolve({ encounters, patients, loadedAt: '2026-10-01T08:00:00Z' })); }, { encounters, patients });
      await h.page.click('#worklist-refresh');
      await h.page.waitForFunction(() => /SYN-BOUNDARY/.test(document.querySelector('#worklist-rows')?.textContent || ''));
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      await h.page.evaluate(() => {
        let release;
        window.__stale = new Promise(r => { release = r; });
        window.__releaseStale = release;
        window.__refreshQueue = [window.__stale];
      });
      await h.page.click('#worklist-refresh');
      await waitRefresh(h.page);
      const rowsBeforeDestroy = await h.page.locator('#worklist-rows').innerText();
      await h.page.evaluate(() => window.__worklist.destroy());
      await h.page.evaluate(({ encounters, patients }) => window.__releaseStale({ encounters, patients, loadedAt: '2026-10-01T09:00:00Z' }), { encounters, patients });
      await h.page.waitForTimeout(30);
      assert.equal(await h.page.locator('#worklist-rows').innerText(), rowsBeforeDestroy, 'destroyed controller must ignore stale result');
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      await h.page.evaluate(() => window.__worklist.loading());
      await h.page.fill('#worklist-search', 'SYN-COMPLETE');
      assert.equal(await h.page.locator('#worklist-rows').innerText(), '', 'filtering while loading must not resurrect stale rows');
      await h.page.evaluate(({ encounters, patients }) => window.__worklist.update({ encounters: encounters.slice(0, 1), patients, loadedAt: '2026-10-01T10:00:00Z' }), { encounters, patients });
      assert.equal(await h.page.locator('#worklist-rows').innerText(), '', 'active filter must remain applied after external update');
      await h.page.fill('#worklist-search', '');
      assert.match(await h.page.locator('#worklist-rows').innerText(), /SYN-BOUNDARY/);
      await h.page.evaluate(() => window.__worklist.destroy());
      const after = await h.page.locator('#worklist-rows').innerText();
      await h.page.evaluate(({ encounters, patients }) => { try { window.__worklist.update({ encounters, patients, loadedAt: '2026-10-01T11:00:00Z' }); } catch {} }, { encounters, patients });
      assert.equal(await h.page.locator('#worklist-rows').innerText(), after, 'destroyed controller must ignore external updates');
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      await h.page.evaluate(() => {
        window.__stale = new Promise(resolve => { window.__releaseStale = resolve; });
        window.__refreshQueue = [window.__stale];
      });
      await h.page.click('#worklist-refresh');
      await waitRefresh(h.page);
      await h.page.evaluate(({ encounters, patients }) => window.__worklist.update({ encounters: encounters.slice(1, 2), patients, loadedAt: '2026-10-01T12:00:00Z' }), { encounters, patients });
      await h.page.evaluate(({ encounters, patients }) => window.__releaseStale({ encounters, patients, loadedAt: '2026-10-01T13:00:00Z' }), { encounters, patients });
      await h.page.waitForTimeout(50);
      assert.match(await h.page.locator('#worklist-rows').innerText(), /SYN-COMPLETE/);
      assert.doesNotMatch(await h.page.locator('#worklist-rows').innerText(), /SYN-BOUNDARY/);
      await h.context.close();
    }

    {
      const h = await makePage();
      await mount(h.page);
      for (const bad of [
        { encounters: [{ id: 'duplicate', patient_id: 'patient-a' }, { id: 'duplicate', patient_id: 'patient-a' }], patients, loadedAt: 'synthetic' },
        { encounters: [{ id: '' }], patients, loadedAt: 'synthetic' },
        { encounters: [], patients: [{ id: '' }], loadedAt: 'synthetic' }
      ]) {
        const result = await h.page.evaluate(snapshot => { try { window.__worklist.update(snapshot); return 'accepted'; } catch (error) { return error.constructor.name; } }, bad);
        assert.notEqual(result, 'accepted', 'malformed/duplicate identity snapshots must be rejected');
      }
      await h.context.close();
    }

    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const h = await makePage({ viewport }); await mount(h.page, encounters.slice(0, 3));
      assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: table must not stretch the whole page`);
      if (name === 'mobile') {
        const wrap = h.page.locator('.worklist-table-wrap');
        assert.ok(await wrap.evaluate(el => el.scrollWidth > el.clientWidth), 'mobile table remains scrollable');
        await wrap.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        const action = await h.page.locator('#worklist-rows a').first().boundingBox();
        assert.ok(action.x >= 0 && action.x + action.width <= viewport.width, 'exact encounter action reachable within mobile viewport');
        await wrap.evaluate(el => { el.scrollLeft = 0; });
      }
      if (process.env.CNYOS_WORKLIST_SCREENSHOT_DIR) {
        await fs.promises.mkdir(process.env.CNYOS_WORKLIST_SCREENSHOT_DIR, { recursive: true });
        await h.page.screenshot({ path: `${process.env.CNYOS_WORKLIST_SCREENSHOT_DIR}/clinical-worklist-${name}.png`, fullPage: false });
      }
      assert.deepEqual(h.requests, [], 'no network requests from isolated fixture');
      await h.context.close();
    }
    console.log('PASS isolated clinical worklist browser controller: Bangkok date/search/status filtering, identity/status honesty, empty vs failed, 250 cap, encoded new-tab links, text safety, refresh dedupe/failure/retry, and stale lifecycle. Synthetic DOM only; no live clinical acceptance.');
  } finally {
    await browser.close();
  }
}
