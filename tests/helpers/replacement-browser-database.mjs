import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

export async function verifyBillingPayment({asUser,actorId,invoiceId,requestId,pay,amount=50,balanceBefore=125,lossBeforeCommit=false}) {
  const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  let calls=0,receipt,paymentRow;
  let refreshFailurePending=true;
  const failedTable=amount===balanceBefore?'payments':'invoices';
  const reloadAfterLoss=amount!==balanceBefore;
  const expectedCalls=reloadAfterLoss?1:2;
  const loaded=new Set();
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const errors=[],dialogs=[];page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>{dialogs.push(dialog.message());return dialog.dismiss();});
    await page.route('**/*',route=>route.abort());
    const html=(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
    await page.route('https://billing-database.invalid/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.exposeFunction('billingRpc',async(name,args)=>{
      if(name==='list_billable_treatment_encounters')return {data:(await asUser(actorId,'select * from public.list_billable_treatment_encounters()')).rows};
      assert.equal(name,'record_atomic_invoice_payment');
      assert.deepEqual(args,{p_request_key:requestId,p_invoice_id:invoiceId,p_amount:amount,p_channel:'cash',p_reference_note:'Synthetic replacement payment'});
      calls++;
      if(calls===1 && lossBeforeCommit)return {error:{message:'Synthetic connection lost before payment commit'}};
      receipt=(await asUser(actorId,pay(requestId,amount))).rows[0];
      return calls===1?{error:{message:'Synthetic response lost after payment commit'}}:{data:[receipt]};
    });
    const invoiceRow=(await asUser(actorId,`select id,invoice_number,patient_id from public.invoices where id='${invoiceId}'`)).rows[0];
    assert.ok(invoiceRow);
    const clinicId=(await asUser(actorId,`select clinic_id from public.patients where id='${invoiceRow.patient_id}'`)).rows[0].clinic_id;
    await page.exposeFunction('billingList',async table=>{
      assert.ok(['patients','encounters','prescriptions','dispensing_orders','dispensing_items','prescription_items','products','invoices','payments'].includes(table));
      if(table===failedTable&&refreshFailurePending){refreshFailurePending=false;return {error:{message:'Synthetic financial list read failure'}};}
      const rows=(await asUser(actorId,`select * from public.${table}`)).rows;
      loaded.add(table);return {data:rows};
    });
    await page.exposeFunction('billingRead',async(table,id)=>{
      const allowed={payments:receipt?.payment_id,invoices:invoiceId,patients:invoiceRow.patient_id};
      assert.ok(Object.hasOwn(allowed,table));
      const byRequest=table==='payments'&&id===requestId;
      if(!byRequest)assert.equal(id,allowed[table]);
      assert.match(id,/^[a-f0-9-]{36}$/);
      const row=(await asUser(actorId,`select * from public.${table} where ${byRequest?'request_key':'id'}='${id}'`)).rows[0];
      if(table==='payments')paymentRow=row;
      return {data:row?JSON.parse(JSON.stringify(row)):null};
    });
    async function mountBilling() {
    await page.goto('https://billing-database.invalid/');
    await page.addStyleTag({content:await fs.readFile(new URL('../../app.css',import.meta.url),'utf8')});
    await page.evaluate(({invoiceId,requestId,amount})=>{
      crypto.randomUUID=()=>requestId;
      document.querySelector('#boot').classList.add('hidden');document.querySelector('#app').classList.remove('hidden');
      document.querySelectorAll('.view').forEach(view=>view.classList.remove('active'));
      document.querySelector('#billing').classList.add('active');
      document.querySelector('#pay-invoice').append(new Option('Synthetic invoice',invoiceId));
      document.querySelector('#pay-invoice').value=invoiceId;
      document.querySelector('#pay-amount').value=String(amount);
      document.querySelector('#pay-channel').value='cash';
      document.querySelector('#pay-note').value='Synthetic replacement payment';
    },{invoiceId,requestId,amount});
    const source=await fs.readFile(new URL('../../app.js',import.meta.url),'utf8');
    assert.ok(source.includes('  init();\n})();'));
    await page.addScriptTag({content:await fs.readFile(new URL('../../payment-journal.js',import.meta.url),'utf8')});
    await page.addScriptTag({content:source.replace('  init();\n})();',`
      atomicHandoffsReady=true; session={user:{id:${JSON.stringify(actorId)}}};
      role='billing'; profile={id:${JSON.stringify(actorId)},role:'billing',clinic_id:${JSON.stringify(clinicId)}};
      window.ChananyaRuntime={can:(_profile,permission)=>permission==='billing_operate'};
      data.invoices=[{id:${JSON.stringify(invoiceId)},balance_due:${balanceBefore}}];
      db={rpc:window.billingRpc,from(table){return {select(){return this},order(){return this},eq(field,id){this.id=id;return this},single(){return window.billingRead(table,this.id)},then(resolve,reject){return window.billingList(table).then(resolve,reject)}}}};
      db.auth={onAuthStateChange(callback){window.emitSyntheticAuth=callback;}};
      watchAccount();
      restoreSavedPayment();
      window.showSyntheticReceipt=showReceipt;
      window.refreshSyntheticBilling=loadAll;
    })();`)});
    }
    await mountBilling();
    await page.evaluate(()=>{
      window.originalStorageSetItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(key.startsWith('cnyos.payment.pending.v1:'))throw new Error('Synthetic payment storage denied');
        return window.originalStorageSetItem.call(this,key,value);
      };
    });
    await Promise.all([page.waitForEvent('dialog',{timeout:10000}),page.locator('#payment-form button').click()]);
    assert.ok(dialogs.includes('Synthetic payment storage denied'));
    await page.waitForFunction(()=>!document.querySelector('#payment-form button').disabled,null,{timeout:10000});
    assert.equal(calls,0,'unpersisted payment identity must never reach the write RPC');
    assert.equal(await page.locator('#payment-form button').isEnabled(),true);
    assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('cnyos.payment.pending.v1:')).length),0);
    await page.evaluate(()=>{Storage.prototype.setItem=window.originalStorageSetItem;delete window.originalStorageSetItem;});
    await page.locator('#payment-form button').click();
    await page.locator('#payment-recovery').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#payment-retry').disabled);
    assert.equal(calls,1);
    assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('cnyos.payment.pending.v1:')).length),1);
    {
      await page.evaluate(()=>window.previousDocumentMarker=true);
      await mountBilling();
      assert.equal(await page.evaluate(()=>window.previousDocumentMarker),undefined,'recovery must use a new document');
      await page.locator('#payment-recovery').waitFor({state:'visible'});
      assert.match(await page.locator('#payment-recovery-message').textContent(),/ก่อนโหลดหน้า/);
      assert.equal(calls,1,'document reload must not submit another payment');
    }
    if(reloadAfterLoss) {
      await page.locator('#payment-retry').click();
    } else {
      if(lossBeforeCommit) {
        await Promise.all([page.waitForEvent('dialog',{timeout:10000}),page.locator('#payment-retry').click()]);
        assert.ok(dialogs.includes('ยังตรวจผลรับเงินเดิมไม่ได้ ห้ามรับเงินซ้ำ'));
        assert.equal(calls,1,'failed read-only recovery must not submit a payment');
      }
      await page.locator('#resume-amount').fill(String(amount+1));
      await page.locator('#resume-channel').selectOption('cash');
      await page.locator('#resume-note').fill('Synthetic replacement payment');
      await Promise.all([page.waitForEvent('dialog',{timeout:10000}),page.locator('#payment-resume-form button').click()]);
      assert.ok(dialogs.includes('PAYMENT_OUTCOME_UNRESOLVED'));
      assert.equal(calls,1,'different re-entered draft must not dispatch a payment');
      await page.locator('#resume-amount').fill(String(amount));
      await page.locator('#payment-resume-form button').click();
    }
    await page.locator('#payment-recovery').waitFor({state:'hidden'});
    assert.equal(calls,expectedCalls);
    assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('cnyos.payment.pending.v1:')).length),0);
    assert.equal(Number(receipt.balance_due),balanceBefore-amount);
    assert.match(await page.locator('#toast').textContent(),reloadAfterLoss?/ตรวจพบการรับเงินเดิมแล้ว.*โหลดหน้ารายการไม่สำเร็จ/:/รับเงินและตรวจอ่านกลับแล้ว แต่โหลดหน้ารายการไม่สำเร็จ/);
    assert.match(await page.locator('#invoice-list').textContent(),/ยังอ่านข้อมูลการเงินล่าสุดไม่ได้/);
    assert.equal(await page.locator('#pay-invoice option').count(),0,'stale invoice choices must be removed after read failure');
    await page.evaluate(()=>window.refreshSyntheticBilling());
    assert.equal(calls,expectedCalls,'read refresh must not repeat payment write');
    assert.ok(loaded.has('invoices')&&loaded.has('payments'),'real loadAll did not read financial lists');
    const card=page.locator('#invoice-list article').filter({hasText:invoiceRow.invoice_number});
    assert.equal(await card.count(),1);
    assert.ok((await card.textContent()).includes(`คงเหลือ ฿${(balanceBefore-amount).toFixed(2)}`));
    assert.equal(await page.locator(`#pay-invoice option[value="${invoiceId}"]`).count(),balanceBefore===amount?0:1);
    await page.evaluate(id=>window.showSyntheticReceipt(id),receipt.payment_id);
    assert.equal(await page.locator('#receipt-dialog').isVisible(),true);
    const receiptText=await page.locator('#receipt-body').textContent();
    assert.ok(receiptText.includes(paymentRow.payment_reference));
    assert.ok(receiptText.includes(invoiceRow.invoice_number));
    assert.ok(receiptText.includes(amount.toFixed(2)));
    for(const failOlder of [false,true]) {
      await page.evaluate(async failOlder=>{
        const original=window.billingList;
        let entered,release,hold=true;
        const started=new Promise(resolve=>entered=resolve);
        const held=new Promise(resolve=>release=resolve);
        window.billingList=async table=>{
          if(table==='invoices'&&hold){hold=false;entered();await held;
            if(failOlder)return {error:{message:'Synthetic older refresh error'}};
            const result=await original(table);
            return {data:result.data.map(row=>({...row,balance_due:999}))};
          }
          return original(table);
        };
        try {
          const older=window.refreshSyntheticBilling().catch(()=>{});
          await started;await window.refreshSyntheticBilling();release();await older;
        } finally {release();window.billingList=original;}
      },failOlder);
      assert.ok((await card.textContent()).includes(`คงเหลือ ฿${(balanceBefore-amount).toFixed(2)}`));
      assert.equal(await page.locator(`#pay-invoice option[value="${invoiceId}"]`).count(),balanceBefore===amount?0:1);
      assert.equal(calls,expectedCalls);
    }
    await page.evaluate(id=>window.showSyntheticReceipt(id),receipt.payment_id);
    assert.equal(await page.locator('#receipt-dialog').isVisible(),true);
    await page.evaluate(()=>window.emitSyntheticAuth('SIGNED_OUT',null));
    assert.equal(await page.locator('#app').isVisible(),false);
    assert.equal(await page.locator('#app').evaluate(element=>element.inert),true);
    assert.equal(await page.locator('#receipt-dialog').isVisible(),false);
    assert.equal(await page.locator('#receipt-body').textContent(),'');
    assert.equal(await page.locator('#boot').isVisible(),true);
    await page.evaluate(()=>window.refreshSyntheticBilling());
    assert.equal(calls,expectedCalls,'blocked document must not issue a payment or revive the old workspace');
    assert.equal(await page.locator('#app').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log(`Billing actual form/database passed: ${lossBeforeCommit?'connection lost before commit':'committed response loss'}, ${reloadAfterLoss?'new-document read-only recovery':'new-document exact-draft retry with changed-draft denial'}, real list refresh/balance/options and receipt readback. Authentication bootstrap remains an isolated test hook.`);
    return receipt;
  } finally {await browser.close();}
}

export async function verifyReplacementAuthoring({asUser,actorId,ticketId,oldOrderId,requestId,items,call}) {
  const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  let writes=0;
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    const html=(await fs.readFile(new URL('../../clinical-v3.html',import.meta.url),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    await page.route('https://replacement-authoring.invalid/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.exposeFunction('replacementRpc',async(name,args)=>{
      assert.equal(name,'manage_prescription_replacement');
      assert.equal(args.p_request_id,requestId);assert.equal(args.p_ticket_id,ticketId);
      assert.ok(['replace','read'].includes(args.p_action));
      if(args.p_action==='replace') {
        assert.deepEqual(args.p_items,items);
        assert.equal(args.p_reason,'Synthetic replacement reason');
        assert.equal(args.p_notes,'New synthetic notes');
      }
      const result=(await asUser(actorId,call(args.p_action))).rows[0].result;
      if(args.p_action==='replace'){writes++;return {error:{message:'Synthetic committed response lost'}};}
      return {data:result};
    });
    const load=async()=>{
      await page.goto('https://replacement-authoring.invalid/');
      await page.addScriptTag({content:await fs.readFile(new URL('../../replacement-action.js',import.meta.url),'utf8')});
    };
    await load();
    const source=await fs.readFile(new URL('../../clinical-v3.js',import.meta.url),'utf8');
    assert.ok(source.includes('  init();\n})();'));
    // Replace only authentication/bootstrap with a fixed isolated fixture.
    // The actual markup, modal, handlers and submission controller are retained.
    await page.addScriptTag({content:source.replace('  init();\n})();',`  window.openSyntheticReplacement = async options => {
      db={rpc:window.replacementRpc}; session={user:{id:options.actorId}};
      currentEncounter='synthetic-encounter'; prescriptionCartEncounterId=currentEncounter;
      prescriptionCart=options.items.map(item=>({...item,product_name:'Synthetic medicine'}));
      prescriptionCartVersion=1; atomicHandoffsReady=true;
      $('#rx-encounter').append(new Option('Synthetic encounter',currentEncounter));
      $('#rx-encounter').value=currentEncounter;
      $('#rx-clinical-notes').value='New synthetic notes';
      await openReplacementDraft({ticketId:options.ticketId,orderId:options.oldOrderId,encounterId:currentEncounter});
    };
    window.changeSyntheticReplacementContext = kind => {
      if(kind==='actor')session={user:{id:'different-synthetic-actor'}};
      else if(kind==='encounter')currentEncounter='different-synthetic-encounter';
      else if(kind==='cart')prescriptionCartVersion++;
      else if(kind==='selector')$('#rx-encounter').value='';
      else throw Error('Unknown synthetic context mutation');
    };
})();`)});
    for(const kind of ['actor','encounter','cart','selector']) {
      await page.evaluate(options=>window.openSyntheticReplacement(options),
        {actorId,ticketId,oldOrderId,items});
      const staleModal=page.getByRole('dialog',{name:'ตรวจรายการใบสั่งยาทดแทน'});
      await staleModal.getByLabel('เหตุผลการออกใบทดแทน').fill('Synthetic stale reason');
      await page.evaluate(kind=>window.changeSyntheticReplacementContext(kind),kind);
      await staleModal.getByRole('button',{name:'ยืนยันออกใบทดแทน',exact:true}).click();
      await staleModal.getByRole('status').filter({hasText:'บริบท Encounter หรือรายการยาเปลี่ยนแล้ว'}).waitFor();
      assert.equal(writes,0,`${kind}: stale context must not submit`);
      assert.equal(await page.evaluate(()=>sessionStorage.length),0,
        `${kind}: no request journal before a valid context`);
      await staleModal.getByRole('button',{name:'ปิด',exact:true}).click();
      assert.equal(await staleModal.count(),0);
    }
    await page.evaluate(async options=>{
      // Deterministic UUID only in this isolated test, so existing SQL replay
      // assertions can verify the exact browser-issued request.
      crypto.randomUUID=()=>options.requestId;
      await window.openSyntheticReplacement(options);
    },{actorId,ticketId,oldOrderId,requestId,items});
    const modal=page.getByRole('dialog',{name:'ตรวจรายการใบสั่งยาทดแทน'});
    await modal.getByLabel('เหตุผลการออกใบทดแทน').fill('Synthetic replacement reason');
    await modal.getByRole('button',{name:'ยืนยันออกใบทดแทน',exact:true}).click();
    await modal.getByRole('status').filter({hasText:'Synthetic committed response lost'}).waitFor();
    assert.equal(writes,1);
    await load();
    const receipt=await page.evaluate(async options=>{
      const action=CnyosReplacementAction.restore({...options,db:{rpc:replacementRpc}});
      if(!action)throw Error('Missing recovery journal');
      return action.recover();
    },{actorId,ticketId,oldOrderId});
    assert.equal(writes,1);assert.equal(receipt.request_id,requestId);
    assert.equal(await page.evaluate(()=>sessionStorage.length),0);
    console.log('Replacement actual HTML/modal/browser/database passed: real button, real commit, simulated response loss, full document reload, exact read-only recovery. Authenticated bootstrap/full clinical journey remains separate.');
    return receipt;
  } finally {await browser.close();}
}

// Fixed actor + receipt bridge to disposable PGlite. No hosted JWT/API claim.
export async function verifyReplacementAcknowledgement({asUser,pharmacy,receipt,ticket}) {
  const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  let writes=0;
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.route('**/*',route=>route.abort());
    const queueData={};
    for(const [key,table] of Object.entries({products:'products',dispensing:'dispensing_orders',prescriptions:'prescriptions',prescriptionItems:'prescription_items',patients:'patients'})) {
      queueData[key]=(await asUser(pharmacy,`select * from public.${table}`)).rows;
    }
    await page.exposeFunction('syntheticReplacementRpc',async(name,args)=>{
      try {
        let sql;
        if(name==='read_prescription_replacements') {
          assert.equal(args.p_order_id,receipt.new_order_id);
          sql=`select public.read_prescription_replacements('${receipt.new_order_id}') result`;
        } else if(name==='manage_prescription_clarification') {
          assert.equal(args.p_order_id,receipt.new_order_id);
          assert.equal(args.p_action,'history');
          sql=`select public.manage_prescription_clarification('${receipt.new_order_id}',null,'history',null) result`;
        } else {
          assert.equal(name,'manage_prescription_replacement');
          assert.equal(args.p_request_id,receipt.request_id);
          assert.equal(args.p_ticket_id,ticket.id);
          assert.ok(['read','acknowledge'].includes(args.p_action));
          sql=`select public.manage_prescription_replacement('${receipt.request_id}','${ticket.id}','${args.p_action}') result`;
        }
        const result=(await asUser(pharmacy,sql)).rows[0].result;
        if(args.p_action==='acknowledge') {writes++;return {error:{message:'Synthetic lost response after database commit'}};}
        return {data:result};
      } catch(error) {return {error:{message:error.message}};}
    });
    const html=(await fs.readFile(new URL('../../pharmacy.html',import.meta.url),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
    await page.setContent(html);
    await page.addStyleTag({content:await fs.readFile(new URL('../../app.css',import.meta.url),'utf8')});
    await page.evaluate(()=>{document.querySelector('#boot').remove();document.querySelector('#app').classList.remove('hidden');});
    for(const file of ['price-master-client.js','replacement-history.js','clarification-history.js'])
      await page.addScriptTag({content:await fs.readFile(new URL(`../../${file}`,import.meta.url),'utf8')});
    const source=await fs.readFile(new URL('../../pharmacy.js',import.meta.url),'utf8');
    assert.ok(source.includes('  init();\n})();'));
    await page.addScriptTag({content:source.replace('  init();\n})();',`
      session={user:{id:${JSON.stringify(pharmacy)}}};
      db={rpc:window.syntheticReplacementRpc};
      Object.assign(data,${JSON.stringify(queueData)});
      renderPrescriptionQueue();bindActions();
    })();`)});
    await page.locator(`[data-act="rx-clarification-history"][data-id="${receipt.new_order_id}"]`).click();
    await page.getByText(`หมายเหตุใบใหม่: ${receipt.new_snapshot.prescription.clinical_notes || 'ไม่มี'}`,{exact:true}).waitFor();
    const displayed=await page.locator('dialog.clarification-history').textContent();
    for(const item of receipt.new_snapshot.items) {
      assert.ok(displayed.includes(`รหัสยา ${item.product_id}`));
      const product=queueData.products.find(product=>product.id===item.product_id);
      assert.ok(product?.name_th,'Pharmacy must be able to read the prescribed product name');
      assert.ok(displayed.includes(`ชื่อในแค็ตตาล็อกปัจจุบัน: ${product.name_th}`));
      assert.ok(displayed.includes(`คำแนะนำ ${item.instructions || 'ไม่ระบุ'}`));
    }
    await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).click();
    await page.getByRole('button',{name:'ตรวจผลการยืนยันเดิม',exact:true}).click();
    await page.getByText(/ยืนยันและอ่านกลับตรงกันแล้ว/).waitFor();
    assert.equal(writes,1);
    const stored=(await asUser(pharmacy,`select public.manage_prescription_replacement('${receipt.request_id}','${ticket.id}','read') result`)).rows[0].result;
    assert.equal(stored.acknowledged_by,pharmacy);
    assert.ok(stored.acknowledged_at);
    assert.equal(await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'ปิด',exact:true}).click();
    await page.locator(`[data-act="rx-clarification-history"][data-id="${receipt.new_order_id}"]`).click();
    await page.getByText(/ห้องยายืนยันเมื่อ/).waitFor();
    assert.equal(await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).count(),0);
    assert.equal(writes,1,'reopening history must only read stored acknowledgement');
    console.log('Replacement browser/database: actual Pharmacy page/queue/history, role-read catalog names, acknowledgement response loss, read-only recovery, stored actor and reopened decision verified; authentication bootstrap remains a fixture.');
  } finally {await browser.close();}
}
