/* Read-only recovery of an unresolved authoring request. No clinical draft storage. */
(() => {
  'use strict';
  function mount({db,actorId,ticketId,orderId,parent,isDisposed=()=>false}) {
    const add=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;parent.append(element);return element;};
    let action;
    try {
      action=window.CnyosReplacementAction.restore({db,actorId,ticketId,oldOrderId:orderId});
      if(!action)return;
    } catch {
      add('p','อ่านรหัสใบสั่งยาทดแทนเดิมไม่ได้ — อย่าออกใบใหม่ กรุณาให้ผู้ดูแลตรวจสอบ');
      return;
    }
    const message=add('p','มีคำขอใบสั่งยาทดแทนที่ยังไม่ได้ยืนยันผล — ตรวจรายการเดิมก่อน ห้ามออกซ้ำ');
    message.setAttribute('role','status');
    const button=add('button','ตรวจผลใบสั่งยาทดแทนเดิม');
    button.type='button';button.className='btn';
    let busy=false,done=false;
    button.onclick=async()=>{
      if(busy||done||isDisposed())return;
      busy=true;button.disabled=true;
      message.textContent='กำลังอ่านผลใบสั่งยาทดแทนเดิม…';
      try {
        const receipt=await action.recover();
        if(receipt.old_order_id!==orderId)throw new Error('ORDER_MISMATCH');
        done=true;
        if(!isDisposed())message.textContent=`พบใบสั่งยาทดแทนที่บันทึกแล้ว • คิว ${receipt.new_order_id} — ปิดแล้วเปิดประวัติใหม่ ห้องยายังต้องยืนยันและตรวจทานก่อนจ่ายยา`;
      } catch {
        if(!isDisposed())message.textContent='ยังตรวจผลเดิมไม่ได้ — ไม่ได้ส่งใบใหม่และยังไม่ถือว่าบันทึกสำเร็จ ลองตรวจผลอีกครั้ง';
      } finally {
        busy=false;
        if(!isDisposed())button.disabled=done;
      }
    };
  }
  window.CnyosReplacementRecovery=Object.freeze({mount});
})();
