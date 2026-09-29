// SIMULATION_ONLY: real markup, journal and click handlers; no hosted writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage(), errors = [], messages = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { messages.push(d.message()); await d.dismiss(); });
  await page.route('https://cnyos-simulation.invalid/', route => route.fulfill({ contentType: 'text/html', body: read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '') }));
  await page.goto('https://cnyos-simulation.invalid/');
  await page.addStyleTag({ content: read('app.css') });
  await page.addScriptTag({ content: read('service-invoice-journal.js') });
  await page.evaluate(async () => {
    document.querySelector('#boot').classList.add('hidden');
    document.querySelector('#app').classList.remove('hidden');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelector('#billing').classList.add('active');
    window.fixture = { actorId: crypto.randomUUID(), clinicId: crypto.randomUUID(), encounterId: crypto.randomUUID(), invoiceId: crypto.randomUUID(), mode: 'missing', writes: [] };
    window.fixture.marker = await window.CnyosServiceInvoiceJournal.prepare({ ...window.fixture, amount: 487.5, description: 'Synthetic 45 minute session' });
    window.ChananyaRuntime = { can: () => true };
  });
  const source = read('app.js');
  assert.ok(source.includes('  init();\n})();'));
  await page.addScriptTag({ content: source.replace('  init();\n})();', `
    const f=window.fixture;
    session={user:{id:f.actorId}};profile={clinic_id:f.clinicId};
    loadAll=async()=>{};
    db={async rpc(name,args){
      if(name==='quote_treatment_invoice')return {data:{amount:f.mode==='changed'?500:487.5,description:'Synthetic 45 minute session'}};
      if(name!=='issue_atomic_treatment_invoice')throw new Error('Unexpected synthetic RPC');
      f.writes.push(args);return {data:[{invoice_id:f.invoiceId}]};
    },from(table){const q={select(){return q},eq(){return q},single(){return run()},then(ok,bad){return run().then(ok,bad)}};
      async function run(){
        if(f.mode==='missing')return {data:null};
        if(table==='invoices')return {data:{id:f.invoiceId,encounter_id:f.encounterId,created_by:f.actorId,source_service_request_key:f.marker.requestId,grand_total:'487.50'}};
        if(table==='encounters')return {data:{id:f.encounterId,clinic_id:f.clinicId}};
        if(table==='invoice_items')return {data:[{invoice_id:f.invoiceId,item_type:'service',quantity:'0.750000000000',unit_price:'650.00',line_total:'487.50',description:'Synthetic 45 minute session'}]};
        throw new Error('Unexpected synthetic table');
      }return q;
    }};
    window.restoreFixture=restoreSavedServiceInvoice;
    restoreSavedServiceInvoice();
  })();`) });
  const recover = page.locator('#service-invoice-recover'), resume = page.locator('#service-invoice-resume');
  assert.equal(await recover.isVisible(), true);
  await recover.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#service-invoice-recover').disabled);
  assert.match(messages.pop(), /ยังไม่พบบิลเดิม/);
  assert.equal(await recover.isVisible(), true);
  await page.evaluate(() => { window.fixture.mode='changed'; });
  await resume.click();
  await page.waitForFunction(() => !document.querySelector('#service-invoice-resume').disabled);
  assert.match(messages.pop(), /ราคาหรือรายการบริการเปลี่ยน/);
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 0);
  await page.evaluate(() => { window.fixture.mode='valid'; });
  await recover.click();
  await page.locator('#service-invoice-recovery').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 0);
  await page.evaluate(async () => {
    window.fixture.marker=await window.CnyosServiceInvoiceJournal.prepare({ ...window.fixture, amount:487.5,description:'Synthetic 45 minute session' });
    window.restoreFixture();
  });
  await resume.focus(); await page.keyboard.press('Enter');
  await page.locator('#service-invoice-recovery').waitFor({ state:'hidden' });
  const result=await page.evaluate(()=>({writes:window.fixture.writes,key:window.fixture.marker.requestId}));
  assert.equal(result.writes.length,1);
  assert.equal(result.writes[0].p_request_key,result.key);
  assert.equal(result.writes[0].p_amount,487.5);
  assert.deepEqual(errors,[]);
  console.log('Service invoice browser passed: mobile keyboard/click recovery, missing receipt retained, changed quote explained, zero-write recovery and same-key resume. SIMULATION_ONLY.');
} finally { await browser.close(); }
