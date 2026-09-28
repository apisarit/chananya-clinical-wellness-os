import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = fs.readFileSync(new URL('../admin-clinical-audit.js', import.meta.url), 'utf8');
const oldId = '11111111-1111-4111-a111-111111111111';
const newId = '22222222-2222-4222-a222-222222222222';
const actorId='33333333-3333-4333-a333-333333333333';
const clinicId='44444444-4444-4444-a444-444444444444';
const signoffId='55555555-5555-4555-a555-555555555555';
const signed=()=>[{id:signoffId,record_section:'complete_record',lock_record:true,signature_generation:1,signer_name:'Synthetic signer',signed_at:'2026-09-27T00:00:00Z'}];
const journalSource=fs.readFileSync(new URL('../amendment-journal.js',import.meta.url),'utf8');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function harness(responses, rpcResponse, sharedEntries=new Map()) {
  const nodes = new Map(); let writes = 0;const calls=[];
  let authCallback;
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {value:'',innerHTML:'',textContent:''});
    return nodes.get(key);
  };
  const db = { auth:{onAuthStateChange(callback){authCallback=callback;}}, rpc(name,args) {
    calls.push({name,args});if(name==='unlock_clinical_record_for_amendment_v2')writes++;
    if(typeof rpcResponse==='function')return rpcResponse(name,args);
    if(rpcResponse)return rpcResponse;throw new Error('Unexpected RPC');
  }, from(table) {
    const response = responses[table].shift();
    assert.notEqual(response, undefined);
    return {select(){return this;},eq(){return this;},order(){return this;},maybeSingle(){return this;},
      then(resolve,reject){return Promise.resolve(response).then(resolve,reject);} };
  }};
  const storage={getItem:k=>sharedEntries.get(k)??null,setItem:(k,v)=>sharedEntries.set(k,v),removeItem:k=>sharedEntries.delete(k)};
  const sandbox = {document:{querySelector:node},window:{},console,alert(){},confirm:()=>true,crypto:webcrypto,TextEncoder,sessionStorage:storage};
  vm.runInNewContext(journalSource,sandbox);
  const instrumented = source.replace("  init().catch(error => console.error('Admin clinical audit failed', error));",
    `globalThis.hooks={search,unlock,recover,setDb(value){db=value;recoveryContext={actorId:'${actorId}',clinicId:'${clinicId}',isCurrent:()=>!accountBlocked};watchAccount('${actorId}');}};`);
  assert.notEqual(instrumented, source);
  vm.runInNewContext(instrumented,sandbox); sandbox.hooks.setDb(db);
  const marker=()=>sandbox.window.CnyosAmendmentJournal.restore({actorId,clinicId,storage});
  const receipt=()=>{const m=marker();return {request_id:m.requestId,actor_id:m.actorId,clinic_id:m.clinicId,
    encounter_id:m.encounterId,signoff_id:m.signoffId,signature_generation:m.generation,reason_digest:m.reasonDigest,unlocked:true};};
  return {...sandbox.hooks,node,writes:()=>writes,calls,marker,receipt,storage,entries:sharedEntries,auth:(event,next)=>authCallback(event,next)};
}
async function waitWrites(app,n=1){for(let i=0;i<100;i++){if(app.writes()===n)return;await new Promise(r=>setTimeout(r,2));}throw new Error('Expected write not dispatched');}
const ok = data => ({data});
const held = deferred();
const app = harness({clinical_record_signoffs:[held.promise,ok([])],
  clinical_record_audit_events:[ok([]),ok([])],
  encounters:[ok({encounter_no:'OLD'}),ok({encounter_no:'NEW'})]});
const older = app.search(oldId);
await new Promise(r=>setImmediate(r));
assert.equal(app.node('#amend-encounter').value,'');
await app.search(newId);
held.resolve(ok([])); await older;
assert.equal(app.node('#amend-encounter').value,newId);
assert.match(app.node('#audit-signoff').innerHTML,/NEW/);
assert.doesNotMatch(app.node('#audit-signoff').innerHTML,/OLD/);
app.node('#amend-encounter').value=oldId;
app.node('#amend-reason').value='Synthetic reason';
await assert.rejects(app.unlock(),/โหลดประวัติ/);
assert.equal(app.writes(),0);
for (const encounter of [ok(null),{error:new Error('synthetic failure')}]) {
  const failed=harness({clinical_record_signoffs:[ok([])],clinical_record_audit_events:[ok([])],encounters:[encounter]});
  await assert.rejects(failed.search(oldId));
  assert.equal(failed.node('#amend-encounter').value,'');
  assert.match(failed.node('#audit-signoff').textContent,/ไม่สำเร็จ/);
  failed.node('#amend-encounter').value=oldId;
  failed.node('#amend-reason').value='Synthetic reason';
  await assert.rejects(failed.unlock(),/โหลดประวัติ/);
  assert.equal(failed.writes(),0);
}
for (const [event,next] of [['SIGNED_OUT',null],['SIGNED_IN',{user:{id:'OTHER-SYN'}}]]) {
  const slow=deferred();
  const account=harness({clinical_record_signoffs:[slow.promise],clinical_record_audit_events:[ok([])],encounters:[ok({encounter_no:'STALE'})]});
  const loading=account.search(oldId);
  await new Promise(r=>setImmediate(r));
  account.auth(event,next); slow.resolve(ok([])); await loading;
  assert.equal(account.node('#amend-encounter').value,'');
  assert.equal(account.node('#amend-form').inert,true);
  assert.match(account.node('#audit-signoff').textContent,/บัญชีเปลี่ยน/);
  await assert.rejects(account.search(oldId),/บัญชีเปลี่ยน/);
  await assert.rejects(account.unlock(),/บัญชีเปลี่ยน/);
  assert.equal(account.writes(),0);
}
const committed=deferred();
const account=harness({clinical_record_signoffs:[ok(signed())],clinical_record_audit_events:[ok([])],encounters:[ok({encounter_no:'SYN'})]},committed.promise);
await account.search(oldId);
account.auth('TOKEN_REFRESHED',{user:{id:actorId}});
account.node('#amend-reason').value='Synthetic reason';
const unlocking=account.unlock();
await waitWrites(account);
account.auth('SIGNED_OUT',null); committed.resolve(ok({})); await unlocking;
assert.equal(account.writes(),1,'already dispatched operation must not replay');
assert.equal(account.node('#amend-encounter').value,'');
const response=deferred();
const switching=harness({clinical_record_signoffs:[ok(signed()),ok(signed())],clinical_record_audit_events:[ok([]),ok([])],
  encounters:[ok({encounter_no:'OLD'}),ok({encounter_no:'NEW'})]},response.promise);
await switching.search(oldId);
switching.node('#amend-reason').value='Original reason';
const firstUnlock=switching.unlock();
await switching.unlock();
await waitWrites(switching);
assert.equal(switching.writes(),1,'double submit must send one request');
assert.equal(switching.node('#amend-form').inert,true);
await switching.search(newId);
switching.node('#amend-reason').value='New encounter reason';
response.resolve(ok(switching.receipt())); await firstUnlock;
assert.equal(switching.node('#amend-encounter').value,newId,'old unlock must not navigate back');
assert.equal(switching.node('#amend-reason').value,'New encounter reason');
assert.equal(switching.node('#amend-form').inert,false);
assert.equal(switching.marker(),null);

// Lost reply survives a reload. Recovery only calls the read RPC, never unlock.
const reloadEntries=new Map();
const unknown=harness({clinical_record_signoffs:[ok(signed())],clinical_record_audit_events:[ok([])],encounters:[ok({encounter_no:'SYN'})]},
  async()=>{throw new Error('Synthetic lost reply');},reloadEntries);
await unknown.search(oldId);unknown.node('#amend-reason').value='Synthetic recovery reason';
await assert.rejects(unknown.unlock(),/lost reply/);
const saved=unknown.marker();assert.ok(saved);assert.equal(unknown.writes(),1);
const recoveredReceipt=unknown.receipt();
const reloaded=harness({},async name=>{assert.equal(name,'read_clinical_amendment_receipt');return ok(recoveredReceipt);},reloadEntries);
await reloaded.recover();assert.equal(reloaded.writes(),0);assert.equal(reloaded.marker(),null);
assert.equal(reloaded.calls.length,1);

// An absent receipt retains the key. Explicit retry uses its old generation even
// when the current record has been re-signed, and never silently generates a key.
const retryEntries=new Map();let replyMode='lost';let retry;
retry=harness({clinical_record_signoffs:[ok(signed()),ok([{...signed()[0],signature_generation:2}])],
  clinical_record_audit_events:[ok([]),ok([])],encounters:[ok({encounter_no:'SYN'}),ok({encounter_no:'SYN'})]},
  async name=>{if(name==='read_clinical_amendment_receipt')return ok(null);if(replyMode==='lost')throw new Error('Synthetic lost reply');return {error:{code:'P0001',message:'AMENDMENT_SIGNATURE_STALE'}};},retryEntries);
await retry.search(oldId);retry.node('#amend-reason').value='Same recovery reason';
await assert.rejects(retry.unlock(),/lost reply/);const pendingId=retry.marker().requestId;
await assert.rejects(retry.recover(),/RECEIPT_PENDING/);assert.equal(retry.marker().requestId,pendingId);assert.equal(retry.writes(),1);
await retry.search(oldId);retry.node('#amend-reason').value='Changed reason';
await assert.rejects(retry.unlock(),/OUTCOME_UNRESOLVED/);assert.equal(retry.writes(),1);
replyMode='stale';retry.node('#amend-reason').value='Same recovery reason';
await assert.rejects(retry.unlock(),error=>error.message==='AMENDMENT_SIGNATURE_STALE');
const retryCall=retry.calls.filter(c=>c.name==='unlock_clinical_record_for_amendment_v2')[1];
assert.equal(retryCall.args.p_request_id,pendingId);assert.equal(retryCall.args.p_signature_generation,'1');
assert.equal(retry.marker(),null,'explicit authoritative stale rejection resolves the marker');
assert.equal(retry.writes(),2);

const beforeDispatch=harness({clinical_record_signoffs:[ok(signed())],clinical_record_audit_events:[ok([])],encounters:[ok({encounter_no:'SYN'})]});
await beforeDispatch.search(oldId);beforeDispatch.node('#amend-reason').value='Synthetic pending digest';
const preparing=beforeDispatch.unlock();beforeDispatch.auth('SIGNED_OUT',null);
await assert.rejects(preparing,/CONTEXT_CHANGED/);
assert.equal(beforeDispatch.writes(),0);assert.equal(beforeDispatch.marker(),null);
const blockedStorage=harness({clinical_record_signoffs:[ok(signed())],clinical_record_audit_events:[ok([])],encounters:[ok({encounter_no:'SYN'})]});
await blockedStorage.search(oldId);blockedStorage.node('#amend-reason').value='Synthetic blocked storage';
blockedStorage.storage.setItem=()=>{throw new Error('Synthetic storage unavailable');};
await assert.rejects(blockedStorage.unlock(),/storage unavailable/);assert.equal(blockedStorage.writes(),0);
console.log('Admin clinical audit UI passed: search/account isolation, version-bound dispatch, same-key recovery/retry, read-only reload recovery, duplicate guard and late-response navigation.');
