(() => {
  'use strict';

  const cfg = window.CHANANYA_AUTH || {};
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const VIEW_NAMES = { front: 'ด้านหน้า', back: 'ด้านหลัง', left: 'ด้านซ้าย', right: 'ด้านขวา' };
  const STAGE_NAMES = { before: 'ก่อนรักษา', after: 'หลังรักษา', followup: 'ติดตามผล' };
  const TYPE_NAMES = {
    pain: 'ปวด', numbness: 'ชา', tightness: 'ตึง', burning: 'แสบร้อน',
    swelling: 'บวม', weakness: 'อ่อนแรง', other: 'อื่น ๆ'
  };
  const TYPE_COLORS = {
    pain: '#ef6c35', numbness: '#2979ff', tightness: '#f3b61f',
    burning: '#d62828', swelling: '#8e44ad', weakness: '#546e7a', other: '#2e7d32'
  };

  let db = null;
  let session = null;
  let currentEncounter = null;
  let points = [];
  let draft = null;
  let editingId = null;

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function injectStyle() {
    if ($('#bodymap-style')) return;
    const style = document.createElement('style');
    style.id = 'bodymap-style';
    style.textContent = `
      .bodymap-toolbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}
      .bodymap-toolbar label{min-width:0}
      .bodymap-toolbar input,.bodymap-toolbar select,.bodymap-toolbar textarea{width:100%;min-width:0;box-sizing:border-box}
      .bodymap-full{grid-column:1/-1}
      .bodymap-shell{border:1px solid #d8e1dc;border-radius:16px;padding:12px;background:#fff;overflow:hidden}
      .bodymap-labels{display:grid;grid-template-columns:repeat(4,1fr);font-weight:700;text-align:center;font-size:.92rem;margin-bottom:4px}
      .bodymap-canvas{position:relative;width:100%;aspect-ratio:800/380;background:#fff;touch-action:manipulation;cursor:crosshair;user-select:none}
      .bodymap-canvas>img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}
      .bodymap-markers{position:absolute;inset:0;pointer-events:none}
      .bodymap-marker{position:absolute;width:24px;height:24px;border-radius:50%;transform:translate(-50%,-50%);border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:800}
      .bodymap-marker.after{background:#fff!important;border-width:4px}
      .bodymap-marker.selected{outline:3px solid #173f31;outline-offset:2px}
      .bodymap-draft{position:absolute;width:28px;height:28px;border-radius:50%;transform:translate(-50%,-50%);border:3px dashed #173f31;background:rgba(23,63,49,.18);pointer-events:none}
      .bodymap-actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
      .bodymap-actions>*{flex:1 1 180px}
      .bodymap-hint{padding:10px 12px;border-radius:10px;background:#edf5f1;margin:10px 0}
      .bodymap-legend{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      .bodymap-legend span{display:inline-flex;align-items:center;gap:6px;font-size:.85rem}
      .bodymap-dot{width:12px;height:12px;border-radius:50%;display:inline-block}
      .bodymap-list .item{align-items:flex-start}
      .bodymap-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}
      @media(max-width:900px){.bodymap-toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:560px){.bodymap-toolbar{grid-template-columns:1fr}.bodymap-labels{font-size:.72rem}.bodymap-marker{width:20px;height:20px}}
      @media print{.v3nav,.top,.bodymap-toolbar,.bodymap-actions,.bodymap-hint,.bodymap-list button{display:none!important}.bodymap-shell{border:0;padding:0}}
    `;
    document.head.appendChild(style);
  }

  function sectionTemplate() {
    return `
      <h2 class="section-title">4. แผนภาพตำแหน่งอาการปวดและผลก่อน–หลังรักษา</h2>
      <p class="muted">เลือก Encounter แล้วแตะบนร่างกายเพื่อวางจุด จากนั้นระบุชนิดอาการ คะแนน แนวเส้น และบันทึก</p>

      <div class="bodymap-toolbar">
        <label>ช่วงประเมิน
          <select id="bm-stage"><option value="before">ก่อนรักษา</option><option value="after">หลังรักษา</option><option value="followup">ติดตามผล</option></select>
        </label>
        <label>ชนิดอาการ
          <select id="bm-type"><option value="pain">ปวด</option><option value="numbness">ชา</option><option value="tightness">ตึง</option><option value="burning">แสบร้อน</option><option value="swelling">บวม</option><option value="weakness">อ่อนแรง</option><option value="other">อื่น ๆ</option></select>
        </label>
        <label>คะแนน 0–10<input id="bm-score" type="number" min="0" max="10" step="1"></label>
        <label>ด้าน
          <select id="bm-side"><option value="not_specified">ไม่ระบุ</option><option value="left">ซ้าย</option><option value="right">ขวา</option><option value="bilateral">สองข้าง</option><option value="midline">กึ่งกลาง</option></select>
        </label>
        <label>บริเวณกายวิภาค<input id="bm-region" placeholder="เช่น บ่า ไหล่ ข้อศอก หลังส่วนล่าง"></label>
        <label>แนวเส้น S.xx
          <input id="bm-sen" list="bm-sen-list" placeholder="เช่น S.04">
          <datalist id="bm-sen-list">${Array.from({length: 20}, (_, i) => `<option value="S.${String(i + 1).padStart(2, '0')}"></option>`).join('')}</datalist>
        </label>
        <label>ป้ายกำกับ<input id="bm-label" placeholder="เช่น จุดปวดหลัก"></label>
        <label>มุมมองที่เลือก<input id="bm-view-name" readonly placeholder="แตะบนรูป"></label>
        <label class="bodymap-full">หมายเหตุ<input id="bm-notes" placeholder="อาการร่วม การร้าว ปัจจัยกระตุ้น หรือรายละเอียดเพิ่มเติม"></label>
      </div>

      <div class="bodymap-shell">
        <div class="bodymap-labels"><span>ด้านหน้า</span><span>ด้านหลัง</span><span>ด้านซ้าย</span><span>ด้านขวา</span></div>
        <div class="bodymap-canvas" id="bodymap-canvas" role="application" aria-label="แผนภาพร่างกายสำหรับระบุตำแหน่งอาการ">
          <img src="/bodymap-figures.svg?v=1" alt="ร่างกายด้านหน้า ด้านหลัง ด้านซ้าย และด้านขวา">
          <div class="bodymap-markers" id="bodymap-markers"></div>
        </div>
        <div class="bodymap-legend">
          ${Object.entries(TYPE_NAMES).map(([k, v]) => `<span><i class="bodymap-dot" style="background:${TYPE_COLORS[k]}"></i>${v}</span>`).join('')}
          <span>● ก่อนรักษา</span><span>○ หลังรักษา</span>
        </div>
      </div>

      <div class="bodymap-hint" id="bm-hint">ยังไม่ได้เลือกตำแหน่ง กรุณาแตะบนร่างกาย</div>
      <div class="bodymap-actions">
        <button type="button" class="btn primary" id="bm-save">บันทึกจุดปวด</button>
        <button type="button" class="btn ghost" id="bm-cancel">ยกเลิกการแก้ไข</button>
        <button type="button" class="btn ghost" id="bm-print">พิมพ์ Pain Map</button>
      </div>

      <div id="pain-list" class="list bodymap-list"></div>
    `;
  }

  async function initDb() {
    if (!cfg.url || !cfg.anonKey || !window.supabase) throw new Error('ไม่พบ Supabase config');
    db = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    session = (await db.auth.getSession()).data.session;
    if (!session) throw new Error('กรุณาเข้าสู่ระบบ');
  }

  function install() {
    const oldForm = $('#pain-form');
    const section = oldForm?.closest('section.card');
    if (!section || section.dataset.interactiveBodymap === '1') return false;

    section.dataset.interactiveBodymap = '1';
    section.innerHTML = sectionTemplate();
    injectStyle();

    $('#bodymap-canvas').addEventListener('click', onCanvasClick);
    $('#bm-save').addEventListener('click', () => savePoint().catch(showError));
    $('#bm-cancel').addEventListener('click', resetDraft);
    $('#bm-print').addEventListener('click', printMap);

    const encounter = $('#encounter');
    currentEncounter = encounter?.value || null;
    encounter?.addEventListener('change', () => {
      currentEncounter = encounter.value || null;
      resetDraft();
      setTimeout(() => loadPoints().catch(showError), 350);
    });

    initDb().then(() => currentEncounter ? loadPoints() : renderPoints()).catch(showError);
    return true;
  }

  function onCanvasClick(event) {
    if (!currentEncounter) { alert('กรุณาเลือก Encounter ก่อนวางจุด'); return; }
    if (event.target.closest('.bodymap-marker')) return;

    const canvas = $('#bodymap-canvas');
    const rect = canvas.getBoundingClientRect();
    const globalX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    const viewIndex = Math.min(3, Math.floor(globalX / 25));
    const view = ['front', 'back', 'left', 'right'][viewIndex];
    const localX = (globalX - viewIndex * 25) * 4;

    draft = { body_view: view, x_percent: localX, y_percent: y };
    $('#bm-view-name').value = VIEW_NAMES[view];
    if (view === 'left') $('#bm-side').value = 'left';
    if (view === 'right') $('#bm-side').value = 'right';
    updateHint();
    renderPoints();
  }

  function markerPosition(point) {
    const idx = { front: 0, back: 1, left: 2, right: 3 }[point.body_view] ?? 0;
    return { left: idx * 25 + Number(point.x_percent || 0) / 4, top: Number(point.y_percent || 0) };
  }

  function renderPoints() {
    const layer = $('#bodymap-markers');
    if (!layer) return;
    const html = points.map(point => {
      const pos = markerPosition(point);
      const color = TYPE_COLORS[point.symptom_type] || TYPE_COLORS.other;
      const afterClass = point.assessment_stage === 'after' ? ' after' : '';
      const selected = point.id === editingId ? ' selected' : '';
      const label = point.pain_score == null ? '' : esc(point.pain_score);
      return `<button type="button" class="bodymap-marker${afterClass}${selected}" data-point-id="${point.id}" style="left:${pos.left}%;top:${pos.top}%;background:${color};${point.assessment_stage === 'after' ? `border-color:${color};color:${color}` : ''}" title="${esc(TYPE_NAMES[point.symptom_type] || point.symptom_type)} ${esc(point.body_region || '')} ${esc(point.pain_pattern_code || '')}">${label}</button>`;
    }).join('');
    const draftHtml = draft ? (() => { const pos = markerPosition(draft); return `<span class="bodymap-draft" style="left:${pos.left}%;top:${pos.top}%"></span>`; })() : '';
    layer.innerHTML = html + draftHtml;
    $$('[data-point-id]', layer).forEach(button => button.addEventListener('click', event => { event.stopPropagation(); editPoint(button.dataset.pointId); }));
    renderList();
  }

  function renderList() {
    const list = $('#pain-list');
    if (!list) return;
    list.innerHTML = points.map(point => `
      <div class="item">
        <div>
          <b>${esc(STAGE_NAMES[point.assessment_stage] || point.assessment_stage)} • ${esc(VIEW_NAMES[point.body_view] || point.body_view)} • ${esc(TYPE_NAMES[point.symptom_type] || point.symptom_type)} ${point.pain_score == null ? '' : `(${esc(point.pain_score)}/10)`}</b>
          <small>${esc(point.body_region || 'ไม่ระบุบริเวณ')} • ${esc(point.side || 'ไม่ระบุด้าน')} • ${esc(point.sen_line_code || 'ไม่ระบุเส้น')}</small>
          <small class="bodymap-code">${esc(point.pain_pattern_code || point.point_code || '')}</small>
          ${point.notes ? `<small>${esc(point.notes)}</small>` : ''}
        </div>
        <div class="right"><button type="button" class="btn ghost" data-edit-point="${point.id}">แก้ไข</button><button type="button" class="btn ghost" data-delete-point="${point.id}">ลบ</button></div>
      </div>
    `).join('') || '<p class="muted">ยังไม่มีตำแหน่งอาการ</p>';
    $$('[data-edit-point]', list).forEach(b => b.onclick = () => editPoint(b.dataset.editPoint));
    $$('[data-delete-point]', list).forEach(b => b.onclick = () => deletePoint(b.dataset.deletePoint).catch(showError));
  }

  async function loadPoints() {
    currentEncounter = $('#encounter')?.value || null;
    if (!db || !currentEncounter) { points = []; renderPoints(); return; }
    const result = await db.from('body_pain_points').select('*').eq('encounter_id', currentEncounter).order('recorded_at', { ascending: true });
    if (result.error) throw result.error;
    points = result.data || [];
    renderPoints();
  }

  function updateHint() {
    const hint = $('#bm-hint');
    if (!draft) { hint.textContent = 'ยังไม่ได้เลือกตำแหน่ง กรุณาแตะบนร่างกาย'; return; }
    hint.textContent = `ตำแหน่งที่เลือก: ${VIEW_NAMES[draft.body_view]} • X ${Number(draft.x_percent).toFixed(1)}% • Y ${Number(draft.y_percent).toFixed(1)}%`;
  }

  function buildPatternCode(payload) {
    const sen = String(payload.sen_line_code || 'S.00').toUpperCase().replace(/\s+/g, '');
    const view = { front: 'F', back: 'B', left: 'L', right: 'R' }[payload.body_view] || 'U';
    const side = { left: 'L', right: 'R', bilateral: 'B', midline: 'M', not_specified: 'U' }[payload.side] || 'U';
    const type = { pain: 'P', numbness: 'N', tightness: 'T', burning: 'BR', swelling: 'SW', weakness: 'WK', other: 'O' }[payload.symptom_type] || 'O';
    const stage = { before: 'B', after: 'A', followup: 'F' }[payload.assessment_stage] || 'U';
    const score = payload.pain_score == null || payload.pain_score === '' ? 'X' : String(payload.pain_score).padStart(2, '0');
    return `CPSC-${sen}-${view}-${side}-${type}${score}-${stage}`;
  }

  async function savePoint() {
    if (!db) await initDb();
    currentEncounter = $('#encounter')?.value || null;
    if (!currentEncounter) throw new Error('กรุณาเลือก Encounter');
    if (!draft) throw new Error('กรุณาแตะตำแหน่งบนร่างกาย');

    const payload = {
      encounter_id: currentEncounter,
      assessment_stage: $('#bm-stage').value,
      body_view: draft.body_view,
      symptom_type: $('#bm-type').value,
      pain_score: $('#bm-score').value === '' ? null : Number($('#bm-score').value),
      x_percent: Number(draft.x_percent.toFixed(2)),
      y_percent: Number(draft.y_percent.toFixed(2)),
      body_region: $('#bm-region').value.trim() || null,
      side: $('#bm-side').value,
      sen_line_code: $('#bm-sen').value.trim().toUpperCase() || null,
      marker_label: $('#bm-label').value.trim() || null,
      notes: $('#bm-notes').value.trim() || null,
      recorded_by: session.user.id
    };
    payload.pain_pattern_code = buildPatternCode(payload);

    let result = editingId ? await db.from('body_pain_points').update(payload).eq('id', editingId) : await db.from('body_pain_points').insert(payload);
    if (result.error) {
      const missingExtendedColumn = /body_region|sen_line_code|pain_pattern_code|marker_label|side/i.test(result.error.message || '');
      if (!missingExtendedColumn) throw result.error;
      const fallback = {
        encounter_id: payload.encounter_id,
        assessment_stage: payload.assessment_stage,
        body_view: payload.body_view,
        symptom_type: payload.symptom_type,
        pain_score: payload.pain_score,
        x_percent: payload.x_percent,
        y_percent: payload.y_percent,
        notes: [payload.notes, payload.body_region ? `บริเวณ:${payload.body_region}` : '', payload.side ? `ด้าน:${payload.side}` : '', payload.sen_line_code ? `เส้น:${payload.sen_line_code}` : '', `รหัส:${payload.pain_pattern_code}`].filter(Boolean).join(' | '),
        recorded_by: payload.recorded_by
      };
      result = editingId ? await db.from('body_pain_points').update(fallback).eq('id', editingId) : await db.from('body_pain_points').insert(fallback);
      if (result.error) throw result.error;
      alert('บันทึกได้แล้ว แต่ควร Run SQL Body Pain Map เพื่อเปิดใช้ฟิลด์แนวเส้นและ Pain Code แบบเต็ม');
    }

    const wasEditing = Boolean(editingId);
    resetDraft();
    await loadPoints();
    flash(wasEditing ? 'อัปเดตจุดปวดแล้ว' : 'บันทึกจุดปวดแล้ว');
  }

  function editPoint(id) {
    const point = points.find(p => p.id === id);
    if (!point) return;
    editingId = id;
    draft = { body_view: point.body_view, x_percent: Number(point.x_percent), y_percent: Number(point.y_percent) };
    $('#bm-stage').value = point.assessment_stage || 'before';
    $('#bm-type').value = point.symptom_type || 'pain';
    $('#bm-score').value = point.pain_score ?? '';
    $('#bm-side').value = point.side || 'not_specified';
    $('#bm-region').value = point.body_region || '';
    $('#bm-sen').value = point.sen_line_code || '';
    $('#bm-label').value = point.marker_label || '';
    $('#bm-notes').value = point.notes || '';
    $('#bm-view-name').value = VIEW_NAMES[point.body_view] || point.body_view;
    $('#bm-save').textContent = 'อัปเดตจุดปวด';
    updateHint();
    renderPoints();
    $('#bm-region').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetDraft() {
    draft = null;
    editingId = null;
    ['bm-score', 'bm-region', 'bm-sen', 'bm-label', 'bm-notes', 'bm-view-name'].forEach(id => { const el = $(`#${id}`); if (el) el.value = ''; });
    if ($('#bm-side')) $('#bm-side').value = 'not_specified';
    if ($('#bm-save')) $('#bm-save').textContent = 'บันทึกจุดปวด';
    updateHint();
    renderPoints();
  }

  async function deletePoint(id) {
    if (!confirm('ยืนยันลบตำแหน่งอาการนี้?')) return;
    const result = await db.from('body_pain_points').delete().eq('id', id);
    if (result.error) throw result.error;
    if (editingId === id) resetDraft();
    await loadPoints();
    flash('ลบจุดปวดแล้ว');
  }

  function printMap() {
    if (!currentEncounter) { alert('กรุณาเลือก Encounter'); return; }
    const before = points.filter(p => p.assessment_stage === 'before');
    const after = points.filter(p => p.assessment_stage === 'after');
    const score = rows => rows.length ? Math.max(...rows.map(p => Number(p.pain_score || 0))) : '-';
    const markers = points.map(point => {
      const pos = markerPosition(point);
      const color = TYPE_COLORS[point.symptom_type] || TYPE_COLORS.other;
      const ring = point.assessment_stage === 'after';
      return `<span style="position:absolute;left:${pos.left}%;top:${pos.top}%;width:18px;height:18px;border-radius:50%;transform:translate(-50%,-50%);background:${ring ? '#fff' : color};border:3px solid ${ring ? color : '#fff'};box-shadow:0 1px 4px #555;text-align:center;font:700 9px Arial;color:${ring ? color : '#fff'}">${point.pain_score ?? ''}</span>`;
    }).join('');
    const rows = points.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(STAGE_NAMES[p.assessment_stage] || p.assessment_stage)}</td><td>${esc(VIEW_NAMES[p.body_view] || p.body_view)}</td><td>${esc(p.body_region || '-')}</td><td>${esc(p.side || '-')}</td><td>${esc(TYPE_NAMES[p.symptom_type] || p.symptom_type)}</td><td>${esc(p.pain_score ?? '-')}</td><td>${esc(p.sen_line_code || '-')}</td><td>${esc(p.notes || '')}</td></tr>`).join('');

    const w = window.open('', '_blank', 'width=1100,height=900');
    w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Pain Map</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:Arial,"Noto Sans Thai",sans-serif;color:#111;margin:0}h1{font-size:22px;margin:0 0 8px}.meta{display:flex;gap:30px;margin-bottom:12px}.map{position:relative;width:100%;max-width:1000px;aspect-ratio:800/380;margin:auto}.map img{width:100%;height:100%;object-fit:contain}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border:1px solid #aaa;padding:5px;text-align:left}.summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.box{border:1px solid #aaa;padding:10px}button{padding:8px 16px;margin:10px 0}@media print{button{display:none}}</style></head><body><h1>ชนัญญา — แผนภาพตำแหน่งอาการปวดและผลก่อน–หลังการรักษา</h1><div class="meta"><span>Encounter: ${esc($('#encounter option:checked')?.textContent || currentEncounter)}</span><span>วันที่พิมพ์: ${new Date().toLocaleString('th-TH')}</span></div><div class="map"><img src="/bodymap-figures.svg?v=1">${markers}</div><div class="summary"><div class="box"><b>ก่อนรักษา</b><br>คะแนนสูงสุด ${score(before)}/10 • ${before.length} จุด</div><div class="box"><b>หลังรักษา</b><br>คะแนนสูงสุด ${score(after)}/10 • ${after.length} จุด</div></div><table><thead><tr><th>#</th><th>ช่วง</th><th>มุมมอง</th><th>บริเวณ</th><th>ด้าน</th><th>อาการ</th><th>คะแนน</th><th>เส้น</th><th>หมายเหตุ</th></tr></thead><tbody>${rows}</tbody></table><button onclick="print()">พิมพ์</button></body></html>`);
    w.document.close();
  }

  function flash(message) {
    const toast = $('#toast');
    if (toast) { toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); }
  }

  function showError(error) { console.error(error); alert(error?.message || String(error)); }

  window.addEventListener('load', () => {
    if (install()) return;
    const timer = setInterval(() => { if (install()) clearInterval(timer); }, 250);
    setTimeout(() => clearInterval(timer), 10000);
  });
})();
