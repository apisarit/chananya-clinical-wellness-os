(() => {
  'use strict';
  const cfg = window.CHANANYA_AUTH;
  if (!cfg || !window.supabase) return;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const $ = s => document.querySelector(s);
  let db, user, currentEncounter = null;

  function style(){
    if ($('#opd-workflow-style')) return;
    const s=document.createElement('style'); s.id='opd-workflow-style';
    s.textContent=`
      .opd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.opd-grid .full{grid-column:1/-1}
      .opd-chipgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.opd-chipgrid label{display:flex;gap:8px;align-items:center;padding:10px;background:#f4f7f5;border-radius:10px;min-width:0}
      .opd-actions{display:flex;gap:10px;flex-wrap:wrap}.opd-session{border:1px solid #dfe7e2;border-radius:12px;padding:12px;margin:10px 0;background:#fff}.opd-session strong{color:#174c3a}
      @media(max-width:900px){.opd-grid,.opd-chipgrid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(s);
  }

  function historySection(){
    const section=document.createElement('section'); section.className='card'; section.id='opd-history-section';
    section.innerHTML=`
      <h2 class="section-title">0. OPD History / ประวัติส่วนตัว</h2>
      <p class="muted">Snapshot ของประวัติใน Encounter นี้ ตามแบบ OPD เวชกรรมไทยฉบับแก้ไข 7-8-69</p>
      <form id="opd-history-form" class="opd-grid">
        <label class="full">ประวัติอุบัติเหตุ<textarea id="opd-accident"></textarea></label>
        <label class="full">ประวัติผ่าตัด<textarea id="opd-surgery"></textarea></label>
        <label class="full">โรคประจำตัว<textarea id="opd-chronic"></textarea></label>
        <label class="full">ประวัติครอบครัว<textarea id="opd-family"></textarea></label>
        <label class="full">ประวัติส่วนตัว<textarea id="opd-personal"></textarea></label>
        <label>อาหาร<input id="opd-food"></label>
        <label>น้ำ (แก้ว/วัน)<input id="opd-water" type="number" min="0" step="0.5"></label>
        <label>ชา/กาแฟ (แก้ว/วัน)<input id="opd-coffee" type="number" min="0" step="0.5"></label>
        <label>บุหรี่<input id="opd-smoking" placeholder="ไม่สูบ / จำนวนมวนต่อวัน"></label>
        <label>แอลกอฮอล์<input id="opd-alcohol"></label>
        <label>ปัสสาวะ (ครั้ง/วัน)<input id="opd-urination" type="number" min="0" step="0.5"></label>
        <label>อุจจาระ (ครั้ง/วัน)<input id="opd-bowel" type="number" min="0" step="0.5"></label>
        <label>การนอน<input id="opd-sleep"></label>
        <label>อิริยาบถ<input id="opd-posture"></label>
        <label>อารมณ์<input id="opd-emotion"></label>
        <label>การแพ้ยา/อาหาร<input id="opd-allergy"></label>
        <label>ประจำเดือน<input id="opd-menstruation"></label>
        <label class="full">ยา / อาหารเสริมที่ใช้อยู่<textarea id="opd-meds"></textarea></label>
        <label class="full">ตรวจร่างกายเพิ่มเติม / Narrative<textarea id="opd-physical"></textarea></label>
        <button class="btn primary full" type="submit">บันทึก OPD History</button>
      </form><div id="opd-history-status" class="status">เลือก Encounter ก่อน</div>`;
    return section;
  }

  function sessionSection(){
    const section=document.createElement('section'); section.className='card'; section.id='opd-session-section';
    section.innerHTML=`
      <h2 class="section-title">Treatment Session & Outcome</h2>
      <form id="opd-session-form" class="opd-grid">
        <div class="full opd-chipgrid">
          ${['นวดไทย','ประคบสมุนไพร','อบสมุนไพร','ยาสมุนไพร','หัตถการอื่น'].map((x,i)=>`<label><input type="checkbox" name="opd-modality" value="${x}">${x}</label>`).join('')}
        </div>
        <label>ความปวดก่อนรักษา 0–10<input id="opd-pain-before" type="number" min="0" max="10"></label>
        <label>ความปวดหลังรักษา 0–10<input id="opd-pain-after" type="number" min="0" max="10"></label>
        <label class="full">วิธีการรักษา / รายละเอียด<textarea id="opd-treatment-detail" required></textarea></label>
        <label class="full"><input id="opd-procedure-referral" type="checkbox"> ส่งหัตถการ / ส่งต่อ Procedure</label>
        <label class="full">รายละเอียดการส่งหัตถการ<input id="opd-procedure-detail"></label>
        <label class="full">ข้อควรระวัง<textarea id="opd-precautions"></textarea></label>
        <label class="full">สรุปผลหลังรักษา<textarea id="opd-outcome"></textarea></label>
        <label class="full">คำแนะนำ<textarea id="opd-advice"></textarea></label>
        <button class="btn primary full" type="submit">บันทึก Treatment Session</button>
      </form>
      <div class="opd-actions"><a class="btn ghost" href="/">ไป Doctor / Prescription</a><a class="btn ghost" href="/pharmacy.html">ไป Pharmacy</a></div>
      <div id="opd-session-list"></div>`;
    return section;
  }

  function inject(){
    if ($('#opd-history-section')) return true;
    const main=$('main'), encounterCard=$('#encounter')?.closest('section');
    if(!main||!encounterCard) return false;
    encounterCard.insertAdjacentElement('afterend', historySection());
    const plan=$('#plan-form')?.closest('section');
    if(plan) plan.insertAdjacentElement('afterend', sessionSection()); else main.appendChild(sessionSection());
    bind();
    return true;
  }

  const val=id=>$(id)?.value || null;
  const num=id=>{const v=$(id)?.value; return v===''||v==null?null:Number(v)};
  const set=(id,v)=>{const e=$(id); if(e) e.value=v??''};

  async function loadHistory(){
    if(!currentEncounter) return;
    const {data,error}=await db.from('ttm_opd_histories').select('*').eq('encounter_id',currentEncounter).maybeSingle();
    if(error){$('#opd-history-status').textContent='ยังไม่ได้ Run OPD workflow SQL หรือไม่มีสิทธิ์'; return;}
    const d=data||{};
    set('#opd-accident',d.accident_history);set('#opd-surgery',d.surgery_history);set('#opd-chronic',d.chronic_diseases);set('#opd-family',d.family_history);set('#opd-personal',d.personal_history);
    set('#opd-food',d.food_pattern);set('#opd-water',d.water_glasses_per_day);set('#opd-coffee',d.tea_coffee_glasses_per_day);set('#opd-smoking',d.smoking_detail);set('#opd-alcohol',d.alcohol_detail);
    set('#opd-urination',d.urination_per_day);set('#opd-bowel',d.bowel_movement_per_day);set('#opd-sleep',d.sleep_detail);set('#opd-posture',d.posture_detail);set('#opd-emotion',d.emotional_state);
    set('#opd-allergy',d.allergy_food_drug);set('#opd-menstruation',d.menstruation_detail);set('#opd-meds',d.current_medicines_supplements);set('#opd-physical',d.physical_exam_narrative);
    $('#opd-history-status').textContent=data?'โหลด OPD History แล้ว':'ยังไม่มี OPD History ใน Encounter นี้';
  }

  async function saveHistory(ev){
    ev.preventDefault(); if(!currentEncounter) return alert('เลือก Encounter ก่อน');
    const payload={encounter_id:currentEncounter,accident_history:val('#opd-accident'),surgery_history:val('#opd-surgery'),chronic_diseases:val('#opd-chronic'),family_history:val('#opd-family'),personal_history:val('#opd-personal'),food_pattern:val('#opd-food'),water_glasses_per_day:num('#opd-water'),tea_coffee_glasses_per_day:num('#opd-coffee'),smoking_detail:val('#opd-smoking'),alcohol_detail:val('#opd-alcohol'),urination_per_day:num('#opd-urination'),bowel_movement_per_day:num('#opd-bowel'),sleep_detail:val('#opd-sleep'),posture_detail:val('#opd-posture'),emotional_state:val('#opd-emotion'),allergy_food_drug:val('#opd-allergy'),menstruation_detail:val('#opd-menstruation'),current_medicines_supplements:val('#opd-meds'),physical_exam_narrative:val('#opd-physical'),updated_by:user.id,updated_at:new Date().toISOString()};
    const {data:existing}=await db.from('ttm_opd_histories').select('id').eq('encounter_id',currentEncounter).maybeSingle(); if(!existing) payload.created_by=user.id;
    const {error}=await db.from('ttm_opd_histories').upsert(payload,{onConflict:'encounter_id'}); if(error) return alert(error.message);
    $('#opd-history-status').textContent='บันทึก OPD History แล้ว';
  }

  async function loadSessions(){
    const box=$('#opd-session-list'); if(!box||!currentEncounter) return;
    const {data,error}=await db.from('clinical_treatment_sessions').select('*').eq('encounter_id',currentEncounter).order('session_no');
    if(error){box.innerHTML='<div class="status danger">ยังไม่ได้ Run OPD workflow SQL หรือไม่มีสิทธิ์</div>';return;}
    box.innerHTML=(data||[]).length?(data||[]).map(s=>`<div class="opd-session"><strong>Session ${s.session_no}</strong> · ${esc(new Date(s.treated_at).toLocaleString('th-TH'))}<br>${esc((s.treatment_modalities||[]).join(', '))}<br>${esc(s.treatment_detail)}<br><b>Pain:</b> ${esc(s.pain_before??'-')} → ${esc(s.pain_after??'-')}<br><b>Outcome:</b> ${esc(s.outcome_summary||'-')}</div>`).join(''):'<div class="status">ยังไม่มี Treatment Session</div>';
  }

  async function saveSession(ev){
    ev.preventDefault(); if(!currentEncounter) return alert('เลือก Encounter ก่อน');
    const {data:last}=await db.from('clinical_treatment_sessions').select('session_no').eq('encounter_id',currentEncounter).order('session_no',{ascending:false}).limit(1);
    const sessionNo=(last?.[0]?.session_no||0)+1;
    const modalities=[...document.querySelectorAll('input[name="opd-modality"]:checked')].map(x=>x.value);
    const payload={encounter_id:currentEncounter,session_no:sessionNo,treatment_modalities:modalities,treatment_detail:val('#opd-treatment-detail'),procedure_referral:$('#opd-procedure-referral').checked,procedure_referral_detail:val('#opd-procedure-detail'),precautions:val('#opd-precautions'),pain_before:num('#opd-pain-before'),pain_after:num('#opd-pain-after'),outcome_summary:val('#opd-outcome'),advice:val('#opd-advice'),practitioner_id:user.id};
    const {error}=await db.from('clinical_treatment_sessions').insert(payload); if(error) return alert(error.message);
    ev.target.reset(); await loadSessions();
  }

  function bind(){
    $('#opd-history-form')?.addEventListener('submit',saveHistory);
    $('#opd-session-form')?.addEventListener('submit',saveSession);
    const encounter=$('#encounter'); if(encounter){encounter.addEventListener('change',async()=>{currentEncounter=encounter.value||null;await loadHistory();await loadSessions();});currentEncounter=encounter.value||null;}
  }

  async function init(){
    style(); db=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true}});
    const {data:{session}}=await db.auth.getSession(); if(!session) return; user=session.user;
    if(!inject()){const timer=setInterval(()=>{if(inject())clearInterval(timer)},250);setTimeout(()=>clearInterval(timer),10000)}
    setTimeout(async()=>{const e=$('#encounter');currentEncounter=e?.value||null;if(currentEncounter){await loadHistory();await loadSessions();}},700);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
