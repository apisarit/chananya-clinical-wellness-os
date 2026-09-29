// Diagnostic, not an acceptance test: demonstrates the current trace gap.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const { db, ids, asOwner, asUser } = await createPriceMasterFixture();
let browserCheck;
try {
  const setup = (await asUser(ids.owner, 'select * from public.setup_price_master_default()')).rows[0];
  await asOwner(`insert into public.price_list_items(clinic_id,price_list_id,item_type,product_id,unit_code,unit_price,version)
    values('${ids.clinicA}','${setup.price_list_id}','product','${ids.productA}','ชิ้น',100,1)`);
  const [patient, encounter, rx, rxItem, order, item, lot] = Array.from({ length: 7 }, () => randomUUID());
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await db.exec(`
    insert into public.patients(id,hn,first_name,last_name,created_by)
      values('${patient}','TRACE-SYNTHETIC','Synthetic','Trace','${ids.owner}');
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
      values('${encounter}','TRACE-SYNTHETIC','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.owner}');
    insert into public.clinical_treatment_sessions(encounter_id,session_no,treatment_detail,duration_minutes,practitioner_id)
      values('${encounter}',1,'Synthetic trace test',60,'${ids.userA}');
    insert into public.prescriptions(id,prescription_no,encounter_id,patient_id,prescriber_id,status)
      values('${rx}','TRACE-SYNTHETIC','${encounter}','${patient}','${ids.userA}','draft');
    insert into public.prescription_items(id,prescription_id,product_id,quantity_prescribed,unit)
      values('${rxItem}','${rx}','${ids.productA}',1,'ชิ้น');
    insert into public.inventory_lots(id,product_id,lot_number,unit,clinic_id,current_quantity,received_quantity)
      values('${lot}','${ids.productA}','SYNTHETIC-NOT-DISPENSED','ชิ้น','${ids.clinicA}',10,10);
    insert into public.dispensing_orders(id,prescription_id,status)
      values('${order}','${rx}','waiting');
    insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,inventory_lot_id,quantity_dispensed,unit,unit_price,status)
      values('${item}','${order}','${rxItem}','${lot}',0,'ชิ้น',100,'pending');
  `);
  const read = async actor => (await asUser(actor,
    `select encounter_id,herbal_lots from public.search_clinical_outcomes('TRACE-SYNTHETIC')`)).rows;
  const rows = await read(ids.userA);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].herbal_lots, ['SYNTHETIC-NOT-DISPENSED']);
  assert.equal((await read(ids.userB)).length, 0);
  const movements = (await asOwner(`select count(*)::int n from public.stock_movements where inventory_lot_id='${lot}'`)).rows[0].n;
  assert.equal(movements, 0);
  console.log('CONFIRMED GAP: waiting order + pending item + zero quantity + no stock movement appears in outcome herbal_lots. Foreign clinic returned no rows. Diagnostic only; NOT acceptance.');
  const candidate = await fs.readFile(new URL('../supabase/manual/outcome_lot_trace_candidate.sql', import.meta.url), 'utf8');
  const guard = "do $$ begin raise exception 'OUTCOME_LOT_TRACE_REVIEW_REQUIRED'; end $$;";
  assert.ok(candidate.includes(guard));
  await assert.rejects(db.exec(candidate), /OUTCOME_LOT_TRACE_REVIEW_REQUIRED/);
  await db.exec('rollback');
  // Disposable fixture only. The on-disk unconditional guard is preserved.
  await db.exec(candidate.replace(guard, ''));
  const query = `select public.clinical_outcome_lot_trace('${encounter}') trace`;
  await assert.rejects(asUser(ids.userA, query), /permission denied/);
  if (process.env.CNYOS_TEST_OUTCOME_BROWSER === '1') {
    const { openOutcomeTraceBrowser } = await import('./helpers/outcome-trace-browser-database.mjs');
    browserCheck = await openOutcomeTraceBrowser({ asUser, actor: ids.userA, encounter });
    await browserCheck.verify({ contains: [/ยังตรวจไม่ได้/], excludes: [/SYNTHETIC-NOT-DISPENSED/] });
  }
  await asOwner('grant execute on function public.clinical_outcome_lot_trace(uuid) to authenticated');
  const trace = async () => (await asUser(ids.userA, query)).rows[0].trace;
  let result = await trace();
  assert.equal(result.entries[0].state, 'not_dispensed');
  assert.equal(result.entries[0].prescription_quantity_state, 'under_prescribed_quantity');
  assert.equal(result.entries[0].lot_id, null);
  assert.equal(result.complete, false);
  await browserCheck?.verify({ contains: [/ยังไม่ยืนยันการจ่าย/, /จ่ายน้อยกว่าจำนวนที่สั่ง/], excludes: [/SYNTHETIC-NOT-DISPENSED/] });
  await assert.rejects(asUser(ids.userB, query), /ENCOUNTER_NOT_AVAILABLE/);
  // Boundary proof with synthetic prescription lines; no silent first-page result.
  await asOwner(`insert into public.prescription_items(prescription_id,product_id,quantity_prescribed,unit)
    select '${rx}','${ids.productA}',1,'ชิ้น' from generate_series(1,999)`);
  assert.equal((await trace()).entries.length, 1000);
  await asOwner(`insert into public.prescription_items(prescription_id,product_id,quantity_prescribed,unit)
    values('${rx}','${ids.productA}',1,'ชิ้น')`);
  await assert.rejects(trace(), /OUTCOME_TRACE_RESULT_LIMIT_EXCEEDED/);
  await browserCheck?.verify({ contains: [/เกินขอบเขต 1,000/, /ไม่ได้แสดงผลบางส่วน/],
    excludes: [/หลักฐานบางส่วนเท่านั้น/, /จ่ายน้อยกว่าจำนวนที่สั่ง/, /SYNTHETIC-NOT-DISPENSED/] });
  await assert.rejects(asUser(ids.userB, query), /ENCOUNTER_NOT_AVAILABLE/, 'Oversize must not reveal foreign encounter size');
  await asOwner(`delete from public.prescription_items where prescription_id='${rx}' and id<>'${rxItem}'`);
  assert.equal((await trace()).entries.length, 1, 'Normal trace recovers after fixture overflow removal');
  await browserCheck?.verify({ contains: [/ยังไม่ยืนยันการจ่าย/, /จ่ายน้อยกว่าจำนวนที่สั่ง/],
    excludes: [/เกินขอบเขต 1,000/] });
  await asOwner(`update public.dispensing_orders set status='dispensed' where id='${order}'`);
  await asOwner(`update public.dispensing_items set status='dispensed',quantity_dispensed=1 where id='${item}'`);
  result = await trace();
  assert.equal(result.entries[0].state, 'recorded_dispense');
  assert.equal(result.entries[0].lot_id, lot);
  assert.equal(result.entries[0].prescription_quantity_state, 'matched_prescribed_quantity');
  assert.equal(result.entries[0].stock_state, 'movement_missing');
  assert.equal(result.entries[0].production_state, 'production_source_unavailable');
  await browserCheck?.verify({ contains: [/มีบันทึกการจ่าย/, /ไม่พบรายการตัดสต็อก/, /SYNTHETIC-NOT-DISPENSED/] });
  const [formula, production, qc] = Array.from({ length: 3 }, () => randomUUID());
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await db.exec(`
    insert into public.formulas(id,formula_code,name_th,finished_product_id,standard_batch_size,batch_unit,clinic_id)
      values('${formula}','TRACE-SYN','Synthetic formula','${ids.productA}',10,'ชิ้น','${ids.clinicA}');
    insert into public.production_orders(id,production_order_no,formula_id,finished_product_id,batch_number,planned_quantity,planned_unit,clinic_id,status)
      values('${production}','TRACE-SYN','${formula}','${ids.productA}','TRACE-SYN',10,'ชิ้น','${ids.clinicA}','released');
    insert into public.finished_goods_receipts(production_order_id,inventory_lot_id,received_quantity,unit,clinic_id)
      values('${production}','${lot}',10,'ชิ้น','${ids.clinicA}');
  `);
  assert.equal((await trace()).entries[0].production_state, 'qc_missing');
  await asOwner(`insert into public.production_qc(id,production_order_id,status,clinic_id)
    values('${qc}','${production}','pending','${ids.clinicA}')`);
  assert.equal((await trace()).entries[0].production_state, 'qc_not_passed');
  await asOwner(`update public.production_qc set status='passed' where id='${qc}'`);
  assert.equal((await trace()).entries[0].production_state, 'qc_approval_missing');
  await asOwner(`update public.production_qc set approved_by='${ids.userA}',approved_at=now() where id='${qc}'`);
  const provenance = (await trace()).entries[0];
  assert.equal(provenance.production_state, 'internal_qc_recorded');
  assert.equal(provenance.formula_id, formula);
  assert.equal(provenance.production_order_id, production);
  assert.equal(provenance.receipt_quantity_state, 'actual_production_quantity_missing');
  await asOwner(`update public.production_orders set actual_quantity=9 where id='${production}'`);
  assert.equal((await trace()).entries[0].receipt_quantity_state, 'production_receipt_quantity_mismatch');
  await browserCheck?.verify({ contains: [/ยอดรับสินค้าไม่ตรงกับยอดผลิตจริง/, /มีบันทึก QC ภายใน/] });
  await asOwner(`update public.production_orders set actual_quantity=10 where id='${production}'`);
  assert.equal((await trace()).entries[0].receipt_quantity_state, 'matched_production_receipt_quantity');
  await asOwner(`update public.inventory_lots set received_quantity=9 where id='${lot}'`);
  assert.equal((await trace()).entries[0].receipt_quantity_state, 'lot_receipt_quantity_mismatch');
  await browserCheck?.verify({ contains: [/ยอดรับล็อตไม่ตรงกับใบรับสินค้า/] });
  await asOwner(`update public.inventory_lots set received_quantity=10 where id='${lot}'`);
  await browserCheck?.verify({ contains: [/ยอดผลิตจริง ใบรับสินค้า และยอดรับล็อตตรงกัน/, /หลักฐานบางส่วนเท่านั้น/] });
  await asOwner(`update public.production_orders set actual_quantity='NaN' where id='${production}'`);
  await asOwner(`update public.finished_goods_receipts set received_quantity='NaN' where production_order_id='${production}'`);
  await asOwner(`update public.inventory_lots set received_quantity='NaN' where id='${lot}'`);
  assert.equal((await trace()).entries[0].receipt_quantity_state, 'receipt_quantity_invalid', 'NaN equality must not certify matching receipt quantities');
  await browserCheck?.verify({ contains: [/ยอดรับสินค้าหรือยอดรับล็อตไม่ถูกต้อง/], excludes: [/ยอดผลิตจริง ใบรับสินค้า และยอดรับล็อตตรงกัน/] });
  await asOwner(`update public.production_orders set actual_quantity=10 where id='${production}'`);
  await asOwner(`update public.finished_goods_receipts set received_quantity=10 where production_order_id='${production}'`);
  await asOwner(`update public.inventory_lots set received_quantity=10 where id='${lot}'`);
  const movement = randomUUID();
  await asOwner(`insert into public.stock_movements(id,clinic_id,inventory_lot_id,movement_type,quantity,direction,reference_type,reference_id)
    values('${movement}','${ids.clinicA}','${lot}','prescription_dispense',0.5,'out','dispensing_order','${order}')`);
  assert.equal((await trace()).entries[0].stock_state, 'quantity_mismatch');
  await asOwner(`update public.stock_movements set quantity=1 where id='${movement}'`);
  assert.equal((await trace()).entries[0].stock_state, 'matched_order_lot_quantity');
  await asOwner(`update public.stock_movements set direction='in' where id='${movement}'`);
  assert.equal((await trace()).entries[0].stock_state, 'movement_type_conflict');
  await asOwner(`update public.stock_movements set direction='out' where id='${movement}'`);
  await asOwner(`update public.stock_movements set quantity='NaN' where id='${movement}'`);
  assert.equal((await trace()).entries[0].stock_state, 'stock_quantity_invalid');
  await asOwner(`update public.stock_movements set quantity=1 where id='${movement}'`);
  await asOwner(`update public.dispensing_items set quantity_dispensed='NaN' where id='${item}'`);
  const invalidDispense = (await trace()).entries[0];
  assert.equal(invalidDispense.state, 'dispensed_quantity_invalid');
  assert.equal(invalidDispense.lot_id, null);
  assert.equal(invalidDispense.stock_state, 'stock_quantity_invalid');
  assert.equal(invalidDispense.prescription_quantity_state, 'prescribed_quantity_invalid');
  await asOwner(`update public.dispensing_items set quantity_dispensed=1 where id='${item}'`);
  await asOwner(`update public.prescription_items set quantity_prescribed='NaN' where id='${rxItem}'`);
  assert.equal((await trace()).entries[0].prescription_quantity_state, 'prescribed_quantity_invalid');
  await asOwner(`update public.prescription_items set quantity_prescribed=1 where id='${rxItem}'`);
  const splitItem = randomUUID();
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await db.query(`insert into public.dispensing_items(id,dispensing_order_id,prescription_item_id,inventory_lot_id,quantity_dispensed,unit,unit_price,status)
    values('${splitItem}','${order}','${rxItem}','${lot}',1,'ชิ้น',100,'dispensed')`);
  assert.ok((await trace()).entries.every(entry => entry.stock_state === 'quantity_mismatch'));
  await asOwner(`update public.stock_movements set quantity=2 where id='${movement}'`);
  assert.ok((await trace()).entries.every(entry => entry.stock_state === 'matched_order_lot_quantity'));
  assert.ok((await trace()).entries.every(entry => entry.prescription_quantity_state === 'over_prescribed_quantity'));
  await browserCheck?.verify({ contains: [/จ่ายเกินจำนวนที่สั่ง/, /ยอดตัดสต็อกตรง/, /มีบันทึก QC ภายใน/, /หลักฐานบางส่วนเท่านั้น/] });
  assert.equal(result.complete, false, 'Recorded status alone does not prove stock/batch provenance');
  await asOwner(`update public.dispensing_items set inventory_lot_id=null where id='${item}'`);
  result = await trace();
  assert.equal(result.entries.find(entry => entry.dispensing_item_id === item).state, 'lot_missing_or_out_of_scope');
  assert.equal(result.entries.length, 2, 'Missing lot must not silently drop the edge');
  // Existing linked item becomes ineligible: it must surface as a conflict, not disappear silently.
  await asOwner(`update public.prescription_items set status='cancelled' where id='${rxItem}'`);
  result = await trace();
  assert.equal(result.link_conflict_count, 2);
  await browserCheck?.verify({ contains: [/ความขัดแย้งในการเชื่อมรายการ: 2/, /ไม่พบรายการยาในใบสั่งที่ยังใช้งาน/], excludes: [/SYNTHETIC-NOT-DISPENSED/] });
  assert.equal(result.complete, false);
  console.log('Guarded projection passed: runtime/tenant denial, pending/recorded/missing lot, absent/mismatched/matching/conflicting stock movements. No full provenance or deployment claim.');
  if (browserCheck) console.log('Actual outcomes UI/disposable SQL adapter passed: revoked read, pending, stock missing, over-dispense with matched stock/internal QC, orphan links. Not hosted REST/Auth acceptance.');
} finally { try { await browserCheck?.close(); } finally { await db.close(); } }
