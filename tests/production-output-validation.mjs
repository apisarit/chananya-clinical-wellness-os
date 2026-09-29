// Exercise the actual browser handler; no hosted API or real production records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../production.js', import.meta.url), 'utf8');
function fixture(values) {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { value: '', textContent: '', addEventListener() {}, close() { this.closed = true; }, classList: { add() {}, remove() {} } });
    return nodes.get(key);
  };
  ['actual', 'loss', 'waste'].forEach((name, i) => { node(`#complete-${name}`).value = values[i]; });
  const calls = [];
  const context = { console, Intl, window: { setTimeout() {} }, document: { querySelector: node, querySelectorAll: () => [] } };
  vm.runInNewContext(source.replace('  init();\n})();', `
    persistenceReady=true;session={user:{id:'synthetic'}};profile={id:'synthetic'};activeOrderId='synthetic-order';
    globalThis.hooks={saveCompletedOrder,messageFor,setup(database){db=database;load=async()=>{};}};
  })();`), context);
  context.hooks.setup({ async rpc(name, args) { calls.push({ name, args }); return { data: { id: 'synthetic-order' } }; } });
  const control = { disabled: false };
  return { calls, node, control, hooks: context.hooks, event: { preventDefault() {}, currentTarget: { querySelectorAll: () => [control] } } };
}
let rejected = 0;
for (let position = 0; position < 3; position++) {
  for (const bad of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e309', 'not-a-number', '-1']) {
    const values = ['10', '0', '0']; values[position] = bad;
    const f = fixture(values);
    await assert.rejects(f.hooks.saveCompletedOrder(f.event), /PRODUCTION_OUTPUT_VALUE_INVALID/);
    assert.equal(f.calls.length, 0, `Invalid ${position}:${bad} must not dispatch`);
    assert.equal(f.node('#complete-dialog').closed, undefined);
    assert.equal(f.control.disabled, false);
    assert.match(f.hooks.messageFor(new Error('PRODUCTION_OUTPUT_VALUE_INVALID')), /จำนวน/);
    rejected++;
  }
}
const zero = fixture(['0', '0', '0']);
await assert.rejects(zero.hooks.saveCompletedOrder(zero.event), /PRODUCTION_OUTPUT_VALUE_INVALID/);
assert.equal(zero.calls.length, 0);
const valid = fixture(['10.5', '0', '0.25']);
await valid.hooks.saveCompletedOrder(valid.event);
assert.equal(valid.calls.length, 1);
assert.equal(valid.calls[0].args.p_actual_quantity, 10.5);
assert.equal(valid.calls[0].args.p_loss_quantity, 0);
assert.equal(valid.calls[0].args.p_waste_quantity, 0.25);
assert.equal(valid.node('#complete-dialog').closed, true);
console.log(`Production output validation: ${rejected + 1} invalid inputs blocked before RPC; valid decimals and explicit zero loss/waste preserved.`);
