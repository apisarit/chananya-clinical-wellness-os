import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source=fs.readFileSync(new URL('../opd-workflow.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(){
  const nodes=new Map(), storage=new Map(), events=[], listeners=new Map();
  const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'',checked:false,inert:false,textContent:'',innerHTML:'',addEventListener(){},setAttribute(){},reset(){this.resets=(this.resets||0)+1;}});return nodes.get(s);};
  node('#encounter').value='encounter';node('#opd-duration-minutes').value='60';
  let authEvent, mode='', resolvePending, reads=0, writes=0;
  const db={auth:{onAuthStateChange(fn){authEvent=fn;}},from(){reads++;const q={select(){return q;},eq(){return q;},maybeSingle(){return mode==='history'?new Promise(resolve=>{resolvePending=resolve;}):Promise.resolve({data:{}});},order(){return Promise.resolve({data:[]});},upsert(){writes++;return Promise.resolve({data:{}});}};return q;},rpc(){writes++;return new Promise(resolve=>{resolvePending=resolve;});}};
  const window={ChananyaRuntime:{getDb:()=>db,getSession:async()=>({user:{id:'actor'}})},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener:(t,fn)=>listeners.set(t,fn),dispatchEvent:e=>events.push(e)};
  const sandbox={window,document:{readyState:'complete',querySelector:node,querySelectorAll:()=>[]},console,alert(){},TextEncoder,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},crypto:{randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:(...args)=>mode==='digest'?new Promise(resolve=>{resolvePending=()=>resolve(new Uint8Array(32));}):webcrypto.subtle.digest(...args)}}};
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.hooks={saveHistory,saveSession,loadHistory,loadSessions};})();'),sandbox);
  await flush();
  return {node,storage,events,h:sandbox.hooks,setMode:v=>{mode=v;},release:()=>resolvePending({data:{id:'synthetic'}}),block:()=>authEvent('SIGNED_OUT',null),refresh:()=>authEvent('TOKEN_REFRESHED',{user:{id:'actor'}}),replace:()=>authEvent('SIGNED_IN',{user:{id:'other'}}),reads:()=>reads,writes:()=>writes,event:{preventDefault(){},target:node('#opd-session-form')}};
}
const history=await fixture();history.setMode('history');
const pendingHistory=history.h.saveHistory(history.event);
history.block();history.release();
await assert.rejects(pendingHistory,/บัญชีเปลี่ยน/);
assert.equal(history.writes(),0,'no history upsert after the account changed during lookup');
assert.equal(history.node('#opd-history-form').inert,true);
assert.equal(history.node('#opd-session-form').inert,true);
const count=history.reads();await history.h.loadHistory();await history.h.loadSessions();assert.equal(history.reads(),count);

const digest=await fixture();digest.setMode('digest');
const pendingDigest=digest.h.saveSession(digest.event);
digest.replace();digest.release();await assert.rejects(pendingDigest,/บัญชีเปลี่ยน/);
assert.equal(digest.writes(),0,'no treatment request after account changed during digest');
assert.equal(digest.storage.size,0);

const inflight=await fixture();const pendingWrite=inflight.h.saveSession(inflight.event);
for(let i=0;i<100&&inflight.writes()===0;i++)await flush();
assert.equal(inflight.writes(),1);assert.equal(inflight.storage.size,1);
inflight.block();inflight.release();await assert.rejects(pendingWrite,/บัญชีเปลี่ยน/);
assert.equal(inflight.storage.size,1,'unknown outcome retains the actor-bound recovery marker');
assert.equal(inflight.events.length,0,'old account response does not announce success');

const same=await fixture();same.refresh();assert.equal(same.node('#opd-history-form').inert,false);
console.log('OPD account boundary passed: lookup/digest races stop writes, in-flight result preserves recovery marker, blocked reads/events and same-actor refresh. Synthetic callback evidence.');
