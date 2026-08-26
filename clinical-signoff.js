(() => {
  'use strict';
  const $ = (s, root=document) => root.querySelector(s);
  let db=null, session=null, profile=null, currentEncounter=null, locked=false;

  async function waitRuntime(){for(let i=0;i<50;i++){if(window.ChananyaRuntime)return window.ChananyaRuntime;await new Promise(r=>setTimeout(r,100))}throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน')}
  const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function mount(){
    const section=$('#clinical-signoff-panel');
    const form=$('#signoff-form');
    if(!section||!form) return false;
    $('#signer-name').value=profile?.full_name||session?.user?.email||'';
    if(form.dataset.signoffBound!=='1'){
      form.dataset.signoffBound='1';
      form.addEventListener('submit',signAndLock);
    }
    return true;
  }

  async function loadStatus(){
    const box=$('#signoff-status'); if(!box) return;
    currentEncounter=$('#encounter')?.value||null;
    if(!currentEncounter){box.textContent='เลือก Encounter เพื่อดูสถานะ';setLockedUI(false);return}
    const {data,error}=await db.from('clinical_record_signoffs').select('signer_name,professional_license_no,signed_at,lock_record,reason').eq('encounter_id',currentEncounter).eq('record_section','complete_record').maybeSingle();
    if(error){box.textContent=`อ่านสถานะไม่ได้: ${friendlyError(error)}`;setLockedUI(true);return}
    if(!data){box.innerHTML='<b>ยังไม่ลงนาม</b><br><small>ต้องมี Diagnosis และ Treatment ก่อนจึงจะ Sign-off ได้</small>';setLockedUI(false);return}
    box.innerHTML=`<b>${data.lock_record?'SIGNED & LOCKED':'SIGNED • UNLOCKED FOR AMENDMENT'}</b><br>${esc(data.signer_name||'-')} • ${data.professional_license_no?`ใบประกอบ ${esc(data.professional_license_no)} • `:''}${new Date(data.signed_at).toLocaleString('th-TH')}<br><small>${esc(data.reason||'')}</small>`;
    setLockedUI(Boolean(data.lock_record));
  }

  function setLockedUI(isLocked){
    locked=Boolean(isLocked);
    const fields=$('#clinical-record-fields');
    if(fields){fields.inert=locked;fields.setAttribute('aria-disabled',String(locked))}
    const btn=$('#signoff-btn'); if(btn){btn.disabled=locked;btn.textContent=locked?'เวชระเบียนถูก Lock แล้ว':'ลงนามและ Lock เวชระเบียน'}
    window.dispatchEvent(new CustomEvent('chananya:signoff-changed',{detail:{encounterId:currentEncounter,locked}}));
  }

  function friendlyError(error){
    const message=error?.message||String(error);
    const known={
      DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF:'ต้องบันทึก Diagnosis ก่อนลงนาม',
      TREATMENT_REQUIRED_BEFORE_SIGNOFF:'ต้องมี Treatment Plan หรือ Treatment Session ก่อนลงนาม',
      CLINICAL_RECORD_LOCKED:'เวชระเบียนนี้ถูก Lock แล้ว',
      PERMISSION_DENIED:'บัญชีนี้ไม่มีสิทธิ์ลงนามเวชระเบียน',
      AUTH_REQUIRED:'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่'
    };
    const code=Object.keys(known).find(key=>message.includes(key));
    return code?known[code]:message;
  }

  async function signAndLock(e){
    e.preventDefault();
    currentEncounter=$('#encounter')?.value||null;
    if(!currentEncounter) return alert('กรุณาเลือก Encounter');
    if(!confirm('ยืนยันลงนามและ Lock เวชระเบียนนี้? หลังจากนี้การแก้ไขต้องผ่าน Amendment')) return;
    const btn=$('#signoff-btn'); const old=btn.textContent; btn.disabled=true; btn.textContent='กำลังลงนาม...';
    try{
      const {error}=await db.rpc('sign_clinical_record_complete',{
        p_encounter_id:currentEncounter,
        p_signer_name:$('#signer-name').value.trim()||null,
        p_license_no:$('#license-no').value.trim()||null,
        p_reason:$('#signoff-reason').value.trim()||'Complete clinical record sign-off'
      });
      if(error) throw error;
      await loadStatus();
      alert('ลงนามและ Lock เวชระเบียนสำเร็จ');
    }catch(err){console.error(err);alert(friendlyError(err));btn.disabled=false;btn.textContent=old}
  }

  async function init(){
    const R=await waitRuntime(); db=R.getDb(); session=await R.getSession(); if(!session) return;
    profile=await R.getProfile(session.user.id); mount();
    const encounter=$('#encounter'); if(encounter){encounter.addEventListener('change',()=>loadStatus().catch(console.error));}
    await loadStatus();
  }

  const start=()=>init().catch(e=>console.error('Clinical sign-off extension failed',e));
  if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
})();
