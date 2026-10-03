(() => {
  'use strict';

  const runtime = window.ChananyaRuntime;
  if (!runtime) return;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const valueOf = selector => $(selector)?.value || null;
  const numberOf = selector => {
    const value = $(selector)?.value;
    return value === '' || value == null ? null : Number(value);
  };
  const fields = [
    ['accident_history', '#opd-accident'],
    ['surgery_history', '#opd-surgery'],
    ['chronic_diseases', '#opd-chronic'],
    ['family_history', '#opd-family'],
    ['personal_history', '#opd-personal'],
    ['food_pattern', '#opd-food'],
    ['water_glasses_per_day', '#opd-water', true],
    ['tea_coffee_glasses_per_day', '#opd-coffee', true],
    ['smoking_detail', '#opd-smoking'],
    ['alcohol_detail', '#opd-alcohol'],
    ['urination_per_day', '#opd-urination', true],
    ['bowel_movement_per_day', '#opd-bowel', true],
    ['sleep_detail', '#opd-sleep'],
    ['posture_detail', '#opd-posture'],
    ['emotional_state', '#opd-emotion'],
    ['allergy_food_drug', '#opd-allergy'],
    ['menstruation_detail', '#opd-menstruation'],
    ['current_medicines_supplements', '#opd-meds'],
    ['physical_exam_narrative', '#opd-physical']
  ];
  const attempts = new Map();
  const OPERATION_TIMEOUT = 20000;
  let db, user, clinicId;
  let currentEncounter = null, encounterRevision = 0;
  let loadedHistoryEncounter = null, loadedHistoryRevision = 0;
  let historyLoadState = 'empty';

  function emitChanged(source, encounterId = currentEncounter) {
    window.dispatchEvent(new CustomEvent('chananya:clinical-data-changed', { detail: { encounterId, source } }));
  }
  function isActiveEncounter(encounterId, revision = encounterRevision) {
    return encounterId === currentEncounter && revision === encounterRevision && ($('#encounter')?.value || null) === encounterId;
  }
  function status(text) {
    const node = $('#opd-history-status');
    if (node) node.textContent = text;
  }
  function setHistoryBusy(busy) {
    const form = $('#opd-history-form');
    if (form) { form.inert = busy; form.setAttribute?.('aria-busy', String(busy)); }
  }
  function setVerify(attempt) {
    const button = $('#opd-history-verify');
    if (!button) return;
    button.hidden = !attempt || attempt.state !== 'uncertain';
    button.disabled = Boolean(attempt?.verifying || (attempt?.writeStarted && !attempt.writeSettled));
  }
  function bounded(operation) {
    let timer;
    return Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OPD_TIMEOUT')), OPERATION_TIMEOUT); })
    ]).finally(() => clearTimeout(timer));
  }
  function draft() { return Object.fromEntries(fields.map(([key, selector]) => [key, $(selector)?.value ?? ''])); }
  function showFields(values) {
    fields.forEach(([key, selector]) => { const element = $(selector); if (element) element.value = values[key] ?? ''; });
  }
  function capturePayload(encounterId) {
    const payload = { encounter_id: encounterId, updated_by: user.id, updated_at: new Date().toISOString() };
    for (const [key, selector, numeric] of fields) {
      const raw = $(selector)?.value ?? '';
      if (numeric && $(selector)?.validity?.badInput) throw new Error('OPD_NUMBER_INVALID');
      const value = raw === '' ? null : numeric ? Number(raw) : raw;
      if (numeric && value !== null && (!Number.isFinite(value) || value < 0 || value > 9999.99 || !Number.isInteger(value * 2))) {
        throw new Error('OPD_NUMBER_INVALID');
      }
      payload[key] = value;
    }
    return Object.freeze(payload);
  }
  async function authorize() {
    const session = await bounded(runtime.getSession());
    if (!session?.user?.id) throw new Error('OPD_AUTH');
    const profile = await bounded(runtime.getProfile(session.user.id));
    if (profile?.id !== session.user.id || !profile.clinic_id || profile.access_context_ready !== true || !runtime.can(profile, 'clinical_write')) {
      throw new Error('OPD_AUTH');
    }
    if (user && (session.user.id !== user.id || profile.clinic_id !== clinicId)) throw new Error('OPD_AUTH');
    const latest = await bounded(runtime.getSession());
    if (latest?.user?.id !== session.user.id) throw new Error('OPD_AUTH');
    return { user: session.user, clinicId: profile.clinic_id };
  }
  function validRow(row, encounterId) {
    return row && typeof row.id === 'string' && row.id.length > 0 && row.encounter_id === encounterId;
  }
  function matchingReadback(row, attempt) {
    const payload = attempt.payload;
    if (!validRow(row, attempt.id) || (attempt.rowId && row.id !== attempt.rowId)
      || row.updated_by !== payload.updated_by || Date.parse(row.updated_at) !== Date.parse(payload.updated_at)) return false;
    return fields.every(([key,, numeric]) => {
      if (!Object.hasOwn(row, key)) return false;
      if (payload[key] === null) return row[key] === null;
      if (row[key] === null || row[key] === undefined || row[key] === '') return false;
      return numeric ? Number(row[key]) === payload[key] : row[key] === payload[key];
    });
  }
  function renderAttempt(attempt) {
    if (!isActiveEncounter(attempt.id) || attempts.get(attempt.id) !== attempt) return;
    setHistoryBusy(attempt.state === 'pending' || attempt.verifying);
    setVerify(attempt);
    status(attempt.state === 'draft' ? attempt.draftMessage
      : attempt.state === 'pending' ? 'กำลังบันทึกและตรวจสอบ OPD History...'
      : attempt.verifying ? 'กำลังตรวจสอบผลบันทึกเดิม...'
      : 'ยังยืนยันผลบันทึกไม่ได้ เก็บร่างไว้แล้ว ห้ามส่งซ้ำ ใช้ปุ่มตรวจสอบผลเดิม');
  }
  function confirmAttempt(attempt) {
    if (attempts.get(attempt.id) !== attempt) return;
    // Recovery confirms the submitted snapshot, not edits made afterwards.
    // Keep those edits even when recovery completes while another visit is open.
    if (isActiveEncounter(attempt.id)) attempt.draft = draft();
    const edited = fields.some(([key]) => String(attempt.draft[key] ?? '') !== String(attempt.payload[key] ?? ''));
    if (edited) {
      attempt.state = 'draft';
      attempt.verifying = false;
      attempt.draftMessage = 'ตรวจสอบผลบันทึกเดิมแล้ว มีการแก้ไขบนหน้าจอที่ยังไม่บันทึก';
    }
    else attempts.delete(attempt.id);
    if (isActiveEncounter(attempt.id)) {
      setHistoryBusy(false);
      setVerify(null);
      status(edited ? 'ตรวจสอบผลบันทึกเดิมแล้ว มีการแก้ไขบนหน้าจอที่ยังไม่บันทึก' : 'บันทึก OPD History และตรวจสอบผลแล้ว');
    }
    emitChanged('opd-history', attempt.id);
  }

  async function loadHistory(encounterId = currentEncounter, revision = encounterRevision) {
    if (!isActiveEncounter(encounterId, revision)) return;
    setVerify(null);
    loadedHistoryEncounter = null;
    loadedHistoryRevision = revision;
    if (!encounterId) {
      historyLoadState = 'empty';
      $('#opd-history-form')?.reset();
      setHistoryBusy(false);
      status('เลือก Encounter ก่อน');
      return;
    }
    const prior = attempts.get(encounterId);
    if (prior) {
      showFields(prior.draft);
      loadedHistoryEncounter = encounterId;
      historyLoadState = 'ready';
      renderAttempt(prior);
      return;
    }
    historyLoadState = 'loading';
    $('#opd-history-form')?.reset();
    setHistoryBusy(true);
    status('กำลังโหลด OPD History...');
    try {
      const result = await bounded(db.from('ttm_opd_histories').select('*').eq('encounter_id', encounterId).maybeSingle());
      if (!isActiveEncounter(encounterId, revision)) return;
      if (result.error || (result.data && !validRow(result.data, encounterId))) throw new Error('OPD_LOAD');
      showFields(result.data || {});
      loadedHistoryEncounter = encounterId;
      historyLoadState = 'ready';
      setHistoryBusy(false);
      status(result.data ? 'โหลด OPD History แล้ว' : 'ยังไม่มี OPD History ใน Encounter นี้');
    } catch {
      if (!isActiveEncounter(encounterId, revision)) return;
      historyLoadState = 'error';
      setHistoryBusy(true);
      status('อ่าน OPD History ไม่ได้หรือไม่มีสิทธิ์ กรุณาเลือก Encounter ใหม่เพื่อลองอ่านอีกครั้ง');
    }
  }
  // Transport failures do not prove rejection. Restrict safe retry to explicit
  // PostgreSQL validation, constraint and authorization statement failures.
  function knownRejection(error) { return /^(22|23|28|42|P0)[A-Z0-9]{3}$/.test(String(error?.code || '')); }
  async function saveHistory(event) {
    event.preventDefault();
    const id = currentEncounter, revision = encounterRevision;
    if (!id) { status('เลือก Encounter ก่อน'); return; }
    if (attempts.has(id) && attempts.get(id).state !== 'draft') { renderAttempt(attempts.get(id)); return; }
    if (historyLoadState !== 'ready' || loadedHistoryEncounter !== id || loadedHistoryRevision !== revision) {
      status('กำลังโหลด OPD History ของ Encounter นี้ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    let payload;
    try { payload = capturePayload(id); }
    catch { status('ตัวเลขต้องเป็นค่าตั้งแต่ 0 ถึง 9999.5 โดยเพิ่มครั้งละ 0.5 กรุณาตรวจสอบก่อนบันทึก'); return; }
    const attempt = { id, payload, draft: draft(), state: 'pending', writeStarted: false, writeSettled: false, verifying: false };
    // Reserve synchronously before authentication or any awaited request.
    attempts.set(id, attempt);
    renderAttempt(attempt);
    let rejected = false;
    try {
      await authorize();
      const existing = await bounded(db.from('ttm_opd_histories').select('id,encounter_id').eq('encounter_id', id).maybeSingle());
      if (existing.error || (existing.data && !validRow(existing.data, id))) throw new Error('OPD_PREWRITE');
      attempt.rowId = existing.data?.id || null;
      if (!existing.data) attempt.payload = Object.freeze({ ...payload, created_by: user.id });
      await authorize();
      attempt.writeStarted = true;
      const write = Promise.resolve(db.from('ttm_opd_histories').upsert(attempt.payload, { onConflict: 'encounter_id' }));
      // Timing out does not cancel a write. Track real settlement separately.
      write.then(() => { attempt.writeSettled = true; renderAttempt(attempt); },
        () => { attempt.writeSettled = true; renderAttempt(attempt); });
      const result = await bounded(write);
      if (result?.error) { rejected = knownRejection(result.error); throw new Error('OPD_WRITE'); }
      const readback = await bounded(db.from('ttm_opd_histories').select('*').eq('encounter_id', id).maybeSingle());
      if (readback.error || !matchingReadback(readback.data, attempt)) throw new Error('OPD_READBACK');
      await authorize();
      confirmAttempt(attempt);
    } catch {
      if (!attempt.writeStarted || rejected) {
        if (isActiveEncounter(id)) attempt.draft = draft();
        attempt.state = 'draft';
        attempt.draftMessage = 'ยังไม่ได้บันทึก OPD History เก็บร่างไว้แล้ว กรุณาตรวจสอบสิทธิ์หรือสถานะล็อกก่อนลองใหม่';
        renderAttempt(attempt);
      } else {
        attempt.state = 'uncertain';
        renderAttempt(attempt);
      }
    }
  }
  async function verifyHistory() {
    const attempt = attempts.get(currentEncounter);
    if (!attempt || attempt.state !== 'uncertain' || attempt.verifying || !attempt.writeSettled) return;
    attempt.verifying = true;
    renderAttempt(attempt);
    try {
      await authorize();
      const result = await bounded(db.from('ttm_opd_histories').select('*').eq('encounter_id', attempt.id).maybeSingle());
      if (result.error || !matchingReadback(result.data, attempt)) throw new Error('OPD_READBACK');
      await authorize();
      confirmAttempt(attempt);
    } catch {
      // Read-only recovery: never retry a write automatically.
    } finally {
      attempt.verifying = false;
      renderAttempt(attempt);
    }
  }

  async function loadSessions(encounterId = currentEncounter, revision = encounterRevision) {
    const box = $('#opd-session-list');
    if (!box) return;
    if (!encounterId) {
      if (isActiveEncounter(encounterId, revision)) box.innerHTML = '<div class="status">เลือก Encounter ก่อน</div>';
      return;
    }
    const result = await db.from('clinical_treatment_sessions').select('*').eq('encounter_id', encounterId).order('session_no');
    if (!isActiveEncounter(encounterId, revision)) return;
    if (result.error) { box.innerHTML = '<div class="status danger">อ่าน Treatment Session ไม่ได้หรือไม่มีสิทธิ์</div>'; return; }
    box.innerHTML = (result.data || []).map(treatment => `<article class="opd-session"><strong>Session ${treatment.session_no}</strong> · ${esc(new Date(treatment.treated_at).toLocaleString('th-TH'))}<br>${esc((treatment.treatment_modalities || []).join(', '))}<br>${esc(treatment.treatment_detail)}<br><b>Pain:</b> ${esc(treatment.pain_before ?? '-')} → ${esc(treatment.pain_after ?? '-')}<br><b>Outcome:</b> ${esc(treatment.outcome_summary || '-')}</article>`).join('') || '<div class="status">ยังไม่มี Treatment Session</div>';
  }
  async function saveSession(event) {
    event.preventDefault();
    const targetEncounter = currentEncounter;
    const targetRevision = encounterRevision;
    if (!targetEncounter) throw new Error('เลือก Encounter ก่อน');
    const modalities = [...document.querySelectorAll('input[name="opd-modality"]:checked')].map(input => input.value);
    const result = await db.rpc('create_clinical_treatment_session', {
      p_encounter_id: targetEncounter,
      p_treatment_modalities: modalities,
      p_treatment_detail: valueOf('#opd-treatment-detail'),
      p_procedure_referral: $('#opd-procedure-referral').checked,
      p_procedure_referral_detail: valueOf('#opd-procedure-detail'),
      p_precautions: valueOf('#opd-precautions'),
      p_pain_before: numberOf('#opd-pain-before'),
      p_pain_after: numberOf('#opd-pain-after'),
      p_outcome_summary: valueOf('#opd-outcome'),
      p_advice: valueOf('#opd-advice')
    });
    if (result.error) throw result.error;
    if (isActiveEncounter(targetEncounter, targetRevision)) event.target.reset();
    await loadSessions(targetEncounter, targetRevision);
    emitChanged('treatment-session', targetEncounter);
  }
  function fail() { alert('ดำเนินการ OPD ไม่สำเร็จ กรุณาตรวจสอบสิทธิ์หรือสถานะรายการแล้วลองใหม่'); }
  async function init() {
    setHistoryBusy(true);
    try {
      db = runtime.getDb();
      const identity = await authorize();
      user = identity.user;
      clinicId = identity.clinicId;
    } catch { status('ไม่มีสิทธิ์บันทึกเวชระเบียน หรือ Session เปลี่ยน กรุณาเข้าสู่ระบบใหม่'); return; }
    const historyForm = $('#opd-history-form');
    const sessionForm = $('#opd-session-form');
    const encounter = $('#encounter');
    if (!historyForm || !sessionForm || !encounter) return;
    historyForm.addEventListener('submit', event => saveHistory(event).catch(fail));
    sessionForm.addEventListener('submit', event => saveSession(event).catch(fail));
    $('#opd-history-verify')?.addEventListener('click', verifyHistory);
    historyForm.addEventListener('input', () => {
      const attempt = attempts.get(currentEncounter);
      if (attempt) attempt.draft = draft();
      else if (historyLoadState === 'ready') status('มีการแก้ไข OPD History ที่ยังไม่บันทึก');
    });
    const syncEncounter = () => {
      const nextEncounter = encounter.value || null;
      if (nextEncounter === currentEncounter) return;
      const previous = attempts.get(currentEncounter);
      if (previous) previous.draft = draft();
      currentEncounter = nextEncounter;
      const revision = ++encounterRevision;
      sessionForm.reset();
      Promise.all([loadHistory(nextEncounter, revision), loadSessions(nextEncounter, revision)]).catch(fail);
    };
    encounter.addEventListener('change', syncEncounter);
    window.addEventListener('chananya:encounter-changed', syncEncounter);
    currentEncounter = encounter.value || null;
    const initialRevision = ++encounterRevision;
    await Promise.all([loadHistory(currentEncounter, initialRevision), loadSessions(currentEncounter, initialRevision)]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(fail), { once: true });
  else init().catch(fail);
})();
