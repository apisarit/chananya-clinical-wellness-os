import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const source=fs.readFileSync(new URL('../body-pain-map.js',import.meta.url),'utf8');
const {db,ids,asUser,asOwner}=await createPriceMasterFixture();
const literal=v=>v===null?'null':typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
try {
  const patient=(await asOwner(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1`)).rows[0].id;
  for(const commitBeforeLoss of [true,false]) {
    const target=randomUUID(), storage=new Map();
    await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
      values('${target}','MAP-${target}','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}')`);
    const payload={encounter_id:target,assessment_stage:'before',body_view:'front',x_percent:12.34,y_percent:56.78,symptom_type:'pain',pain_score:4,side:'left',body_region:'Synthetic region',sen_line_code:null,point_label:null,notes:'PRIVATE-SYNTHETIC-NOTE',pain_pattern_code:'S.00-SYNTHETIC-L-P04'};
    let mode=commitBeforeLoss?'commit-lost':'not-sent', actor=ids.userA, writes=0, failInitialRead=!commitBeforeLoss;
    const adapter={from(table){assert.equal(table,'body_pain_points');let fields='*',filters={},insert=null;
      const q={select(v){fields=v;return q;},eq(k,v){filters[k]=v;return q;},insert(v){insert=v;return q;},maybeSingle:()=>execute(true),order:()=>execute(false),then:(ok,bad)=>execute(false).then(ok,bad)};
      async function execute(single){
        if(insert){writes++;if(mode!=='not-sent')await asUser(actor,`insert into public.body_pain_points(${Object.keys(insert).join(',')}) values(${Object.values(insert).map(literal).join(',')})`);
          return mode==='normal'?{error:null}:{error:{code:'NETWORK',message:'Synthetic lost acknowledgement'}};}
        if(failInitialRead){failInitialRead=false;return {error:{message:'Synthetic pre-dispatch lookup failure'}};}
        assert.match(fields,/^[a-z_,*]+$/);
        const rows=(await asUser(actor,`select ${fields} from public.body_pain_points where ${Object.entries(filters).map(([k,v])=>`${k}=${literal(v)}`).join(' and ')}`)).rows;
        return {data:single?rows[0]||null:rows};
      }return q;
    }};
    function controller(){
      const nodes=new Map();const node=s=>{if(!nodes.has(s))nodes.set(s,{value:s==='#encounter'?target:'',innerHTML:'',textContent:'',querySelectorAll:()=>[]});return nodes.get(s);};
      const window={ChananyaRuntime:{},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener(){},dispatchEvent(){}};
      const sandbox={window,document:{readyState:'loading',addEventListener(){},querySelector:node,querySelectorAll:()=>[]},crypto:webcrypto,TextEncoder,console,CustomEvent:class{}};
      vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'globalThis.hooks={insertPoint,recoverInsert,setup(d,s,t){db=d;session=s;currentEncounter=t;}};})();'),sandbox);
      sandbox.hooks.setup(adapter,{user:{id:ids.userA}},target);return sandbox.hooks;
    }
    await assert.rejects(controller().insertPoint(payload,target,0),/ยังยืนยัน|ยังอ่านผล/);
    assert.equal(storage.size,1);const original=[...storage.values()][0];
    assert.ok(!original.includes('PRIVATE-SYNTHETIC-NOTE'));assert.deepEqual(Object.keys(JSON.parse(original)).sort(),['digest','id','phase','version']);
    const reloaded=controller(), before=writes;
    actor=ids.userB;
    await assert.rejects(reloaded.recoverInsert(),/ยังไม่พบรายการ/);
    assert.equal([...storage.values()][0],original,'foreign clinic cannot clear the originating receipt');
    actor=ids.userA;
    if(commitBeforeLoss){
      await reloaded.recoverInsert();assert.equal(writes,before,'recovery must be read-only');
    }else{
      await assert.rejects(reloaded.recoverInsert(),/ยังไม่พบรายการ/);
      await assert.rejects(reloaded.insertPoint({...payload,pain_score:7},target,0),/คำขอเดิม/);
      assert.equal(writes,before);
      mode='normal';await reloaded.insertPoint(payload,target,0);
    }
    assert.equal(storage.size,0);
    const rows=(await asUser(ids.userA,`select id,notes from public.body_pain_points where encounter_id='${target}'`)).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].id,JSON.parse(original).id);
    assert.equal(rows[0].notes,payload.notes);
    // A dispatched request whose row is no longer present must not resurrect it.
    await asUser(ids.userA,`delete from public.body_pain_points where id='${rows[0].id}'`);
    storage.set(`cnyos:bodypoint-insert:${ids.userA}:${target}`,JSON.stringify({...JSON.parse(original),phase:'sent'}));
    const sentBefore=writes;
    await assert.rejects(controller().insertPoint(payload,target,0),/ไม่ส่งบันทึกซ้ำ/);
    assert.equal(writes,sentBefore);
    assert.equal((await asUser(ids.userA,`select id from public.body_pain_points where id='${rows[0].id}'`)).rows.length,0);
  }
  console.log('Body-point recovery passed against migrated PGlite: committed/lost recovery, pre-dispatch retry uses one ID, dispatched/missing cannot resurrect, reload read-only recovery, changed draft refusal, metadata-only marker and foreign-clinic denial. Fixture auth, not hosted proof.');
} finally { await db.close(); }
