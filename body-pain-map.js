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
      <div id="bm-list"></div>
    </div>`;
  }

  function emitChanged() {
    window.dispatchEvent(new CustomEvent('chananya:clinical-data-changed', { detail: { encounterId: currentEncounter, source: 'body-pain-map' } }));
  }

  function position(point) {
    const panel = { front: 0, back: 1, left: 2, right: 3 }[point.body_view] ?? 0;
    return { left: panel * 25 + Number(point.x_percent) / 4, top: Number(point.y_percent) };
  }

  function render() {
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
    if (!currentEncounter) { points = []; render(); return; }
    const result = await db.from('body_pain_points').select('*').eq('encounter_id', currentEncounter).order('recorded_at');
    if (result.error) throw result.error;
    points = result.data || [];
    render();
  }

  function edit(id) {
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
    editingId = null;
    draft = null;
    ['#bm-score', '#bm-region', '#bm-sen', '#bm-label', '#bm-notes', '#bm-view'].forEach(selector => { const element = $(selector); if (element) element.value = ''; });
    if ($('#bm-status')) $('#bm-status').textContent = 'แตะบนร่างกายเพื่อเลือกตำแหน่ง';
    render();
  }

  async function save() {
    if (!currentEncounter) throw new Error('กรุณาเลือก Encounter');
    if (!draft) throw new Error('กรุณาแตะตำแหน่งบนร่างกาย');
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
    const result = editingId
      ? await db.from('body_pain_points').update(payload).eq('id', editingId)
      : await db.from('body_pain_points').insert({ ...payload, recorded_by: session.user.id });
    if (result.error) throw result.error;
    reset();
    await load();
    emitChanged();
  }

  async function remove(id) {
    if (!confirm('ยืนยันลบจุดนี้?')) return;
    const result = await db.from('body_pain_points').delete().eq('id', id);
    if (result.error) throw result.error;
    await load();
    emitChanged();
  }

  function showError(error) {
    console.error(error);
    alert(error?.message || String(error));
  }

  async function init() {
    db = runtime.getDb();
    session = await runtime.getSession();
    if (!session) return;
    const slot = $('#bodymap-slot');
    if (!slot) return;
    slot.innerHTML = markup();
    $('#bm-canvas').addEventListener('click', onCanvasClick);
    $('#bm-save').addEventListener('click', () => save().catch(showError));
    $('#bm-cancel').addEventListener('click', reset);
    $('#bm-print').addEventListener('click', () => window.print());
    $('#bm-list').addEventListener('click', event => {
      const editButton = event.target.closest('[data-edit-point]');
      const deleteButton = event.target.closest('[data-delete-point]');
      if (editButton) edit(editButton.dataset.editPoint);
      if (deleteButton) remove(deleteButton.dataset.deletePoint).catch(showError);
    });
    const encounter = $('#encounter');
    currentEncounter = encounter?.value || null;
    encounter?.addEventListener('change', () => {
      currentEncounter = encounter.value || null;
      reset();
      load().catch(showError);
    });
    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(showError), { once: true });
  else init().catch(showError);
})();
