// SIMULATION_ONLY: isolated browser, synthetic receipts, no external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*',route=>route.abort());
  await page.route('https://replacement-test.invalid/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="th"><body></body></html>'}));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let receipt,writes=0,reads=0;
  await page.exposeFunction('syntheticRpc',async(name,args)=>{
    if(name==='manage_prescription_clarification') {
      assert.equal(args.p_action,'history');
      return {data:{tickets:[{id:'ticket',request_id:'question',order_id:'old',status:'open',question:'Synthetic question'}],next_cursor:null}};
    }
    assert.equal(name,'manage_prescription_replacement');
    if(args.p_action==='replace') {
      writes++;
      receipt={request_id:args.p_request_id,ticket_id:'ticket',old_order_id:'old',actor_id:'doctor',new_rx_id:'new-rx',new_order_id:'new',request_payload:{ticket:'ticket',reason:args.p_reason,notes:args.p_notes,items:args.p_items}};
      return {error:{message:'Synthetic committed response lost'}};
    }
    assert.equal(args.p_action,'read');reads++;
    assert.equal(args.p_request_id,receipt.request_id);
    return {data:receipt};
  });
  const load=async()=>{
    await page.goto('https://replacement-test.invalid/');
    for(const file of ['replacement-action.js','replacement-recovery.js','clarification-history.js']) {
      await page.addScriptTag({content:fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8')});
    }
  };
  await load();
  await page.evaluate(async()=>{
    const action=await CnyosReplacementAction.prepare({db:{rpc:syntheticRpc},actorId:'doctor',ticketId:'ticket',oldOrderId:'old',reason:'Synthetic reason',notes:'Sensitive synthetic draft',items:[{product_id:'synthetic',dose:'Synthetic dose'}]});
    try {await action.submit();} catch {}
  });
  assert.equal(writes,1);
  assert.doesNotMatch(await page.evaluate(()=>JSON.stringify({...sessionStorage})),/Synthetic|Sensitive/);
  await load(); // New document destroys in-memory controller/draft; session marker survives.
  await page.evaluate(()=>CnyosClarificationHistory.open({db:{rpc:syntheticRpc},orderId:'old',actorId:'doctor',mode:'prescriber'}));
  await page.getByRole('button',{name:'ตรวจผลใบสั่งยาทดแทนเดิม',exact:true}).click();
  await page.getByText(/พบใบสั่งยาทดแทนที่บันทึกแล้ว/).waitFor();
  assert.equal(writes,1);
  assert.equal(reads,1);
  assert.equal(await page.evaluate(()=>sessionStorage.length),0);
  assert.equal(await page.getByRole('button',{name:'ตรวจผลใบสั่งยาทดแทนเดิม',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('Replacement recovery browser passed: actual history integration after document reload, metadata-only storage, one synthetic write, read-only recovery and no browser errors. Not live database acceptance.');
} finally {await browser.close();}
