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
  const setValue = (selector, value) => { const element = $(selector); if (element) element.value = value ?? ''; };

  let db;
  let user;
  let currentEncounter = null;
  let encounterRevision = 0;
  let loadedHistoryEncounter = null;
  let loadedHistoryRevision = 0;
  let historyLoadState = 'empty';

  function emitChanged(source, encounterId = currentEncounter) {
    window.dispatchEvent(new CustomEvent('chananya:clinical-data-changed', { detail: { encounterId, source } }));
  }

  function isActiveEncounter(encounterId, revision) {
    return encounterId === currentEncounter && revision === encounterRevision && ($('#encounter')?.value || null) === encounterId;
  }

  function setHistoryBusy(busy) {
    const form = $('#opd-history-form');
    if (!form) return;
    form.inert = busy;
    form.setAttribute?.('aria-busy', String(busy));
  }

  async function loadHistory(encounterId = currentEncounter, revision = encounterRevision) {
    const form = $('#opd-history-form');
    if (!encounterId) {
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
    if (existing.error) throw existing.error;
    if (!existing.data) payload.created_by = user.id;
    const result = await db.from('ttm_opd_histories').upsert(payload, { onConflict: 'encounter_id' });
    if (result.error) throw result.error;
    if (isActiveEncounter(targetEncounter, targetRevision)) $('#opd-history-status').textContent = 'บันทึก OPD History แล้ว';
    emitChanged('opd-history', targetEncounter);
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

  function fail(error) {
    console.error(error);
    alert(error?.message || String(error));
  }

  async function init() {
    db = runtime.getDb();
    const runtimeSession = await runtime.getSession();
    if (!runtimeSession) return;
    user = runtimeSession.user;
    const historyForm = $('#opd-history-form');
    const sessionForm = $('#opd-session-form');
    const encounter = $('#encounter');
    if (!historyForm || !sessionForm || !encounter) return;
    historyForm.addEventListener('submit', event => saveHistory(event).catch(fail));
    sessionForm.addEventListener('submit', event => saveSession(event).catch(fail));
    const syncEncounter = () => {
      const nextEncounter = encounter.value || null;
      if (nextEncounter === currentEncounter) return;
      currentEncounter = nextEncounter;
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(fail), { once: true });
  else init().catch(fail);
})();
