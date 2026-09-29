// SIMULATION_ONLY: real markup/handlers, mocked API and blocked outbound traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const read=name=>fs.readFile(new URL('../'+name,import.meta.url),'utf8');
const html=(await read('production.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
const source=await read('production.js');
const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  for(const [formId,rpcName] of [['formula-form','upsert_production_formula'],['component-form','upsert_production_formula_component'],['complete-form','complete_production_order']]) {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const errors=[],dialogs=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>{dialogs.push(d.message());return d.dismiss();});
    await page.route('**/*',r=>r.abort());
    await page.route('https://production-synthetic.invalid/',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://production-synthetic.invalid/');
    await page.addStyleTag({content:await read('app.css')});
    await page.addScriptTag({content:source.replace('  init();\n})();',`
      persistenceReady=true;session={user:{id:'synthetic-producer'}};profile={id:'synthetic-producer'};
      data.products=[{id:'synthetic-product',stock_unit:'bottle'},{id:'synthetic-material',stock_unit:'g'}];
      data.orders=[{id:'synthetic-order',production_order_no:'SIMULATION_ONLY',planned_quantity:10,planned_unit:'bottle'}];
      window.syntheticRequests=[];
      db={rpc(name,payload){window.syntheticRequests.push({name,payload});return new Promise(resolve=>{window.finishSyntheticWrite=()=>resolve({data:{id:'synthetic-receipt'}});});}};
      load=async()=>{throw new Error('SIMULATION_ONLY refresh failure');};
      window.openSyntheticCompletion=()=>openCompleteDialog('synthetic-order');
      $('#boot').classList.add('hidden');$('#app').classList.remove('hidden');
    })();`)});
    if(formId==='complete-form') {
      await page.evaluate(()=>window.openSyntheticCompletion());
      await page.locator('#complete-actual').fill('9');
    } else {
      await page.locator('[data-view="formulas"]').click();
      await page.evaluate(()=>{
        for(const [id,value] of [['f-product','synthetic-product'],['c-formula','synthetic-formula'],['c-material','synthetic-material']]) {
          const select=document.getElementById(id);select.append(new Option('SIMULATION_ONLY',value));select.value=value;select.dispatchEvent(new Event('change'));
        }
      });
      if(formId==='formula-form') {
        await page.locator('#f-code').fill('SYNTHETIC-FORMULA');
        await page.locator('#f-name').fill('Synthetic formula only');
        await page.locator('#f-batch').fill('10');
        assert.equal(await page.locator('#f-unit').inputValue(),'bottle');
        assert.equal(await page.locator('#f-unit').getAttribute('readonly'),'');
      } else await page.locator('#c-qty').fill('20');
    }
    const button=page.locator('#'+formId+' button:not([type="button"])');
    await button.click();
    assert.equal(await button.isDisabled(),true);
    await page.evaluate(id=>document.getElementById(id).requestSubmit(),formId);
    const requests=await page.evaluate(()=>window.syntheticRequests);
    assert.equal(requests.length,1);
    assert.equal(requests[0].name,rpcName);
    await page.evaluate(()=>window.finishSyntheticWrite());
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('โหลดรายการล่าสุดไม่สำเร็จ'));
    assert.equal(await button.isEnabled(),true);
    if(formId==='complete-form')assert.equal(await page.locator('#complete-dialog').isVisible(),false);
    else assert.equal(await page.locator(formId==='formula-form'?'#f-code':'#c-qty').inputValue(),'');
    assert.match(await page.locator('#toast').textContent(),/แล้ว.*โหลดรายการล่าสุดไม่สำเร็จ/);
    assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('SIMULATION_ONLY Production browser passed: three real mobile forms, duplicate-submit suppression, native event lifetime, preserved derived unit, reset/close after acknowledgement and truthful refresh failure. No persistence claim.');
} finally {await browser.close();}
