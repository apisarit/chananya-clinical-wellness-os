// Actual loadAll controller; synthetic DOM/API, no hosted authorization claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.ok(source.includes('  init();\n})();'));
function harness(database) {
  const events=new Map();let reloads=0;
  const nodes=new Map();
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{textContent:'',dataset:{},open:false,
      classList:{add(){},remove(){},toggle(){}},addEventListener(){},
      replaceChildren(){this.cleared=true;},close(){this.open=false;}});
    return nodes.get(selector);
  };
  const sandbox={console,setTimeout:()=>0,clearTimeout(){},URL,URLSearchParams,
    location:{reload(){reloads++;}},
    window:{addEventListener(name,callback){events.set(name,callback);},CnyosPaymentJournal:{async prepare(){return {requestId:'uncertain-original'};},async recover(){}},ChananyaRuntime:{can:(_p,permission)=>permission==='billing_operate'}},
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    let renders=0; render=()=>{renders++;};
    globalThis.hooks={loadAll,watchAccount,savePayment,refreshBilling,
      pendingPayment(){atomicHandoffsReady=true;paymentRequest=Object.freeze({p_request_key:'uncertain-original',p_invoice_id:'invoice',p_amount:50});},
      setup(database){db=database;role='billing';session={user:{id:'first'}};profile={id:'first'};},
      switchIdentity(kind){if(kind==='session')session={user:{id:'second'}};else profile={id:'second'};},
      snapshot(){return {invoices:data.invoices,renders,accountBlocked,paymentRequest};}
    };
  })();`),sandbox);
  sandbox.hooks.setup(database);
  return {hooks:sandbox.hooks,node,events,reloads:()=>reloads};
}
function delayedDatabase(failOlder=false, heldTable='invoices') {
  let release,enter,first=true;
  const started=new Promise(resolve=>enter=resolve);
  const held=new Promise(resolve=>release=resolve);
  return {started,release:()=>release(),database:{
    async rpc(name){assert.equal(name,'list_billable_treatment_encounters');return {data:[]};},
    from(table){return {select(){return this;},order(){return this;},then(resolve,reject){
      return (async()=>{
        if(table===heldTable && first){first=false;enter();await held;
          return failOlder?{error:{message:'old failure'}}:{data:[{id:'old',balance_due:999}]};}
        return {data:table==='invoices'?[{id:'current',balance_due:75}]:[]};
      })().then(resolve,reject);
    }};}
  }};
}
for(const failure of [false,true]) {
  const fixture=delayedDatabase(failure),{hooks,node}=harness(fixture.database);
  const old=hooks.loadAll().catch(()=>{});await fixture.started;
  await hooks.loadAll();fixture.release();await old;
  assert.equal(hooks.snapshot().invoices[0].id,'current');
  assert.equal(hooks.snapshot().renders,1);
  assert.equal(node('#pay-invoice').cleared,undefined,'old failure cleared current payment choices');
}
for (const table of ['patients', 'encounters', 'prescriptions', 'dispensing_orders', 'dispensing_items', 'prescription_items', 'products', 'payments']) {
  const fixture = delayedDatabase(true, table), { hooks, node } = harness(fixture.database);
  const older = hooks.loadAll().catch(() => {});
  await fixture.started;
  await hooks.loadAll();
  fixture.release();
  await older;
  assert.equal(hooks.snapshot().invoices[0].id, 'current', `${table}: older error cleared current invoices`);
  assert.equal(hooks.snapshot().renders, 1);
  assert.equal(node('#pay-invoice').cleared, undefined);
  assert.equal(node('#billing-queue').textContent, '', `${table}: older error replaced current handoff queue`);
}
for(const kind of ['session','profile']) {
  for(const failure of [false,true]) {
    const fixture=delayedDatabase(failure),{hooks,node}=harness(fixture.database);
    const old=hooks.loadAll().catch(()=>{});await fixture.started;
    hooks.switchIdentity(kind);fixture.release();await old;
    assert.equal(hooks.snapshot().invoices.length,0);
    assert.equal(hooks.snapshot().renders,0);
    assert.equal(node('#pay-invoice').cleared,undefined);
  }
}
for (const event of ['SIGNED_OUT', 'SIGNED_IN', 'INITIAL_SESSION']) {
  const fixture=delayedDatabase();
  let onAuth;
  fixture.database.auth={onAuthStateChange(callback){onAuth=callback;}};
  const {hooks,node}=harness(fixture.database);
  hooks.watchAccount();
  hooks.pendingPayment();
  const old=hooks.loadAll();await fixture.started;
  assert.equal(onAuth(event,event==='SIGNED_OUT'?null:{user:{id:'other'}}),undefined);
  fixture.release();await old;
  assert.equal(hooks.snapshot().accountBlocked,true);
  assert.equal(hooks.snapshot().invoices.length,0);
  assert.equal(hooks.snapshot().renders,0);
  assert.equal(node('#app').inert,true);
  assert.match(node('#boot-error').textContent,/ห้ามรับเงินซ้ำ/);
  assert.equal(hooks.snapshot().paymentRequest.p_request_key,'uncertain-original');
  onAuth('SIGNED_IN',{user:{id:'first'}});
  await hooks.loadAll();
  assert.equal(hooks.snapshot().renders,0,'blocked document must not resume stale account state');
}
{
  const fixture=delayedDatabase();let onAuth;
  fixture.database.auth={onAuthStateChange(callback){onAuth=callback;}};
  const {hooks}=harness(fixture.database);hooks.watchAccount();
  const read=hooks.loadAll();await fixture.started;
  for(const event of ['INITIAL_SESSION','SIGNED_IN','TOKEN_REFRESHED'])onAuth(event,{user:{id:'first'}});
  fixture.release();await read;
  assert.equal(hooks.snapshot().accountBlocked,false);
  assert.equal(hooks.snapshot().renders,1,'same-account token events must not discard a valid load');
}
for (const phase of ['write','readback']) {
  let onAuth,release,enter,writes=0,reads=0;
  const entered=new Promise(resolve=>enter=resolve);
  const held=new Promise(resolve=>release=resolve);
  const database={auth:{onAuthStateChange(cb){onAuth=cb;}},
    async rpc(){writes++;if(phase==='write'){enter();await held;}return {data:{payment_id:'payment',balance_due:0}};},
    from(){reads++;return {select(){return this;},eq(){return this;},async single(){
      enter();await held;return {data:{id:'payment',invoice_id:'invoice',amount:50}};
    }};}
  };
  const {hooks,node}=harness(database);hooks.watchAccount();hooks.pendingPayment();
  const form={dataset:{},querySelectorAll:()=>[],reset(){throw new Error('Must not clear old uncertain request');}};
  const event={preventDefault(){},currentTarget:form};
  const request=hooks.savePayment(event,true);await entered;
  onAuth('SIGNED_IN',{user:{id:'other'}});release();await request;
  await hooks.savePayment(event,true);
  assert.equal(writes,1);assert.equal(reads,phase==='write'?0:1);
  assert.equal(hooks.snapshot().paymentRequest.p_request_key,'uncertain-original');
  assert.equal(node('#toast').textContent,'');
}
for (const failedTable of ['invoices', 'payments', 'patients', 'encounters', 'prescriptions', 'dispensing_orders', 'dispensing_items', 'prescription_items', 'products']) {
  let failReads = false, writes = 0;
  const database = {
    async rpc(name) { assert.equal(name, 'list_billable_treatment_encounters'); return { data: [] }; },
    from(table) { return { select() { return this; }, order() { return this; },
      insert() { writes++; throw new Error('Read recovery must not write'); },
      then(resolve, reject) {
        return Promise.resolve(failReads && table === failedTable
          ? { error: new Error('synthetic latest financial read failure') }
          : { data: table === 'invoices' ? [{ id: 'current', balance_due: 75 }] : [] }).then(resolve, reject);
      }
    }; }
  };
  const { hooks, node } = harness(database);
  await hooks.loadAll();
  hooks.pendingPayment();
  const original = hooks.snapshot().paymentRequest;
  failReads = true;
  await assert.rejects(hooks.loadAll(), /latest financial read failure/);
  assert.equal(hooks.snapshot().invoices.length, 0);
  assert.equal(node('#pay-invoice').cleared, true);
  assert.match(node('#invoice-list').textContent, /ไม่ใช่การยืนยันว่าไม่มีบิล/);
  assert.match(node('#billing-queue').textContent, /ไม่ใช่การยืนยันว่าไม่มีงาน/);
  assert.match(node('#treatment-billing-queue').textContent, /โหลดข้อมูลส่งต่อ/);
  assert.equal(hooks.snapshot().paymentRequest, original, 'read error must preserve uncertain request identity');
  failReads = false;
  await hooks.loadAll();
  assert.equal(hooks.snapshot().invoices[0].balance_due, 75);
  assert.equal(hooks.snapshot().paymentRequest, original, 'successful read must not silently discard uncertain payment');
  assert.equal(hooks.snapshot().renders, 2, 'failed refresh must not render an empty financial ledger');
  assert.equal(writes, 0);
}
{
  const fixture=delayedDatabase(), {hooks,node}=harness(fixture.database);
  const first=hooks.refreshBilling(); await fixture.started;
  assert.equal(node('#billing-refresh').disabled,true);
  await hooks.refreshBilling();
  assert.equal(hooks.snapshot().renders,0,'second click must not start another read');
  fixture.release(); await first;
  assert.equal(node('#billing-refresh').disabled,false);
  assert.match(node('#billing-refresh-status').textContent,/โหลดข้อมูลแล้ว/);
}
{
  const fixture=delayedDatabase(true), {hooks,node}=harness(fixture.database);
  hooks.pendingPayment();
  const request=hooks.refreshBilling(); await fixture.started;
  fixture.release(); await request;
  assert.equal(node('#billing-refresh').disabled,false);
  assert.match(node('#billing-refresh-status').textContent,/โหลดไม่สำเร็จ/);
  assert.equal(hooks.snapshot().paymentRequest.p_request_key,'uncertain-original');
  await hooks.refreshBilling();
  assert.match(node('#billing-refresh-status').textContent,/โหลดข้อมูลแล้ว/);
  assert.equal(hooks.snapshot().paymentRequest.p_request_key,'uncertain-original');
}
for (const failure of [false, true]) {
  const fixture=delayedDatabase(failure), {hooks,node}=harness(fixture.database);
  const old=hooks.refreshBilling(); await fixture.started;
  await hooks.loadAll();
  fixture.release(); await old;
  assert.doesNotMatch(node('#billing-refresh-status').textContent,/โหลดข้อมูลแล้ว/,'superseded refresh must not claim its result is current');
  assert.equal(node('#billing-refresh').disabled,false);
}
for (const kind of ['session', 'profile']) {
  for (const failure of [false, true]) {
    const fixture=delayedDatabase(failure), {hooks,node}=harness(fixture.database);
    const pending=hooks.refreshBilling(); await fixture.started;
    hooks.switchIdentity(kind);
    node('#billing-refresh-status').textContent='new identity status';
    fixture.release(); await pending;
    assert.equal(node('#billing-refresh-status').textContent,'new identity status');
    assert.equal(hooks.snapshot().renders,0);
  }
}
for(const uncertain of [false,true]) {
  const fixture=delayedDatabase(),h=harness(fixture.database);
  if(uncertain)h.hooks.pendingPayment();
  h.events.get('pageshow')({persisted:false});
  assert.equal(h.hooks.snapshot().accountBlocked,false);
  const read=h.hooks.loadAll();await fixture.started;
  h.events.get('pagehide')({persisted:true});
  assert.equal(h.node('#app').inert,true,'cached document must be inert before restoration');
  fixture.release();await read;
  h.events.get('pageshow')({persisted:true});
  assert.equal(h.hooks.snapshot().renders,0);
  assert.equal(h.reloads(),uncertain?0:1);
  assert.equal(Boolean(h.hooks.snapshot().paymentRequest),uncertain);
}
console.log('Billing history-cache boundary passed: ordinary load unchanged, cached UI blocked before restore, fresh bootstrap requested unless payment outcome is uncertain. Simulated lifecycle events.');
console.log('Billing refresh ordering passed: older success/error cannot overwrite latest state; changed session/profile rejects late results. Synthetic controller test only.');
console.log('Auth event boundary passed: sign-out/account replacement blocks old document and late reads, preserves uncertain payment identity, and tolerates same-account refresh. Provider callback simulation only.');
