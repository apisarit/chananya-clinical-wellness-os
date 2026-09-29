import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/202608270600_atomic_production_execution.sql');
const production = read('production.js');
const productionHtml = read('production.html');
const quality = read('quality.js');
const qualityHtml = read('quality.html');
const pharmacy = read('pharmacy.js');
const pharmacyHtml = read('pharmacy.html');
const uiReview = read('ui-review.html');

const stockContext = {num: value => Number(value || 0)};
vm.runInNewContext(production.slice(production.indexOf('  function lowMaterialCount('), production.indexOf('  let db;'))
  + '; this.count = lowMaterialCount;', stockContext);
const day = new Date(2026, 8, 26, 12);
const material = {id:'herb',category:'herb',active:true,reorder_level:2};
const lot = {product_id:'herb',status:'active',current_quantity:10,expiry_date:'2026-09-25'};
assert.equal(stockContext.count([material],[lot],day),1,'expired units must not hide shortage');
assert.equal(stockContext.count([material],[{...lot,expiry_date:'2026-09-26'}],day),0,'expiry day remains eligible in display');
assert.equal(stockContext.count([material],[{...lot,expiry_date:null}],day),0,'null expiry follows existing FEFO eligibility');
assert.equal(stockContext.count([material],[{...lot,expiry_date:'2026-09-27',status:'quarantined'}],day),1);
assert.equal(stockContext.count([material],[{...lot,expiry_date:'invalid'}],day),1);
assert.equal(stockContext.count([material],[{...lot,expiry_date:null,current_quantity:2}],day),1,'reorder threshold is inclusive');
assert.equal(stockContext.count([{...material,active:false}],[],day),0);
assert.equal(stockContext.count([{...material,category:'finished_product'}],[],day),0);
assert.match(productionHtml,/ประมาณการ/);
assert.match(productionHtml,/วันที่บนอุปกรณ์/);

assert.match(migration, /^begin;/i, 'production migration must be atomic');
assert.match(migration, /commit;\s*\n\s*select/i, 'migration must commit before its verification query');

for (const rpc of [
  'upsert_supplier_master',
  'upsert_production_formula',
  'upsert_production_formula_component',
  'create_production_request',
  'open_production_order',
  'issue_production_materials_fefo',
  'complete_production_order',
  'release_production_order',
  'reject_production_order',
  'stage_production_import',
  'commit_production_import',
  'production_execution_healthcheck'
]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\b`, 'i'), `${rpc} must exist`);
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\b`, 'i'), `${rpc} must be explicitly revoked`);
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\b`, 'i'), `${rpc} must be granted explicitly`);
}

assert.ok((migration.match(/security definer/gi) || []).length >= 12, 'production writes must run behind trusted functions');
assert.ok((migration.match(/set search_path = public/gi) || []).length >= 12, 'trusted functions must pin search_path');
assert.ok((migration.match(/for update/gi) || []).length >= 10, 'workflow transitions must lock authoritative rows and lots');
assert.match(migration, /IDEMPOTENCY_KEY_REUSED/);
assert.match(migration, /order by l\.expiry_date nulls last, l\.received_at, l\.id\s+for update/i, 'FEFO must be deterministic and locked');
assert.match(migration, /PRODUCTION_MATERIAL_INSUFFICIENT/);
assert.match(migration, /and d\.status not in \('submitted_to_billing','billed','cancelled','rejected'\)/i, 'finalized dispensing must not create production work');
assert.match(migration, /stock_movements_atomic_source_uidx/, 'stock movements must have an idempotent source key');
assert.match(migration, /enforce_prescription_item_product_tenant/, 'clinical product links must be tenant checked');

for (const constraint of [
  'formulas_product_clinic_fkey',
  'formula_components_formula_clinic_fkey',
  'formula_components_product_clinic_fkey',
  'production_requests_product_clinic_fkey',
  'production_orders_request_clinic_fkey',
  'production_orders_formula_clinic_fkey',
  'production_orders_product_clinic_fkey',
  'production_issues_lot_clinic_fkey',
  'production_qc_order_clinic_fkey',
  'finished_receipts_lot_clinic_fkey'
]) {
  assert.match(migration, new RegExp(constraint), `${constraint} must bind tenant relationships`);
}
assert.ok(
  (migration.match(/as restrictive for all to authenticated/gi) || []).length >= 10,
  'all production/master/import tables must have restrictive tenant policies'
);

for (const table of [
  'formulas', 'formula_components', 'production_requests', 'production_orders',
  'production_material_issues', 'production_qc', 'finished_goods_receipts',
  'import_batches', 'import_rows', 'inventory_lots', 'stock_movements'
]) {
  assert.match(
    migration,
    new RegExp(`revoke insert, update, delete on public\\.${table} from authenticated`, 'i'),
    `direct authenticated writes to ${table} must be revoked`
  );
}

for (const rpc of [
  'upsert_production_formula',
  'upsert_production_formula_component',
  'open_production_order',
  'issue_production_materials_fefo',
  'complete_production_order',
  'stage_production_import',
  'commit_production_import',
  'production_execution_healthcheck'
]) {
  assert.match(production, new RegExp(`rpc\\('${rpc}'`), `Production UI must call ${rpc}`);
}
assert.match(pharmacy, /rpc\('create_production_request'/, 'Pharmacy owns production request creation');
assert.match(pharmacy, /window\.crypto\.randomUUID\(\)/, 'request retries need a cryptographic idempotency key');
assert.match(pharmacyHtml, /id="production-request-form"/, 'request form belongs to Pharmacy');
assert.doesNotMatch(productionHtml, /id="production-request-form"|Pharmacy: สร้างคำขอผลิต/, 'Production must not impersonate Pharmacy');

const protectedDirectWrite = /\.from\(['"](?:formulas|formula_components|production_requests|production_orders|production_material_issues|production_qc|finished_goods_receipts|import_batches|import_rows|inventory_lots|stock_movements)['"]\)\.(?:insert|update|delete|upsert)\s*\(/;
assert.doesNotMatch(production, protectedDirectWrite, 'Production browser must be RPC-only');
assert.doesNotMatch(pharmacy, protectedDirectWrite, 'Pharmacy browser must not bypass production RPCs');

for (const patientDomain of ['patients', 'prescriptions', 'prescription_items', 'dispensing_orders']) {
  assert.doesNotMatch(
    production,
    new RegExp(`query\\('${patientDomain}'`),
    `Production must not load patient-domain table ${patientDomain}`
  );
}
assert.match(productionHtml, /ไม่เห็นข้อมูลผู้รับบริการ/);
assert.match(productionHtml, /id="complete-dialog"/);
assert.doesNotMatch(productionHtml, /id="release-dialog"|id="reject-dialog"/, 'Production must not own Quality decisions');
assert.doesNotMatch(production, /rpc\('(?:release_production_order|reject_production_order|quality_release_production_order|quality_reject_production_order)'/, 'Production browser cannot release or reject its own batch');
assert.match(qualityHtml, /id="release-dialog"/);
assert.match(qualityHtml, /id="reject-dialog"/);
assert.match(quality, /rpc\('quality_release_production_order'/);
assert.match(quality, /rpc\('quality_reject_production_order'/);
assert.doesNotMatch(production, /prompt\(/, 'critical Production transitions must use validated forms');
assert.match(uiReview, /Pharmacy → Production → Quality แบบแยกแผนก/);
assert.match(uiReview, /ไม่แสดงชื่อ HN หรือ Diagnosis/);
assert.doesNotMatch(uiReview, /supabase-js|auth-config\.js|chananya-runtime\.js/, 'read-only review must have no database runtime');

for (const table of [
  'production_requests', 'production_orders', 'production_material_issues',
  'production_qc', 'finished_goods_receipts', 'import_batches', 'import_rows'
]) {
  assert.match(migration, new RegExp(`'${table}'`), `Products backup must include ${table}`);
}
assert.match(migration, /'schema_version','2026-08-27\.2'/);

console.log(
  'Atomic production contracts passed: tenant FKs/RLS, department ownership, FEFO locks, idempotency, audited RPC-only writes, validated dialogs and complete backup coverage'
);
await import('./production-output-validation.mjs');
