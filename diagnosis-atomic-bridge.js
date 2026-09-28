(() => {
  'use strict';
  const runtime = window.ChananyaRuntime;
  if (!runtime) return;
  const $ = s => document.querySelector(s);

  const form = $('#diagnosis-form');
  if (form && window.ChananyaTTMContext) install(form);

  function install(form){
    if(form.dataset.atomicDiagnosis==='1') return;
    form.dataset.atomicDiagnosis='1';
    const db=runtime.getDb();
    let ready=false, blocked=false, pending=false, revision=0;
    const block=()=>{
      blocked=true;ready=false;revision++;form.inert=true;
      form.querySelectorAll('input,textarea,select').forEach(input=>{input.value='';input.checked=false;});
      const status=$('#diagnosis-status');if(status)status.textContent='บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่';
    };
    form.inert=true;
    runtime.getSession().then(session=>{
      if(blocked)return;
      if(!session?.user?.id){block();return;}
      const actor=session.user.id;
      db.auth.onAuthStateChange((event,next)=>{if(event==='SIGNED_OUT'||!next?.user?.id||next.user.id!==actor)block();});
      if(!blocked){ready=true;form.inert=false;}
    }).catch(()=>block());
    $('#encounter')?.addEventListener('change',()=>{revision++;});
    window.addEventListener('chananya:encounter-changed',()=>{revision++;});
    window.addEventListener('pagehide',event=>{if(event.persisted)block();});
    form.onsubmit=async event=>{
      event.preventDefault();
      if(!ready||blocked||pending)return;
      const encounter=$('#encounter')?.value;
      if(!encounter) return alert('กรุณาเลือก Encounter');
      const targetRevision=revision;
      const isCurrent=()=>!blocked&&revision===targetRevision&&encounter===$('#encounter')?.value;
      const causes=[...document.querySelectorAll('input[name="cause"]:checked')].map(x=>x.value);
      const ctx=window.ChananyaTTMContext.getValues();
      const payload={
        p_encounter_id:encounter,
        p_dhatu_samutthan:$('#dx-dhatu')?.value||null,
        p_utu_samutthan:$('#dx-utu')?.value||null,
        p_ayu_samutthan:$('#dx-age')?.value||null,
        p_kala_samutthan:$('#dx-time')?.value||null,
        p_pradesa_samutthan:$('#dx-place')?.value||null,
        p_birth_constitution:$('#dx-birth')?.value||null,
        p_present_constitution:$('#dx-present')?.value||null,
        p_disease_causes:causes,
        p_symptom_mechanism:$('#dx-mechanism')?.value||null,
        p_analysis_summary:$('#dx-summary')?.value||null,
        p_thai_diagnosis:$('#dx-thai')?.value||null,
        p_differential_diagnosis:$('#dx-differential')?.value||null,
        p_diagnostic_confidence:$('#dx-confidence')?.value||null,
        p_dosha_state:ctx.dosha_state,
        p_coordinate:ctx.coordinate,
        p_mixed_coordinate:ctx.mixed_coordinate,
        p_season_4:ctx.season_4,
        p_season_6:ctx.season_6,
        p_season_pitsadan:ctx.season_pitsadan,
        p_zodiac_samutthan:ctx.zodiac_samutthan,
        p_practitioner_confirmed:ctx.practitioner_confirmed,
        p_knowledge_version:ctx.knowledge_version
      };
      const button=form.querySelector('button[type="submit"],button:not([type])');
      const oldText=button?.textContent;
      pending=true;
      if(button){button.disabled=true;button.textContent='กำลังบันทึก...';}
      try{
        const {error}=await db.rpc('save_ttm_diagnosis_atomic',payload);
        if(!isCurrent())return;
        if(error) throw error;
        const status=$('#diagnosis-status');
        if(status) status.innerHTML=`<b>${escapeHtml(payload.p_thai_diagnosis)}</b><br>${escapeHtml(payload.p_analysis_summary)}<br><small>บันทึก Diagnosis + สมุฏฐานแบบ Atomic แล้ว</small>`;
        if(window.dispatchEvent) window.dispatchEvent(new CustomEvent('chananya:diagnosis-saved',{detail:{encounterId:encounter}}));
      }catch(error){
        if(!isCurrent())return;
        console.error('Atomic diagnosis save failed',error);
        alert(error.message||String(error));
      }finally{
        pending=false;
        if(button&&!blocked){button.disabled=false;button.textContent=oldText||'บันทึก/อัปเดตการวินิจฉัย';}
      }
    };
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
})();
