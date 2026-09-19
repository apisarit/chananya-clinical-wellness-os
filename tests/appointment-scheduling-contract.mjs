import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../appointments.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/migrations/20260919214500_appointment_schedule_self_service.sql', import.meta.url), 'utf8');

assert.match(html, /id="schedule-form"/);
assert.match(html, /id="schedule-submit"/);
assert.match(html, /id="booking-submit"/);
assert.match(html, /id="schedule-practitioner"[^>]*required/);
assert.match(html, /id="schedule-start" type="datetime-local" required/);
assert.match(html, /id="schedule-end" type="datetime-local" required/);
assert.match(html, /บันทึกช่วงเวลาและเลือกเพื่อจอง/);

assert.match(js, /rpc\('list_appointment_practitioners'\)/);
assert.match(js, /rpc\('create_practitioner_schedule'/);
assert.match(js, /ยังไม่มีช่วงเวลาที่เปิดรับนัด/);
assert.match(js, /selectSchedule\(result\.data\.id\)/);
assert.match(js, /parseBangkokDateTime\(\$\('#schedule-start'\)\.value\)/);
assert.match(js, /parseBangkokDateTime\(\$\('#schedule-end'\)\.value\)/);
assert.match(js, /if \(endsAt <= startsAt\) throw new Error\('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม'\)/);
assert.match(js, /if \(scheduleCreateInFlight\) return/);
assert.match(js, /if \(bookingInFlight\) return/);
assert.match(js, /\$\('#schedule-submit'\)\.disabled = true/);
assert.match(js, /\$\('#booking-submit'\)\.disabled = true/);
assert.match(js, /await Promise\.all\(\[loadSchedules\(\), loadAppointments\(\)\]\);\s*\$\('#booking-status'\)\.textContent = confirmation/);
assert.match(js, /new Date\(`\$\{day\}T00:00:00\+07:00`\)/);
assert.match(js, /thaiTime\(item\.ends_at\)/);

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
const datePredicates = [];
const query = {
  select() { return this; }, gt() { return this; }, order() { return this; },
  gte(...args) { datePredicates.push(['gte', ...args]); return this; }, lte(...args) { datePredicates.push(['lte', ...args]); return this; },
  then(resolve) { return Promise.resolve({ data: fixtureRows, error: null }).then(resolve); }
};
let patientFixtureRows = [];
const patientCalls = [];
const patientQuery = {
  select(value) { patientCalls.push(['select', value]); return this; },
  eq(...args) { patientCalls.push(['eq', ...args]); return this; },
  order(...args) { patientCalls.push(['order', ...args]); return this; },
  limit(...args) { patientCalls.push(['limit', ...args]); return this; },
  or(...args) { patientCalls.push(['or', ...args]); return this; },
  then(resolve) { return Promise.resolve({ data: patientFixtureRows, error: null }).then(resolve); }
};
const sandbox = { window: { dispatchEvent() {} }, CustomEvent: class {}, document: {
  querySelector: element,
  querySelectorAll: selector => selector.endsWith(':checked') ? selectedWindows.map(value => ({ value })) : []
}, console };
vm.runInNewContext(js.replace('  init();', '  globalThis.testLoader = loadSchedules; globalThis.testLoadPatients = loadPatients; globalThis.testThaiDate = thaiDate; globalThis.testBangkokDateTimeValue = bangkokDateTimeValue; globalThis.testParseBangkokDateTime = parseBangkokDateTime; db = globalThis.testDb;'), Object.assign(sandbox, { testDb: { from: table => table === 'patients' ? patientQuery : query } }));
assert.equal(sandbox.testThaiDate('2026-09-19T18:00:00Z'), '2026-09-20');
assert.equal(sandbox.testBangkokDateTimeValue('2026-09-19T18:05:00Z'), '2026-09-20T01:05');
assert.equal(sandbox.testParseBangkokDateTime('2026-09-20T10:00').toISOString(), '2026-09-20T03:00:00.000Z');
patientFixtureRows = [{ id: 'old-patient', hn: 'HN-0001', first_name: 'ทดสอบ', last_name: 'ระบบ' }];
await sandbox.testLoadPatients('HN-0001,()');
assert.deepEqual(patientCalls.find(call => call[0] === 'select'), ['select', 'id,hn,prefix,first_name,last_name,phone,created_at']);
assert.deepEqual(patientCalls.find(call => call[0] === 'eq'), ['eq', 'active', true]);
assert.deepEqual(patientCalls.find(call => call[0] === 'limit'), ['limit', 100]);
assert.deepEqual(patientCalls.find(call => call[0] === 'or'), ['or', 'hn.ilike.%HN-0001%,first_name.ilike.%HN-0001%,last_name.ilike.%HN-0001%,phone.ilike.%HN-0001%']);
assert.match(element('#patient').innerHTML, /old-patient/);
fixtureRows = ['03:00', '05:00', '06:00', '08:00', '11:00', '14:00'].map((time, i) => {
  const startsAt = new Date(`2026-09-20T${time}:00Z`);
  return { id: String(i), title: `slot-${i}`, starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 30 * 60000).toISOString(), available_capacity: 1, max_patients: 1 };
});
for (const [selection, count] of [[[], 6], [['10:00-12:00'], 1], [['13:00-15:00'], 1], [['15:00-18:00'], 1], [['18:00-21:00'], 1], [['10:00-12:00', '18:00-21:00'], 2]]) {
  selectedWindows = selection;
  await sandbox.testLoader();
  assert.equal(element('#schedule-status').textContent, `พบ ${count} ช่วงเวลาที่ว่าง`);
}
fixtureRows = [];
await sandbox.testLoader();
assert.match(element('#schedule-status').textContent, /ไม่พบตารางเปิดรับนัด/);
for (const window of ['10:00-12:00', '13:00-15:00', '15:00-18:00', '18:00-21:00']) assert.ok(html.includes(`value="${window}"`));
element('#date-from').value = '2026-09-20';
element('#date-to').value = '2026-09-20';
element('#selected-schedule').value = 'stale-selection';
await sandbox.testLoader();
assert.deepEqual(datePredicates.slice(-2), [['gte', 'starts_at', '2026-09-19T17:00:00.000Z'], ['lte', 'starts_at', '2026-09-20T16:59:59.999Z']]);
assert.equal(element('#selected-schedule').value, '');
element('#date-from').value = '2026-09-21';
await sandbox.testLoader();
assert.match(element('#schedule-status').textContent, /วันที่เริ่มต้องไม่อยู่หลัง/);
element('#date-from').value = '';
element('#date-to').value = '';
const deferred = [];
query.then = resolve => new Promise(done => deferred.push(result => done(resolve(result))));
const oldSearch = sandbox.testLoader();
await Promise.resolve();
const newSearch = sandbox.testLoader();
await Promise.resolve();
deferred[1]({ data: [], error: null });
await newSearch;
deferred[0]({ data: [{ title: 'stale result' }], error: null });
await oldSearch;
assert.doesNotMatch(element('#schedule-list').innerHTML, /stale result/);

console.log('Appointment scheduling contract passed: empty-state recovery, tenant-bound operator authorization, schedule creation and auto-selection are present');
