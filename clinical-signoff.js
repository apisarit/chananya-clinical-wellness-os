(() => {
  'use strict';
  const $ = (s, root=document) => root.querySelector(s);
  let db=null, session=null, profile=null, currentEncounter=null;

  async function waitRuntime(){for(let i=0;i<50;i++){if(window.ChananyaRuntime)return window.ChananyaRuntime;await new Promise(r=>setTimeout(r,100))}throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน')}
  const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function mount(){
    if($('#clinical-signoff-panel')) return;
    const main=$('main'); if(!main) return;
    const section=document.createElement('section');
    section.className='card'; section.id='clinical-signoff-panel';
    section.innerHTML=`<h2 class="section-title">Clinical Sign-off / Record Lock</h2>
      <p class="muted">ลงนามเมื่อการวินิจฉัยและการรักษาครบแล้ว หลังลงนาม เวชระเบียนส่วนคลินิกจะถูก Lock เพื่อป้องกันการแก้ไขโดยไม่ผ่านกระบวนการ amendment</p>
      <div id="signoff-status" class="status">เลือก Encounter เพื่อดูสถานะ</div>
      <form id="signoff-form" class="form" style="margin-top:12px">
        <label>ชื่อผู้ลงนาม<input id="signer-name"></label>
        <label>เลขใบประกอบวิชาชีพ<input id="license-no" placeholder="ถ้ามี"></label>
        <label class="full">เหตุผล/หมายเหตุ<input id="signoff-reason" value="Complete clinical record sign-off"></label>
        <button class="btn primary full" id="signoff-btn">ลงนามและ Lock เวชระเบียน</button>
      </form>`;
    main.appendChild(section);
    $('#signer-name').value=profile?.full_name||session?.user?.email||'';
    $('#signoff-form').addEventListener('submit',signAndLock);
  }

  async function loadStatus(){
    const box=$('#signoff-status'); if(!box) return;
    currentEncounter=$('#encounter')?.value||null;
    if(!currentEncounter){box.textContent='เลือก Encounter เพื่อดูสถานะ';setLockedUI(false);return}
    const {data,error}=await db.from('clinical_record_signoffs').select('signer_name,professional_license_no,signed_at,lock_record,reason').eq('encounter_id',currentEncounter).eq('record_section','complete_record').maybeSingle();
    if(error){box.textContent=`อ่านสถานะไม่ได้: ${error.message}`;return}
    if(!data){box.innerHTML='<b>ยังไม่ลงนาม</b><br><small>ต้องมี Diagnosis และ Treatment ก่อนจึงจะ Sign-off ได้</small>';setLockedUI(false);return}
    box.innerHTML=`<b>${data.lock_record?'SIGNED & LOCKED':'SIGNED • UNLOCKED FOR AMENDMENT'}</b><br>${esc(data.signer_name||'-')} • ${data.professional_license_no?`ใบประกอบ ${esc(data.professional_license_no)} • `:''}${new Date(data.signed_at).toLocaleString('th-TH')}<br><small>${esc(data.reason||'')}</small>`;
    setLockedUI(Boolean(data.lock_record));
  }

  function setLockedUI(locked){
    document.querySelectorAll('main form:not(#signoff-form) input,main form:not(#signoff-form) textarea,main form:not(#signoff-form) select,main form:not(#signoff-form) button').forEach(el=>el.disabled=locked);
    const encounter=$('#encounter'); if(encounter) encounter.disabled=false;
    const btn=$('#signoff-btn'); if(btn){btn.disabled=locked;btn.textContent=locked?'เวชระเบียนถูก Lock แล้ว':'ลงนามและ Lock เวชระเบียน'}
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
    }catch(err){console.error(err);alert(err.message||String(err));btn.disabled=false;btn.textContent=old}
  }

  async function init(){
    const R=await waitRuntime(); db=R.getDb(); session=await R.getSession(); if(!session) return;
    profile=await R.getProfile(session.user.id); mount();
    const encounter=$('#encounter'); if(encounter){encounter.addEventListener('change',()=>loadStatus().catch(console.error));}
    await loadStatus();
  }

  window.addEventListener('load',()=>init().catch(e=>console.error('Clinical sign-off extension failed',e)));
})();