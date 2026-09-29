import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const elements=Object.fromEntries(['clinical-signoff-panel','signoff-form','signer-name','license-no','signoff-reason','signoff-status','clinical-record-fields','signoff-btn','encounter'].map(id=>[id,{value:'',dataset:{},listeners:{},textContent:'',addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){}}]));
elements.encounter.value='A';
const queries=[], mutations=[], events=[], alerts=[];
let authEvent;
const db={from(){let encounter;const q={select(){return q;},eq(key,value){if(key==='encounter_id') encounter=value;return q;},maybeSingle(){return new Promise(resolve=>queries.push({encounter,resolve}));}};return q;},rpc(name,args){return new Promise(resolve=>mutations.push({name,args,resolve}));}};
db.auth={onAuthStateChange(fn){authEvent=fn;}};
const window={ChananyaRuntime:{getDb:()=>db,getSession:async()=>({user:{id:'synthetic'}}),getProfile:async()=>({full_name:'Synthetic practitioner'})},dispatchEvent:e=>events.push(e),addEventListener(){}};
vm.runInNewContext(fs.readFileSync(new URL('../clinical-signoff.js',import.meta.url),'utf8'),{window,document:{readyState:'complete',querySelector:s=>elements[s.slice(1)]},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},console,alert:m=>alerts.push(m),confirm:()=>true,setTimeout});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const resolveRead=(encounter,data,error=null)=>{const i=queries.findIndex(q=>q.encounter===encounter);assert.ok(i>=0);queries.splice(i,1)[0].resolve({data,error});};
const change=id=>{elements.encounter.value=id;elements.encounter.listeners.change();};
const submit=()=>elements['signoff-form'].listeners.submit({preventDefault(){}});
await flush();
change('B');
resolveRead('B',null);await flush();
assert.equal(elements['clinical-record-fields'].inert,false);
resolveRead('A',{lock_record:true,signer_name:'Old record'});await flush();
assert.equal(elements['clinical-record-fields'].inert,false,'stale A response must not lock B');
assert.ok(events.every(e=>e.detail.encounterId==='B'),'stale/loading status must not broadcast signed events');

const first=submit();const duplicate=submit();
assert.equal(mutations.length,1,'double submit creates one signoff request');
assert.equal(mutations[0].args.p_encounter_id,'B');
mutations.shift().resolve({error:null});await flush();
resolveRead('B',null,{message:'Synthetic read failure'});await first;await duplicate;
assert.match(alerts.at(-1),/ยังยืนยันสถานะกลับไม่ได้/);
assert.equal(elements['clinical-record-fields'].inert,true,'unknown status blocks editing');
assert.ok(!alerts.includes('ลงนามและ Lock เวชระเบียนสำเร็จ'));

change('C');resolveRead('C',null);await flush();
const changing=submit();
change('D');resolveRead('D',null);await flush();
mutations.shift().resolve({error:{message:'Old request failed'}});await changing;
assert.equal(elements['clinical-record-fields'].inert,false,'old request failure must not alter D');
assert.equal(elements['signoff-btn'].disabled,false);
assert.equal(alerts.length,1,'old request must not show alerts in different encounter');

const success=submit();mutations.shift().resolve({error:null});await flush();
resolveRead('D',{lock_record:true,signer_name:'Synthetic practitioner',signed_at:'2026-09-26T00:00:00Z'});await success;
assert.equal(alerts.at(-1),'ลงนามและ Lock เวชระเบียนสำเร็จ');
assert.equal(events.at(-1).detail.encounterId,'D');
assert.equal(events.at(-1).detail.locked,true);
change('E');resolveRead('E',null);await flush();
for(const [code,message] of [
  ['ENCOUNTER_PRACTITIONER_MISMATCH','ผู้รับผิดชอบเคสลงนาม'],
  ['ENCOUNTER_NOT_FOUND','กลับไปเลือกรายการรับบริการ'],
  ['CNYOS_SUBSCRIPTION_SUSPENDED','ติดต่อผู้ดูแล'],
]){
  const rejected=submit();mutations.shift().resolve({error:{message:code}});await flush();
  assert.ok(alerts.at(-1).includes(message));
  assert.ok(!alerts.at(-1).includes(code),'show actionable text, not internal error code');
  resolveRead('E',null);await rejected;
  assert.equal(mutations.length,0,'denial does not automatically retry signoff');
}
authEvent('TOKEN_REFRESHED',{user:{id:'synthetic'}});
assert.equal(elements['signoff-btn'].disabled,false);
const abandoned=submit();assert.equal(mutations.length,1);
authEvent('SIGNED_IN',{user:{id:'other'}});
assert.equal(elements['clinical-record-fields'].inert,true);
assert.equal(elements['signoff-form'].inert,true);
assert.equal(elements['signer-name'].value,'');
const alertCount=alerts.length,eventCount=events.length;
mutations.shift().resolve({error:null});await abandoned;
await submit();change('F');await flush();
assert.equal(mutations.length,0,'blocked signoff cannot send another RPC');
assert.equal(queries.length,0,'late signoff does not read under the replacement account');
assert.equal(alerts.length,alertCount);assert.equal(events.length,eventCount);
assert.match(elements['signoff-status'].textContent,/บัญชีเปลี่ยน/);
console.log('Clinical signoff UI passed: stale response, double submit, failed readback, encounter switch, verified success and account-change in-flight isolation');
