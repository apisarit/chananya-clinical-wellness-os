import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../admin-role-history.js', import.meta.url), 'utf8');
const row = id => ({ id, action: 'assign_department_role', user_id: 'ACTOR-SYN', entity_id: 'TARGET-SYN',
  occurred_at: '2026-09-26T10:00:00Z', old_clinic_role: 'viewer', new_clinic_role: 'billing', reason: '<script>unsafe</script>' });
function harness(results) {
  const nodes = new Map(), calls = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', disabled: false,
      listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } });
    return nodes.get(selector);
  };
  const state = { session: { user: { id: 'ACTOR-SYN' } }, profile: { clinic_id: 'CLINIC-A' }, allowed: true };
  let authCallback;
  const db = { auth: { onAuthStateChange(callback) { authCallback = callback; } }, from(table) {
    const call = { table }; calls.push(call);
    const response = results.shift();
    return { select(fields) { call.fields = fields; return this; }, eq(key, value) { call.eq = [key, value]; return this; },
      in(key, values) { call.in = [key, [...values]]; return this; }, order(key, value) { call.order = [key, value]; return this; },
      limit(value) { call.limit = value; return this; }, lt(key, value) { call.lt = [key, value]; return this; },
      then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); } };
  } };
  vm.runInNewContext(source, { document: { querySelector: node }, window: { ChananyaRuntime: {
    getSession: async () => state.session, getProfile: async () => state.profile,
    can: () => state.allowed, getDb: () => db
  } } });
  return { node, state, calls, auth: (event, next) => authCallback(event, next), refresh: () => node('#role-history-refresh').listeners.click(),
    more: () => node('#role-history-more').listeners.click() };
}
const app = harness([{ data: Array.from({ length: 51 }, (_, i) => row(100-i)) }, { data: [row(50),row(49)] },
  { error: new Error('must not expose database internals') }]);
await app.refresh();
assert.equal(app.calls[0].table,'audit_logs');
assert.deepEqual(app.calls[0].eq,['clinic_id','CLINIC-A']);
assert.deepEqual(app.calls[0].in,['action',['assign_staff_role','assign_department_role','set_system_role']]);
assert.equal(app.calls[0].limit,51);
assert.ok(!app.calls[0].fields.split(',').includes('metadata'), 'do not fetch arbitrary metadata');
assert.match(app.node('#role-history-list').innerHTML,/viewer → billing/);
assert.match(app.node('#role-history-list').innerHTML,/ไม่มีค่าบันทึก/);
assert.match(app.node('#role-history-list').innerHTML,/&lt;script&gt;/);
assert.doesNotMatch(app.node('#role-history-list').innerHTML,/<script>/);
assert.equal(app.node('#role-history-more').disabled,false);
await app.more();
assert.deepEqual(app.calls[1].lt,['id','51']);
assert.match(app.node('#role-history-status').textContent,/52 รายการ/);
assert.equal(app.node('#role-history-more').disabled,true);
await app.refresh();
assert.match(app.node('#role-history-status').textContent,/ไม่สำเร็จ/);
assert.doesNotMatch(app.node('#role-history-status').textContent,/database internals/);
assert.equal(app.node('#role-history-more').disabled,true);
const denied = harness([]); denied.state.allowed=false;
await denied.refresh(); assert.equal(denied.calls.length,0);
denied.state.session=null;
await denied.refresh(); assert.equal(denied.calls.length,0);
const expired = harness([{ data: Array.from({length:51},(_,i)=>row(100-i)) }]);
await expired.refresh();
expired.state.session=null;
await expired.more();
assert.equal(expired.calls.length,1);
assert.equal(expired.node('#role-history-list').textContent,'ยังยืนยันรายการประวัติไม่ได้');
assert.equal(expired.node('#role-history-more').disabled,true);
const switched = harness([{ data: Array.from({length:51},(_,i)=>row(100-i)) }, {error:new Error('unavailable')}]);
await switched.refresh();
switched.state.profile={clinic_id:'CLINIC-B'};
await switched.more();
assert.deepEqual(switched.calls[1].eq,['clinic_id','CLINIC-B']);
assert.equal(switched.calls[1].lt,undefined);
assert.equal(switched.node('#role-history-list').textContent,'ยังยืนยันรายการประวัติไม่ได้');
assert.equal(switched.node('#role-history-more').disabled,true);

let release;
const first = new Promise(resolve => { release=resolve; });
const raced = harness([first,{data:[row(200)]}]);
const old = raced.refresh();
await new Promise(resolve => setImmediate(resolve));
await raced.refresh();
release({data:[{...row(100),entity_id:'STALE-TARGET'}]});
await old;
assert.doesNotMatch(raced.node('#role-history-list').innerHTML,/STALE-TARGET/);
for (const invalid of [
  [row(20),row(20)], [row(20),row(21)], [null], [row(0)], [row('001')],
  [row(Number.MAX_SAFE_INTEGER+1)], Array.from({length:52},(_,i)=>row(200-i))
]) {
  const bad=harness([{data:invalid}]);
  await bad.refresh();
  assert.match(bad.node('#role-history-status').textContent,/ไม่สำเร็จ/);
  assert.doesNotMatch(bad.node('#role-history-status').textContent,/โหลดครบ/);
  assert.equal(bad.node('#role-history-more').disabled,true);
}
const overlap=harness([{data:Array.from({length:51},(_,i)=>row(100-i))},{data:[row(51),row(50)]}]);
await overlap.refresh();
const verifiedPage=overlap.node('#role-history-list').innerHTML;
await overlap.more();
assert.equal(overlap.node('#role-history-list').innerHTML,verifiedPage,'invalid next page cannot contaminate verified history');
assert.match(overlap.node('#role-history-status').textContent,/ไม่สำเร็จ/);
assert.equal(overlap.node('#role-history-more').disabled,false,'retain the original cursor so the failed page can be retried');
const precise=harness([{data:[row('9007199254740993'),row('9007199254740992')]}]);
await precise.refresh();
assert.match(precise.node('#role-history-status').textContent,/2 รายการ/);
for (const [event, next] of [['SIGNED_OUT', null], ['SIGNED_IN', { user: { id: 'OTHER-SYN' } }]]) {
  let resolveRead;
  const held = new Promise(resolve => { resolveRead = resolve; });
  const account = harness([{data:[row(300)]}, held]);
  await account.refresh();
  const loading = account.refresh();
  await new Promise(resolve => setImmediate(resolve));
  account.auth(event, next);
  resolveRead({data:[{...row(200),entity_id:'LATE-OLD-ACCOUNT'}]});
  await loading;
  assert.equal(account.node('#role-history-list').textContent, '');
  assert.doesNotMatch(account.node('#role-history-list').innerHTML, /LATE-OLD-ACCOUNT/);
  assert.match(account.node('#role-history-status').textContent, /บัญชีเปลี่ยน/);
  assert.equal(account.node('#role-history-more').disabled, true);
  assert.equal(account.node('#role-history-refresh').disabled, true);
  await account.refresh(); await account.more();
  assert.equal(account.calls.length, 2, 'blocked history must not make new reads');
}
const renewed = harness([{data:[row(300)]}, {data:[row(200)]}]);
await renewed.refresh();
renewed.auth('TOKEN_REFRESHED', {user:{id:'ACTOR-SYN'}});
await renewed.refresh();
assert.equal(renewed.calls.length, 2);
assert.match(renewed.node('#role-history-status').textContent, /1 รายการ/);
console.log('Admin role history UI passed: scoped reads, pagination, malformed-page rejection, account invalidation and token refresh');
