// Actual clinical controller with a captured worklist view boundary.
// Read-only synthetic RPC/DOM fixtures; not a live database or full-browser proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../clinical-v3.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.listeners = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ target: this, currentTarget: this, preventDefault() {} }); }
  setAttribute() {}
  replaceChildren() { this.innerHTML = ''; }
  scrollIntoView() {}
  reset() {}
}
async function harness({ allowed = true, signedIn = true, selected = 'A' } = {}) {
  const elements = new Map(); const events = {}; const calls = []; const alerts = [];
  const node = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const location = { href: `https://synthetic.invalid/clinical-v3.html?step=history${selected ? `&encounter=${selected}` : ''}`, replace: url => { location.href = url; } };
  const records = {
    patients: [{ id: 'patient-a', hn: 'SYN-A', first_name: 'Synthetic', last_name: 'A' }],
    products: [{ id: 'synthetic-product', name_th: 'Synthetic product', dispense_unit: 'unit' }],
    encounters: [{ id: 'A', encounter_no: 'SYN-ENC-A', patient_id: 'patient-a', chief_complaint: 'Synthetic complaint', status: 'draft', started_at: '2026-10-01T03:00:00Z' }]
  };
  let failure = null; let capture; let destroyed = false; let mounts = 0; let authRead = null;
  const auth = { signedIn, allowed, userId: 'synthetic-practitioner', clinicId: 'synthetic-clinic' };
  const updates = [];
  const db = {
    from(table) {
      const call = { table, columns: null, filters: [], limit: null }; calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(...args) { call.filters.push(args); return query; },
        order() { return query; }, limit(value) { call.limit = value; return query; },
        maybeSingle: async () => ({ data: null, error: failure }),
        then(resolve, reject) { return Promise.resolve({ data: Object.hasOwn(records, table) ? records[table] : [], error: failure }).then(resolve, reject); },
        insert() { throw new Error('UNEXPECTED_WRITE'); }, update() { throw new Error('UNEXPECTED_WRITE'); }, delete() { throw new Error('UNEXPECTED_WRITE'); }
      }; return query;
    },
    async rpc(name) { assert.ok(name.endsWith('healthcheck'), `Unexpected RPC ${name}`); return { data: [{ ready: true }], error: null }; }
  };
  const window = {
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    ChananyaClinicalWorklist: { mount(options) { capture = options; mounts++; destroyed = false; return {
      update(snapshot) { updates.push(snapshot); }, loading() {}, failure() {},
      async refresh() { try { updates.push(await options.onRefresh()); } catch {} }, destroy() { destroyed = true; }
    }; } },
    ChananyaRuntime: { getDb: () => db,
      getSession: async () => authRead ? authRead : auth.signedIn ? { user: { id: auth.userId } } : null,
      getProfile: async () => ({ role: auth.allowed ? 'practitioner' : 'reception', clinic_id: auth.clinicId }), can: () => auth.allowed },
    ChananyaShell: { mount() {} }
  };
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  vm.runInNewContext(source, {
    window, document: { querySelector: selector => selector.startsWith('#') ? node(selector.slice(1)) : null, querySelectorAll: () => [], createElement: () => new Element() },
    location, history: { replaceState(_a, _b, url) { location.href = String(url); } }, URL, CustomEvent,
    CSS: { escape: value => value }, matchMedia: () => ({ matches: false }), crypto: { randomUUID: () => 'synthetic-key' },
    setTimeout() { return 1; }, clearTimeout() {}, console: { error() {}, warn() {} }, alert: message => alerts.push(message), confirm: () => true
  }, { filename: 'clinical-v3.js' });
  await flush(); await flush();
  return { node, calls, records, updates, location, alerts, window, auth,
    get mount() { return capture; }, get mounts() { return mounts; }, get destroyed() { return destroyed; },
    set failure(value) { failure = value; }, set authRead(value) { authRead = value; } };
}

for (const options of [{ allowed: false }, { signedIn: false }]) {
  const h = await harness(options);
  assert.equal(h.mount, undefined, 'unauthorized/sessionless worklist never mounts');
  assert.equal(h.calls.length, 0, 'no clinical table reads before authorization');
}
console.log('PASS denied role / missing session: no worklist or clinical reads');

const h = await harness();
assert.ok(h.mount, 'authorized controller mounts actual worklist boundary');
assert.ok(h.updates.some(snapshot => snapshot.encounters.some(row => row.id === 'A')), 'editor initial read feeds worklist');
assert.equal(h.node('encounter').value, 'A');
h.node('opd-chief').value = 'UNSAVED SYNTHETIC HISTORY';
h.node('plan-goal1').value = 'UNSAVED SYNTHETIC PLAN';
h.node('rx-product').value = 'synthetic-product'; h.node('rx-qty').value = '2';
h.node('prescription-item-form').dispatch('submit');
assert.match(h.node('rx-cart').innerHTML, /Synthetic product/);
const before = { url: h.location.href, selector: h.node('encounter').value, cart: h.node('rx-cart').innerHTML };
h.calls.length = 0;
h.records.encounters = [...h.records.encounters, { ...h.records.encounters[0], id: 'B', encounter_no: 'SYN-ENC-B' }];
const refreshed = await h.mount.onRefresh();
assert.equal(refreshed.encounters.length, 2);
assert.deepEqual(h.calls.map(call => call.table).sort(), ['encounters', 'patients']);
assert.equal(h.calls.find(call => call.table === 'encounters').limit, 250);
assert.equal(h.calls.find(call => call.table === 'patients').limit, 500);
assert.doesNotMatch(h.calls.find(call => call.table === 'patients').columns, /\*/);
assert.equal(h.calls.find(call => call.table === 'patients').columns, 'id,hn,prefix,first_name,last_name', 'only schema-backed identity columns');
assert.equal(h.node('opd-chief').value, 'UNSAVED SYNTHETIC HISTORY');
assert.equal(h.node('plan-goal1').value, 'UNSAVED SYNTHETIC PLAN');
assert.deepEqual({ url: h.location.href, selector: h.node('encounter').value, cart: h.node('rx-cart').innerHTML }, before);
console.log('PASS read-only refresh: new row returned; current encounter, notes, URL and prescription draft preserved');

h.records.encounters = null;
await assert.rejects(() => h.mount.onRefresh(), /WORKLIST_RESPONSE_INVALID/, 'malformed response is not an empty successful list');
h.failure = { code: '42501', message: 'synthetic access denied' };
await assert.rejects(() => h.mount.onRefresh(), 'denied refresh must not resolve with empty success');
assert.equal(h.node('rx-cart').innerHTML, before.cart);
h.window.dispatchEvent({ type: 'pagehide' });
assert.equal(h.destroyed, true, 'page exit destroys worklist lifecycle');
console.log('PASS failed refresh remains failure; page exit disposes worklist');

h.failure = null;
h.records.encounters = [{ id: 'B', patient_id: 'patient-a', encounter_no: 'SYN-ENC-B' }];
h.calls.length = 0;
h.window.dispatchEvent({ type: 'pageshow', persisted: true });
await flush(); await flush();
assert.equal(h.mounts, 2, 'restored page remounts after authorization');
assert.equal(h.updates.at(-1).encounters[0].id, 'B', 'restoration reads fresh data, not cached snapshot');
assert.deepEqual(h.calls.map(call => call.table).sort(), ['encounters', 'patients']);
assert.equal(h.node('opd-chief').value, 'UNSAVED SYNTHETIC HISTORY');
assert.equal(h.node('plan-goal1').value, 'UNSAVED SYNTHETIC PLAN');
assert.deepEqual({ url: h.location.href, selector: h.node('encounter').value, cart: h.node('rx-cart').innerHTML }, before);
h.window.dispatchEvent({ type: 'pagehide' });
assert.equal(h.destroyed, true, 'repeated exit also destroys restored worklist');
console.log('PASS browser-cache restore revalidates access and reads only the worklist, preserving unsaved editor');

for (const change of [{ signedIn: false }, { allowed: false }, { userId: 'synthetic-other-user' }, { clinicId: 'synthetic-other-clinic' }, { clinicId: null }]) {
  const denied = await harness();
  denied.window.dispatchEvent({ type: 'pagehide' });
  Object.assign(denied.auth, change);
  denied.calls.length = 0;
  denied.window.dispatchEvent({ type: 'pageshow', persisted: true });
  await flush(); await flush();
  assert.equal(denied.mounts, 1, 'changed/denied context cannot restore worklist');
  assert.equal(denied.calls.length, 0, 'denied restoration cannot read clinical rows');
  assert.match(denied.node('worklist-feedback').textContent, /ยืนยันสิทธิ์/);
}
const late = await harness();
late.window.dispatchEvent({ type: 'pagehide' });
let release;
late.authRead = new Promise(resolve => { release = resolve; });
late.window.dispatchEvent({ type: 'pageshow', persisted: true });
late.window.dispatchEvent({ type: 'pagehide' });
late.calls.length = 0;
release({ user: { id: late.auth.userId } });
await flush(); await flush();
assert.equal(late.mounts, 1, 'late authorization cannot remount a departed page');
assert.equal(late.calls.length, 0);
console.log('PASS changed/revoked session, clinic and late authorization stay denied on restore');
console.log('Clinical worklist integration passed. Synthetic controller boundary only; actual view/browser proof is separate.');
