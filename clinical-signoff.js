(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  let db = null, session = null, profile = null, currentEncounter = null;
  let locked = false, statusKnown = false, submitting = false, requestVersion = 0, authorized = false;
  let readiness = { state: 'pending', diagnosis: false, treatment: false };

  async function waitRuntime() {
    for (let i = 0; i < 50; i += 1) {
      if (window.ChananyaRuntime) return window.ChananyaRuntime;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const selectedId = () => $('#encounter')?.value || null;
  const isCurrent = (id, version) => id === selectedId() && id === currentEncounter && version === requestVersion;

  function mount() {
    const section = $('#clinical-signoff-panel');
    const form = $('#signoff-form');
    if (!section || !form) return false;
    $('#signer-name').value = profile?.full_name || session?.user?.email || '';
    if (form.dataset.signoffBound !== '1') {
      form.dataset.signoffBound = '1';
      form.addEventListener('submit', signAndLock);
    }
    updateButton();
    return true;
  }

  function updateButton() {
    const btn = $('#signoff-btn');
    if (!btn) return;
    const ready = readiness.state === 'ready' && readiness.diagnosis && readiness.treatment;
    btn.disabled = !authorized || !statusKnown || locked || submitting || !currentEncounter || !ready;
    if (submitting) btn.textContent = 'กำลังลงนาม...';
    else if (locked) btn.textContent = 'เวชระเบียนถูก Lock แล้ว';
    else btn.textContent = 'ลงนามและ Lock เวชระเบียน';
  }

  function setReadiness(next) {
    readiness = next;
    const box = $('#signoff-status');
    if (box && next.state === 'pending') box.textContent = currentEncounter ? 'กำลังตรวจสอบ Diagnosis และ Treatment…' : 'เลือก Encounter เพื่อดูสถานะ';
    updateButton();
  }

  function setLockedUI(isLocked, known = true) {
    locked = Boolean(isLocked);
    statusKnown = known;
    const fields = $('#clinical-record-fields');
    const editingBlocked = Boolean(currentEncounter) && (locked || !statusKnown);
    if (fields) { fields.inert = editingBlocked; fields.setAttribute('aria-disabled', String(editingBlocked)); }
    updateButton();
    window.dispatchEvent(new CustomEvent('chananya:signoff-changed', { detail: { encounterId: currentEncounter, locked, statusKnown, editingBlocked } }));
  }

  function friendlyError(error) {
    const message = error?.message || String(error);
    const known = {
      DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF: 'ต้องบันทึก Diagnosis ก่อนลงนาม',
      TREATMENT_REQUIRED_BEFORE_SIGNOFF: 'ต้องมี Treatment Plan หรือ Treatment Session ก่อนลงนาม',
      CLINICAL_RECORD_LOCKED: 'เวชระเบียนนี้ถูก Lock แล้ว',
      PERMISSION_DENIED: 'บัญชีนี้ไม่มีสิทธิ์ลงนามเวชระเบียน',
      AUTH_REQUIRED: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่'
    };
    const code = Object.keys(known).find(key => message.includes(key));
    return code ? known[code] : 'ดำเนินการ sign-off ไม่สำเร็จ กรุณาลองใหม่';
  }

  async function readReadiness(encounterId) {
    const [diagnosisResult, planResult, sessionResult] = await Promise.all([
      db.from('ttm_structured_diagnoses').select('id').eq('encounter_id', encounterId).limit(1).maybeSingle(),
      db.from('clinical_treatment_plans').select('id').eq('encounter_id', encounterId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('clinical_treatment_sessions').select('id').eq('encounter_id', encounterId).limit(1)
    ]);
    [diagnosisResult, planResult, sessionResult].forEach(result => { if (result.error) throw result.error; });
    return { state: 'ready', diagnosis: Boolean(diagnosisResult.data), treatment: Boolean(planResult.data || (sessionResult.data || []).length) };
  }

  async function loadStatus() {
    const box = $('#signoff-status');
    const encounterId = selectedId();
    const version = ++requestVersion;
    if (currentEncounter !== encounterId) locked = false;
    currentEncounter = encounterId;
    // Pending knowledge and actual record lock are separate. Overlapping reads
    // must never erase a known lock, nor allow editing an unknown record.
    setLockedUI(locked, false);
    setReadiness({ state: encounterId ? 'pending' : 'missing', diagnosis: false, treatment: false });
    if (!encounterId) {
      if (box) box.textContent = 'เลือก Encounter เพื่อดูสถานะ';
      setLockedUI(false);
      return { encounterId, version };
    }
    try {
      const [statusResult, readinessResult] = await Promise.all([
        db.from('clinical_record_signoffs').select('signer_name,professional_license_no,signed_at,lock_record,reason').eq('encounter_id', encounterId).eq('record_section', 'complete_record').maybeSingle(),
        readReadiness(encounterId)
      ]);
      if (statusResult.error) throw statusResult.error;
      if (!isCurrent(encounterId, version)) return null;
      readiness = readinessResult;
      const data = statusResult.data;
      if (data) {
        if (box) box.innerHTML = `<b>${data.lock_record ? 'SIGNED & LOCKED' : 'SIGNED • UNLOCKED FOR AMENDMENT'}</b><br>${esc(data.signer_name || '-')} • ${data.professional_license_no ? `ใบประกอบ ${esc(data.professional_license_no)} • ` : ''}${esc(new Date(data.signed_at).toLocaleString('th-TH'))}<br><small>${esc(data.reason || '')}</small>`;
      } else if (box) {
        const missing = !readiness.diagnosis || !readiness.treatment;
        box.innerHTML = missing ? '<b>ยังไม่พร้อมลงนาม</b><br><small>ต้องมี Diagnosis และ Treatment ก่อนจึงจะ Sign-off ได้</small>' : '<b>ยังไม่ลงนาม</b><br><small>พร้อมตรวจสอบและลงนาม</small>';
      }
      setLockedUI(Boolean(data?.lock_record));
      return { encounterId, version, data, readiness };
    } catch (error) {
      if (!isCurrent(encounterId, version)) return null;
      console.error('Clinical sign-off readiness failed');
      readiness = { state: 'error', diagnosis: false, treatment: false };
      if (box) box.textContent = 'ตรวจสอบความพร้อมลงนามไม่สำเร็จ กรุณาลองใหม่';
      setLockedUI(locked, false);
      return null;
    }
  }

  async function signAndLock(event) {
    event.preventDefault();
    if (submitting) return;
    const encounterId = selectedId();
    if (!encounterId || encounterId !== currentEncounter) return;
    if (!authorized) return;
    submitting = true;
    let dispatched = false;
    updateButton();
    try {
      const fresh = await loadStatus();
      if (!fresh || !isCurrent(fresh.encounterId, fresh.version) || fresh.readiness?.state !== 'ready' || !fresh.readiness.diagnosis || !fresh.readiness.treatment) {
        alert('ยังไม่พร้อมลงนาม กรุณาตรวจสอบ Diagnosis และ Treatment แล้วลองใหม่');
        return;
      }
      if (fresh.data?.lock_record) return;
      if (!confirm('ยืนยันลงนามและ Lock เวชระเบียนนี้? หลังจากนี้การแก้ไขต้องผ่าน Amendment')) return;
      if (encounterId !== selectedId() || encounterId !== currentEncounter || !authorized) return;
      dispatched = true;
      setLockedUI(locked, false);
      const result = await db.rpc('sign_clinical_record_complete', {
        p_encounter_id: encounterId,
        p_signer_name: $('#signer-name').value.trim() || null,
        p_license_no: $('#license-no').value.trim() || null,
        p_reason: $('#signoff-reason').value.trim() || 'Complete clinical record sign-off'
      });
      if (result.error) throw result.error;
      if (selectedId() === encounterId && currentEncounter === encounterId) setLockedUI(true);
      const readback = await loadStatus();
      if (selectedId() === encounterId) alert(readback?.data?.lock_record
        ? 'ลงนามและ Lock เวชระเบียนสำเร็จ'
        : 'ส่งคำลงนามแล้ว แต่ยังยืนยันผลอ่านกลับไม่ได้ กรุณาโหลดสถานะใหม่');
    } catch (error) {
      if (dispatched && selectedId() === encounterId && currentEncounter === encounterId) setLockedUI(locked, false);
      console.error('Clinical sign-off operation failed');
      alert(friendlyError(error));
    } finally {
      submitting = false;
      updateButton();
    }
  }

  async function init() {
    const runtime = await waitRuntime();
    db = runtime.getDb(); session = await runtime.getSession(); if (!session) return;
    profile = await runtime.getProfile(session.user.id);
    authorized = typeof runtime.can === 'function' && runtime.can(profile, 'clinical_write') === true;
    mount();
    const encounter = $('#encounter');
    if (encounter) encounter.addEventListener('change', () => loadStatus().catch(console.error));
    window.addEventListener('chananya:encounter-changed', event => {
      if (event.detail?.encounterId !== undefined) loadStatus().catch(console.error);
    });
    window.addEventListener('chananya:clinical-references-rendered', () => loadStatus().catch(console.error));
    window.addEventListener('chananya:diagnosis-saved', () => { if (currentEncounter) loadStatus().catch(console.error); });
    window.addEventListener('chananya:clinical-data-changed', event => {
      if (currentEncounter && (!event.detail?.encounterId || event.detail.encounterId === currentEncounter)) loadStatus().catch(console.error);
    });
    await loadStatus();
  }

  const start = () => init().catch(error => console.error('Clinical sign-off extension failed', error));
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
})();
