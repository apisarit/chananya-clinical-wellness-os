// Actual Foundation UI -> intercepted transport -> disposable migrated PGlite.
// No hosted API, real identity, clinical record or approval write is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const fixture = await createPriceMasterFixture();
const { db, ids, asOwner, asUser } = fixture;
const literal = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
let browser;
let loseResponse = true;
let writes = 0;
let holdAcknowledgement = false;
let releaseAcknowledgement;
let acknowledgementHeld;
const held = new Promise(resolve => { acknowledgementHeld = resolve; });
try {
  await asOwner('select 1');
  await db.exec(await fs.readFile(new URL('../supabase/manual/20260917_ttm_knowledge_review_rpc_candidate.sql', import.meta.url), 'utf8'));
  browser = await chromium.launch(process.env.FOUNDATION_TEST_BROWSER_CHANNEL ? { channel: process.env.FOUNDATION_TEST_BROWSER_CHANNEL } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('syntheticSubmit', async params => {
    writes++;
    const sql = `select * from public.submit_ttm_knowledge_suggestion_once(${[
      params.p_request_id, params.p_target_table, params.p_target_id, params.p_action,
      JSON.stringify(params.p_payload), params.p_source_ref, params.p_reason
    ].map(literal).join(',')})`;
    try {
      const row = (await asUser(ids.userA, sql)).rows[0];
      if (loseResponse) { loseResponse = false; return { error: { message: 'SIMULATION_ONLY: response lost after commit' } }; }
      if (holdAcknowledgement) {
        await new Promise(resolve => { releaseAcknowledgement = resolve; acknowledgementHeld(); });
      }
      return { data: row };
    } catch (error) { return { error: { message: error.message, code: error.code } }; }
  });
  await page.exposeFunction('syntheticRead', async (table, filters, single) => {
    if (!['ttm_knowledge_suggestions','ttm_knowledge_suggestion_events'].includes(table)) return { data: [] };
    const allowed = new Set(['clinic_id','requested_by','client_request_id','status']);
    assert.ok(filters.every(([key]) => allowed.has(key)));
    const where = filters.map(([key,value]) => `${key}=${literal(value)}`).join(' and ');
    const rows = (await asUser(ids.userA, `select * from public.${table}${where ? ` where ${where}` : ''} limit 51`)).rows;
    return { data: single ? rows[0] || null : rows };
  });
  await page.addInitScript(({ userId, clinicId }) => {
    const db = {
      rpc(name, params) {
        if (name !== 'submit_ttm_knowledge_suggestion_once') throw new Error('Unexpected synthetic RPC');
        return window.syntheticSubmit(params);
      },
      from(table) {
        const filters = [];
        return { select() { return this; }, order() { return this; },
          eq(key,value) { filters.push([key,value]); return this; },
          range() { return window.syntheticRead(table, filters, false); },
          maybeSingle() { return window.syntheticRead(table, filters, true); }
        };
      },
      channel() { return { on() { return this; }, subscribe(callback) { setTimeout(() => callback('SUBSCRIBED'), 0); return this; } }; },
      removeChannel: async () => {}, auth: { signOut: async () => {}, onAuthStateChange(callback) { window.syntheticAuthChange=callback; } }
    };
    window.ChananyaRuntime = { getDb: () => db, getSession: async () => ({ user: { id: userId } }),
      getProfile: async () => ({ id: userId, clinic_id: clinicId }), can: () => true,
      rolesOf: () => ({ effectiveRole: 'practitioner', systemRole: null }) };
  }, { userId: ids.userA, clinicId: ids.clinicA });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (url.origin === 'https://foundation.test' && ['foundation.html','foundation.js','foundation-live.js','ttm-reasoning.js','app.css'].includes(name)) {
      return route.fulfill({ body: await fs.readFile(new URL(`../${name}`, import.meta.url)), contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    return route.fulfill({ body: '', contentType: 'application/javascript' });
  });
  const open = async () => {
    await page.goto('https://foundation.test/foundation.html');
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('[data-foundation-tab=coverage]').click();
  };
  const fill = async key => {
    await page.locator('#ttm-suggestion-payload').fill(JSON.stringify({ domain: 'synthetic', rule_key: key, input_key: 'synthetic', output_value: 'Not clinical knowledge' }));
    await page.locator('#ttm-suggestion-source').fill('Synthetic reference');
    await page.locator('#ttm-suggestion-reason').fill('Synthetic request recovery test');
  };
  const pendingKey = `cnyos:knowledge-request:${ids.userA}:${ids.clinicA}`;
  await open(); await fill('BROWSER-REPLAY');
  await page.locator('#ttm-suggestion-submit').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('response lost'));
  const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), pendingKey);
  assert.ok(saved.requestId);
  await open(); await fill('BROWSER-REPLAY');
  await page.locator('#ttm-suggestion-submit').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('เข้าคิวทบทวนแล้ว'));
  assert.equal(writes, 2);
  const rows = (await asOwner(`select * from public.ttm_knowledge_suggestions where client_request_id=${literal(saved.requestId)}`)).rows;
  assert.equal(rows.length, 1);
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_knowledge_suggestion_events where suggestion_id=${literal(rows[0].id)}`)).rows[0].n, 1);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
  assert.equal(await page.locator('#ttm-suggestion-payload').inputValue(), '');
  loseResponse = true;
  await fill('BROWSER-RECOVER'); await page.locator('#ttm-suggestion-submit').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('response lost'));
  await open();
  await page.locator('#ttm-suggestion-recover').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('พบข้อเสนอเดิม'));
  assert.equal(writes, 3, 'recovery is read-only, no fourth submit');
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
  assert.equal((await asOwner('select count(*)::int n from public.ttm_knowledge_suggestions')).rows[0].n, 2);
  holdAcknowledgement = true;
  await fill('BROWSER-EDIT-DURING-SEND');
  await page.locator('#ttm-suggestion-submit').click();
  await held;
  await page.locator('#ttm-suggestion-payload').fill('{"definition":"New unsent draft"}');
  releaseAcknowledgement();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('ร่างนี้ยังไม่ได้ส่ง'));
  assert.equal(await page.locator('#ttm-suggestion-payload').inputValue(), '{"definition":"New unsent draft"}');
  assert.equal(writes, 4);
  assert.deepEqual(errors, []);
  console.log('Foundation browser + PGlite passed: committed lost response, reload/same-ID replay, one event, scoped read recovery without resubmit. SIMULATION_ONLY; not hosted transport or production.');
} finally {
  if (browser) await browser.close();
  await db.close();
}
