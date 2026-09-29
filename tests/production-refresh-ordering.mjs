// Actual controller with synthetic deferred reads; not hosted authentication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../production.js',import.meta.url),'utf8');
for(const changed of ['newer','session','profile']) for(const oldFailure of [false,true]) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'stale',textContent:'stale',innerHTML:'stale',addEventListener(){},close(){this.closed=true;}});return nodes.get(id);};
  const context={console,Intl,window:{},document:{querySelector:node,querySelectorAll:()=>[]}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    let renders=0;render=()=>renders++;
    globalThis.hooks={load,setup(database){db=database;session={user:{id:'synthetic'}};profile={id:'synthetic'};},
    change(kind){if(kind==='session')session={user:{id:'other'}};else profile={id:'other'};},snapshot:()=>({data,renders})};
  })();`),context);
  let first=true,entered,release,failLatest=false;
  const started=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  context.hooks.setup({from(table){return {select(){return this;},order(){return this;},then(resolve,reject){return (async()=>{
    if(table!=='production_orders')return {data:[]};
    if(first){first=false;entered();await hold;return oldFailure?{error:new Error('old failure')}:{data:[{id:'old'}]};}
    return failLatest?{error:new Error('latest failure')}:{data:[{id:'new'}]};
  })().then(resolve,reject);}};}});
  const old=context.hooks.load().catch(error=>error);await started;
  if(changed==='newer')await context.hooks.load();else context.hooks.change(changed);
  release();const result=await old;
  assert.match(result?.message||'',oldFailure?/old failure/:/PRODUCTION_LOAD_SUPERSEDED/);
  if(changed!=='newer') {
    assert.equal(context.hooks.snapshot().renders,0);
    assert.equal(context.hooks.snapshot().data.orders.length,0);
    await context.hooks.load();
  }
  assert.equal(context.hooks.snapshot().data.orders[0].id,'new');
  assert.equal(context.hooks.snapshot().renders,1);
  failLatest=true;await assert.rejects(context.hooks.load(),/latest failure/);
  for(const rows of Object.values(context.hooks.snapshot().data)) assert.equal(rows.length,0);
  assert.match(node('#order-list').textContent,/ยังอ่านข้อมูลการผลิตล่าสุดไม่ได้/);
  for(const id of ['#f-product','#c-formula','#c-material'])assert.equal(node(id).innerHTML,'');
  assert.equal(node('#complete-dialog').closed,true);
}
console.log('Production refresh ordering passed: stale success/error and replaced contexts cannot overwrite new data; latest failure removes old actions/selections. Synthetic reads only.');
