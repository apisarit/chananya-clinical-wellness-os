// Isolated browser interaction only: no production requests, credentials or writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  const html = fs.readFileSync(new URL('../appointments.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.setContent(html);
  await page.addStyleTag({ content: '.hidden { display:none }' });
  await page.evaluate(() => {
    const patient = { id: 'synthetic-patient', hn: 'SYNTHETIC-ONLY', first_name: 'ทดสอบ', last_name: 'ห้ามใช้จริง' };
    const providers = [{ practitioner_id: 'p1', display_name: 'Synthetic Provider One', clinic_role: 'practitioner' }, { practitioner_id: 'p2', display_name: 'Synthetic Provider Two', clinic_role: 'practitioner' }, { practitioner_id: 'p3', display_name: 'Synthetic No Schedule', clinic_role: 'practitioner' }];
    const base = { title: 'Synthetic visit', starts_at: '2026-09-23T03:00:00Z', ends_at: '2026-09-23T05:00:00Z', available_capacity: 2, max_patients: 2, room_code: 'ROOM-1' };
    const slots = [
      { ...base, id: 's1', practitioner_id: 'p1', branch_code: 'MAIN' },
      { ...base, id: 's2', practitioner_id: 'p1', branch_code: 'SECOND' },
      { ...base, id: 's3', practitioner_id: 'p2', branch_code: 'MAIN', room_code: 'ROOM-2' }
    ];
    window.simulatedBookings = [];
    const db = {
      from(table) {
        const query = { select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, gt() { return this; }, gte() { return this; }, lte() { return this; },
          then(resolve) { return Promise.resolve({ data: table === 'patients' ? [patient] : table === 'available_practitioner_schedules' ? slots.map(s => ({ ...s })) : table === 'clinic_appointments' ? window.simulatedBookings : [], error: null }).then(resolve); }
        };
        return query;
      },
      async rpc(name, payload) {
        if (name === 'list_appointment_practitioners') return { data: providers };
        if (name !== 'book_clinic_appointment') throw new Error('UNEXPECTED_SIMULATION_RPC');
        const slot = slots.find(s => s.id === payload.p_schedule_id);
        if (!slot) throw new Error('SIMULATION_SLOT_NOT_FOUND');
        const appointment = { id: 'synthetic-booking', appointment_no: 'SIMULATION_ONLY-001', queue_number: 1, status: 'booked', scheduled_start: slot.starts_at, scheduled_end: slot.ends_at, practitioner_id: slot.practitioner_id, patient, payload };
        window.simulatedBookings.push(appointment);
        return { data: appointment };
      }
    };
    window.ChananyaRuntime = { getDb: () => db, getSession: async () => ({ user: { id: 'synthetic-operator' } }), getProfile: async () => ({ role: 'admin' }), can: () => true };
  });
  await page.addScriptTag({ content: fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8') });
  await page.waitForFunction(() => document.querySelector('#boot').classList.contains('hidden'));
  assert.equal(await page.locator('#booking-date').isDisabled(), true);
  await page.selectOption('#booking-practitioner', 'p1');
  await page.selectOption('#booking-date', '2026-09-23');
  await page.selectOption('#booking-time', { index: 1 });
  const rooms = await page.locator('#booking-room option').allTextContents();
  assert.equal(rooms.length, 3, 'same room code in two branches remains distinct');
  await page.selectOption('#booking-room', { label: 'สาขา SECOND • ห้อง ROOM-1' });
  assert.equal(await page.inputValue('#selected-schedule'), 's2');
  await page.selectOption('#booking-practitioner', 'p2');
  assert.equal(await page.inputValue('#selected-schedule'), '');
  assert.equal(await page.inputValue('#booking-time'), '');
  assert.equal(await page.locator('#booking-room').isDisabled(), true);
  await page.selectOption('#booking-date', '2026-09-23');
  await page.selectOption('#booking-time', { index: 1 });
  await page.selectOption('#booking-room', { index: 1 });
  assert.equal(await page.inputValue('#selected-schedule'), 's3');
  await page.selectOption('#patient', 'synthetic-patient');
  await page.locator('#selected-schedule').evaluate(element => { element.value = 's1'; });
  await page.click('#booking-submit');
  await page.waitForFunction(() => document.querySelector('#booking-status').textContent.includes('ไม่ตรงกับผู้ให้บริการ'));
  assert.equal(await page.evaluate(() => window.simulatedBookings.length), 0, 'mismatched provider/schedule never submitted');
  await page.selectOption('#booking-room', { index: 1 });
  await page.click('#booking-submit');
  await page.waitForFunction(() => document.querySelector('#booking-status').textContent.includes('SIMULATION_ONLY-001'));
  assert.equal(await page.evaluate(() => window.simulatedBookings.length), 1);
  assert.equal(await page.evaluate(() => window.simulatedBookings[0].payload.p_schedule_id), 's3');
  await page.click('#refresh-appts');
  await page.waitForFunction(() => document.querySelector('#appointment-list').textContent.includes('SIMULATION_ONLY-001'));
  await page.selectOption('#booking-practitioner', 'p3');
  assert.equal(await page.locator('#booking-date').isDisabled(), true);
  assert.equal(await page.inputValue('#selected-schedule'), '');
  assert.deepEqual(errors, []);
  console.log('PASS isolated browser: provider → day/time → branch/room → synthetic submit → list reload; dependent resets; no-slot provider. SIMULATION ONLY, not live persistence.');
} finally {
  await browser.close();
}
