// Actual Pharmacy load/act functions; API, rendering and notifications are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../pharmacy.js', import.meta.url), 'utf8');

function extract(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return source.slice(start, end);
}

const functions = extract('  async function load()', '  function startQueueRefresh()')
  + extract('  function requirePersistence()', '  function requireAccount()')
  + extract('  async function act(', '  function syncSalePatient()');

async function scenario({ failOld = false, failFresh = false, code = functions } = {}) {
  let releaseOld;
  const held = new Promise((resolve, reject) => {
    releaseOld = () => failOld
      ? reject(new Error('synthetic old read failure'))
      : resolve([]);
  });
  const events = [];
  const renders = [];
  const messages = [];
  let generation = 0;
  let committed = false;
  let writes = 0;
  let failCurrentFreshRead = failFresh;
  const status = { textContent: '' };
  const staleList = { textContent: 'stale actionable queue' };
  const staleSelect = { innerHTML: '<option>stale product</option>' };
  let dialogClosed = false;

  const context = vm.createContext({
    Map,
    Date,
    Promise,
    $: selector => selector === '#rx-refresh-status' ? status : staleList,
    $$: selector => {
      if (selector === 'dialog[open]') {
        return [{ textContent: 'patient detail', close() { dialogClosed = true; } }];
      }
      if (selector === '#app select') return [staleSelect];
      return [];
    },
    persistenceReady: true,
    requireAccount() {},
    accountBlocked: false,
    toast: message => messages.push(message),
    query(table) {
      if (table === 'products') generation += 1;
      const current = generation;
      events.push(`${current}:${table}`);
      if (table === 'products' && current === 1) return held;
      if (current > 1 && failCurrentFreshRead) {
        return Promise.reject(new Error('synthetic fresh read failure'));
      }
      return Promise.resolve(table === 'dispensing_orders'
        ? [{ id: 'synthetic-order', status: committed ? 'submitted_to_billing' : 'dispensed' }]
        : []);
    },
    db: {
      async rpc(name, args) {
        assert.equal(name, 'transition_atomic_prescription_dispensing');
        assert.equal(args.p_action, 'submit_billing');
        writes += 1;
        committed = true;
        return { data: { status: 'submitted_to_billing' }, error: null };
      },
    },
    capture: state => renders.push(state),
  });

  vm.runInContext(`
    let loadPromise = null;
    let queueReadFailed = false;
    const data = {};
    function render() { capture(data.dispensing[0]?.status); }
    ${code}
  `, context);

  const oldRead = vm.runInContext('load()', context);
  const oldResult = oldRead.catch(() => {});
  const action = vm.runInContext("act('rx-billing', 'synthetic-order')", context);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(generation, 1);

  releaseOld();
  await Promise.all([oldResult, action]);
  assert.equal(writes, 1, 'readback must not replay a committed mutation');
  assert.equal(generation, 2, 'acknowledgement must initiate a fresh read after draining the old read');
  assert.equal(events.filter(value => value.endsWith(':dispensing_orders')).length, 2);

  if (failFresh) {
    assert.equal(vm.runInContext('queueReadFailed', context), true);
    assert.equal(vm.runInContext('data.dispensing.length', context), 0);
    assert.match(staleList.textContent, /ไม่ได้หมายความว่าไม่มีงาน/);
    assert.equal(staleSelect.innerHTML, '');
    assert.equal(dialogClosed, true);
    await assert.rejects(
      vm.runInContext("act('rx-billing', 'synthetic-order')", context),
      /รีเฟรชคิว/
    );
    assert.equal(writes, 1, 'failed readback must suppress a second write');
    assert.match(status.textContent, /แล้ว.*โหลดรายการล่าสุดไม่สำเร็จ/);
    assert.match(messages.at(-1), /รีเฟรชคิว/);

    failCurrentFreshRead = false;
    await vm.runInContext('load()', context);
    assert.equal(vm.runInContext('queueReadFailed', context), false, 'a successful manual refresh unlocks actions');
    vm.runInContext('requirePersistence()', context);
    assert.equal(renders.at(-1), 'submitted_to_billing');
    assert.equal(writes, 1, 'recovery read must not replay the acknowledged mutation');
  } else {
    assert.equal(vm.runInContext('queueReadFailed', context), false);
    assert.equal(renders.at(-1), 'submitted_to_billing');
    assert.match(status.textContent, /อัปเดต/);
    assert.match(messages.at(-1), /ส่ง Checkout/);
  }
}

await scenario();
await scenario({ failOld: true });
await scenario({ failFresh: true });

const oldBehavior = functions.replace('if (loadPromise) await loadPromise.catch(() => {});', '');
assert.notEqual(oldBehavior, functions);
await assert.rejects(
  scenario({ code: oldBehavior }),
  /acknowledgement must initiate a fresh read/
);

console.log('Pharmacy refresh ordering passed: acknowledged writes drain stale reads, then prove state with one fresh read and safe recovery.');
