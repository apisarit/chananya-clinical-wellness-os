(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateTime = value => new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const thaiTime = value => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Bangkok' });
  const thaiDate = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  const bangkokDateTimeValue = value => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const parseBangkokDateTime = value => new Date(`${value}:00+07:00`);
  const displayText = value => {
    const text = String(value ?? '').trim();
    return text === '-' ? '' : text;
  };
  const providerLabel = item => displayText(item.practitioner_name) || 'ยังไม่พบชื่อผู้ให้บริการ';
  const scheduleLabel = item => `${dateTime(item.starts_at)} – ${thaiTime(item.ends_at)} น. • ผู้ให้บริการ: ${providerLabel(item)} • ${item.title}`;
  const rowDate = item => thaiDate(item.starts_at);
  const rowTimeKey = item => `${item.starts_at}|${item.ends_at}`;
  const rowRoomKey = item => `${displayText(item.branch_code)}\u001f${displayText(item.room_code)}`;
  const roomLabel = item => `${displayText(item.branch_code) ? `สาขา ${displayText(item.branch_code)}` : 'ยังไม่ระบุสาขา'} • ${displayText(item.room_code) ? `ห้อง ${displayText(item.room_code)}` : 'ยังไม่ระบุห้อง'}`;

  function scheduleCard(item, allowBooking) {
    const name = displayText(item.practitioner_name);
    const specialty = displayText(item.specialty_name_th) || displayText(item.specialty_name_en);
    const branch = displayText(item.branch_code);
    const room = displayText(item.room_code);
    const location = [branch ? `สาขา ${branch}` : 'ยังไม่ระบุสาขา', room ? `ห้อง ${room}` : 'ยังไม่ระบุห้อง'].join(' • ');
    return `<article class="schedule-card"><h3>${esc(item.title)}</h3><div class="meta"><span>ผู้ให้บริการ: ${esc(providerLabel(item))}</span>${!name ? '<span>กรุณาตรวจสอบผู้ให้บริการในตารางรับนัดก่อนยืนยันการจอง</span>' : ''}${specialty ? `<span>ความเชี่ยวชาญ: ${esc(specialty)}</span>` : ''}<span>${esc(dateTime(item.starts_at))} – ${esc(thaiTime(item.ends_at))} น.</span><span>${esc(location)}</span></div><p><span class="capacity">เหลือ ${esc(item.available_capacity)} ที่ จาก ${esc(item.max_patients)} ที่</span></p>${allowBooking ? `<button class="btn primary" data-book="${esc(item.id)}" data-label="${esc(scheduleLabel(item))}">${name ? `จองกับ ${esc(name)}` : 'เลือกช่วงเวลานี้'}</button>` : ''}</article>`;
  }

  let db;
  let session;
  let profile;
  let canOperate = false;
  let canClinicalStatus = false;
  let allPatients = [];
  let allSchedules = [];
  const practitionerNames = new Map();
  let scheduleRequestVersion = 0;
  let appointmentRequestVersion = 0;
  let patientRequestVersion = 0;
  let patientSearchTimer;
  let scheduleCreateInFlight = false;
  let bookingInFlight = false;
  const appointmentActionsInFlight = new Set();

  const patientName = patient => [patient.title || patient.prefix, patient.first_name, patient.last_name].filter(Boolean).join(' ') || patient.full_name || patient.name || 'ไม่ระบุชื่อ';
  const patientLabel = patient => `${patient.hn || patient.patient_no || '-'} — ${patientName(patient)}${patient.phone ? ` • ${patient.phone}` : ''}`;
  const appointmentStatusLabel = status => ({ booked: 'จองแล้ว', confirmed: 'ยืนยันแล้ว', checked_in: 'เช็กอินแล้ว', in_service: 'กำลังรับบริการ', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก', no_show: 'ไม่มาตามนัด', rescheduled: 'เลื่อนนัด' }[status] || status || '-');

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
  }

  function fail(error) { console.error(error); alert(error?.message || String(error)); }

  function renderPatients(rows) {
    $('#patient').innerHTML = '<option value="">เลือกผู้รับบริการ</option>' + rows.map(patient => `<option value="${patient.id}">${esc(patientLabel(patient))}</option>`).join('');
    window.dispatchEvent(new CustomEvent('chananya:appointments-rendered'));
  }

  function clearResolvedSchedule(message = 'กรุณาเลือกผู้ให้บริการ วันที่ เวลา และสาขา/ห้องให้ครบ') {
    $('#selected-schedule').value = '';
    $('#selected-schedule-label').value = '';
    $('#booking-status').textContent = message;
  }

  function setOptions(selector, placeholder, options, disabled = false) {
    const element = $(selector);
    element.innerHTML = `<option value="">${esc(placeholder)}</option>` + options.map(option => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');
    element.disabled = disabled;
  }

  function renderBookingPractitioners(rows = allSchedules) {
    const seen = new Map();
    practitionerNames.forEach((name, id) => { if (id) seen.set(id, displayText(name) || 'ยังไม่พบชื่อผู้ให้บริการ'); });
    rows.forEach(item => {
      const id = displayText(item.practitioner_id);
      if (id && !seen.has(id)) seen.set(id, providerLabel(item));
    });
    setOptions('#booking-practitioner', seen.size ? 'เลือกผู้ให้บริการก่อน' : 'ยังไม่มีผู้ให้บริการในช่วงเวลาที่ค้นพบ', Array.from(seen, ([value, label]) => ({ value, label })), !seen.size);
    setOptions('#booking-date', 'เลือกผู้ให้บริการก่อน', [], true);
    setOptions('#booking-time', 'เลือกวันที่ก่อน', [], true);
    setOptions('#booking-room', 'เลือกเวลาก่อน', [], true);
    clearResolvedSchedule('กรุณาเลือกผู้ให้บริการก่อน');
  }

  function renderBookingDates() {
    const practitioner = $('#booking-practitioner').value;
    const dates = [...new Set(allSchedules.filter(item => item.practitioner_id === practitioner).map(rowDate))].sort();
    setOptions('#booking-date', dates.length ? 'เลือกวันที่' : 'ไม่พบวันที่ว่าง', dates.map(value => ({ value, label: value })), !practitioner || !dates.length);
    setOptions('#booking-time', 'เลือกวันที่ก่อน', [], true);
    setOptions('#booking-room', 'เลือกเวลาก่อน', [], true);
    clearResolvedSchedule(!practitioner ? 'กรุณาเลือกผู้ให้บริการก่อน' : dates.length ? 'กรุณาเลือกวันที่' : 'ผู้ให้บริการนี้ยังไม่มีช่วงเวลารับนัดที่ตรงกับตัวกรอง กรุณาเปลี่ยนช่วงวันที่หรือเพิ่มตารางรับนัด');
  }

  function renderBookingTimes() {
    const practitioner = $('#booking-practitioner').value;
    const day = $('#booking-date').value;
    const rows = allSchedules.filter(item => item.practitioner_id === practitioner && rowDate(item) === day);
    const seen = new Map();
    rows.forEach(item => { if (!seen.has(rowTimeKey(item))) seen.set(rowTimeKey(item), `${thaiTime(item.starts_at)}–${thaiTime(item.ends_at)} น.`); });
    setOptions('#booking-time', seen.size ? 'เลือกเวลา' : 'ไม่พบเวลาว่าง', Array.from(seen, ([value, label]) => ({ value, label })), !day || !seen.size);
    setOptions('#booking-room', 'เลือกเวลาก่อน', [], true);
    clearResolvedSchedule(day ? 'กรุณาเลือกเวลา' : 'กรุณาเลือกวันที่');
  }

  function renderBookingRooms() {
    const practitioner = $('#booking-practitioner').value;
    const day = $('#booking-date').value;
    const time = $('#booking-time').value;
    const rows = allSchedules.filter(item => item.practitioner_id === practitioner && rowDate(item) === day && rowTimeKey(item) === time);
    const seen = new Map();
    rows.forEach(item => { if (!seen.has(rowRoomKey(item))) seen.set(rowRoomKey(item), roomLabel(item)); });
    setOptions('#booking-room', seen.size ? 'เลือกสาขาและห้อง' : 'ไม่พบห้องว่าง', Array.from(seen, ([value, label]) => ({ value, label })), !time || !seen.size);
    clearResolvedSchedule(time ? 'กรุณาเลือกสาขาและห้อง' : 'กรุณาเลือกเวลา');
  }

  function resolveBookingRoom() {
    const practitioner = $('#booking-practitioner').value;
    const day = $('#booking-date').value;
    const time = $('#booking-time').value;
    const room = $('#booking-room').value;
    const matches = allSchedules.filter(item => item.practitioner_id === practitioner && rowDate(item) === day && rowTimeKey(item) === time && rowRoomKey(item) === room);
    if (matches.length !== 1) {
      clearResolvedSchedule(matches.length ? 'พบหลายช่วงเวลาที่ตรงกัน กรุณาเลือกจากรายการช่วงเวลาว่าง' : 'ไม่พบช่วงเวลาที่ตรงกัน กรุณาค้นหาใหม่');
      return false;
    }
    selectSchedule(matches[0].id, false);
    return true;
  }

  function selectedScheduleMatchesBooking() {
    const selected = allSchedules.find(item => item.id === $('#selected-schedule').value);
    if (!selected) return false;
    return selected.practitioner_id === $('#booking-practitioner').value
      && rowDate(selected) === $('#booking-date').value
      && rowTimeKey(selected) === $('#booking-time').value
      && rowRoomKey(selected) === $('#booking-room').value;
  }

  async function loadPatients(rawTerm = '') {
    const version = ++patientRequestVersion;
    const term = rawTerm.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\s+\-]/gu, '').trim();
    $('#patient-search-status').textContent = term ? 'กำลังค้นหาผู้รับบริการ…' : 'กำลังโหลดผู้รับบริการล่าสุด…';
    let request = db.from('patients').select('id,hn,prefix,first_name,last_name,phone,created_at').eq('active', true).order('created_at', { ascending: false }).limit(100);
    if (term.length >= 2) request = request.or(`hn.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%`);
    const result = await request;
    if (version !== patientRequestVersion) return;
    if (result.error) throw result.error;
    allPatients = result.data || [];
    renderPatients(allPatients);
    $('#patient-search-status').textContent = term.length === 1
      ? 'พิมพ์อย่างน้อย 2 ตัวอักษรเพื่อค้นหาจากฐานข้อมูล'
      : `พบผู้รับบริการ ${allPatients.length} ราย${term ? ` สำหรับ “${term}”` : 'ล่าสุด'}`;
  }

  async function loadSchedules() {
    const version = ++scheduleRequestVersion;
    allSchedules = [];
    $('#selected-schedule').value = '';
    $('#selected-schedule-label').value = '';
    $('#booking-status').textContent = 'กรุณาเลือกช่วงเวลาจากผลค้นหาใหม่';
    $('#schedule-list').innerHTML = '';
    $('#schedule-status').textContent = 'กำลังค้นหาช่วงเวลาว่าง…';
    let request = db.from('available_practitioner_schedules').select('*').gt('available_capacity', 0).order('starts_at');
    const from = $('#date-from').value;
    const to = $('#date-to').value;
    if (from && to && from > to) {
      $('#schedule-status').textContent = 'วันที่เริ่มต้องไม่อยู่หลังวันที่สิ้นสุด';
      return;
    }
    if (from) request = request.gte('starts_at', new Date(`${from}T00:00:00+07:00`).toISOString());
    if (to) request = request.lte('starts_at', new Date(`${to}T23:59:59.999+07:00`).toISOString());
    const result = await request;
    if (version !== scheduleRequestVersion) return;
    if (result.error) {
      $('#schedule-status').textContent = 'โหลดช่วงเวลาไม่สำเร็จ กรุณาลองค้นหาอีกครั้ง';
      throw result.error;
    }
    const term = $('#search').value.trim().toLowerCase();
    for (const item of result.data || []) {
      item.practitioner_name = displayText(item.practitioner_name) || displayText(practitionerNames.get(item.practitioner_id));
    }
    const windows = Array.from(document.querySelectorAll('[name="time-window"]:checked'), input => input.value.split('-'));
    const rows = (result.data || []).filter(item => (!term || [item.practitioner_name, item.specialty_name_th, item.specialty_name_en, item.title, item.room_code, item.branch_code].some(value => String(value || '').toLowerCase().includes(term))) && (!windows.length || windows.some(([start, end]) => thaiTime(item.starts_at) < end && thaiTime(item.ends_at) > start)));
    allSchedules = rows;
    renderBookingPractitioners(rows);
    $('#schedule-status').textContent = rows.length ? `พบ ${rows.length} ช่วงเวลาที่ว่าง` : 'ไม่พบตารางเปิดรับนัดตามวันและเวลาที่เลือก — ลองเปลี่ยนตัวกรอง หรือเพิ่มช่วงเวลารับนัด';
    $('#schedule-list').innerHTML = rows.map(item => scheduleCard(item, canOperate)).join('') || `<div class="notice warning"><b>ยังไม่มีช่วงเวลาที่เปิดรับนัด</b><br>${canOperate ? 'กด “เพิ่มช่วงเวลารับนัด” เพื่อสร้างช่วงเวลาแรก แล้วจึงเลือกผู้รับบริการ' : 'กรุณาให้ Admin หรือ Reception เพิ่มตารางรับนัด'}</div>`;
    document.querySelectorAll('[data-book]').forEach(button => {
      button.onclick = () => {
        if (!selectSchedule(button.dataset.book)) return;
        $('#booking-section').scrollIntoView({ behavior: 'smooth' });
      };
    });
  }

  async function loadPractitioners() {
    if (!canOperate) return;
    const result = await db.rpc('list_appointment_practitioners');
    if (result.error) throw result.error;
    const rows = result.data || [];
    rows.forEach(item => practitionerNames.set(item.practitioner_id, item.display_name));
    $('#schedule-practitioner').innerHTML = '<option value="">เลือกผู้ให้บริการ</option>' + rows.map(item => `<option value="${item.practitioner_id}">${esc(item.display_name)} • ${esc(item.clinic_role)}</option>`).join('');
    $('#schedule-setup').classList.remove('hidden');
    const start = new Date();
    start.setMinutes(Math.ceil((start.getMinutes() + 15) / 30) * 30, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    $('#schedule-start').value = bangkokDateTimeValue(start);
    $('#schedule-end').value = bangkokDateTimeValue(end);
    if (!rows.length) {
      $('#schedule-create-status').textContent = 'ยังไม่มีผู้ให้บริการที่มีบทบาท practitioner หรือ doctor กรุณากำหนดสิทธิ์ก่อน';
      $('#schedule-form button').disabled = true;
    }
  }

  function selectSchedule(scheduleId, syncSelectors = true) {
    const item = allSchedules.find(row => row.id === scheduleId);
    if (!item) return false;
    if (syncSelectors && item.practitioner_id) {
      $('#booking-practitioner').value = item.practitioner_id;
      renderBookingDates();
      $('#booking-date').value = rowDate(item);
      renderBookingTimes();
      $('#booking-time').value = rowTimeKey(item);
      renderBookingRooms();
      $('#booking-room').value = rowRoomKey(item);
    }
    $('#selected-schedule').value = item.id;
    $('#selected-schedule-label').value = scheduleLabel(item);
    $('#booking-status').textContent = 'เลือกช่วงเวลาแล้ว กรุณาเลือกผู้รับบริการ';
    return true;
  }

  async function createSchedule(event) {
    event.preventDefault();
    if (!canOperate) throw new Error('บัญชีนี้มีสิทธิ์ดูเท่านั้น');
    if (scheduleCreateInFlight) return;
    scheduleCreateInFlight = true;
    $('#schedule-submit').disabled = true;
    try {
      const startsAt = parseBangkokDateTime($('#schedule-start').value);
      const endsAt = parseBangkokDateTime($('#schedule-end').value);
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) throw new Error('กรุณาระบุวันเวลาให้ครบ');
      if (endsAt <= startsAt) throw new Error('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม');
      $('#schedule-create-status').classList.remove('danger');
      $('#schedule-create-status').textContent = 'กำลังบันทึกช่วงเวลา…';
      const result = await db.rpc('create_practitioner_schedule', {
        p_practitioner_id: $('#schedule-practitioner').value,
        p_title: $('#schedule-title').value,
        p_starts_at: startsAt.toISOString(),
        p_ends_at: endsAt.toISOString(),
        p_branch_code: $('#schedule-branch').value,
        p_room_code: $('#schedule-room').value || null,
        p_max_patients: Number($('#schedule-capacity').value),
        p_slot_minutes: Number($('#schedule-slot-minutes').value),
        p_notes: $('#schedule-notes').value || null
      });
      if (result.error) throw result.error;
      $('#date-from').value = $('#schedule-start').value.slice(0, 10);
      $('#date-to').value = $('#schedule-start').value.slice(0, 10);
      $('#search').value = '';
      await loadSchedules();
      if (!selectSchedule(result.data.id)) throw new Error('สร้างช่วงเวลาแล้ว แต่ยังโหลดกลับมาไม่ได้ กรุณากดค้นหาอีกครั้ง');
      $('#schedule-create-status').textContent = 'สร้างช่วงเวลาแล้ว และเลือกไว้สำหรับการจองนี้';
      $('#schedule-setup').open = false;
      $('#booking-section').scrollIntoView({ behavior: 'smooth' });
      toast('เพิ่มช่วงเวลารับนัดแล้ว');
    } finally {
      scheduleCreateInFlight = false;
      $('#schedule-submit').disabled = false;
    }
  }

  async function bookAppointment(event) {
    event.preventDefault();
    if (!canOperate) throw new Error('บัญชีนี้มีสิทธิ์ดูเท่านั้น');
    if (bookingInFlight) return;
    const scheduleId = $('#selected-schedule').value;
    const patientId = $('#patient').value;
    if (!scheduleId) throw new Error('กรุณาเลือกช่วงเวลาว่าง');
    if (!selectedScheduleMatchesBooking()) throw new Error('ช่วงเวลาที่เลือกไม่ตรงกับผู้ให้บริการ วันที่ เวลา หรือห้อง กรุณาเลือกใหม่');
    if (!patientId) throw new Error('กรุณาเลือกผู้รับบริการ');
    bookingInFlight = true;
    $('#booking-submit').disabled = true;
    try {
      $('#booking-status').classList.remove('danger');
      $('#booking-status').textContent = 'กำลังยืนยันการจอง…';
      const result = await db.rpc('book_clinic_appointment', { p_patient_id: patientId, p_schedule_id: scheduleId, p_chief_complaint: $('#chief-complaint').value || null, p_notes: $('#notes').value || null, p_booking_source: 'staff' });
      if (result.error) throw result.error;
      const confirmation = `จองสำเร็จ ${result.data.appointment_no} • คิว ${result.data.queue_number}`;
      event.target.reset();
      toast('จองนัดหมายสำเร็จ');
      await Promise.all([loadSchedules(), loadAppointments()]);
      $('#booking-status').textContent = confirmation;
    } finally {
      bookingInFlight = false;
      $('#booking-submit').disabled = false;
    }
  }

  async function loadAppointments() {
    const version = ++appointmentRequestVersion;
    $('#appointment-list').innerHTML = '<p class="muted">กำลังโหลด…</p>';
    const day = $('#appointments-date').value;
    const status = $('#status-filter').value;
    let request = db.from('clinic_appointments').select('*,patient:patients!clinic_appointments_patient_clinic_fkey(id,hn,prefix,first_name,last_name,phone)').order('scheduled_start');
    if (day) request = request.gte('scheduled_start', new Date(`${day}T00:00:00+07:00`).toISOString()).lte('scheduled_start', new Date(`${day}T23:59:59.999+07:00`).toISOString());
    if (status) request = request.eq('status', status);
    const result = await request;
    if (version !== appointmentRequestVersion) return;
    if (result.error) throw result.error;
    $('#appointment-list').innerHTML = (result.data || []).map(item => {
      const patient = item.patient || {};
      const mayProvideCare = canClinicalStatus && item.practitioner_id === session.user.id;
      const actions = (canOperate || mayProvideCare) ? `${canOperate && item.status === 'booked' ? `<button class="btn ghost" data-status="confirmed" data-id="${item.id}">ยืนยัน</button>` : ''}${canOperate && ['booked', 'confirmed'].includes(item.status) ? `<button class="btn ghost" data-status="checked_in" data-id="${item.id}">Check-in</button>` : ''}${(canOperate || mayProvideCare) && item.status === 'checked_in' ? `<button class="btn ghost" data-status="in_service" data-id="${item.id}">เริ่มบริการ</button>` : ''}${(canOperate || mayProvideCare) && item.status === 'in_service' ? `<button class="btn ghost" data-status="completed" data-id="${item.id}">เสร็จสิ้น</button>` : ''}${canOperate && ['booked', 'confirmed'].includes(item.status) ? `<button class="btn danger" data-cancel="${item.id}">ยกเลิก</button>` : ''}` : '';
      return `<article class="appt-row"><div><b>${esc(item.appointment_no)} • คิว ${item.queue_number}</b><small>${esc(patientLabel(patient))}</small><small>${esc(dateTime(item.scheduled_start))} • ${esc(appointmentStatusLabel(item.status))}</small><small>${esc(item.chief_complaint || '')}</small></div><div class="actions">${actions}</div></article>`;
    }).join('') || '<p class="muted">ไม่มีรายการนัดหมาย</p>';
    document.querySelectorAll('[data-status]').forEach(button => { button.onclick = () => setStatus(button.dataset.id, button.dataset.status).catch(fail); });
    document.querySelectorAll('[data-cancel]').forEach(button => { button.onclick = () => cancelAppointment(button.dataset.cancel).catch(fail); });
  }

  async function setStatus(id, status) {
    if (!canOperate) throw new Error('บัญชีนี้มีสิทธิ์ดูเท่านั้น');
    if (appointmentActionsInFlight.has(id)) return;
    appointmentActionsInFlight.add(id);
    document.querySelectorAll('[data-status],[data-cancel]').forEach(button => { if (button.dataset.id === id || button.dataset.cancel === id) button.disabled = true; });
    try {
      const result = await db.rpc('set_clinic_appointment_status', { p_appointment_id: id, p_new_status: status, p_note: null });
      if (result.error) throw result.error;
      toast('อัปเดตสถานะแล้ว');
      await loadAppointments();
    } finally {
      appointmentActionsInFlight.delete(id);
      document.querySelectorAll('[data-status],[data-cancel]').forEach(button => { if (button.dataset.id === id || button.dataset.cancel === id) button.disabled = false; });
    }
  }

  async function cancelAppointment(id) {
    if (!canOperate) throw new Error('บัญชีนี้มีสิทธิ์ดูเท่านั้น');
    const reason = prompt('เหตุผลที่ยกเลิก');
    if (reason === null) return;
    if (!reason.trim()) throw new Error('กรุณาระบุเหตุผลที่ยกเลิก');
    if (appointmentActionsInFlight.has(id)) return;
    appointmentActionsInFlight.add(id);
    document.querySelectorAll('[data-status],[data-cancel]').forEach(button => { if (button.dataset.id === id || button.dataset.cancel === id) button.disabled = true; });
    try {
      const result = await db.rpc('cancel_clinic_appointment', { p_appointment_id: id, p_reason: reason.trim() });
      if (result.error) throw result.error;
      toast('ยกเลิกนัดแล้ว');
      await Promise.all([loadSchedules(), loadAppointments()]);
    } finally {
      appointmentActionsInFlight.delete(id);
      document.querySelectorAll('[data-status],[data-cancel]').forEach(button => { if (button.dataset.id === id || button.dataset.cancel === id) button.disabled = false; });
    }
  }

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      session = await runtime.getSession();
      if (!session) { location.replace('/login.html'); return; }
      profile = await runtime.getProfile(session.user.id);
      if (!profile) throw new Error('ไม่พบ Profile');
      if (!runtime.can(profile, 'appointments_view')) throw new Error('บัญชีนี้ไม่มีสิทธิ์ดูระบบนัดหมาย');
      canOperate = runtime.can(profile, 'appointments_operate');
      canClinicalStatus = runtime.can(profile, 'appointments_clinical_status');
      window.ChananyaShell?.mount({ profile, session, active: 'appointments' });
      $('#view-only-notice').classList.toggle('hidden', canOperate);
      if (!canOperate && canClinicalStatus) $('#view-only-notice').textContent = 'บัญชีผู้ให้บริการดูตารางนัดได้ และเริ่มหรือจบการรักษาได้เฉพาะนัดของตน';
      $('#booking-section').classList.toggle('hidden', !canOperate);
      $('#schedule-setup').classList.toggle('hidden', !canOperate);
      const today = new Date();
      const in14 = new Date(today); in14.setDate(in14.getDate() + 14);
      $('#date-from').value = thaiDate(today);
      $('#date-to').value = thaiDate(in14);
      $('#appointments-date').value = thaiDate(today);
      await loadPatients();
      await loadPractitioners();
      await Promise.all([loadSchedules(), loadAppointments()]);
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#patient-search').addEventListener('input', event => {
    clearTimeout(patientSearchTimer);
    patientSearchTimer = setTimeout(() => loadPatients(event.target.value).catch(error => {
      $('#patient-search-status').textContent = 'ค้นหาผู้รับบริการไม่สำเร็จ กรุณาลองใหม่';
      fail(error);
    }), 250);
  });
  $('#booking-practitioner').addEventListener('change', () => renderBookingDates());
  $('#booking-date').addEventListener('change', () => renderBookingTimes());
  $('#booking-time').addEventListener('change', () => renderBookingRooms());
  $('#booking-room').addEventListener('change', () => resolveBookingRoom());
  $('#search-btn').addEventListener('click', () => loadSchedules().catch(fail));
  document.querySelectorAll('[name="time-window"]').forEach(input => input.addEventListener('change', () => loadSchedules().catch(fail)));
  $('#schedule-form').addEventListener('submit', event => createSchedule(event).catch(error => { $('#schedule-create-status').textContent = error.message; $('#schedule-create-status').classList.add('danger'); fail(error); }));
  $('#booking-form').addEventListener('submit', event => bookAppointment(event).catch(error => { $('#booking-status').textContent = error.message; $('#booking-status').classList.add('danger'); fail(error); }));
  $('#refresh-appts').addEventListener('click', () => loadAppointments().catch(fail));
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  init();
})();
