import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const start = source.indexOf('  function renderBookingCalendar()');
const end = source.indexOf('  function renderBookingDates()', start);
assert.ok(start > 0 && end > start);
const host = { innerHTML: '', textContent: '' };
const practitioner = { value: 'doctor-a' };
const selected = { value: '2028-02-29' };
const context = vm.createContext({
  $: selector => ({ '#booking-calendar': host, '#booking-practitioner': practitioner, '#booking-date': selected })[selector],
  allSchedules: [
    { practitioner_id: 'doctor-a', day: '2028-02-29', available_capacity: 1 },
    { practitioner_id: 'doctor-a', day: '2028-02-29', available_capacity: 2 },
    { practitioner_id: 'doctor-a', day: '2028-03-01', available_capacity: 1 },
    { practitioner_id: 'doctor-a', day: '2028-02-28', available_capacity: 0 },
    { practitioner_id: 'doctor-b', day: '2028-02-27', available_capacity: 1 },
  ],
  rowDate: row => row.day,
  esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
});
vm.runInContext(source.slice(start, end) + '\nrenderBookingCalendar();', context);
assert.equal((host.innerHTML.match(/data-calendar-day=/g) || []).length, 2);
assert.match(host.innerHTML, /data-calendar-day="2028-02-29"[^>]*aria-pressed="true"/);
assert.doesNotMatch(host.innerHTML, /data-calendar-day="2028-02-(27|28)"/);
assert.doesNotMatch(host.innerHTML, /2028-02-30/);
assert.match(host.innerHTML, /type="button"/);
practitioner.value = 'doctor-b';
vm.runInContext('renderBookingCalendar()', context);
assert.match(host.innerHTML, /data-calendar-day="2028-02-27"/);
assert.doesNotMatch(host.innerHTML, /data-calendar-day="2028-02-29"/);
practitioner.value = '';
vm.runInContext('renderBookingCalendar()', context);
assert.match(host.textContent, /เลือกผู้ให้บริการ/);
assert.match(source, /booking-date'\)\.options/);
console.log('Practitioner calendar: filtered dates, no sold-out dates, leap year, selection and explicit button type passed (isolated UI).');
