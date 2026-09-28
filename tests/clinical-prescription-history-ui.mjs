import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clinical = fs.readFileSync(new URL('../clinical-v3.js', import.meta.url), 'utf8');

const makeElement = () => ({
  value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, scrollIntoView() {}, focus() {}, reset() {}, append() {}
});

const nodes = new Map();
const element = selector => {
  if (!nodes.has(selector)) nodes.set(selector, makeElement());
  return nodes.get(selector);
};

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const baseRows = {
  clinical_examination_findings: [],
  ttm_structured_diagnoses: null,
  clinical_treatment_plans: null,
  body_pain_points: [],
  ttm_opd_histories: null,
  clinical_treatment_sessions: [],
  clinical_record_signoffs: null
};

function makeDb({ prescriptions = {}, orders = [], prescriptionError = null, orderError = null, delayedPrescriptions = null } = {}) {
  function resultFor(state) {
    if (state.table === 'prescriptions') {
      if (prescriptionError) return Promise.resolve({ data: null, error: prescriptionError });
      const encounterId = state.eq.encounter_id;
      if (delayedPrescriptions && encounterId === delayedPrescriptions.encounterId) {
        return delayedPrescriptions.gate.promise.then(() => ({ data: prescriptions[encounterId] || [], error: null }));
      }
      return Promise.resolve({ data: prescriptions[encounterId] || [], error: null });
    }
    if (state.table === 'dispensing_orders') {
      if (orderError) return Promise.resolve({ data: null, error: orderError });
      const ids = new Set(state.inValues.prescription_id || []);
      return Promise.resolve({ data: orders.filter(item => ids.has(item.prescription_id)), error: null });
    }
    const data = baseRows[state.table] ?? [];
    return Promise.resolve({ data, error: null });
  }
  return {
    from(table) {
      const state = { table, eq: {}, inValues: {} };
      const chain = {
        select() { return this; },
        eq(column, value) { state.eq[column] = value; return this; },
        in(column, values) { state.inValues[column] = values; return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() { return resultFor(state); },
        then(resolve, reject) { return resultFor(state).then(resolve, reject); }
      };
      return chain;
    }
  };
}

const sandbox = {
  console,
  URL,
  setTimeout,
  clearTimeout,
  CSS: { escape: value => String(value) },
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  location: { href: 'https://cnyos.cloud/clinical-v3.html', replace() {} },
  history: { replaceState() {} },
  matchMedia: () => ({ matches: false }),
  confirm: () => true,
  alert() {},
  window: { addEventListener() {}, dispatchEvent() {} },
  document: { createElement: makeElement, querySelector: element, querySelectorAll: () => [], activeElement: null }
};

const source = clinical.replace(
  '  init();\n})();',
  `  globalThis.__clinicalHistoryTest = {
    setState(value) {
      currentEncounter = value.currentEncounter ?? null;
      db = value.db;
    },
    loadEncounter,
    renderPrescriptionReceipt
  };
})();`
);
vm.runInNewContext(source, sandbox);
const hooks = sandbox.__clinicalHistoryTest;

const firstRows = [
  { id: 'rx-a', prescription_no: 'RX-A', status: 'sent' },
  { id: 'rx-b', prescription_no: 'RX-B<script>alert(1)</script>', status: 'queued' }
];
const firstOrders = [
  { id: 'order-a', prescription_id: 'rx-a', queue_number: 'Q-A', status: 'waiting' },
  { id: 'order-b', prescription_id: 'rx-b', queue_number: 'Q-B<img src=x>', status: 'review' }
];

hooks.setState({
  currentEncounter: 'enc-a',
  db: makeDb({ prescriptions: { 'enc-a': firstRows }, orders: firstOrders })
});
await hooks.loadEncounter();
const historyMarkup = element('#rx-handoff-receipt').innerHTML;
assert.match(historyMarkup, /RX-A/);
assert.match(historyMarkup, /Q-A/);
assert.match(historyMarkup, /RX-B/);
assert.match(historyMarkup, /Q-B/);
assert.doesNotMatch(historyMarkup, /<script>|<img/);
assert.match(historyMarkup, /สถานะใบสั่งยา/);
assert.match(historyMarkup, /สถานะคิว/);

// A slow response for an old encounter must never replace the currently
// selected encounter's empty state.
const gate = deferred();
hooks.setState({
  currentEncounter: 'enc-a',
  db: makeDb({
    prescriptions: { 'enc-a': firstRows, 'enc-b': [] },
    orders: firstOrders,
    delayedPrescriptions: { encounterId: 'enc-a', gate }
  })
});
const staleLoad = hooks.loadEncounter();
hooks.setState({ currentEncounter: 'enc-b', db: makeDb({ prescriptions: { 'enc-b': [] } }) });
await hooks.loadEncounter();
gate.resolve();
await staleLoad;
assert.match(element('#rx-handoff-receipt').innerHTML, /ยังไม่มีใบสั่งยา/);
assert.doesNotMatch(element('#rx-handoff-receipt').innerHTML, /RX-A|Q-A/);

// A prescription read with no order is not reported as delivered.
hooks.setState({
  currentEncounter: 'enc-a',
  db: makeDb({ prescriptions: { 'enc-a': [{ id: 'rx-missing', prescription_no: 'RX-MISSING', status: 'sent' }] } })
});
await hooks.loadEncounter();
assert.match(element('#rx-handoff-receipt').innerHTML, /ไม่พบคิวห้องยา/);
assert.doesNotMatch(element('#rx-handoff-receipt').innerHTML, /ส่งห้องยาแล้ว/);

// An order read failure is explicit and cannot claim delivery.
hooks.setState({
  currentEncounter: 'enc-a',
  db: makeDb({
    prescriptions: { 'enc-a': [{ id: 'rx-error', prescription_no: 'RX-ERROR', status: 'sent' }] },
    orderError: new Error('synthetic order read failure')
  })
});
await assert.rejects(hooks.loadEncounter(), /synthetic order read failure/);
assert.match(element('#rx-handoff-receipt').innerHTML, /โหลดประวัติใบสั่งยา\/คิวห้องยาไม่สำเร็จ/);
assert.doesNotMatch(element('#rx-handoff-receipt').innerHTML, /ส่งห้องยาแล้ว/);

hooks.setState({
  currentEncounter: 'enc-a',
  db: makeDb({ prescriptionError: new Error('synthetic prescription read failure') })
});
await assert.rejects(hooks.loadEncounter(), /synthetic prescription read failure/);
assert.match(element('#rx-handoff-receipt').innerHTML, /โหลดประวัติใบสั่งยา\/คิวห้องยาไม่สำเร็จ/);
assert.doesNotMatch(element('#rx-handoff-receipt').innerHTML, /ส่งห้องยาแล้ว/);

// The single-row renderer remains the post-submit receipt contract.
hooks.renderPrescriptionReceipt(
  { prescription_no: 'RX-LATEST', status: 'sent' },
  { queue_number: 'Q-LATEST', status: 'waiting' }
);
assert.match(element('#rx-handoff-receipt').innerHTML, /RX-LATEST/);
assert.match(element('#rx-handoff-receipt').innerHTML, /Q-LATEST/);

console.log('Clinical prescription history UI regression passed: all orders, escaped output, stale isolation, and explicit missing/error states');
