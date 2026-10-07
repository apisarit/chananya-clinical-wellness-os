(() => {
  'use strict';

  const runtime = window.ChananyaRuntime;
  if (!runtime) return;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
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
  const sessionAttempts = new Map();
  const sessionDrafts = new Map();
  const LEGACY_SESSION_OPERATION_PREFIX = 'cnyos:treatment-session-operation:';
  const SESSION_OPERATION_PREFIX = `${LEGACY_SESSION_OPERATION_PREFIX}v2:`;
  const SESSION_OPERATION_IDENTITY_KEY = 'cnyos:treatment-session-operation-identity:v2';
  const OPERATION_TIMEOUT = 20000;
  let db, user, clinicId;
  let currentEncounter = null, encounterRevision = 0;
  let loadedHistoryEncounter = null, loadedHistoryRevision = 0;
  let historyLoadState = 'empty';
  let loadedSessionsEncounter = null, loadedSessionsRevision = 0;
  let sessionLoadState = 'empty';

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

  function sessionStatus(text) {
    const node = $('#opd-session-status');
    if (node) node.textContent = text;
  }
  function setSessionBusy(busy) {
    const form = $('#opd-session-form');
    if (form) { form.inert = busy; form.setAttribute?.('aria-busy', String(busy)); }
  }
  function setSessionVerify(attempt) {
    const button = $('#opd-session-verify');
    if (!button) return;
    button.hidden = !attempt || attempt.state !== 'uncertain';
    button.disabled = Boolean(attempt?.verifying);
  }
  function readSessionDraft() {
    return {
      modalities: [...document.querySelectorAll('input[name="opd-modality"]:checked')].map(input => input.value),
      painBefore: $('#opd-pain-before')?.value ?? '',
      painAfter: $('#opd-pain-after')?.value ?? '',
      treatmentDetail: $('#opd-treatment-detail')?.value ?? '',
      procedureReferral: Boolean($('#opd-procedure-referral')?.checked),
      procedureDetail: $('#opd-procedure-detail')?.value ?? '',
      precautions: $('#opd-precautions')?.value ?? '',
      outcome: $('#opd-outcome')?.value ?? '',
      advice: $('#opd-advice')?.value ?? ''
    };
  }
  function showSessionDraft(values = {}) {
    const selected = new Set(values.modalities || []);
    document.querySelectorAll('input[name="opd-modality"]').forEach(input => { input.checked = selected.has(input.value); });
    const assignments = [
      ['#opd-pain-before', 'painBefore'], ['#opd-pain-after', 'painAfter'],
      ['#opd-treatment-detail', 'treatmentDetail'], ['#opd-procedure-detail', 'procedureDetail'],
      ['#opd-precautions', 'precautions'], ['#opd-outcome', 'outcome'], ['#opd-advice', 'advice']
    ];
    assignments.forEach(([selector, key]) => { const element = $(selector); if (element) element.value = values[key] ?? ''; });
    const referral = $('#opd-procedure-referral');
    if (referral) referral.checked = Boolean(values.procedureReferral);
  }
  function hasSessionDraft(values) {
    return Boolean(values?.modalities?.length || values?.procedureReferral
      || ['painBefore', 'painAfter', 'treatmentDetail', 'procedureDetail', 'precautions', 'outcome', 'advice']
        .some(key => String(values?.[key] ?? '').length > 0));
  }
  function sameSessionDraft(left, right) {
    return JSON.stringify(left || {}) === JSON.stringify(right || {});
  }
  function rememberSessionDraft(encounterId = currentEncounter) {
    if (!encounterId) return;
    const value = readSessionDraft();
    if (hasSessionDraft(value)) sessionDrafts.set(encounterId, value);
    else if (!sessionAttempts.has(encounterId)) sessionDrafts.delete(encounterId);
    const attempt = sessionAttempts.get(encounterId);
    if (attempt) attempt.draft = value;
  }
  function trimmedValue(selector) {
    const value = $(selector)?.value ?? '';
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  function painValue(selector) {
    const element = $(selector);
    const raw = element?.value ?? '';
    if (element?.validity?.badInput) throw new Error('SESSION_PAIN_INVALID');
    if (raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error('SESSION_PAIN_INVALID');
    return value;
  }
  function validOperationId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }
  function newOperationId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) throw new Error('SESSION_OPERATION_ID_UNAVAILABLE');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function sessionOperationIdentity() {
    if (!clinicId || !user?.id) return null;
    return `${encodeURIComponent(clinicId)}:${encodeURIComponent(user.id)}`;
  }
  function sessionOperationKey(encounterId) {
    const identity = sessionOperationIdentity();
    if (!identity || !encounterId) return null;
    return `${SESSION_OPERATION_PREFIX}${identity}:${encodeURIComponent(encounterId)}`;
  }
  function reconcileSessionOperationIdentity() {
    try {
      const storage = window.sessionStorage;
      const identity = sessionOperationIdentity();
      if (!storage || !identity) return;
      if (storage.getItem(SESSION_OPERATION_IDENTITY_KEY) !== identity) {
        // Encounter-only keys cannot be attributed to the current practitioner.
        // On first v2 use or a same-tab identity handoff, discard them instead of
        // migrating an opaque operation UUID into the newly authenticated scope.
        for (let index = storage.length - 1; index >= 0; index -= 1) {
          const key = storage.key(index);
          if (key?.startsWith(LEGACY_SESSION_OPERATION_PREFIX)
              && !key.startsWith(SESSION_OPERATION_PREFIX)) storage.removeItem(key);
        }
      }
      storage.setItem(SESSION_OPERATION_IDENTITY_KEY, identity);
    } catch { /* scoped keys still prevent cross-identity reuse when storage is unavailable */ }
  }
  function storedOperationId(encounterId) {
    try {
      const key = sessionOperationKey(encounterId);
      if (!key) return null;
      const value = window.sessionStorage?.getItem(key);
      return validOperationId(value) ? value : null;
    } catch { return null; }
  }
  function rememberOperationId(encounterId, operationId) {
    try {
      const key = sessionOperationKey(encounterId);
      if (key) window.sessionStorage?.setItem(key, operationId);
    } catch { /* in-memory guard remains */ }
  }
  function clearOperationId(encounterId, operationId = null) {
    try {
      const key = sessionOperationKey(encounterId);
      if (!key) return;
      if (!operationId || window.sessionStorage?.getItem(key) === operationId) window.sessionStorage?.removeItem(key);
    } catch { /* storage may be unavailable */ }
  }
  function captureSessionPayload(encounterId, operationId) {
    const detail = trimmedValue('#opd-treatment-detail');
    if (!detail) throw new Error('SESSION_DETAIL_REQUIRED');
    return Object.freeze({
      p_encounter_id: encounterId,
      p_client_request_id: operationId,
      p_treatment_modalities: [...document.querySelectorAll('input[name="opd-modality"]:checked')].map(input => input.value),
      p_treatment_detail: detail,
      p_procedure_referral: Boolean($('#opd-procedure-referral')?.checked),
      p_procedure_referral_detail: trimmedValue('#opd-procedure-detail'),
      p_precautions: trimmedValue('#opd-precautions'),
      p_pain_before: painValue('#opd-pain-before'),
      p_pain_after: painValue('#opd-pain-after'),
      p_outcome_summary: trimmedValue('#opd-outcome'),
      p_advice: trimmedValue('#opd-advice')
    });
  }
  function validSessionIdentity(row, encounterId) {
    return row && typeof row.id === 'string' && row.id.length > 0
      && row.encounter_id === encounterId && Number.isInteger(Number(row.session_no))
      && Number(row.session_no) > 0;
  }
  function equalSessionValue(actual, expected, kind = 'text') {
    if (expected === null) return actual === null;
    if (kind === 'array') return Array.isArray(actual) && actual.length === expected.length
      && actual.every((value, index) => value === expected[index]);
    if (kind === 'number') return actual !== null && actual !== '' && Number(actual) === expected;
    if (kind === 'boolean') return actual === expected;
    return actual === expected;
  }
  function matchingSessionRow(row, attempt) {
    const payload = attempt.payload;
    return validSessionIdentity(row, attempt.id)
      && (!attempt.rowId || row.id === attempt.rowId)
      && row.client_request_id === attempt.operationId
      && row.practitioner_id === user.id
      && equalSessionValue(row.treatment_modalities, payload.p_treatment_modalities, 'array')
      && equalSessionValue(row.treatment_detail, payload.p_treatment_detail)
      && equalSessionValue(row.procedure_referral, payload.p_procedure_referral, 'boolean')
      && equalSessionValue(row.procedure_referral_detail, payload.p_procedure_referral_detail)
      && equalSessionValue(row.precautions, payload.p_precautions)
      && equalSessionValue(row.pain_before, payload.p_pain_before, 'number')
      && equalSessionValue(row.pain_after, payload.p_pain_after, 'number')
      && equalSessionValue(row.outcome_summary, payload.p_outcome_summary)
      && equalSessionValue(row.advice, payload.p_advice);
  }
  function oneRpcRow(data) {
    if (Array.isArray(data)) return data.length === 1 ? data[0] : null;
    return data && typeof data === 'object' ? data : null;
  }
  function validSessionList(rows, encounterId) {
    return Array.isArray(rows) && rows.every(row => validSessionIdentity(row, encounterId));
  }
  function renderSessions(rows) {
    const box = $('#opd-session-list');
    if (!box) return;
    box.innerHTML = rows.map(treatment => `<article class="opd-session"><strong>Session ${treatment.session_no}</strong> · ${esc(new Date(treatment.treated_at).toLocaleString('th-TH'))}<br>${esc((treatment.treatment_modalities || []).join(', '))}<br>${esc(treatment.treatment_detail)}<br><b>Pain:</b> ${esc(treatment.pain_before ?? '-')} → ${esc(treatment.pain_after ?? '-')}<br><b>Outcome:</b> ${esc(treatment.outcome_summary || '-')}</article>`).join('') || '<div class="status">ยังไม่มี Treatment Session</div>';
  }
  function renderSessionAttempt(attempt) {
    if (!isActiveEncounter(attempt.id) || sessionAttempts.get(attempt.id) !== attempt) return;
    setSessionBusy(attempt.state === 'pending' || attempt.verifying);
    setSessionVerify(attempt);
    sessionStatus(attempt.state === 'pending' ? 'กำลังบันทึกและตรวจสอบ Treatment Session...'
      : attempt.verifying ? 'กำลังตรวจสอบผลบันทึก Treatment Session เดิม...'
      : 'ยังยืนยันผลบันทึกไม่ได้ เก็บร่างไว้แล้ว ห้ามกดบันทึกซ้ำ ใช้ปุ่มตรวจสอบผลเดิม');
  }
  async function loadSessions(encounterId = currentEncounter, revision = encounterRevision) {
    const box = $('#opd-session-list');
    if (!box) return;
    if (!encounterId) {
      if (isActiveEncounter(encounterId, revision)) {
        loadedSessionsEncounter = null;
        loadedSessionsRevision = revision;
        sessionLoadState = 'empty';
        $('#opd-session-form')?.reset();
        setSessionBusy(false);
        setSessionVerify(null);
        sessionStatus('เลือก Encounter ก่อน');
        box.innerHTML = '<div class="status">เลือก Encounter ก่อน</div>';
      }
      return;
    }
    if (isActiveEncounter(encounterId, revision)) {
      loadedSessionsEncounter = null;
      loadedSessionsRevision = revision;
      sessionLoadState = 'loading';
      setSessionBusy(true);
      setSessionVerify(null);
      sessionStatus('กำลังโหลด Treatment Session...');
    }
    try {
      const result = await bounded(db.from('clinical_treatment_sessions').select('*').eq('encounter_id', encounterId).order('session_no'));
      if (!isActiveEncounter(encounterId, revision)) return;
      if (result.error || !validSessionList(result.data || [], encounterId)) throw new Error('SESSION_LOAD');
      const rows = result.data || [];
      const storedOperation = storedOperationId(encounterId);
      const recoveredOperation = storedOperation
        ? rows.find(row => row.client_request_id === storedOperation && row.practitioner_id === user.id)
        : null;
      if (recoveredOperation && !sessionAttempts.has(encounterId)) clearOperationId(encounterId, storedOperation);
      renderSessions(rows);
      loadedSessionsEncounter = encounterId;
      loadedSessionsRevision = revision;
      sessionLoadState = 'ready';
      $('#opd-session-form')?.reset();
      const savedDraft = sessionDrafts.get(encounterId);
      if (savedDraft) showSessionDraft(savedDraft);
      const attempt = sessionAttempts.get(encounterId);
      if (attempt) renderSessionAttempt(attempt);
      else {
        setSessionBusy(false);
        setSessionVerify(null);
        sessionStatus(recoveredOperation
          ? `พบและยืนยัน Session จากคำขอก่อนหน้าแล้ว (Session ${recoveredOperation.session_no})`
          : rows.length ? `โหลด Treatment Session แล้ว ${rows.length} รายการ` : 'ยังไม่มี Treatment Session ใน Encounter นี้');
      }
    } catch {
      if (!isActiveEncounter(encounterId, revision)) return;
      sessionLoadState = 'error';
      setSessionBusy(true);
      const savedDraft = sessionDrafts.get(encounterId);
      if (savedDraft) showSessionDraft(savedDraft);
      sessionStatus('อ่าน Treatment Session ไม่ได้หรือไม่มีสิทธิ์ กรุณาเลือก Encounter ใหม่เพื่อลองอ่านอีกครั้ง');
      box.innerHTML = '<div class="status danger">อ่าน Treatment Session ไม่ได้หรือไม่มีสิทธิ์</div>';
    }
  }
  async function readSessionAttempt(attempt) {
    // The server-enforced operation UUID is the durable identity when a
    // transport loses the inserted row acknowledgement.
    let query = db.from('clinical_treatment_sessions').select('*').eq('encounter_id', attempt.id);
    query = attempt.rowId ? query.eq('id', attempt.rowId) : query.eq('client_request_id', attempt.operationId);
    const result = await bounded(query.maybeSingle());
    if (result.error || !matchingSessionRow(result.data, attempt)) throw new Error('SESSION_READBACK');
    attempt.rowId = result.data.id;
    return result.data;
  }
  async function confirmSessionAttempt(attempt) {
    if (sessionAttempts.get(attempt.id) !== attempt) return;
    let latestDraft = attempt.draft;
    if (isActiveEncounter(attempt.id)) latestDraft = readSessionDraft();
    const edited = !sameSessionDraft(latestDraft, attempt.submittedDraft);
    sessionAttempts.delete(attempt.id);
    if (edited) sessionDrafts.set(attempt.id, latestDraft);
    else sessionDrafts.delete(attempt.id);
    clearOperationId(attempt.id, attempt.operationId);
    if (isActiveEncounter(attempt.id)) {
      const revision = encounterRevision;
      if (!edited) $('#opd-session-form')?.reset();
      setSessionVerify(null);
      await loadSessions(attempt.id, revision);
      if (isActiveEncounter(attempt.id, revision)) {
        if (edited) showSessionDraft(latestDraft);
        sessionStatus(edited
          ? 'ตรวจสอบ Session เดิมแล้ว มีร่างแก้ไขใหม่ที่ยังไม่บันทึก'
          : 'บันทึก Treatment Session และตรวจสอบผลแล้ว');
      }
    }
    emitChanged('treatment-session', attempt.id);
  }
  async function saveSession(event) {
    event.preventDefault();
    const id = currentEncounter, revision = encounterRevision;
    if (!id) { sessionStatus('เลือก Encounter ก่อน'); return; }
    const existingAttempt = sessionAttempts.get(id);
    if (existingAttempt) { renderSessionAttempt(existingAttempt); return; }
    if (sessionLoadState !== 'ready' || loadedSessionsEncounter !== id || loadedSessionsRevision !== revision) {
      sessionStatus('กำลังโหลด Treatment Session ของ Encounter นี้ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    let payload, operationId;
    try {
      operationId = storedOperationId(id) || newOperationId();
      payload = captureSessionPayload(id, operationId);
    }
    catch (error) {
      sessionStatus(error.message === 'SESSION_DETAIL_REQUIRED'
        ? 'กรุณาระบุวิธีการรักษาหรือรายละเอียดก่อนบันทึก'
        : error.message === 'SESSION_OPERATION_ID_UNAVAILABLE'
          ? 'เบราว์เซอร์นี้ไม่สามารถสร้างรหัสคำขอที่ปลอดภัยได้ จึงยังไม่ส่งข้อมูล'
          : 'คะแนนความปวดต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 10');
      return;
    }
    const submittedDraft = readSessionDraft();
    const attempt = {
      id, revision, operationId, payload, submittedDraft, draft: submittedDraft, baselineIds: new Set(),
      state: 'pending', writeStarted: false, writeSettled: false, verifying: false, rowId: null
    };
    sessionAttempts.set(id, attempt);
    sessionDrafts.set(id, submittedDraft);
    rememberOperationId(id, operationId);
    renderSessionAttempt(attempt);
    let rejected = false;
    try {
      await authorize();
      const before = await bounded(db.from('clinical_treatment_sessions').select('*').eq('encounter_id', id).order('session_no'));
      if (before.error || !validSessionList(before.data || [], id)) throw new Error('SESSION_PREWRITE');
      attempt.baselineIds = new Set((before.data || []).map(row => row.id));
      await authorize();
      attempt.writeStarted = true;
      const write = Promise.resolve().then(() => db.rpc('create_clinical_treatment_session', payload));
      write.then(result => {
        attempt.writeSettled = true;
        const row = oneRpcRow(result?.data);
        if (row && matchingSessionRow(row, attempt)) attempt.rowId = row.id;
        renderSessionAttempt(attempt);
      }, () => { attempt.writeSettled = true; renderSessionAttempt(attempt); });
      const result = await bounded(write);
      attempt.writeSettled = true;
      if (result?.error) { rejected = knownRejection(result.error); throw result.error; }
      const row = oneRpcRow(result?.data);
      if (!matchingSessionRow(row, attempt)) throw new Error('SESSION_ACK');
      attempt.rowId = row.id;
      await readSessionAttempt(attempt);
      await authorize();
      await confirmSessionAttempt(attempt);
    } catch {
      if (!attempt.writeStarted || rejected) {
        sessionAttempts.delete(id);
        if (isActiveEncounter(id)) attempt.draft = readSessionDraft();
        sessionDrafts.set(id, attempt.draft);
        if (isActiveEncounter(id)) {
          setSessionBusy(false);
          setSessionVerify(null);
          sessionStatus('ยังไม่ได้บันทึก Treatment Session เก็บร่างไว้แล้ว กรุณาตรวจสอบสิทธิ์ สถานะ Encounter หรือข้อมูลก่อนลองใหม่');
        }
      } else {
        attempt.state = 'uncertain';
        if (isActiveEncounter(id)) {
          attempt.draft = readSessionDraft();
          sessionDrafts.set(id, attempt.draft);
        }
        renderSessionAttempt(attempt);
      }
    }
  }
  async function verifySession() {
    const attempt = sessionAttempts.get(currentEncounter);
    if (!attempt || attempt.state !== 'uncertain' || attempt.verifying) return;
    attempt.verifying = true;
    renderSessionAttempt(attempt);
    try {
      await authorize();
      await readSessionAttempt(attempt);
      await authorize();
      await confirmSessionAttempt(attempt);
    } catch {
      // Verification is deliberately read-only. Never repeat the append-only RPC.
    } finally {
      attempt.verifying = false;
      renderSessionAttempt(attempt);
    }
  }
  function fail() { alert('ดำเนินการ OPD ไม่สำเร็จ กรุณาตรวจสอบสิทธิ์หรือสถานะรายการแล้วลองใหม่'); }
  async function init() {
    setHistoryBusy(true);
    setSessionBusy(true);
    try {
      db = runtime.getDb();
      const identity = await authorize();
      user = identity.user;
      clinicId = identity.clinicId;
      reconcileSessionOperationIdentity();
    } catch {
      status('ไม่มีสิทธิ์บันทึกเวชระเบียน หรือ Session เปลี่ยน กรุณาเข้าสู่ระบบใหม่');
      sessionStatus('ไม่มีสิทธิ์บันทึก Treatment Session หรือ Session ผู้ใช้เปลี่ยน กรุณาเข้าสู่ระบบใหม่');
      return;
    }
    const historyForm = $('#opd-history-form');
    const sessionForm = $('#opd-session-form');
    const encounter = $('#encounter');
    if (!historyForm || !sessionForm || !encounter) return;
    historyForm.addEventListener('submit', event => saveHistory(event).catch(fail));
    sessionForm.addEventListener('submit', event => saveSession(event).catch(fail));
    $('#opd-history-verify')?.addEventListener('click', verifyHistory);
    $('#opd-session-verify')?.addEventListener('click', verifySession);
    historyForm.addEventListener('input', () => {
      const attempt = attempts.get(currentEncounter);
      if (attempt) attempt.draft = draft();
      else if (historyLoadState === 'ready') status('มีการแก้ไข OPD History ที่ยังไม่บันทึก');
    });
    sessionForm.addEventListener('input', () => {
      if (!currentEncounter) return;
      const value = readSessionDraft();
      if (hasSessionDraft(value)) sessionDrafts.set(currentEncounter, value);
      else if (!sessionAttempts.has(currentEncounter)) sessionDrafts.delete(currentEncounter);
      const attempt = sessionAttempts.get(currentEncounter);
      if (attempt) attempt.draft = value;
      else if (sessionLoadState === 'ready') sessionStatus('มีร่าง Treatment Session ที่ยังไม่บันทึก');
    });
    window.addEventListener('beforeunload', event => {
      if (!sessionAttempts.size && ![...sessionDrafts.values()].some(hasSessionDraft)) return;
      // Do not persist clinical drafts in browser storage. Warn before the
      // in-memory duplicate guard or unsaved clinical content is discarded.
      event.preventDefault();
      event.returnValue = '';
    });
    const syncEncounter = () => {
      const nextEncounter = encounter.value || null;
      if (nextEncounter === currentEncounter) return;
      const previous = attempts.get(currentEncounter);
      if (previous) previous.draft = draft();
      rememberSessionDraft(currentEncounter);
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
