(()=>{
'use strict';
const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let db=null, session=null, editingPatientId=null, rxCart=[];

async function initClient(){
  for(let i=0;i<50&&!window.ChananyaRuntime;i++)await new Promise(resolve=>setTimeout(resolve,100));
  if(!window.ChananyaRuntime)return;
  db=window.ChananyaRuntime.getDb();
  session=await window.ChananyaRuntime.getSession();
}
function toast(t){const e=$('#toast');if(!e)return; e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2400)}
function fail(e){console.error(e);alert(e?.message||String(e))}

function installPatientEditing(){
  const form=$('#patient-form'), list=$('#patient-list'); if(!form||!list)return;
  const submit=form.querySelector('button[type="submit"],button:not([type])');
  const cancel=document.createElement('button');cancel.type='button';cancel.className='btn ghost full';cancel.textContent='ยกเลิกการแก้ไข';cancel.style.display='none';form.appendChild(cancel);
  cancel.onclick=()=>{editingPatientId=null;form.reset();cancel.style.display='none';if(submit)submit.textContent='บันทึกผู้รับบริการ'};

  new MutationObserver(async()=>{
    if(!db)return;
    const r=await db.from('patients').select('*'); if(r.error)return;
    [...list.querySelectorAll('.item')].forEach(row=>{
      if(row.querySelector('[data-edit-patient]'))return;
      const text=row.textContent||'';const p=(r.data||[]).find(x=>text.includes(x.hn));if(!p)return;
      const b=document.createElement('button');b.type='button';b.className='btn ghost';b.textContent='แก้ไข';b.dataset.editPatient=p.id;
      b.onclick=()=>{
        editingPatientId=p.id;
        $('#p-hn').value=p.hn||'';$('#p-prefix').value=p.prefix||'';$('#p-first').value=p.first_name||'';$('#p-last').value=p.last_name||'';
        $('#p-national').value=p.national_id||'';$('#p-gender').value=p.gender||'';$('#p-dob').value=p.date_of_birth||'';$('#p-phone').value=p.phone||'';
        $('#p-address').value=p.address||'';$('#p-right').value=p.payment_right||'';$('#p-emergency').value=p.emergency_contact_name||'';
        cancel.style.display='block';if(submit)submit.textContent='บันทึกการแก้ไข';form.scrollIntoView({behavior:'smooth'});
      };
      row.appendChild(b);
    });
  }).observe(list,{childList:true,subtree:true});

  form.addEventListener('submit',async e=>{
    if(!editingPatientId)return;
    e.preventDefault();e.stopImmediatePropagation();
    try{
      const payload={hn:$('#p-hn').value.trim(),prefix:$('#p-prefix').value.trim()||null,first_name:$('#p-first').value.trim(),last_name:$('#p-last').value.trim(),national_id:$('#p-national').value.trim()||null,gender:$('#p-gender').value||null,date_of_birth:$('#p-dob').value||null,phone:$('#p-phone').value.trim()||null,address:$('#p-address').value.trim()||null,payment_right:$('#p-right').value.trim()||null,emergency_contact_name:$('#p-emergency').value.trim()||null,updated_at:new Date().toISOString()};
      const r=await db.from('patients').update(payload).eq('id',editingPatientId);if(r.error)throw r.error;
      editingPatientId=null;form.reset();cancel.style.display='none';if(submit)submit.textContent='บันทึกผู้รับบริการ';toast('แก้ไขข้อมูลผู้รับบริการแล้ว');location.reload();
    }catch(err){fail(err)}
  },true);
}

function currentDrug(){
  const product=$('#rx-product'),qty=Number($('#rx-qty').value||0),unit=$('#rx-unit').value.trim();
  if(!product?.value||!(qty>0)||!unit)throw new Error('กรุณาเลือกยา ระบุจำนวน และหน่วย');
  return {product_id:product.value,product_name:product.options[product.selectedIndex]?.text||'',quantity_prescribed:qty,unit,dose:$('#rx-dose').value.trim()||null,frequency:$('#rx-frequency').value.trim()||null,duration:$('#rx-duration').value.trim()||null,route:$('#rx-route').value.trim()||null,instructions:$('#rx-instructions').value.trim()||null,status:'ordered'};
}
function renderCart(){
  const box=$('#rx-cart');if(!box)return;
  box.innerHTML=rxCart.length?rxCart.map((x,i)=>`<div class="item"><div><b>${esc(x.product_name)}</b><small>${x.quantity_prescribed} ${esc(x.unit)} • ${esc(x.dose||'-')} • ${esc(x.frequency||'-')}</small></div><button type="button" class="btn ghost" data-remove-rx="${i}">ลบ</button></div>`).join(''):'<p class="muted">ยังไม่มีรายการยาในใบสั่ง</p>';
  box.querySelectorAll('[data-remove-rx]').forEach(b=>b.onclick=()=>{rxCart.splice(Number(b.dataset.removeRx),1);renderCart()});
}
function clearDrugFields(){['#rx-qty','#rx-unit','#rx-dose','#rx-frequency','#rx-duration','#rx-instructions'].forEach(s=>{const e=$(s);if(e)e.value=''});if($('#rx-product'))$('#rx-product').value='';if($('#rx-route'))$('#rx-route').value='oral'}
function installMultiDrugPrescription(){
  const form=$('#prescription-form');if(!form)return;
  const final=form.querySelector('button[type="submit"],button:not([type])');
  const cartWrap=document.createElement('div');cartWrap.className='full';cartWrap.innerHTML='<h4 style="margin:8px 0">รายการยาในใบสั่ง</h4><div id="rx-cart"></div>';
  const add=document.createElement('button');add.type='button';add.className='btn ghost full';add.textContent='+ เพิ่มยาในใบสั่ง';
  form.insertBefore(add,final);form.insertBefore(cartWrap,final);if(final)final.textContent='ส่งใบสั่งยาทั้งหมดไป Pharmacy';renderCart();
  add.onclick=()=>{try{rxCart.push(currentDrug());clearDrugFields();renderCart();toast('เพิ่มยาในใบสั่งแล้ว')}catch(e){fail(e)}};

  form.addEventListener('submit',async e=>{
    e.preventDefault();e.stopImmediatePropagation();
    try{
      if(!rxCart.length)rxCart.push(currentDrug());
      const encounterId=$('#rx-encounter').value;if(!encounterId)throw new Error('กรุณาเลือก Encounter');
      const enc=await db.from('encounters').select('id,patient_id').eq('id',encounterId).single();if(enc.error)throw enc.error;
      const rx=await db.from('prescriptions').insert({prescription_no:`RX-${Date.now()}`,encounter_id:enc.data.id,patient_id:enc.data.patient_id,prescriber_id:session.user.id,status:'sent_to_pharmacy',clinical_notes:rxCart.map(x=>x.instructions).filter(Boolean).join(' | ')||null,sent_to_pharmacy_at:new Date().toISOString()}).select().single();if(rx.error)throw rx.error;
      const items=rxCart.map(x=>({...x,prescription_id:rx.data.id}));const ir=await db.from('prescription_items').insert(items);if(ir.error)throw ir.error;
      const qr=await db.from('dispensing_orders').insert({prescription_id:rx.data.id,queue_number:`Q-${String(Date.now()).slice(-6)}`,status:'waiting'});if(qr.error)throw qr.error;
      rxCart=[];form.reset();renderCart();toast(`ส่งใบสั่งยา ${items.length} รายการไป Pharmacy แล้ว`);setTimeout(()=>location.reload(),700);
    }catch(err){fail(err)}
  },true);
}

document.addEventListener('DOMContentLoaded',async()=>{await initClient();if(!session)return;installPatientEditing();installMultiDrugPrescription()});
})();
