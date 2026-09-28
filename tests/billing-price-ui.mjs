import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const nodes = new Map();
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector, {
    value: '', innerHTML: '', textContent: '', dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} }, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelectorAll: () => [], reset() { this.resetCount = (this.resetCount || 0) + 1; }
  });
  return nodes.get(selector);
};
const sandbox = { console, setTimeout: () => 0, clearTimeout() {}, URL, URLSearchParams,
  crypto: { randomUUID: () => 'synthetic-request-key' }, alert() {},
  // This suite isolates form behavior; real journal/SQL integration is tested separately.
  window: { addEventListener() {}, CnyosServiceInvoiceJournal:{async prepare(){return {requestId:'synthetic-request-key'};},async recover(){}}, CnyosPaymentJournal:{async prepare(){return {requestId:'synthetic-request-key'};},async recover(){}} }, document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} } };
const testSource = source.replace('  init();\n})();', `
  globalThis.hooks = {
    set(value, quotes, database) { session={user:{id:'synthetic-actor'}};profile={clinic_id:'synthetic-clinic'};Object.assign(data, value); treatmentQuotes.clear(); for (const [id,q] of quotes) treatmentQuotes.set(id,q); db=database; atomicHandoffsReady=true; },
    renderBilling, createServiceInvoice, createInvoice, savePayment,
    setAggregate(id, quote) { encounterInvoiceQuotes.set(id, quote); },
    setServiceQuote(id, quote) { treatmentQuotes.set(id, quote); },
    clearServiceQueue() { data.billableTreatmentEncounters=[];treatmentQuotes.clear(); },
    stubRefresh() { loadAll=async()=>{}; }
  };
})();`);
vm.runInNewContext(testSource, sandbox);
const hooks = sandbox.hooks;
hooks.stubRefresh();
let calls = [];
let finish;
let hold = false;
let readbackFailure = false;
let returnedBalance = 287.5;
let returnedEncounterClosed;
let invoiceKind = 'aggregate';
const database = {
  rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'issue_atomic_treatment_invoice') {
      invoiceKind = 'service';
      return { data: [{ invoice_id: 'service' }] };
    }
    if (name === 'issue_atomic_encounter_invoice') invoiceKind = 'aggregate';
    if (hold) await new Promise(resolve => { finish = resolve; });
    return { data: name === 'record_atomic_invoice_payment' ? [{ payment_id: 'payment', balance_due: returnedBalance, encounter_closed: returnedEncounterClosed }] : name === 'issue_atomic_encounter_invoice' ? [{invoice_id:'aggregate',invoice_number:'INV-1',grand_total:587.5}] : [] };
  },
  from(table) { return { select() { return this; }, eq() { return this; }, single: async () => readbackFailure ? { error: {} } : { data: table === 'invoices' ? {id:invoiceKind,encounter_id:'enc',invoice_number:'INV-1',grand_total:invoiceKind === 'service' ? 487.5 : 587.5} : { id: 'payment', invoice_id: 'invoice', amount: 200 } } }; }
};
const state = { encounters: [{ id: 'enc' }], prescriptions: [{ id: 'rx', encounter_id: 'enc' }], dispensing: [{ id: 'dispense', prescription_id: 'rx', status: 'submitted_to_billing' }], dispensingItems: [{ dispensing_order_id: 'dispense', quantity_dispensed: 1, unit_price: 100 }], billableTreatmentEncounters: [{ encounter_id: 'enc' }], invoices: [], payments: [] };
hooks.set(state, [], database);
hooks.renderBilling();
assert.match(node('#billing-queue').innerHTML, /data-action="invoice"[^>]*disabled/);
assert.match(node('#treatment-billing-queue').innerHTML, /data-action="service-invoice"[^>]*disabled/);
await assert.rejects(hooks.createServiceInvoice('enc'), /ราคากลาง/);
assert.equal(calls.length, 0);
const quote = { amount: 487.5, duration_minutes: 45, unit_price: 650, description: 'Session <45>' };
hooks.set(state, [['enc', quote]], database);
hooks.renderBilling();
assert.match(node('#treatment-billing-queue').innerHTML, /487\.50/);
assert.match(node('#treatment-billing-queue').innerHTML, /Session &lt;45&gt;/);
assert.doesNotMatch(node('#treatment-billing-queue').innerHTML, /<input/);
readbackFailure = true;
await assert.rejects(hooks.createServiceInvoice('enc'), /ตรวจอ่านกลับยังไม่สำเร็จ/);
assert.doesNotMatch(node('#toast').textContent, /สร้าง Invoice ค่าบริการแล้ว/);
const serviceRequest = calls.at(-1).args.p_request_key;
hooks.clearServiceQueue();
hooks.renderBilling();
assert.match(node('#treatment-billing-queue').innerHTML, /ตรวจผลคำขอเดิม/);
assert.match(node('#treatment-billing-queue').innerHTML, /487\.50/);
assert.doesNotMatch(node('#treatment-billing-queue').innerHTML, /สร้าง Invoice ค่าบริการ/);
hooks.setServiceQuote('enc', { ...quote, amount: 900, description: 'Changed after uncertain issue' });
readbackFailure = false;
await hooks.createServiceInvoice('enc');
assert.equal(calls.at(-1).args.p_request_key, serviceRequest);
assert.match(node('#toast').textContent, /สร้าง Invoice ค่าบริการแล้ว/);
hooks.renderBilling();
assert.doesNotMatch(node('#treatment-billing-queue').innerHTML, /ตรวจผลคำขอเดิม/);
assert.equal(calls.at(-1).args.p_amount, 487.5);
hooks.setAggregate('enc', {encounter_id:'enc',quote_fingerprint:'a'.repeat(64),medicine_total:100,service_total:487.5,grand_total:587.5,orders:[{id:'dispense',queue_number:'Q-1'}]});
await hooks.createInvoice('enc');
assert.equal(calls.at(-1).name, 'issue_atomic_encounter_invoice');
assert.equal(calls.at(-1).args.p_quote_fingerprint, 'a'.repeat(64));
assert.equal('p_service_fee' in calls.at(-1).args, false);
hooks.set({ invoices: [{ id: 'invoice', balance_due: 487.5 }] }, [], database);
node('#pay-invoice').value = 'invoice';
node('#pay-amount').value = '200';
node('#pay-channel').value = 'cash';
const form = node('#pay-form');
// Production event wiring points at #payment-form. Alias the synthetic form so
// the actual click listener gets a form, not the button as currentTarget.
nodes.set('#payment-form', form);
assert.match(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /id="payment-retry"[^>]*type="button"/);
const event = { preventDefault() {}, currentTarget: form, target: form };
hold = true;
const pending = hooks.savePayment(event);
await hooks.savePayment(event);
assert.equal(calls.filter(call => call.name === 'record_atomic_invoice_payment').length, 1);
finish();
await pending;
assert.equal(form.dataset.requestKey, undefined);
assert.match(node('#toast').textContent, /ชำระบางส่วน/);
hold = false;
readbackFailure = true;
await assert.rejects(hooks.savePayment(event), /ตรวจอ่านกลับยังไม่สำเร็จ/);
assert.equal(form.dataset.requestKey, 'synthetic-request-key', 'keep same idempotency key on uncertain readback');
node('#pay-amount').value = '900';
const beforeConflict = calls.length;
await assert.rejects(hooks.savePayment(event), /คำขอรับเงินเดิมยังไม่ยืนยัน/);
assert.equal(calls.length, beforeConflict, 'changed request must never reach the server');
node('#pay-amount').value = '200';
for (const [selector, changed, original] of [['#pay-invoice','different','invoice'], ['#pay-channel','transfer','cash'], ['#pay-note','changed','']]) {
  node(selector).value = changed;
  await assert.rejects(hooks.savePayment(event), /คำขอรับเงินเดิมยังไม่ยืนยัน/);
  assert.equal(calls.length, beforeConflict);
  node(selector).value = original;
}
// Server has already committed the payment; a refreshed balance must not block
// recovery of the same request, even if the current balance is now zero.
hooks.set({ invoices: [{ id: 'invoice', balance_due: 0 }] }, [], database);
readbackFailure = false;
const uncertainPayload = calls.at(-1).args;
node('#pay-invoice').value = '';
node('#pay-amount').value = '';
node('#pay-note').value = 'new form values must not replace the original request';
await node('#payment-retry').listeners.click();
assert.deepEqual(calls.at(-1).args, uncertainPayload);
assert.equal(form.dataset.requestKey, undefined);
assert.equal(node('#payment-recovery-message').textContent, '');
const afterRecovery = calls.length;
await node('#payment-retry').listeners.click();
assert.equal(calls.length, afterRecovery, 'retry button must not start a new payment after recovery');
console.log('Billing price UI passed: quoted treatment/Rx fees only, fail-closed missing price, payment submit guard and readback with sticky retry key');

hooks.set({ invoices: [{ id: 'invoice', balance_due: 487.5 }] }, [], database);
node('#pay-invoice').value = 'invoice';
node('#pay-amount').value = '200';
node('#pay-note').value = '';
const resetsBeforeInvalid = form.resetCount;
for (const invalid of [null, undefined, '', ' ', false, true, [], {}, -1, '-1', NaN, Infinity, 'NaN']) {
  returnedBalance = invalid;
  await assert.rejects(hooks.savePayment(event), /ยังยืนยันผลรับเงินไม่ได้/);
  assert.equal(form.resetCount, resetsBeforeInvalid, 'invalid response must not clear the form');
  assert.equal(form.dataset.requestKey, 'synthetic-request-key');
}
returnedBalance = '0.00';
await hooks.savePayment(event);
assert.equal(form.dataset.requestKey, undefined);
assert.match(node('#toast').textContent, /รับชำระครบแล้ว/);
assert.doesNotMatch(node('#toast').textContent, /ปิด Encounter/);
for (const closed of [false, 'true', true]) {
  returnedEncounterClosed = closed;
  await hooks.savePayment(event);
  if (closed === true) assert.match(node('#toast').textContent, /ปิด Encounter/);
  else assert.doesNotMatch(node('#toast').textContent, /ปิด Encounter/);
}
console.log('Payment response validation passed: malformed balances rejected; zero balance is not encounter closure without strict server confirmation');
