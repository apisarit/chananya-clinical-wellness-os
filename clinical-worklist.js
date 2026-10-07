(() => {
  'use strict';

  const MAX_ENCOUNTERS = 250;
  const MAX_PATIENTS = 500;
  const text = value => String(value ?? '').trim();
  const knownStatus = value => text(value) || 'ไม่ทราบสถานะ';
  const statusNames = new Map([['draft', 'ฉบับร่าง (draft)'], ['in_progress', 'ดำเนินการ (in_progress)'],
    ['completed', 'ปิด Encounter (completed)'], ['cancelled', 'ยกเลิก (cancelled)']]);
  const statusLabel = value => statusNames.get(value) || value;

  function bangkokDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function displayTime(value) {
    if (!value) return 'ไม่ทราบเวลา';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'ไม่ทราบเวลา';
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short'
    }).format(date);
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.encounters) || !Array.isArray(snapshot.patients)) {
      throw new TypeError('ข้อมูล worklist ไม่ถูกต้อง');
    }
    if (snapshot.encounters.length > MAX_ENCOUNTERS || snapshot.patients.length > MAX_PATIENTS) {
      throw new TypeError('ข้อมูล worklist เกินขอบเขตที่กำหนด');
    }
    [snapshot.encounters, snapshot.patients].forEach(collection => {
      const ids = new Set();
      collection.forEach(row => {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()
            || row.id !== row.id.trim() || ids.has(row.id)) throw new TypeError('รหัสรายการไม่ถูกต้องหรือซ้ำกัน');
        ids.add(row.id);
      });
    });
    if (snapshot.encounters.some(row => typeof row.patient_id !== 'string' || !row.patient_id.trim())) {
      throw new TypeError('Encounter ไม่มีรหัสผู้รับบริการ');
    }
    return snapshot;
  }

  function mount({ host, onRefresh } = {}) {
    if (!host || typeof host.querySelector !== 'function') throw new TypeError('ต้องระบุ worklist host');
    if (typeof onRefresh !== 'function') throw new TypeError('ต้องระบุ onRefresh');
    const search = host.querySelector('#worklist-search');
    const date = host.querySelector('#worklist-date');
    const status = host.querySelector('#worklist-status');
    const refresh = host.querySelector('#worklist-refresh');
    const summary = host.querySelector('#worklist-summary');
    const feedback = host.querySelector('#worklist-feedback');
    const rows = host.querySelector('#worklist-rows');
    if (![search, date, status, refresh, summary, feedback, rows].every(Boolean)) {
      throw new TypeError('worklist host ขาดองค์ประกอบที่จำเป็น');
    }
    const details = host.querySelector('details');
    let snapshot = null;
    let destroyed = false;
    let pending = false;
    let generation = 0;
    let refreshTimer = null;

    const clear = () => {
      rows.replaceChildren();
      summary.textContent = 'ยังไม่มีข้อมูล worklist';
    };
    const patientById = () => new Map((snapshot?.patients || []).map(patient => [text(patient.id), patient]));
    const filtered = () => {
      if (!snapshot) return [];
      const query = text(search.value).toLocaleLowerCase();
      const selectedDate = date.value;
      const selectedStatus = status.value;
      const patients = patientById();
      return snapshot.encounters.filter(encounter => {
        const patient = patients.get(text(encounter.patient_id));
        const name = patient ? [patient.prefix || patient.title, patient.first_name, patient.last_name].filter(Boolean).join(' ') : '';
        const haystack = [encounter.encounter_no, encounter.chief_complaint, name, patient?.hn].map(text).join(' ').toLocaleLowerCase();
        return (!query || haystack.includes(query))
          && (!selectedDate || bangkokDate(encounter.started_at) === selectedDate)
          && (!selectedStatus || knownStatus(encounter.status) === selectedStatus);
      });
    };
    const renderStatusOptions = () => {
      const selected = status.value;
      const values = [...new Set((snapshot?.encounters || []).map(row => knownStatus(row.status)))].sort((a, b) => a.localeCompare(b));
      status.replaceChildren(new Option('ทุกสถานะ', ''));
      values.forEach(value => status.append(new Option(statusLabel(value), value)));
      status.value = values.includes(selected) ? selected : '';
    };
    const render = () => {
      if (!snapshot) { clear(); return; }
      const patients = patientById();
      const visible = filtered();
      rows.replaceChildren();
      visible.forEach(encounter => {
        const patient = patients.get(text(encounter.patient_id));
        const name = patient ? [patient.prefix || patient.title, patient.first_name, patient.last_name].filter(Boolean).join(' ').trim() : 'ไม่พบข้อมูลผู้รับบริการในชุดข้อมูลที่โหลด';
        const row = document.createElement('tr');
        const values = [patient?.hn || 'ไม่ทราบ HN', name || 'ไม่ทราบชื่อ', text(encounter.encounter_no) || 'ไม่ทราบ Encounter', displayTime(encounter.started_at), statusLabel(knownStatus(encounter.status)), text(encounter.chief_complaint) || 'ไม่ทราบอาการสำคัญ'];
        values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
        const action = document.createElement('td');
        const link = document.createElement('a');
        link.className = 'btn ghost'; link.target = '_blank'; link.rel = 'noopener';
        link.href = `/clinical-v3.html?encounter=${encodeURIComponent(text(encounter.id))}&step=history`;
        link.textContent = 'เปิดประวัติในแท็บใหม่';
        action.append(link); row.append(action); rows.append(row);
      });
      const cap = snapshot.encounters.length >= MAX_ENCOUNTERS ? ` แสดงข้อมูลที่โหลด ${MAX_ENCOUNTERS} รายการแรก อาจมีรายการเพิ่มเติม` : '';
      summary.textContent = `แสดง ${visible.length} จาก ${snapshot.encounters.length} Encounter ที่โหลด • ผู้รับบริการ ${snapshot.patients.length} รายการ${cap}`;
      feedback.textContent = visible.length === 0
        ? 'ไม่พบรายการในชุดข้อมูลที่โหลดตามตัวกรองนี้ ลองเปลี่ยนคำค้น วันที่ หรือสถานะ'
        : snapshot.loadedAt ? `โหลดเมื่อ ${displayTime(snapshot.loadedAt)} • กรองในชุดข้อมูลที่ได้รับอนุญาตเท่านั้น` : '';
    };
    const unlock = () => { pending = false; refresh.disabled = false; clearTimeout(refreshTimer); refreshTimer = null; };
    const failure = () => {
      if (destroyed) return;
      generation += 1; unlock(); snapshot = null; clear(); renderStatusOptions();
      feedback.textContent = 'โหลด worklist ไม่สำเร็จ กรุณาลองใหม่ โดยยังไม่แสดงข้อมูลเดิม'; feedback.className = 'status danger';
    };
    const update = next => {
      if (destroyed) return;
      try { validateSnapshot(next); } catch (error) { failure(); throw error; }
      generation += 1; unlock();
      snapshot = { ...next, encounters: next.encounters.map(row => ({ ...row })), patients: next.patients.map(row => ({ ...row })) };
      feedback.className = 'status'; renderStatusOptions(); render();
    };
    const loading = () => {
      if (destroyed) return;
      generation += 1; clearTimeout(refreshTimer); refreshTimer = null;
      pending = true; refresh.disabled = true; snapshot = null; clear();
      feedback.className = 'status'; feedback.textContent = 'กำลังโหลด worklist…';
    };
    const refreshSnapshot = async () => {
      if (destroyed || pending) return;
      loading();
      const token = generation;
      try {
        const timeout = new Promise((_, reject) => { refreshTimer = setTimeout(() => reject(new Error('WORKLIST_READ_TIMEOUT')), 20000); });
        const next = await Promise.race([Promise.resolve().then(onRefresh), timeout]);
        if (destroyed || token !== generation) return;
        update(next);
      } catch (error) { if (!destroyed && token === generation) failure(); }
    };
    const onFilter = () => { if (!destroyed) render(); };
    search.addEventListener('input', onFilter); date.addEventListener('change', onFilter); status.addEventListener('change', onFilter); refresh.addEventListener('click', refreshSnapshot);
    const api = { update, loading, failure, refresh: refreshSnapshot, destroy() {
      destroyed = true; generation += 1; clearTimeout(refreshTimer); refreshTimer = null;
      snapshot = null; clear(); refresh.disabled = true; feedback.textContent = 'รายการหยุดแล้ว กรุณาเปิดหน้าใหม่เพื่อโหลดข้อมูล';
      search.removeEventListener('input', onFilter); date.removeEventListener('change', onFilter); status.removeEventListener('change', onFilter); refresh.removeEventListener('click', refreshSnapshot);
    } };
    if (details) details.open = !new URL(location.href).searchParams.get('encounter');
    return api;
  }

  window.ChananyaClinicalWorklist = Object.freeze({ mount });
})();
