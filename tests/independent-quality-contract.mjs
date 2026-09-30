import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

console.log('Independent Quality contracts passed: dedicated role, database-enforced producer/approver separation, RPC-only release, least-privilege data visibility and auditable decisions');
