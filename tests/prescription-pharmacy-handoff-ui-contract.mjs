import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const clinical = read('clinical-v3.js');
const clinicalHtml = read('clinical-v3.html');
const pharmacy = read('pharmacy.js');
const pharmacyHtml = read('pharmacy.html');

assert.match(clinicalHtml, /id="rx-handoff-receipt"[^>]*role="status"/);
assert.match(clinicalHtml, /data-go-treatment/);
assert.match(clinicalHtml, /data-go-prescription/);
assert.match(clinical, /prescription_no/);
assert.match(clinical, /queue_number/);
assert.match(clinical, /dispensing_orders/);
assert.ok(clinical.includes("order('prescribed_at', { ascending: false }).limit(1)"));
assert.ok(clinical.includes('if (result.error) throw result.error'));
assert.ok(clinical.includes('prescriptionCart.length === 0'));
assert.ok(clinical.includes("setStep('prescription')"));
assert.match(clinical, /scrollIntoView/);
assert.match(clinical, /encounterLoadVersion/);
assert.match(clinical, /prescriptionCartEncounterId/);
assert.match(clinical, /prescriptionCartVersion/);
assert.match(clinical, /setPrescriptionSubmitting/);
assert.match(clinical, /currentEncounter === encounterId/);
assert.match(clinical, /prescriptionResult\.data\.prescription_no/);
assert.match(clinical, /dispensing_orders.*receipt\.dispensing_order_id/s);
assert.match(clinical, /create_atomic_prescription_handoff/);

assert.match(pharmacyHtml, /id="refresh-rx-queue"/);
assert.match(pharmacyHtml, /id="rx-refresh-status"/);
assert.match(pharmacy, /let loadPromise = null/);
assert.ok(pharmacy.includes('if (loadPromise) return loadPromise'));
assert.ok(pharmacy.includes('setTimeout(async () =>'));
assert.ok(pharmacy.includes('startQueueRefresh();'));
assert.match(pharmacy, /document.visibilityState/);
assert.match(pharmacy, /refresh-rx-queue/);
assert.match(pharmacy, /capturePrescriptionPriceDrafts/);
assert.match(pharmacy, /restorePrescriptionPriceDrafts/);

const makeElement = () => ({
  value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, scrollIntoView() {},
  focus() { this.focused = true; },
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
});

// Execute the actual clinical controller with synthetic DOM/DB fixtures. These cases
// cover the patient-bound cart and stale in-flight response guard, not only source text.
const clinicalNodes = new Map();
const clinicalElement = selector => {
  if (!clinicalNodes.has(selector)) clinicalNodes.set(selector, makeElement());
  return clinicalNodes.get(selector);
};
let confirmSwitch = false;
const clinicalErrors = [];
const clinicalSandbox = {
  console: { ...console, error: (...args) => clinicalErrors.push(args) }, URL, setTimeout, clearTimeout,
  CSS: { escape: value => String(value) },
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  location: { href: 'https://cnyos.cloud/clinical-v3.html', replace() {} },
  history: { replaceState() {} },
  matchMedia: () => ({ matches: false }),
  confirm: () => confirmSwitch,
  alert() {},
  window: { addEventListener() {}, dispatchEvent() {} },
  document: {
    querySelector: clinicalElement,
    querySelectorAll: () => [],
    activeElement: null
  }
};
const clinicalForTest = clinical.replace(
  '  init();\n})();',
  `  globalThis.__clinicalHandoffTest = {
    setState(value) {
      currentEncounter = value.currentEncounter ?? null;
      prescriptionCart = (value.cart || []).map(item => ({ ...item }));
      prescriptionCartEncounterId = value.cartEncounterId ?? null;
      prescriptionCartVersion = value.cartVersion ?? 0;
      atomicHandoffsReady = value.atomicHandoffsReady ?? true;
      encounters = value.encounters || [];
      if (value.db) db = value.db;
      $('#encounter').value = currentEncounter || '';
      $('#rx-encounter').value = value.rxEncounter ?? currentEncounter ?? '';
      renderPrescriptionCart();
    },
    forceDraft(value) {
      currentEncounter = value.currentEncounter;
      prescriptionCart = value.cart.map(item => ({ ...item }));
      prescriptionCartEncounterId = value.cartEncounterId;
      prescriptionCartVersion = value.cartVersion;
    },
    state() {
      return {
        currentEncounter,
        cart: prescriptionCart.map(item => ({ ...item })),
        cartEncounterId: prescriptionCartEncounterId,
        cartVersion: prescriptionCartVersion,
        submitting: prescriptionSubmitting,
        requestKey: $('#prescription-form').dataset.requestKey || null
      };
    },
    renderPrescriptionReceipt,
    selectEncounter,
    sendPrescription
  };
})();`
);
vm.runInNewContext(clinicalForTest, clinicalSandbox);
const clinicalHooks = clinicalSandbox.__clinicalHandoffTest;
const cartA = [{ product_id: 'product-a', product_name: 'ยา A', quantity_prescribed: 1, unit: 'เม็ด' }];
const cartB = [{ product_id: 'product-b', product_name: 'ยา B', quantity_prescribed: 2, unit: 'เม็ด' }];
const encounterRows = [{ id: 'enc-a' }, { id: 'enc-b' }];
const submitEvent = () => ({
  preventDefault() {},
  currentTarget: clinicalElement('#prescription-form'),
  target: clinicalElement('#prescription-form')
});

clinicalHooks.setState({ currentEncounter: 'enc-a', cart: cartA, cartEncounterId: 'enc-a', cartVersion: 1, encounters: encounterRows, rxEncounter: 'enc-b' });
await assert.rejects(clinicalHooks.sendPrescription(submitEvent()), /ไม่ตรงกับ Encounter/);
assert.equal(clinicalHooks.state().cartEncounterId, 'enc-a');
assert.equal(clinicalHooks.state().cart.length, 1);

clinicalHooks.setState({ currentEncounter: 'enc-a', cart: cartA, cartEncounterId: 'enc-a', cartVersion: 1, encounters: encounterRows });
confirmSwitch = false;
await clinicalHooks.selectEncounter(null);
assert.equal(clinicalHooks.state().currentEncounter, 'enc-a');
assert.equal(clinicalHooks.state().cart.length, 1);
confirmSwitch = true;
await clinicalHooks.selectEncounter(null);
assert.equal(clinicalHooks.state().currentEncounter, null);
assert.equal(clinicalHooks.state().cart.length, 0);

clinicalHooks.setState({ currentEncounter: 'enc-a', cart: [], cartEncounterId: null, cartVersion: 2, encounters: encounterRows });
clinicalHooks.renderPrescriptionReceipt(
  { prescription_no: 'RX-OLD', status: 'sent' },
  { queue_number: 'Q-OLD', status: 'waiting' }
);
assert.equal(clinicalElement('#rx-handoff-receipt').hidden, false);
await clinicalHooks.selectEncounter(null);
assert.equal(clinicalElement('#rx-handoff-receipt').hidden, true);
assert.equal(clinicalElement('#rx-handoff-receipt').innerHTML, '');

let finishRpc;
const rpcResult = new Promise(resolve => { finishRpc = resolve; });
const readback = {
  prescriptions: { id: 'rx-a', prescription_no: 'RX-A', status: 'sent' },
  dispensing_orders: { id: 'order-a', queue_number: 'Q-A', status: 'waiting' }
};
const syntheticDb = {
  rpc: () => rpcResult,
  from(table) {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle() { return Promise.resolve({ data: readback[table], error: null }); }
    };
  }
};
clinicalElement('#prescription-form').dataset = {};
clinicalHooks.setState({ currentEncounter: 'enc-a', cart: cartA, cartEncounterId: 'enc-a', cartVersion: 7, encounters: encounterRows, db: syntheticDb });
const pendingSend = clinicalHooks.sendPrescription(submitEvent());
await Promise.resolve();
assert.equal(clinicalHooks.state().submitting, true);
clinicalHooks.forceDraft({ currentEncounter: 'enc-b', cart: cartB, cartEncounterId: 'enc-b', cartVersion: 8 });
finishRpc({ data: { prescription_id: 'rx-a', dispensing_order_id: 'order-a', prescription_no: 'RX-A', queue_number: 'Q-A' }, error: null });
await assert.rejects(pendingSend, /หน้าจอเปลี่ยนระหว่างทำรายการ/);
assert.equal(clinicalHooks.state().cartEncounterId, 'enc-b');
assert.equal(clinicalHooks.state().cart[0].product_id, 'product-b');
assert.ok(clinicalHooks.state().requestKey);
assert.equal(clinicalHooks.state().submitting, false);

// Once RPC + exact readback are verified, an ancillary Encounter refresh failure
// must not claim the handoff failed or retain a retry key/cart.
const committedDb = {
  rpc: async () => ({ data: { prescription_id: 'rx-a', dispensing_order_id: 'order-a', prescription_no: 'RX-A', queue_number: 'Q-A' }, error: null }),
  from(table) {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle() { return Promise.resolve({ data: readback[table], error: null }); }
    };
  }
};
clinicalElement('#prescription-form').dataset = {};
clinicalHooks.setState({ currentEncounter: 'enc-a', cart: cartA, cartEncounterId: 'enc-a', cartVersion: 11, encounters: encounterRows, db: committedDb });
await clinicalHooks.sendPrescription(submitEvent());
assert.equal(clinicalHooks.state().cart.length, 0);
assert.equal(clinicalHooks.state().requestKey, null);
assert.equal(clinicalElement('#rx-handoff-receipt').hidden, false);
assert.match(clinicalElement('#rx-handoff-receipt').innerHTML, /RX-A/);
assert.match(clinicalElement('#toast').textContent, /ส่งใบสั่งยาสำเร็จ.*คิว Q-A.*รีเฟรชข้อมูลล่าสุดไม่สำเร็จ/);
assert.ok(clinicalErrors.length > 0);

// Execute the Pharmacy draft snapshot/restore functions. A refresh must preserve
// unsaved unit prices and keyboard focus while replacing queue DOM.
const pharmacyNodes = new Map();
const pharmacyElement = selector => {
  if (!pharmacyNodes.has(selector)) pharmacyNodes.set(selector, makeElement());
  return pharmacyNodes.get(selector);
};
let pharmacyPriceInputs = [];
const pharmacyDocument = {
  visibilityState: 'visible',
  activeElement: null,
  querySelector: pharmacyElement,
  querySelectorAll: selector => selector === '[data-rx-price]' ? pharmacyPriceInputs : [],
  addEventListener() {}
};
const pharmacySandbox = {
  console, Intl, setTimeout, clearTimeout,
  document: pharmacyDocument,
  window: {},
  location: { replace() {} },
  alert() {},
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000002' }
};
const pharmacyForTest = pharmacy.replace(
  '  init();\n})();',
  '  globalThis.__pharmacyDraftTest = { capturePrescriptionPriceDrafts, restorePrescriptionPriceDrafts };\n})();'
);
vm.runInNewContext(pharmacyForTest, pharmacySandbox);
const priceA = Object.assign(makeElement(), { value: '125.50', dataset: { rxPrice: 'item-a' } });
const priceB = Object.assign(makeElement(), { value: '', dataset: { rxPrice: 'item-b' } });
pharmacyPriceInputs = [priceA, priceB];
pharmacyDocument.activeElement = priceA;
const priceDrafts = pharmacySandbox.__pharmacyDraftTest.capturePrescriptionPriceDrafts();
const replacementA = Object.assign(makeElement(), { value: '', dataset: { rxPrice: 'item-a' } });
const replacementB = Object.assign(makeElement(), { value: '', dataset: { rxPrice: 'item-b' } });
pharmacyPriceInputs = [replacementA, replacementB];
pharmacySandbox.__pharmacyDraftTest.restorePrescriptionPriceDrafts(priceDrafts);
assert.equal(replacementA.value, '125.50');
assert.equal(replacementB.value, '');
assert.equal(replacementA.focused, true);

console.log('Prescription/pharmacy handoff UI contract passed: patient-bound cart, stale-response retention, exact readback, and refresh-safe price drafts');
