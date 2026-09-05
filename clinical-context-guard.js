(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const watchedForms = new Set([
    'exam-form',
    'diagnosis-form',
    'plan-form',
    'opd-history-form',
    'opd-session-form',
    'signoff-form'
  ]);

  let db = null;
  let encounterSelect = null;
  let refreshTimer = null;
  let refreshVersion = 0;

  async function waitRuntime() {
    for (let i = 0; i < 50; i += 1) {
      if (window.ChananyaRuntime) return window.ChananyaRuntime;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
  }

  function mount() {
    return $('#clinical-context-guard');
  }

  function text(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value ?? '—';
  }

  function ageAt(dateOfBirth) {
    if (!dateOfBirth) return null;
    const birth = new Date(`${dateOfBirth}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const beforeBirthday = now.getMonth() < birth.getMonth()
      || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
    if (beforeBirthday) age -= 1;
    return age >= 0 ? age : null;
  }

  function thaiDateTime(value) {
    if (!value) return 'ไม่ระบุเวลา';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('th-TH');
  }

  function setAlertState(selector, active, warning = false) {
    const box = $(selector);
    if (!box) return;
    box.classList.toggle('ccg-alert', Boolean(active && !warning));
    box.classList.toggle('ccg-warning', Boolean(active && warning));
  }

  function addChip(container, label, state, title) {
    const chip = document.createElement('span');
    chip.className = `ccg-chip ${state}`;
    chip.textContent = label;
    if (title) chip.title = title;
    container.appendChild(chip);
  }

  function resetContext(message = 'เลือก Encounter เพื่อดูบริบทผู้ป่วยและความพร้อมก่อนลงนาม') {
    text('#ccg-state', 'รอเลือก Encounter');
    text('#ccg-patient', '—');
    text('#ccg-demographic', '—');
    text('#ccg-encounter', '—');
    text('#ccg-encounter-meta', '—');
    text('#ccg-chief', '—');
    text('#ccg-allergies', message);
    text('#ccg-redflags', message);
    const readiness = $('#ccg-readiness');
    if (readiness) readiness.replaceChildren();
    setAlertState('#ccg-allergy-box', false);
    setAlertState('#ccg-redflag-box', false);
  }

  async function countRows(table, encounterId) {
    const result = await db.from(table)
      .select('id', { count: 'exact', head: true })
      .eq('encounter_id', encounterId);
    return { count: result.count || 0, error: result.error || null };
  }

  async function refresh() {
    const host = mount();
    const encounterId = encounterSelect?.value || '';
    const version = ++refreshVersion;
    if (!host || !encounterId) {
      resetContext();
      return;
    }

    host.setAttribute('aria-busy', 'true');
    text('#ccg-state', 'กำลังตรวจ Clinical context…');
    try {
      const encounterResult = await db.from('encounters')
        .select('id,encounter_no,patient_id,chief_complaint,red_flags,general_examination,started_at,status')
        .eq('id', encounterId)
        .maybeSingle();
      if (encounterResult.error) throw encounterResult.error;
      if (!encounterResult.data) throw new Error('ไม่พบ Encounter ที่เลือก');

      const encounter = encounterResult.data;
      const [patientResult, allergyResult, examResult, diagnosisResult, planResult, sessionResult, signoffResult] = await Promise.all([
        db.from('patients').select('id,hn,prefix,first_name,last_name,date_of_birth,gender').eq('id', encounter.patient_id).maybeSingle(),
        db.from('patient_allergies').select('*').eq('patient_id', encounter.patient_id).eq('status', 'active'),
        countRows('clinical_examination_findings', encounterId),
        db.from('ttm_structured_diagnoses').select('id').eq('encounter_id', encounterId).maybeSingle(),
        countRows('clinical_treatment_plans', encounterId),
        countRows('clinical_treatment_sessions', encounterId),
        db.from('clinical_record_signoffs').select('signed_at,lock_record,signer_name').eq('encounter_id', encounterId).eq('record_section', 'complete_record').maybeSingle()
      ]);

      if (version !== refreshVersion) return;
      const requiredErrors = [patientResult, diagnosisResult, signoffResult, examResult, planResult, sessionResult]
        .map(result => result?.error)
        .filter(Boolean);
      if (requiredErrors.length) throw requiredErrors[0];

      const patient = patientResult.data || {};
      const patientName = [patient.prefix, patient.first_name, patient.last_name].filter(Boolean).join(' ') || 'ไม่ระบุชื่อ';
      const age = ageAt(patient.date_of_birth);
      text('#ccg-patient', `${patient.hn || 'ไม่มี HN'} • ${patientName}`);
      text('#ccg-demographic', [patient.gender, age === null ? null : `อายุ ${age} ปี`].filter(Boolean).join(' • ') || 'ไม่ระบุข้อมูลประชากร');
      text('#ccg-encounter', encounter.encounter_no || encounter.id);
      text('#ccg-encounter-meta', `${thaiDateTime(encounter.started_at)} • ${encounter.status || 'ไม่ระบุสถานะ'}`);
      text('#ccg-chief', encounter.chief_complaint || 'ยังไม่บันทึกอาการสำคัญ');

      const allergies = allergyResult.error ? [] : (allergyResult.data || []);
      const allergyText = allergyResult.error
        ? `อ่านข้อมูลการแพ้ไม่ได้: ${allergyResult.error.message}`
        : allergies.length
          ? allergies.map(item => [item.allergen_name || item.allergen, item.reaction, item.severity].filter(Boolean).join(' — ')).join(' | ')
          : 'ไม่พบรายการแพ้ที่ active — โปรดยืนยันกับผู้รับบริการทุกครั้ง';
      text('#ccg-allergies', allergyText);
      setAlertState('#ccg-allergy-box', allergies.length > 0 || Boolean(allergyResult.error), Boolean(allergyResult.error));

      const redFlags = encounter.red_flags || encounter.general_examination || '';
      text('#ccg-redflags', redFlags || 'ไม่พบข้อมูล red flags/ผลตรวจเดิม — โปรดประเมินก่อนรักษา');
      setAlertState('#ccg-redflag-box', Boolean(redFlags), true);

      const readiness = $('#ccg-readiness');
      readiness.replaceChildren();
      addChip(readiness, examResult.count > 0 ? `ผลตรวจ ${examResult.count} รายการ` : 'ยังไม่มีผลตรวจ', examResult.count > 0 ? 'ready' : 'missing', 'ผลตรวจเป็นรายการแนะนำก่อนลงนาม');
      addChip(readiness, diagnosisResult.data ? 'Diagnosis พร้อม' : 'ต้องมี Diagnosis', diagnosisResult.data ? 'ready' : 'missing');
      const treatmentReady = planResult.count > 0 || sessionResult.count > 0;
      addChip(readiness, treatmentReady ? 'Treatment พร้อม' : 'ต้องมี Plan/Session', treatmentReady ? 'ready' : 'missing');
      if (signoffResult.data?.lock_record) {
        addChip(readiness, 'SIGNED & LOCKED', 'locked', `ลงนาม ${thaiDateTime(signoffResult.data.signed_at)}`);
      } else if (signoffResult.data) {
        addChip(readiness, 'เปิด Amendment', 'missing', `ลงนามเดิม ${thaiDateTime(signoffResult.data.signed_at)}`);
      } else {
        addChip(readiness, diagnosisResult.data && treatmentReady ? 'พร้อม Sign-off' : 'ยังไม่พร้อม Sign-off', diagnosisResult.data && treatmentReady ? 'ready' : 'missing');
      }
      text('#ccg-state', signoffResult.data?.lock_record ? 'เวชระเบียนถูก Lock' : 'Clinical context พร้อมตรวจสอบ');
    } catch (error) {
      if (version !== refreshVersion) return;
      console.error('Clinical context guard refresh failed', error);
      text('#ccg-state', 'ตรวจ readiness ไม่สำเร็จ');
      text('#ccg-allergies', error.message || String(error));
      text('#ccg-redflags', 'โปรดตรวจ release gate และสิทธิ์ RLS ก่อนลงนาม');
      setAlertState('#ccg-allergy-box', true, true);
      setAlertState('#ccg-redflag-box', true, true);
    } finally {
      if (version === refreshVersion) host.setAttribute('aria-busy', 'false');
    }
  }

  function scheduleRefresh(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(console.error), delay);
  }

  async function init() {
    const runtime = await waitRuntime();
    db = runtime.getDb();
    const session = await runtime.getSession();
    if (!session) return;
    encounterSelect = $('#encounter');
    if (!encounterSelect || !mount()) return;
    encounterSelect.addEventListener('change', () => scheduleRefresh());
    document.addEventListener('submit', event => {
      if (watchedForms.has(event.target?.id)) scheduleRefresh(1100);
    }, true);
    ['chananya:diagnosis-saved', 'chananya:signoff-changed', 'chananya:clinical-data-changed'].forEach(eventName => {
      window.addEventListener(eventName, () => scheduleRefresh(150));
    });
    window.ChananyaClinicalContext = Object.freeze({ refresh: () => scheduleRefresh() });
    scheduleRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(console.error), { once: true });
  } else {
    init().catch(console.error);
  }
})();
