import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../opd-workflow.js', import.meta.url), 'utf8');

class Element {
  constructor(value = '') { this.value = value; this.checked = false; this.textContent = ''; this.innerHTML = ''; this.listeners = {}; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type, detail) { for (const listener of this.listeners[type] || []) listener({ target: this, detail, preventDefault() {} }); }
  reset() { this.value = ''; this.resetCount = (this.resetCount || 0) + 1; }
}

const ids = ['encounter', 'opd-history-form', 'opd-session-form', 'opd-history-status', 'opd-session-list',
  'opd-accident', 'opd-surgery', 'opd-chronic', 'opd-family', 'opd-personal', 'opd-food', 'opd-water',
  'opd-coffee', 'opd-smoking', 'opd-alcohol', 'opd-urination', 'opd-bowel', 'opd-sleep', 'opd-posture',
  'opd-emotion', 'opd-allergy', 'opd-menstruation', 'opd-meds', 'opd-physical', 'opd-treatment-detail',
  'opd-procedure-referral', 'opd-procedure-detail', 'opd-precautions', 'opd-pain-before', 'opd-pain-after',
  'opd-outcome', 'opd-advice'];
const elements = Object.fromEntries(ids.map(id => [`#${id}`, new Element()]));
const historyFields = ['#opd-accident', '#opd-surgery', '#opd-chronic', '#opd-family', '#opd-personal', '#opd-food', '#opd-water', '#opd-coffee', '#opd-smoking', '#opd-alcohol', '#opd-urination', '#opd-bowel', '#opd-sleep', '#opd-posture', '#opd-emotion', '#opd-allergy', '#opd-menstruation', '#opd-meds', '#opd-physical'];
elements['#opd-history-form'].reset = () => historyFields.forEach(selector => { elements[selector].value = ''; });
elements['#opd-session-form'].reset = () => {};
const modality = new Element(); modality.value = 'needle';
const listeners = {};
const window = {
  addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
  dispatchEvent(event) { for (const listener of listeners[event.type] || []) listener(event); }
};
class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const document = {
  readyState: 'complete',
  querySelector(selector) { return elements[selector] || null; },
  querySelectorAll(selector) { return selector === 'input[name="opd-modality"]:checked' ? [modality] : []; },
  addEventListener() {}
};

const pending = [];
const alerts = [];
const db = {
  failEncounters: new Set(),
  from(table) {
    const query = { table, encounter: null, mode: null, payload: null };
    return {
      select() { query.mode = 'select'; return this; },
      eq(_field, value) { query.encounter = value; return this; },
      maybeSingle() {
        query.mode ||= 'single';
        if (table === 'ttm_opd_histories' && db.failEncounters.has(query.encounter)) return Promise.resolve({ data: null, error: new Error('synthetic load failure') });
        if (table === 'ttm_opd_histories' && db.history.has(query.encounter)) return Promise.resolve({ data: db.history.get(query.encounter), error: null });
        if (table === 'ttm_opd_histories') return new Promise(resolve => pending.push({ query, resolve }));
        return Promise.resolve({ data: null, error: null });
      },
      order() {
        return new Promise(resolve => pending.push({ query, resolve }));
      },
      upsert(payload) { query.mode = 'upsert'; query.payload = payload; db.saved.push(payload); db.history.set(payload.encounter_id, payload); return Promise.resolve({ error: null }); }
    };
  },
  saved: [],
  history: new Map(),
  async rpc(_name, args) { db.saved.push({ encounter_id: args.p_encounter_id }); return { data: null, error: null }; }
};
function resolve(table, encounter, data) {
  const index = pending.findIndex(item => item.query.table === table && item.query.encounter === encounter);
  assert.notEqual(index, -1, `pending ${table}/${encounter}`);
  pending.splice(index, 1)[0].resolve({ data, error: null });
}
function flush() { return new Promise(resolve => setImmediate(resolve)); }

window.ChananyaRuntime = {
  getDb: () => db,
  getSession: async () => ({ user: { id: 'synthetic-user' } })
};
const context = { window, document, CustomEvent, console: { error() {}, log() {} }, alert() {} };
context.alert = message => alerts.push(message);
vm.runInNewContext(source, context, { filename: 'opd-workflow.js' });

// Selection made before OPD init is picked up from the DOM.
elements['#encounter'].value = 'enc-A';
await flush();
assert.equal(elements['#opd-history-form'].inert, true);
resolve('ttm_opd_histories', 'enc-A', { accident_history: 'A' });
resolve('clinical_treatment_sessions', 'enc-A', []);
await flush();
assert.equal(elements['#opd-history-form'].inert, false);
assert.equal(elements['#opd-accident'].value, 'A');

// A native selection followed quickly by B must not let slow A overwrite B.
elements['#encounter'].value = 'enc-X';
elements['#encounter'].dispatch('change');
resolve('ttm_opd_histories', 'enc-X', { accident_history: 'X' });
resolve('clinical_treatment_sessions', 'enc-X', []);
await flush();
elements['#encounter'].value = 'enc-A';
elements['#encounter'].dispatch('change');
elements['#encounter'].value = 'enc-B';
elements['#encounter'].dispatch('change');
resolve('ttm_opd_histories', 'enc-B', { accident_history: 'B' });
resolve('clinical_treatment_sessions', 'enc-B', []);
resolve('ttm_opd_histories', 'enc-A', { accident_history: 'STALE-A' });
resolve('clinical_treatment_sessions', 'enc-A', []);
await flush();
assert.equal(elements['#opd-accident'].value, 'B');

// Same-context clinical notifications are deduplicated; changing context clears prior fields.
const pendingBeforeDuplicate = pending.length;
elements['#opd-accident'].value = 'typed-B-draft';
window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: 'enc-B' } }));
assert.equal(pending.length, pendingBeforeDuplicate);
assert.equal(elements['#opd-accident'].value, 'typed-B-draft');

// A pending load cannot be saved under the newly selected encounter.
elements['#encounter'].value = 'enc-C';
window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: 'enc-C' } }));
assert.equal(elements['#opd-accident'].value, '');
elements['#opd-history-form'].dispatch('submit');
await flush();
assert.match(alerts.at(-1), /กำลังโหลด OPD History/);
assert.equal(db.saved.length, 0);
resolve('ttm_opd_histories', 'enc-C', { accident_history: 'C' });
resolve('clinical_treatment_sessions', 'enc-C', []);
await flush();
assert.equal(elements['#opd-accident'].value, 'C');

// Clinical selection events also synchronize, including clear selection.
elements['#encounter'].value = '';
window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: null } }));
await flush();
assert.equal(elements['#opd-history-status'].textContent, 'เลือก Encounter ก่อน');
window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: 'stale-C' } }));
assert.equal(elements['#encounter'].value, '');
assert.equal(elements['#opd-history-status'].textContent, 'เลือก Encounter ก่อน');

// A failed load also keeps saving closed until a successful readback.
db.failEncounters.add('enc-D');
elements['#encounter'].value = 'enc-D';
window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: 'enc-D' } }));
await flush();
resolve('clinical_treatment_sessions', 'enc-D', []);
assert.equal(elements['#opd-history-form'].inert, true);
elements['#opd-history-form'].dispatch('submit');
await flush();
assert.match(alerts.at(-1), /กำลังโหลด OPD History/);
assert.equal(db.saved.length, 0);

// Save captures A; changing to B while the read is in flight cannot retarget the write or event.
const changed = [];
window.addEventListener('chananya:clinical-data-changed', event => changed.push(event.detail));
elements['#encounter'].value = 'enc-A';
elements['#encounter'].dispatch('change');
resolve('ttm_opd_histories', 'enc-A', { accident_history: 'A' });
resolve('clinical_treatment_sessions', 'enc-A', []);
await flush();
elements['#opd-accident'].value = 'saved-A';
let saveResolve;
let saveGateUsed = false;
const originalMaybeSingle = db.from;
db.from = (...args) => {
  const chain = originalMaybeSingle(...args);
  if (args[0] === 'ttm_opd_histories' && !saveGateUsed) {
    saveGateUsed = true;
    chain.maybeSingle = () => new Promise(resolve => { saveResolve = () => resolve({ data: null, error: null }); });
  }
  return chain;
};
const savePromise = (async () => elements['#opd-history-form'].dispatch('submit'))();
await flush();
elements['#encounter'].value = 'enc-B';
elements['#encounter'].dispatch('change');
saveResolve();
resolve('clinical_treatment_sessions', 'enc-B', []);
resolve('ttm_opd_histories', 'enc-B', { accident_history: 'B' });
await savePromise;
await flush();
assert.equal(db.saved.at(-1).encounter_id, 'enc-A');
assert.equal(db.saved.at(-1).accident_history, 'saved-A');
assert.equal(changed.at(-1).encounterId, 'enc-A');

// The saved value is read back when returning to A for a subsequent edit.
elements['#encounter'].value = 'enc-A';
elements['#encounter'].dispatch('change');
resolve('clinical_treatment_sessions', 'enc-A', []);
await flush();
assert.equal(elements['#opd-accident'].value, 'saved-A');

// A subsequent edit remains scoped to A and is read back after another context switch.
elements['#opd-accident'].value = 'saved-A-edit';
elements['#opd-history-form'].dispatch('submit');
await flush();
assert.equal(db.saved.at(-1).encounter_id, 'enc-A');
assert.equal(db.saved.at(-1).accident_history, 'saved-A-edit');
elements['#encounter'].value = 'enc-B';
elements['#encounter'].dispatch('change');
resolve('ttm_opd_histories', 'enc-B', { accident_history: 'B' });
resolve('clinical_treatment_sessions', 'enc-B', []);
await flush();
elements['#encounter'].value = 'enc-A';
elements['#encounter'].dispatch('change');
resolve('clinical_treatment_sessions', 'enc-A', []);
await flush();
assert.equal(elements['#opd-accident'].value, 'saved-A-edit');
assert.equal(pending.length, 0, pending.map(item => `${item.query.table}/${item.query.encounter}`).join(','));

// Independent empty-init case: a later clinical event initializes the workflow from the DOM.
const lateElements = Object.fromEntries(ids.map(id => [`#${id}`, new Element()]));
lateElements['#opd-history-form'].reset = () => {};
lateElements['#opd-session-form'].reset = () => {};
const lateWindow = { listeners: {}, addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }, dispatchEvent(event) { for (const listener of this.listeners[event.type] || []) listener(event); } };
const lateDocument = { readyState: 'complete', querySelector(selector) { return lateElements[selector] || null; }, querySelectorAll() { return []; }, addEventListener() {} };
const lateDb = { from(table) { const chain = { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: table === 'ttm_opd_histories' ? { accident_history: 'late-A' } : null, error: null }); }, order() { return Promise.resolve({ data: [], error: null }); }, upsert() { return Promise.resolve({ error: null }); } }; return chain; }, async rpc() { return { error: null }; } };
lateWindow.ChananyaRuntime = { getDb: () => lateDb, getSession: async () => ({ user: { id: 'late-user' } }) };
vm.runInNewContext(source, { window: lateWindow, document: lateDocument, CustomEvent, console: { error() {}, log() {} }, alert() {} }, { filename: 'opd-workflow-empty-init.js' });
await flush();
lateElements['#encounter'].value = 'late-A';
lateWindow.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: 'late-A' } }));
await flush();
assert.equal(lateElements['#opd-accident'].value, 'late-A');

console.log('opd encounter sync contract: ok');
