import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const nodes = new Map();
function get(key) {
  if (!nodes.has(key)) nodes.set(key, {
    value: '', textContent: '', innerHTML: '', events: {},
    classList: { add() {}, remove() {} },
    addEventListener(name, handler) { this.events[name] = handler; }
  });
  return nodes.get(key);
}
const requests = [];
let authCallback;
const db = { auth: { onAuthStateChange(callback) { authCallback = callback; } },
  rpc: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = () => get('#outcomes-filter').events.submit({ preventDefault() {} });
function succeed(index, label) {
  requests[index].resolve({ data: [{ total_sessions: 1 }] });
  requests[index + 1].resolve({ data: [{ patient_name: label }] });
}
vm.runInNewContext(await fs.readFile(new URL('../outcomes.js', import.meta.url), 'utf8'), {
  document: { querySelector: get }, console: { error() {} },
  window: { ChananyaRuntime: { getDb: () => db,
    getSession: async () => ({ user: { id: 'synthetic' } }),
    getProfile: async () => ({}), can: () => true } },
  location: { replace() { throw Error('Unexpected redirect'); } }
});
await tick();
submit();
succeed(2, 'LATEST');
await tick();
succeed(0, 'STALE');
await tick();
assert.match(get('#outcomes-list').innerHTML, /LATEST/);
assert.doesNotMatch(get('#outcomes-list').innerHTML, /STALE/);
submit();
assert.equal(get('#outcomes-list').innerHTML, '');
assert.equal(get('#outcomes-total').textContent, 'รอข้อมูล');
submit();
succeed(6, 'RECOVERED');
await tick();
requests[4].reject(Error('OLD FAILURE'));
requests[5].resolve({ data: [] });
await tick();
assert.match(get('#outcomes-list').innerHTML, /RECOVERED/);
assert.doesNotMatch(get('#outcomes-meta').textContent, /OLD FAILURE/);
submit();
requests[8].resolve({ error: { message: 'CURRENT FAILURE' } });
requests[9].resolve({ data: [] });
await tick();
assert.equal(get('#outcomes-list').innerHTML, '');
assert.equal(get('#outcomes-meta').textContent, 'CURRENT FAILURE');
submit();
get('#outcomes-from').value = '';
submit();
await tick();
succeed(10, 'INVALIDATED');
await tick();
assert.equal(get('#outcomes-list').innerHTML, '');
assert.match(get('#outcomes-meta').textContent, /กรุณาระบุช่วงวันที่/);
get('#outcomes-from').value = '2026-01-01';
authCallback('TOKEN_REFRESHED', { user: { id: 'synthetic' } });
submit();
assert.equal(requests.length, 14);
authCallback('SIGNED_IN', { user: { id: 'different-account' } });
succeed(12, 'OLD ACCOUNT');
await tick();
assert.equal(get('#outcomes-list').innerHTML, '');
assert.equal(get('#app').inert, true);
assert.match(get('#boot-error').textContent, /บัญชีเปลี่ยน/);
submit();
assert.equal(requests.length, 14, 'Blocked account must not issue another RPC');
console.log('Outcomes refresh ordering passed: stale successes/errors ignored, current failures clear prior results, invalid range invalidates pending reads. Synthetic controller only.');
