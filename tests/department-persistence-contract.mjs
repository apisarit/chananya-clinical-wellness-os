import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/202608270500_department_persistence_and_drive_export.sql');
const environmentBackup = read('supabase/migrations/202608281430_environment_transaction_drive_backup.sql');
const runtime = read('chananya-runtime.js');
const pharmacy = read('pharmacy.js');
const production = read('production.js');
const operations = read('app.js');
const searchSelect = read('searchable-select.js');
const bodyMap = read('body-pain-map.js');
const bodyFigure = read('bodymap-figures.svg');
const backupWorker = read('netlify/functions/database-backup.mts');
const backupBackground = read('netlify/functions/database-backup-background.mts');
const backupRecovery = read('netlify/functions/database-backup-recovery.mts');
const backupRuntime = read('netlify/functions/_shared/database-backup-runtime.mjs');
const backupHelper = read('netlify/functions/_shared/database-backup.mjs');
const runbook = read('docs/DEPARTMENT_ACCESS_AND_BACKUPS.md');

assert.match(migration, /^begin;/i, 'department migration must be atomic');
assert.match(migration, /commit;\s*\n\s*select/i, 'migration must commit before its verification query');
for (const rpc of [
  'current_access_context',
  'upsert_product_master',
  'set_product_master_active',
  'create_pharmacy_counter_sale',
  'upsert_pharmacy_counter_sale_item',
  'remove_pharmacy_counter_sale_item',
  'transition_pharmacy_counter_sale',
  'dispense_pharmacy_counter_sale',
  'begin_backup_export_run',
  'complete_backup_export_run',
  'export_clinic_backup_domain',
  'department_persistence_healthcheck'
]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\b`, 'i'), `${rpc} must exist`);
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\b`, 'i'), `${rpc} must be explicitly revoked`);
}

assert.match(migration, /when public\.is_super_admin\(\) then true/i, 'only super admin may receive the database override');
assert.match(migration, /'governance'[^;]+system_role = 'admin'/is, 'ordinary admin must remain governance-only');
assert.match(migration, /as restrictive for all to authenticated/gi, 'domain boundaries must be restrictive RLS policies');
assert.ok((migration.match(/as restrictive for all to authenticated/gi) || []).length >= 8, 'patient, product, inventory and pharmacy domains must be restricted');
for (const constraint of [
  'inventory_lots_product_clinic_fkey',
  'stock_movements_lot_clinic_fkey',
  'pharmacy_counter_items_sale_clinic_fkey',
  'pharmacy_counter_items_product_clinic_fkey',
  'pharmacy_counter_allocations_item_clinic_fkey',
  'pharmacy_counter_allocations_lot_clinic_fkey'
]) {
  assert.match(migration, new RegExp(constraint), `${constraint} must enforce tenant referential integrity`);
}
assert.match(migration, /revoke insert, update, delete on public\.products from authenticated/i);
assert.match(migration, /revoke insert, update, delete on public\.pharmacy_counter_sales from authenticated/i);
assert.match(migration, /pg_advisory_xact_lock/, 'backup lease must serialize concurrent runs');
assert.match(migration, /backup_export_runs_clinic_slot_uidx/, 'backup slots must be unique per clinic');
assert.match(environmentBackup, /^begin;/i, 'environment backup migration must be atomic');
assert.match(environmentBackup, /elsif p_domain = 'transactions'/i, 'a separate transaction audit domain must exist');
for (const table of ['audit_logs', 'invoices', 'invoice_items', 'payments']) {
  assert.match(environmentBackup, new RegExp(`'${table}'`), `Transaction backup must include ${table}`);
}
assert.match(environmentBackup, /where a\.clinic_id=v_requested_clinic/i, 'audit export must be tenant scoped');
assert.match(environmentBackup, /'schema_version','2026-08-28\.1'/);

assert.match(runtime, /access_context_ready !== true\) return false/, 'UI capability checks must fail closed');
assert.match(runtime, /admin_center: \['super_admin','admin'\]/, 'admin is limited to its governance capability');
assert.match(runtime, /clinical_write: \['super_admin','practitioner','doctor'\]/);
assert.match(runtime, /pharmacy_operate: \['super_admin','pharmacy'\]/);
assert.match(runtime, /production_operate: \['super_admin','production','inventory'\]/);
assert.match(runtime, /quality_operate: \['super_admin','quality'\]/);
assert.match(runtime, /billing_operate: \['super_admin','billing'\]/);

for (const rpc of [
  'create_pharmacy_counter_sale',
  'upsert_pharmacy_counter_sale_item',
  'remove_pharmacy_counter_sale_item',
  'transition_pharmacy_counter_sale',
  'dispense_pharmacy_counter_sale',
  'upsert_product_master',
  'set_product_master_active',
  'department_persistence_healthcheck'
]) {
  assert.match(pharmacy, new RegExp(`rpc\\('${rpc}'`), `Pharmacy UI must call ${rpc}`);
}
assert.doesNotMatch(
  pharmacy,
  /\.from\(['"](?:products|pharmacy_counter_sales|pharmacy_counter_sale_items|pharmacy_counter_allocations)['"]\)\.(?:insert|update|delete|upsert)\s*\(/,
  'Pharmacy browser must not bypass controlled writes'
);
assert.match(production, /rpc\('commit_production_import'/, 'Production import must commit through one server transaction');
assert.doesNotMatch(
  production,
  /\.from\(['"]products['"]\)\.(?:insert|update|delete|upsert)\s*\(/,
  'Production browser must not bypass Product Master RPC'
);
assert.match(operations, /rpc\('upsert_patient_registration'/, 'patient writes must use the audited registration RPC');

assert.match(searchSelect, /role', 'combobox'/, 'searchable selection must expose an accessible combobox');
assert.match(searchSelect, /Intl\.Collator\(\['th', 'en'\]/, 'searchable selection must sort Thai and English labels');
assert.match(searchSelect, /select\.dispatchEvent\(new Event\('change'/, 'enhancement must preserve native change contracts');
for (const page of [
  'index.html', 'appointments.html', 'check-in.html', 'foundation.html',
  'clinical-v3.html', 'pharmacy.html', 'production.html', 'quality.html', 'admin.html', 'patient-card.html'
]) {
  assert.match(read(page), /searchable-select\.js/, `${page} must enhance single-choice selects`);
}

assert.match(bodyMap, /bodymap-figures\.svg\?v=clinical-os-department1/, 'Clinical must load the cache-busted revised body map');
assert.match(bodyMap, /chananya:bodymap-rendered/, 'dynamic body-map selects must join the explicit lifecycle');
assert.equal((bodyFigure.match(/class="panel"/g) || []).length, 4, 'body map must contain four aligned views');
assert.doesNotMatch(bodyFigure, /(?:href|src)=["']https?:\/\//, 'body-map asset must not call external image services');
assert.match(bodyFigure, /linearGradient id="skin"/, 'body map must use the polished clinical illustration');

assert.match(backupWorker, /schedule:\s*'0 20 \* \* \*'/, 'backup worker must run daily');
assert.match(backupBackground, /handleBackgroundBackup/, 'heavy backup work must use a Netlify background function');
assert.match(backupRecovery, /handleBackupRecovery/, 'a bounded scheduled monitor must recover stale same-slot leases');
assert.match(backupRuntime, /GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64/);
assert.match(backupRuntime, /resolveGoogleServiceAccountCredential/);
assert.match(backupRuntime, /BACKUP_GOOGLE_SERVICE_ACCOUNT_DIRECT_ENV_FORBIDDEN/);
assert.match(backupRuntime, /GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID/);
assert.match(backupRuntime, /BACKUP_ENVIRONMENT/);
assert.match(backupRuntime, /BACKUP_PRODUCTION_SUPABASE_URL/);
assert.match(backupHelper, /createCipheriv\('aes-256-gcm'/, 'backup payload must use authenticated AES-256-GCM');
assert.match(backupHelper, /plaintext_sha256/);
assert.match(backupHelper, /ciphertext_sha256/);
assert.match(backupHelper, /scope: 'https:\/\/www\.googleapis\.com\/auth\/drive\.file'/, 'Drive scope must be file-limited');
assert.match(runbook, /Supabase PostgreSQL is the transactional source of truth/);
assert.match(runbook, /never put the key in Drive/i);
assert.match(runbook, /isolated restore drill/i);

console.log('Department persistence contracts passed: fail-closed role routes, restrictive tenant RLS/FKs, audited RPC-only writes, searchable selects, polished body map and encrypted Drive backup');
