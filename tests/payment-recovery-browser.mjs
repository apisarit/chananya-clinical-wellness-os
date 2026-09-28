// SIMULATION_ONLY: real page markup/handlers, in-memory API, no external traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.route('https://cnyos-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cnyos-simulation.invalid/');
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'function', 'secure-context UUID generation is required');
  await page.addStyleTag({ content: fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    document.querySelector('#boot').classList.add('hidden');
    document.querySelector('#app').classList.remove('hidden');
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelector('#billing').classList.add('active');
    document.querySelector('#pay-invoice').innerHTML = '<option value="simulation-invoice">SIMULATION_ONLY Invoice</option>';
    document.querySelector('#pay-amount').value = '650';
    document.querySelector('#pay-note').value = 'SIMULATION_ONLY';
  });
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(source.includes('  init();\n})();'), 'fixture injection point changed');
  await page.addScriptTag({ content: source.replace('  init();\n})();', `
    atomicHandoffsReady=true;
    session={user:{id:'synthetic-actor'}};profile={clinic_id:'synthetic-clinic'};
    // This suite isolates presentation. The browser/database suite uses the real journal.
    const simulatedRequestId=crypto.randomUUID();
    window.CnyosPaymentJournal={async prepare(){return {requestId:simulatedRequestId};},async recover(){}};
    data.invoices=[{id:'simulation-invoice',balance_due:650}];
    window.simulatedPaymentRequests=[];
    db={
      async rpc(name,payload){
        if(name!=='record_atomic_invoice_payment')throw new Error('UNEXPECTED_SIMULATION_RPC');
        window.simulatedPaymentRequests.push({...payload});
        if(window.simulatedPaymentRequests.length===1)throw new Error('SIMULATION_ONLY response lost');
        return {data:[{payment_id:'simulation-payment',balance_due:0,encounter_closed:window.simulatedEncounterClosed}]};
      },
      from(table){
        if(table!=='payments')throw new Error('UNEXPECTED_SIMULATION_TABLE');
        return {select(){return this},eq(){return this},async single(){return {data:{id:'simulation-payment',invoice_id:'simulation-invoice',amount:650,payment_reference:'SIMULATION_ONLY'}}}};
      }
    };
    loadAll=async()=>{};
    window.receiptFixture=async(patch={})=>{
      data.patients=[{id:'synthetic-patient',first_name:'Synthetic',last_name:'Only'}];
      data.invoices=[{id:'simulation-invoice',patient_id:'synthetic-patient',invoice_number:'INV-SYNTHETIC'}];
      data.payments=[{id:'simulation-payment',invoice_id:'simulation-invoice',amount:650,status:'paid',channel:'cash',payment_reference:'PAY-SYNTHETIC',paid_at:'2026-09-27T01:00:00Z',...patch}];
      db.from=table=>({select(){return this},eq(_field,id){this.id=id;return this},async single(){
        window.receiptReads=(window.receiptReads||0)+1;
        if(window.receiptReadFailure===table)return {error:{message:'Synthetic read failure'}};
        return {data:data[table].find(row=>row.id===this.id)};
      }});
      try {await showReceipt('simulation-payment');return null;} catch(error){return error.message;}
    };
    window.receiptRace=async(changeActor=false)=>{
      window.receiptReadFailure=null;
      await window.receiptFixture();
      const first={...data.payments[0],id:'old-payment',payment_reference:'OLD-REFERENCE'};
      const second={...first,id:'new-payment',payment_reference:'NEW-REFERENCE'};
      let release;
      const held=new Promise(resolve=>release=resolve);
      db.from=table=>({select(){return this},eq(_field,id){this.id=id;return this},async single(){
        if(table==='payments'&&this.id==='old-payment'){await held;return {data:first};}
        if(table==='payments')return {data:second};
        return {data:data[table].find(row=>row.id===this.id)};
      }});
      const older=showReceipt('old-payment',true);
      if(changeActor) session={user:{id:'different-synthetic-actor'}};
      else await showReceipt('new-payment');
      release();await older;
    };
  })();`) });
  assert.equal(await page.locator('#payment-recovery').isVisible(), false);
  await page.locator('#payment-form button').click();
  await page.locator('#payment-recovery').waitFor({ state: 'visible' });
  assert.match(await page.locator('#payment-recovery-message').textContent(), /650/);
  assert.equal(await page.locator('#payment-retry').isEnabled(), true);
  // Simulate a refreshed list dropping an already-paid invoice. The type=button
  // recovery path must work even though native form required fields are empty.
  await page.evaluate(() => { document.querySelector('#pay-invoice').innerHTML=''; });
  await page.locator('#pay-amount').fill('');
  await page.locator('#payment-retry').focus();
  await page.keyboard.press('Enter');
  await page.locator('#payment-recovery').waitFor({ state: 'hidden' });
  const requests = await page.evaluate(() => window.simulatedPaymentRequests);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.match(await page.locator('#toast').textContent(), /รับชำระครบแล้ว/);
  assert.doesNotMatch(await page.locator('#toast').textContent(), /ปิด Encounter แล้ว/);
  for(const closed of [false,'true',true]) {
    await page.evaluate(closed=>{
      window.simulatedEncounterClosed=closed;
      document.querySelector('#pay-invoice').innerHTML='<option value="simulation-invoice">SIMULATION_ONLY Invoice</option>';
    },closed);
    await page.locator('#pay-amount').fill('650');
    const before=await page.evaluate(()=>window.simulatedPaymentRequests.length);
    await page.locator('#payment-form button').click();
    await page.waitForFunction(before=>window.simulatedPaymentRequests.length===before+1,before);
    await page.waitForFunction(()=>document.querySelector('#pay-amount').value==='');
    const message=await page.locator('#toast').textContent();
    if(closed===true) assert.match(message,/ปิด Encounter แล้ว/);
    else {assert.match(message,/รับชำระครบแล้ว/);assert.doesNotMatch(message,/ปิด Encounter แล้ว/);}
  }
  assert.equal(await page.evaluate(()=>window.receiptFixture()),null);
  assert.equal(await page.locator('#receipt-dialog').isVisible(),true);
  assert.match(await page.locator('#receipt-body').textContent(),/PAY-SYNTHETIC/);
  await page.evaluate(()=>{window.print=()=>{window.syntheticPrintCalled=true;window.dispatchEvent(new Event('afterprint'));};});
  await page.locator('#receipt-print').click();
  await page.waitForFunction(()=>window.syntheticPrintCalled===true);
  assert.equal(await page.evaluate(()=>window.syntheticPrintCalled),true);
  assert.equal(await page.evaluate(()=>window.receiptReads),6,'display and print each read current payment/invoice/patient');
  assert.equal(await page.evaluate(()=>document.body.classList.contains('receipt-printing')),false);
  await page.evaluate(()=>{window.print=()=>{throw new Error('SYNTHETIC_PRINT_FAILURE');};});
  await page.locator('#receipt-print').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('พิมพ์ใบรับเงินไม่สำเร็จ'));
  assert.equal(await page.evaluate(()=>document.body.classList.contains('receipt-printing')),false,'failed print must restore normal print layout');
  assert.equal(await page.locator('#receipt-dialog').isVisible(),true,'keep verified receipt available for retry');
  const paymentWritesBeforeRetry=await page.evaluate(()=>window.simulatedPaymentRequests.length);
  await page.evaluate(()=>{window.syntheticPrintCalled=false;window.print=()=>{window.syntheticPrintCalled=true;window.dispatchEvent(new Event('afterprint'));};});
  await page.locator('#receipt-print').click();
  await page.waitForFunction(()=>window.syntheticPrintCalled===true);
  assert.equal(await page.evaluate(()=>window.simulatedPaymentRequests.length),paymentWritesBeforeRetry,'retry printing must not receive payment again');
  assert.equal(await page.evaluate(()=>document.body.classList.contains('receipt-printing')),false);
  for(const patch of [{status:'pending'},{status:'failed'},{payment_reference:''},{paid_at:null},{amount:0},{amount:'NaN'}]) {
    assert.match(await page.evaluate(patch=>window.receiptFixture(patch),patch),/ยังแสดงใบรับเงินไม่ได้/);
    assert.equal(await page.locator('#receipt-dialog').isVisible(),false);
    assert.equal(await page.locator('#receipt-body').textContent(),'');
  }
  for(const table of ['payments','invoices','patients']) {
    await page.evaluate(table=>window.receiptReadFailure=table,table);
    assert.match(await page.evaluate(()=>window.receiptFixture()),/ยังตรวจข้อมูลใบรับเงินไม่ได้/);
    assert.equal(await page.locator('#receipt-dialog').isVisible(),false);
    assert.equal(await page.locator('#receipt-body').textContent(),'');
  }
  await page.evaluate(()=>{window.syntheticPrintCalled=false;});
  await page.evaluate(()=>window.receiptRace());
  assert.match(await page.locator('#receipt-body').textContent(),/NEW-REFERENCE/);
  assert.doesNotMatch(await page.locator('#receipt-body').textContent(),/OLD-REFERENCE/);
  assert.equal(await page.evaluate(()=>window.syntheticPrintCalled),false,'superseded print request must not print');
  await page.evaluate(()=>window.receiptRace(true));
  assert.equal(await page.locator('#receipt-dialog').isVisible(),false);
  assert.equal(await page.locator('#receipt-body').textContent(),'');
  assert.equal(await page.evaluate(()=>window.syntheticPrintCalled),false,'previous actor response must not print');
  assert.deepEqual(errors, []);
  console.log('SIMULATION_ONLY payment recovery browser passed: mobile form, visible warning, keyboard retry with empty required fields, exact request reuse, receipt print-failure cleanup and read-only print retry; no persistence claim');
} finally {
  await browser.close();
}
