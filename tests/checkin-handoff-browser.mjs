// Isolated browser proof for the check-in handoff. Requests are locally fulfilled or aborted and
// the runtime/RPC layer below is synthetic; this never reaches Supabase or a
// real patient record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const html = fs.readFileSync(new URL('../check-in.html', import.meta.url), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '')
  .replace('</head>', '<base href="http://cnyos.synthetic/"></head>');
const source = fs.readFileSync(new URL('../check-in.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const A = { patient_id: 'patient-a', hn: 'SYN-A', display_name: 'Synthetic A', date_of_birth: '1990-01-01', phone_last4: '0001' };
const B = { patient_id: 'patient-b', hn: 'SYN-B', display_name: 'Synthetic B', date_of_birth: '1991-02-02', phone_last4: '0002' };

async function makePage(browser, { role = 'reception', outcome = 'ok', mismatch = false, appointment = false } = {}) {
  const context = await browser.newContext();
  const requests = [];
  await context.route('**/*', route => {
    requests.push(route.request().url());
    return route.request().resourceType() === 'document' && appointment
      ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
      : route.abort();
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.dismiss());
  page.on('pageerror', error => console.error('synthetic pageerror:', error.message));
  if (appointment) await page.goto('http://cnyos.synthetic/check-in.html?appointment=synthetic-appt');
  else await page.setContent(html);
  await page.addStyleTag({ content: css });
  await page.evaluate(({ role }) => {
    window.ChananyaRuntime = {
      getDb: () => window.__syntheticDb,
      getSession: async () => ({ user: { id: 'synthetic-operator' } }),
      getProfile: async () => ({ role }),
      can: (_profile, capability) => capability === 'patient_checkin' || (capability === 'clinical_write' && role === 'practitioner')
    };
    window.ChananyaShell = { mount() { document.querySelector('#role').textContent = `${role} · synthetic`; } };
  }, { role });
  await page.evaluate(({ outcome, mismatch, patientA, patientB }) => {
    window.__calls = [];
    const rows = { A: [patientA], B: [patientB] };
    window.__syntheticDb = {
      rpc: async (name, payload) => {
        window.__calls.push({ name, payload });
        if (name === 'hybrid_patient_identity_healthcheck') return { data: [{ ready: true }], error: null };
        if (name === 'search_patients_for_checkin') return { data: payload.p_query.trim().toUpperCase().endsWith('B') ? rows.B : rows.A, error: null };
        if (name === 'resolve_patient_qr') return window.__delayedQr;
        if (name === 'start_manual_patient_encounter' || name === 'confirm_patient_qr' || name === 'check_in_clinic_appointment') {
          if (outcome === 'denied') return { data: null, error: Object.assign(new Error('PERMISSION_DENIED'), { code: '42501' }) };
          if (outcome === 'unknown') throw new Error('synthetic transport interrupted');
          return { data: { encounter_id: mismatch ? 'encounter-for-b' : 'encounter-a', encounter_no: 'SYN-ENC-1', patient_id: mismatch ? 'patient-b' : 'patient-a' }, error: null };
        }
        throw new Error(`UNEXPECTED_RPC_${name}`);
      },
      from: table => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: 'synthetic-appt', appointment_no: 'SYN-APT-1', patient_id: patientA.patient_id, practitioner_id: 'synthetic-provider', status: 'booked', encounter_id: null, scheduled_start: '2026-10-01T03:00:00Z', chief_complaint: '', patient: { id: patientA.patient_id, hn: patientA.hn, first_name: 'Synthetic', last_name: 'A', phone: '0001' } }, error: null }) })
    };
  }, { outcome, mismatch, patientA: A, patientB: B });
  // Promise handles cannot cross the browser boundary, so replace the QR
  // response with a browser-side deferred promise.
  await page.evaluate(() => {
    let release;
    window.__qrPromise = new Promise(resolve => { release = resolve; });
    window.__releaseQr = release;
    const rpc = window.__syntheticDb.rpc;
    window.__syntheticDb.rpc = async (name, payload) => name === 'resolve_patient_qr' ? window.__qrPromise : rpc(name, payload);
  });
  await page.addScriptTag({ content: source });
  await page.waitForTimeout(500);
  if (!(await page.locator('#boot').getAttribute('class') || '').includes('hidden')) {
    throw new Error(`synthetic check-in boot did not complete: ${await page.locator('#boot-error').textContent()}`);
  }
  return { context, page, requests };
}

async function selectManual(page, term) {
  await page.fill('#manual-search', term);
  await page.locator('#manual-search-form button').click({ timeout: 5000 });
  await page.locator('#manual-results .identity-result').first().click({ timeout: 5000 });
}
async function waitReceipt(page) {
  await page.waitForFunction(() => !document.querySelector('#handoff-receipt').classList.contains('hidden'), null, { timeout: 5000 });
}

const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  {
    const h = await makePage(browser, { role: 'reception', appointment: true });
    await selectManual(h.page, 'SYN-A');
    await h.page.fill('#verification-note', 'synthetic note A');
    await h.page.fill('#checkin-chief', 'synthetic chief A');
    await h.page.check('#patient-present');
    await h.page.locator('#confirmation-form').evaluate(form => form.requestSubmit());
    await waitReceipt(h.page);
    assert.equal((await h.page.evaluate(() => window.__calls.filter(c => c.name === 'check_in_clinic_appointment'))).length, 1);
    assert.match(await h.page.locator('#handoff-primary').getAttribute('href'), /appointments\.html#appointment-register$/);
    assert.match(await h.page.locator('#appointment-context-detail').textContent(), /เชื่อม Encounter SYN-ENC-1 สำเร็จ/);
    if (process.env.CNYOS_CHECKIN_SCREENSHOT_PATH) {
      await h.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await h.page.screenshot({ path: process.env.CNYOS_CHECKIN_SCREENSHOT_PATH, fullPage: true });
    }
    await h.page.locator('#handoff-primary').evaluate(anchor => anchor.addEventListener('click', event => {
      event.preventDefault();
      window.__callsAtNavigation = window.__calls.filter(c => c.name === 'check_in_clinic_appointment');
    }, { once: true }));
    await h.page.locator('#handoff-primary').click();
    assert.equal(await h.page.evaluate(() => window.__callsAtNavigation.length), 1, 'blocked navigation retry must not repeat the mutation');
    assert.equal((await h.page.evaluate(() => window.__calls.filter(c => c.name === 'check_in_clinic_appointment'))).length, 1, 'navigation retry must not repeat the mutation');
    await h.context.close();
  }
  {
    const h = await makePage(browser, { role: 'practitioner' });
    await selectManual(h.page, 'SYN-A'); await h.page.check('#patient-present');
    await h.page.locator('#confirmation-form').evaluate(form => form.requestSubmit());
    await waitReceipt(h.page);
    assert.match(await h.page.locator('#handoff-primary').getAttribute('href'), /clinical-v3\.html\?encounter=encounter-a&step=history$/);
    await h.context.close();
  }
  {
    const h = await makePage(browser, { role: 'reception' });
    await h.page.fill('#credential-input', '123456');
    await h.page.locator('#credential-form').evaluate(form => form.requestSubmit());
    await h.page.evaluate(() => { const input = document.querySelector('#manual-search'); input.disabled = false; input.value = 'SYN-B'; document.querySelector('#manual-search-form').requestSubmit(); });
    await h.page.waitForSelector('#manual-results .identity-result');
    await h.page.locator('#manual-results .identity-result').click();
    await h.page.evaluate(patient => window.__releaseQr({ data: patient, error: null }), A);
    await h.page.waitForTimeout(30);
    assert.equal(await h.page.locator('#confirm-hn').textContent(), 'SYN-B', 'stale QR response must not replace newer manual identity');
    await h.context.close();
  }
  for (const outcome of ['denied', 'unknown']) {
    const h = await makePage(browser, { role: 'reception', outcome });
    await selectManual(h.page, 'SYN-A'); await h.page.check('#patient-present');
    await h.page.locator('#confirmation-form').evaluate(form => form.requestSubmit());
    await h.page.waitForTimeout(50);
    assert.equal(await h.page.locator('#handoff-receipt').isVisible(), false, `${outcome} must not show success receipt`);
    if (outcome === 'unknown') assert.equal(await h.page.locator('#handoff-uncertain').isVisible(), true);
    await h.context.close();
  }
  {
    const h = await makePage(browser, { role: 'reception', mismatch: true });
    await selectManual(h.page, 'SYN-A'); await h.page.check('#patient-present');
    await h.page.locator('#confirmation-form').evaluate(form => form.requestSubmit());
    await h.page.waitForTimeout(50);
    assert.equal(await h.page.locator('#handoff-receipt').isVisible(), false, 'returned patient mismatch must be rejected');
    await h.context.close();
  }
  console.log('PASS isolated browser check-in handoff: reception/practitioner routes, receipt idempotency, stale QR, denied/unknown outcomes, and returned-patient mismatch. Synthetic RPC only; no live DB acceptance.');
} finally { await browser.close(); }
