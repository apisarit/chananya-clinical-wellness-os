import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
const actorId=randomUUID(), clinicId=randomUUID(), encounterId=randomUUID(), invoiceId=randomUUID();
const entries=new Map();
const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
const nodes=new Map();
const node=s=>{
  if(!nodes.has(s)) nodes.set(s,{value:'',dataset:{},textContent:'',innerHTML:'',disabled:false,
    classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelectorAll:()=>[]});
  return nodes.get(s);
};
const sandbox={console,crypto:webcrypto,TextEncoder,sessionStorage:storage,URL,URLSearchParams,
  setTimeout:()=>0,clearTimeout(){},window:{addEventListener(){},ChananyaRuntime:{can:()=>true}},
  document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}}};
vm.runInNewContext(fs.readFileSync(new URL('../service-invoice-journal.js',import.meta.url),'utf8'),sandbox);
let marker=await sandbox.window.CnyosServiceInvoiceJournal.prepare({actorId,clinicId,encounterId,amount:650,description:'Synthetic session',storage});
let writes=0, mode='missing';
const calls=[];
const db={async rpc(name,args){
  if(name==='quote_treatment_invoice') return {data:{amount:mode==='changed-quote'?700:650,description:'Synthetic session'}};
  assert.equal(name,'issue_atomic_treatment_invoice');
  assert.equal(args.p_request_key,marker.requestId);
  assert.equal(args.p_amount,650);
  writes++;return {data:[{invoice_id:invoiceId}]};
},from(table){
  const filters={};const q={select(){return q;},eq(k,v){filters[k]=v;return q;},single(){return execute();},then(ok,bad){return execute().then(ok,bad);}};
  async function execute(){
    calls.push({table,filters});
    if(mode==='missing') return {error:{message:'Synthetic failed read'}};
    if(table==='invoices') return {data:{id:invoiceId,encounter_id:encounterId,created_by:actorId,source_service_request_key:marker.requestId,grand_total:'650.00'}};
    if(table==='encounters') return {data:{id:encounterId,clinic_id:mode==='wrong-clinic'?randomUUID():clinicId}};
    if(table==='invoice_items') return {data:[{invoice_id:invoiceId,item_type:'service',quantity:'1.000',unit_price:'650.00',line_total:'650.00',description:'Synthetic session'}]};
    throw new Error('unexpected table');
  }return q;
}};
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace('  init();\n})();',`
globalThis.hooks={restoreSavedServiceInvoice,recoverSavedServiceInvoice,resumeSavedServiceInvoice,createServiceInvoice,
  setup(database){db=database;session={user:{id:'${actorId}'}};profile={clinic_id:'${clinicId}'};loadAll=async()=>{};},
  marker(){return savedServiceMarker;}};
})();`);
vm.runInNewContext(app,sandbox);
const h=sandbox.hooks;h.setup(db);h.restoreSavedServiceInvoice();
assert.equal(h.marker().requestId,marker.requestId);
await assert.rejects(h.createServiceInvoice(encounterId),/ตรวจบิลเดิม/);
await assert.rejects(h.recoverSavedServiceInvoice(),/ยังไม่พบบิลเดิม/);
assert.equal(h.marker().requestId,marker.requestId);
assert.equal(sandbox.window.CnyosServiceInvoiceJournal.restore({actorId,clinicId,storage}).requestId,marker.requestId);
mode='wrong-clinic';
await assert.rejects(h.recoverSavedServiceInvoice(),/MISMATCH/);
assert.equal(h.marker().requestId,marker.requestId);
mode='valid';await h.recoverSavedServiceInvoice();
assert.equal(h.marker(),null);
assert.equal(sandbox.window.CnyosServiceInvoiceJournal.restore({actorId,clinicId,storage}),null);
assert.equal(writes,0);
assert.match(node('#toast').textContent,/ไม่มีการออกบิลซ้ำ/);
assert.equal(calls[0].filters.source_service_request_key,marker.requestId);
marker=await sandbox.window.CnyosServiceInvoiceJournal.prepare({actorId,clinicId,encounterId,amount:650,description:'Synthetic session',storage});
h.restoreSavedServiceInvoice();
mode='changed-quote';
await assert.rejects(h.resumeSavedServiceInvoice(),/UNRESOLVED/);
assert.equal(writes,0);
assert.equal(h.marker().requestId,marker.requestId);
mode='valid';
await h.resumeSavedServiceInvoice();
assert.equal(writes,1);
assert.equal(h.marker(),null);
assert.equal(sandbox.window.CnyosServiceInvoiceJournal.restore({actorId,clinicId,storage}),null);
console.log('Service invoice reload UI passed: read-only recovery, failed/foreign read retention, changed-quote denial and explicit same-key resume. Synthetic database adapter.');
