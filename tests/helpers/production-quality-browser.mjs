import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Actual page handlers/rendering with an explicit test-only SQL bridge.
// Authentication is injected; no Supabase REST, live credentials or network.
export async function productionQualityBrowser({query,producer,quality,clinic,requestId,finishedId,materialId}) {
  let orderId;
  const read=name=>fs.readFile(new URL('../../'+name,import.meta.url),'utf8');
  const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
  const errors=[],dialogs=[],writes=[];
  const tables=new Set(['products','inventory_lots','formulas','formula_components','production_requests','production_orders','production_material_issues','production_qc','finished_goods_receipts']);
  const literal=value=>value==null?'null':`'${String(value).replaceAll("'","''")}'`;
  const rpcKeys={complete_production_order:['p_production_order_id','p_actual_quantity','p_loss_quantity','p_waste_quantity'],quality_release_production_order:['p_production_order_id','p_result_summary','p_sample_reference','p_appearance_result','p_moisture_result','p_water_activity_result','p_weight_result']};
  rpcKeys.upsert_production_formula=['p_formula_id','p_formula_code','p_revision','p_name_th','p_finished_product_id','p_standard_batch_size','p_batch_unit','p_expected_yield_percent','p_shelf_life_days','p_manufacturing_instructions','p_status'];
  rpcKeys.upsert_production_formula_component=['p_component_id','p_formula_id','p_material_product_id','p_sequence_no','p_quantity_per_batch','p_unit','p_process_stage','p_notes'];
  rpcKeys.open_production_order=['p_request_id','p_formula_id','p_planned_quantity'];
  rpcKeys.issue_production_materials_fefo=['p_production_order_id'];
  async function open(module,actor) {
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',async dialog=>{
      if(dialog.type()==='confirm' && dialog.message().startsWith('ยืนยันเบิกวัตถุดิบตาม FEFO')) return dialog.accept();
      dialogs.push(dialog.message());await dialog.dismiss();
    });
    await page.route('**/*',route=>route.abort());
    const origin=`https://${module}-database-test.invalid/`;
    const html=(await read(module+'.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
    await page.route(origin,route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto(origin);
    await page.addStyleTag({content:await read('app.css')});
    await page.exposeFunction('testDatabase',async(operation,name,payload)=>{
      try {
        if(operation==='read') {
          assert.ok(tables.has(name));
          return {data:query(actor,`select coalesce(jsonb_agg(t),'[]') from public.${name} t`)};
        }
        assert.equal(operation,'rpc');assert.ok(Object.hasOwn(rpcKeys,name));
        if(Object.hasOwn(payload,'p_production_order_id')) assert.equal(payload.p_production_order_id,orderId);
        assert.equal(actor,name==='quality_release_production_order'?quality:producer);
        writes.push(name);
        return {data:query(actor,`select to_jsonb(public.${name}(${rpcKeys[name].map(key=>literal(payload[key])).join(',')}))`)};
      } catch(error) {return {error:{message:error.message}};}
    });
    const source=await read(module+'.js');
    assert.ok(source.includes('  init();\n})();'));
    await page.addScriptTag({content:source.replace('  init();\n})();',`
      session={user:{id:${JSON.stringify(actor)}}};profile={id:${JSON.stringify(actor)},clinic_id:${JSON.stringify(clinic)}};
      ${module==='production'?'persistenceReady=true;':''}
      db={from(table){return {select(){return this},order(){return this},then(resolve,reject){return (window.testReadFailure?Promise.resolve({error:{message:'SYNTHETIC_READ_FAILURE'}}):window.testDatabase('read',table)).then(resolve,reject)}}},rpc(name,args){return window.testDatabase('rpc',name,args)}};
      $('#boot').classList.add('hidden');$('#app').classList.remove('hidden');
      window.testLoad=load;window.testReady=load();
    })();`)});
    await page.evaluate(()=>window.testReady);
    return page;
  }
  try {
    const production=await open('production',producer);
    await production.locator('[data-view="formulas"]').click();
    await production.locator('#f-code').fill('BROWSER-FORMULA');
    await production.locator('#f-name').fill('Synthetic browser formula');
    await production.locator('#f-product').selectOption(finishedId);
    await production.locator('#f-batch').fill('10');
    await production.locator('#f-status').selectOption('approved');
    assert.equal(await production.locator('#f-unit').inputValue(),'ชิ้น');
    await production.locator('#formula-form').getByRole('button').click();
    await production.waitForFunction(()=>document.querySelector('#f-code').value==='');
    await production.evaluate(()=>window.testLoad());
    const formula=query(producer,"select to_jsonb(f) from public.formulas f where formula_code='BROWSER-FORMULA'");
    assert.equal(formula.finished_product_id,finishedId);
    await production.locator('#c-formula').selectOption(formula.id);
    await production.locator('#c-material').selectOption(materialId);
    await production.locator('#c-qty').fill('5');
    assert.equal(await production.locator('#c-unit').inputValue(),'ชิ้น');
    await production.locator('#component-form').getByRole('button').click();
    await production.waitForFunction(()=>document.querySelector('#c-qty').value==='');
    await production.evaluate(()=>window.testLoad());
    await production.locator('[data-view="queue"]').click();
    await production.locator(`[data-act="open-order"][data-id="${requestId}"]`).click();
    await production.waitForFunction(()=>document.querySelector('[data-act="issue"]'));
    const order=query(producer,`select to_jsonb(o) from public.production_orders o where production_request_id=${literal(requestId)}`);
    orderId=order.id;assert.equal(order.formula_id,formula.id);
    const lotState=()=>query(producer,`select jsonb_agg(to_jsonb(l) order by id) from public.inventory_lots l where product_id=${literal(materialId)}`);
    const beforeIssue=lotState();
    const shortageAlert=production.waitForEvent('dialog',dialog=>dialog.type()==='alert');
    await production.locator(`[data-act="issue"][data-id="${orderId}"]`).click();
    assert.match((await shortageAlert).message(),/ไม่เพียงพอ.*ยกเลิกการเบิกทั้งหมด/);
    assert.deepEqual(lotState(),beforeIssue,'shortage must not partially change any lot');
    assert.equal(query(producer,`select to_jsonb(count(*)) from public.production_material_issues where production_order_id=${literal(orderId)}`),0);
    assert.equal(query(producer,`select to_jsonb(status) from public.production_orders where id=${literal(orderId)}`),'planned');
    // Correct this synthetic BOM through its real form, retaining one component.
    await production.locator('[data-view="formulas"]').click();
    await production.locator('#c-formula').selectOption(formula.id);
    await production.locator('#c-material').selectOption(materialId);
    await production.locator('#c-qty').fill('2');
    await production.locator('#component-form').getByRole('button').click();
    await production.waitForFunction(()=>document.querySelector('#c-qty').value==='');
    await production.evaluate(()=>window.testLoad());
    assert.equal(query(producer,`select to_jsonb(count(*)) from public.formula_components where formula_id=${literal(formula.id)}`),1);
    await production.locator('[data-view="queue"]').click();
    await production.locator(`[data-act="issue"][data-id="${orderId}"]`).click();
    await production.locator(`[data-act="complete"][data-id="${orderId}"]`).waitFor();
    await production.locator(`[data-act="complete"][data-id="${orderId}"]`).click();
    await production.locator('#complete-actual').fill('9');
    await production.locator('#complete-loss').fill('1');
    await production.locator('#complete-form').getByRole('button',{name:'บันทึกและส่ง QC'}).click();
    await production.locator('#complete-dialog').waitFor({state:'hidden'});
    assert.equal(query(producer,`select to_jsonb(status) from public.production_orders where id=${literal(orderId)}`),'awaiting_qc');
    const inspector=await open('quality',quality);
    assert.match(await inspector.locator('#quality-queue').textContent(),/Synthetic QC product/);
    await inspector.locator(`[data-quality-act="release"][data-id="${orderId}"]`).click();
    await inspector.locator('#qc-summary').fill('Synthetic browser independent QC result');
    await inspector.locator('#qc-sample').fill('SYNTHETIC-SAMPLE');
    await inspector.locator('#release-form button[type="submit"]').click();
    await inspector.locator('#release-dialog').waitFor({state:'hidden'});
    await inspector.evaluate(()=>window.testLoad());
    const pendingDownload=inspector.waitForEvent('download');
    await inspector.locator(`[data-quality-report="${orderId}"]`).click();
    const report=await fs.readFile(await (await pendingDownload).path(),'utf8');
    assert.match(report,/Synthetic browser independent QC result/);
    assert.match(report,/ไม่ใช่ COA ที่รับรองภายนอก/);
    await inspector.close();
    const reopened=await open('quality',quality);
    assert.equal(await reopened.locator(`[data-quality-report="${orderId}"]`).count(),1);
    await production.evaluate(async()=>{window.testReadFailure=true;try{await window.testLoad();}catch(error){if(error.message!=='SYNTHETIC_READ_FAILURE')throw error;}});
    assert.equal(await production.locator('[data-act]').count(),0);
    assert.equal(await production.locator('#f-product option, #c-material option, #c-formula option').count(),0);
    assert.match(await production.locator('#order-list').textContent(),/ยังอ่านข้อมูลการผลิตล่าสุดไม่ได้/);
    await production.evaluate(async()=>{window.testReadFailure=false;await window.testLoad();});
    assert.ok(await production.locator('#f-product option').count()>1);
    assert.deepEqual(writes,['upsert_production_formula','upsert_production_formula_component','open_production_order','issue_production_materials_fefo','upsert_production_formula_component','issue_production_materials_fefo','complete_production_order','quality_release_production_order']);
    assert.deepEqual(errors,[]);assert.equal(dialogs.length,1);assert.match(dialogs[0],/ไม่เพียงพอ.*ยกเลิกการเบิกทั้งหมด/);
    console.log('Production → Quality mobile browser/native SQL passed: formula/BOM creation, request/order, FEFO issue, completion, independent release, report download and reopened readback. Authentication injected; no hosted/live acceptance.');
    return orderId;
  } finally {await browser.close();}
}
