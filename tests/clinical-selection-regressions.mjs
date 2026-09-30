import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const v3 = fs.readFileSync(new URL('../clinical-v3.js', import.meta.url), 'utf8');
const guard = fs.readFileSync(new URL('../clinical-context-guard.js', import.meta.url), 'utf8');
class E {
  constructor(id) { this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.listeners = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ target: this, currentTarget: this, preventDefault() {} }); }
  setAttribute() {}
  replaceChildren() { this.innerHTML = ''; }
  scrollIntoView() {}
}
class CE { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const flush = () => new Promise(resolve => setImmediate(resolve));

function v3Harness() {
  const nodes = new Map();
  const node = selector => { if (!selector.startsWith('#')) return null; const id = selector.slice(1); if (!nodes.has(id)) nodes.set(id, new E(id)); return nodes.get(id); };
  const listeners = {};
  const location = { href: 'https://local.test/clinical-v3.html?step=treatment&encounter=A' };
  const history = { replaceState(_a, _b, url) { location.href = String(url); } };
  let deferA = false; const delayedA = [];
  const rows = { patients: [{ id: 'pA', prefix: 'นพ.', first_name: 'A', last_name: 'Patient' }, { id: 'pB', prefix: 'นพ.', first_name: 'B', last_name: 'Patient' }], products: [], encounters: [{ id: 'A', encounter_no: 'ENC-A', patient_id: 'pA', chief_complaint: 'A' }, { id: 'B', encounter_no: 'ENC-B', patient_id: 'pB', chief_complaint: 'B' }] };
  function result(table, id) {
    if (deferA && id === 'A' && table !== 'encounters') return new Promise(resolve => delayedA.push(resolve));
    if (rows[table]) return { data: rows[table], error: null };
    if (table === 'ttm_structured_diagnoses') return { data: { thai_diagnosis: `${id} diagnosis` }, error: null };
    if (table === 'clinical_treatment_plans' || table === 'ttm_opd_histories' || table === 'clinical_record_signoffs') return { data: null, error: null };
    return { data: [], error: null };
  }
  const db = { from(table) { let id = null; const q = { select() { return q; }, eq(_f, value) { id = value; return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return Promise.resolve(result(table, id)); }, then(resolve, reject) { return Promise.resolve(result(table, id)).then(resolve, reject); } }; return q; }, async rpc(name) { return name.endsWith('healthcheck') ? { data: [{ ready: true }], error: null } : { data: null, error: null }; }, auth: { signOut: async () => {} } };
  const window = { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); }, ChananyaRuntime: { getDb: () => db, getSession: async () => ({ user: { id: 'u' } }), getProfile: async () => ({}), can: () => true }, ChananyaShell: { mount() {} } };
  const context = { window, document: { readyState: 'complete', querySelector: node, querySelectorAll: () => [], addEventListener() {}, createElement: id => new E(id) }, location, history, URL, CSS: { escape: x => x }, CustomEvent: CE, matchMedia: () => ({ matches: false }), crypto: { randomUUID: () => 'r' }, setTimeout, clearTimeout, console: { error() {}, log() {} }, alert() {}, confirm: () => true };
  return { context, nodes, window, location, delayedA, set deferA(value) { deferA = value; } };
}

const h = v3Harness();
vm.runInNewContext(v3, h.context, { filename: 'clinical-v3.js' });
await flush(); await flush();
assert.equal(h.nodes.get('encounter').value, 'A');
assert.match(h.location.href, /step=treatment/);
assert.match(h.nodes.get('encounter').innerHTML, /นพ\. A Patient/);
h.nodes.get('encounter').value = 'B'; h.nodes.get('encounter').dispatch('change'); await flush();
assert.match(h.location.href, /encounter=B/); assert.match(h.location.href, /step=treatment/);
h.nodes.get('encounter').value = ''; h.nodes.get('encounter').dispatch('change'); await flush();
assert.doesNotMatch(h.location.href, /encounter=/);
h.nodes.get('encounter').value = 'INVALID'; h.nodes.get('encounter').dispatch('change'); await flush();
assert.equal(h.nodes.get('encounter').value, ''); assert.doesNotMatch(h.location.href, /encounter=/);

h.deferA = true;
h.nodes.get('encounter').value = 'A'; h.nodes.get('encounter').dispatch('change');
h.nodes.get('encounter').value = 'B'; h.nodes.get('encounter').dispatch('change');
await flush(); await flush();
assert.match(h.nodes.get('diagnosis-status').innerHTML, /B diagnosis/);
for (const resolve of h.delayedA) resolve({ data: [], error: null });
await flush(); await flush();
assert.match(h.nodes.get('diagnosis-status').innerHTML, /B diagnosis/);
assert.doesNotMatch(h.nodes.get('diagnosis-status').innerHTML, /A diagnosis/);

const guardNodes = new Map(['clinical-context-guard', 'encounter', 'ccg-state', 'ccg-patient', 'ccg-demographic', 'ccg-encounter', 'ccg-encounter-meta', 'ccg-chief', 'ccg-allergies', 'ccg-redflags', 'ccg-readiness', 'ccg-allergy-box', 'ccg-redflag-box'].map(id => [id, new E(id)]));
guardNodes.get('encounter').value = 'A'; const guardEvents = {}; const guardA = [];
const guardWindow = { addEventListener(type, fn) { (guardEvents[type] ||= []).push(fn); }, dispatchEvent(event) { for (const fn of guardEvents[event.type] || []) fn(event); } };
const guardDb = { from(table) { let id = null; const q = { select() { return q; }, eq(_f, value) { id = value; return q; }, maybeSingle() { if (table === 'encounters' && id === 'A') return new Promise(resolve => guardA.push(resolve)); if (table === 'encounters') return Promise.resolve({ data: { id, encounter_no: `ENC-${id}`, patient_id: id === 'B' ? 'pB' : 'pA', chief_complaint: id }, error: null }); if (table === 'patients') { const name = id === 'pB' ? 'B' : 'A'; return Promise.resolve({ data: { id, hn: `HN-${name}`, first_name: name, last_name: 'Patient' }, error: null }); } return Promise.resolve({ data: null, error: null }); }, then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return q; } };
const guardContext = { window: guardWindow, document: { querySelector(selector) { return guardNodes.get(selector.slice(1)) || null; }, addEventListener() {} }, CustomEvent: CE, setTimeout: fn => { fn(); return 1; }, clearTimeout, console: { error() {} } };
guardWindow.ChananyaRuntime = { getDb: () => guardDb, getSession: async () => ({ user: { id: 'u' } }) };
vm.runInNewContext(guard, guardContext, { filename: 'clinical-context-guard.js' });
await flush(); guardNodes.get('encounter').value = 'B'; guardWindow.dispatchEvent(new CE('chananya:encounter-changed', { detail: { encounterId: 'B' } }));
await flush(); await flush(); for (const resolve of guardA) resolve({ data: { id: 'A', encounter_no: 'ENC-A', patient_id: 'pA', chief_complaint: 'stale' }, error: null }); await flush(); await flush();
assert.match(guardNodes.get('ccg-patient').textContent, /B Patient/); assert.doesNotMatch(guardNodes.get('ccg-patient').textContent, /A Patient/);

console.log('clinical selection regressions passed: initial URL, selection/clear, normalized name, stale Encounter and context reads');
