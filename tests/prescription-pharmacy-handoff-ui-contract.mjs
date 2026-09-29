import assert from 'node:assert/strict';
import './pharmacy-refresh-ordering.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

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
assert.ok(clinical.includes("order('prescribed_at', { ascending: false })"));
assert.ok(!clinical.includes("order('prescribed_at', { ascending: false }).limit(1)"), 'clinical history must not hide older prescriptions');
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
assert.match(pharmacy, /productPrices = new Map/);
assert.match(pharmacy, /CnyosPriceMaster\.productQuotes/);

const makeElement = () => ({
  children: [], setAttribute() {}, showModal() {}, remove() {},
  value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, scrollIntoView() {}, append(child) { this.children.push(child); },
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
    body: makeElement(),
    createElement: makeElement,
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
      if (value.session) session = value.session;
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
    setRefresh(callback) { loadEncounter = callback; },
    selectEncounter,
    openReplacementDraft,
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

// A successful full refresh must not be overwritten by the latest single receipt.
clinicalHooks.setRefresh(async () => clinicalHooks.renderPrescriptionReceipt(
  [{id:'rx-old',prescription_no:'RX-OLDER',status:'sent'}, readback.prescriptions],
  [{id:'order-old',prescription_id:'rx-old',queue_number:'Q-OLDER',status:'waiting'},
   {...readback.dispensing_orders,prescription_id:'rx-a'}]
));
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:12,encounters:encounterRows,db:committedDb});
await clinicalHooks.sendPrescription(submitEvent());
assert.match(clinicalElement('#rx-handoff-receipt').innerHTML,/RX-OLDER/);
assert.match(clinicalElement('#rx-handoff-receipt').innerHTML,/Q-OLDER/);
assert.match(clinicalElement('#rx-handoff-receipt').innerHTML,/RX-A/);

// A billed Encounter is a definitive business rejection, not a network retry.
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:13,encounters:encounterRows,
  db:{rpc:async()=>({error:{message:'PRESCRIPTION_ENCOUNTER_ALREADY_BILLED'}})}});
await assert.rejects(clinicalHooks.sendPrescription(submitEvent()), /ออกบิลแล้ว.*ประสานฝ่ายการเงิน/);
assert.equal(clinicalHooks.state().cart.length, cartA.length, 'rejected draft remains available');
assert.equal(clinicalHooks.state().submitting, false);

// Execute the Pharmacy renderer with actual quote validation. Manual price drafts
// no longer exist; missing/wrong-unit prices block dispensing instead.
const pharmacyNodes = new Map();
const pharmacyElement = selector => {
  if (!pharmacyNodes.has(selector)) pharmacyNodes.set(selector, makeElement());
  return pharmacyNodes.get(selector);
};
const pharmacyDocument = {
  visibilityState: 'visible',
  activeElement: null,
  querySelector: pharmacyElement,
  querySelectorAll: () => [],
  addEventListener() {}
};
const pharmacySandbox = {
  console, Intl, setTimeout, clearTimeout,
  document: pharmacyDocument,
  window: { addEventListener() {} },
  location: { replace() {} },
  alert() {},
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000002' }
};
const pharmacyForTest = pharmacy.replace(
  '  init();\n})();',
  `  globalThis.__pharmacyPriceTest = { render(value, prices) {
    Object.assign(data, value); productPrices = new Map(prices); renderPrescriptionQueue();
  }, act, setupAction(api, refresh, pending = null) { db = api; persistenceReady = true; load = refresh; loadPromise = pending; }};\n})();`
);
vm.runInNewContext(read('price-master-client.js'), pharmacySandbox);
vm.runInNewContext(pharmacyForTest, pharmacySandbox);
const fixture = { dispensing: [{ id: 'd', prescription_id: 'rx', status: 'reviewed' }], prescriptions: [{ id: 'rx' }], prescriptionItems: [{ id: 'i', prescription_id: 'rx', product_id: 'p', quantity_prescribed: 1, unit: 'capsule' }], products: [{ id: 'p', name_th: '<script>bad</script>' }] };
pharmacySandbox.__pharmacyPriceTest.render(fixture, []);
assert.match(pharmacyElement('#rx-list').innerHTML, /data-act="rx-dispense"[^>]*disabled/);
assert.doesNotMatch(pharmacyElement('#rx-list').innerHTML, /<script>/);
pharmacySandbox.__pharmacyPriceTest.render(fixture, [['p', { unit_price: 100, unit_code: 'bottle' }]]);
assert.match(pharmacyElement('#rx-list').innerHTML, /data-act="rx-dispense"[^>]*disabled/);
pharmacySandbox.__pharmacyPriceTest.render(fixture, [['p', { unit_price: 100, unit_code: 'capsule' }]]);
assert.doesNotMatch(pharmacyElement('#rx-list').innerHTML, /data-act="rx-dispense"[^>]*disabled/);
assert.match(pharmacyElement('#rx-list').innerHTML, /100\.00/);
assert.doesNotMatch(pharmacyElement('#rx-list').innerHTML, /<input/);

for (const [status, expected] of [
  ['submitted_to_billing', /ส่งฝ่ายการเงินแล้ว.*ยังไม่ใช่การรับชำระเงิน/],
  ['billed', /ออกบิลแล้ว.*ตรวจยอดรับชำระและใบเสร็จ/]
]) {
  pharmacySandbox.__pharmacyPriceTest.render({ ...fixture, dispensing: [{ id: 'd', prescription_id: 'rx', status }] }, []);
  assert.match(pharmacyElement('#rx-list').innerHTML, expected);
  assert.doesNotMatch(pharmacyElement('#rx-list').innerHTML, /data-act="rx-billing"/);
}
let rpcCalls = 0;
pharmacySandbox.__pharmacyPriceTest.setupAction({ rpc: async (name, args) => {
  rpcCalls++;
  assert.equal(name, 'transition_atomic_prescription_dispensing');
  assert.equal(args.p_action, 'submit_billing');
  return { data: { status: 'submitted_to_billing' }, error: null };
}}, async () => { throw new Error('Synthetic refresh failure'); });
await pharmacySandbox.__pharmacyPriceTest.act('rx-billing', 'd');
assert.equal(rpcCalls, 1, 'refresh failure must not repeat the committed RPC');
assert.match(pharmacyElement('#rx-refresh-status').textContent, /ส่ง Checkout.*แล้ว.*โหลดรายการล่าสุดไม่สำเร็จ/);
assert.doesNotMatch(pharmacyElement('#rx-refresh-status').textContent, /Synthetic refresh failure/);
pharmacySandbox.__pharmacyPriceTest.setupAction({ rpc: async () => ({ error: new Error('Synthetic rejected write') }) },
  async () => { throw new Error('must not refresh rejected write'); });
await assert.rejects(pharmacySandbox.__pharmacyPriceTest.act('rx-billing', 'd'), /Synthetic rejected write/);

for (const failOldRead of [false, true]) {
  let finishOldRead;
  let freshReads = 0;
  let writes = 0;
  const pending = new Promise((resolve, reject) => { finishOldRead = () => failOldRead ? reject(new Error('old read failed')) : resolve(); });
  pharmacySandbox.__pharmacyPriceTest.setupAction({ rpc: async () => {
    writes++;
    return { error: null, data: { status: 'submitted_to_billing' } };
  } }, async () => { freshReads++; }, pending);
  const action = pharmacySandbox.__pharmacyPriceTest.act('rx-billing', 'd');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(freshReads, 0, 'must drain the pre-acknowledgement read first');
  finishOldRead();
  await action;
  assert.equal(freshReads, 1, 'fresh post-write read required even when prior read failed');
  assert.equal(writes, 1, 'refresh ordering must never replay the mutation');
}

// Exercise actual replacement dialog code, including unknown-result isolation.
delete clinicalElement('#prescription-form').dataset.requestKey;
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:50,encounters:encounterRows,session:{user:{id:'doctor'}}});
clinicalHooks.setRefresh(async()=>{});
let replacementPending=false,replacementWrites=0,replacementReads=0;
clinicalSandbox.window.CnyosReplacementAction={
  hasPending:()=>replacementPending,
  prepare:async options=>{
    assert.equal(options.actorId,'doctor');assert.equal(options.oldOrderId,'old-order');
    assert.equal(options.ticketId,'ticket');assert.equal(options.items[0].product_id,'product-a');
    replacementPending=true;
    return {
      submit:async()=>{replacementWrites++;throw Error('Synthetic lost response');},
      recover:async()=>{replacementReads++;replacementPending=false;return {new_order_id:'new-order'};}
    };
  }
};
await clinicalHooks.openReplacementDraft({ticketId:'ticket',orderId:'old-order',encounterId:'enc-a'});
const replacementDialog=clinicalSandbox.document.body.children.at(-1);
const replacementSubmit=replacementDialog.children.find(el=>el.textContent==='ยืนยันออกใบทดแทน');
const replacementRecover=replacementDialog.children.find(el=>el.textContent==='ตรวจผลคำขอเดิม');
replacementDialog.children.find(el=>el.textContent==='เหตุผลการออกใบทดแทน').children[0].value='Synthetic correction';
await replacementSubmit.onclick();
assert.equal(replacementWrites,1);
assert.equal(clinicalHooks.state().cart.length,1,'unknown result retains draft');
assert.equal(replacementRecover.hidden,false);
await assert.rejects(clinicalHooks.sendPrescription(submitEvent()),/คำขอใบทดแทน/);
await replacementRecover.onclick();
assert.equal(replacementReads,1);assert.equal(replacementWrites,1);
assert.equal(clinicalHooks.state().cart.length,0,'confirmed replacement clears only matching cart');
assert.equal(replacementSubmit.disabled,true);
// Actual controller + actual clinical dialog: definitive rejection returns to
// the unchanged cart; unlike uncertain responses it may retire its request key.
const replacementJournal=new Map();
clinicalSandbox.crypto=webcrypto;
clinicalSandbox.TextEncoder=TextEncoder;
clinicalSandbox.sessionStorage={
  get length(){return replacementJournal.size;},key:index=>[...replacementJournal.keys()][index]??null,
  getItem:key=>replacementJournal.get(key)??null,setItem:(key,value)=>replacementJournal.set(key,value),removeItem:key=>replacementJournal.delete(key)
};
vm.runInNewContext(read('replacement-action.js'),clinicalSandbox);
let deniedWrites=0;
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:51,encounters:encounterRows,
  db:{rpc:async()=>{deniedWrites++;return {error:{code:'P0001',message:'REPLACEMENT_CORRECTION_REQUIRED'}};}}});
await clinicalHooks.openReplacementDraft({ticketId:'ticket',orderId:'old-order',encounterId:'enc-a'});
const deniedDialog=clinicalSandbox.document.body.children.at(-1);
deniedDialog.children.find(el=>el.textContent==='เหตุผลการออกใบทดแทน').children[0].value='Synthetic correction';
await deniedDialog.children.find(el=>el.textContent==='ยืนยันออกใบทดแทน').onclick();
assert.equal(deniedWrites,1);
const revise=deniedDialog.children.find(el=>el.textContent==='กลับไปแก้รายการที่ถูกปฏิเสธ');
assert.equal(revise.hidden,false);
assert.equal(replacementJournal.size,1,'requires explicit correction action before removing marker');
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:51,encounters:encounterRows,session:{user:{id:'other-doctor'}}});
revise.onclick();
assert.equal(replacementJournal.size,1,'another actor must not discard the original request');
assert.ok(deniedDialog.children.some(el=>el.textContent.includes('ห้ามล้างคำขอเดิม')));
assert.equal(deniedWrites,1,'stale correction must not send another RPC');
clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:51,encounters:encounterRows,session:{user:{id:'doctor'}}});
revise.onclick();
assert.equal(replacementJournal.size,0);
assert.equal(clinicalHooks.state().cart.length,1,'rejection correction preserves clinical draft');
assert.equal(clinicalHooks.state().cart[0].product_id,'product-a');
// Context can change while asynchronous request preparation or readback waits.
for(const phase of ['prepare','submit']) {
  clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:60,encounters:encounterRows});
  let resume,submissions=0;
  const hold=new Promise(resolve=>{resume=resolve;});
  let entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  clinicalSandbox.window.CnyosReplacementAction={prepare:async()=>{
    if(phase==='prepare'){entered();await hold;}
    return {submit:async()=>{submissions++;entered();await hold;return {new_order_id:'new-order'};}};
  }};
  await clinicalHooks.openReplacementDraft({ticketId:'ticket',orderId:'old-order',encounterId:'enc-a'});
  const dialog=clinicalSandbox.document.body.children.at(-1);
  const operation=dialog.children.find(el=>el.textContent==='ยืนยันออกใบทดแทน').onclick();
  await waiting;
  clinicalHooks.forceDraft({currentEncounter:'enc-b',cart:cartB,cartEncounterId:'enc-b',cartVersion:61});
  clinicalElement('#rx-encounter').value='enc-b';
  resume();await operation;
  assert.equal(submissions,phase==='prepare'?0:1);
  assert.equal(clinicalHooks.state().cartEncounterId,'enc-b');
  assert.equal(clinicalHooks.state().cart[0].product_id,'product-b','late replacement must not clear another encounter draft');
  assert.equal(clinicalHooks.state().submitting,false);
}
// Same encounter is not sufficient: actor or cart can change during commit.
for(const outcome of ['success','error']) for(const change of ['actor','cart']) {
  clinicalHooks.setState({currentEncounter:'enc-a',cart:cartA,cartEncounterId:'enc-a',cartVersion:70,encounters:encounterRows,session:{user:{id:'doctor'}}});
  let resume,entered,refreshes=0;
  const hold=new Promise(resolve=>{resume=resolve;});
  const waiting=new Promise(resolve=>{entered=resolve;});
  clinicalHooks.setRefresh(async()=>{refreshes++;});
  clinicalSandbox.window.CnyosReplacementAction={prepare:async()=>({submit:async()=>{
    entered();await hold;
    if(outcome==='error')throw Error('old-context-private-error');
    return {new_order_id:'old-context-receipt'};
  }})};
  await clinicalHooks.openReplacementDraft({ticketId:'ticket',orderId:'old-order',encounterId:'enc-a'});
  const dialog=clinicalSandbox.document.body.children.at(-1);
  const operation=dialog.children.find(el=>el.textContent==='ยืนยันออกใบทดแทน').onclick();
  await waiting;
  clinicalHooks.setState({currentEncounter:'enc-a',cart:cartB,cartEncounterId:'enc-a',cartVersion:change==='cart'?71:70,encounters:encounterRows,session:{user:{id:change==='actor'?'other-doctor':'doctor'}}});
  resume();await operation;
  assert.equal(refreshes,0,`${change}: late success must not reload current context`);
  assert.equal(clinicalHooks.state().cart[0].product_id,'product-b');
  assert.ok(dialog.children.some(el=>el.textContent.includes('บริบทเปลี่ยนแล้ว ไม่อัปเดต')));
  assert.ok(!dialog.children.some(el=>el.textContent.includes('old-context-receipt')));
  assert.ok(!dialog.children.some(el=>el.textContent.includes('old-context-private-error')));
  assert.equal(dialog.children.find(el=>el.textContent==='ยืนยันออกใบทดแทน').disabled,true);
  assert.equal(dialog.children.find(el=>el.textContent==='ตรวจผลคำขอเดิม').disabled,true);
}
console.log('Prescription/pharmacy handoff UI contract passed: patient-bound cart, stale-response retention, exact readback, price-master-only dispensing and replacement lost-response recovery without ordinary duplicate submission');
