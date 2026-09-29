import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const nodes = new Map();
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector, {innerHTML:'',textContent:'',dataset:{},
    classList:{add(){},remove(){}},querySelectorAll:()=>[],addEventListener(){}});
  return nodes.get(selector);
};
let sequence = 0;
const otherButton = {dataset:{id:'other'},disabled:false};
const sandbox = {console,setTimeout:()=>0,clearTimeout(){},URL,URLSearchParams,
  crypto:{randomUUID:()=>`request-${++sequence}`},
  window:{addEventListener(){}},document:{querySelector:node,querySelectorAll:selector=>selector === '[data-action="invoice"]' ? [otherButton] : [],addEventListener(){}}};
vm.runInNewContext(source.replace('  init();\n})();', `
  globalThis.hooks = { renderBilling, createInvoice,
    init(state,database){Object.assign(data,state);db=database;atomicHandoffsReady=true;loadAll=async()=>{};},
    quote(id,value){encounterInvoiceQuotes.set(id,value);},
    error(id,value){encounterInvoiceQuotes.delete(id);encounterInvoiceErrors.set(id,value);},
    request(id){return encounterInvoiceRequests.get(id);}
  };
})();`), sandbox);
const h = sandbox.hooks;
const quote = {encounter_id:'enc',quote_fingerprint:'a'.repeat(64),medicine_total:300,
  service_total:650,grand_total:950,orders:[{id:'d1',queue_number:'Q-1'},{id:'d2',queue_number:'<Q-2>'}]};
let mode = 'readback-fail';
let hold;
const calls = [];
const db = {
  async rpc(name,args){
    calls.push({name,args});
    if (mode === 'hold') await new Promise(resolve=>{hold=resolve;});
    if (mode === 'stale') return {error:{message:'STALE_INVOICE_QUOTE'}};
    return {data:[{invoice_id:'inv',invoice_number:'INV-1',grand_total:950,balance_due:950}]};
  },
  from(){return {select(){return this;},eq(){return this;},async single(){
    return mode === 'readback-fail' ? {error:{message:'network'}} :
      {data:{id:'inv',encounter_id:'enc',invoice_number:'INV-1',grand_total:950}};
  } };}
};
h.init({encounters:[{id:'enc',encounter_no:'ENC-1'}],prescriptions:[
  {id:'rx1',encounter_id:'enc',status:'sent_to_pharmacy'},
  {id:'rx2',encounter_id:'enc',status:'sent_to_pharmacy'}],
  dispensing:[{id:'d1',prescription_id:'rx1',status:'submitted_to_billing'},
    {id:'d2',prescription_id:'rx2',status:'preparing'}],invoices:[],payments:[]},db);
h.error('enc','ห้องยายังส่งงานไม่ครบทุกใบสั่งยา');
h.renderBilling();
assert.equal((node('#billing-queue').innerHTML.match(/data-action="invoice"/g)||[]).length,1);
assert.match(node('#billing-queue').innerHTML,/disabled/);
await assert.rejects(h.createInvoice('enc'),/ยังไม่มีราคากลาง/);
assert.equal(calls.length,0);
h.quote('enc',{...quote,encounter_id:'another-encounter'});
await assert.rejects(h.createInvoice('enc'),/ยังไม่มีราคากลาง/);
h.quote('enc',{...quote,grand_total:1});
await assert.rejects(h.createInvoice('enc'),/ยังไม่มีราคากลาง/);
h.quote('enc',quote);
h.renderBilling();
assert.match(node('#billing-queue').innerHTML,/Q-1/);
assert.match(node('#billing-queue').innerHTML,/&lt;Q-2&gt;/);
assert.match(node('#billing-queue').innerHTML,/950\.00/);
await assert.rejects(h.createInvoice('enc'),/ตรวจอ่านกลับยังไม่สำเร็จ/);
const first = calls[0].args;
assert.equal(first.p_encounter_id,'enc');
assert.equal(first.p_quote_fingerprint,quote.quote_fingerprint);
assert.ok(h.request('enc'));
assert.match(node('#billing-queue').innerHTML,/ตรวจผลคำขอเดิม/);
assert.match(node('#billing-queue').innerHTML,/ห้ามสร้างบิลใหม่/);
// An uncertain committed request must never be silently rebound to a new quote.
h.quote('enc',{...quote,quote_fingerprint:'b'.repeat(64),medicine_total:350,grand_total:1000});
mode='hold';
const pending=h.createInvoice('enc');
await h.createInvoice('enc');
assert.equal(calls.length,2,'only one in-flight retry');
assert.deepEqual(calls[1].args,first);
hold();
await pending;
assert.equal(h.request('enc'),undefined);
assert.match(node('#toast').textContent,/ออกบิลรวม/);
// Definitive stale-quote rejection discards only that request and disables issue.
mode='stale';
await assert.rejects(h.createInvoice('enc'),/รายการหรือราคาเปลี่ยน/);
assert.equal(h.request('enc'),undefined);
assert.match(node('#billing-queue').innerHTML,/disabled/);
assert.equal(typeof otherButton.onclick,'function','rerender must rebind the other billing buttons');
console.log('Encounter invoice UI passed: grouped sources, escaped queues, incomplete blocking, exact fingerprint, sticky retry, readback and stale quote');
