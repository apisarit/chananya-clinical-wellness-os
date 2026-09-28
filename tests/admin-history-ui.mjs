import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Actual Admin loader/renderers with synthetic, independent API responses.
// No live account, approval decision or data write is performed.
const source = fs.readFileSync(new URL('../admin.js', import.meta.url), 'utf8');
const action = { id: 'ACTION-SYN', task_id: 'TASK-SYN', action: 'approve',
  action_by: 'ACTOR-SYN', from_status: 'pending', to_status: 'approved',
  notes: '<script>unsafe</script>', acted_at: '2026-09-26T10:00:00Z' };
const task = { id: 'TASK-SYN', task_no: 'TASK-001', title: 'Synthetic decision', status: 'approved' };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function harness(responses, staffResponses = [], configuration = {}) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', value: '', disabled: false,
      dataset: {}, listeners: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { this.listeners[type] = callback; } });
    return nodes.get(selector);
  };
  let decisionWrites = 0;
  let authCallback;
  const api = { auth: { onAuthStateChange(callback) { authCallback = callback; } },
    async rpc() { decisionWrites++; if (configuration.rpc) return configuration.rpc;
      throw new Error('Unexpected decision write'); }, from(table) {
    const result = responses[table]?.shift();
    assert.notEqual(result, undefined, `unexpected read of ${table}`);
    return { select() { return this; }, order() { return this; }, limit() { return this; },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } };
  } };
  const sandbox = { console, setTimeout: () => 0, clearTimeout() {}, alert() {}, prompt: () => configuration.notes ?? null,
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: { dispatchEvent() {}, ChananyaRuntime: {
      getDb: () => api, getSession: async () => ({ user: { id: 'ACTOR-SYN' } }),
      getProfile: () => configuration.profile || Promise.resolve({ id: 'ACTOR-SYN' }),
      rolesOf: () => ({ systemRole: 'admin' }), can: () => true,
      accountRequest: async () => {
      const result = staffResponses.shift();
      if (result instanceof Error) throw result;
      return result || { users: [] };
    } } }, document: { querySelector: node, querySelectorAll: () => [] } };
  const instrumented = source.replace('  init();\n})();',
    '  globalThis.hooks={init,load,decide,saveTask,saveStaffRole,saveSystemRole,setDb(value){db=value;session={user:{id:"ACTOR-SYN"}};watchAccount();},snapshot(){return data;}};\n})();');
  assert.notEqual(instrumented, source, 'test must instrument the real loader');
  vm.runInNewContext(instrumented, sandbox);
  sandbox.hooks.setDb(api);
  return { ...sandbox.hooks, node, decisionWrites: () => decisionWrites,
    auth: (event, next) => authCallback(event, next) };
}
const ok = data => ({ data });
const failure = { error: new Error('Synthetic permission/network failure') };
const app = harness({ approval_tasks: [ok([task]), ok([task]), ok([task])],
  approval_actions: [ok([action]), failure, ok([action])], admin_task_summary: [ok([{ pending: 3 }]), failure, ok([{ pending: 0 }])] },
  [new Error('Synthetic staff list unavailable'), { users: [] }]);
await app.load();
assert.equal(app.snapshot().actions.length, 1, 'staff directory failure must not hide approvals');
assert.match(app.node('#action-list').innerHTML, /Synthetic decision/);
assert.match(app.node('#action-list').innerHTML, /ACTOR-SYN/);
assert.ok(!app.node('#action-list').innerHTML.includes('<script>'));
assert.match(app.node('#action-list').innerHTML, /&lt;script&gt;/);
await app.load();
assert.equal(app.snapshot().actions.length, 0, 'failed refresh must not masquerade as current old history');
const failedHistory = app.node('#action-list').innerHTML + app.node('#action-list').textContent;
assert.match(failedHistory, /โหลด|ผิดพลาด|ไม่สำเร็จ/);
assert.doesNotMatch(failedHistory, /ไม่พบการตัดสินใจ/);
assert.notEqual(String(app.node('#stat-pending').textContent), '0', 'failed summary is unknown, not zero');
const refreshEvent = { currentTarget: app.node('#refresh-history') };
const refresh = app.node('#refresh-history').listeners.click(refreshEvent);
refreshEvent.currentTarget = null; // Real DOM clears currentTarget after dispatch.
await refresh;
assert.equal(app.snapshot().actions.length, 1, 'visible retry must recover history');
assert.equal(app.node('#refresh-history').disabled, false);
await app.decide('TASK-SYN','approve');
assert.equal(app.decisionWrites(), 0, 'cancelling the notes prompt must not approve a task');

const slowStaff = deferred();
const partial = harness({ approval_tasks: [ok([task])], approval_actions: [ok([action])],
  admin_task_summary: [ok([{ pending: 0 }])] }, [slowStaff.promise]);
const partialLoad = partial.load();
await new Promise(resolve => setImmediate(resolve));
assert.match(partial.node('#action-list').innerHTML,/Synthetic decision/,
  'available approvals must render without waiting for the staff directory');
slowStaff.resolve({ users: [] });
await partialLoad;

const slowSummary = deferred();
const preserving = harness({ approval_tasks: [ok([task])], approval_actions: [ok([action])],
  admin_task_summary: [slowSummary.promise] }, [{ users: [{ id: 'USER-SYN', access_status: 'active' }] }]);
const preservingLoad = preserving.load();
await new Promise(resolve => setImmediate(resolve));
preserving.node('#staff-user').value = 'USER-SYN';
preserving.node('#system-user').value = 'USER-SYN';
slowSummary.resolve(ok([{ pending: 0 }]));
await preservingLoad;
assert.equal(preserving.node('#staff-user').value,'USER-SYN','late unrelated results must not clear staff selection');
assert.equal(preserving.node('#system-user').value,'USER-SYN');

const oldTasks = deferred(), oldActions = deferred(), oldSummary = deferred();
const raced = harness({ approval_tasks: [oldTasks.promise, ok([{ ...task, title: 'Newest task' }])],
  approval_actions: [oldActions.promise, ok([{ ...action, id: 'NEWEST' }])],
  admin_task_summary: [oldSummary.promise, ok([{ pending: 7 }])] });
const oldLoad = raced.load();
await raced.load();
oldTasks.resolve(ok([{ ...task, title: 'Stale task' }]));
oldActions.resolve(ok([{ ...action, id: 'STALE' }]));
oldSummary.resolve(ok([{ pending: 99 }]));
await oldLoad;
assert.equal(raced.snapshot().actions[0].id, 'NEWEST');
assert.equal(raced.snapshot().summary.pending, 7);
assert.match(raced.node('#action-list').innerHTML, /Newest task/);
for (const [event, next] of [['SIGNED_OUT', null], ['SIGNED_IN', { user: { id: 'OTHER-SYN' } }]]) {
  const held = deferred();
  const scoped = harness({ approval_tasks: [held.promise], approval_actions: [held.promise], admin_task_summary: [held.promise] }, [held.promise]);
  const loading = scoped.load();
  scoped.auth(event, next);
  held.resolve(ok([action]));
  await loading;
  assert.equal(scoped.snapshot().actions.length, 0, 'late history must not return after account change');
  assert.equal(scoped.node('#app').inert, true);
  assert.match(scoped.node('#boot-error').textContent, /บัญชีเปลี่ยน/);
  await assert.rejects(scoped.decide('TASK-SYN', 'approve'), /บัญชีเปลี่ยน/);
  for (const name of ['saveTask', 'saveStaffRole', 'saveSystemRole']) {
    await assert.rejects(scoped[name]({ preventDefault() {} }), /บัญชีเปลี่ยน/);
  }
  assert.equal(await scoped.load(), false, 'blocked page must not start another read');
  assert.equal(scoped.decisionWrites(), 0);
}
const refreshing = harness({ approval_tasks: [ok([task])], approval_actions: [ok([action])], admin_task_summary: [ok([])] });
refreshing.auth('TOKEN_REFRESHED', { user: { id: 'ACTOR-SYN' } });
await refreshing.load();
assert.equal(refreshing.snapshot().actions.length, 1, 'same-account token refresh remains usable');

const committed = deferred();
const writing = harness({}, [], { notes: 'Synthetic approval', rpc: committed.promise });
const decision = writing.decide('TASK-SYN', 'approve');
assert.equal(writing.decisionWrites(), 1);
writing.auth('SIGNED_OUT', null);
committed.resolve({ data: {} });
await decision;
assert.equal(writing.node('#toast').textContent, '', 'old-account acknowledgement must not render');
assert.equal(writing.decisionWrites(), 1, 'no replay after account change');
const profileRead = deferred();
const booting = harness({}, [], { profile: profileRead.promise });
const boot = booting.init();
await new Promise(resolve => setImmediate(resolve));
booting.auth('SIGNED_OUT', null);
profileRead.resolve({ id: 'ACTOR-SYN' });
await boot;
assert.equal(booting.node('#app').inert, true, 'late profile cannot unlock the page');
assert.match(booting.node('#boot-error').textContent, /บัญชีเปลี่ยน/);
console.log('Admin history UI passed: source failure, errors, escaped decisions, stale reads, account changes, blocked writes and same-account token refresh');
