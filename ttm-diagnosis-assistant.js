(() => {
  'use strict';

  const runtime = window.ChananyaRuntime;
  if (!runtime) { console.error('ChananyaRuntime is required before TTM assistant'); return; }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const slot = document.querySelector('#ttm-assistant-slot');
  if (!slot || document.querySelector('#ttm-knowledge-assistant')) return;

  slot.innerHTML = `
    <section id="ttm-knowledge-assistant" class="ttm-assistant">
      <div class="ttm-assistant-head">
        <div><b>ฐานความรู้วินิจฉัยแพทย์แผนไทย</b><small>ช่วยจัดโครงสร้างสมุฏฐานจาก TTM-DKR-v1 — ผู้ประกอบวิชาชีพต้องตรวจและยืนยัน</small></div>
        <button type="button" id="ttm-load-rules" class="btn ghost">เปิดฐานความรู้</button>
      </div>
      <div id="ttm-rule-status" class="muted space-top-xs">ยังไม่ได้โหลดฐานความรู้</div>
      <div id="ttm-coordinate-panel" class="space-top-sm" hidden>
        <label>พิกัดสมุฏฐาน<select id="ttm-coordinate"><option value="">เลือกพิกัด</option></select></label>
        <div id="ttm-coordinate-desc" class="status space-top-xs"></div>
      </div>
      <div id="ttm-context-panel" class="ttm-context-grid" hidden>
        <label>สถานะธาตุ<select id="ttm-dosha-state"><option value="">ไม่ระบุ</option><option>กำเริบ</option><option>หย่อน</option><option>พิการ</option></select></label>
        <label>พิกัดระคน<input id="ttm-mixed-coordinate" placeholder="บันทึกเมื่อมีพิกัดระคน"></label>
        <label>ฤดูสมุฏฐาน 4<input id="ttm-season4" placeholder="แพทย์ยืนยัน"></label>
        <label>ฤดูสมุฏฐาน 6<input id="ttm-season6" placeholder="แพทย์ยืนยัน"></label>
        <label>ฤดูพิสดาร<input id="ttm-season-pitsadan" placeholder="แพทย์ยืนยัน"></label>
        <label>ราศีสมุฏฐาน<input id="ttm-zodiac" placeholder="แพทย์ยืนยัน"></label>
      </div>
      <label class="ttm-confirm"><input type="checkbox" id="ttm-confirm"><span>ข้าพเจ้าได้ตรวจข้อมูลสมุฏฐานและยืนยันการประเมินนี้ด้วยตนเอง</span></label>
      <div class="ttm-note">รายการที่ยังไม่ได้ approve เป็น decision support เท่านั้น ระบบจะไม่วินิจฉัยแทนผู้ประกอบวิชาชีพ</div>
    </section>`;

  const db = runtime.getDb();
  const $ = selector => slot.querySelector(selector);
  let rules = [];

  async function loadRules() {
    const result = await db.from('ttm_diagnostic_knowledge').select('*').eq('active', true).order('domain').order('rule_key');
    if (result.error) { $('#ttm-rule-status').textContent = `โหลดฐานความรู้ไม่ได้: ${result.error.message}`; return; }
    rules = result.data || [];
    const coordinates = rules.filter(item => item.domain === 'coordinate');
    $('#ttm-coordinate').innerHTML = '<option value="">เลือกพิกัด</option>' + coordinates.map(item => `<option value="${esc(item.input_key)}">${esc(item.input_key)} — ${esc(item.rule_key)}</option>`).join('');
    $('#ttm-coordinate-panel').hidden = false;
    $('#ttm-context-panel').hidden = false;
    const pending = rules.filter(item => item.review_status !== 'approved').length;
    $('#ttm-rule-status').textContent = `โหลด ${rules.length} rules • ${pending} รายการยังต้อง practitioner review`;
  }

  $('#ttm-load-rules').addEventListener('click', () => loadRules().catch(error => { console.error(error); $('#ttm-rule-status').textContent = error.message; }));
  $('#ttm-coordinate').addEventListener('change', () => {
    const item = rules.find(rule => rule.domain === 'coordinate' && rule.input_key === $('#ttm-coordinate').value);
    $('#ttm-coordinate-desc').textContent = item ? `${item.output_value || ''}${item.description ? ` — ${item.description}` : ''} • ${item.review_status === 'approved' ? 'Approved' : 'Review required'}` : '';
    if (item) {
      const dhatu = document.querySelector('#dx-dhatu');
      const map = { ไฟ: 'เตโช', ลม: 'วาโย', น้ำ: 'อาโป', ดิน: 'ปถวี' };
      if (dhatu && !dhatu.value) dhatu.value = map[item.element] || '';
    }
  });

  window.ChananyaTTMContext = Object.freeze({
    getValues() {
      return {
        dosha_state: $('#ttm-dosha-state').value || null,
        coordinate: $('#ttm-coordinate').value || null,
        mixed_coordinate: $('#ttm-mixed-coordinate').value || null,
        season_4: $('#ttm-season4').value || null,
        season_6: $('#ttm-season6').value || null,
        season_pitsadan: $('#ttm-season-pitsadan').value || null,
        zodiac_samutthan: $('#ttm-zodiac').value || null,
        practitioner_confirmed: $('#ttm-confirm').checked,
        knowledge_version: 'TTM-DKR-v1'
      };
    }
  });
  window.dispatchEvent(new CustomEvent('chananya:ttm-assistant-ready'));
})();
