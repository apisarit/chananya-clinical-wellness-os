import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../outcomes.js',import.meta.url),'utf8');
async function render(value, measured){
  if (arguments.length === 1) measured = 1;
  const nodes=new Map();
  const get=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',innerHTML:'',
      classList:{add(){},remove(){}},addEventListener(){}});
    return nodes.get(selector);
  };
  const summary={total_sessions:1,measured_sessions:measured,average_pain_before:value,
    average_pain_after:value,improvement_rate:value,followup_encounters:0};
  const db={auth:{onAuthStateChange(){}},rpc:async name=>({data:name==='clinical_outcomes_summary'?[summary]:[],error:null})};
  vm.runInNewContext(source,{document:{querySelector:get},window:{ChananyaRuntime:{
    getDb:()=>db,getSession:async()=>({user:{id:'synthetic'}}),getProfile:async()=>({}),can:()=>true
  }},location:{replace(){throw new Error('Unexpected redirect');}},console});
  await new Promise(resolve=>setImmediate(resolve));
  return ['#outcomes-before','#outcomes-after','#outcomes-rate'].map(key=>get(key).textContent);
}
for(const value of [null,undefined,'',' ',NaN,Infinity,false])
  assert.deepEqual(await render(value),Array(3).fill('ยังไม่มีข้อมูล'));
for(const value of [0,'0']) assert.deepEqual(await render(value),['0','0','0%']);
assert.deepEqual(await render(2.5),['2.5','2.5','2.5%']);
for (const measured of [0, '0', undefined, null, -1, '', 'bad', 0.5]) {
  assert.deepEqual(await render(0, measured), Array(3).fill('ยังไม่มีข้อมูล'));
}
assert.deepEqual(await render(0, '1'), ['0', '0', '0%']);
console.log('Outcomes UI: absent/invalid measurements are not displayed as measured zero; genuine zero preserved. Synthetic controller only.');
