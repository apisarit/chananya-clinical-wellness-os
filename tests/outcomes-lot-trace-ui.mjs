import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const encounter = '00000000-0000-4000-8000-000000000001';
const nodes = new Map();
const get = key => {
  if (!nodes.has(key)) nodes.set(key, { value: '', innerHTML: '', textContent: '', events: {},
    classList: { add() {}, remove() {} }, contains: () => true,
    addEventListener(name, handler) { this.events[name] = handler; } });
  return nodes.get(key);
};
let auth;
const reads = [];
const db = { auth: { onAuthStateChange(cb) { auth = cb; } }, rpc(name, args) {
  if (name === 'clinical_outcomes_summary') return Promise.resolve({ data: [] });
  if (name === 'search_clinical_outcomes') return Promise.resolve({ data: [{ encounter_id: encounter, herbal_lots: ['pending'] }] });
  assert.equal(name, 'clinical_outcome_lot_trace');
  assert.equal(args.p_encounter_id, encounter);
  return new Promise((resolve, reject) => reads.push({ resolve, reject }));
} };
vm.runInNewContext(await fs.readFile(new URL('../outcomes.js', import.meta.url), 'utf8'), {
  document: { querySelector: get }, console: { error() {} },
  window: { ChananyaRuntime: { getDb: () => db, getSession: async () => ({ user: { id: 'actor' } }),
    getProfile: async () => ({}), can: () => true } }, location: { replace() {} }
});
const tick = () => new Promise(resolve => setImmediate(resolve));
await tick();
assert.match(get('#outcomes-list').innerHTML, /ยังไม่ยืนยันการจ่าย/);
const result = { textContent: '', innerHTML: '' };
const button = { dataset: { outcomeTrace: '0' }, disabled: false,
  parentElement: { querySelector: () => result } };
const click = () => get('#outcomes-list').events.click({ target: { closest: () => button } });
const valid = () => ({ encounter_id: encounter, scope: 'encounter', link_conflict_count: 0,
  complete: false, entries: [{ state: 'recorded_dispense', lot_number: '<img src=x>',
    stock_state: 'movement_missing', production_state: 'production_source_unavailable', receipt_quantity_state: 'not_evaluable',
    prescription_quantity_state: 'under_prescribed_quantity' }] });
click(); click();
assert.equal(reads.length, 1, 'Double click is one read');
reads[0].resolve({ data: valid() }); await tick();
assert.match(result.innerHTML, /&lt;img src=x&gt;/);
assert.match(result.innerHTML, /ไม่พบรายการตัดสต็อก/);
assert.match(result.innerHTML, /หลักฐานบางส่วนเท่านั้น/);
assert.equal(button.disabled, false);
for (const response of [{ error: { message: 'secret database detail' } },
  { data: { ...valid(), encounter_id: 'foreign' } }, { data: { ...valid(), entries: [null] } }]) {
  click(); reads.at(-1).resolve(response); await tick();
  assert.match(result.textContent, /ยังตรวจไม่ได้/);
  assert.doesNotMatch(result.textContent, /secret/);
}
click(); reads.at(-1).resolve({ data: { ...valid(), entries: [] } }); await tick();
assert.match(result.innerHTML, /ไม่ได้ยืนยันว่าหลักฐานครบ/);
click(); reads.at(-1).resolve({ error: { message: 'OUTCOME_TRACE_RESULT_LIMIT_EXCEEDED' } }); await tick();
assert.match(result.textContent, /เกินขอบเขต 1,000/);
assert.match(result.textContent, /ไม่ได้แสดงผลบางส่วน/);
assert.equal(button.disabled, false);
click();
get('#outcomes-filter').events.submit({ preventDefault() {} }); await tick();
result.innerHTML = 'NEW PAGE';
reads.at(-1).resolve({ data: valid() }); await tick();
assert.equal(result.innerHTML, 'NEW PAGE', 'Late read cannot paint after filtering');
button.disabled = false;
click();
auth('SIGNED_OUT', null);
result.innerHTML = 'SIGNED OUT';
reads.at(-1).resolve({ data: valid() }); await tick();
assert.equal(result.innerHTML, 'SIGNED OUT');
const count = reads.length;
click(); assert.equal(reads.length, count);
console.log('Outcome lot trace UI: explicit read, partial/missing evidence, safe text, duplicate suppression, filter/sign-out isolation passed. Synthetic controller only.');
