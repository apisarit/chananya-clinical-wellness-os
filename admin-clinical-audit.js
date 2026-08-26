(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  let db = null;

  const fail = error => {
    console.error(error);
    alert(error?.message || String(error));
  };

  async function resolveEncounter(query) {
    if (!query) throw new Error('กรุณาระบุ Encounter');
    if (/^[0-9a-f-]{36}$/i.test(query)) return query;
    const result = await db.from('encounters').select('id,encounter_no').eq('encounter_no', query).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('ไม่พบ Encounter');
    return result.data.id;
  }

  async function search(query) {
    const encounterId = await resolveEncounter(query);
    $('#amend-encounter').value = encounterId;
    const [signoffResult, auditResult, encounterResult] = await Promise.all([
      db.from('clinical_record_signoffs').select('*').eq('encounter_id', encounterId).order('signed_at', { ascending: false }),
      db.from('clinical_record_audit_events').select('*').eq('encounter_id', encounterId).order('created_at', { ascending: false }),
      db.from('encounters').select('encounter_no,chief_complaint,started_at').eq('id', encounterId).maybeSingle()
    ]);
    [signoffResult, auditResult, encounterResult].forEach(result => { if (result.error) throw result.error; });
    const signoff = (signoffResult.data || []).find(item => item.record_section === 'complete_record');
    $('#audit-signoff').innerHTML = `<b>${esc(encounterResult.data?.encounter_no || encounterId)}</b><br>${signoff ? (signoff.lock_record ? 'SIGNED & LOCKED' : 'SIGNED • UNLOCKED') : 'ยังไม่มี Complete Sign-off'}${signoff ? `<br><small>${esc(signoff.signer_name || '-')} • ${new Date(signoff.signed_at).toLocaleString('th-TH')}</small>` : ''}`;
    $('#clinical-audit-list').innerHTML = (auditResult.data || []).map(item => `<article class="item"><div><b>${esc(item.event_type)} • ${esc(item.record_section || '-')}</b><small>${new Date(item.created_at).toLocaleString('th-TH')} • ${esc(item.reason || '')}</small></div></article>`).join('') || '<p class="muted">ยังไม่มี Audit Event</p>';
  }

  async function unlock() {
    const encounterId = $('#amend-encounter').value.trim();
    const reason = $('#amend-reason').value.trim();
    if (!encounterId || reason.length < 5) throw new Error('กรุณาค้นหา Encounter และระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
    if (!confirm('ยืนยัน Unlock เวชระเบียนเพื่อ Amendment? การกระทำนี้จะถูกบันทึก Audit')) return;
    const result = await db.rpc('unlock_clinical_record_for_amendment', { p_encounter_id: encounterId, p_reason: reason });
    if (result.error) throw result.error;
    $('#amend-reason').value = '';
    await search(encounterId);
    alert('Unlock for Amendment สำเร็จ');
  }

  async function init() {
    const runtime = window.ChananyaRuntime;
    if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
    db = runtime.getDb();
    const session = await runtime.getSession();
    if (!session) return;
    const profile = await runtime.getProfile(session.user.id);
    if (!runtime.can(profile, 'admin_center')) return;
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
  }

  init().catch(error => console.error('Admin clinical audit failed', error));
})();
