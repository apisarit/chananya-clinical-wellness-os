import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../appointments.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/migrations/20260919214500_appointment_schedule_self_service.sql', import.meta.url), 'utf8');

assert.match(html, /id="schedule-form"/);
assert.match(html, /id="schedule-practitioner"[^>]*required/);
assert.match(html, /id="schedule-start" type="datetime-local" required/);
assert.match(html, /id="schedule-end" type="datetime-local" required/);
assert.match(html, /บันทึกช่วงเวลาและเลือกเพื่อจอง/);

assert.match(js, /rpc\('list_appointment_practitioners'\)/);
assert.match(js, /rpc\('create_practitioner_schedule'/);
assert.match(js, /ยังไม่มีช่วงเวลาที่เปิดรับนัด/);
assert.match(js, /selectSchedule\(result\.data\.id\)/);
assert.match(js, /new Date\(\$\('#schedule-start'\)\.value\)/);
assert.match(js, /new Date\(\$\('#schedule-end'\)\.value\)/);

assert.match(sql, /create or replace function public\.is_appointment_operator\(\)/i);
assert.match(sql, /p\.system_role in \('admin','super_admin'\)/i);
assert.match(sql, /create or replace function public\.list_appointment_practitioners\(\)/i);
assert.match(sql, /create or replace function public\.create_practitioner_schedule\(/i);
assert.match(sql, /perform public\.assert_clinic_subscription_active\(v_clinic_id\)/i);
assert.match(sql, /m\.clinic_role in \('practitioner','doctor'\)/i);
assert.match(sql, /p_starts_at <= now\(\)/i);
assert.match(sql, /grant execute on function public\.create_practitioner_schedule[\s\S]+to authenticated/i);
assert.doesNotMatch(sql, /grant execute[\s\S]+to anon/i);

// Execute the actual schedule loader against synthetic rows, without live writes.
const nodes = new Map();
const element = key => {
  if (!nodes.has(key)) nodes.set(key, { value: '', textContent: '', innerHTML: '', addEventListener() {} });
  return nodes.get(key);
};
let selectedWindows = [];
let fixtureRows = [];
const query = {
  select() { return this; }, gt() { return this; }, order() { return this; },
  gte() { return this; }, lte() { return this; },
  then(resolve) { return Promise.resolve({ data: fixtureRows, error: null }).then(resolve); }
};
const sandbox = { document: {
  querySelector: element,
  querySelectorAll: selector => selector.endsWith(':checked') ? selectedWindows.map(value => ({ value })) : []
}, console };
vm.runInNewContext(js.replace('  init();', '  globalThis.testLoader = loadSchedules; db = globalThis.testDb;'), Object.assign(sandbox, { testDb: { from: () => query } }));
fixtureRows = ['03:00', '05:00', '06:00', '08:00', '11:00', '14:00'].map((time, i) => ({ id: String(i), title: `slot-${i}`, starts_at: `2026-09-20T${time}:00Z`, ends_at: `2026-09-20T${time}:00Z`, available_capacity: 1, max_patients: 1 }));
for (const [selection, count] of [[[], 6], [['10:00-12:00'], 1], [['13:00-15:00'], 1], [['15:00-18:00'], 1], [['18:00-21:00'], 1], [['10:00-12:00', '18:00-21:00'], 2]]) {
  selectedWindows = selection;
  await sandbox.testLoader();
  assert.equal(element('#schedule-status').textContent, `พบ ${count} ช่วงเวลาที่ว่าง`);
}
fixtureRows = [];
await sandbox.testLoader();
assert.match(element('#schedule-status').textContent, /ไม่พบตารางเปิดรับนัด/);
for (const window of ['10:00-12:00', '13:00-15:00', '15:00-18:00', '18:00-21:00']) assert.ok(html.includes(`value="${window}"`));

console.log('Appointment scheduling contract passed: empty-state recovery, tenant-bound operator authorization, schedule creation and auto-selection are present');
