(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  let db = null;
  let searchVersion = 0;
  let verifiedEncounter = null;
  let verifiedSignoff = null;
  let recoveryContext = null;
  let accountBlocked = false;
  let unlockPending = false;
  function requireAccount() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนหรือหมดอายุ กรุณาเปิดหน้าใหม่');
  }
  function watchAccount(actor) {
    db.auth.onAuthStateChange((event, next) => {
      if (event !== 'SIGNED_OUT' && next?.user?.id === actor) return;
      accountBlocked = true;
      searchVersion++;
      verifiedEncounter = null;
      verifiedSignoff = null;
      for (const selector of ['#amend-encounter', '#amend-reason', '#audit-query']) $(selector).value = '';
      $('#clinical-audit-list').textContent = '';
      $('#audit-signoff').textContent = 'บัญชีเปลี่ยนหรือหมดอายุ กรุณาเปิดหน้าใหม่';
      $('#audit-search-form').inert = true;
      $('#amend-form').inert = true;
      $('#amend-recover').disabled = true;
      $('#amend-recovery-status').textContent = '';
    });
  }

  const fail = error => {
    if (accountBlocked) return;
    const messages = {
      AMENDMENT_RECEIPT_PENDING: 'ยังไม่พบผลคำขอเดิม ห้ามสร้างคำขอใหม่ หากต้องส่งซ้ำให้ใช้ Encounter และเหตุผลเดิม',
      AMENDMENT_OUTCOME_UNRESOLVED: 'มีคำขอค้างอยู่ กรุณาตรวจผลก่อน หรือกรอกเหตุผลเดิมเพื่อส่งคำขอเดิมซ้ำ',
      AMENDMENT_SIGNATURE_STALE: 'ลายเซ็นเปลี่ยนแล้ว คำขอนี้ไม่ได้ปลดล็อก กรุณาค้นหาเวชระเบียนใหม่',
      AMENDMENT_ALREADY_UNLOCKED: 'เวชระเบียนถูกปลดล็อกแล้ว คำขอนี้ไม่ได้ทำรายการเพิ่ม กรุณาค้นหาใหม่',
      AMENDMENT_RECEIPT_MISMATCH: 'ผลคำขอไม่ตรงกับรายการที่ส่ง ยังยืนยันไม่ได้ กรุณาติดต่อผู้ดูแล',
      AMENDMENT_JOURNAL_INVALID: 'ข้อมูลกู้คำขอในเบราว์เซอร์ไม่สมบูรณ์ กรุณาติดต่อผู้ดูแลก่อนทำรายการ',
      AMENDMENT_JOURNAL_UNAVAILABLE: 'บันทึกรหัสกู้คำขอไม่ได้ ยังไม่ส่งคำขอ กรุณาตรวจการตั้งค่าเบราว์เซอร์',
      AMENDMENT_GENERATION_INVALID: 'ยังอ่านรุ่นลายเซ็นไม่ได้ กรุณาตรวจว่าระบบฐานข้อมูลอัปเดตครบแล้ว',
      PERMISSION_DENIED: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการ กรุณาตรวจสิทธิ์กับผู้ดูแล',
      CNYOS_SUBSCRIPTION_SUSPENDED: 'คลินิกหรือสิทธิ์เข้าใช้ถูกระงับ ไม่สามารถทำรายการได้'
    };
    const code = error?.message;
    const text = messages[code] || (/^[\u0E00-\u0E7F]/.test(code || '') ? code : 'ยังยืนยันผลไม่ได้ กรุณาตรวจผลคำขอเดิมก่อนส่งอีกครั้ง');
    $('#amend-recovery-status').textContent = text;
    alert(text);
  };

  function journal() {
    if (!window.CnyosAmendmentJournal || !recoveryContext) throw new Error('AMENDMENT_CONTEXT_INVALID');
    return window.CnyosAmendmentJournal;
  }
  function renderRecovery() {
    if (accountBlocked) return;
    const marker = journal().restore(recoveryContext);
    $('#amend-recover').disabled = !marker || unlockPending;
    $('#amend-submit').textContent = marker ? 'ส่งคำขอเดิมซ้ำ (ใช้เหตุผลเดิม)' : 'Unlock for Amendment';
    $('#amend-recovery-status').textContent = marker
      ? `มีคำขอรอตรวจผล ${marker.requestId} • Encounter ${marker.encounterId} — ตรวจผลได้โดยไม่ปลดล็อกซ้ำ`
      : 'ไม่มีคำขอค้างในแท็บนี้';
  }

  async function resolveEncounter(query) {
    if (!query) throw new Error('กรุณาระบุ Encounter');
    if (/^[0-9a-f-]{36}$/i.test(query)) return query;
    const result = await db.from('encounters').select('id,encounter_no').eq('encounter_no', query).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('ไม่พบ Encounter');
    return result.data.id;
  }

  async function search(query) {
    requireAccount();
    const version = ++searchVersion;
    verifiedEncounter = null;
    verifiedSignoff = null;
    $('#amend-encounter').value = '';
    $('#audit-signoff').textContent = 'กำลังโหลดประวัติเวชระเบียน…';
    $('#clinical-audit-list').textContent = '';
    try {
    const encounterId = await resolveEncounter(query);
    if (version !== searchVersion) return;
    const [signoffResult, auditResult, encounterResult] = await Promise.all([
      db.from('clinical_record_signoffs').select('*').eq('encounter_id', encounterId).order('signed_at', { ascending: false }),
      db.from('clinical_record_audit_events').select('*').eq('encounter_id', encounterId).order('created_at', { ascending: false }),
      db.from('encounters').select('encounter_no,chief_complaint,started_at').eq('id', encounterId).maybeSingle()
    ]);
    if (version !== searchVersion) return;
    [signoffResult, auditResult, encounterResult].forEach(result => { if (result.error) throw result.error; });
    if (!encounterResult.data) throw new Error('ไม่พบ Encounter ในขอบเขตสิทธิ์นี้');
    verifiedEncounter = encounterId;
    $('#amend-encounter').value = encounterId;
    const signoff = (signoffResult.data || []).find(item => item.record_section === 'complete_record');
    verifiedSignoff = signoff || null;
    $('#audit-signoff').innerHTML = `<b>${esc(encounterResult.data?.encounter_no || encounterId)}</b><br>${signoff ? (signoff.lock_record ? 'SIGNED & LOCKED' : 'SIGNED • UNLOCKED') : 'ยังไม่มี Complete Sign-off'}${signoff ? `<br><small>${esc(signoff.signer_name || '-')} • ${new Date(signoff.signed_at).toLocaleString('th-TH')}</small>` : ''}`;
    $('#clinical-audit-list').innerHTML = (auditResult.data || []).map(item => `<article class="item"><div><b>${esc(item.event_type)} • ${esc(item.record_section || '-')}</b><small>${new Date(item.created_at).toLocaleString('th-TH')} • ${esc(item.reason || '')}</small></div></article>`).join('') || '<p class="muted">ยังไม่มี Audit Event</p>';
    renderRecovery();
    } catch (error) {
      if (version !== searchVersion) return;
      verifiedEncounter = null;
      verifiedSignoff = null;
      $('#amend-encounter').value = '';
      $('#audit-signoff').textContent = 'โหลดประวัติไม่สำเร็จ กรุณาค้นหาใหม่ก่อนปลดล็อก';
      $('#clinical-audit-list').textContent = '';
      throw error;
    }
  }

  async function unlock() {
    requireAccount();
    if (unlockPending) return;
    const encounterId = $('#amend-encounter').value.trim();
    const reason = $('#amend-reason').value.trim();
    if (!verifiedEncounter || encounterId !== verifiedEncounter) throw new Error('กรุณาค้นหาและโหลดประวัติ Encounter ให้สำเร็จก่อนปลดล็อก');
    if (!encounterId || reason.length < 5 || reason.length > 2000) throw new Error('กรุณาระบุเหตุผล 5–2000 ตัวอักษร');
    const saved = journal().restore(recoveryContext);
    if (saved && saved.encounterId !== encounterId) throw new Error('AMENDMENT_OUTCOME_UNRESOLVED');
    if (!saved && !verifiedSignoff?.lock_record) throw new Error('กรุณาค้นหาเวชระเบียนที่ลงนามและล็อกแล้ว');
    const signoffId = saved?.signoffId || verifiedSignoff.id;
    const generation = saved?.generation || journal().generation(verifiedSignoff.signature_generation);
    if (!confirm(saved ? 'ส่งคำขอเดิมซ้ำโดยใช้เหตุผลเดิม? จะไม่สร้างคำขอใหม่' : 'ยืนยัน Unlock เวชระเบียนรุ่นที่แสดงเพื่อ Amendment? การกระทำนี้จะถูกบันทึก Audit')) return;
    requireAccount();
    const version = searchVersion;
    unlockPending = true;
    $('#amend-form').inert = true;
    $('#amend-recover').disabled = true;
    try {
    const marker = await journal().prepare({...recoveryContext,encounterId,signoffId,generation,reason,
      expectedRequestId:saved?.requestId ?? null,isCurrent:()=>recoveryContext.isCurrent() && version===searchVersion});
    requireAccount();
    if (version !== searchVersion) return;
    const result = await db.rpc('unlock_clinical_record_for_amendment_v2', {
      p_request_id:marker.requestId,p_encounter_id:encounterId,p_signoff_id:signoffId,
      p_signature_generation:generation,p_reason:reason
    });
    if (accountBlocked) return;
    if (result.error) {
      if (result.error.code === 'P0001' && ['AMENDMENT_SIGNATURE_STALE','AMENDMENT_ALREADY_UNLOCKED'].includes(result.error.message)) {
        journal().reject(recoveryContext,marker,result.error.message);
        if (version === searchVersion) verifiedSignoff = null;
      }
      throw result.error;
    }
    journal().confirm(recoveryContext,marker,result.data);
    if (version !== searchVersion) {
      alert('ยืนยันผลคำขอเดิมแล้ว โปรดค้นหา Encounter นั้นเพื่อตรวจสถานะล่าสุด — ไม่เปลี่ยนรายการที่กำลังดู');
      return;
    }
    $('#amend-reason').value = '';
    await search(encounterId);
    if (accountBlocked || searchVersion !== version + 1) return;
    alert('ยืนยันผลคำขอปลดล็อกแล้ว สถานะลายเซ็นปัจจุบันแสดงในประวัติ');
    } finally {
      unlockPending = false;
      if (!accountBlocked) $('#amend-form').inert = false;
      if (!accountBlocked) renderRecovery();
    }
  }

  async function recover() {
    requireAccount();
    if (unlockPending) return;
    const version = searchVersion;
    unlockPending = true;
    $('#amend-form').inert = true;
    $('#amend-recover').disabled = true;
    try {
      const receipt = await journal().recover({...recoveryContext,readReceipt:async requestId=>{
        const result = await db.rpc('read_clinical_amendment_receipt',{p_request_id:requestId});
        if (result.error) throw result.error;
        return result.data;
      }});
      if (accountBlocked) return;
      if (version === searchVersion && verifiedEncounter === receipt.encounter_id) {
        $('#amend-reason').value = '';
        await search(receipt.encounter_id);
      }
      if (!accountBlocked) alert('ตรวจพบว่าคำขอเดิมสำเร็จแล้ว ไม่มีการปลดล็อกซ้ำ กรุณาดูสถานะลายเซ็นล่าสุดในประวัติ');
    } finally {
      unlockPending = false;
      if (!accountBlocked) {$('#amend-form').inert = false;renderRecovery();}
    }
  }

  async function init() {
    const runtime = window.ChananyaRuntime;
    if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
    db = runtime.getDb();
    const session = await runtime.getSession();
    if (!session) return;
    watchAccount(session.user.id);
    if (accountBlocked) return;
    const profile = await runtime.getProfile(session.user.id);
    if (accountBlocked) return;
    if (!runtime.can(profile, 'admin_center')) return;
    recoveryContext = {actorId:session.user.id,clinicId:profile.clinic_id,isCurrent:()=>!accountBlocked};
    const searchForm = $('#audit-search-form');
    const amendForm = $('#amend-form');
    if (!searchForm || !amendForm) throw new Error('Admin Clinical Audit markup ไม่ครบ');
    searchForm.addEventListener('submit', event => {
      event.preventDefault();
      search($('#audit-query').value.trim()).catch(fail);
    });
    amendForm.addEventListener('submit', event => {
      event.preventDefault();
      unlock().catch(fail);
    });
    $('#amend-recover').addEventListener('click',()=>recover().catch(fail));
    renderRecovery();
  }

  init().catch(error => console.error('Admin clinical audit failed', error));
})();
