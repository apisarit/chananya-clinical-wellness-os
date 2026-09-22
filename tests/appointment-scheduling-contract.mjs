import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './appointment-availability-regression.mjs';
import './appointment-operator-read-regression.mjs';

const html = fs.readFileSync(new URL('../appointments.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/migrations/20260919214500_appointment_schedule_self_service.sql', import.meta.url), 'utf8');
const dualRoleSql = fs.readFileSync(new URL('../supabase/migrations/20260921015219_appointment_provider_dual_role.sql', import.meta.url), 'utf8');
const cancellationSql = fs.readFileSync(new URL('../supabase/migrations/20260919231610_require_appointment_cancellation_reason.sql', import.meta.url), 'utf8');

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
assert.match(js, /patients!clinic_appointments_patient_clinic_fkey\(id,hn,prefix,first_name,last_name,phone\)/);
assert.match(js, /if \(version !== appointmentRequestVersion\) return/);
assert.match(js, /appointmentStatusLabel\(item\.status\)/);
assert.match(js, /if \(!reason\.trim\(\)\) throw new Error\('กรุณาระบุเหตุผลที่ยกเลิก'\)/);
assert.match(js, /appointmentActionsInFlight\.has\(id\)/);
assert.match(js, /runtime\.can\(profile, 'appointments_clinical_status'\)/);
assert.match(js, /item\.practitioner_id === session\.user\.id/);

assert.match(sql, /create or replace function public\.is_appointment_operator\(\)/i);
assert.match(sql, /p\.system_role in \('admin','super_admin'\)/i);
assert.match(sql, /create or replace function public\.list_appointment_practitioners\(\)/i);
assert.match(sql, /create or replace function public\.create_practitioner_schedule\(/i);
assert.match(sql, /perform public\.assert_clinic_subscription_active\(v_clinic_id\)/i);
assert.match(sql, /m\.clinic_role in \('practitioner','doctor'\)/i);
assert.match(sql, /p_starts_at <= now\(\)/i);
assert.match(sql, /grant execute on function public\.create_practitioner_schedule[\s\S]+to authenticated/i);
assert.doesNotMatch(sql, /grant execute[\s\S]+to anon/i);
assert.match(dualRoleSql, /create or replace function public\.list_appointment_practitioners\(\)/i);
assert.match(dualRoleSql, /m\.clinic_role in \('practitioner','doctor'\)\s+or p\.role in \('practitioner','doctor'\)/i);
assert.match(dualRoleSql, /join public\.profiles p on p\.id = m\.profile_id/i);
assert.match(dualRoleSql, /m\.profile_id = p_practitioner_id/i);
assert.match(dualRoleSql, /revoke all on function public\.list_appointment_practitioners\(\) from public, anon, authenticated, service_role/i);
assert.match(dualRoleSql, /grant execute on function public\.list_appointment_practitioners\(\) to authenticated/i);
assert.doesNotMatch(dualRoleSql, /grant execute[\s\S]+to anon/i);
assert.match(cancellationSql, /nullif\(trim\(p_reason\), ''\) is null then raise exception 'CANCELLATION_REASON_REQUIRED'/i);
assert.match(cancellationSql, /set search_path = pg_catalog, public, pg_temp/i);
assert.match(cancellationSql, /revoke all on function public\.cancel_clinic_appointment\(uuid,text\) from public, anon, authenticated, service_role/i);
assert.match(cancellationSql, /grant execute on function public\.cancel_clinic_appointment\(uuid,text\) to authenticated/i);
assert.match(cancellationSql, /v_old = 'checked_in' and p_new_status = 'in_service'/i);
assert.match(cancellationSql, /v_old = 'in_service' and p_new_status = 'completed'/i);
assert.match(cancellationSql, /raise exception 'INVALID_APPOINTMENT_TRANSITION'/i);
assert.doesNotMatch(cancellationSql, /p_new_status not in \([^\n]*'cancelled'/i);
assert.match(cancellationSql, /revoke all on function public\.set_clinic_appointment_status\(uuid,text,text\) from public, anon, authenticated, service_role/i);

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
vm.runInNewContext(js.replace('  init();', '  globalThis.testLoader = loadSchedules; globalThis.testLoadPatients = loadPatients; globalThis.testThaiDate = thaiDate; globalThis.testBangkokDateTimeValue = bangkokDateTimeValue; globalThis.testParseBangkokDateTime = parseBangkokDateTime; globalThis.testRenderBookingDates = renderBookingDates; globalThis.testRenderBookingTimes = renderBookingTimes; globalThis.testRenderBookingRooms = renderBookingRooms; globalThis.testResolveBookingRoom = resolveBookingRoom; db = globalThis.testDb;'), Object.assign(sandbox, { testDb: { from: table => table === 'patients' ? patientQuery : query } }));
assert.equal(sandbox.testThaiDate('2026-09-19T18:00:00Z'), '2026-09-20');
assert.equal(sandbox.testBangkokDateTimeValue('2026-09-19T18:05:00Z'), '2026-09-20T01:05');
assert.equal(sandbox.testParseBangkokDateTime('2026-09-20T10:00').toISOString(), '2026-09-20T03:00:00.000Z');
// Exercise the actual card renderer, including honest missing-data states.
const cards = { document: sandbox.document, console };
vm.runInNewContext(js.replace('  init();', '  globalThis.renderCard = scheduleCard; globalThis.label = scheduleLabel;'), cards);
const slot = { id: 'synthetic-slot', title: 'ตรวจและรับบริการ', starts_at: '2026-09-23T03:00:00Z', ends_at: '2026-09-23T05:00:00Z', available_capacity: 1, max_patients: 2, branch_code: 'MAIN', room_code: 'ROOM-2' };
for (const missing of [null, '', '   ', '-']) {
  const card = cards.renderCard({ ...slot, practitioner_name: missing, specialty_name_th: missing }, true);
  assert.match(card, /ผู้ให้บริการ: ยังไม่พบชื่อผู้ให้บริการ/);
  assert.match(card, /กรุณาตรวจสอบผู้ให้บริการ/);
  assert.doesNotMatch(card, /<span>-<\/span>|ความเชี่ยวชาญ:/);
  assert.match(card, /เหลือ 1 ที่ จาก 2 ที่/);
  assert.doesNotMatch(cards.label({ ...slot, practitioner_name: missing }), /• - •/);
}
const named = cards.renderCard({ ...slot, practitioner_name: 'แพทย์ทดสอบ', specialty_name_th: 'แพทย์แผนไทย' }, true);
assert.match(named, /ผู้ให้บริการ: แพทย์ทดสอบ/);
assert.match(named, /จองกับ แพทย์ทดสอบ/);
assert.match(named, /ความเชี่ยวชาญ: แพทย์แผนไทย/);
assert.doesNotMatch(named, /กรุณาตรวจสอบผู้ให้บริการ/);
assert.doesNotMatch(cards.renderCard(slot, false), /data-book=/);
const escaped = cards.renderCard({ ...slot, practitioner_name: '<img src=x onerror=alert(1)>', specialty_name_en: '<script>bad</script>', id: 'x" onclick="bad' }, true);
assert.doesNotMatch(escaped, /<img|<script|data-book="x" onclick=/);
assert.match(escaped, /&lt;img/);
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
// Practitioner-first chain: same time is not resolved until branch/room is chosen.
const sharedStart = new Date('2026-09-23T03:00:00Z').toISOString();
const sharedEnd = new Date('2026-09-23T04:00:00Z').toISOString();
fixtureRows = [
  { id: 'room-a', practitioner_id: 'prac-a', practitioner_name: 'ผู้ให้บริการ A', title: 'ช่วงเช้า', starts_at: sharedStart, ends_at: sharedEnd, available_capacity: 1, max_patients: 1, branch_code: 'MAIN', room_code: 'A' },
  { id: 'room-b', practitioner_id: 'prac-a', practitioner_name: 'ผู้ให้บริการ A', title: 'ช่วงเช้า', starts_at: sharedStart, ends_at: sharedEnd, available_capacity: 1, max_patients: 1, branch_code: 'NORTH', room_code: 'B' }
];
await sandbox.testLoader();
element('#booking-practitioner').value = 'prac-a';
sandbox.testRenderBookingDates();
element('#booking-date').value = '2026-09-23';
sandbox.testRenderBookingTimes();
element('#booking-time').value = `${sharedStart}|${sharedEnd}`;
sandbox.testRenderBookingRooms();
assert.match(element('#booking-room').innerHTML, /MAIN/);
assert.match(element('#booking-room').innerHTML, /NORTH/);
assert.equal(sandbox.testResolveBookingRoom(), false);
assert.equal(element('#selected-schedule').value, '');
element('#booking-room').value = 'MAIN\u001fA';
assert.equal(sandbox.testResolveBookingRoom(), true);
assert.equal(element('#selected-schedule').value, 'room-a');
element('#booking-practitioner').value = '';
sandbox.testRenderBookingDates();
assert.equal(element('#selected-schedule').value, '');
assert.equal(element('#booking-room').disabled, true);
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
