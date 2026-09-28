// Local UI -> parameterized disposable SQL adapter. Not hosted REST/Auth evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

export async function openOutcomeTraceBrowser({ asUser, actor, encounter }) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const read = file => fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const html = (await read('outcomes.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*>/gi, '');
    await page.route('https://outcome-sql-fixture.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://outcome-sql-fixture.invalid/');
    await page.addStyleTag({ content: await read('app.css') });
    let queue = Promise.resolve();
    let traceReads = 0;
    await page.exposeFunction('fixtureRpc', (name, args) => {
      const work = queue.then(async () => {
        try {
          if (name === 'clinical_outcomes_summary') {
            const result = await asUser(actor, 'select * from public.clinical_outcomes_summary($1,$2)', [args.p_from, args.p_to]);
            return { data: result.rows, error: null };
          }
          if (name === 'search_clinical_outcomes') {
            const result = await asUser(actor,
              'select * from public.search_clinical_outcomes($1,$2,$3,$4,$5)',
              [args.p_query, args.p_from, args.p_to, args.p_limit, args.p_offset]);
            return { data: result.rows, error: null };
          }
          assert.equal(name, 'clinical_outcome_lot_trace', 'No write or unapproved RPC');
          assert.equal(args.p_encounter_id, encounter);
          traceReads++;
          const result = await asUser(actor, 'select public.clinical_outcome_lot_trace($1::uuid) trace', [args.p_encounter_id]);
          return { data: result.rows[0].trace, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message } };
        }
      });
      queue = work.then(() => undefined, () => undefined);
      return work;
    });
    await page.evaluate(actorId => {
      window.ChananyaRuntime = {
        getSession: async () => ({ user: { id: actorId } }),
        getProfile: async () => ({}), can: () => true,
        getDb: () => ({ auth: { onAuthStateChange() {} }, rpc: (name, args) => window.fixtureRpc(name, args) })
      };
    }, actor);
    await page.addScriptTag({ content: await read('outcomes.js') });
    const button = page.locator('[data-outcome-trace]');
    await button.waitFor();
    assert.equal(await button.count(), 1);
    return {
      async verify({ contains, excludes = [] }) {
        const before = traceReads;
        await button.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
          const node = document.querySelector('[data-trace-result]');
          return node && node.textContent && !node.textContent.includes('กำลังตรวจหลักฐาน');
        });
        await queue;
        assert.equal(traceReads, before + 1);
        const text = await page.locator('[data-trace-result]').innerText();
        for (const pattern of contains) assert.match(text, pattern);
        for (const pattern of excludes) assert.doesNotMatch(text, pattern);
        assert.deepEqual(errors, []);
      },
      async close() { await queue; await browser.close(); }
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
