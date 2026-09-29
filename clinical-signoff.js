(() => {
  'use strict';
  const $ = (s, root=document) => root.querySelector(s);
  let db=null, session=null, profile=null, currentEncounter=null, locked=false;
  let statusRevision=0;
  let accountBlocked=false;
  const pendingSignoffs=new Set();

  function blockAccount(){
    if(accountBlocked)return;
    accountBlocked=true;statusRevision++;currentEncounter=null;
    setLockedUI(true,false);
    for(const selector of ['#signer-name','#license-no','#signoff-reason']){
      const input=$(selector);if(input)input.value='';
    }
    const form=$('#signoff-form');if(form)form.inert=true;
    const status=$('#signoff-status');if(status)status.textContent='บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่';
  }

  async function waitRuntime(){for(let i=0;i<50;i++){if(window.ChananyaRuntime)return window.ChananyaRuntime;await new Promise(r=>setTimeout(r,100))}throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน')}
  const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function mount(){
    if(accountBlocked)return false;
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
    if(accountBlocked)return false;
    const box=$('#signoff-status'); if(!box) return;
    currentEncounter=$('#encounter')?.value||null;
    const target=currentEncounter, revision=++statusRevision;
    if(!target){box.textContent='เลือก Encounter เพื่อดูสถานะ';setLockedUI(true,false);return false}
    box.textContent='กำลังตรวจสถานะการลงนาม';setLockedUI(true,false);
    let result;
    try { result=await db.from('clinical_record_signoffs').select('signer_name,professional_license_no,signed_at,lock_record,reason').eq('encounter_id',target).eq('record_section','complete_record').maybeSingle(); }
    catch(error){result={error};}
    if(accountBlocked || revision!==statusRevision || target!==($('#encounter')?.value||null)) return false;
    const {data,error}=result;
    if(error){box.textContent=`อ่านสถานะไม่ได้: ${friendlyError(error)}`;setLockedUI(true,false);return false}
    if(!data){box.innerHTML='<b>ยังไม่ลงนาม</b><br><small>ต้องมี Diagnosis และ Treatment ก่อนจึงจะ Sign-off ได้</small>';setLockedUI(false);return false}
    box.innerHTML=`<b>${data.lock_record?'SIGNED & LOCKED':'SIGNED • UNLOCKED FOR AMENDMENT'}</b><br>${esc(data.signer_name||'-')} • ${data.professional_license_no?`ใบประกอบ ${esc(data.professional_license_no)} • `:''}${new Date(data.signed_at).toLocaleString('th-TH')}<br><small>${esc(data.reason||'')}</small>`;
    setLockedUI(Boolean(data.lock_record));
    return Boolean(data.lock_record);
  }

  function setLockedUI(isLocked,publish=true){
    locked=Boolean(isLocked);
    const fields=$('#clinical-record-fields');
    if(fields){fields.inert=locked;fields.setAttribute('aria-disabled',String(locked))}
    const btn=$('#signoff-btn'); if(btn){btn.disabled=locked;btn.textContent=!publish?'ต้องยืนยันสถานะเวชระเบียนก่อน':locked?'เวชระเบียนถูก Lock แล้ว':'ลงนามและ Lock เวชระเบียน'}
    if(publish) window.dispatchEvent(new CustomEvent('chananya:signoff-changed',{detail:{encounterId:currentEncounter,locked}}));
  }

  function friendlyError(error){
    const message=error?.message||String(error);
    const known={
      DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF:'ต้องบันทึก Diagnosis ก่อนลงนาม',
      TREATMENT_REQUIRED_BEFORE_SIGNOFF:'ต้องมี Treatment Plan หรือ Treatment Session ก่อนลงนาม',
      CLINICAL_RECORD_LOCKED:'เวชระเบียนนี้ถูก Lock แล้ว',
      PERMISSION_DENIED:'บัญชีนี้ไม่มีสิทธิ์ลงนามเวชระเบียน',
      ENCOUNTER_PRACTITIONER_MISMATCH:'เวชระเบียนนี้อยู่ในความรับผิดชอบของผู้ให้บริการท่านอื่น กรุณาให้ผู้รับผิดชอบเคสลงนาม',
      ENCOUNTER_NOT_FOUND:'ไม่พบเวชระเบียนในคลินิกที่คุณเข้าถึงได้ กรุณากลับไปเลือกรายการรับบริการ',
      CNYOS_SUBSCRIPTION_SUSPENDED:'ไม่สามารถใช้สิทธิ์ในคลินิกนี้ได้ กรุณาติดต่อผู้ดูแลเพื่อตรวจสอบสถานะบัญชีและคลินิก',
      AUTH_REQUIRED:'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่'
    };
    const code=Object.keys(known).find(key=>message.includes(key));
    return code?known[code]:message;
  }

  async function signAndLock(e){
    e.preventDefault();
    if(accountBlocked)return;
    currentEncounter=$('#encounter')?.value||null;
    if(!currentEncounter) return alert('กรุณาเลือก Encounter');
    const target=currentEncounter;
    if(locked || pendingSignoffs.has(target)) return;
    if(!confirm('ยืนยันลงนามและ Lock เวชระเบียนนี้? หลังจากนี้การแก้ไขต้องผ่าน Amendment')) return;
    const btn=$('#signoff-btn'); btn.disabled=true; btn.textContent='กำลังลงนาม...';
    pendingSignoffs.add(target);
    try{
      const {error}=await db.rpc('sign_clinical_record_complete',{
        p_encounter_id:target,
        p_signer_name:$('#signer-name').value.trim()||null,
        p_license_no:$('#license-no').value.trim()||null,
        p_reason:$('#signoff-reason').value.trim()||'Complete clinical record sign-off'
      });
      if(accountBlocked)return;
      if(error) throw error;
      if(target!==($('#encounter')?.value||null)) return;
      const verified=await loadStatus();
      if(accountBlocked)return;
      if(target!==($('#encounter')?.value||null)) return;
      alert(verified?'ลงนามและ Lock เวชระเบียนสำเร็จ':'ส่งคำขอลงนามแล้ว แต่ยังยืนยันสถานะกลับไม่ได้ กรุณาโหลดสถานะใหม่ก่อนดำเนินการต่อ');
    }catch(err){
      if(!accountBlocked && target===($('#encounter')?.value||null)){
        alert(friendlyError(err));
        await loadStatus();
      }
    }finally{pendingSignoffs.delete(target)}
  }

  async function init(){
    const R=await waitRuntime(); db=R.getDb(); session=await R.getSession(); if(!session) return;
    const originalActor=session.user.id;
    db.auth.onAuthStateChange((event,nextSession)=>{
      if(event==='SIGNED_OUT'||!nextSession?.user?.id||nextSession.user.id!==originalActor)blockAccount();
    });
    if(accountBlocked)return;
    profile=await R.getProfile(session.user.id);if(accountBlocked)return;mount();
    const encounter=$('#encounter'); if(encounter){encounter.addEventListener('change',()=>loadStatus().catch(console.error));}
    await loadStatus();
  }

  const start=()=>init().catch(e=>console.error('Clinical sign-off extension failed',e));
  window.addEventListener('pagehide',event=>{if(event.persisted)blockAccount();});
  if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
})();
