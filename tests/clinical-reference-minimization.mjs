import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const source=fs.readFileSync(new URL('../clinical-v3.js',import.meta.url),'utf8');
const nodes=new Map();
const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'',innerHTML:'',dataset:{},addEventListener(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(s);};
const sandbox={console,URL,location:{href:'https://synthetic.invalid/'},setTimeout:()=>0,
  CustomEvent:class{},window:{addEventListener(){},dispatchEvent(){}},document:{querySelector:node,querySelectorAll:()=>[]}};
assert.ok(source.includes('  init();\n})();'));
vm.runInNewContext(source.replace('  init();\n})();',`globalThis.hooks={loadReferences,setDb(v){db=v;}};})();`),sandbox);
const {db,ids,asOwner,asUser}=await createPriceMasterFixture();
try {
  const id=randomUUID();
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await asOwner(`insert into public.patients(id,clinic_id,hn,prefix,first_name,last_name,phone,created_by)
    values('${id}','${ids.clinicA}','MIN-SYN','คุณ','<Synthetic>','Only','PRIVATE-SENTINEL','${ids.owner}')`);
  let projection, returned, outsideRecent=false, linkedFailure=false;
  const linkedQueries=[];
  sandbox.hooks.setDb({from(table){const q={select(fields){q.fields=fields;return q;},order(){return q;},limit(){return q;},eq(){return q;},then(ok,bad){return execute().then(ok,bad);}};
    q.in=(column,values)=>{assert.equal(column,'id');q.ids=values;return q;};
    async function execute(){
      if(table==='encounters'&&outsideRecent)return {data:[{id:'synthetic-encounter',encounter_no:'ENC-SYN',patient_id:id}]};
      if(table!=='patients')return {data:[]};
      projection=q.fields;
      assert.equal(projection,'id,hn,prefix,first_name,last_name');
      if(outsideRecent&&!q.ids)return {data:[]};
      if(q.ids){linkedQueries.push([...q.ids]);assert.deepEqual([...q.ids],[id]);if(linkedFailure)return {error:new Error('Synthetic linked read denied')};}
      returned=(await asUser(ids.userA,`select ${projection} from public.patients order by created_at desc limit 500`)).rows;
      return {data:returned};
    }return q;
  }});
  await sandbox.hooks.loadReferences();
  assert.ok(returned.some(row=>row.id===id),'authorized practitioner can still select the patient');
  assert.deepEqual(Object.keys(returned.find(row=>row.id===id)).sort(),['first_name','hn','id','last_name','prefix']);
  assert.match(node('#enc-patient').innerHTML,/MIN-SYN/);
  assert.match(node('#enc-patient').innerHTML,/&lt;Synthetic&gt;/);
  assert.ok(!node('#enc-patient').innerHTML.includes('PRIVATE-SENTINEL'));
  outsideRecent=true;
  await sandbox.hooks.loadReferences();
  assert.equal(linkedQueries.length,1);
  assert.match(node('#encounter').innerHTML,/&lt;Synthetic&gt;/,'old linked patient name survives recent-list boundary');
  const previous=node('#encounter').innerHTML;
  linkedFailure=true;
  await assert.rejects(sandbox.hooks.loadReferences(),/Synthetic linked read denied/);
  assert.equal(node('#encounter').innerHTML,previous,'failed linked lookup must not replace rendered context with partial references');
  const foreign=(await asUser(ids.userB,`select ${projection} from public.patients where id='${id}'`)).rows;
  assert.equal(foreign.length,0);
  console.log('Clinical reference minimization passed: actual projection against migrated SQL, name/HN options preserved, unrelated fields omitted and foreign-clinic denied. Fixture auth, not hosted acceptance.');
} finally {await db.close();}
