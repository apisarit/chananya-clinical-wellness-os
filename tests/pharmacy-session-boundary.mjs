// Actual controller, synthetic deferred API; no hosted-session claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../pharmacy.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(mode) {
  const nodes = new Map(), listeners = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', innerHTML: '',
      classList: {add(){},remove(){}}, addEventListener(){}, inert:false });
    return nodes.get(selector);
  };
  let auth, release, reads=0, writes=0, renders=0, quotes=0, closed=0;
  const held = new Promise(resolve => { release=resolve; });
  const api = { auth:{onAuthStateChange(fn){auth=fn;}},
    from(table){ reads++; const q={select(){return q;},order(){return q;},
      then(resolve,reject){return (mode==='read' ? held : Promise.resolve({data:[]})).then(resolve,reject);}};return q; },
    rpc(){writes++;return held;}
  };
  const sandbox={console,Intl,setTimeout:()=>1,clearTimeout(){},alert(){},
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},visibilityState:'visible'},
    window:{CnyosClarificationHistory:{close(){closed++;}},addEventListener:(name,fn)=>listeners.set(name,fn),CnyosPriceMaster:{productQuotes:async()=>{quotes++;return mode==='quote'?held:new Map();}}},
    location:{reload(){},replace(){}},api,capture(){renders++;}};
  vm.runInNewContext(source.replace('  init();\n})();', `
    db=api; session={user:{id:'actor'}}; persistenceReady=true; watchAccount();
    render=()=>capture(); globalThis.h={load,act,state:()=>data};
  })();`),sandbox);
  return {h:sandbox.h,node,release,replace:()=>auth('SIGNED_IN',{user:{id:'other'}}),
    refresh:()=>auth('TOKEN_REFRESHED',{user:{id:'actor'}}),
    pagehide:()=>listeners.get('pagehide')({persisted:true}),
    reads:()=>reads,writes:()=>writes,renders:()=>renders,quotes:()=>quotes,closed:()=>closed};
}
const read=fixture('read'), pending=read.h.load();
read.replace();read.release({data:[{id:'OLD-ACCOUNT'}]});await pending;
assert.equal(read.renders(),0);assert.equal(read.quotes(),0);
assert.ok(Object.values(read.h.state()).every(rows=>rows.length===0));
assert.equal(read.node('#app').inert,true);
assert.equal(read.closed(),1,'account invalidation synchronously disposes the history sidecar');
const before=read.reads();await read.h.load();assert.equal(read.reads(),before);
await assert.rejects(read.h.act('rx-billing','order'),/บัญชีเปลี่ยน/);assert.equal(read.writes(),0);

const quote=fixture('quote'), pendingQuote=quote.h.load();await flush();
assert.equal(quote.quotes(),1);quote.replace();quote.release(new Map());await pendingQuote;
assert.equal(quote.renders(),0);

const write=fixture('write'), pendingWrite=write.h.act('rx-billing','order');
assert.equal(write.writes(),1);write.replace();write.release({data:{},error:null});
await assert.rejects(pendingWrite,/บัญชีเปลี่ยน/);assert.equal(write.reads(),0);
assert.equal(write.node('#toast').textContent,'');

const same=fixture('normal');same.refresh();await same.h.load();assert.equal(same.renders(),1);
same.pagehide();assert.equal(same.node('#app').inert,true);
console.log('Pharmacy account boundary passed: late reads/quotes discarded, old write acknowledgement suppressed, new actions blocked, same-actor refresh allowed, cached page blocked. Synthetic callbacks only.');
