import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto,randomUUID} from 'node:crypto';
const window={};
vm.runInNewContext(fs.readFileSync(new URL('../amendment-journal.js',import.meta.url),'utf8'),{window,crypto:webcrypto,TextEncoder});
const journal=window.CnyosAmendmentJournal;
const entries=new Map();
const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
let valid=true;
const context={actorId:randomUUID(),clinicId:randomUUID(),storage,isCurrent:()=>valid};
const draft={...context,encounterId:randomUUID(),signoffId:randomUUID(),generation:'1',reason:'เหตุผลทดสอบ ไม่ใช่ข้อมูลผู้ป่วย'};
const marker=await journal.prepare(draft);
assert.equal((await journal.prepare(draft)).requestId,marker.requestId);
assert.ok(![...entries.values()][0].includes(draft.reason));
assert.equal(journal.restore({...context,actorId:randomUUID()}),null);
assert.equal(journal.restore({...context,clinicId:randomUUID()}),null);
assert.equal(journal.restore(context).generation,'1');
for(const delta of [{reason:'Different reason'},{encounterId:randomUUID()},{signoffId:randomUUID()},{generation:'2'}])
  await assert.rejects(journal.prepare({...draft,...delta}),/OUTCOME_UNRESOLVED/);
for(const generation of [null,0,-1,1.2,'01','1e2','9223372036854775808',9007199254740992])
  assert.throws(()=>journal.generation(generation),/GENERATION_INVALID/);
const receipt={request_id:marker.requestId,actor_id:marker.actorId,clinic_id:marker.clinicId,
  encounter_id:marker.encounterId,signoff_id:marker.signoffId,signature_generation:marker.generation,
  reason_digest:marker.reasonDigest,unlocked:true};
for(const delta of [{request_id:randomUUID()},{actor_id:randomUUID()},{clinic_id:randomUUID()},
  {encounter_id:randomUUID()},{signoff_id:randomUUID()},{signature_generation:'2'},{reason_digest:'0'.repeat(64)},{unlocked:false}]) {
  assert.throws(()=>journal.confirm(context,marker,{...receipt,...delta}),/RECEIPT_MISMATCH/);
  assert.equal(journal.restore(context).requestId,marker.requestId);
}
await assert.rejects(journal.recover({...context,readReceipt:async()=>null}),/RECEIPT_PENDING/);
assert.equal(journal.restore(context).requestId,marker.requestId);
valid=false;
await assert.rejects(journal.recover({...context,readReceipt:async()=>receipt}),/CONTEXT_CHANGED/);
valid=true;
await assert.rejects(journal.recover({...context,readReceipt:async()=>{valid=false;return receipt;}}),/CONTEXT_CHANGED/);
valid=true;
assert.equal((await journal.recover({...context,readReceipt:async requestId=>{assert.equal(requestId,marker.requestId);return receipt;}})).request_id,marker.requestId);
assert.equal(journal.restore(context),null);
await assert.rejects(journal.prepare({...draft,expectedRequestId:marker.requestId}),/JOURNAL_CHANGED/);
const rejected=await journal.prepare(draft);
assert.throws(()=>journal.reject(context,rejected,'PERMISSION_DENIED'),/REJECTION_UNVERIFIED/);
assert.equal(journal.restore(context).requestId,rejected.requestId);
journal.reject(context,rejected,'AMENDMENT_SIGNATURE_STALE');
assert.equal(journal.restore(context),null);
await assert.rejects(journal.prepare({...draft,storage:{getItem:()=>null,setItem(){throw new Error('blocked storage');}}}),/blocked storage/);
assert.equal(entries.size,0);
const changed=await journal.prepare(draft);
const originalRaw=[...entries.values()][0],originalKey=[...entries.keys()][0];
entries.set(originalKey,JSON.stringify({...JSON.parse(originalRaw),reasonDigest:[changed.reasonDigest]}));
assert.throws(()=>journal.restore(context),/JOURNAL_INVALID/);
entries.set(originalKey,originalRaw);
await assert.rejects(journal.recover({...context,readReceipt:async()=>{
  entries.clear();return {...receipt,request_id:changed.requestId};
}}),/JOURNAL_CHANGED/);
console.log('Amendment journal passed: metadata-only storage, same-key retry, scoped read-only recovery, strict receipt binding, storage/context failures and verified rejection only.');
