// Actual Production handlers with synthetic RPCs; no database/persistence claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../production.js',import.meta.url),'utf8');
for(const mode of ['refresh-failure','success','write-failure']) for(const action of ['saveFormula','saveComponent','saveCompletedOrder']) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'1',textContent:'',disabled:false,
    classList:{add(){},remove(){}},addEventListener(){},reset(){this.resets=(this.resets||0)+1;},close(){this.closed=true;}});return nodes.get(id);};
  let release,calls=0;
  const held=new Promise(resolve=>release=resolve);
  const context={console,Intl,window:{setTimeout(){}},document:{querySelector:node,querySelectorAll:()=>[]}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    persistenceReady=true;session={user:{id:'synthetic'}};profile={id:'synthetic'};activeOrderId='synthetic-order';
    globalThis.hooks={saveFormula,saveComponent,saveCompletedOrder,setup(database){db=database;load=async()=>{${mode==='refresh-failure'?"throw new Error('Synthetic refresh failed');":''}};}};
  })();`),context);
  context.hooks.setup({async rpc(){calls++;await held;if(mode==='write-failure')throw new Error('Synthetic unknown write outcome');return {data:{id:'synthetic-result'}};}});
  const control={disabled:false};
  const lockedControl={disabled:true};
  const form={querySelectorAll:()=>[control,lockedControl],reset(){this.resets=(this.resets||0)+1;}};
  const event={preventDefault(){},currentTarget:form,target:form};
  const first=context.hooks[action](event);
  const second=context.hooks[action](event);
  assert.equal(calls,1,`${action} dispatched duplicate RPC`);
  assert.equal(control.disabled,true);
  release();const results=await Promise.allSettled([first,second]);
  assert.equal(calls,1);
  assert.equal(control.disabled,false);
  assert.equal(lockedControl.disabled,true,'pre-existing locks must remain');
  if(mode==='write-failure') {
    assert.equal(results[0].status,'rejected');
    assert.match(results[0].reason.message,/unknown write outcome/);
    assert.equal(form.resets,undefined);
    assert.equal(node('#complete-dialog').closed,undefined);
    assert.equal(node('#toast').textContent,'');
  } else {
    assert.equal(results[0].status,'fulfilled');
    assert.match(node('#toast').textContent,mode==='refresh-failure'?/แล้ว.*โหลดรายการล่าสุดไม่สำเร็จ/:/แล้ว$/);
  }
}
console.log('Production form handlers passed: one in-flight RPC per form, controls restored, acknowledged save distinguished from failed refresh. Synthetic API only.');
