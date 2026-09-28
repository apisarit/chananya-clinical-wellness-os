import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source=fs.readFileSync(new URL('../payment-journal.js',import.meta.url),'utf8');
const storage=new Map();
const adapter={getItem:key=>storage.has(key)?storage.get(key):null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
function boot(){const context={window:{},crypto:webcrypto,TextEncoder,sessionStorage:adapter};vm.runInNewContext(source,context);return context.window.CnyosPaymentJournal;}
const actorId='ab000000-0000-4000-8000-000000000001',clinicId='ab000000-0000-4000-8000-000000000002';
const payload={p_invoice_id:'ab000000-0000-4000-8000-000000000003',p_amount:50,p_channel:'cash',p_reference_note:'PRIVATE synthetic note'};
const args={actorId,clinicId,payload};
const seededClinic='00000000-0000-0000-0000-000000000001';
assert.equal((await boot().prepare({...args,clinicId:seededClinic})).clinicId,seededClinic);
storage.clear();
for(const amount of [0,-1,NaN,Infinity,'50',0.001,10000001])await assert.rejects(boot().prepare({...args,payload:{...payload,p_amount:amount}}),/DRAFT_INVALID/);
const first=await boot().prepare(args);
const rebooted=boot();
assert.equal(rebooted.restore(args).requestId,first.requestId);
assert.equal((await rebooted.prepare(args)).requestId,first.requestId);
assert.equal((await rebooted.prepare({...args,expectedRequestId:first.requestId})).requestId,first.requestId);
await assert.rejects(rebooted.prepare({...args,expectedRequestId:actorId}),/JOURNAL_CHANGED/);
await assert.rejects(rebooted.prepare({...args,expectedRequestId:first.requestId,payload:{...payload,p_amount:51}}),/OUTCOME_UNRESOLVED/);
assert.doesNotMatch([...storage.values()].join(),/PRIVATE|p_amount|p_channel|reference_note/);
await assert.rejects(rebooted.prepare({...args,payload:{...payload,p_amount:51}}),/OUTCOME_UNRESOLVED/);
await assert.rejects(rebooted.prepare({...args,payload:{...payload,p_reference_note:'changed'}}),/OUTCOME_UNRESOLVED/);
assert.equal(rebooted.restore({...args,actorId:'ab000000-0000-4000-8000-000000000004'}),null);
assert.equal(rebooted.restore({...args,clinicId:'ab000000-0000-4000-8000-000000000005'}),null);
const key=[...storage.keys()][0];
for(const invalid of ['', '{}',JSON.stringify({...first,extra:'untrusted'}),JSON.stringify({...first,actorId:clinicId})]) {
  storage.set(key,invalid);
  assert.throws(()=>rebooted.restore(args),/JOURNAL_INVALID/);
  await assert.rejects(rebooted.prepare(args),/JOURNAL_INVALID/);
  assert.equal(storage.get(key),invalid,'must not overwrite damaged evidence');
}
storage.clear();
await assert.rejects(boot().prepare({...args,expectedRequestId:first.requestId}),/JOURNAL_CHANGED/);
assert.equal(storage.size,0,'explicit retry must never allocate a new identity when the old marker is missing');
const concurrent=await Promise.all([boot().prepare(args),boot().prepare(args)]);
assert.equal(concurrent[0].requestId,concurrent[1].requestId);
await assert.rejects(boot().prepare({...args,storage:{getItem:()=>null,setItem(){throw new Error('storage denied');}}}),/storage denied/);
await assert.rejects(boot().prepare({...args,storage:{getItem:()=>null,setItem(){}}}),/JOURNAL_UNAVAILABLE/);
assert.equal(rebooted.discard,undefined);
const current=concurrent[0];
const payment={id:'ab000000-0000-4000-8000-000000000006',request_key:current.requestId,invoice_id:payload.p_invoice_id,
  received_by:actorId,provider:'manual',status:'paid',amount:'50.00',payment_reference:'PAY-SYNTHETIC',paid_at:'2026-09-27T01:00:00Z',
  channel:'cash',gateway_transaction_id:payload.p_reference_note};
const recoverArgs={actorId,clinicId,isCurrent:()=>true,readPayment:async marker=>{
  assert.equal(marker.requestId,current.requestId);return {clinicId,payment};
}};
for(const patch of [{id:'invalid'},{request_key:actorId},{invoice_id:actorId},{received_by:clinicId},{provider:'gateway'},
  {status:'pending'},{amount:51},{amount:true},{amount:'5e1'},{payment_reference:''},{paid_at:'bad'},
  {channel:'card'},{gateway_transaction_id:'different'}]) {
  await assert.rejects(boot().recover({...recoverArgs,readPayment:async()=>({clinicId,payment:{...payment,...patch}})}),/READBACK_MISMATCH/);
  assert.equal(boot().restore(args).requestId,current.requestId);
}
await assert.rejects(boot().recover({...recoverArgs,readPayment:async()=>({clinicId:actorId,payment})}),/READBACK_MISMATCH/);
await assert.rejects(boot().recover({...recoverArgs,readPayment:async()=>null}),/READBACK_MISMATCH/);
let active=true;
await assert.rejects(boot().recover({...recoverArgs,isCurrent:()=>active,readPayment:async()=>{active=false;return {clinicId,payment};}}),/CONTEXT_CHANGED/);
assert.equal(boot().restore(args).requestId,current.requestId);
await assert.rejects(boot().recover({...recoverArgs,storage:{...adapter,removeItem(){}}}),/JOURNAL_UNAVAILABLE/);
assert.equal((await boot().recover(recoverArgs)).id,payment.id);
assert.equal(boot().restore(args),null);
await assert.rejects(boot().recover(recoverArgs),/JOURNAL_MISSING/);
console.log('Payment metadata journal passed: reload identity, changed draft denial, actor/clinic isolation, corrupt-marker preservation and storage fail-closed. Unit coverage; Billing integration tested separately.');
console.log('Payment recovery receipt verification passed: exact readback and current-context checks required before clearing; mismatches preserve uncertainty. Synthetic read adapter only.');
