import assert from 'node:assert/strict';
import fs from 'node:fs';

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

console.log('Appointment scheduling contract passed: empty-state recovery, tenant-bound operator authorization, schedule creation and auto-selection are present');
