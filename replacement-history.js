/* Order linkage and exact-receipt acknowledgement; server authorizes writes. */
(() => {
  'use strict';
  function mount({db,orderId,parent,mode='read',actorId=null,productLabel=()=>null}) {
    let disposed=false;
    const section=document.createElement('section');
    section.className='item column';
    parent.append(section);
    const add=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;section.append(el);return el;};
    add('h3','ประวัติใบทดแทน');
    const status=add('p','กำลังตรวจประวัติใบทดแทน…');
    async function load() {
      try {
        const result=await db.rpc('read_prescription_replacements',{p_order_id:orderId});
        if(disposed)return;
        const rows=result.data?.replacements;
        if(result.error || result.data?.order_id!==orderId || !Array.isArray(rows) || rows.length>2
          || rows.some(row=>!row?.request_id || !row.old_order_id || !row.new_order_id
            || (row.old_order_id!==orderId && row.new_order_id!==orderId))) throw new Error('INVALID_LINKAGE');
        status.textContent=rows.length?'ประวัตินี้ไม่แทนการตรวจทานก่อนจ่ายยา':'ไม่พบใบทดแทนที่เชื่อมกับคิวนี้';
        for(const row of rows) {
          add('strong',row.old_order_id===orderId?'ใบนี้ถูกแทนแล้ว — ห้ามจ่ายจากคิวเดิม':'ใบนี้เป็นใบทดแทน');
          add('p',`คิวเดิม: ${row.old_order_id} → คิวใหม่: ${row.new_order_id}`);
          add('p',`เหตุผล: ${row.request_payload?.reason || 'ไม่พบเหตุผลในประวัติ'}`);
          add('p',row.acknowledged_at
            ?`ห้องยายืนยันเมื่อ ${row.acknowledged_at} — ยังต้องตรวจทานใบใหม่`
            :'ยังรอห้องยายืนยันใบทดแทน — ยังไม่พร้อมจ่ายยา');
          const items=row.new_snapshot?.items;
          const validItems=Array.isArray(items)&&items.length>0&&items.every(item=>item
            &&typeof item.product_id==='string'&&item.product_id.trim()
            &&typeof item.quantity_prescribed==='number'&&Number.isFinite(item.quantity_prescribed)&&item.quantity_prescribed>0
            &&typeof item.unit==='string'&&item.unit.trim()
            &&['dose','frequency','route','duration','instructions'].every(field=>item[field]==null||typeof item[field]==='string'));
          if(validItems) {
            add('p',`หมายเหตุใบใหม่: ${row.new_snapshot.prescription?.clinical_notes || 'ไม่มี'}`);
            for(const item of items) {
              const label=productLabel(item.product_id);
              add('p',typeof label==='string'&&label.trim()?`ชื่อในแค็ตตาล็อกปัจจุบัน: ${label}`:'ยังอ่านชื่อยาจากแค็ตตาล็อกไม่ได้ — ตรวจสอบรหัสยาก่อนจ่าย');
              add('p',`รหัสยา ${item.product_id} · จำนวน ${item.quantity_prescribed} ${item.unit || ''} · ขนาดยา ${item.dose || 'ไม่ระบุ'} · ความถี่ ${item.frequency || 'ไม่ระบุ'} · วิธีใช้ ${item.route || 'ไม่ระบุ'} · ระยะเวลา ${item.duration || 'ไม่ระบุ'} · คำแนะนำ ${item.instructions || 'ไม่ระบุ'}`);
            }
          } else add('p','รายการใบใหม่ไม่ครบหรืออ่านไม่ได้ — หยุดยืนยันและตรวจสอบใบสั่งยาก่อน');
          if(mode==='pharmacy' && actorId && actorId!==row.actor_id && row.new_order_id===orderId
            && !row.acknowledged_at && row.ticket_id && validItems) {
            const message=add('p','ยืนยันว่าอ่านเหตุผลและรายการใบใหม่แล้ว จากนั้นต้องตรวจทานก่อนจ่ายยา');
            const confirm=add('button','ยืนยันรับทราบใบทดแทน');confirm.type='button';confirm.className='btn';
            const recover=add('button','ตรวจผลการยืนยันเดิม');recover.type='button';recover.className='btn';recover.hidden=true;
            let busy=false,done=false;
            const matches=value=>value?.request_id===row.request_id && value.ticket_id===row.ticket_id
              && value.old_order_id===row.old_order_id && value.new_order_id===orderId
              && value.acknowledged_by===actorId && Boolean(value.acknowledged_at)
              && JSON.stringify(value.new_snapshot)===JSON.stringify(row.new_snapshot);
            const run=async(write)=>{
              if(busy||done||disposed)return;
              busy=true;confirm.disabled=true;recover.disabled=true;
              message.textContent='กำลังตรวจผลการยืนยัน…';
              try {
                if(write) {
                  const result=await db.rpc('manage_prescription_replacement',{p_request_id:row.request_id,p_ticket_id:row.ticket_id,p_action:'acknowledge'});
                  if(result.error)throw result.error;
                  if(!matches(result.data))throw new Error('ACK_MISMATCH');
                }
                const check=await db.rpc('manage_prescription_replacement',{p_request_id:row.request_id,p_ticket_id:row.ticket_id,p_action:'read'});
                if(check.error||!matches(check.data))throw new Error('READBACK_MISMATCH');
                done=true;
                if(!disposed)message.textContent='ยืนยันและอ่านกลับตรงกันแล้ว — ปิดประวัติและตรวจทานใบใหม่ก่อนจ่ายยา';
              } catch {
                if(!disposed){message.textContent='ยังยืนยันผลไม่ได้ — ตรวจผลเดิมหรือส่งการยืนยันเดิมอีกครั้ง ห้ามถือว่าพร้อมจ่ายยา';recover.hidden=false;}
              } finally {busy=false;if(!disposed){confirm.disabled=done;recover.disabled=done;}}
            };
            confirm.onclick=()=>run(true);recover.onclick=()=>run(false);
          }
        }
      } catch {
        if(!disposed)status.textContent='ตรวจประวัติใบทดแทนไม่ได้ — ยังยืนยันว่าไม่มีใบทดแทนไม่ได้ กรุณาตรวจสิทธิ์หรือการเปิดใช้ระบบ';
      }
    }
    load();
    return ()=>{disposed=true;section.remove();};
  }
  window.CnyosReplacementHistory=Object.freeze({mount});
})();
