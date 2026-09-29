// SIMULATION_ONLY: real DOM, synthetic RPC, all outbound requests blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const browser = await chromium.launch({headless:true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? {executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  const context = await browser.newContext({viewport:{width:390,height:844}});
  await context.route('**/*',route=>route.abort());
  const page = await context.newPage();
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://clarification-test.invalid/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="th"><body></body></html>'}));
  await page.goto('https://clarification-test.invalid/');
  await page.addScriptTag({content:fs.readFileSync(new URL('../clarification-action.js',import.meta.url),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(new URL('../clarification-history.js',import.meta.url),'utf8')});
  await page.evaluate(()=>{
    window.calls=[];
    window.mode='normal';
    window.mockDb={rpc:async(name,args)=>{
      calls.push({name,args});
      if(mode==='late') return new Promise(resolve=>{window.resolveLate=resolve;});
      if(mode==='denied') return {error:{message:'PRIVATE_INTERNAL_ERROR'}};
      if(mode==='empty') return {data:{tickets:[],next_cursor:null}};
      return {data:{tickets:[{id:'ticket-a',order_id:mode==='wrong'?'other':args.p_order_id,
        question:'<img src=x onerror="window.injected=true">',answer:'Synthetic answer',
        status:'answered',created_at:'2026-09-26'}],next_cursor:null}};
    }};
    window.openHistory=()=>CnyosClarificationHistory.open({db:mockDb,orderId:'order-a',label:'Synthetic queue'});
    openHistory();
  });
  await page.getByText('คำตอบ: Synthetic answer',{exact:true}).waitFor();
  assert.equal(await page.locator('dialog img').count(),0);
  assert.equal(await page.evaluate(()=>!!window.injected),false);
  assert.match(await page.locator('dialog').innerText(),/รอห้องยายืนยัน/);
  assert.deepEqual(await page.evaluate(()=>calls[0].args),{
    p_order_id:'order-a',p_request_id:null,p_action:'history',p_text:null});
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  assert.equal(await page.locator('dialog').count(),0);
  for(const mode of ['denied','wrong']) {
    await page.evaluate(mode=>{window.mode=mode;openHistory();},mode);
    await page.getByText(/โหลดประวัติไม่ได้/).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_INTERNAL_ERROR'));
    assert.equal(await page.locator('dialog article').count(),0);
    await page.getByRole('button',{name:'ปิด',exact:true}).click();
  }
  await page.evaluate(()=>{mode='late';openHistory();});
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  await page.evaluate(()=>{mode='empty';openHistory();resolveLate({data:{tickets:[],next_cursor:null}});});
  await page.getByText('ไม่มีคำถามในประวัติของใบสั่งยานี้',{exact:true}).waitFor();
  assert.equal(await page.locator('dialog').count(),1);
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  await page.evaluate(()=>{
    window.ticket=null; window.writes=0; window.loseOnce=true;
    window.flowDb={rpc:async(_name,args)=>{
      if(args.p_action==='history') return {data:{tickets:ticket?[ticket]:[],next_cursor:null}};
      if(args.p_action==='read') return {data:ticket};
      writes++;
      if(args.p_action==='open') ticket={id:'flow-ticket',request_id:args.p_request_id,order_id:'flow-order',
        requested_by:'pharmacy',question:args.p_text,status:'open'};
      if(args.p_action==='answer') Object.assign(ticket,{answer:args.p_text,answered_by:'doctor',status:'answered'});
      if(args.p_action==='acknowledge') Object.assign(ticket,{acknowledged_by:'pharmacy',status:'resolved'});
      if(loseOnce){loseOnce=false;throw new Error('simulated lost response');}
      return {data:ticket};
    }};
    window.openFlow=mode=>CnyosClarificationHistory.open({db:flowDb,orderId:'flow-order',mode,
      actorId:mode==='pharmacy'?'pharmacy':'doctor'});
    openFlow('pharmacy');
  });
  await page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).fill('Synthetic question');
  await page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
  await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).waitFor();
  await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).click();
  await page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  assert.equal(await page.evaluate(()=>writes),1);
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  await page.evaluate(()=>openFlow('prescriber'));
  await page.getByLabel('คำตอบสำหรับใบสั่งยาเดิม (ไม่แก้รายการยา)',{exact:true}).fill('Synthetic answer');
  await page.getByRole('button',{name:'บันทึกคำตอบ',exact:true}).click();
  await page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  await page.evaluate(()=>openFlow('pharmacy'));
  await page.getByRole('button',{name:'ยืนยันคำตอบ',exact:true}).click();
  await page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  assert.equal(await page.evaluate(()=>ticket.status),'resolved');
  assert.equal(await page.evaluate(()=>writes),3);
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  for (const failPage of [false, true]) {
    await page.evaluate(failPage=>{
      window.paginationWrites=0;
      window.paginationTicket=null;
      const orderId=`pagination-${failPage}`;
      const tickets=Array.from({length:100},(_,i)=>({id:`page-${i}`,order_id:orderId,
        question:'Synthetic historical question',status:'resolved'}));
      const db={rpc:async(_name,args)=>{
        if(args.p_action==='history') {
          if(!args.p_request_id) return {data:{tickets,next_cursor:'page-99'}};
          return new Promise(resolve=>{window.finishPage=()=>resolve(failPage
            ? {error:{message:'Synthetic unavailable'}} : {data:{tickets:[],next_cursor:null}});});
        }
        if(args.p_action==='read') return {data:paginationTicket};
        paginationWrites++;
        paginationTicket={id:'new-ticket',order_id:orderId,request_id:args.p_request_id,
          requested_by:'pharmacy',question:args.p_text,status:'open'};
        return {data:paginationTicket};
      }};
      CnyosClarificationHistory.open({db,orderId,actorId:'pharmacy',mode:'pharmacy'});
    },failPage);
    const input=page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true});
    await input.fill('Synthetic retained draft');
    await page.getByRole('button',{name:'โหลดหน้าถัดไป',exact:true}).click();
    // Also exercise the handler directly: disabled controls alone are not a guard.
    await page.locator('dialog form').evaluate(form=>form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));
    assert.equal(await input.isDisabled(),true,'pagination must pause form editing');
    assert.equal(await page.evaluate(()=>paginationWrites),0);
    await page.evaluate(()=>finishPage());
    await page.waitForFunction(()=>!document.querySelector('dialog textarea')?.disabled);
    assert.equal(await input.inputValue(),'Synthetic retained draft');
    assert.equal(await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).count(),0,
      'pagination must not create an unattempted pending decision');
    await page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
    await page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
    assert.equal(await page.evaluate(()=>paginationWrites),1);
    await page.getByRole('button',{name:'ปิด',exact:true}).click();
  }
  let reloadTicket=null, reloadWrites=0;
  await page.exposeFunction('reloadRpc',async(_name,args)=>{
    if(args.p_action==='history') return {data:{tickets:reloadTicket?[reloadTicket]:[],next_cursor:null}};
    if(args.p_action==='read') return {data:reloadTicket};
    reloadWrites++;
    reloadTicket={id:'reload-ticket',order_id:'reload-order',request_id:args.p_request_id,
      requested_by:'pharmacy',question:args.p_text,status:'open'};
    throw new Error('Synthetic committed response lost');
  });
  const openReload=()=>page.evaluate(()=>CnyosClarificationHistory.open({db:{rpc:window.reloadRpc},
    orderId:'reload-order',actorId:'pharmacy',mode:'pharmacy'}));
  await openReload();
  await page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).fill('Synthetic reload confidential question');
  await page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
  await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).waitFor();
  const stored=await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)));
  assert.ok(!stored.includes('confidential'));
  assert.match(stored,/reload-order/);
  await page.reload(); // Destroy all controller/dialog memory, not merely close the dialog.
  for(const file of ['clarification-action.js','clarification-history.js']) {
    await page.addScriptTag({content:fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8')});
  }
  await openReload();
  await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).waitFor();
  assert.equal(reloadWrites,1,'reload must not auto-write');
  assert.equal(await page.getByRole('button',{name:'ส่งคำถาม',exact:true}).count(),0);
  await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).click();
  await page.getByText(/บันทึกและอ่านกลับตรงกันแล้ว/).waitFor();
  assert.equal(reloadWrites,1,'recovery must not repeat the mutation');
  assert.equal(await page.evaluate(()=>sessionStorage.length),0);
  await page.getByRole('button',{name:'ปิด',exact:true}).click();
  await page.addScriptTag({content:fs.readFileSync(new URL('../replacement-history.js',import.meta.url),'utf8')});
  for(const catalogName of ['Synthetic medicine <img src=x>', null, '   ']) {
    await page.evaluate(catalogName=>{
      window.catalogRequests=[];window.sharedHistoryWrites=0;
      const row={request_id:'shared-replacement',ticket_id:'shared-ticket',actor_id:'doctor',
        old_order_id:'old-order',new_order_id:'shared-order',acknowledged_at:null,
        new_snapshot:{prescription:{clinical_notes:'Synthetic only'},
          items:[{product_id:'catalog-product',quantity_prescribed:2,unit:'unit'}]}};
      const db={rpc:async(name,args)=>{
        if(name==='read_prescription_replacements')return {data:{order_id:'shared-order',replacements:[row]}};
        if(args.p_action==='history')return {data:{tickets:[],next_cursor:null}};
        window.sharedHistoryWrites++;throw new Error('No mutation permitted in this display test');
      }};
      CnyosClarificationHistory.open({db,orderId:'shared-order',actorId:'pharmacy',mode:'pharmacy',
        productLabel:id=>{catalogRequests.push(id);return catalogName;}});
    },catalogName);
    await page.getByText(/รหัสยา catalog-product/).waitFor();
    assert.deepEqual(await page.evaluate(()=>catalogRequests),['catalog-product']);
    if(catalogName?.trim())await page.getByText(`ชื่อในแค็ตตาล็อกปัจจุบัน: ${catalogName}`,{exact:true}).waitFor();
    else await page.getByText('ยังอ่านชื่อยาจากแค็ตตาล็อกไม่ได้ — ตรวจสอบรหัสยาก่อนจ่าย',{exact:true}).waitFor();
    assert.equal(await page.locator('dialog img').count(),0);
    assert.equal(await page.evaluate(()=>sharedHistoryWrites),0);
    assert.match(await page.locator('dialog').innerText(),/จำนวน 2 unit/);
    await page.getByRole('button',{name:'ปิด',exact:true}).click();
    assert.equal(await page.locator('dialog').count(),0);
  }
  // Closing during async preparation must not retain a stale decision or send it.
  await page.evaluate(()=>{
    window.originalAction=window.CnyosClarificationAction;
    window.closedWrites=0;
    window.CnyosClarificationAction={restore:()=>null,prepare:()=>new Promise(resolve=>{
      window.finishPreparation=()=>resolve({submit:async()=>{closedWrites++;},canDiscard:()=>false});
    })};
    window.openClosing=()=>CnyosClarificationHistory.open({db:{rpc:async()=>({data:{tickets:[],next_cursor:null}})},
      orderId:'closing-order',actorId:'pharmacy',mode:'pharmacy'});
    openClosing();
  });
  await page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).fill('Synthetic pending preparation');
  await page.getByRole('button',{name:'ส่งคำถาม',exact:true}).click();
  await page.waitForFunction(()=>typeof finishPreparation==='function');
  await page.evaluate(async()=>{
    CnyosClarificationHistory.close();
    CnyosClarificationHistory.close(); // disposal is idempotent
    finishPreparation();
    await Promise.resolve(); await Promise.resolve();
  });
  assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.evaluate(()=>closedWrites),0);
  await page.evaluate(()=>openClosing());
  await page.getByLabel('คำถามถึงผู้สั่งยา',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'ตรวจผลอีกครั้ง',exact:true}).count(),0,
    'disposed preparation must not add a stale in-memory pending decision');
  await page.evaluate(()=>{CnyosClarificationHistory.close();window.CnyosClarificationAction=originalAction;});
  assert.deepEqual(errors,[]);
  console.log('Clarification browser passed: safe history, order binding, error vs empty, stale close isolation; synthetic ask/answer/ack and read-only lost-response recovery. No database writes.');
} finally {await browser.close();}
