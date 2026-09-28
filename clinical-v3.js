(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const num = value => {
    const normalized = String(value ?? '').trim().replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

  let db;
  let session;
  let profile;
  let currentEncounter = null;
  let patients = [];
  let products = [];
  let encounters = [];
  let prescriptionCart = [];
  let prescriptionCartEncounterId = null;
  let prescriptionCartVersion = 0;
  let prescriptionSubmitting = false;
  let encounterLoadVersion = 0;
  let referenceLoadVersion = 0;
  let hybridIdentityReady = false;
  let atomicHandoffsReady = false;
  let accountBlocked = false;

  function blockClinicalAccess() {
    if (accountBlocked) return;
    accountBlocked = true;
    referenceLoadVersion += 1;
    encounterLoadVersion += 1;
    currentEncounter = null;
    patients = []; products = []; encounters = []; prescriptionCart = [];
    const app = $('#app');
    app.classList.add('hidden');
    app.inert = true;
    $$('#app input, #app textarea, #app select').forEach(control => { control.value = ''; control.disabled = true; });
    $$('#app select').forEach(control => { control.textContent = ''; });
    ['#exam-list','#diagnosis-status','#plan-status','#opd-session-list','#rx-cart','#rx-handoff-receipt'].forEach(selector => {
      const element = $(selector); if (element) element.textContent = '';
    });
    $$('dialog[open]').forEach(dialog => { dialog.close(); dialog.textContent = ''; });
    $('#boot').classList.remove('hidden');
    $('#boot-error').textContent = 'บัญชีหรือ session เปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่ ก่อนทำรายการต่อ';
  }

  function watchClinicalSession() {
    const originalActor = session.user.id;
    return db.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT' || !nextSession?.user?.id || nextSession.user.id !== originalActor) blockClinicalAccess();
    });
  }

  function requireClinicalSession() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
  }

  function toast(message) {
    if (accountBlocked) return;
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
  }

  function fail(error) {
    if (accountBlocked) return;
    console.error(error);
    alert(error?.message || String(error));
  }

  function patientName(id) {
    const patient = patients.find(item => item.id === id);
    return patient ? `${patient.prefix || patient.title || ''}${patient.first_name || ''} ${patient.last_name || ''}`.trim() : '-';
  }

  function optionRows(rows, label) {
    return '<option value="">เลือก</option>' + rows.map(item => `<option value="${item.id}">${esc(label(item))}</option>`).join('');
  }

  function syncPrescriptionUnit() {
    const product = products.find(item => item.id === $('#rx-product').value);
    $('#rx-unit').value = product?.dispense_unit || '';
  }

  function requireAtomicHandoffs() {
    if (!atomicHandoffsReady) {
      throw new Error('ฐานข้อมูลยังไม่เปิดใช้ Atomic Clinical/Financial Handoffs จึงหยุดการบันทึกเพื่อป้องกันข้อมูลครึ่งชุด');
    }
  }

  function syncPrescriptionControls() {
    if (accountBlocked) return;
    const form = $('#prescription-form');
    const retryLocked = Boolean(form?.dataset.requestKey);
    ['#encounter', '#rx-encounter'].forEach(selector => {
      const control = $(selector);
      if (control) control.disabled = prescriptionSubmitting || retryLocked;
    });
    $$('#prescription-item-form input, #prescription-item-form select, #prescription-item-form textarea, #prescription-item-form button')
      .forEach(control => { control.disabled = prescriptionSubmitting || retryLocked; });
    $$('#prescription-form select, #prescription-form textarea')
      .forEach(control => { control.disabled = prescriptionSubmitting || retryLocked; });
    const submit = $('#prescription-form button');
    if (submit) submit.disabled = prescriptionSubmitting || !atomicHandoffsReady || prescriptionCart.length === 0;
  }

  function setPrescriptionSubmitting(busy) {
    prescriptionSubmitting = busy;
    syncPrescriptionControls();
  }

  function clearPrescriptionDraft() {
    prescriptionCart = [];
    prescriptionCartEncounterId = null;
    prescriptionCartVersion += 1;
    renderPrescriptionCart();
  }

  function setStep(step) {
    const target = $(`[data-stage="${CSS.escape(step)}"]`);
    if (!target) return;
    $$('.clinical-stage').forEach(stage => stage.classList.toggle('active', stage === target));
    $$('[data-clinical-step]').forEach(button => button.classList.toggle('active', button.dataset.clinicalStep === step));
    const url = new URL(location.href);
    url.searchParams.set('step', step);
    history.replaceState({}, '', url);
    if (matchMedia('(max-width: 900px)').matches) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function markStep(step, ready) {
    document.querySelector(`[data-step-state="${step}"]`)?.classList.toggle('ready', Boolean(ready));
  }

  async function loadReferences(preferredEncounter) {
    if (accountBlocked) return;
    const version = ++referenceLoadVersion;
    const actorSession = session, actorProfile = profile;
    const actorId = session?.user?.id, clinicId = profile?.clinic_id;
    const isCurrent = () => !accountBlocked && version === referenceLoadVersion && session === actorSession && profile === actorProfile
      && session?.user?.id === actorId && profile?.clinic_id === clinicId;
    const [patientResult, productResult, encounterResult] = await Promise.all([
      db.from('patients').select('id,hn,prefix,first_name,last_name').order('created_at', { ascending: false }).limit(500),
      db.from('products').select('*').eq('active', true).order('name_th'),
      db.from('encounters').select('id,encounter_no,patient_id,chief_complaint,thai_diagnosis,started_at,status').order('started_at', { ascending: false }).limit(250)
    ]);
    if (!isCurrent()) return;
    [patientResult, productResult, encounterResult].forEach(result => { if (result.error) throw result.error; });
    const referenceEncounters = [...(encounterResult.data || [])];
    if (preferredEncounter && !referenceEncounters.some(item => item.id === preferredEncounter)) {
      const linkedEncounter = await db.from('encounters').select('id,encounter_no,patient_id,chief_complaint,thai_diagnosis,started_at,status').eq('id', preferredEncounter).maybeSingle();
      if (!isCurrent()) return;
      if (linkedEncounter.error) throw linkedEncounter.error;
      if (!linkedEncounter.data || linkedEncounter.data.id !== preferredEncounter) throw new Error('ไม่พบ Encounter ที่ร้องขอ หรือบัญชีนี้ไม่มีสิทธิ์อ่าน');
      referenceEncounters.unshift(linkedEncounter.data);
    }
    const referencePatients = patientResult.data || [];
    const knownPatientIds = new Set(referencePatients.map(item => item.id));
    const missingPatientIds = [...new Set(referenceEncounters.map(item => item.patient_id).filter(id => id && !knownPatientIds.has(id)))];
    if (missingPatientIds.length) {
      const linkedPatients = await db.from('patients').select('id,hn,prefix,first_name,last_name').in('id', missingPatientIds);
      if (!isCurrent()) return;
      if (linkedPatients.error) throw linkedPatients.error;
      referencePatients.push(...(linkedPatients.data || []));
    }
    patients = referencePatients;
    products = productResult.data || [];
    encounters = referenceEncounters;

    $('#enc-patient').innerHTML = optionRows(patients, item => `${item.hn || '-'} — ${patientName(item.id)}`);
    $('#encounter').innerHTML = '<option value="">เลือก Encounter</option>' + encounters.map(item => `<option value="${item.id}">${esc(item.encounter_no || '-')} — ${esc(patientName(item.patient_id))} — ${esc(item.chief_complaint || '-')}</option>`).join('');
    $('#rx-encounter').innerHTML = optionRows(encounters, item => `${item.encounter_no || '-'} — ${patientName(item.patient_id)}`);
    $('#rx-product').innerHTML = optionRows(products, item => `${item.sku || '-'} — ${item.name_th}`);
    syncPrescriptionUnit();

    if (preferredEncounter && encounters.some(item => item.id === preferredEncounter)) {
      $('#encounter').value = preferredEncounter;
      $('#rx-encounter').value = preferredEncounter;
      await selectEncounter(preferredEncounter);
    }
    if (isCurrent()) window.dispatchEvent(new CustomEvent('chananya:clinical-references-rendered'));
  }

  async function selectEncounter(encounterId) {
    requireClinicalSession();
    const nextEncounter = encounterId || null;
    if (nextEncounter !== currentEncounter && prescriptionSubmitting) {
      $('#encounter').value = currentEncounter || '';
      $('#rx-encounter').value = currentEncounter || '';
      throw new Error('กำลังส่งใบสั่งยา กรุณารอผลก่อนเปลี่ยน Encounter');
    }
    if (nextEncounter !== prescriptionCartEncounterId && prescriptionCart.length) {
      $('#encounter').value = currentEncounter || '';
      $('#rx-encounter').value = currentEncounter || '';
      if ($('#prescription-form')?.dataset.requestKey) {
        throw new Error('ผลส่งใบสั่งยายังไม่แน่นอน กรุณาลองส่งซ้ำ Encounter เดิมก่อนเปลี่ยนผู้รับบริการ');
      }
      if (!confirm('มีรายการยาในใบสั่งยาของ Encounter เดิม การเปลี่ยนผู้รับบริการจะล้างรายการเหล่านี้ ยืนยันหรือไม่?')) return;
      clearPrescriptionDraft();
    }
    currentEncounter = nextEncounter;
    $('#encounter').value = currentEncounter || '';
    $('#rx-encounter').value = currentEncounter || '';
    if (!currentEncounter) {
      $('#encounter-info').textContent = 'เลือก Encounter หรือเปิด Visit ใหม่';
      resetEncounterViews();
      markStep('intake', false);
      window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: null } }));
      return;
    }
    const encounter = encounters.find(item => item.id === currentEncounter);
    $('#encounter-info').textContent = `${encounter?.encounter_no || currentEncounter} • ${patientName(encounter?.patient_id)}`;
    markStep('intake', true);
    await loadEncounter();
    window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: currentEncounter } }));
  }

  function resetEncounterViews() {
    renderExam([]); renderDiagnosis(null); renderPlan(null);
    renderPrescriptionReceipt(null);
    ['history', 'exam', 'diagnosis', 'treatment', 'prescription', 'signoff'].forEach(step => markStep(step, false));
  }

  async function loadEncounter() {
    if (accountBlocked) return;
    const loadVersion = ++encounterLoadVersion;
    const encounterId = currentEncounter;
    renderPrescriptionReceipt(null);
    const queryResults = await Promise.all([
      db.from('clinical_examination_findings').select('*').eq('encounter_id', encounterId).order('sequence_no'),
      db.from('ttm_structured_diagnoses').select('*').eq('encounter_id', encounterId).maybeSingle(),
      db.from('clinical_treatment_plans').select('*').eq('encounter_id', encounterId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('body_pain_points').select('*').eq('encounter_id', encounterId).order('recorded_at', { ascending: false }),
      db.from('ttm_opd_histories').select('id').eq('encounter_id', encounterId).maybeSingle(),
      db.from('clinical_treatment_sessions').select('id').eq('encounter_id', encounterId),
      db.from('prescriptions').select('id,prescription_no,prescribed_at,status,clinical_notes,sent_to_pharmacy_at').eq('encounter_id', encounterId).order('prescribed_at', { ascending: false }),
      db.from('clinical_record_signoffs').select('id,lock_record').eq('encounter_id', encounterId).eq('record_section', 'complete_record').maybeSingle()
    ]);
    if (loadVersion !== encounterLoadVersion || encounterId !== currentEncounter) return;
    const [examResult, diagnosisResult, planResult, painResult, historyResult, sessionResult, prescriptionResult, signoffResult] = queryResults;
    if (prescriptionResult.error) {
      renderPrescriptionReceipt([], [], prescriptionResult.error);
      throw prescriptionResult.error;
    }
    [examResult, diagnosisResult, planResult, painResult, historyResult, sessionResult, prescriptionResult, signoffResult].forEach(result => { if (result.error) throw result.error; });
    const prescriptions = prescriptionResult.data || [];
    let orders = [];
    if (prescriptions.length) {
      const orderResult = await db.from('dispensing_orders').select('id,prescription_id,queue_number,status,created_at').in('prescription_id', prescriptions.map(item => item.id)).order('created_at', { ascending: false });
      if (orderResult.error) {
        if (loadVersion === encounterLoadVersion && encounterId === currentEncounter) {
          renderPrescriptionReceipt([], [], orderResult.error);
        }
        if (loadVersion !== encounterLoadVersion || encounterId !== currentEncounter) return;
        throw orderResult.error;
      }
      orders = orderResult.data || [];
    }
    if (loadVersion !== encounterLoadVersion || encounterId !== currentEncounter) return;
    renderExam(examResult.data || []);
    renderDiagnosis(diagnosisResult.data);
    renderPlan(planResult.data);
    markStep('history', Boolean(historyResult.data));
    markStep('exam', (examResult.data || []).length > 0 || (painResult.data || []).length > 0);
    markStep('diagnosis', Boolean(diagnosisResult.data));
    markStep('treatment', Boolean(planResult.data) || (sessionResult.data || []).length > 0);
    markStep('prescription', prescriptions.length > 0);
    markStep('signoff', Boolean(signoffResult.data?.lock_record));
    renderPrescriptionReceipt(prescriptions, orders);
  }

  function renderExam(rows) {
    $('#exam-list').innerHTML = rows.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.body_region)}</td><td>${esc(row.side)}</td><td>${[row.tenderness ? 'กดเจ็บ' : '', row.swelling ? 'บวม' : '', row.warmth ? 'ร้อน' : '', row.redness ? 'แดง' : '', row.numbness ? 'ชา' : '', row.muscle_tightness ? 'ตึง' : ''].filter(Boolean).join(', ') || '-'}</td><td>${esc(row.range_of_motion || '-')}</td><td>${esc(row.identified_problem || '-')}</td><td><button class="btn ghost" data-delete-exam="${row.id}">ลบ</button></td></tr>`).join('') || '<tr><td colspan="7">ยังไม่มีผลตรวจ</td></tr>';
    $$('[data-delete-exam]').forEach(button => { button.onclick = () => removeRow('clinical_examination_findings', button.dataset.deleteExam).catch(fail); });
  }

  function renderDiagnosis(row) {
    $('#diagnosis-status').innerHTML = row ? `<b>${esc(row.thai_diagnosis)}</b><br>${esc(row.analysis_summary)}<br><small>${esc([row.dhatu_samutthan, row.utu_samutthan, row.ayu_samutthan, row.kala_samutthan, row.pradesa_samutthan].filter(Boolean).join(' • '))}</small>` : 'ยังไม่มีข้อมูล';
  }

  function renderPlan(row) {
    $('#plan-status').innerHTML = row ? `<b>${esc(row.goal_1)}</b><br>ความถี่ ${esc(row.frequency_per_week || '-')} ครั้ง/สัปดาห์ • ${esc(row.planned_sessions || '-')} ครั้ง<br><small>${esc((row.treatment_modalities || []).join(', '))}</small>` : 'ยังไม่มีแผนการรักษา';
  }

  function renderPrescriptionReceipt(prescription, order = null, error = null) {
    const receipt = $('#rx-handoff-receipt');
    if (!receipt) return;
    if (!prescription && !error) {
      receipt.hidden = true;
      receipt.innerHTML = '';
      return;
    }
    receipt.hidden = false;
    if (error) {
      receipt.innerHTML = `<b>โหลดประวัติใบสั่งยา/คิวห้องยาไม่สำเร็จ</b><br><small>${esc(error.message || 'กรุณาลองใหม่และตรวจสอบสิทธิ์ของ Encounter')}</small>`;
      return;
    }
    if (Array.isArray(prescription)) {
      const prescriptions = prescription;
      const orders = Array.isArray(order) ? order : [];
      if (!prescriptions.length) {
        receipt.innerHTML = '<span class="muted">ยังไม่มีใบสั่งยาใน Encounter นี้</span>';
        return;
      }
      const ordersByPrescription = new Map();
      orders.forEach(item => {
        const list = ordersByPrescription.get(item.prescription_id) || [];
        list.push(item);
        ordersByPrescription.set(item.prescription_id, list);
      });
      receipt.innerHTML = prescriptions.flatMap(item => {
        const linkedOrders = ordersByPrescription.get(item.id) || [];
        if (!linkedOrders.length) return [`<article class="handoff-receipt"><b>บันทึกใบสั่งยาแล้ว แต่ไม่พบคิวห้องยา</b><br>เลขที่ใบสั่งยา: <strong>${esc(item.prescription_no || '-')}</strong><br><small>สถานะใบสั่งยา ${esc(item.status || '-')} · หยุดขั้นตอนและให้ผู้ดูแลตรวจสอบ atomic handoff</small></article>`];
        return linkedOrders.map(currentOrder => `<article class="handoff-receipt"><b>ส่งห้องยาแล้ว</b><br>เลขที่ใบสั่งยา: <strong>${esc(item.prescription_no || '-')}</strong> · คิวห้องยา: <strong>${esc(currentOrder.queue_number || '-')}</strong><br><small>สถานะใบสั่งยา ${esc(item.status || '-')} · สถานะคิว ${esc(currentOrder.status || '-')}</small></article>`);
      }).join('<hr>');
      appendClarificationButtons(receipt, orders);
      return;
    }
    if (!order) {
      receipt.innerHTML = `<b>ใบสั่งยาถูกบันทึก แต่ไม่พบคิวห้องยา</b><br>เลขที่ใบสั่งยา: <strong>${esc(prescription.prescription_no || '-')}</strong><br><small>หยุดขั้นตอนและให้ผู้ดูแลตรวจสอบ atomic handoff ก่อนดำเนินการต่อ</small>`;
      return;
    }
    receipt.innerHTML = `<b>ส่งห้องยาแล้ว</b><br>เลขที่ใบสั่งยา: <strong>${esc(prescription.prescription_no || '-')}</strong> · คิวห้องยา: <strong>${esc(order.queue_number || '-')}</strong><br><small>สถานะใบสั่งยา ${esc(prescription.status || '-')} · สถานะคิว ${esc(order.status || '-')}</small>`;
    appendClarificationButtons(receipt, [order]);
  }

  function appendClarificationButtons(receipt, orders) {
    orders.forEach(order => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn';
      button.textContent = `ประวัติคำถามห้องยา ${order.queue_number || ''}`;
      const encounterId=currentEncounter;
      button.onclick = () => window.CnyosClarificationHistory.open({ db, orderId: order.id, actorId: session?.user?.id, mode: 'prescriber', label: `คิวห้องยา ${order.queue_number || ''}`,
        onReplace: selection=>openReplacementDraft({...selection,encounterId}).catch(fail) });
      receipt.append(button);
    });
  }

  async function openReplacementDraft({ticketId,orderId,encounterId}) {
    requireAtomicHandoffs();
    if(prescriptionSubmitting||!prescriptionCart.length||currentEncounter!==encounterId
      ||prescriptionCartEncounterId!==encounterId||$('#rx-encounter').value!==encounterId) {
      throw new Error('กรุณาเตรียมรายการยาทดแทนใน Encounter เดิมก่อน แล้วเปิดประวัติคำถามห้องยาอีกครั้ง');
    }
    if($('#prescription-form').dataset.requestKey)throw new Error('ต้องตรวจผลส่งใบสั่งยาเดิมก่อนออกใบทดแทน');
    const actorId=session?.user?.id;
    const version=prescriptionCartVersion;
    const items=prescriptionCart.map(({product_name,status,...item})=>({...item}));
    const notes=$('#rx-clinical-notes').value.trim()||null;
    const dialog=document.createElement('dialog');dialog.className='card';
    dialog.setAttribute('aria-label','ตรวจรายการใบสั่งยาทดแทน');
    const add=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;dialog.append(el);return el;};
    add('h2','ตรวจรายการใบสั่งยาทดแทน');
    add('p','ใบเดิมจะถูกยกเลิกเมื่อบันทึกสำเร็จ ห้องยาต้องยืนยันและตรวจทานใบใหม่ก่อนจ่ายยา');
    for(const item of prescriptionCart)add('p',`${item.product_name} • ${item.quantity_prescribed} ${item.unit} • ${item.dose||''} • ${item.frequency||''} • ${item.route||''} • ${item.duration||''} • ${item.instructions||''}`);
    add('p',`หมายเหตุ: ${notes||'ไม่มี'}`);
    const label=add('label','เหตุผลการออกใบทดแทน');
    const reason=document.createElement('textarea');reason.maxLength=2000;label.append(reason);
    const message=add('p','ยังไม่ได้ส่งข้อมูล');message.setAttribute('role','status');
    const submit=add('button','ยืนยันออกใบทดแทน');submit.type='button';submit.className='btn';
    const recover=add('button','ตรวจผลคำขอเดิม');recover.type='button';recover.className='btn';recover.hidden=true;
    const revise=add('button','กลับไปแก้รายการที่ถูกปฏิเสธ');revise.type='button';revise.className='btn';revise.hidden=true;
    const close=add('button','ปิด');close.type='button';
    let busy=false,done=false,decision=null,disposed=false;
    const validContext=()=>currentEncounter===encounterId&&prescriptionCartEncounterId===encounterId
      &&prescriptionCartVersion===version&&session?.user?.id===actorId&&$('#rx-encounter').value===encounterId;
    const run=async readOnly=>{
      if(busy||done||disposed)return;
      busy=true;submit.disabled=true;recover.disabled=true;reason.disabled=true;
      try {
        if(!validContext())throw new Error('บริบท Encounter หรือรายการยาเปลี่ยนแล้ว หยุดส่งคำขอ');
        setPrescriptionSubmitting(true);
        if(!decision)decision=await window.CnyosReplacementAction.prepare({db,actorId,ticketId,oldOrderId:orderId,reason:reason.value,notes,items});
        if(!validContext())throw new Error('บริบทเปลี่ยนระหว่างเตรียมคำขอ ตรวจผลก่อนดำเนินการต่อ');
        setPrescriptionSubmitting(true);
        const receipt=await (readOnly?decision.recover():decision.submit());
        done=true;
        if(validContext()) {
          clearPrescriptionDraft();
          if(!disposed)message.textContent=`บันทึกและอ่านกลับแล้ว • คิว ${receipt.new_order_id} • ห้องยายังต้องตรวจทาน`;
          await loadEncounter();
        } else if(!disposed) {
          message.textContent='บริบทเปลี่ยนแล้ว ไม่อัปเดตหน้าปัจจุบัน กรุณาเปิดประวัติคำขอในบัญชีและ Encounter เดิมเพื่อตรวจผล';
        }
      } catch(error) {
        if(!disposed){
          if(decision&&!validContext()) {
            message.textContent='บริบทเปลี่ยนแล้ว ไม่อัปเดตหน้าปัจจุบัน กรุณาเปิดประวัติคำขอในบัญชีและ Encounter เดิมเพื่อตรวจผล';
            revise.hidden=true;recover.hidden=true;
          } else {
            message.textContent=`ยังปิดงานไม่ได้: ${error.message}`;
            revise.hidden=!decision?.canDiscard?.();
            recover.hidden=!decision||!revise.hidden;
          }
        }
      } finally {
        busy=false;setPrescriptionSubmitting(false);
        if(!disposed){submit.disabled=done||!validContext();recover.disabled=done||!validContext();reason.disabled=Boolean(decision)||!validContext();}
      }
    };
    submit.onclick=()=>run(false);recover.onclick=()=>run(true);
    const dispose=()=>{if(busy)return;disposed=true;dialog.remove();};
    revise.onclick=()=>{
      if(busy||disposed||!decision?.canDiscard?.())return;
      if(!validContext()) {
        message.textContent='บริบทเปลี่ยนแล้ว ห้ามล้างคำขอเดิม กรุณากลับไปตรวจในบัญชีและ Encounter เดิม';
        return;
      }
      try {decision.discard();dispose();}
      catch {message.textContent='ยังล้างคำขอที่ถูกปฏิเสธไม่ได้ หยุดสร้างรายการใหม่และตรวจผลเดิม';}
    };
    close.onclick=dispose;dialog.addEventListener('cancel',event=>{event.preventDefault();dispose();});
    document.body.append(dialog);dialog.showModal();reason.focus();
  }

  async function removeRow(table, id) {
    requireClinicalSession();
    if (!confirm('ยืนยันลบรายการนี้?')) return;
    const result = await db.from(table).delete().eq('id', id);
    if (result.error) throw result.error;
    await loadEncounter();
    toast('ลบแล้ว');
  }

  function bloodPressure() {
    const [systolic, diastolic] = ($('#enc-bp').value || '').split('/').map(Number);
    return { systolic_bp: systolic || null, diastolic_bp: diastolic || null };
  }

  function syncVerificationNoteRequirement() {
    const guardian = $('#enc-verification-method').value === 'guardian_attestation';
    $('#enc-verification-note').required = guardian;
  }

  async function saveEncounter(event) {
    requireClinicalSession();
    event.preventDefault();
    if (!hybridIdentityReady) {
      throw new Error('ฐานข้อมูลยังไม่เปิดใช้ Hybrid Patient Identity จึงหยุดการเปิด Encounter เพื่อป้องกันข้อมูลคัดกรองครึ่งชุด');
    }
    if (!$('#enc-identity-confirmed').checked) throw new Error('กรุณาตรวจสอบตัวตนกับผู้รับบริการก่อนเปิด Encounter');
    const bp = bloodPressure();
    const intake = {
      chief_complaint: $('#enc-chief').value,
      present_illness: $('#enc-history').value || null,
      past_history: $('#enc-past').value || null,
      current_medications: $('#enc-meds').value || null,
      red_flags: $('#enc-redflags').value || null,
      general_examination: $('#enc-exam').value || null,
      temperature: num($('#enc-temp').value),
      pulse: num($('#enc-pulse').value),
      respiration: num($('#enc-rr').value),
      spo2: num($('#enc-spo2').value),
      systolic_bp: bp.systolic_bp,
      diastolic_bp: bp.diastolic_bp,
      pain_before: num($('#enc-before').value)
    };
    const result = await db.rpc('start_manual_patient_encounter', {
      p_patient_id: $('#enc-patient').value,
      p_verification_method: $('#enc-verification-method').value,
      p_patient_present_confirmed: true,
      p_verification_note: $('#enc-verification-note').value.trim() || null,
      p_chief_complaint: $('#enc-chief').value,
      p_intake: intake
    });
    if (result.error) throw result.error;
    const encounter = Array.isArray(result.data) ? result.data[0] : result.data;
    const encounterId = encounter?.encounter_id;
    if (!encounterId) throw new Error('ไม่สามารถเปิด Encounter ได้');
    event.target.reset();
    syncVerificationNoteRequirement();
    await loadReferences(encounterId);
    setStep('history');
    toast('เปิด Encounter แล้ว');
  }

  async function saveExam(event) {
    requireClinicalSession();
    event.preventDefault();
    if (!currentEncounter) throw new Error('กรุณาเลือก Encounter');
    const countResult = await db.from('clinical_examination_findings').select('id', { count: 'exact', head: true }).eq('encounter_id', currentEncounter);
    requireClinicalSession();
    if (countResult.error) throw countResult.error;
    const result = await db.from('clinical_examination_findings').insert({
      encounter_id: currentEncounter, sequence_no: (countResult.count || 0) + 1,
      body_region: $('#exam-region').value, side: $('#exam-side').value,
      tenderness: $('#exam-tenderness').checked, swelling: $('#exam-swelling').checked,
      warmth: $('#exam-warmth').checked, redness: $('#exam-redness').checked,
      numbness: $('#exam-numbness').checked, muscle_tightness: $('#exam-tightness').checked,
      range_of_motion: $('#exam-rom').value, severity: num($('#exam-severity').value),
      movement_notes: $('#exam-movement').value || null, abnormal_finding: $('#exam-abnormal').value || null,
      identified_problem: $('#exam-problem').value, created_by: session.user.id
    });
    if (result.error) throw result.error;
    event.target.reset();
    await loadEncounter();
    toast('เพิ่มผลตรวจแล้ว');
  }

  async function savePlan(event) {
    requireClinicalSession();
    event.preventDefault();
    if (!currentEncounter) throw new Error('กรุณาเลือก Encounter');
    const result = await db.from('clinical_treatment_plans').insert({
      encounter_id: currentEncounter, plan_number: `TP-${Date.now()}`,
      goal_1: $('#plan-goal1').value, goal_2: $('#plan-goal2').value || null, goal_3: $('#plan-goal3').value || null,
      frequency_per_week: num($('#plan-frequency').value), planned_duration_weeks: num($('#plan-weeks').value),
      planned_sessions: num($('#plan-sessions').value), treatment_modalities: csv($('#plan-modalities').value),
      target_areas: csv($('#plan-areas').value), precautions: $('#plan-precautions').value || null,
      herbal_plan: $('#plan-herbal').value || null, home_program: $('#plan-home').value || null,
      planned_by: session.user.id, status: 'active'
    });
    if (result.error) throw result.error;
    await loadEncounter();
    toast('บันทึก Treatment Plan แล้ว');
  }

  function renderPrescriptionCart() {
    $('#rx-cart').innerHTML = prescriptionCart.map((item, index) => `<article class="item"><div><b>${esc(item.product_name)}</b><small>${item.quantity_prescribed} ${esc(item.unit)} • ${esc(item.dose || '-')} • ${esc(item.frequency || '-')} • ${esc(item.duration || '-')}</small></div><button class="btn ghost" data-remove-rx="${index}">ลบ</button></article>`).join('') || '<p class="muted">ยังไม่มีรายการยา</p>';
    $$('[data-remove-rx]').forEach(button => { button.onclick = () => {
      if ($('#prescription-form')?.dataset.requestKey) {
        fail(new Error('ผลส่งยังไม่แน่นอน กรุณาลองส่งซ้ำรายการเดิมก่อนแก้ไขใบสั่งยา'));
        return;
      }
      prescriptionCart.splice(Number(button.dataset.removeRx), 1);
      prescriptionCartVersion += 1;
      if (!prescriptionCart.length) prescriptionCartEncounterId = null;
      renderPrescriptionCart();
    }; });
    syncPrescriptionControls();
  }

  function addPrescriptionItem(event) {
    requireClinicalSession();
    event.preventDefault();
    const encounterId = $('#rx-encounter').value;
    if (!encounterId || encounterId !== currentEncounter) throw new Error('กรุณาเลือก Encounter ที่กำลังเปิดก่อนเพิ่มรายการยา');
    if (prescriptionCartEncounterId && prescriptionCartEncounterId !== encounterId) {
      throw new Error('รายการยาเป็นของ Encounter อื่น กรุณาเปลี่ยนกลับหรือล้างรายการก่อน');
    }
    const product = products.find(item => item.id === $('#rx-product').value);
    if (!product) throw new Error('กรุณาเลือกยา/ผลิตภัณฑ์');
    prescriptionCartEncounterId = encounterId;
    prescriptionCart.push({
      product_id: product.id, product_name: product.name_th,
      quantity_prescribed: Number($('#rx-qty').value), unit: product.dispense_unit,
      dose: $('#rx-dose').value || null, frequency: $('#rx-frequency').value || null,
      duration: $('#rx-duration').value || null, route: $('#rx-route').value || null,
      instructions: $('#rx-instructions').value || null, status: 'ordered'
    });
    prescriptionCartVersion += 1;
    event.target.reset();
    $('#rx-route').value = 'oral';
    syncPrescriptionUnit();
    renderPrescriptionCart();
    setStep('prescription');
    $('#rx-cart')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#prescription-form button')?.focus({ preventScroll: true });
  }

  async function sendPrescription(event) {
    requireClinicalSession();
    event.preventDefault();
    requireAtomicHandoffs();
    if(window.CnyosReplacementAction?.hasPending({actorId:session?.user?.id})) {
      throw new Error('มีคำขอใบทดแทนที่ยังยืนยันผลไม่ได้ในแท็บนี้ กรุณาเปิดประวัติคำถามห้องยาและตรวจผลเดิมก่อนออกใบใหม่');
    }
    const encounterId = $('#rx-encounter').value;
    const encounter = encounters.find(item => item.id === encounterId);
    if (!encounter) throw new Error('กรุณาเลือก Encounter');
    if (!prescriptionCart.length) throw new Error('กรุณาเพิ่มรายการยาอย่างน้อย 1 รายการ');
    if (encounterId !== currentEncounter || prescriptionCartEncounterId !== encounterId) {
      throw new Error('รายการยาไม่ตรงกับ Encounter ที่กำลังเปิด ระบบหยุดส่งเพื่อป้องกันการสั่งยาให้ผู้รับบริการผิดคน');
    }
    const operationVersion = prescriptionCartVersion;
    const itemSnapshot = prescriptionCart.map(({ product_name, status, ...item }) => ({ ...item }));
    const requestKey = event.currentTarget.dataset.requestKey || crypto.randomUUID();
    event.currentTarget.dataset.requestKey = requestKey;
    let verifiedReadback = null;
    try {
      setPrescriptionSubmitting(true);
      try {
        const result = await db.rpc('create_atomic_prescription_handoff', {
          p_request_key: requestKey,
          p_encounter_id: encounter.id,
          p_clinical_notes: $('#rx-clinical-notes').value.trim() || null,
          p_items: itemSnapshot
        });
        requireClinicalSession();
        if (result.error) throw result.error;
        const receipt = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!receipt?.prescription_no || !receipt?.queue_number) throw new Error('ระบบส่งใบสั่งยาแล้วแต่ไม่พบเลขที่ใบสั่งยา/เลขคิว จึงหยุดการยืนยันผล');
        const [prescriptionResult, orderResult] = await Promise.all([
          db.from('prescriptions').select('id,prescription_no,status').eq('id', receipt.prescription_id).maybeSingle(),
          db.from('dispensing_orders').select('id,queue_number,status').eq('id', receipt.dispensing_order_id).maybeSingle()
        ]);
        requireClinicalSession();
        if (prescriptionResult.error) throw prescriptionResult.error;
        if (orderResult.error) throw orderResult.error;
        if (!prescriptionResult.data || !orderResult.data
          || prescriptionResult.data.prescription_no !== receipt.prescription_no
          || orderResult.data.queue_number !== receipt.queue_number) {
          throw new Error('เลขที่ใบสั่งยาหรือเลขคิวอ่านกลับไม่ตรงกับผลส่ง');
        }
        if (prescriptionCartVersion !== operationVersion
          || prescriptionCartEncounterId !== encounterId
          || currentEncounter !== encounterId) {
          throw new Error('ส่งใบสั่งยาแล้ว แต่หน้าจอเปลี่ยนระหว่างทำรายการ จึงไม่ล้าง draft กรุณาโหลด Encounter เดิมเพื่อตรวจเลขคิว');
        }
        verifiedReadback = { prescription: prescriptionResult.data, order: orderResult.data };
      } catch (error) {
        if (String(error.message).includes('PRESCRIPTION_ENCOUNTER_ALREADY_BILLED')) {
          throw new Error('Encounter นี้ออกบิลแล้ว ไม่สามารถเพิ่มใบสั่งยาใหม่ได้ กรุณาประสานฝ่ายการเงินก่อนแก้รายการ หรือเปิด Encounter ใหม่สำหรับบริการครั้งใหม่ รายการที่กรอกยังอยู่');
        }
        throw new Error(`ยังปิดงานส่งใบสั่งยาไม่ได้ ระบบเก็บรายการเดิมและ request key ไว้ให้ลองซ้ำอย่างปลอดภัย (${error.message})`);
      }
      delete event.currentTarget.dataset.requestKey;
      clearPrescriptionDraft();
      event.target.reset();
      $('#rx-encounter').value = currentEncounter || '';
      renderPrescriptionReceipt(verifiedReadback.prescription, verifiedReadback.order);
      try {
        await loadEncounter();
      } catch (refreshError) {
        console.error(refreshError);
        if (currentEncounter === encounterId) {
          renderPrescriptionReceipt(verifiedReadback.prescription, verifiedReadback.order);
        }
        toast(`ส่งใบสั่งยาสำเร็จ • คิว ${verifiedReadback.order.queue_number} • รีเฟรชข้อมูลล่าสุดไม่สำเร็จ`);
        return;
      }
      // A successful refresh renders the complete encounter history. Do not
      // replace it with the single latest receipt that was returned by the RPC.
      toast(`ส่งใบสั่งยาไป Pharmacy แล้ว • คิว ${verifiedReadback.order.queue_number}`);
    } finally {
      setPrescriptionSubmitting(false);
    }
  }

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      session = await runtime.getSession();
      if (!session) { location.replace('/login.html'); return; }
      watchClinicalSession();
      profile = await runtime.getProfile(session.user.id);
      if (accountBlocked) return;
      if (!profile) throw new Error('ไม่พบ Profile');
      if (!runtime.can(profile, 'clinical_write')) throw new Error('บัญชีนี้ไม่มีสิทธิ์บันทึกเวชระเบียน');
      window.ChananyaShell?.mount({ profile, session, active: 'clinical' });
      const identityHealth = await db.rpc('hybrid_patient_identity_healthcheck');
      hybridIdentityReady = !identityHealth.error && Boolean((Array.isArray(identityHealth.data) ? identityHealth.data[0] : identityHealth.data)?.ready);
      const handoffHealth = await db.rpc('clinical_financial_handoffs_healthcheck');
      atomicHandoffsReady = !handoffHealth.error && Boolean((Array.isArray(handoffHealth.data) ? handoffHealth.data[0] : handoffHealth.data)?.ready);
      $('#encounter-form button').disabled = !hybridIdentityReady;
      $('#prescription-form button').disabled = !atomicHandoffsReady;
      const requested = new URL(location.href).searchParams.get('encounter');
      await loadReferences(requested);
      if (accountBlocked) return;
      renderPrescriptionCart();
      const requestedStep = new URL(location.href).searchParams.get('step');
      if (requestedStep) setStep(requestedStep);
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $$('[data-clinical-step]').forEach(button => button.addEventListener('click', () => setStep(button.dataset.clinicalStep)));
  $$('[data-go-treatment]').forEach(button => button.addEventListener('click', () => setStep('treatment')));
  $$('[data-go-prescription]').forEach(button => button.addEventListener('click', () => setStep('prescription')));
  $('#encounter').addEventListener('change', event => selectEncounter(event.target.value).catch(fail));
  $('#rx-encounter').addEventListener('change', event => selectEncounter(event.target.value).catch(fail));
  $('#rx-product').addEventListener('change', syncPrescriptionUnit);
  $('#enc-verification-method').addEventListener('change', syncVerificationNoteRequirement);
  $('#encounter-form').addEventListener('submit', event => saveEncounter(event).catch(fail));
  $('#exam-form').addEventListener('submit', event => saveExam(event).catch(fail));
  $('#plan-form').addEventListener('submit', event => savePlan(event).catch(fail));
  $('#prescription-item-form').addEventListener('submit', event => { try { addPrescriptionItem(event); } catch (error) { fail(error); } });
  $('#prescription-form').addEventListener('submit', event => sendPrescription(event).catch(fail));
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  window.addEventListener('chananya:diagnosis-saved', () => { if (currentEncounter) loadEncounter().catch(fail); });
  window.addEventListener('chananya:clinical-data-changed', event => {
    if (currentEncounter && (!event.detail?.encounterId || event.detail.encounterId === currentEncounter)) loadEncounter().catch(fail);
  });
  window.addEventListener('chananya:signoff-changed', event => { markStep('signoff', Boolean(event.detail?.locked)); });
  // Never restore a previously authorized clinical workspace from browser history.
  window.addEventListener('pagehide', event => {
    if (event.persisted) blockClinicalAccess();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      blockClinicalAccess();
      location.reload();
    }
  });
  renderPrescriptionCart();
  init();
})();
