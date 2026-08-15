(() => {
  'use strict';
  const wait = setInterval(() => {
    const form = document.querySelector('#diagnosis-form');
    if (!form || !window.supabase || !window.CHANANYA_AUTH) return;
    clearInterval(wait);
    install(form);
  }, 250);
  setTimeout(() => clearInterval(wait), 15000);

  function install(form) {
    if (document.querySelector('#ttm-knowledge-assistant')) return;
    const cfg = window.CHANANYA_AUTH;
    const db = supabase.createClient(cfg.url || cfg.supabaseUrl, cfg.anonKey || cfg.publishableKey, {auth:{persistSession:true,autoRefreshToken:true}});
    const box = document.createElement('section');
    box.id = 'ttm-knowledge-assistant';
    box.className = 'full';
    box.innerHTML = `
      <div style="border:1px solid #cfdcd5;border-radius:14px;padding:14px;background:#f8fbf9">
        <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">
          <div><b>TTM Diagnostic Knowledge Assistant</b><div style="font-size:.88rem;color:#617069">ช่วยจัดโครงสร้างสมุฏฐานจากฐานความรู้ TTM-DKR-v1 — แพทย์ต้องตรวจและยืนยัน</div></div>
          <button type="button" id="ttm-load-rules" class="btn ghost">เปิดฐานความรู้</button>
        </div>
        <div id="ttm-rule-status" style="margin-top:10px;font-size:.9rem;color:#617069">ยังไม่ได้โหลดฐานความรู้</div>
        <div id="ttm-coordinate-panel" style="display:none;margin-top:12px">
          <label>พิกัดสมุฏฐาน<select id="ttm-coordinate"><option value="">เลือกพิกัด</option></select></label>
          <div id="ttm-coordinate-desc" style="margin-top:8px;padding:10px;border-radius:10px;background:#eef4f0"></div>
        </div>
        <div id="ttm-context-panel" style="display:none;margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
          <label>สถานะธาตุ<select id="ttm-dosha-state"><option value="">ไม่ระบุ</option><option>กำเริบ</option><option>หย่อน</option><option>พิการ</option></select></label>
          <label>พิกัดระคน<input id="ttm-mixed-coordinate" placeholder="บันทึกเมื่อมีพิกัดระคน"></label>
          <label>ฤดูสมุฏฐาน 4<input id="ttm-season4" placeholder="แพทย์ยืนยัน"></label>
          <label>ฤดูสมุฏฐาน 6<input id="ttm-season6" placeholder="แพทย์ยืนยัน"></label>
          <label>ฤดูพิสดาร<input id="ttm-season-pitsadan" placeholder="แพทย์ยืนยัน"></label>
          <label>ราศีสมุฏฐาน<input id="ttm-zodiac" placeholder="แพทย์ยืนยัน"></label>
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px"><input type="checkbox" id="ttm-confirm" style="width:auto;margin-top:3px"><span>ข้าพเจ้าได้ตรวจข้อมูลสมุฏฐานและยืนยันการประเมินนี้ด้วยตนเอง</span></label>
        <div style="font-size:.82rem;color:#8a6420;margin-top:8px">รายการที่ถอดจากภาพและยังไม่ได้ lock ใน workbook จะแสดงเป็นข้อมูลช่วยทบทวนเท่านั้น ระบบจะไม่วินิจฉัยแทนแพทย์</div>
      </div>`;
    const summary = form.querySelector('#dx-mechanism')?.closest('label');
    form.insertBefore(box, summary || form.lastElementChild);

    let rules=[];
    const $=s=>box.querySelector(s);
    $('#ttm-load-rules').onclick = async () => {
      const r=await db.from('ttm_diagnostic_knowledge').select('*').eq('active',true).order('domain').order('rule_key');
      if(r.error){$('#ttm-rule-status').textContent='โหลดฐานความรู้ไม่ได้: '+r.error.message;return;}
      rules=r.data||[];
      const coords=rules.filter(x=>x.domain==='coordinate');
      $('#ttm-coordinate').innerHTML='<option value="">เลือกพิกัด</option>'+coords.map(x=>`<option value="${escapeHtml(x.input_key)}">${escapeHtml(x.input_key)} — ${escapeHtml(x.rule_key)}</option>`).join('');
      $('#ttm-coordinate-panel').style.display='block';
      $('#ttm-context-panel').style.display='grid';
      const pending=rules.filter(x=>x.review_status!=='approved').length;
      $('#ttm-rule-status').textContent=`โหลด ${rules.length} rules • ${pending} รายการยังต้อง practitioner review`;
    };
    $('#ttm-coordinate').onchange=()=>{
      const x=rules.find(r=>r.domain==='coordinate'&&r.input_key===$('#ttm-coordinate').value);
      $('#ttm-coordinate-desc').textContent=x ? `${x.output_value||''}${x.description?' — '+x.description:''} • ${x.review_status==='approved'?'Approved':'Review required'}` : '';
      if(x){const dh=document.querySelector('#dx-dhatu'); if(dh && !dh.value){const map={ไฟ:'เตโช',ลม:'วาโย',น้ำ:'อาโป',ดิน:'ปถวี'};dh.value=map[x.element]||'';}}
    };

    form.addEventListener('submit', async () => {
      try{
        const encounter=document.querySelector('#encounter')?.value;
        if(!encounter) return;
        const payload={
          encounter_id:encounter,
          birth_element:document.querySelector('#dx-birth')?.value||null,
          current_element:document.querySelector('#dx-present')?.value||null,
          ayu_samutthan:document.querySelector('#dx-age')?.value||null,
          kala_samutthan:document.querySelector('#dx-time')?.value||null,
          pradesa_samutthan:document.querySelector('#dx-place')?.value||null,
          dosha_state:$('#ttm-dosha-state').value||null,
          coordinate:$('#ttm-coordinate').value||null,
          mixed_coordinate:$('#ttm-mixed-coordinate').value||null,
          season_4:$('#ttm-season4').value||null,
          season_6:$('#ttm-season6').value||null,
          season_pitsadan:$('#ttm-season-pitsadan').value||null,
          zodiac_samutthan:$('#ttm-zodiac').value||null,
          practitioner_confirmed:$('#ttm-confirm').checked,
          confirmed_by:$('#ttm-confirm').checked?(await db.auth.getUser()).data.user?.id:null,
          confirmed_at:$('#ttm-confirm').checked?new Date().toISOString():null,
          knowledge_version:'TTM-DKR-v1'
        };
        await db.from('ttm_diagnostic_contexts').upsert(payload,{onConflict:'encounter_id'});
      }catch(e){console.warn('TTM context save',e);}
    }, true);
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
})();
