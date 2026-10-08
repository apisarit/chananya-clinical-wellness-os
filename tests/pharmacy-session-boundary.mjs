// Actual Pharmacy controller with a synthetic deferred API; no hosted-session claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../pharmacy.js', import.meta.url), 'utf8');

function fixture(mode) {
  const nodes = new Map();
  const listeners = new Map();
  const buttons = [];
  let authCallback;
  let release;
  let reads = 0;
  let writes = 0;
  let renders = 0;
  let dialogClosed = 0;

  const held = new Promise(resolve => { release = resolve; });
  const node = selector => {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        value: '',
        checked: false,
        textContent: '',
        innerHTML: '',
        inert: false,
        tagName: 'DIV',
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
      });
    }
    return nodes.get(selector);
  };
  const dialog = { textContent: 'sensitive patient context', close() { dialogClosed += 1; } };
  const api = {
    auth: { onAuthStateChange(callback) { authCallback = callback; } },
    from() {
      reads += 1;
      const request = {
        select() { return request; },
        order() { return request; },
        then(resolve, reject) {
          const result = mode === 'read'
            ? held
            : Promise.resolve({ data: [], error: null });
          return result.then(resolve, reject);
        },
      };
      return request;
    },
    rpc() {
      writes += 1;
      return mode === 'write' || mode === 'duplicate'
        ? held
        : Promise.resolve({ data: {}, error: null });
    },
  };
  const sandbox = {
    console,
    Intl,
    setTimeout: () => 1,
    clearTimeout() {},
    alert() {},
    confirm: () => true,
    document: {
      querySelector: node,
      querySelectorAll(selector) {
        if (selector === 'dialog[open]') return [dialog];
        if (selector === '[data-act]') return buttons;
        return [];
      },
      addEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      addEventListener(name, callback) { listeners.set(name, callback); },
    },
    location: { reload() {}, replace() {} },
    api,
    capture() { renders += 1; },
  };

  const instrumented = source.replace(
    '  init();\n})();',
    `  db = api;
  session = { user: { id: 'actor' } };
  persistenceReady = true;
  watchAccount();
  render = () => capture();
  globalThis.__pharmacyBoundary = { load, act, bindActions, state: () => data };
})();`
  );
  assert.notEqual(instrumented, source, 'test hook must replace the Pharmacy bootstrap');
  vm.runInNewContext(instrumented, sandbox);

  return {
    api: sandbox.__pharmacyBoundary,
    addButton(action, id) {
      const button = { dataset: { act: action, id }, disabled: false };
      buttons.push(button);
      return button;
    },
    replaceAccount() { authCallback('SIGNED_IN', { user: { id: 'other' } }); },
    refreshSameAccount() { authCallback('TOKEN_REFRESHED', { user: { id: 'actor' } }); },
    restoreFromCache() { listeners.get('pagehide')({ persisted: true }); },
    release,
    reads: () => reads,
    writes: () => writes,
    renders: () => renders,
    dialogClosed: () => dialogClosed,
    node,
  };
}

const read = fixture('read');
const pendingRead = read.api.load();
read.replaceAccount();
read.release({ data: [{ id: 'OLD-ACCOUNT' }], error: null });
await pendingRead;
assert.equal(read.renders(), 0, 'a late response from the previous account must not render');
assert.ok(Object.values(read.api.state()).every(rows => rows.length === 0));
assert.equal(read.node('#app').inert, true);
assert.equal(read.dialogClosed(), 1, 'account invalidation closes patient-context dialogs');
const readsBeforeBlockedLoad = read.reads();
await read.api.load();
assert.equal(read.reads(), readsBeforeBlockedLoad, 'blocked accounts must not issue more reads');
await assert.rejects(read.api.act('rx-billing', 'order'), /บัญชีเปลี่ยน/);
assert.equal(read.writes(), 0, 'blocked accounts must not issue writes');

const write = fixture('write');
const pendingWrite = write.api.act('rx-billing', 'order');
assert.equal(write.writes(), 1);
write.replaceAccount();
write.release({ data: {}, error: null });
await assert.rejects(pendingWrite, /บัญชีเปลี่ยน/);
assert.equal(write.reads(), 0, 'an old-account write acknowledgement must not trigger readback');
assert.equal(write.node('#toast').textContent, '', 'an old-account acknowledgement must not toast success');

const duplicate = fixture('duplicate');
const button = duplicate.addButton('rx-billing', 'order');
duplicate.api.bindActions();
const firstClick = button.onclick();
const secondClick = button.onclick();
assert.equal(duplicate.writes(), 1, 'the same action key must have only one in-flight write');
assert.equal(button.disabled, true);
duplicate.release({ data: {}, error: null });
await Promise.all([firstClick, secondClick]);
assert.equal(duplicate.writes(), 1);
assert.equal(duplicate.reads(), 11, 'the acknowledged write must receive one full readback, including Price Master and event history');
assert.equal(button.disabled, false);

const same = fixture('normal');
same.refreshSameAccount();
await same.api.load();
assert.equal(same.renders(), 1, 'same-account token refresh remains usable');
same.restoreFromCache();
assert.equal(same.node('#app').inert, true, 'a cached Pharmacy page must be invalidated');

console.log('Pharmacy session boundary passed: account changes block late reads/writes, duplicate actions collapse, same-account refresh remains usable.');
