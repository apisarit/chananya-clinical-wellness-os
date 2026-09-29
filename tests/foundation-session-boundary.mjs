// Actual controller, synthetic auth events and RPC; no hosted review decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../foundation.js',import.meta.url),'utf8');
assert.ok(source.includes('  init();\n})();'));
function harness() {
  const nodes=new Map(), timers=[]; let callback, writes=0, refreshes=0, stops=0, resolveWrite;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',inert:false,classList:{add(){},remove(){}},replaceChildren(){this.textContent='';},addEventListener(){}});return nodes.get(id);};
  const database={auth:{onAuthStateChange(fn){callback=fn;}},rpc(){writes++;return new Promise(resolve=>resolveWrite=resolve);}};
  const context={document:{querySelector:node,querySelectorAll:()=>[]},window:{},console,setTimeout:fn=>timers.push(fn),prompt:()=> 'Synthetic review reason'};
  vm.runInNewContext(source.replace('  init();\n})();',`
    globalThis.hooks={init,decideSuggestion, refreshKnowledge, setup(database, controller){
      db=database;session={user:{id:'original'}};profile={clinic_id:'clinic'};live=controller;watchAccount();
    },blocked:()=>accountBlocked};
  })();`),context);
  context.hooks.setup(database,{request(){refreshes++;},stop(){stops++;}});
  return {database,context,node,timers,emit:(event,user)=>callback(event,user?{user:{id:user}}:null),finish:()=>resolveWrite({data:{}}),writes:()=>writes,refreshes:()=>refreshes,stops:()=>stops};
}
for(const event of ['SIGNED_OUT','SIGNED_IN','INITIAL_SESSION']) {
  const h=harness();
  const pending=h.context.hooks.decideSuggestion('synthetic','approve');
  assert.equal(h.writes(),1);
  assert.equal(h.emit(event,event==='SIGNED_OUT'?null:'different'),undefined);
  assert.equal(h.context.hooks.blocked(),true);
  assert.equal(h.node('#app').inert,true);
  assert.equal(h.stops(),0,'auth callback must not call provider APIs');
  h.finish();await pending;
  assert.equal(h.refreshes(),0,'old decision acknowledgement must not refresh new account');
  await assert.rejects(h.context.hooks.decideSuggestion('synthetic','reject'),/ตรวจสิทธิ์/);
  assert.equal(h.writes(),1);
  await h.context.hooks.refreshKnowledge();
  h.emit('SIGNED_IN','original');
  assert.equal(h.context.hooks.blocked(),true,'old document cannot resume');
  h.timers.forEach(fn=>fn());assert.equal(h.stops(),1);
}
for(const event of ['INITIAL_SESSION','SIGNED_IN','TOKEN_REFRESHED']) {
  const h=harness();h.emit(event,'original');assert.equal(h.context.hooks.blocked(),false);
  const pending=h.context.hooks.decideSuggestion('synthetic','reject');h.finish();await pending;
  assert.equal(h.refreshes(),1);
}
console.log('Foundation session boundary passed: synchronous invalidation, delayed stop, stale decision acknowledgement, blocked follow-up writes, same-user refresh; synthetic auth only');
for(const failure of [false,true]) {
  const h=harness();let release,started;
  const entered=new Promise(resolve=>started=resolve);
  h.context.console={error(){},warn(){}};
  h.context.window.ChananyaRuntime={getDb:()=>h.database,getSession:async()=>({user:{id:'original'}}),
    getProfile:()=>new Promise((resolve,reject)=>{release=()=>failure?reject(new Error('OLD-PROFILE-ERROR')):resolve({clinic_id:'clinic'});started();}),
    can(){throw new Error('must not authorize old profile');}};
  const boot=h.context.hooks.init();await entered;
  h.emit('SIGNED_IN','other-user');
  release();await boot;
  assert.equal(h.node('#app').inert,true);
  assert.match(h.node('#boot-error').textContent,/บัญชีเปลี่ยนแล้ว/);
  assert.doesNotMatch(h.node('#boot-error').textContent,/OLD-PROFILE/);
}
console.log('Foundation bootstrap race passed: late profile success/error cannot resume or replace blocked-account instructions');
