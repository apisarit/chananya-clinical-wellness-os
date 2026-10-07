// Isolated browser regression for Treatment Session persistence. Every identifier and
// clinical value is synthetic, the document is fulfilled in memory, all external network
// requests are aborted, and the Supabase-shaped client below is in-memory only. This is
// not live database or staging acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const html = fs.readFileSync(new URL('../clinical-v3.html', import.meta.url), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '')
  .replace('</head>', '<base href="http://cnyos.synthetic/"></head>');
const css = fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../opd-workflow.js', import.meta.url), 'utf8');
const TEST_URL = 'http://cnyos.synthetic/clinical-v3.html';
const LEGACY_OPERATION_PREFIX = 'cnyos:treatment-session-operation:';
const SCOPED_OPERATION_PREFIX = `${LEGACY_OPERATION_PREFIX}v2:`;
const OPERATION_IDENTITY_KEY = 'cnyos:treatment-session-operation-identity:v2';

const SYNTHETIC = Object.freeze({
  detail: 'synthetic treatment detail',
  procedure: 'synthetic procedure referral',
  precautions: 'synthetic precautions',
  outcome: 'synthetic outcome',
  advice: 'synthetic advice'
});

function expectedPayload(encounterId = 'enc-a') {
  return {
    encounter_id: encounterId,
    treatment_modalities: ['นวดไทย'],
    treatment_detail: SYNTHETIC.detail,
    procedure_referral: true,
    procedure_referral_detail: SYNTHETIC.procedure,
    precautions: SYNTHETIC.precautions,
    pain_before: 6,
    pain_after: 3,
    outcome_summary: SYNTHETIC.outcome,
    advice: SYNTHETIC.advice
  };
}

function operationIdentity(clinicId, practitionerId) {
  return `${encodeURIComponent(clinicId)}:${encodeURIComponent(practitionerId)}`;
}

function scopedOperationKey(clinicId, practitionerId, encounterId) {
  return `${SCOPED_OPERATION_PREFIX}${operationIdentity(clinicId, practitionerId)}:${encodeURIComponent(encounterId)}`;
}

async function mountSyntheticPage(page, {
  mode = 'ok', delayedRpc = false,
  practitionerId = 'synthetic-practitioner', clinicId = 'synthetic-clinic'
} = {}) {
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    document.querySelector('#app')?.classList.remove('hidden');
    document.querySelector('#boot')?.remove();
    document.querySelector('.clinical-stage[data-stage="treatment"]')?.classList.add('active');
  });
  await page.evaluate(({ mode, delayedRpc, synthetic, practitionerId, clinicId }) => {
    window.__calls = [];
    window.__events = [];
    window.__sessions = [];
    window.__profile = {
      id: practitionerId,
      role: 'practitioner',
      clinic_id: clinicId,
      access_context_ready: true
    };
    window.addEventListener('chananya:clinical-data-changed', event => window.__events.push(event.detail));
    const result = (data = null, error = null) => ({ data, error });
    const matches = (row, filters) => Object.entries(filters).every(([key, value]) => row[key] === value);
    const query = table => {
      const filters = {};
      const builder = {
        select(columns = '*') { builder.columns = columns; return builder; },
        eq(column, value) { filters[column] = value; return builder; },
        limit() { return builder; },
        async order(column) {
          window.__calls.push({ op: 'read-list', table, filters: { ...filters }, column });
          if (table === 'clinical_treatment_sessions') {
            const rows = window.__sessions.filter(row => matches(row, filters))
              .sort((left, right) => Number(left.session_no) - Number(right.session_no));
            return result(structuredClone(rows));
          }
          return result([]);
        },
        async maybeSingle() {
          window.__calls.push({ op: 'read-one', table, filters: { ...filters }, columns: builder.columns });
          if (table === 'ttm_opd_histories') return result(null);
          if (mode === 'readback-missing' && filters.id) return result(null);
          const rows = window.__sessions.filter(row => matches(row, filters));
          return rows.length === 1 ? result(structuredClone(rows[0])) : rows.length === 0 ? result(null) : result(null, { code: 'PGRST116', message: 'synthetic multiple rows' });
        },
        async single() {
          const found = await builder.maybeSingle();
          return found.data ? found : result(null, found.error || { code: 'PGRST116', message: 'synthetic row missing' });
        },
        then(resolve, reject) {
          return builder.order('session_no').then(resolve, reject);
        }
      };
      return builder;
    };
    let sequence = 0;
    function persist(payload, encounterId = payload.p_encounter_id) {
      const row = {
        id: `synthetic-session-${++sequence}`,
        encounter_id: encounterId,
        session_no: 1 + window.__sessions.filter(item => item.encounter_id === encounterId).length,
        treated_at: '2026-10-03T08:00:00.000Z',
        practitioner_id: practitionerId,
        client_request_id: payload.p_client_request_id,
        treatment_modalities: structuredClone(payload.p_treatment_modalities || []),
        treatment_detail: payload.p_treatment_detail,
        procedure_referral: payload.p_procedure_referral,
        procedure_referral_detail: payload.p_procedure_referral_detail,
        precautions: payload.p_precautions,
        pain_before: payload.p_pain_before,
        pain_after: payload.p_pain_after,
        outcome_summary: payload.p_outcome_summary,
        advice: payload.p_advice
      };
      window.__sessions.push(row);
      return row;
    }
    if (mode === 'baseline-replay') {
      persist({
        p_encounter_id: 'enc-a', p_treatment_modalities: ['นวดไทย'],
        p_treatment_detail: synthetic.detail, p_procedure_referral: true,
        p_procedure_referral_detail: synthetic.procedure, p_precautions: synthetic.precautions,
        p_pain_before: 6, p_pain_after: 3, p_outcome_summary: synthetic.outcome,
        p_advice: synthetic.advice
      });
    }
    let releaseRpc;
    window.__rpcGate = new Promise(resolve => { releaseRpc = resolve; });
    window.__releaseRpc = releaseRpc;
    window.__syntheticDb = {
      from: query,
      async rpc(name, payload) {
        window.__calls.push({ op: 'rpc', name, payload: structuredClone(payload) });
        if (name !== 'create_clinical_treatment_session') throw new Error(`UNEXPECTED_RPC_${name}`);
        if (delayedRpc) await window.__rpcGate;
        if (mode === 'ack-null') return result(null);
        if (mode === 'wrong-encounter') return result(structuredClone(persist(payload, 'enc-b')));
        if (mode === 'baseline-replay') return result(structuredClone(window.__sessions[0]));
        const existing = window.__sessions.find(row => row.encounter_id === payload.p_encounter_id
          && row.client_request_id === payload.p_client_request_id);
        if (existing) return result(structuredClone(existing));
        const row = persist(payload);
        if (mode === 'ambiguous-after-persist') throw new Error('SYNTHETIC_TRANSPORT_INTERRUPTED');
        return result(structuredClone(row));
      }
    };
    window.ChananyaRuntime = {
      getDb: () => window.__syntheticDb,
      getSession: async () => ({ user: { id: practitionerId } }),
      getProfile: async () => window.__profile,
      can: (profile, capability) => profile?.id === practitionerId
        && profile?.clinic_id === clinicId
        && profile?.access_context_ready === true
        && capability === 'clinical_write'
    };
    const encounter = document.querySelector('#encounter');
    encounter.replaceChildren(new Option('Synthetic encounter A', 'enc-a'), new Option('Synthetic encounter B', 'enc-b'));
  }, { mode, delayedRpc, synthetic: SYNTHETIC, practitionerId, clinicId });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => window.__calls.some(call => call.op === 'read-list' && call.filters.encounter_id === 'enc-a'));
}

async function makePage(browser, options = {}) {
  const context = await browser.newContext();
  const requests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    requests.push(url);
    if (url === TEST_URL && route.request().resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });
  await mountSyntheticPage(page, options);
  return { context, page, requests };
}

async function reloadPageAs(page, options) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await mountSyntheticPage(page, options);
}

async function fillSession(page, suffix = '') {
  await page.check('input[name="opd-modality"][value="นวดไทย"]');
  await page.fill('#opd-pain-before', '6');
  await page.fill('#opd-pain-after', '3');
  await page.fill('#opd-treatment-detail', `${SYNTHETIC.detail}${suffix}`);
  await page.check('#opd-procedure-referral');
  await page.fill('#opd-procedure-detail', `${SYNTHETIC.procedure}${suffix}`);
  await page.fill('#opd-precautions', `${SYNTHETIC.precautions}${suffix}`);
  await page.fill('#opd-outcome', `${SYNTHETIC.outcome}${suffix}`);
  await page.fill('#opd-advice', `${SYNTHETIC.advice}${suffix}`);
}
async function submit(page) {
  await page.locator('#opd-session-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function switchEncounter(page, encounterId) {
  await page.selectOption('#encounter', encounterId);
  await page.waitForFunction(id => window.__calls.some(call => call.op === 'read-list' && call.filters.encounter_id === id), encounterId);
}
async function sessionState(page) {
  return page.evaluate(() => ({
    detail: document.querySelector('#opd-treatment-detail')?.value,
    events: structuredClone(window.__events),
    calls: structuredClone(window.__calls),
    sessions: structuredClone(window.__sessions)
  }));
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {})
});
try {
  // An empty acknowledgement is not persistence proof: keep the draft and emit no success.
  {
    const h = await makePage(browser, { mode: 'ack-null' });
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'rpc'));
    await h.page.waitForTimeout(30);
    const state = await sessionState(h.page);
    assert.equal(state.sessions.length, 0);
    assert.equal(state.detail, SYNTHETIC.detail, 'data:null/error:null must retain the submitted draft');
    assert.equal(state.events.length, 0, 'data:null/error:null must not emit treatment-session success');
    await h.context.close();
  }

  // A row acknowledged for another encounter is never proof for the selected encounter.
  {
    const h = await makePage(browser, { mode: 'wrong-encounter' });
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'rpc'));
    await h.page.waitForTimeout(30);
    const state = await sessionState(h.page);
    assert.equal(state.sessions[0]?.encounter_id, 'enc-b');
    assert.equal(state.detail, SYNTHETIC.detail, 'wrong-encounter acknowledgement must retain the A draft');
    assert.equal(state.events.length, 0, 'wrong-encounter acknowledgement must not emit A success');
    await h.context.close();
  }

  // An old identical row replayed by the RPC is not proof that this request appended a session.
  {
    const h = await makePage(browser, { mode: 'baseline-replay' });
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'rpc'));
    await h.page.waitForTimeout(30);
    const state = await sessionState(h.page);
    assert.equal(state.sessions.length, 1, 'baseline replay fixture must not append a row');
    assert.equal(state.detail, SYNTHETIC.detail, 'baseline row acknowledgement must retain the new draft');
    assert.equal(state.events.length, 0, 'baseline row acknowledgement must not emit success');
    await h.context.close();
  }

  // Success requires both an exact returned row and an independent ID + encounter readback.
  {
    const h = await makePage(browser);
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__events.length === 1);
    const state = await sessionState(h.page);
    const rpcIndex = state.calls.findIndex(call => call.op === 'rpc');
    const exactRead = state.calls.find((call, index) => index > rpcIndex && call.op === 'read-one'
      && call.table === 'clinical_treatment_sessions'
      && call.filters.id === state.sessions[0].id
      && call.filters.encounter_id === 'enc-a');
    assert.ok(exactRead, 'success requires independent exact ID + encounter readback after RPC');
    const operationId = state.calls.find(call => call.op === 'rpc').payload.p_client_request_id;
    assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(state.sessions[0].client_request_id, operationId, 'persisted row must bind the exact client operation UUID');
    assert.equal(state.events[0].encounterId, 'enc-a');
    assert.equal(state.events[0].source, 'treatment-session');
    assert.equal(state.detail, '', 'only verified persistence may clear the submitted draft');
    assert.deepEqual({
      encounter_id: state.sessions[0].encounter_id,
      treatment_modalities: state.sessions[0].treatment_modalities,
      treatment_detail: state.sessions[0].treatment_detail,
      procedure_referral: state.sessions[0].procedure_referral,
      procedure_referral_detail: state.sessions[0].procedure_referral_detail,
      precautions: state.sessions[0].precautions,
      pain_before: state.sessions[0].pain_before,
      pain_after: state.sessions[0].pain_after,
      outcome_summary: state.sessions[0].outcome_summary,
      advice: state.sessions[0].advice
    }, expectedPayload());
    await h.context.close();
  }

  // An acknowledgement without its independent exact readback remains uncertain.
  {
    const h = await makePage(browser, { mode: 'readback-missing' });
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'read-one' && call.filters.id));
    await h.page.waitForTimeout(30);
    const state = await sessionState(h.page);
    assert.equal(state.sessions.length, 1, 'fixture persists before hiding exact readback');
    assert.equal(state.events.length, 0, 'missing exact readback must not emit success');
    assert.equal(state.detail, SYNTHETIC.detail, 'missing exact readback must retain the draft');
    assert.equal(await h.page.locator('#opd-session-verify').count(), 1);
    await h.context.close();
  }

  // A transport failure after insertion is recovered by the exact server-enforced operation UUID.
  {
    const h = await makePage(browser, { mode: 'ambiguous-after-persist' });
    await fillSession(h.page);
    await submit(h.page);
    await h.page.waitForFunction(() => window.__sessions.length === 1);
    await submit(h.page);
    await h.page.waitForTimeout(30);
    let state = await sessionState(h.page);
    assert.equal(state.calls.filter(call => call.op === 'rpc').length, 1, 'uncertain write must block repeat mutation');
    assert.equal(state.sessions.length, 1, 'uncertain write must not create a duplicate session');
    assert.equal(state.detail, SYNTHETIC.detail, 'uncertain write must retain the submitted draft');
    assert.equal(state.events.length, 0, 'uncertain write is not success');
    const verify = h.page.locator('#opd-session-verify');
    assert.equal(await verify.count(), 1, 'uncertain write needs a read-only verification control');
    await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await h.page.waitForFunction(() => window.__events.length === 1);
    state = await sessionState(h.page);
    assert.equal(state.calls.filter(call => call.op === 'rpc').length, 1, 'verification must never repeat the mutation');
    assert.equal(state.events.length, 1, 'exact operation-ID readback resolves the original attempt');
    assert.equal(state.detail, '', 'verified operation-ID recovery may clear the submitted draft');
    await h.context.close();
  }

  // A transport that never settles may be checked read-only after timeout, but never retried or guessed.
  {
    const h = await makePage(browser, { delayedRpc: true });
    await h.page.clock.install();
    await fillSession(h.page, ' hanging');
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'rpc'));
    await h.page.clock.fastForward(20001);
    await h.page.waitForFunction(() => !document.querySelector('#opd-session-verify').hidden);
    const verify = h.page.locator('#opd-session-verify');
    assert.equal(await verify.isDisabled(), false, 'read-only verification must remain available after client timeout');
    await verify.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await h.page.waitForTimeout(20);
    await submit(h.page);
    const state = await sessionState(h.page);
    assert.equal(state.calls.filter(call => call.op === 'rpc').length, 1, 'hanging transport must block a second mutation');
    assert.equal(state.events.length, 0);
    assert.equal(state.detail, `${SYNTHETIC.detail} hanging`);
    await h.context.close();
  }

  // Unsaved drafts are encounter-scoped and survive navigation in both directions.
  {
    const h = await makePage(browser);
    await fillSession(h.page, ' A-draft');
    await switchEncounter(h.page, 'enc-b');
    await h.page.fill('#opd-treatment-detail', 'synthetic B draft');
    await switchEncounter(h.page, 'enc-a');
    assert.equal(await h.page.inputValue('#opd-treatment-detail'), `${SYNTHETIC.detail} A-draft`);
    await switchEncounter(h.page, 'enc-b');
    assert.equal(await h.page.inputValue('#opd-treatment-detail'), 'synthetic B draft');
    assert.equal((await sessionState(h.page)).calls.filter(call => call.op === 'rpc').length, 0);
    await h.context.close();
  }

  // A same-tab auth handoff must not give practitioner B either A's scoped UUID
  // or an unattributed legacy encounter-only UUID for the same Encounter.
  {
    const clinicId = 'synthetic-clinic';
    const practitionerA = 'synthetic-practitioner-a';
    const practitionerB = 'synthetic-practitioner-b';
    const legacyOperation = '22222222-2222-4222-8222-222222222222';
    const encounterId = 'enc-a';
    const operationAKey = scopedOperationKey(clinicId, practitionerA, encounterId);
    const operationBKey = scopedOperationKey(clinicId, practitionerB, encounterId);
    const legacyKey = `${LEGACY_OPERATION_PREFIX}${encounterId}`;
    const h = await makePage(browser, { mode: 'ambiguous-after-persist', practitionerId: practitionerA, clinicId });
    await fillSession(h.page, ' A-handoff');
    await submit(h.page);
    await h.page.waitForFunction(() => !document.querySelector('#opd-session-verify').hidden);
    const operationA = (await sessionState(h.page)).calls.find(call => call.op === 'rpc')?.payload.p_client_request_id;
    assert.equal(await h.page.evaluate(key => sessionStorage.getItem(key), operationAKey), operationA,
      'A uncertain write must use the clinic + practitioner + Encounter scoped key');
    await h.page.evaluate(({ legacyKey, legacyOperation }) => {
      sessionStorage.setItem(legacyKey, legacyOperation);
    }, { legacyKey, legacyOperation });

    assert.equal(await h.page.evaluate(key => sessionStorage.getItem(key), OPERATION_IDENTITY_KEY),
      operationIdentity(clinicId, practitionerA));
    await reloadPageAs(h.page, { practitionerId: practitionerB, clinicId });
    const storageAfterHandoff = await h.page.evaluate(keys => ({
      legacy: sessionStorage.getItem(keys.legacyKey),
      practitionerA: sessionStorage.getItem(keys.operationAKey),
      practitionerB: sessionStorage.getItem(keys.operationBKey),
      identity: sessionStorage.getItem(keys.identityKey)
    }), { legacyKey, operationAKey, operationBKey, identityKey: OPERATION_IDENTITY_KEY });
    assert.equal(storageAfterHandoff.legacy, null, 'identity handoff must clear unattributed encounter-only recovery state');
    assert.equal(storageAfterHandoff.practitionerA, operationA, 'handoff must not rewrite A recovery state into B scope');
    assert.equal(storageAfterHandoff.practitionerB, null, 'B starts without a recovered operation UUID');
    assert.equal(storageAfterHandoff.identity, operationIdentity(clinicId, practitionerB));

    await fillSession(h.page, ' B-handoff');
    await submit(h.page);
    await h.page.waitForFunction(() => window.__events.length === 1);
    const state = await sessionState(h.page);
    const operationB = state.calls.find(call => call.op === 'rpc')?.payload.p_client_request_id;
    assert.match(operationB, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(operationB, operationA, 'B must not reuse A scoped UUID');
    assert.notEqual(operationB, legacyOperation, 'B must not reuse the cleared legacy UUID');
    assert.equal(state.sessions[0]?.practitioner_id, practitionerB);
    assert.equal(await h.page.evaluate(key => sessionStorage.getItem(key), operationAKey), operationA,
      'successful B save must not clear A scoped recovery state');
    assert.equal(await h.page.evaluate(key => sessionStorage.getItem(key), operationBKey), null,
      'verified B save clears only B scoped recovery state');
    await h.context.close();
  }

  // A late A response may prove A, but cannot clear or overwrite the active B draft.
  {
    const h = await makePage(browser, { delayedRpc: true });
    await fillSession(h.page, ' delayed-A');
    await submit(h.page);
    await h.page.waitForFunction(() => window.__calls.some(call => call.op === 'rpc'));
    await switchEncounter(h.page, 'enc-b');
    await h.page.fill('#opd-treatment-detail', 'synthetic B active draft');
    await h.page.evaluate(() => window.__releaseRpc());
    await h.page.waitForFunction(() => window.__events.some(event => event.encounterId === 'enc-a'));
    assert.equal(await h.page.inputValue('#opd-treatment-detail'), 'synthetic B active draft', 'late A completion must not affect active B');
    const state = await sessionState(h.page);
    assert.equal(state.calls.filter(call => call.op === 'rpc').length, 1);
    assert.equal(state.calls.find(call => call.op === 'rpc').payload.p_encounter_id, 'enc-a');
    assert.ok(state.events.every(event => event.encounterId === 'enc-a'));
    await h.context.close();
  }

  console.log('PASS isolated Treatment Session browser persistence: exact acknowledgement/readback, identity-scoped recovery, duplicate protection, and encounter-scoped drafts. Synthetic only; no live DB acceptance.');
} finally {
  await browser.close();
}
