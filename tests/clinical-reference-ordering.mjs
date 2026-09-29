import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../clinical-v3.js',import.meta.url),'utf8');
const nodes=new Map();
const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'',innerHTML:'',dataset:{},addEventListener(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(s);};
let events=0;
const sandbox={console,URL,setTimeout:()=>0,location:{href:'https://synthetic.invalid/'},CustomEvent:class{},
 window:{addEventListener(){},dispatchEvent(){events++;}},document:{querySelector:node,querySelectorAll:()=>[]}};
vm.runInNewContext(source.replace('  init();\n})();',`session={user:{id:'original'}};profile={clinic_id:'original-clinic'};globalThis.hooks={loadReferences,setDb(v){db=v;},switchActor(){session={user:{id:'new-actor'}};},mutateActor(){session.user.id+='-changed';},mutateClinic(){profile.clinic_id+='-changed';}};})();`),sandbox);
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
function database(name,gate=null,linked=false){return {from(table){let filtered=false;const q={select(){return q},order(){return q},limit(){return q},eq(){return q},in(){filtered=true;return q},then(ok,bad){return run().then(ok,bad)}};
 async function run(){
  if(table==='patients'){
   if(linked&&!filtered)return {data:[]};
   if(gate){gate.entered=true;await gate.promise;}
   return {data:[{id:name,hn:name,first_name:name,last_name:'Synthetic'}]};
  }
  return {data:table==='encounters'?[{id:'enc-'+name,patient_id:name,encounter_no:name}]:[]};
 }return q;}};}
for(const linked of [false,true]){
 const gate=deferred();sandbox.hooks.setDb(database('OLDER',gate,linked));
 const old=sandbox.hooks.loadReferences();
 // Allow the old initial read to reach the linked lookup when applicable.
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(gate.entered,true,'the delayed lookup must be in flight before the newer request');
 sandbox.hooks.setDb(database('NEWER'));await sandbox.hooks.loadReferences();
 const eventCount=events;gate.resolve();await old;
 assert.match(node('#encounter').innerHTML,/NEWER/);
 assert.ok(!node('#encounter').innerHTML.includes('OLDER'));
 assert.equal(events,eventCount,'stale read must not emit completion');
}
const gate=deferred();sandbox.hooks.setDb(database('PREVIOUS-ACTOR',gate));
const old=sandbox.hooks.loadReferences(), previous=node('#encounter').innerHTML;
sandbox.hooks.switchActor();gate.resolve();await old;
assert.equal(node('#encounter').innerHTML,previous);
for(const change of ['mutateActor','mutateClinic']){
 const gate=deferred();sandbox.hooks.setDb(database('IN-PLACE-STALE',gate));
 const pending=sandbox.hooks.loadReferences(),before=node('#encounter').innerHTML;
 sandbox.hooks[change]();gate.resolve();await pending;
 assert.equal(node('#encounter').innerHTML,before,change+' must invalidate pending read');
}
console.log('Clinical reference ordering passed: delayed initial/linked reads cannot overwrite newer references; actor replacement prevents late render. Synthetic adapter only.');

// Exact-link resolution is tested separately from clinical record loading.
const deepNodes=new Map();
const deepNode=s=>{if(!deepNodes.has(s))deepNodes.set(s,{...node(s),innerHTML:'',value:''});return deepNodes.get(s);};
const deep={...sandbox,document:{querySelector:deepNode,querySelectorAll:()=>[]}};
vm.runInNewContext(source.replace('  init();\n})();',`globalThis.hooks={loadReferences,setDb(v){db=v;},selected:null};selectEncounter=async id=>{globalThis.hooks.selected=id;};})();`),deep);
let exact=null, deny=false;
deep.hooks.setDb({from(table){let filter;const q={select(){return q},order(){return q},limit(){return q},eq(field,id){if(table==='encounters'){assert.equal(field,'id');filter=id;}return q},in(){return q},maybeSingle(){return result()},then(ok,bad){return result().then(ok,bad)}};
 async function result(){
  if(table==='encounters'&&filter){exact=filter;return {data:deny?null:{id:filter,patient_id:'old-patient',encounter_no:'OLD-ENCOUNTER'}};}
  return {data:table==='patients'?[{id:'old-patient',hn:'OLD-HN',first_name:'Synthetic'}]:[]};
 }return q;}});
await deep.hooks.loadReferences('old-encounter');
assert.equal(exact,'old-encounter');
assert.equal(deep.hooks.selected,'old-encounter');
assert.match(deepNode('#encounter').innerHTML,/OLD-ENCOUNTER/);
assert.equal(deepNode('#rx-encounter').value,'old-encounter');
deny=true;deep.hooks.selected=null;
await assert.rejects(deep.hooks.loadReferences('denied-encounter'),/ไม่มีสิทธิ์อ่าน/);
assert.equal(deep.hooks.selected,null);
console.log('Clinical exact-link lookup passed: encounter outside recent window resolved by ID; unavailable/denied record never auto-selects another encounter. Synthetic adapter.');
