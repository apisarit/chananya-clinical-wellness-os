// Actual app recovery handler + journal; synthetic read API. No payment writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const actorId='ab000000-0000-4000-8000-000000000001',clinicId='00000000-0000-0000-0000-000000000001';
const invoiceId='ab000000-0000-4000-8000-000000000002',patientId='ab000000-0000-4000-8000-000000000003';
const records=new Map(),nodes=new Map();
const storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
const node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){}});return nodes.get(s);};
const context={console,crypto:webcrypto,TextEncoder,sessionStorage:storage,setTimeout:()=>0,clearTimeout(){},URL,URLSearchParams,
  window:{addEventListener(){},ChananyaRuntime:{can:()=>true}},document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../payment-journal.js',import.meta.url),'utf8'),context);
const marker=await context.window.CnyosPaymentJournal.prepare({actorId,clinicId,payload:{p_invoice_id:invoiceId,p_amount:50,p_channel:'cash',p_reference_note:null}});
let failRead=true,reads=0,writes=0;
const payment={id:'ab000000-0000-4000-8000-000000000004',invoice_id:invoiceId,request_key:marker.requestId,received_by:actorId,
  provider:'manual',status:'paid',amount:50,payment_reference:'PAY-TEST',paid_at:'2026-09-27T01:00:00Z',channel:'cash',gateway_transaction_id:null};
const database={rpc(){writes++;throw new Error('Unexpected write');},from(table){return {select(){return this;},eq(field,id){this.field=field;this.id=id;return this;},async single(){
  reads++;
  if(failRead)return {error:{message:'Synthetic read failed'}};
  const expected={payments:['request_key',marker.requestId,payment],invoices:['id',invoiceId,{id:invoiceId,patient_id:patientId}],patients:['id',patientId,{id:patientId,clinic_id:clinicId}]}[table];
  assert.equal(this.field,expected[0]);assert.equal(this.id,expected[1]);return {data:expected[2]};
}};}};
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
vm.runInContext(source.replace('  init();\n})();',`
globalThis.hooks={setup(database){db=database;session={user:{id:'${actorId}'}};profile={clinic_id:'${clinicId}'};loadAll=async()=>{};restoreSavedPayment();},failRefresh(){loadAll=async()=>{throw new Error('Synthetic refresh failure');};},savePayment,recoverSavedPayment,pending:()=>savedPaymentMarker};
})();`),context);
context.hooks.setup(database);
assert.ok(context.hooks.pending());
assert.match(node('#payment-recovery-message').textContent,/ก่อนโหลดหน้า/);
await assert.rejects(context.hooks.savePayment({preventDefault(){}},false),/ค้างตรวจผล/);
assert.equal(writes,0);assert.equal(reads,0);
await assert.rejects(context.hooks.recoverSavedPayment(),/ห้ามรับเงินซ้ำ/);
assert.ok(context.hooks.pending());assert.equal(records.size,1);
failRead=false;
context.hooks.failRefresh();
await context.hooks.savePayment({preventDefault(){}},true);
assert.equal(writes,0);assert.equal(reads,4);
assert.equal(context.hooks.pending(),null);assert.equal(records.size,0);
assert.match(node('#toast').textContent,/ไม่มีการรับเงินซ้ำ/);
assert.match(node('#toast').textContent,/โหลดหน้ารายการไม่สำเร็จ/);
console.log('Payment reload UI passed: restored marker blocks new payment, failed read preserves uncertainty, recovery reads payment/invoice/clinic and clears only verified identity; zero write RPCs.');
