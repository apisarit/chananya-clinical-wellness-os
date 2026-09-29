import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    value: '', textContent: '', innerHTML: '', disabled: false, handlers: {},
    classList: { add() {}, toggle() {} }, querySelectorAll: () => [],
    reset() { this.resetCount = (this.resetCount || 0) + 1; },
    addEventListener(type, handler) { this.handlers[type] = handler; }
  });
  return nodes.get(selector);
}
const calls = [];
let resolvePending;
let throwList = false;
let holdSave = false;
let readbackMode = 'normal';
const catalog = [{ price_list_id: 'list', item_id: 'item', item_type: 'product', product_id: 'p', service_id: null, item_description: '<script>bad</script>', unit_code: 'capsule', unit_price: 100, item_version: 2, price_list_name: 'Standard' }];
const db = { auth: { onAuthStateChange() {} }, rpc: async (name, args) => {
  calls.push({ name, args });
  if (name === 'list_price_master') return throwList ? { error: { message: 'network failure' } } : { data: readbackMode === 'missing' ? [] : catalog.map(row => ({ ...row })) };
  if (name === 'list_price_master_history') return { data: [{ before_state: { unit_price: 90 }, after_state: { unit_price: 100 }, actor_id: '<actor>', action: 'update', reason: '<reason>', created_at: '2026-09-01T00:00:00Z' }] };
  if (name === 'set_price_master_item') {
    if (holdSave) await new Promise(resolve => { resolvePending = resolve; });
    if (readbackMode !== 'stale') { catalog[0].unit_price = args.p_unit_price; catalog[0].item_version++; }
    return { data: [] };
  }
  return { data: [] };
} };
const sandbox = { console, document: { querySelector: node }, window: { ChananyaRuntime: { getDb: () => db, getSession: async () => ({ user: { id: 'synthetic' } }) } } };
vm.runInNewContext(read('admin-price-master.js').replace('  $(\'#price-edit-form\').addEventListener', '  globalThis.hooks = { load, select, save };\n  $(\'#price-edit-form\').addEventListener'), sandbox);
await sandbox.hooks.load();
assert.match(node('#price-list').innerHTML, /&lt;script&gt;/);
assert.doesNotMatch(node('#price-list').innerHTML, /<script>/);
await sandbox.hooks.select(0);
assert.match(node('#price-history').innerHTML, /&lt;reason&gt;/);
assert.match(node('#price-history').innerHTML, /90\.00.*100\.00/);
node('#price-reason').value = 'new approved rate';
const event = { preventDefault() {} };
for (const amount of ['0', '-1', 'NaN', 'Infinity', '100.001']) {
  node('#price-amount').value = amount;
  await sandbox.hooks.save(event);
}
assert.equal(calls.filter(call => call.name === 'set_price_master_item').length, 0);
node('#price-amount').value = '120.50';
holdSave = true;
const first = sandbox.hooks.save(event);
await sandbox.hooks.save(event);
assert.equal(calls.filter(call => call.name === 'set_price_master_item').length, 1, 'in-flight save cannot double submit');
assert.equal(node('#price-save').disabled, true);

resolvePending();
await first;
const saved = calls.find(call => call.name === 'set_price_master_item').args;
assert.equal(saved.p_expected_version, 2);
assert.equal(saved.p_unit_price, 120.5);
assert.equal(saved.p_unit_code, 'capsule');
assert.equal(saved.p_product_id, 'p');
assert.match(node('#price-status').textContent, /บันทึกราคากลางแล้ว/);
holdSave = false;
throwList = true;
node('#price-amount').value = '125';
node('#price-reason').value = 'new rate';
await sandbox.hooks.save(event);
assert.match(node('#price-status').textContent, /บันทึกราคาแล้ว แต่โหลดกลับไม่สำเร็จ/);
assert.equal(node('#price-save').disabled, true);

// Product quotes run bounded requests; mismatched/missing/non-positive prices
throwList = false;
for (const mode of ['stale', 'missing']) {
  readbackMode = 'normal';
  await sandbox.hooks.load();
  await sandbox.hooks.select(0);
  readbackMode = mode;
  node('#price-amount').value = '150';
  node('#price-reason').value = 'synthetic correction';
  await sandbox.hooks.save(event);
  assert.doesNotMatch(node('#price-status').textContent, /บันทึกราคากลางแล้ว และโหลดรายการกลับ/);
  assert.match(node('#price-status').textContent, mode === 'missing' ? /ไม่พบรายการนี้/ : /ไม่ตรงกับครั้งนี้/);
}
throwList = true;
node('#price-setup-reason').value = 'synthetic setup';
await node('#price-setup-form').handlers.submit(event);
assert.match(node('#price-status').textContent, /รับตั้งราคากลางแล้ว แต่โหลดกลับไม่สำเร็จ/);

// are unusable. A failed resolver never silently supplies a default price.
vm.runInNewContext(read('price-master-client.js'), sandbox);
const helper = sandbox.window.CnyosPriceMaster;
assert.equal(helper.checkedPrice({ unit_price: 0, unit_code: 'capsule' }, 'capsule'), null);
assert.equal(helper.checkedPrice({ unit_price: 100, unit_code: 'box' }, 'capsule'), null);
assert.equal(helper.checkedPrice({ unit_price: 'NaN', unit_code: 'capsule' }, 'capsule'), null);
assert.equal(helper.checkedPrice(null, 'capsule'), null);
let active = 0;
let maxActive = 0;
const quoteDb = { rpc: async (_, args) => {
  active += 1; maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 1));
  active -= 1;
  return { data: args.p_product_id === 'missing' ? [] : [{ unit_price: 100, unit_code: 'capsule' }] };
} };
const quotes = await helper.productQuotes(quoteDb, [...Array.from({ length: 9 }, (_, index) => ({ id: String(index), dispense_unit: 'capsule' })), { id: 'missing', dispense_unit: 'capsule' }]);
assert.ok(maxActive <= 4);
assert.equal(quotes.get('missing'), null);
await assert.rejects(helper.productQuotes({ rpc: async () => ({ error: new Error('denied') }) }, [{ id: 'p' }]), /denied/);
console.log('Price-master UI passed: escaped catalog/history, validation, version payload, duplicate-submit guard, readback failure and bounded authoritative quotes');
