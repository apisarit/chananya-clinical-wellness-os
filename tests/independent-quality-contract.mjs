import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/202608270700_independent_quality_release.sql');
const runtime = read('chananya-runtime.js');
const shell = read('app-shell.js');
const production = read('production.js');
const productionHtml = read('production.html');
const quality = read('quality.js');
const qualityHtml = read('quality.html');

assert.match(migration, /^begin;/i, 'Quality migration must be atomic');
assert.match(migration, /commit;\s*\n\s*select/i, 'Quality migration must commit before its verification query');
assert.match(migration, /clinic_role in[\s\S]*?'quality'/i, 'database role constraints must include Quality');
assert.match(migration, /when p_capability = 'quality' then\s+public\.current_department_role\(\) = 'quality'/i, 'database authorization must define a dedicated Quality capability');
assert.match(migration, /revoke execute on function public\.release_production_order[\s\S]*?from authenticated/i, 'legacy combined release must be disabled');
assert.match(migration, /revoke execute on function public\.reject_production_order[\s\S]*?from authenticated/i, 'legacy combined reject must be disabled');

for (const rpc of ['quality_release_production_order', 'quality_reject_production_order', 'quality_release_healthcheck']) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\b`, 'i'), `${rpc} must exist`);
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\b`, 'i'), `${rpc} must be explicitly revoked`);
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\b`, 'i'), `${rpc} must be explicitly granted`);
}

assert.match(migration, /QC_INDEPENDENCE_REQUIRED/);
assert.match(migration, /v_order\.produced_by = auth\.uid\(\)/i, 'producer and Quality approver must be different identities');
assert.match(migration, /PRODUCTION_OPERATOR_EVIDENCE_REQUIRED/);
assert.match(migration, /create or replace function public\.assign_inventory_lot_clinic[\s\S]*?department_can\('inventory'\) or public\.department_can\('quality'\)/i, 'Quality release may pass only the tenant-assignment lot trigger');
assert.match(migration, /create or replace function public\.assign_stock_movement_clinic[\s\S]*?department_can\('inventory'\) or public\.department_can\('quality'\)/i, 'Quality release may pass only the tenant-assignment stock trigger');
assert.match(migration, /'separation_of_duties',true/i, 'release audit must record separation of duties');
assert.match(migration, /'produced_by',v_order\.produced_by/i);
assert.match(migration, /'quality_released_by',auth\.uid\(\)/i);
assert.ok((migration.match(/security definer/gi) || []).length >= 3, 'Quality writes must run behind trusted functions');
assert.ok((migration.match(/for update/gi) || []).length >= 4, 'Quality workflow must lock authoritative rows');

assert.match(runtime, /quality_operate: \['super_admin','quality'\]/);
assert.match(shell, /href: '\/quality\.html'[\s\S]*?capability: 'quality_operate'/);
assert.match(quality, /runtime\.can\(profile, 'quality_operate'\)/);
assert.match(quality, /rpc\('quality_release_production_order'/);
assert.match(quality, /rpc\('quality_reject_production_order'/);
assert.match(quality, /rpc\('quality_release_healthcheck'/);
assert.doesNotMatch(quality, /query\('(?:patients|patient_allergies|appointments|encounters|prescriptions|prescription_items|dispensing_orders)'/, 'Quality must not load patient or treatment domains');
assert.doesNotMatch(quality, /\.from\(['"](?:production_orders|production_qc|finished_goods_receipts|inventory_lots|stock_movements)['"]\)\.(?:insert|update|delete|upsert)\s*\(/, 'Quality browser must be RPC-only');
assert.match(qualityHtml, /Independent Quality release/);
assert.match(qualityHtml, /ไม่เห็น HN ผู้รับบริการ/);
assert.doesNotMatch(production, /rpc\('(?:release_production_order|reject_production_order|quality_release_production_order|quality_reject_production_order)'/, 'Production cannot make Quality decisions');
assert.doesNotMatch(productionHtml, /id="release-dialog"|id="reject-dialog"/);
assert.match(productionHtml, /ไม่มีสิทธิ์ปล่อยผ่าน Batch ของตนเอง/);

const reportSource = quality.slice(quality.indexOf('  function qualityReport('), quality.indexOf('  async function downloadQualityReport('));
const guardContext = {num: value => Number(value || 0),session:null,errors:{
  QC_INDEPENDENCE_REQUIRED:'independent reviewer required',
  PRODUCTION_OPERATOR_EVIDENCE_REQUIRED:'missing production evidence',
  PRODUCTION_ORDER_NOT_AWAITING_QC:'not awaiting QC'
}};
vm.runInNewContext(quality.slice(quality.indexOf('  function reviewBlockReason('), quality.indexOf('  function render()'))
  + '; this.reason = reviewBlockReason;', guardContext);
const pending = {status:'awaiting_qc',produced_by:'producer',actual_quantity:10};
assert.equal(guardContext.reason(pending,'producer'),'independent reviewer required');
assert.equal(guardContext.reason(pending,'reviewer'),'');
assert.equal(guardContext.reason({...pending,produced_by:null},'reviewer'),'missing production evidence');
assert.equal(guardContext.reason({...pending,actual_quantity:0},'reviewer'),'missing production evidence');
assert.equal(guardContext.reason({...pending,status:'released'},'reviewer'),'not awaiting QC');
assert.match(guardContext.reason(pending),/เข้าสู่ระบบ/);
assert.match(quality,/const blockedReason = reviewBlockReason\(selected\)/);
const decisionNodes = new Map();
const decisionButtons = [{disabled:false},{disabled:false}];
const decisionContext = {decisionPending:false,activeOrderId:'synthetic',order:()=>pending,
  session:{user:{id:'synthetic-reviewer'}},profile:{clinic_id:'synthetic-clinic'},
  reviewBlockReason:()=>'',toast(){},load:async()=>{throw new Error('synthetic refresh failed');},
  $$:()=>decisionButtons,$:selector=>{
    if(!decisionNodes.has(selector)) decisionNodes.set(selector,{textContent:'',close(){this.closed=true;}});
    return decisionNodes.get(selector);
  }};
vm.runInNewContext(quality.slice(quality.indexOf('  async function saveDecision('),quality.indexOf('  async function release('))
  + '; this.save = saveDecision;',decisionContext);
let finishWrite, writeCount=0;
const writing=decisionContext.save('#release-dialog',()=>{writeCount++;return new Promise(resolve=>{finishWrite=resolve;});},'บันทึกสำเร็จ');
assert.equal(decisionContext.decisionPending,true);
assert.ok(decisionButtons.every(button=>button.disabled));
await decisionContext.save('#release-dialog',async()=>{writeCount++;},'duplicate');
assert.equal(writeCount,1);
finishWrite(); await writing;
assert.equal(decisionContext.decisionPending,false);
assert.ok(decisionButtons.every(button=>!button.disabled));
assert.equal(decisionNodes.get('#release-dialog').closed,true);
assert.match(decisionNodes.get('#quality-action-status').textContent,/บันทึกสำเร็จ.*โหลดรายการล่าสุดไม่สำเร็จ/);
await assert.rejects(decisionContext.save('#reject-dialog',async()=>{throw new Error('write rejected');},'success'),/write rejected/);
assert.match(decisionNodes.get('#quality-action-status').textContent,/ยังยืนยันผลการบันทึกไม่ได้/);
assert.equal(decisionContext.decisionPending,false);
assert.match(qualityHtml,/id="quality-action-status"[^>]*role="status"/);
for (const identity of ['session', 'profile']) {
  for (const outcome of ['success', 'failure', 'refresh']) {
    let settle;
    let closes = 0, notices = 0, loads = 0;
    decisionContext.toast = () => { notices++; };
    decisionContext.load = async () => {
      loads++;
      if (outcome === 'refresh') await new Promise(resolve => { settle = resolve; });
    };
    decisionNodes.set('#release-dialog', {close(){ closes++; }});
    const operation = decisionContext.save('#release-dialog', async () => {
      if (outcome !== 'refresh') await new Promise((resolve,reject) => {
        settle = outcome === 'failure' ? () => reject(new Error('old identity failure')) : resolve;
      });
    }, 'old identity success');
    await new Promise(resolve => setImmediate(resolve));
    decisionContext[identity] = {};
    decisionNodes.get('#quality-action-status').textContent = 'new identity status';
    settle(); await operation;
    assert.equal(decisionNodes.get('#quality-action-status').textContent, 'new identity status');
    assert.equal(notices, 0);
    assert.equal(closes, outcome === 'refresh' ? 1 : 0);
    assert.equal(loads, outcome === 'refresh' ? 1 : 0);
    assert.equal(decisionContext.decisionPending, false);
  }
}
assert.equal((qualityHtml.match(/type="submit"/g)||[]).length,2,'both QC submit controls must participate in pending guard');
const reportContext = { esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) };
vm.runInNewContext(`${reportSource}; this.report = qualityReport;`, reportContext);
const sampleOrder = {id:'order',clinic_id:'clinic-a',status:'released',batch_number:'<script>alert(1)</script>',actual_quantity:0};
const sampleQc = {id:'qc',production_order_id:'order',clinic_id:'clinic-a',status:'passed',result_summary:'Synthetic',moisture_result:0};
const report = reportContext.report(sampleOrder, sampleQc);
assert.match(report, /ไม่ใช่ COA ที่รับรองภายนอก/);
assert.match(report, /ไม่มีค่าบันทึก/);
assert.match(report, /<td>0<\/td>/, 'zero is recorded data, not missing');
assert.doesNotMatch(report, /<script>/);
assert.match(report, /&lt;script&gt;/);
assert.throws(() => reportContext.report(sampleOrder, null), /ยังออกเอกสารไม่ได้/);
assert.throws(() => reportContext.report(sampleOrder, {...sampleQc,clinic_id:'clinic-b'}), /ยังออกเอกสารไม่ได้/);
assert.throws(() => reportContext.report(sampleOrder, {...sampleQc,production_order_id:'other'}), /ยังออกเอกสารไม่ได้/);
assert.throws(() => reportContext.report(sampleOrder, {...sampleQc,status:'rejected'}), /ยังออกเอกสารไม่ได้/);
assert.throws(() => reportContext.report({...sampleOrder,status:'awaiting_qc'}, sampleQc), /ยังออกเอกสารไม่ได้/);
assert.match(reportContext.report({...sampleOrder,status:'rejected'}, {...sampleQc,status:'rejected',rejection_reason:'Synthetic rejection'}), /Synthetic rejection/);
assert.match(quality, /await load\(\);[^\n]*\n\s*const documentHtml = qualityReport/);

console.log('Independent Quality contracts passed: dedicated role, producer/approver separation, RPC-only release, and escaped tenant-matched internal QC report (not external COA)');
