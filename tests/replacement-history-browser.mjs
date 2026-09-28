// Synthetic read-only browser test. All network traffic is blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<main></main>');
  await page.addScriptTag({content:fs.readFileSync(new URL('../replacement-history.js',import.meta.url),'utf8')});
  const mount=async(mode)=>page.evaluate(mode=>{
    document.querySelector('main').replaceChildren();
    const row={request_id:'synthetic',old_order_id:'old',new_order_id:'new',request_payload:{reason:'<img src=x onerror=alert(1)>'},acknowledged_at:null};
    const db={async rpc(name,args){
      if(name!=='read_prescription_replacements'||args.p_order_id!=='old')throw new Error('Unexpected request');
      if(mode==='slow')await new Promise(resolve=>window.releaseReplacement=resolve);
      return mode==='error'?{error:{message:'Synthetic unavailable'}}:{data:{order_id:'old',replacements:mode==='empty'?[]:[{...row,...(mode==='foreign'?{old_order_id:'foreign'}:{})}]}};
    }};
    window.disposeReplacement=window.CnyosReplacementHistory.mount({db,orderId:'old',parent:document.querySelector('main')});
  },mode);
  await mount('valid');
  await page.getByText('ใบนี้ถูกแทนแล้ว — ห้ามจ่ายจากคิวเดิม',{exact:true}).waitFor();
  assert.match(await page.locator('main').textContent(),/ยังรอห้องยายืนยัน/);
  assert.equal(await page.locator('main img').count(),0);
  assert.match(await page.locator('main').textContent(),/<img/);
  for(const mode of ['error','foreign']) {
    await mount(mode);
    await page.getByText(/ตรวจประวัติใบทดแทนไม่ได้/).waitFor();
    assert.doesNotMatch(await page.locator('main').textContent(),/ไม่พบใบทดแทนที่เชื่อม/);
  }
  await mount('empty');
  await page.getByText('ไม่พบใบทดแทนที่เชื่อมกับคิวนี้',{exact:true}).waitFor();
  await mount('slow');
  await page.evaluate(async()=>{window.disposeReplacement();window.releaseReplacement();await Promise.resolve();});
  assert.equal(await page.locator('main').textContent(),'');
  await page.evaluate(()=>{
    const row={request_id:'replacement',ticket_id:'ticket',actor_id:'doctor',old_order_id:'old',new_order_id:'new',
      new_snapshot:{prescription:{clinical_notes:'Synthetic clinical notes'},items:[{product_id:'synthetic-product',quantity_prescribed:1,unit:'unit',dose:'synthetic dose',instructions:'Synthetic instruction <img src=x>'}]},acknowledged_at:null};
    window.replacementWrites=0;
    const db={async rpc(name,args){
      if(name==='read_prescription_replacements')return {data:{order_id:'new',replacements:[row]}};
      if(args.p_request_id!=='replacement'||args.p_ticket_id!=='ticket')throw new Error('Wrong receipt');
      if(args.p_action==='acknowledge'){
        window.replacementWrites++;row.acknowledged_by='pharmacy';row.acknowledged_at='synthetic-time';
        throw new Error('Synthetic committed response lost');
      }
      if(args.p_action!=='read')throw new Error('Unexpected action');
      return {data:row};
    }};
    window.CnyosReplacementHistory.mount({db,orderId:'new',parent:document.querySelector('main'),mode:'pharmacy',actorId:'pharmacy',productLabel:id=>id==='synthetic-product'?'Synthetic medicine <img src=x>':null});
  });
  await page.getByText('หมายเหตุใบใหม่: Synthetic clinical notes',{exact:true}).waitFor();
  await page.getByText('ชื่อในแค็ตตาล็อกปัจจุบัน: Synthetic medicine <img src=x>',{exact:true}).waitFor();
  assert.match(await page.locator('main').textContent(),/รหัสยา synthetic-product/);
  await page.getByText(/คำแนะนำ Synthetic instruction <img src=x>/).waitFor();
  assert.equal(await page.locator('main img').count(),0);
  await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).click();
  await page.getByRole('button',{name:'ตรวจผลการยืนยันเดิม',exact:true}).click();
  await page.getByText(/ยืนยันและอ่านกลับตรงกันแล้ว/).waitFor();
  assert.equal(await page.evaluate(()=>window.replacementWrites),1);
  assert.equal(await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).isDisabled(),true);
  for(const invalid of [null,{}, {product_id:'p',quantity_prescribed:0,unit:'unit'},
    {product_id:'p',quantity_prescribed:'1',unit:'unit'},
    {product_id:'p',quantity_prescribed:1,unit:'unit',instructions:{text:'invalid'}}]) {
    await page.evaluate(item=>{
      document.querySelector('main').replaceChildren();
      const row={request_id:'r',ticket_id:'t',actor_id:'doctor',old_order_id:'old',new_order_id:'new',new_snapshot:{items:[item]}};
      CnyosReplacementHistory.mount({db:{rpc:async()=>({data:{order_id:'new',replacements:[row]}})},orderId:'new',parent:document.querySelector('main'),mode:'pharmacy',actorId:'pharmacy'});
    },invalid);
    await page.getByText(/รายการใบใหม่ไม่ครบหรืออ่านไม่ได้/).waitFor();
    assert.equal(await page.getByRole('button',{name:'ยืนยันรับทราบใบทดแทน',exact:true}).count(),0);
  }
  console.log('Replacement history browser passed: order-linked display, pending acknowledgement, escaped reason, failure distinct from empty and disposed response ignored.');
} finally {await browser.close();}
