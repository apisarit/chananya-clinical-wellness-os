import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../admin-price-master.js',import.meta.url),'utf8');
const event={preventDefault(){}};
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function harness({holdName,holdSession=false,failSession=false}={}) {
  const nodes=new Map(),calls=[],gate=defer(),sessionGate=defer();let callback;
  const node=selector=>{
    if(!nodes.has(selector)) nodes.set(selector,{value:'',textContent:'',innerHTML:'',disabled:false,
      handlers:{},classList:{add(){},toggle(){}},querySelectorAll:()=>[],reset(){},
      addEventListener(type,fn){this.handlers[type]=fn;}});
    return nodes.get(selector);
  };
  const item={item_type:'service',item_id:'item-a',service_id:'service-a',price_list_id:'price-a',
    item_description:'Synthetic clinic A price',unit_code:'hour',unit_price:650,item_version:1};
  const db={auth:{onAuthStateChange(fn){callback=fn;}},rpc:async(name,args)=>{
    calls.push({name,args});if(name===holdName) await gate.promise;
    return {data:name==='list_price_master'?[item]:name==='list_price_master_history'?[{action:'update',reason:'Synthetic history A'}]:[]};
  }};
  const sandbox={document:{querySelector:node},window:{ChananyaRuntime:{getDb:()=>db,getSession:async()=>{
    if(holdSession) await sessionGate.promise;
    if(failSession) throw new Error('Synthetic session lookup failure');
    return {user:{id:'actor-a'}};
  }}},console};
  vm.runInNewContext(source.replace("  $('#price-edit-form').addEventListener","  globalThis.hooks={load,select,save};\n  $('#price-edit-form').addEventListener"),sandbox);
  return {...sandbox.hooks,node,calls,gate,sessionGate,
    change:(type='SIGNED_OUT',id=null)=>callback?.(type,id?{user:{id}}:null)};
}
for(const [type,id] of [['SIGNED_OUT',null],['SIGNED_IN','actor-b'],['TOKEN_REFRESHED',null]]) {
  const h=harness();await h.load();await h.select(0);
  assert.match(h.node('#price-list').innerHTML,/Synthetic clinic A/);
  h.change(type,id);
  assert.equal(h.node('#price-list').innerHTML,'','account change must clear old catalog');
  assert.equal(h.node('#price-history').innerHTML,'');
  assert.equal(h.node('#price-save').disabled,true);
  const n=h.calls.length;
  h.node('#price-amount').value='700';h.node('#price-reason').value='Synthetic change';
  await h.save(event);await h.load();await h.select(0);
  h.node('#price-setup-reason').value='Synthetic setup';
  await h.node('#price-setup-form').handlers.submit(event);
  assert.equal(h.calls.length,n,'old page must not dispatch after account boundary');
}
for(const name of ['list_price_master','list_price_master_history','set_price_master_item','setup_price_master_default']) {
  const h=harness({holdName:name});let pending;
  if(name==='list_price_master') pending=h.load();
  else {
    await h.load();
    if(name==='list_price_master_history') pending=h.select(0);
    else if(name==='set_price_master_item') {
      await h.select(0);h.node('#price-amount').value='700';h.node('#price-reason').value='Synthetic change';pending=h.save(event);
    } else {h.node('#price-setup-reason').value='Synthetic setup';pending=h.node('#price-setup-form').handlers.submit(event);}
  }
  for(let i=0;i<20&&!h.calls.some(x=>x.name===name);i++) await Promise.resolve();
  assert.ok(h.calls.some(x=>x.name===name));
  const count=h.calls.length;h.change('SIGNED_IN','actor-b');h.gate.resolve();await pending;
  assert.equal(h.calls.length,count,'late completion must not refresh under the new actor');
  assert.equal(h.node('#price-list').innerHTML,'');assert.equal(h.node('#price-history').innerHTML,'');
  assert.equal(h.node('#price-save').disabled,true);
  assert.doesNotMatch(h.node('#price-status').textContent,/บันทึกราคากลางแล้ว/);
}
const early=harness({holdSession:true}),loading=early.load();
early.change();early.sessionGate.resolve();await loading;
assert.equal(early.calls.length,0,'sign-out during initial session lookup must prevent first RPC');
const same=harness();await same.load();same.change('TOKEN_REFRESHED','actor-a');await same.select(0);
assert.equal(same.node('#price-save').disabled,false,'same-actor refresh remains usable');
const failed=harness({failSession:true});await failed.load();await failed.load();
assert.equal(failed.calls.length,0,'failed initial identity must not leave a usable cached DB client');
console.log('Price Master session boundary passed: catalog/history clearing, mutation refusal, delayed reads/writes, initial-session race and same-actor refresh. Synthetic controller only.');
