// Synthetic browser proof for OPD History only. Network is aborted; the
// Supabase-shaped client below is an in-memory fixture, not a live/database
// acceptance test. Values and identifiers are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const html = fs.readFileSync(new URL('../clinical-v3.html', import.meta.url), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '')
  .replace('</head>', '<base href="http://cnyos.synthetic/"></head>');
const css = fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../opd-workflow.js', import.meta.url), 'utf8');
const FIELDS = [
  ['#opd-accident', 'accident_history', 'synthetic accident'], ['#opd-surgery', 'surgery_history', 'synthetic surgery'],
  ['#opd-chronic', 'chronic_diseases', 'synthetic chronic'], ['#opd-family', 'family_history', 'synthetic family'],
  ['#opd-personal', 'personal_history', 'synthetic personal'], ['#opd-food', 'food_pattern', 'synthetic food'],
  ['#opd-water', 'water_glasses_per_day', '2.5'], ['#opd-coffee', 'tea_coffee_glasses_per_day', '0'],
  ['#opd-smoking', 'smoking_detail', 'none'], ['#opd-alcohol', 'alcohol_detail', 'none'],
  ['#opd-urination', 'urination_per_day', '4'], ['#opd-bowel', 'bowel_movement_per_day', '1'],
  ['#opd-sleep', 'sleep_detail', '7 hours'], ['#opd-posture', 'posture_detail', 'upright'],
  ['#opd-emotion', 'emotional_state', 'calm'], ['#opd-allergy', 'allergy_food_drug', 'none known'],
  ['#opd-menstruation', 'menstruation_detail', 'synthetic cycle'], ['#opd-meds', 'current_medicines_supplements', 'synthetic supplement'],
  ['#opd-physical', 'physical_exam_narrative', 'synthetic exam']
];
const blankRow = { id: 'opd-row-a', encounter_id: 'enc-a' };
const numericKeys = new Set(['water_glasses_per_day', 'tea_coffee_glasses_per_day', 'urination_per_day', 'bowel_movement_per_day']);
function expectedMap(suffix = '') { return Object.fromEntries(FIELDS.map(([, key, value]) => [key, numericKeys.has(key) ? Number(value) : `${value}${suffix}`])); }

async function makePage(browser, { store = {}, role = 'practitioner', readError = false, readbackError = false, saveError = false, ackNoPersist = false, mismatchAfterSave = false, wrongMarker = false, missingRowId = false, ambiguousAfterPersist = false, nullZeroMismatch = false, upsertDelay = 0, loadDelay = 0 } = {}) {
  const context = await browser.newContext();
  const requests = [];
  await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.dismiss());
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { document.querySelector('#app')?.classList.remove('hidden'); document.querySelector('#boot')?.remove(); document.querySelector('#opd-history-section')?.classList.add('active'); });
  await page.evaluate(({ store, role, readError, readbackError, saveError, ackNoPersist, mismatchAfterSave, wrongMarker, missingRowId, ambiguousAfterPersist, nullZeroMismatch, upsertDelay, loadDelay }) => {
    window.__store = structuredClone(store); window.__calls = []; window.__events = []; window.__profile = { id: 'synthetic-practitioner', role, clinic_id: 'synthetic-clinic', access_context_ready: true };
    window.addEventListener('chananya:clinical-data-changed', event => window.__events.push(event.detail));
    const result = (data = null, error = null) => ({ data, error });
    const query = table => {
      let encounterId = null;
      const builder = {
        select() { return builder; },
        eq(column, value) { if (column === 'encounter_id') encounterId = value; return builder; },
        order() { return Promise.resolve(result([])); },
        limit() { return builder; },
        async maybeSingle() {
          window.__calls.push({ op: 'read', table, encounterId });
          if (window.__delayReadFor === encounterId) {
            await new Promise(resolve => { window.__releaseRead = resolve; });
          }
          if (loadDelay) await new Promise(resolve => setTimeout(resolve, loadDelay));
          if (readError) return result(null, { code: '42501', message: 'SYNTHETIC_READ_DENIED' });
          if (window.__postSave && readbackError && !window.__readbackRecovered) return result(null, new Error('SYNTHETIC_READBACK_INTERRUPTED'));
          if (mismatchAfterSave && window.__postSave) return result({ id: 'wrong-row', encounter_id: 'enc-b', accident_history: 'wrong target' });
          if (wrongMarker && window.__postSave) return result({ ...window.__store[encounterId], updated_by: 'other-writer', updated_at: '2000-01-01T00:00:00.000Z' });
          if (nullZeroMismatch && window.__postSave) return result({ ...window.__store[encounterId], water_glasses_per_day: 0 });
          return result(structuredClone(window.__store[encounterId] || null));
        },
        async upsert(payload) {
          window.__calls.push({ op: 'upsert', table, payload });
          if (upsertDelay) await new Promise(resolve => { window.__releaseUpsert = resolve; });
          if (saveError) return result(null, { code: '42501', message: 'CLINICAL_RECORD_LOCKED' });
          window.__postSave = true;
          if (!ackNoPersist) {
            window.__store[payload.encounter_id] = {
              ...window.__store[payload.encounter_id], ...payload,
              id: window.__store[payload.encounter_id]?.id || `opd-${payload.encounter_id}`
            };
            if (missingRowId) delete window.__store[payload.encounter_id].id;
          }
          if (ambiguousAfterPersist) return result(null, { code: '', status: 0, message: 'SYNTHETIC_CONNECTION_LOST' });
          return result(structuredClone(window.__store[payload.encounter_id] || null));
        }
      }; return builder;
    };
    window.ChananyaRuntime = {
      getDb: () => ({ from: query }),
      getSession: async () => ({ user: { id: 'synthetic-practitioner' } }),
      getProfile: async () => window.__profile,
      can: (profile, capability) => profile?.access_context_ready === true && profile?.role === 'practitioner' && capability === 'clinical_write'
    };
    const encounter = document.querySelector('#encounter');
    encounter.replaceChildren(new Option('Synthetic A', 'enc-a'), new Option('Synthetic B', 'enc-b'));
  }, { store, role, readError, readbackError, saveError, ackNoPersist, mismatchAfterSave, wrongMarker, missingRowId, ambiguousAfterPersist, nullZeroMismatch, upsertDelay, loadDelay });
  await page.addScriptTag({ content: source });
  await page.selectOption('#encounter', 'enc-a');
  await page.dispatchEvent('#encounter', 'change');
  return { context, page, requests };
}
async function waitReady(page) { await page.waitForFunction(() => /โหลด OPD|ยังไม่มี OPD/.test(document.querySelector('#opd-history-status')?.textContent || '')); }
async function waitAttemptSettled(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('#opd-history-verify');
    return window.__calls.some(call => call.op === 'upsert') &&
      (window.__events.length > 0 || (button && !button.hidden && !button.disabled));
  });
}
async function fillAll(page, suffix = '') { for (const [selector, , value] of FIELDS) await page.locator(selector).fill(`${value}${suffix}`); }
async function submit(page) { await page.locator('#opd-history-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  // RED baseline: current source must persist one row after an ordinary save.
  {
    const h = await makePage(browser); await waitReady(h.page); await fillAll(h.page); await submit(h.page);
    await h.page.waitForTimeout(50);
    const state = await h.page.evaluate(() => ({ store: window.__store, calls: window.__calls }));
    assert.ok(state.calls.some(call => call.op === 'upsert'), 'RED baseline: save did not issue OPD upsert');
    assert.ok(state.store['enc-a'], 'RED baseline: successful save must leave a persisted synthetic row');
    await h.context.close();
  }

  // RED: an acknowledged upsert with no persisted row must not report success or emit an event.
  {
    const h = await makePage(browser, { ackNoPersist: true }); await waitReady(h.page); await fillAll(h.page); await submit(h.page);
    await h.page.waitForTimeout(40);
    const state = await h.page.evaluate(() => ({ store: window.__store, events: window.__events, status: document.querySelector('#opd-history-status')?.textContent }));
    assert.equal(state.store['enc-a'], undefined, 'acknowledged no-persist fixture must remain absent');
    assert.equal(state.events.length, 0, 'no persisted row must not emit success event');
    assert.doesNotMatch(state.status || '', /บันทึก OPD History แล้ว/);
    await h.context.close();
  }

  // Happy save -> new page readback -> amendment, including zero/decimal/null.
  {
    const h = await makePage(browser); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await h.page.waitForTimeout(50);
    const persisted = await h.page.evaluate(() => window.__store); await h.context.close();
    const original = expectedMap();
    for (const key of Object.keys(original)) assert.equal(persisted['enc-a'][key], original[key], `persisted original ${key}`);
    const reopened = await makePage(browser, { store: persisted }); await waitReady(reopened.page);
    for (const [selector, key] of FIELDS) assert.equal(await reopened.page.inputValue(selector), String(persisted['enc-a'][key] ?? ''), key);
    await reopened.page.fill('#opd-water', '0'); await reopened.page.fill('#opd-coffee', ''); await reopened.page.fill('#opd-physical', 'amended synthetic exam'); await submit(reopened.page); await reopened.page.waitForTimeout(30);
    const amended = await reopened.page.evaluate(() => window.__store['enc-a']);
    assert.equal(amended.water_glasses_per_day, 0); assert.equal(amended.tea_coffee_glasses_per_day, null); assert.equal(amended.physical_exam_narrative, 'amended synthetic exam');
    assert.equal(amended.encounter_id, 'enc-a'); assert.equal((await reopened.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert'))).length, 1);
    const callOrder = await reopened.page.evaluate(() => window.__calls.map(call => call.op));
    assert.ok(callOrder.indexOf('upsert') > callOrder.lastIndexOf('read', callOrder.indexOf('upsert')), 'save must pre-read before upsert');
    assert.ok(callOrder.lastIndexOf('read') > callOrder.indexOf('upsert'), 'save must independently read back after upsert');
    const afterAmend = await reopened.page.evaluate(() => window.__store); await reopened.context.close();
    const amendedExpected = { ...original, water_glasses_per_day: 0, tea_coffee_glasses_per_day: null, physical_exam_narrative: 'amended synthetic exam' };
    for (const key of Object.keys(amendedExpected)) assert.equal(afterAmend['enc-a'][key], amendedExpected[key], `persisted amended ${key}`);
    const fresh = await makePage(browser, { store: afterAmend }); await waitReady(fresh.page);
    for (const [selector, key] of FIELDS) assert.equal(await fresh.page.inputValue(selector), String(afterAmend['enc-a'][key] ?? ''), `fresh ${key}`);
    assert.equal(afterAmend['enc-a'].created_by, persisted['enc-a'].created_by, 'amendment must retain original creator');
    assert.equal(afterAmend['enc-a'].id, persisted['enc-a'].id, 'amendment must retain row id'); await fresh.context.close();
  }

  // Mismatch readback must not be accepted as the selected Encounter.
  {
    const h = await makePage(browser, { mismatchAfterSave: true }); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await h.page.waitForTimeout(40);
    const result = await h.page.evaluate(() => ({ events: window.__events, calls: window.__calls, status: document.querySelector('#opd-history-status')?.textContent }));
    const readIndexes = result.calls.map((call, index) => call.op === 'read' ? index : -1).filter(index => index >= 0); const upsertIndex = result.calls.findIndex(call => call.op === 'upsert');
    assert.ok(readIndexes.some(index => index > upsertIndex), 'mismatch case requires an independent post-save read'); assert.equal(result.events.length, 0); assert.doesNotMatch(result.status || '', /บันทึก OPD History แล้ว/); await h.context.close();
  }

  // Acknowledged-no-persist and mismatch attempts remain blocked across selection changes; recovery is read-only.
  for (const mode of [{ ackNoPersist: true }, { mismatchAfterSave: true }]) {
    const h = await makePage(browser, mode); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await h.page.waitForTimeout(40);
    await h.page.selectOption('#encounter', 'enc-b'); await h.page.dispatchEvent('#encounter', 'change'); await h.page.waitForTimeout(20);
    await h.page.selectOption('#encounter', 'enc-a'); await h.page.dispatchEvent('#encounter', 'change'); await h.page.waitForTimeout(20);
    const verify = h.page.locator('#opd-history-verify'); assert.equal(await verify.count(), 1, 'recovery control must be present');
    await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await h.page.waitForTimeout(30);
    const state = await h.page.evaluate(() => ({ upserts: window.__calls.filter(c => c.op === 'upsert').length, events: window.__events.length, store: window.__store['enc-a'] }));
    assert.equal(state.upserts, 1); assert.equal(state.events, 0); assert.equal(Boolean(state.store), Boolean(mode.mismatchAfterSave)); await h.context.close();
  }

  // A readback transport error becomes recoverable by the exact read-only verify action, without a retry write.
  {
    const h = await makePage(browser, { readbackError: true }); await waitReady(h.page); await fillAll(h.page); const draft = await h.page.inputValue('#opd-accident'); await submit(h.page); await waitAttemptSettled(h.page);
    const before = await h.page.evaluate(() => ({ upserts: window.__calls.filter(c => c.op === 'upsert').length, events: window.__events.length, saved: Boolean(window.__store['enc-a']) })); assert.equal(before.upserts, 1); assert.equal(before.events, 0); assert.equal(before.saved, true);
    await h.page.evaluate(() => { window.__readbackRecovered = true; }); const verify = h.page.locator('#opd-history-verify'); assert.equal(await verify.count(), 1); await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await h.page.waitForTimeout(40);
    const after = await h.page.evaluate(() => ({ upserts: window.__calls.filter(c => c.op === 'upsert').length, events: window.__events, status: document.querySelector('#opd-history-status')?.textContent })); assert.equal(await h.page.inputValue('#opd-accident'), draft); assert.equal(after.upserts, 1); assert.equal(after.events.length, 1); assert.equal(after.events[0].encounterId, 'enc-a'); assert.match(after.status || '', /บันทึก.*แล้ว/); await h.context.close();
  }

  // Null and zero are distinct persisted numeric values; readback must reject a null→0 mutation.
  {
    const h = await makePage(browser, { nullZeroMismatch: true }); await waitReady(h.page); await fillAll(h.page); await h.page.fill('#opd-water', ''); await submit(h.page); await waitAttemptSettled(h.page); const state = await h.page.evaluate(() => ({ events: window.__events.length, reads: window.__calls.filter(c => c.op === 'read').length })); assert.equal(state.events, 0); assert.ok(state.reads >= 3); await h.context.close();
  }

  // A wrong writer/time marker is not an independently matching persisted row.
  {
    const h = await makePage(browser, { wrongMarker: true }); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await h.page.waitForTimeout(40); const state = await h.page.evaluate(() => ({ reads: window.__calls.filter(c => c.op === 'read').length, events: window.__events.length, status: document.querySelector('#opd-history-status')?.textContent })); assert.ok(state.reads >= 3); assert.equal(state.events, 0); assert.doesNotMatch(state.status || '', /บันทึก OPD History แล้ว/); await h.context.close();
  }

  // A persisted row without an id is not a matching readback, even when fields match.
  {
    const h = await makePage(browser, { missingRowId: true }); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await waitAttemptSettled(h.page); const state = await h.page.evaluate(() => ({ events: window.__events.length, calls: window.__calls })); assert.equal(state.events, 0); assert.ok(state.calls.some(call => call.op === 'read')); await h.context.close();
  }

  // Failed read is visible and blocks a save; denied runtime performs no read/write.
  {
    const failed = await makePage(browser, { readError: true }); await failed.page.waitForFunction(() => /อ่าน OPD/.test(document.querySelector('#opd-history-status')?.textContent || '')); await submit(failed.page); await failed.page.waitForTimeout(20); assert.equal((await failed.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert'))).length, 0); await failed.context.close();
    const denied = await makePage(browser, { role: 'denied' }); await denied.page.waitForTimeout(80); assert.equal(await denied.page.evaluate(() => window.__calls.length), 0); await denied.context.close();
  }

  // Immediate duplicate dispatches are bounded by one delayed in-flight upsert.
  {
    const h = await makePage(browser, { upsertDelay: 1 }); await waitReady(h.page); await fillAll(h.page); await h.page.locator('#opd-history-form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await h.page.waitForFunction(() => window.__calls.filter(c => c.op === 'upsert').length >= 1); assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 1); await h.page.evaluate(() => window.__releaseUpsert()); await h.page.waitForTimeout(40); await h.context.close();
  }

  // Locked server rejection retains the entered draft and emits no success.
  {
    const h = await makePage(browser, { saveError: true }); await waitReady(h.page); await fillAll(h.page); const draft = await h.page.inputValue('#opd-accident'); await submit(h.page); await h.page.waitForTimeout(40); assert.equal(await h.page.inputValue('#opd-accident'), draft); assert.equal(await h.page.evaluate(() => window.__events.length), 0); await h.context.close();
  }

  // Invalid numeric values must not write.
  {
    const h = await makePage(browser); await waitReady(h.page); await fillAll(h.page); for (const value of ['-1', '0.25', '10000']) { await h.page.fill('#opd-water', value); await submit(h.page); } await h.page.waitForTimeout(40); assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 0); await h.context.close();
  }

  // Change one authorization boundary at a time; capability alone is not identity.
  for (const delta of [
    { role: 'denied' }, { clinic_id: 'other-clinic' },
    { id: 'other-user' }, { access_context_ready: false }, { clinic_id: null }
  ]) {
    const h = await makePage(browser);
    await waitReady(h.page);
    await fillAll(h.page);
    await h.page.evaluate(delta => Object.assign(window.__profile, delta), delta);
    await submit(h.page);
    await h.page.waitForFunction(() => /ยังไม่ได้บันทึก/.test(document.querySelector('#opd-history-status').textContent));
    assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 0);
    assert.equal(await h.page.inputValue('#opd-accident'), 'synthetic accident');
    await h.context.close();
  }

  // Ambiguous connection loss requires exact verification, never a retry write.
  {
    const h = await makePage(browser, { ambiguousAfterPersist: true });
    await waitReady(h.page);
    await fillAll(h.page);
    await submit(h.page);
    await waitAttemptSettled(h.page);
    const before = await h.page.evaluate(() => ({
      upserts: window.__calls.filter(c => c.op === 'upsert').length,
      events: window.__events.length, stored: Boolean(window.__store['enc-a'])
    }));
    assert.deepEqual(before, { upserts: 1, events: 0, stored: true });
    await h.page.locator('#opd-history-verify').click();
    await h.page.waitForFunction(() => window.__events.length === 1);
    assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 1);
    assert.equal(await h.page.locator('#opd-history-verify').isVisible(), false);
    await h.context.close();
  }

  // A timed-out write stays blocked until the original promise actually settles.
  {
    const h = await makePage(browser, { upsertDelay: 1 });
    await waitReady(h.page);
    await h.page.clock.install();
    await fillAll(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.filter(c => c.op === 'upsert').length === 1);
    await h.page.clock.fastForward(20001);
    const verify = h.page.locator('#opd-history-verify');
    await h.page.waitForFunction(() => !document.querySelector('#opd-history-verify').hidden);
    assert.equal(await verify.isDisabled(), true);
    await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await submit(h.page);
    assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 1);
    assert.equal(await h.page.evaluate(() => window.__events.length), 0);
    await h.page.evaluate(() => window.__releaseUpsert());
    await h.page.waitForFunction(() => !document.querySelector('#opd-history-verify').disabled);
    await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await h.page.waitForFunction(() => window.__events.length === 1);
    assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 1);
    await h.context.close();
  }

  // Late recovery must retain a newer draft while a different visit is open.
  {
    const h = await makePage(browser, { readbackError: true });
    await waitReady(h.page);
    await fillAll(h.page);
    await submit(h.page);
    await waitAttemptSettled(h.page);
    await h.page.fill('#opd-accident', 'new unsaved draft');
    await h.page.evaluate(() => { window.__readbackRecovered = true; window.__delayReadFor = 'enc-a'; });
    await h.page.locator('#opd-history-verify').click();
    await h.page.waitForFunction(() => typeof window.__releaseRead === 'function');
    await h.page.selectOption('#encounter', 'enc-b');
    await waitReady(h.page);
    await h.page.evaluate(() => { window.__delayReadFor = null; window.__releaseRead(); });
    await h.page.waitForFunction(() => window.__events.length === 1);
    await h.page.selectOption('#encounter', 'enc-a');
    assert.equal(await h.page.inputValue('#opd-accident'), 'new unsaved draft');
    assert.match(await h.page.locator('#opd-history-status').innerText(), /ยังไม่บันทึก/);
    assert.equal(await h.page.evaluate(() => window.__store['enc-a'].accident_history), 'synthetic accident');
    assert.equal(await h.page.evaluate(() => window.__calls.filter(c => c.op === 'upsert').length), 1);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__events.length === 2);
    assert.equal(await h.page.evaluate(() => window.__store['enc-a'].accident_history), 'new unsaved draft');
    await h.context.close();
  }

  // Delayed A save must never retarget B or report A success after selection changes.
  {
    const h = await makePage(browser, { upsertDelay: 1 }); await waitReady(h.page); await fillAll(h.page); await submit(h.page); await h.page.waitForFunction(() => window.__calls.filter(c => c.op === 'upsert').length === 1); await h.page.selectOption('#encounter', 'enc-b'); await h.page.dispatchEvent('#encounter', 'change'); await h.page.evaluate(() => window.__releaseUpsert()); await h.page.waitForTimeout(60); const state = await h.page.evaluate(() => ({ store: window.__store, events: window.__events, status: document.querySelector('#opd-history-status')?.textContent })); assert.ok(state.store['enc-a']); assert.equal(state.store['enc-b'], undefined); assert.ok(state.events.every(event => event.encounterId === 'enc-a'), 'late completion may only emit its original A event'); assert.doesNotMatch(state.status || '', /บันทึก OPD History แล้ว/); await h.context.close();
  }

  console.log('PASS isolated OPD History browser persistence: synthetic save/reopen/amend, complete field mapping, read failure/denied role, duplicate/locked save, invalid numeric and stale selection guards. No live DB acceptance.');
} finally { await browser.close(); }
