// Actual Quality controller, synthetic reads only; no release authorization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../quality.js',import.meta.url),'utf8');
for (const scenario of ['newer','session','profile']) for (const failure of [false,true]) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',addEventListener(){}});return nodes.get(id);};
  let release,entered,first=true;
  const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  const context={console,window:{},document:{querySelector:node,querySelectorAll:()=>[]}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    let renders=0;render=()=>renders++;
    globalThis.hooks={load,setup(database){db=database;session={user:{id:'synthetic'}};profile={id:'synthetic'};},switchContext(kind){if(kind==='session')session={user:{id:'other'}};else profile={id:'other'};},snapshot:()=>({data,renders})};
  })();`),context);
  let failLatest=false;
  context.hooks.setup({from(table){return {select(){return this;},order(){return this;},then(resolve,reject){return (async()=>{
    if(table!=='production_orders')return {data:[]};
    if(first){first=false;entered();await held;return failure?{error:new Error('old')}:{data:[{id:'old'}]};}
    return failLatest?{error:new Error('latest')}:{data:[{id:'new'}]};
  })().then(resolve,reject);}};}});
  const older=context.hooks.load().catch(e=>e);await started;
  if(scenario==='newer')await context.hooks.load();
  else context.hooks.switchContext(scenario);
  release();
  const stale=await older;
  assert.match(stale.message,failure?/old/:/QUALITY_LOAD_SUPERSEDED/);
  if(scenario!=='newer') {
    assert.equal(context.hooks.snapshot().renders,0,'old identity must not render');
    assert.equal(context.hooks.snapshot().data.orders.length,0);
    assert.equal(node('#quality-queue').textContent,'','old identity failure must not paint the new context');
    await context.hooks.load();
  }
  assert.equal(context.hooks.snapshot().data.orders[0].id,'new');
  assert.equal(context.hooks.snapshot().renders,1);
  failLatest=true;await assert.rejects(context.hooks.load(),/latest/);
  assert.equal(context.hooks.snapshot().data.orders.length,0);
  assert.match(node('#quality-queue').textContent,/ยังอ่านคิว Quality ล่าสุดไม่ได้/);
  assert.match(node('#quality-history').textContent,/ยังดาวน์โหลดรายงานไม่ได้/);
}
console.log('Quality refresh ordering passed: old success/error cannot replace newer queue; latest read failure removes stale decision/report data. Synthetic controller only.');
