import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function harness({foreign=false,hold=false}={}) {
  let release,started,fail=false;
  const entered=new Promise(resolve=>started=resolve);
  const pending=new Promise(resolve=>release=resolve);
  const reads=[];
  const context={clinic_id:foreign?'foreign':'clinic',patient_id:'patient',encounter_id:'encounter',encounter_no:'SYN',
    first_name:'Synthetic',last_name:'Owner flow',hn:'SYN',prefix:'',has_prescription:true};
  const database={
    from(table){reads.push(table);assert.ok(['invoices','payments','audit_logs'].includes(table),'Owner must not query clinical tables');
      return {select(){return this;},order(){return this;},then(resolve){return Promise.resolve({data:[]}).then(resolve);}};},
    async rpc(name){
      if(name==='list_owner_finance_context'){started();if(hold)await pending;if(fail)throw new Error('Owner context unavailable');return {data:[context]};}
      if(name==='list_billable_treatment_encounters')return {data:[]};
      if(name==='quote_encounter_invoice')return {error:{message:'SIGNED_CLINICAL_RECORD_REQUIRED'}};
      throw new Error(`unexpected RPC ${name}`);
    }
  };
  const nodes=new Map();
  const node=s=>{if(!nodes.has(s))nodes.set(s,{open:false,textContent:'stale',replaceChildren(){this.textContent='';},classList:{add(){},remove(){},toggle(){}},addEventListener(){}});return nodes.get(s);};
  const sandbox={console,setTimeout,clearTimeout,window:{ChananyaRuntime:{can:(_p,c)=>c==='billing_operate'},addEventListener(){}},
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    render=()=>{};
    globalThis.hooks={loadAll,canView,billingEncounterIds,setup(value){db=value;session={user:{id:'owner'}};
      profile={clinic_id:'clinic',clinic_role:'owner',access_context_ready:true};role='admin';},
      change(){profile={clinic_id:'other',clinic_role:'owner',access_context_ready:true};},
      seedStale(){treatmentQuotes.set('encounter',{});encounterInvoiceQuotes.set('encounter',{});data.billableTreatmentEncounters=[{}];},
      stale(){return treatmentQuotes.size+encounterInvoiceQuotes.size+data.billableTreatmentEncounters.length;},
      state(){return {patients:data.patients,contexts:data.ownerFinanceContexts,invoices:data.invoices};}};
  })();`),sandbox);
  sandbox.hooks.setup(database);
  return {hooks:sandbox.hooks,reads,entered,node,fail:()=>{fail=true;},release:()=>release()};
}
const good=harness();
assert.equal(good.hooks.canView('billing'),true);
assert.equal(good.hooks.canView('patients'),false);
await good.hooks.loadAll();
assert.deepEqual([...good.hooks.billingEncounterIds()],['encounter']);
assert.equal(good.hooks.state().patients[0].first_name,'Synthetic');
assert.deepEqual(Object.keys(good.hooks.state().patients[0]).sort(),['first_name','hn','id','last_name','prefix']);
good.hooks.seedStale();good.fail();
await assert.rejects(good.hooks.loadAll(),/Owner context/);
assert.equal(good.hooks.stale(),0);
assert.equal(good.hooks.state().contexts.length,0);
assert.equal(good.node('#pay-invoice').textContent,'');
assert.match(good.node('#billing-queue').textContent,/ไม่สำเร็จ/);
await assert.rejects(harness({foreign:true}).hooks.loadAll(),/Owner/);
const delayed=harness({hold:true});
const loading=delayed.hooks.loadAll();await delayed.entered;delayed.hooks.change();delayed.release();await loading;
assert.equal(delayed.hooks.state().contexts.length,0);
assert.equal(delayed.hooks.state().patients.length,0);
console.log('Owner finance UI: visible finance-only tab, scoped queue projection, no clinical table reads, foreign and late-context rejection passed. Synthetic controller evidence only.');
