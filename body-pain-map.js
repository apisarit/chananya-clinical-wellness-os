(() => {
  'use strict';

  const runtime = window.ChananyaRuntime;
  if (!runtime) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const viewNames = { front: 'ด้านหน้า', back: 'ด้านหลัง', left: 'ด้านซ้าย', right: 'ด้านขวา' };
  const stageNames = { before: 'ก่อนรักษา', after: 'หลังรักษา', followup: 'ติดตามผล' };
  const typeNames = { pain: 'ปวด', numbness: 'ชา', tightness: 'ตึง', burning: 'แสบร้อน', swelling: 'บวม', weakness: 'อ่อนแรง', other: 'อื่น ๆ' };

  let db;
  let session;
  let currentEncounter = null;
  let points = [];
  let draft = null;
  let editingId = null;
  let encounterRevision = 0;
  let loadRevision = 0;
  let accountBlocked = false;
  let mutationPending = false;
  const pointFields = ['encounter_id','assessment_stage','body_view','x_percent','y_percent','symptom_type','pain_score','side','body_region','sen_line_code','point_label','notes','pain_pattern_code'];
  const insertKey = target => `cnyos:bodypoint-insert:${session.user.id}:${target}`;

  function requireCurrent(target, revision) {
    if (!isCurrent(target, revision)) throw new Error('บริบทบัญชีหรือ Encounter เปลี่ยนแล้ว กรุณาเปิดรายการใหม่');
  }

  async function pointDigest(row) {
    const values = pointFields.map(field => {
      const value = row[field] ?? null;
      return value !== null && ['x_percent','y_percent','pain_score'].includes(field) ? Number(value) : value;
    });
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values))))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function insertMarker(target) {
    const raw = window.sessionStorage.getItem(insertKey(target));
    if (raw === null) return null;
    let marker;
    try { marker = JSON.parse(raw); } catch { throw new Error('รหัสคำขอเดิมเสียหาย กรุณาติดต่อผู้ดูแลก่อนบันทึกซ้ำ'); }
    if (!marker || Object.keys(marker).sort().join() !== 'digest,id,phase,version' || marker.version !== 2
      || !['prepared','sent'].includes(marker.phase)
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(marker.id) || !/^[a-f0-9]{64}$/.test(marker.digest)) {
      throw new Error('รหัสคำขอเดิมเสียหาย กรุณาติดต่อผู้ดูแลก่อนบันทึกซ้ำ');
    }
    return marker;
  }

  function clearInsertMarker(target, marker) {
    const key = insertKey(target);
    if (window.sessionStorage.getItem(key) !== JSON.stringify(marker)) throw new Error('รหัสคำขอเปลี่ยน กรุณาตรวจผลใหม่');
    window.sessionStorage.removeItem(key);
    if (window.sessionStorage.getItem(key) !== null) throw new Error('ล้างสถานะคำขอไม่ได้ กรุณาตรวจผลใหม่');
  }

  async function readPendingPoint(target, revision, marker) {
    requireCurrent(target, revision);
    const result = await db.from('body_pain_points').select(['id','recorded_by',...pointFields].join(','))
      .eq('id', marker.id).eq('encounter_id', target).maybeSingle();
    requireCurrent(target, revision);
    if (result.error) throw new Error('ยังอ่านผลบันทึกเดิมไม่ได้ กรุณาตรวจผลอีกครั้งก่อนบันทึกซ้ำ');
    if (!result.data) return null;
    const row = result.data;
    if (row.id !== marker.id || row.encounter_id !== target || row.recorded_by !== session.user.id
      || !pointFields.every(field => Object.hasOwn(row, field))
      || await pointDigest(row) !== marker.digest) throw new Error('ข้อมูลที่อ่านกลับไม่ตรงคำขอเดิม กรุณาให้ผู้ดูแลตรวจสอบ');
    requireCurrent(target, revision);
    return row;
  }

  async function insertPoint(payload, target, revision) {
    requireCurrent(target, revision);
    const hash = await pointDigest(payload);
    requireCurrent(target, revision);
    let marker = insertMarker(target);
    if (marker && marker.digest !== hash) throw new Error('คำขอเดิมยังไม่ยืนยันผล กรุณาตรวจผลบันทึกที่ค้างก่อนเปลี่ยนข้อมูล');
    if (!marker) {
      marker = { version: 2, id: crypto.randomUUID(), digest: hash, phase: 'prepared' };
      window.sessionStorage.setItem(insertKey(target), JSON.stringify(marker));
      if (window.sessionStorage.getItem(insertKey(target)) !== JSON.stringify(marker)) throw new Error('เก็บรหัสคำขอไม่ได้ จึงยังไม่ส่งการบันทึก');
    }
    if (!await readPendingPoint(target, revision, marker)) {
      requireCurrent(target, revision);
      // A missing row after dispatch could also mean a later deletion. Without
      // a durable server receipt, never recreate that uncertain clinical point.
      if (marker.phase === 'sent') throw new Error('คำขอถูกส่งแล้วแต่ยังไม่พบผล กรุณาให้ผู้ดูแลตรวจสอบ ไม่ส่งบันทึกซ้ำอัตโนมัติ');
      marker = { ...marker, phase: 'sent' };
      window.sessionStorage.setItem(insertKey(target), JSON.stringify(marker));
      if (window.sessionStorage.getItem(insertKey(target)) !== JSON.stringify(marker)) throw new Error('เก็บสถานะส่งคำขอไม่ได้ จึงยังไม่ส่งการบันทึก');
      const result = await db.from('body_pain_points').insert({ ...payload, id: marker.id, recorded_by: session.user.id });
      requireCurrent(target, revision);
      if (result.error && result.error.code !== '23505') {
        if (['P0001','22023','23514','42501','28000','23502','23503'].includes(result.error.code)) clearInsertMarker(target, marker);
        throw new Error('ยังยืนยันการบันทึกไม่ได้ กรุณาตรวจผลบันทึกที่ค้างก่อนลองใหม่');
      }
      if (!await readPendingPoint(target, revision, marker)) throw new Error('ยังไม่พบผลบันทึกเดิม กรุณาตรวจอีกครั้งก่อนลองใหม่');
    }
    requireCurrent(target, revision);
    clearInsertMarker(target, marker);
    return { error: null };
  }

  async function recoverInsert() {
    if (mutationPending || accountBlocked) return;
    const target = currentEncounter, revision = encounterRevision;
    if (!target) throw new Error('กรุณาเลือก Encounter');
    mutationPending = true;
    try {
      const marker = insertMarker(target);
      if (!marker) throw new Error('ไม่มีคำขอบันทึกจุดที่ค้างในบัญชีและ Encounter นี้');
      if (!await readPendingPoint(target, revision, marker)) throw new Error('ยังไม่พบรายการเดิม ไม่ได้สร้างจุดใหม่ กรุณาตรวจอีกครั้ง');
      clearInsertMarker(target, marker);
      reset();
      await load();
      if (isCurrent(target, revision)) $('#bm-status').textContent = 'พบและยืนยันจุดเดิมแล้ว ไม่ได้สร้างรายการซ้ำ';
    } finally { mutationPending = false; }
  }

  function isCurrent(target, revision) {
    return !accountBlocked && target === currentEncounter && revision === encounterRevision && target === ($('#encounter')?.value || null);
  }

  function blockAccount() {
    if (accountBlocked) return;
    accountBlocked = true; encounterRevision++; loadRevision++;
    currentEncounter = null; points = []; draft = null; editingId = null;
    const slot = $('#bodymap-slot');
    if (slot) { slot.inert = true; slot.textContent = 'บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่'; }
  }

  function codeFor(point) {
    const sen = (point.sen_line_code || 'S.00').replace(/\s+/g, '');
    const region = (point.body_region || 'GEN').toUpperCase().replace(/\s+/g, '-').slice(0, 10);
    const side = ({ left: 'L', right: 'R', bilateral: 'B', midline: 'M' }[point.side] || 'N');
    const score = point.pain_score == null ? 'PX' : `P${String(point.pain_score).padStart(2, '0')}`;
    return `${sen}-${region}-${side}-${score}`;
  }

  function markup() {
    return `<div id="bodymap-v31">
      <div class="section-heading"><span class="section-number">MAP</span><div><h3>แผนที่อาการและแนวเส้น</h3><p>แตะตำแหน่งบนร่างกายเพื่อบันทึกอาการก่อน–หลังรักษาใน Encounter เดียวกัน</p></div></div>
      <div class="bm-grid">
        <label>ช่วงประเมิน<select id="bm-stage"><option value="before">ก่อนรักษา</option><option value="after">หลังรักษา</option><option value="followup">ติดตามผล</option></select></label>
        <label>ชนิดอาการ<select id="bm-type"><option value="pain">ปวด</option><option value="numbness">ชา</option><option value="tightness">ตึง</option><option value="burning">แสบร้อน</option><option value="swelling">บวม</option><option value="weakness">อ่อนแรง</option><option value="other">อื่น ๆ</option></select></label>
        <label>คะแนน 0–10<input id="bm-score" type="number" min="0" max="10"></label>
        <label>ด้าน<select id="bm-side"><option value="not_specified">ไม่ระบุ</option><option value="left">ซ้าย</option><option value="right">ขวา</option><option value="bilateral">สองข้าง</option><option value="midline">กึ่งกลาง</option></select></label>
        <label>บริเวณ<input id="bm-region" placeholder="เช่น บ่า ไหล่ เข่า"></label>
        <label>แนวเส้น S.xx<input id="bm-sen" placeholder="เช่น S.04"></label>
        <label>ป้ายกำกับ<input id="bm-label" placeholder="จุดปวดหลัก"></label>
        <label>มุมมอง<input id="bm-view" readonly></label>
        <label class="full">หมายเหตุ<input id="bm-notes"></label>
      </div>
      <div class="bm-shell">
        <div class="bm-labels"><span>ด้านหน้า</span><span>ด้านหลัง</span><span>ด้านซ้าย</span><span>ด้านขวา</span></div>
        <div class="bm-canvas" id="bm-canvas"><img src="/bodymap-figures.svg?v=clinical-os-department1" alt="ภาพบุคคลผู้ใหญ่แบบสี่มุม ด้านหน้า ด้านหลัง ด้านซ้าย และด้านขวา สำหรับเลือกตำแหน่งอาการ"><div class="bm-layer" id="bm-layer"></div></div>
      </div>
      <div id="bm-status" class="bm-status" aria-live="polite">แตะบนร่างกายเพื่อเลือกตำแหน่ง</div>
      <div class="bm-actions"><button type="button" class="btn primary" id="bm-save">บันทึกจุด</button><button type="button" class="btn ghost" id="bm-cancel">ยกเลิก</button><button type="button" class="btn ghost" id="bm-print">พิมพ์ Pain Map</button></div>
      <button type="button" class="btn ghost" id="bm-recover">ตรวจผลบันทึกที่ค้าง</button>
      <div id="bm-list"></div>
    </div>`;
  }

  function emitChanged() {
    if (accountBlocked) return;
    window.dispatchEvent(new CustomEvent('chananya:clinical-data-changed', { detail: { encounterId: currentEncounter, source: 'body-pain-map' } }));
  }

  function position(point) {
    const panel = { front: 0, back: 1, left: 2, right: 3 }[point.body_view] ?? 0;
    return { left: panel * 25 + Number(point.x_percent) / 4, top: Number(point.y_percent) };
  }

  function render() {
    if (accountBlocked) return;
    const layer = $('#bm-layer');
    if (!layer) return;
    const markers = points.map(point => {
      const pointPosition = position(point);
      return `<button type="button" class="bm-marker ${point.assessment_stage === 'after' ? 'after' : ''}" data-marker-id="${esc(point.id)}" style="left:${pointPosition.left}%;top:${pointPosition.top}%" title="${esc(codeFor(point))}">${point.pain_score ?? ''}</button>`;
    }).join('');
    const draftMarker = draft ? (() => {
      const pointPosition = position(draft);
      return `<span class="bm-draft" style="left:${pointPosition.left}%;top:${pointPosition.top}%"></span>`;
    })() : '';
    layer.innerHTML = markers + draftMarker;
    $$('[data-marker-id]', layer).forEach(button => {
      button.addEventListener('click', event => { event.stopPropagation(); edit(button.dataset.markerId); });
    });

    $('#bm-list').innerHTML = points.map(point => `<article class="bm-row"><div><b>${esc(stageNames[point.assessment_stage] || point.assessment_stage)} • ${esc(typeNames[point.symptom_type] || point.symptom_type)} ${point.pain_score == null ? '' : `(${point.pain_score}/10)`}</b><small>${esc(point.body_region || 'ไม่ระบุบริเวณ')} • ${esc(point.side || '')} • ${esc(point.sen_line_code || '')}</small><small class="bm-code">${esc(point.pain_pattern_code || codeFor(point))}</small></div><div class="actions"><button type="button" class="btn ghost" data-edit-point="${esc(point.id)}">แก้</button><button type="button" class="btn danger" data-delete-point="${esc(point.id)}">ลบ</button></div></article>`).join('') || '<p class="muted">ยังไม่มีจุดปวด</p>';
    window.dispatchEvent(new CustomEvent('chananya:bodymap-rendered'));
  }

  function onCanvasClick(event) {
    if (accountBlocked) return;
    if (!currentEncounter) { alert('กรุณาเลือก Encounter ก่อน'); return; }
    if (event.target.closest('.bm-marker')) return;
    const rect = $('#bm-canvas').getBoundingClientRect();
    const globalX = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const panel = Math.min(3, Math.max(0, Math.floor(globalX / 25)));
    const view = ['front', 'back', 'left', 'right'][panel];
    draft = { body_view: view, x_percent: +((globalX - panel * 25) * 4).toFixed(2), y_percent: +Math.max(0, Math.min(100, y)).toFixed(2) };
    $('#bm-view').value = viewNames[view];
    if (view === 'left') $('#bm-side').value = 'left';
    if (view === 'right') $('#bm-side').value = 'right';
    $('#bm-status').textContent = `เลือก ${viewNames[view]} X ${draft.x_percent}% / Y ${draft.y_percent}%`;
    render();
  }

  async function load() {
    if (accountBlocked) return;
    const target = currentEncounter, revision = encounterRevision, request = ++loadRevision;
    if (!currentEncounter) { points = []; render(); return; }
    const result = await db.from('body_pain_points').select('*').eq('encounter_id', target).order('recorded_at');
    if (!isCurrent(target, revision) || request !== loadRevision) return;
    if (result.error) throw result.error;
    points = result.data || [];
    render();
  }

  function edit(id) {
    if (accountBlocked) return;
    const point = points.find(item => item.id === id);
    if (!point) return;
    editingId = id;
    draft = { body_view: point.body_view, x_percent: point.x_percent, y_percent: point.y_percent };
    $('#bm-stage').value = point.assessment_stage;
    $('#bm-type').value = point.symptom_type;
    $('#bm-score').value = point.pain_score ?? '';
    $('#bm-side').value = point.side || 'not_specified';
    $('#bm-region').value = point.body_region || '';
    $('#bm-sen').value = point.sen_line_code || '';
    $('#bm-label').value = point.point_label || '';
    $('#bm-notes').value = point.notes || '';
    $('#bm-view').value = viewNames[point.body_view] || '';
    render();
  }

  function reset() {
    if (accountBlocked) return;
    editingId = null;
    draft = null;
    ['#bm-score', '#bm-region', '#bm-sen', '#bm-label', '#bm-notes', '#bm-view'].forEach(selector => { const element = $(selector); if (element) element.value = ''; });
    if ($('#bm-status')) $('#bm-status').textContent = 'แตะบนร่างกายเพื่อเลือกตำแหน่ง';
    render();
  }

  async function save() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
    if (mutationPending) return;
    if (!currentEncounter) throw new Error('กรุณาเลือก Encounter');
    if (!draft) throw new Error('กรุณาแตะตำแหน่งบนร่างกาย');
    const target = currentEncounter, revision = encounterRevision;
    if (!isCurrent(target, revision)) throw new Error('กรุณาโหลด Encounter ปัจจุบันก่อน');
    if (editingId && insertMarker(target)) throw new Error('กรุณาตรวจผลบันทึกที่ค้างก่อนแก้ไขจุด');
    const payload = {
      encounter_id: currentEncounter,
      assessment_stage: $('#bm-stage').value,
      body_view: draft.body_view,
      x_percent: draft.x_percent,
      y_percent: draft.y_percent,
      symptom_type: $('#bm-type').value,
      pain_score: $('#bm-score').value === '' ? null : Number($('#bm-score').value),
      side: $('#bm-side').value,
      body_region: $('#bm-region').value || null,
      sen_line_code: $('#bm-sen').value || null,
      point_label: $('#bm-label').value || null,
      notes: $('#bm-notes').value || null,
      updated_at: new Date().toISOString()
    };
    payload.pain_pattern_code = codeFor(payload);
    mutationPending = true;
    try {
    const result = editingId
      ? await db.from('body_pain_points').update(payload).eq('id', editingId).eq('encounter_id', target)
      : await insertPoint(payload, target, revision);
    if (!isCurrent(target, revision)) return;
    if (result.error) throw result.error;
    reset();
    await load();
    if (isCurrent(target, revision)) emitChanged();
    } finally { mutationPending = false; }
  }

  async function remove(id) {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
    if (mutationPending) return;
    const target = currentEncounter, revision = encounterRevision;
    if (!isCurrent(target, revision) || !points.some(point => point.id === id)) throw new Error('กรุณาโหลดจุดของ Encounter ปัจจุบันก่อน');
    if (insertMarker(target)) throw new Error('กรุณาตรวจผลบันทึกที่ค้างก่อนลบจุด');
    if (!confirm('ยืนยันลบจุดนี้?')) return;
    mutationPending = true;
    try {
    const result = await db.from('body_pain_points').delete().eq('id', id).eq('encounter_id', target);
    if (!isCurrent(target, revision)) return;
    if (result.error) throw result.error;
    await load();
    if (isCurrent(target, revision)) emitChanged();
    } finally { mutationPending = false; }
  }

  function showError(error) {
    if (accountBlocked) return;
    console.error(error);
    alert(error?.message || String(error));
  }

  async function init() {
    db = runtime.getDb();
    session = await runtime.getSession();
    if (!session) return;
    const originalActor = session.user.id;
    db.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT' || !nextSession?.user?.id || nextSession.user.id !== originalActor) blockAccount();
    });
    if (accountBlocked) return;
    const slot = $('#bodymap-slot');
    if (!slot) return;
    slot.innerHTML = markup();
    $('#bm-canvas').addEventListener('click', onCanvasClick);
    $('#bm-save').addEventListener('click', () => save().catch(showError));
    $('#bm-cancel').addEventListener('click', reset);
    $('#bm-recover').addEventListener('click', () => recoverInsert().catch(showError));
    $('#bm-print').addEventListener('click', () => { if (!accountBlocked) window.print(); });
    $('#bm-list').addEventListener('click', event => {
      const editButton = event.target.closest('[data-edit-point]');
      const deleteButton = event.target.closest('[data-delete-point]');
      if (editButton) edit(editButton.dataset.editPoint);
      if (deleteButton) remove(deleteButton.dataset.deletePoint).catch(showError);
    });
    const encounter = $('#encounter');
    currentEncounter = encounter?.value || null;
    const syncEncounter = () => {
      if (accountBlocked) return;
      const nextEncounter = encounter?.value || null;
      if (nextEncounter === currentEncounter) return;
      currentEncounter = nextEncounter;
      encounterRevision++;
      points = [];
      reset();
      load().catch(showError);
    };
    encounter?.addEventListener('change', syncEncounter);
    window.addEventListener('chananya:encounter-changed', syncEncounter);
    await load();
  }

  window.addEventListener('pagehide', event => { if (event.persisted) blockAccount(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(showError), { once: true });
  else init().catch(showError);
})();
