(() => {
  'use strict';

  const R = window.ChananyaRuntime;
  if (!R) return;

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const VIEW_NAMES = { front:'ด้านหน้า', back:'ด้านหลัง', left:'ด้านซ้าย', right:'ด้านขวา' };
  const STAGE_NAMES = { before:'ก่อนรักษา', after:'หลังรักษา', followup:'ติดตามผล' };
  const TYPE_NAMES = { pain:'ปวด', numbness:'ชา', tightness:'ตึง', burning:'แสบร้อน', swelling:'บวม', weakness:'อ่อนแรง', other:'อื่น ๆ' };

  let db, session, currentEncounter = null, points = [], draft = null, editingId = null;

  function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function codeFor(p){
    const sen=(p.sen_line_code||'S.00').replace(/\s+/g,'');
    const region=(p.body_region||'GEN').toUpperCase().replace(/\s+/g,'-').slice(0,10);
    const side=({left:'L',right:'R',bilateral:'B',midline:'M'}[p.side]||'N');
    const score=p.pain_score==null?'PX':`P${String(p.pain_score).padStart(2,'0')}`;
    return `${sen}-${region}-${side}-${score}`;
  }

  function addStyle(){
    if ($('#bodymap-style-v31')) return;
    const s=document.createElement('style'); s.id='bodymap-style-v31'; s.textContent=`
      #bodymap-v31{margin-top:12px}.bm-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.bm-grid .full{grid-column:1/-1}
      .bm-grid input,.bm-grid select{width:100%;min-width:0;box-sizing:border-box}.bm-shell{border:1px solid #d9e3dd;border-radius:14px;padding:10px;background:#fff}
      .bm-labels{display:grid;grid-template-columns:repeat(4,1fr);text-align:center;font-weight:700;font-size:.9rem}.bm-canvas{position:relative;width:100%;aspect-ratio:800/380;cursor:crosshair;touch-action:manipulation}
      .bm-canvas img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}.bm-layer{position:absolute;inset:0;pointer-events:none}.bm-marker{position:absolute;transform:translate(-50%,-50%);width:24px;height:24px;border-radius:50%;border:3px solid white;background:#a64b2a;color:white;font-weight:800;font-size:10px;pointer-events:auto;cursor:pointer;box-shadow:0 1px 5px #0004}
      .bm-marker.after{background:white;color:#a64b2a;border-color:#a64b2a}.bm-draft{position:absolute;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;border:3px dashed #173f31;background:#173f3120}.bm-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.bm-status{padding:10px;border-radius:10px;background:#edf5f1;margin:8px 0}.bm-row{display:flex;justify-content:space-between;gap:12px;padding:10px;border-bottom:1px solid #e5e9e6}.bm-row small{display:block}.bm-code{font-family:ui-monospace,monospace}
      @media(max-width:900px){.bm-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.bm-grid{grid-template-columns:1fr}.bm-labels{font-size:.72rem}}
      @media print{.v3nav,.top,.bm-grid,.bm-actions,#bm-status,.bm-row button{display:none!important}.bm-shell{border:0}}
    `; document.head.appendChild(s);
  }

  function template(){return `
    <div id="bodymap-v31">
      <h3>Interactive Pain Map / Sen Code</h3>
      <p class="muted">แตะบนร่างกายเพื่อบันทึกตำแหน่งอาการ โดยข้อมูลจะผูกกับ Encounter เดิมโดยตรง</p>
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
        <div class="bm-canvas" id="bm-canvas"><img src="/bodymap-figures.svg?v=1" alt="Body pain map"><div class="bm-layer" id="bm-layer"></div></div>
      </div>
      <div id="bm-status" class="bm-status">แตะบนร่างกายเพื่อเลือกตำแหน่ง</div>
      <div class="bm-actions"><button type="button" class="btn primary" id="bm-save">บันทึกจุด</button><button type="button" class="btn ghost" id="bm-cancel">ยกเลิก</button><button type="button" class="btn ghost" id="bm-print">พิมพ์ Pain Map</button></div>
      <div id="bm-list"></div>
    </div>`;}

  async function install(){
    const oldForm=$('#pain-form'); const section=oldForm?.closest('section.card');
    if(!section || $('#bodymap-v31')) return false;
    addStyle();
    oldForm.hidden=true;
    const legacyList=$('#pain-list',section); if(legacyList) legacyList.hidden=true;
    section.insertAdjacentHTML('beforeend',template());
    $('#bm-canvas').addEventListener('click',onCanvasClick);
    $('#bm-save').addEventListener('click',()=>save().catch(showError));
    $('#bm-cancel').addEventListener('click',reset);
    $('#bm-print').addEventListener('click',()=>window.print());
    const enc=$('#encounter'); currentEncounter=enc?.value||null;
    enc?.addEventListener('change',()=>{currentEncounter=enc.value||null;reset();load().catch(showError);});
    await load(); return true;
  }

  function onCanvasClick(e){
    if(!currentEncounter) return alert('กรุณาเลือก Encounter ก่อน');
    if(e.target.closest('.bm-marker')) return;
    const rect=$('#bm-canvas').getBoundingClientRect(); const gx=((e.clientX-rect.left)/rect.width)*100; const y=((e.clientY-rect.top)/rect.height)*100;
    const idx=Math.min(3,Math.max(0,Math.floor(gx/25))); const view=['front','back','left','right'][idx]; const x=(gx-idx*25)*4;
    draft={body_view:view,x_percent:+x.toFixed(2),y_percent:+Math.max(0,Math.min(100,y)).toFixed(2)};
    $('#bm-view').value=VIEW_NAMES[view]; if(view==='left')$('#bm-side').value='left'; if(view==='right')$('#bm-side').value='right';
    $('#bm-status').textContent=`เลือก ${VIEW_NAMES[view]} X ${draft.x_percent}% / Y ${draft.y_percent}%`; render();
  }

  function pos(p){const i={front:0,back:1,left:2,right:3}[p.body_view]??0;return {left:i*25+Number(p.x_percent)/4,top:Number(p.y_percent)}}
  function render(){
    const layer=$('#bm-layer'); if(!layer)return;
    layer.innerHTML=points.map(p=>{const q=pos(p);return `<button type="button" class="bm-marker ${p.assessment_stage==='after'?'after':''}" data-id="${p.id}" style="left:${q.left}%;top:${q.top}%" title="${esc(codeFor(p))}">${p.pain_score??''}</button>`}).join('')+(draft?(()=>{const q=pos(draft);return `<span class="bm-draft" style="left:${q.left}%;top:${q.top}%"></span>`})():'');
    $$('[data-id]',layer).forEach(b=>b.onclick=e=>{e.stopPropagation();edit(b.dataset.id)});
    $('#bm-list').innerHTML=points.map(p=>`<div class="bm-row"><div><b>${esc(STAGE_NAMES[p.assessment_stage]||p.assessment_stage)} • ${esc(TYPE_NAMES[p.symptom_type]||p.symptom_type)} ${p.pain_score==null?'':`(${p.pain_score}/10)`}</b><small>${esc(p.body_region||'ไม่ระบุบริเวณ')} • ${esc(p.side||'')} • ${esc(p.sen_line_code||'')}</small><small class="bm-code">${esc(p.pain_pattern_code||codeFor(p))}</small></div><div><button type="button" class="btn ghost" data-edit="${p.id}">แก้</button> <button type="button" class="btn ghost" data-del="${p.id}">ลบ</button></div></div>`).join('')||'<p class="muted">ยังไม่มีจุดปวด</p>';
    $$('[data-edit]').forEach(b=>b.onclick=()=>edit(b.dataset.edit)); $$('[data-del]').forEach(b=>b.onclick=()=>remove(b.dataset.del));
  }

  async function load(){
    if(!currentEncounter){points=[];render();return;}
    const {data,error}=await db.from('body_pain_points').select('*').eq('encounter_id',currentEncounter).order('recorded_at'); if(error)throw error; points=data||[];render();
  }
  function edit(id){const p=points.find(x=>x.id===id);if(!p)return;editingId=id;draft={body_view:p.body_view,x_percent:p.x_percent,y_percent:p.y_percent};$('#bm-stage').value=p.assessment_stage;$('#bm-type').value=p.symptom_type;$('#bm-score').value=p.pain_score??'';$('#bm-side').value=p.side||'not_specified';$('#bm-region').value=p.body_region||'';$('#bm-sen').value=p.sen_line_code||'';$('#bm-label').value=p.point_label||'';$('#bm-notes').value=p.notes||'';$('#bm-view').value=VIEW_NAMES[p.body_view]||'';render();}
  function reset(){editingId=null;draft=null;['#bm-score','#bm-region','#bm-sen','#bm-label','#bm-notes','#bm-view'].forEach(id=>{const e=$(id);if(e)e.value=''});const st=$('#bm-status');if(st)st.textContent='แตะบนร่างกายเพื่อเลือกตำแหน่ง';render();}
  async function save(){
    if(!currentEncounter)throw new Error('กรุณาเลือก Encounter'); if(!draft)throw new Error('กรุณาแตะตำแหน่งบนร่างกาย');
    const payload={encounter_id:currentEncounter,assessment_stage:$('#bm-stage').value,body_view:draft.body_view,x_percent:draft.x_percent,y_percent:draft.y_percent,symptom_type:$('#bm-type').value,pain_score:$('#bm-score').value===''?null:Number($('#bm-score').value),side:$('#bm-side').value,body_region:$('#bm-region').value||null,sen_line_code:$('#bm-sen').value||null,point_label:$('#bm-label').value||null,notes:$('#bm-notes').value||null,updated_at:new Date().toISOString()};payload.pain_pattern_code=codeFor(payload);
    let r;if(editingId)r=await db.from('body_pain_points').update(payload).eq('id',editingId);else{payload.recorded_by=session.user.id;r=await db.from('body_pain_points').insert(payload)} if(r.error)throw r.error;reset();await load();
  }
  async function remove(id){if(!confirm('ยืนยันลบจุดนี้?'))return;const r=await db.from('body_pain_points').delete().eq('id',id);if(r.error)return showError(r.error);await load();}
  function showError(e){console.error(e);alert(e?.message||String(e));}

  async function init(){
    try{db=R.getDb();session=await R.getSession();if(!session)return; if(!await install()){const t=setInterval(async()=>{if(await install())clearInterval(t)},250);setTimeout(()=>clearInterval(t),10000)}}catch(e){showError(e)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
