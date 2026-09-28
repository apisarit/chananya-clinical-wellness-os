/* Order-scoped view. The RPC remains the authorization boundary. */
(() => {
  'use strict';
  let current = null;
  const pending = new Map(); // Text stays in memory; reload journal contains metadata/digest only.
  const statusText = {
    open: 'รอผู้สั่งยาตอบ — ยังไม่อนุญาตให้จ่ายยา',
    answered: 'ตอบแล้ว — รอห้องยายืนยันและตรวจทานอีกครั้ง',
    resolved: 'ยืนยันคำตอบแล้ว — ต้องตรวจทานใบสั่งยาก่อนจ่ายยา'
  };
  const node = (tag, text, parent) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (parent) parent.append(element);
    return element;
  };
  function open({ db, orderId, label = '', actorId = null, mode = 'read', onReplace = null, productLabel = undefined }) {
    if (current) current();
    const dialog = node('dialog');
    dialog.className = 'card clarification-history';
    dialog.setAttribute('aria-label', 'คำถามระหว่างห้องยากับผู้สั่งยา');
    node('h2', 'คำถามระหว่างห้องยากับผู้สั่งยา', dialog);
    node('p', label || 'ประวัติของใบสั่งยาที่เลือก', dialog);
    node('p', 'ประวัตินี้ไม่แทนการตรวจทานใบสั่งยา และไม่ใช่การอนุมัติให้จ่ายยา', dialog);
    const message = node('p', '', dialog);
    message.setAttribute('role', 'status');
    const list = node('div', undefined, dialog);
    const actionArea = node('div', undefined, dialog);
    const disposeReplacement = window.CnyosReplacementHistory?.mount({db,orderId,parent:dialog,mode,actorId,productLabel});
    const pendingKey = `${actorId}:${orderId}`;
    let actionBusy = false;
    let recoveryError = false;
    try {
      if (actorId && !pending.has(pendingKey) && window.CnyosClarificationAction) {
        const restored = window.CnyosClarificationAction.restore({db, actorId, orderId});
        if (restored) pending.set(pendingKey, restored);
      }
    } catch { recoveryError = true; }
    function actionForm(parent, action, requestId = null) {
      if (!actorId || recoveryError || !window.CnyosClarificationAction) return;
      const form = node('form', undefined, parent);
      const inputLabel = node('label', action === 'open' ? 'คำถามถึงผู้สั่งยา' : action === 'answer' ? 'คำตอบสำหรับใบสั่งยาเดิม (ไม่แก้รายการยา)' : 'ยืนยันว่าอ่านคำตอบแล้ว และจะตรวจทานใบสั่งยาอีกครั้ง', form);
      const input = action === 'acknowledge' ? null : node('textarea', undefined, inputLabel);
      if (input) { input.required = true; input.minLength = 3; input.maxLength = 2000; }
      const submit = node('button', action === 'open' ? 'ส่งคำถาม' : action === 'answer' ? 'บันทึกคำตอบ' : 'ยืนยันคำตอบ', form);
      submit.type = 'submit'; submit.className = 'btn';
      form.onsubmit = async event => {
        event.preventDefault();
        if (disposed || busy || actionBusy || pending.has(pendingKey)) return;
        actionBusy = true;
        submit.disabled = true;
        if (input) input.disabled = true;
        try {
          const decision = await window.CnyosClarificationAction.prepare({db,orderId,actorId,action,requestId,text:input?.value || ''});
          if (disposed) return;
          pending.set(pendingKey, decision);
          actionBusy = false;
          await execute(decision, false);
        } catch {
          if (!disposed) {
            message.textContent = 'ยังไม่ได้ส่งคำขอ — ตรวจข้อความ 3–2000 ตัวอักษรและพื้นที่เก็บรหัสกู้คืน แล้วเปิดประวัติใหม่';
            submit.disabled = false;
            if (input) input.disabled = false;
          }
        } finally { actionBusy = false; }
      };
    }
    function recoveryControls() {
      actionArea.replaceChildren();
      const decision = pending.get(pendingKey);
      if (!decision) return;
      if (decision.canDiscard()) {
        node('p', 'ฐานข้อมูลปฏิเสธคำขอนี้ — ไม่ได้บันทึกการเปลี่ยนแปลงของคำขอนี้ กรุณาตรวจสถานะหรือสิทธิ์ก่อนแก้ไข', actionArea);
        const reset = node('button','กลับไปตรวจประวัติและแก้ไข',actionArea);
        reset.type='button'; reset.className='btn';
        reset.onclick=()=>{
          if (actionBusy || !decision.canDiscard()) return;
          try { decision.discard?.(); } catch {
            message.textContent='ล้างรหัสคำขอไม่ได้ — ยังไม่เปิดให้สร้างคำขอใหม่'; return;
          }
          pending.delete(pendingKey);
          actionArea.replaceChildren(); list.replaceChildren();
          cursor=null; count=0; seen.clear();
          load();
        };
        return;
      }
      node('p', 'ยังยืนยันผลคำขอเดิมไม่ได้ อย่าสร้างรายการใหม่ ตรวจผลก่อน หรือส่งคำขอเดิมซ้ำโดยไม่เปลี่ยนข้อความ', actionArea);
      let originalText = null;
      if (decision.needsText?.()) {
        const label = node('label', 'หากต้องส่งซ้ำ ให้พิมพ์ข้อความเดิมทุกตัวอักษร (ระบบไม่ได้เก็บข้อความไว้ในเครื่อง)', actionArea);
        originalText = node('textarea', undefined, label);
        originalText.maxLength = 2000;
      }
      for (const [label, write] of [['ตรวจผลอีกครั้ง',false],['ส่งคำขอเดิมอีกครั้ง',true]]) {
        const button = node('button',label,actionArea); button.type='button'; button.className='btn';
        button.onclick=()=>execute(decision,!write,originalText?.value);
      }
    }
    async function execute(decision, recover, originalText) {
      if (actionBusy || disposed || busy) return;
      actionBusy=true;
      more.disabled=true;
      dialog.querySelectorAll('form button, form textarea').forEach(el=>{el.disabled=true;});
      message.textContent='กำลังตรวจบันทึกและอ่านผลกลับ…';
      try {
        await (recover ? decision.recover() : decision.submit(originalText));
        pending.delete(pendingKey);
        if (!disposed) {
          actionArea.replaceChildren();
          message.textContent='บันทึกและอ่านกลับตรงกันแล้ว — ปิดแล้วเปิดประวัติใหม่เพื่อดูสถานะล่าสุด ยังต้องตรวจทานก่อนจ่ายยา';
        }
      } catch {
        if (!disposed) {
          message.textContent='ยังยืนยันผลไม่ได้ — ระบบไม่ถือว่าบันทึกสำเร็จ';
          recoveryControls();
        }
      } finally { actionBusy=false; if (!disposed) more.disabled=false; }
    }
    const more = node('button', 'โหลดประวัติ', dialog);
    more.type = 'button'; more.className = 'btn';
    const close = node('button', 'ปิด', dialog);
    close.type = 'button'; close.className = 'btn';
    let disposed = false, busy = false, cursor = null, count = 0;
    const seen = new Set();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disposeReplacement?.();
      dialog.remove();
      if (current === dispose) current = null;
    };
    current = dispose;
    close.onclick = dispose;
    dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
    dialog.addEventListener('close', dispose);
    async function load() {
      if (busy || disposed || actionBusy) return;
      busy = true; more.disabled = true; message.textContent = 'กำลังโหลดประวัติ…';
      // Preserve previous disabled state: a completed/uncertain decision must
      // not become editable merely because another history page finished.
      const pausedControls = Array.from(dialog.querySelectorAll('form button, form textarea'),
        element => ({ element, disabled: element.disabled }));
      pausedControls.forEach(({ element }) => { element.disabled = true; });
      try {
        const response = await db.rpc('manage_prescription_clarification', {
          p_order_id: orderId, p_request_id: cursor, p_action: 'history', p_text: null
        });
        if (disposed) return;
        if (response.error) throw response.error;
        const page = response.data;
        if (!page || !Array.isArray(page.tickets) || page.tickets.length > 100
          || !(page.next_cursor === null || typeof page.next_cursor === 'string')
          || (page.next_cursor !== null && (page.tickets.length !== 100 || page.next_cursor !== page.tickets.at(-1)?.id || page.next_cursor === cursor))
          || page.tickets.some(ticket => !ticket || ticket.order_id !== orderId
            || typeof ticket.id !== 'string' || !statusText[ticket.status]
            || typeof ticket.question !== 'string' || seen.has(ticket.id))) {
          throw new Error('INVALID_HISTORY');
        }
        const pageIds = new Set(page.tickets.map(ticket => ticket.id));
        if (pageIds.size !== page.tickets.length) throw new Error('INVALID_HISTORY');
        for (const ticket of page.tickets) {
          seen.add(ticket.id);
          const entry = node('article', undefined, list);
          entry.className = 'item column';
          node('strong', statusText[ticket.status], entry);
          if(mode==='prescriber' && actorId)window.CnyosReplacementRecovery?.mount({
            db,actorId,ticketId:ticket.id,orderId,parent:entry,isDisposed:()=>disposed
          });
          node('p', `คำถาม: ${ticket.question}`, entry);
          if (ticket.answer) node('p', `คำตอบ: ${ticket.answer}`, entry);
          node('small', `ถามเมื่อ: ${ticket.created_at || 'ไม่ระบุ'} · ตอบเมื่อ: ${ticket.answered_at || 'ยังไม่มีคำตอบ'} · ยืนยันเมื่อ: ${ticket.acknowledged_at || 'ยังไม่ยืนยัน'}`, entry);
          if (!pending.has(pendingKey) && ticket.request_id) {
            if(mode==='prescriber' && actorId && !recoveryError && typeof onReplace==='function'
              && ['open','answered'].includes(ticket.status)) {
              const replace=node('button','เตรียมใบทดแทนจากรายการยาที่เลือก',entry);
              replace.type='button';replace.className='btn';
              replace.onclick=()=>{
                if(disposed||busy||actionBusy||pending.has(pendingKey))return;
                onReplace({ticketId:ticket.id,orderId});
              };
            }
            if (mode === 'prescriber' && ticket.status === 'open') actionForm(entry,'answer',ticket.request_id);
            if (mode === 'pharmacy' && ticket.status === 'answered') actionForm(entry,'acknowledge',ticket.request_id);
          }
        }
        count += page.tickets.length; cursor = page.next_cursor;
        message.textContent = count ? `แสดง ${count} รายการ${cursor ? ' — ยังมีประวัติหน้าถัดไป' : ''}` : 'ไม่มีคำถามในประวัติของใบสั่งยานี้';
        more.hidden = cursor === null;
        more.textContent = 'โหลดหน้าถัดไป';
        if (pending.has(pendingKey)) recoveryControls();
        else if (mode === 'pharmacy' && count === page.tickets.length) actionForm(actionArea,'open');
        if (recoveryError) message.textContent='อ่านรหัสกู้คืนไม่ได้ — แสดงประวัติได้ แต่หยุดส่งคำขอใหม่เพื่อป้องกันรายการซ้ำ กรุณาติดต่อผู้ดูแล';
      } catch {
        if (!disposed) {
          message.textContent = 'โหลดประวัติไม่ได้ — ตรวจสิทธิ์และการเปิดใช้ระบบคำถาม แล้วลองใหม่ ขณะนี้ยังยืนยันสถานะไม่ได้';
          more.hidden = false; more.textContent = 'ลองโหลดอีกครั้ง';
        }
      } finally {
        busy = false;
        if (!disposed) {
          more.disabled = false;
          pausedControls.forEach(({ element, disabled }) => { element.disabled = disabled; });
        }
      }
    }
    more.onclick = load;
    document.body.append(dialog);
    dialog.showModal();
    load();
    return dispose;
  }
  window.CnyosClarificationHistory = Object.freeze({ open, close: () => current?.() });
})();
