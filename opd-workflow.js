(() => {
  'use strict';

  const runtime = window.ChananyaRuntime;
  if (!runtime) { console.error('ChananyaRuntime is required before OPD workflow'); return; }

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const valueOf = selector => $(selector)?.value || null;
  const numberOf = selector => {
    const value = $(selector)?.value;
    return value === '' || value == null ? null : Number(value);
  };
  function durationMinutes() {
    const raw = valueOf('#opd-duration-minutes');
    const value = raw === null ? NaN : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1440) {
      throw new Error('กรุณาระบุระยะเวลาการรักษาเป็นจำนวนนาทีเต็ม 1–1440 นาที');
    }
    return value;
  }
  const setValue = (selector, value) => { const element = $(selector); if (element) element.value = value ?? ''; };

  let db;
  let user;
  let currentEncounter = null;
  let encounterRevision = 0;
  let loadedHistoryEncounter = null;
  let loadedHistoryRevision = 0;
  let historyLoadState = 'empty';
  let accountBlocked = false;
  const loadedSessions = new Map();
  const durationAmendmentsPending = new Set();
  const sessionSavesPending = new Set();

  function blockAccount() {
    if (accountBlocked) return;
    accountBlocked = true;
    encounterRevision += 1;
    currentEncounter = null;
    loadedHistoryEncounter = null;
    historyLoadState = 'blocked';
    loadedSessions.clear();
    for (const selector of ['#opd-history-form', '#opd-session-form']) {
      const form = $(selector);
      if (form) { form.reset(); form.inert = true; }
    }
    const list = $('#opd-session-list'); if (list) list.textContent = '';
    const status = $('#opd-history-status');
    if (status) status.textContent = 'บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่';
  }

  function requireAccount() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
  }

  function emitChanged(source, encounterId = currentEncounter) {
    if (accountBlocked) return;
    window.dispatchEvent(new CustomEvent('chananya:clinical-data-changed', { detail: { encounterId, source } }));
  }

  function isActiveEncounter(encounterId, revision) {
    return !accountBlocked && encounterId === currentEncounter && revision === encounterRevision && ($('#encounter')?.value || null) === encounterId;
  }

  function setHistoryBusy(busy) {
    const form = $('#opd-history-form');
    if (!form) return;
    form.inert = busy;
    form.setAttribute?.('aria-busy', String(busy));
  }

  async function loadHistory(encounterId = currentEncounter, revision = encounterRevision) {
    if (accountBlocked) return;
    const form = $('#opd-history-form');
    if (!encounterId) {
      loadedSessions.clear();
      if (!isActiveEncounter(encounterId, revision)) return;
      loadedHistoryEncounter = null;
      loadedHistoryRevision = revision;
      historyLoadState = 'empty';
      form?.reset();
      setHistoryBusy(false);
      $('#opd-history-status').textContent = 'เลือก Encounter ก่อน';
      return;
    }
    if (isActiveEncounter(encounterId, revision)) {
      loadedHistoryEncounter = null;
      loadedHistoryRevision = revision;
      historyLoadState = 'loading';
      form?.reset();
      setHistoryBusy(true);
      $('#opd-history-status').textContent = 'กำลังโหลด OPD History...';
    }
    const result = await db.from('ttm_opd_histories').select('*').eq('encounter_id', encounterId).maybeSingle();
    if (!isActiveEncounter(encounterId, revision)) return;
    if (result.error) {
      historyLoadState = 'error';
      $('#opd-history-status').textContent = 'อ่าน OPD History ไม่ได้หรือไม่มีสิทธิ์';
      return;
    }
    const data = result.data || {};
    setValue('#opd-accident', data.accident_history);
    setValue('#opd-surgery', data.surgery_history);
    setValue('#opd-chronic', data.chronic_diseases);
    setValue('#opd-family', data.family_history);
    setValue('#opd-personal', data.personal_history);
    setValue('#opd-food', data.food_pattern);
    setValue('#opd-water', data.water_glasses_per_day);
    setValue('#opd-coffee', data.tea_coffee_glasses_per_day);
    setValue('#opd-smoking', data.smoking_detail);
    setValue('#opd-alcohol', data.alcohol_detail);
    setValue('#opd-urination', data.urination_per_day);
    setValue('#opd-bowel', data.bowel_movement_per_day);
    setValue('#opd-sleep', data.sleep_detail);
    setValue('#opd-posture', data.posture_detail);
    setValue('#opd-emotion', data.emotional_state);
    setValue('#opd-allergy', data.allergy_food_drug);
    setValue('#opd-menstruation', data.menstruation_detail);
    setValue('#opd-meds', data.current_medicines_supplements);
    setValue('#opd-physical', data.physical_exam_narrative);
    loadedHistoryEncounter = encounterId;
    loadedHistoryRevision = revision;
    historyLoadState = 'ready';
    setHistoryBusy(false);
    $('#opd-history-status').textContent = result.data ? 'โหลด OPD History แล้ว' : 'ยังไม่มี OPD History ใน Encounter นี้';
  }

  async function saveHistory(event) {
    event.preventDefault();
    requireAccount();
    const targetEncounter = currentEncounter;
    const targetRevision = encounterRevision;
    if (!targetEncounter) throw new Error('เลือก Encounter ก่อน');
    if (historyLoadState !== 'ready' || loadedHistoryEncounter !== targetEncounter || loadedHistoryRevision !== targetRevision) {
      throw new Error('กำลังโหลด OPD History ของ Encounter นี้ กรุณารอสักครู่แล้วลองใหม่');
    }
    const payload = {
      encounter_id: targetEncounter,
      accident_history: valueOf('#opd-accident'),
      surgery_history: valueOf('#opd-surgery'),
      chronic_diseases: valueOf('#opd-chronic'),
      family_history: valueOf('#opd-family'),
      personal_history: valueOf('#opd-personal'),
      food_pattern: valueOf('#opd-food'),
      water_glasses_per_day: numberOf('#opd-water'),
      tea_coffee_glasses_per_day: numberOf('#opd-coffee'),
      smoking_detail: valueOf('#opd-smoking'),
      alcohol_detail: valueOf('#opd-alcohol'),
      urination_per_day: numberOf('#opd-urination'),
      bowel_movement_per_day: numberOf('#opd-bowel'),
      sleep_detail: valueOf('#opd-sleep'),
      posture_detail: valueOf('#opd-posture'),
      emotional_state: valueOf('#opd-emotion'),
      allergy_food_drug: valueOf('#opd-allergy'),
      menstruation_detail: valueOf('#opd-menstruation'),
      current_medicines_supplements: valueOf('#opd-meds'),
      physical_exam_narrative: valueOf('#opd-physical'),
      updated_by: user.id,
      updated_at: new Date().toISOString()
    };
    const existing = await db.from('ttm_opd_histories').select('id').eq('encounter_id', targetEncounter).maybeSingle();
    requireAccount();
    if (existing.error) throw existing.error;
    if (!existing.data) payload.created_by = user.id;
    const result = await db.from('ttm_opd_histories').upsert(payload, { onConflict: 'encounter_id' });
    requireAccount();
    if (result.error) throw result.error;
    if (isActiveEncounter(targetEncounter, targetRevision)) $('#opd-history-status').textContent = 'บันทึก OPD History แล้ว';
    emitChanged('opd-history', targetEncounter);
  }

  async function loadSessions(encounterId = currentEncounter, revision = encounterRevision) {
    if (accountBlocked) return;
    const box = $('#opd-session-list');
    if (!box) return;
    if (!encounterId) {
      if (isActiveEncounter(encounterId, revision)) box.innerHTML = '<div class="status">เลือก Encounter ก่อน</div>';
      return;
    }
    const result = await db.from('clinical_treatment_sessions').select('*').eq('encounter_id', encounterId).order('session_no');
    if (!isActiveEncounter(encounterId, revision)) return;
    if (result.error) { box.innerHTML = '<div class="status danger">อ่าน Treatment Session ไม่ได้หรือไม่มีสิทธิ์</div>'; return false; }
    loadedSessions.clear();
    (result.data || []).forEach(treatment => loadedSessions.set(treatment.id, treatment));
    box.innerHTML = (result.data || []).map(treatment => {
      const duration = Number.isSafeInteger(Number(treatment.duration_minutes)) && Number(treatment.duration_minutes) > 0
        ? `${Number(treatment.duration_minutes)} นาที` : '-';
      const correction = treatment.duration_minutes == null ? `<form class="form" data-duration-amend="${esc(treatment.id)}"><p class="full">Session เดิมยังไม่มีเวลาจริง จึงยังคิดค่าบริการไม่ได้ หากลงนามแล้วให้ Admin เปิด Amendment ก่อน และลงนามใหม่หลังแก้ไข</p><label>เวลารักษาจริง (นาที)<input name="minutes" type="number" min="1" max="1440" step="1" required></label><label>เหตุผลการเติมข้อมูล<input name="reason" minlength="5" maxlength="500" required></label><button type="submit" class="btn ghost full">บันทึกเวลาจริงพร้อม Audit</button></form>` : '';
      return `<article class="opd-session"><strong>Session ${esc(treatment.session_no)}</strong> · ${esc(new Date(treatment.treated_at).toLocaleString('th-TH'))}<br>${esc((treatment.treatment_modalities || []).join(', '))}<br>${esc(treatment.treatment_detail)}<br><b>ระยะเวลา:</b> ${esc(duration)}<br><b>Pain:</b> ${esc(treatment.pain_before ?? '-')} → ${esc(treatment.pain_after ?? '-')}<br><b>Outcome:</b> ${esc(treatment.outcome_summary || '-')}${correction}</article>`;
    }).join('') || '<div class="status">ยังไม่มี Treatment Session</div>';
    return true;
  }

  async function amendDuration(event) {
    const form = event.target.closest('[data-duration-amend]');
    if (!form) return;
    event.preventDefault();
    requireAccount();
    const id = form.dataset.durationAmend;
    const treatment = loadedSessions.get(id);
    const encounterId = currentEncounter;
    const revision = encounterRevision;
    if (!treatment || treatment.encounter_id !== encounterId || !isActiveEncounter(encounterId, revision)) throw new Error('กรุณาโหลด Session ของ Encounter ปัจจุบันก่อน');
    if (durationAmendmentsPending.has(id)) return;
    const minutes = Number(form.querySelector('[name="minutes"]').value);
    const reason = form.querySelector('[name="reason"]').value.trim();
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || reason.length < 5 || reason.length > 500) throw new Error('กรุณาระบุเวลาจริง 1–1440 นาที และเหตุผลอย่างน้อย 5 ตัวอักษร');
    durationAmendmentsPending.add(id);
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await db.rpc('amend_treatment_session_duration', { p_session_id: id, p_duration_minutes: minutes, p_expected_duration_minutes: treatment.duration_minutes, p_reason: reason });
      requireAccount();
      if (result.error) {
        if (String(result.error.message).includes('LOCKED')) throw new Error('เวชระเบียนลงนามแล้ว ต้องให้ Admin เปิด Amendment ก่อน ไม่สามารถแก้เวลาข้ามการอนุมัติได้');
        throw result.error;
      }
      await loadSessions(encounterId, revision);
      emitChanged('treatment-duration-amendment', encounterId);
    } finally { durationAmendmentsPending.delete(id); if (!accountBlocked) button.disabled = false; }
  }

  async function saveSession(event) {
    event.preventDefault();
    requireAccount();
    const targetEncounter = currentEncounter;
    const targetRevision = encounterRevision;
    if (!targetEncounter) throw new Error('เลือก Encounter ก่อน');
    if (sessionSavesPending.has(targetEncounter)) return;
    sessionSavesPending.add(targetEncounter);
    // Store only an opaque request reference and digest, never clinical narrative.
    const storageKey = 'cnyos:treatment-request:' + user.id + ':' + targetEncounter;
    try {
      let previous;
      try {
        previous = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null');
        if (previous && (!/^[a-f0-9-]{36}$/i.test(previous.id) || !/^[a-f0-9]{64}$/i.test(previous.fingerprint))) {
          throw new Error('invalid saved request');
        }
      } catch (_) { throw new Error('อ่านสถานะคำขอบันทึกเดิมไม่ได้ กรุณาติดต่อผู้ดูแลก่อนบันทึกซ้ำ'); }
      if (previous) {
        const lookup = await db.rpc('get_clinical_treatment_session_request', {
          p_request_id: previous.id, p_encounter_id: targetEncounter
        });
        requireAccount();
        if (lookup.error) throw new Error('ยังตรวจผลคำขอเดิมไม่ได้ กรุณาลองตรวจอีกครั้ง ห้ามสร้างรายการใหม่');
        const recovered = Array.isArray(lookup.data) ? lookup.data[0] : lookup.data;
        if (recovered?.id) {
          window.sessionStorage.removeItem(storageKey);
          if (isActiveEncounter(targetEncounter, targetRevision)) event.target.reset();
          const recoveredReadBack = await loadSessions(targetEncounter, targetRevision);
          if (recoveredReadBack === false) throw new Error('พบการบันทึกเดิมแล้ว แต่อ่านรายการกลับไม่ได้ กรุณาโหลดรายการใหม่ ไม่ต้องบันทึกซ้ำ');
          emitChanged('treatment-session', targetEncounter);
          throw new Error('พบการบันทึกเดิมแล้ว ไม่ได้สร้างรายการซ้ำ กรุณาตรวจรายการก่อนเพิ่มการรักษาครั้งใหม่');
        }
      }
      if (!isActiveEncounter(targetEncounter, targetRevision)) return;
      const payload = {
        p_encounter_id: targetEncounter,
        p_treatment_modalities: [...document.querySelectorAll('input[name="opd-modality"]:checked')].map(input => input.value),
        p_treatment_detail: valueOf('#opd-treatment-detail'),
        p_procedure_referral: $('#opd-procedure-referral').checked,
        p_procedure_referral_detail: valueOf('#opd-procedure-detail'),
        p_precautions: valueOf('#opd-precautions'),
        p_pain_before: numberOf('#opd-pain-before'),
        p_pain_after: numberOf('#opd-pain-after'),
        p_outcome_summary: valueOf('#opd-outcome'),
        p_advice: valueOf('#opd-advice'),
        p_duration_minutes: durationMinutes()
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      requireAccount();
      if (!isActiveEncounter(targetEncounter, targetRevision)) return;
      if (previous && previous.fingerprint !== fingerprint) {
        throw new Error('คำขอเดิมยังไม่ยืนยันผล กรุณาคงข้อมูลเดิมก่อนลองใหม่ ห้ามเปลี่ยนข้อมูลแล้วบันทึกเป็นรายการใหม่');
      }
      const request = previous || { id: crypto.randomUUID(), fingerprint };
      try { window.sessionStorage.setItem(storageKey, JSON.stringify(request)); }
      catch (_) { throw new Error('เก็บรหัสคำขอไม่ได้ จึงยังไม่ส่งการบันทึก เพื่อป้องกันรายการซ้ำ'); }
      const result = await db.rpc('create_clinical_treatment_session_idempotent', {
        ...payload, p_request_id: request.id
      });
      // Preserve the recovery marker when the initiating account has gone away.
      requireAccount();
      if (result.error) {
        // Only an explicit database rejection proves this transaction did not commit.
        if (['P0001', '22023', '23514', '42501', '28000'].includes(result.error.code)
            && !/CONFLICT|REUSED/.test(result.error.message || '')) {
          window.sessionStorage.removeItem(storageKey);
          throw result.error;
        }
        throw new Error('ยังยืนยันผลการบันทึกไม่ได้ รหัสคำขอเดิมถูกเก็บไว้ ให้ลองใหม่ด้วยข้อมูลเดิมเพื่อตรวจผลก่อน');
      }
      window.sessionStorage.removeItem(storageKey);
      if (isActiveEncounter(targetEncounter, targetRevision)) event.target.reset();
      const readBack = await loadSessions(targetEncounter, targetRevision);
      if (readBack === false) throw new Error('บันทึกการรักษาแล้ว แต่อ่านรายการกลับไม่ได้ กรุณาโหลดรายการใหม่ ไม่ต้องบันทึกซ้ำ');
      emitChanged('treatment-session', targetEncounter);
    } finally {
      sessionSavesPending.delete(targetEncounter);
    }
  }

  function fail(error) {
    if (accountBlocked) return;
    if (String(error?.message || '').includes('TREATMENT_SESSION_ALREADY_BILLED')) {
      alert('Encounter นี้ออกบิลแล้ว ไม่สามารถเพิ่มหรือลบรายการรักษา หรือเปลี่ยนเวลาที่ใช้คิดเงินได้ กรุณาประสานฝ่ายการเงินเรื่องแก้ไขบิล หากเป็นบริการครั้งใหม่ให้เปิด Encounter ใหม่');
      return;
    }
    console.error(error);
    alert(error?.message || String(error));
  }

  async function init() {
    db = runtime.getDb();
    const runtimeSession = await runtime.getSession();
    if (!runtimeSession) return;
    user = runtimeSession.user;
    const originalActor = user.id;
    db.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT' || !nextSession?.user?.id || nextSession.user.id !== originalActor) blockAccount();
    });
    if (accountBlocked) return;
    const historyForm = $('#opd-history-form');
    const sessionForm = $('#opd-session-form');
    const encounter = $('#encounter');
    if (!historyForm || !sessionForm || !encounter) return;
    historyForm.addEventListener('submit', event => saveHistory(event).catch(fail));
    sessionForm.addEventListener('submit', event => saveSession(event).catch(fail));
    $('#opd-session-list')?.addEventListener('submit', event => amendDuration(event).catch(fail));
    const syncEncounter = () => {
      if (accountBlocked) return;
      const nextEncounter = encounter.value || null;
      if (nextEncounter === currentEncounter) return;
      currentEncounter = nextEncounter;
      loadedSessions.clear();
      const revision = ++encounterRevision;
      $('#opd-session-form')?.reset();
      Promise.all([loadHistory(nextEncounter, revision), loadSessions(nextEncounter, revision)]).catch(fail);
    };
    encounter.addEventListener('change', () => {
      syncEncounter();
    });
    window.addEventListener('chananya:encounter-changed', () => {
      syncEncounter();
    });
    currentEncounter = encounter.value || null;
    const initialRevision = ++encounterRevision;
    await Promise.all([loadHistory(currentEncounter, initialRevision), loadSessions(currentEncounter, initialRevision)]);
  }

  window.addEventListener('pagehide', event => { if (event.persisted) blockAccount(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(fail), { once: true });
  else init().catch(fail);
})();
