import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
import { BACKUP_DOMAINS, BACKUP_HASHED_TABLES, encryptBackup, verifyBackupSet } from '../netlify/functions/_shared/database-backup.mjs';
import { compareRestoreHashes } from '../scripts/restore-count-comparison.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(path.join(root, 'supabase/migrations/20260926114320_financial_backup_provenance.sql'), 'utf8');
assert.match(migration, /2026-09-26\.1/);
assert.match(migration, /cnyos_billing_internal\.invoice_orders/);
assert.match(migration, /cnyos_treatment_internal\.session_request_receipts/);
assert.match(migration, /pg_catalog\.sha256\(convert_to/);

// Preserve the v1 upgrade/replay contract; the bundled v3 migration has its own
// migration-only replacement and native restore acceptance paths.
const { db, ids, asService, asAnon, asOwner, asUser } = await createPriceMasterFixture({
  stopBeforeMigration: '20260926214550_pharmacy_clarification_replacement_bundle.sql'
});
const ownList = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const otherService = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const otherList = '99999999-9999-4999-8999-999999999999';
const ownItem = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const otherItem = '99999999-9999-4999-8999-999999999991';
await asOwner(`insert into public.services(id,service_code,name_th,category,clinic_id) values ('${otherService}','OTHER-SERVICE','Other clinic service','treatment','${ids.clinicB}')`);
await asOwner(`insert into public.price_lists(id,code,name,effective_from,clinic_id) values ('${ownList}','OWN-LIST','Own list',current_date,'${ids.clinicA}')`);
await asOwner(`insert into public.price_lists(id,code,name,effective_from,clinic_id) values ('${otherList}','OTHER-LIST','Other list',current_date,'${ids.clinicB}')`);
await asOwner(`insert into public.price_list_items(id,price_list_id,item_type,service_id,unit_price,clinic_id) values ('${ownItem}','${ownList}','service','${ids.serviceA}',100,'${ids.clinicA}')`);
await asOwner(`insert into public.price_list_items(id,price_list_id,item_type,service_id,unit_price,clinic_id) values ('${otherItem}','${otherList}','service','${otherService}',200,'${ids.clinicB}')`);

const products = await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','products') as payload`);
const payload = products.rows[0].payload;
assert.equal(payload.schema_version, '2026-09-26.1');
assert.ok(payload.data.services.some(row => row.id === ids.serviceA));
assert.equal(payload.data.services.some(row => row.id === otherService), false);
assert.ok(payload.data.price_lists.some(row => row.id === ownList));
assert.equal(payload.data.price_lists.some(row => row.id === otherList), false);
assert.ok(payload.data.price_list_items.some(row => row.id === ownItem));
assert.equal(payload.data.price_list_items.some(row => row.id === otherItem), false);
assert.equal(Object.keys(payload.table_sha256).length, 3);

await assert.rejects(
  asAnon(`select public.export_clinic_backup_domain('${ids.clinicA}','products')`),
  /permission denied|SERVICE_ROLE_REQUIRED/
);
await assert.rejects(
  asService(`select cnyos_backup_internal.financial_tenant_projection('${ids.clinicA}')`),
  /permission denied/
);
const trace = await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`);
assert.equal(trace.rows[0].payload.schema_version, '2026-09-26.1');
assert.equal(Object.keys(trace.rows[0].payload.table_sha256).length, 8);
assert.equal(trace.rows[0].payload.ready, true);

// Exercise durable provenance produced by real RPCs, not just empty arrays.
const encounter = 'ee000000-0000-4000-8000-000000000001';
const request = 'ee000000-0000-4000-8000-000000000002';
const billRequest = 'ee000000-0000-4000-8000-000000000003';
await asUser(ids.owner, 'select * from public.setup_price_master_default()');
await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
  select '${encounter}','BACKUP-ENC-01',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1`);
const session = (await asUser(ids.userA, `select (public.create_clinical_treatment_session_idempotent(
  '${request}','${encounter}',array['massage']::text[],'Synthetic backup treatment',false,null,null,
  4::smallint,2::smallint,'Synthetic outcome','Synthetic advice',60)).id`)).rows[0].id;
await asOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
  values('${encounter}','complete_record','${ids.userA}',true)`);
const quote = (await asUser(ids.owner, `select public.quote_encounter_invoice('${encounter}') as q`)).rows[0].q;
await asUser(ids.owner, `select * from public.issue_atomic_encounter_invoice('${billRequest}','${encounter}','${quote.quote_fingerprint}')`);
const exported = {};
for (const domain of BACKUP_DOMAINS) {
  exported[domain] = (await asService(`select public.export_clinic_backup_domain('${ids.clinicA}','${domain}') as payload`)).rows[0].payload;
}
const transactions = exported.transactions.data;
assert.ok(transactions.price_master_audit.length > 0);
assert.equal(transactions['cnyos_billing_internal.invoice_request_receipts'][0].request_key, billRequest);
assert.equal(transactions['cnyos_billing_internal.invoice_source_charges'][0].treatment_session_id, session);
assert.equal(transactions['cnyos_treatment_internal.session_request_receipts'][0].request_id, request);
const key = Buffer.alloc(32, 17);
const encrypted = BACKUP_DOMAINS.map(domain => encryptBackup(exported[domain], key, {
  environment: 'restore-test', deploymentId: 'financial-synthetic-restore',
  sourceRevision: 'a'.repeat(40), clinicId: ids.clinicA, clinicCode: 'SYNTHETIC',
  domain, slot: '2026-09-26T00:00:00Z'
}).envelope);
const evidence = verifyBackupSet(encrypted, key);
const fullTrace = (await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`)).rows[0].payload;
assert.equal(Object.keys(compareRestoreHashes(evidence, fullTrace.table_sha256, BACKUP_HASHED_TABLES)).length, 8);
await db.exec("set timezone='America/Los_Angeles'; set datestyle='SQL, DMY';");
const alternateTrace = (await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`)).rows[0].payload;
assert.deepEqual(alternateTrace.table_sha256, fullTrace.table_sha256);
await db.exec("set timezone='UTC'; set datestyle='ISO, YMD';");
await assert.rejects(asUser(ids.owner, `select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`), /permission denied/);

// Reapplying the candidate wrapper must not archive itself or recurse.
await db.exec(migration);
const replayTrace = (await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`)).rows[0].payload;
assert.deepEqual(replayTrace.table_sha256, fullTrace.table_sha256);
// Same-count content damage is detected, even if reference relationships remain valid.
await db.exec(`alter table cnyos_billing_internal.invoice_source_charges disable trigger invoice_source_charges_immutable;
  update cnyos_billing_internal.invoice_source_charges set source_snapshot=source_snapshot||'{"synthetic_corruption":true}'::jsonb;
  alter table cnyos_billing_internal.invoice_source_charges enable trigger invoice_source_charges_immutable;`);
const damaged = (await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`)).rows[0].payload;
assert.deepEqual(damaged.counts, fullTrace.counts);
assert.throws(() => compareRestoreHashes(evidence, damaged.table_sha256, BACKUP_HASHED_TABLES), /content hash mismatch/);
// A missing aggregate receipt is a broken replay boundary, not a successful backup.
await db.exec(`alter table cnyos_billing_internal.invoice_request_receipts disable trigger invoice_request_receipts_immutable;
  delete from cnyos_billing_internal.invoice_request_receipts where request_key='${billRequest}';
  alter table cnyos_billing_internal.invoice_request_receipts enable trigger invoice_request_receipts_immutable;`);
const broken = (await asService(`select public.verify_clinic_restore_trace('${ids.clinicA}') as payload`)).rows[0].payload;
assert.equal(broken.ready, false);
assert.ok(broken.referential_integrity_anomalies > 0);
await assert.rejects(asService(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`), /BACKUP_FINANCIAL_INTEGRITY_ANOMALY/);
await db.close();
console.log('Financial backup provenance passed: actual treatment/invoice receipts, encrypted domains, tenant/role denial, eight hashes, timezone stability, wrapper replay and corruption rejection');
