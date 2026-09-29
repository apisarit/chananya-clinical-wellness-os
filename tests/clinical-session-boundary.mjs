import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../clinical-v3.js',import.meta.url),'utf8');
function fixture(){
 const nodes=new Map();const node=s=>{if(!nodes.has(s)){const classes=new Set();nodes.set(s,{value:'synthetic-private',textContent:'synthetic-private',innerHTML:'',dataset:{},disabled:false,inert:false,addEventListener(){},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),toggle(){},contains:v=>classes.has(v)}});}return nodes.get(s);};
 let callback,queries=0,reloads=0;const listeners=new Map();
 const sandbox={console,URL,setTimeout:()=>0,location:{href:'https://synthetic.invalid/',reload(){reloads++;}},window:{addEventListener(type,fn){listeners.set(type,fn);}},document:{querySelector:node,querySelectorAll:s=>s.includes('#app')?[node('#field')]:[]}};
 vm.runInNewContext(source.replace('  init();\n})();',`globalThis.hooks={watchClinicalSession,savePlan,loadReferences,setup(v){db=v;session={user:{id:'actor'}};profile={clinic_id:'clinic'};}};})();`),sandbox);
 sandbox.hooks.setup({auth:{onAuthStateChange(fn){callback=fn;return {}; }},from(){queries++;throw new Error('UNEXPECTED_READ');}});
 sandbox.hooks.watchClinicalSession();
 return {node,h:sandbox.hooks,event:(...args)=>callback(...args),queries:()=>queries,lifecycle:(type,persisted)=>listeners.get(type)({persisted}),reloads:()=>reloads};
}
for(const [event,next] of [['SIGNED_OUT',null],['SIGNED_IN',{user:{id:'different'}}]]){
 const f=fixture();f.event(event,next);
 assert.equal(f.node('#app').inert,true);
 assert.equal(f.node('#app').classList.contains('hidden'),true);
 assert.equal(f.node('#field').value,'');
 assert.equal(f.node('#diagnosis-status').textContent,'');
 assert.equal(f.node('#plan-status').textContent,'');
 await assert.rejects(f.h.savePlan({}),/บัญชีเปลี่ยน/);
 await f.h.loadReferences();assert.equal(f.queries(),0);
}
const same=fixture();same.event('TOKEN_REFRESHED',{user:{id:'actor'}});
assert.equal(same.node('#app').inert,false);
const cached=fixture();cached.lifecycle('pagehide',true);
assert.equal(cached.node('#app').inert,true);
assert.equal(cached.node('#field').value,'');
cached.lifecycle('pageshow',true);assert.equal(cached.reloads(),1);
await assert.rejects(cached.h.savePlan({}),/บัญชีเปลี่ยน/);
const normal=fixture();normal.lifecycle('pageshow',false);
assert.equal(normal.reloads(),0);assert.equal(normal.node('#app').inert,false);
console.log('Clinical session boundary passed: sign-out/account replacement hides/inerts workspace, clears shown fields/history, refuses new operations; same-actor refresh retained. Provider callback simulation.');
