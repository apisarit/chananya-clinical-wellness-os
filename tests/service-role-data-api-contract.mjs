import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const directRestSources = [
  read('scripts/provision-staging-users.mjs'),
  read('scripts/run-staging-synthetic-uat.mjs'),
  read('scripts/verify-line-staging.mjs')
].join('\n');
const importSources = [
  read('scripts/import-pikad-staging.mjs'),
  read('scripts/import-ttm-dkr-staging.mjs')
].join('\n');

const discovered = new Set();
for (const match of directRestSources.matchAll(
  /(?:adminRequest|serviceRequest)\(\s*[`'"]\/rest\/v1\/([a-z][a-z0-9_]*)/g
)) discovered.add(match[1]);
for (const match of importSources.matchAll(
  /request\(target,\s*[`'"]([a-z][a-z0-9_]*)/g
)) discovered.add(match[1]);

assert.deepEqual([...discovered].sort(), [
  'audit_logs',
  'clinic_memberships',
  'dispensing_items',
  'inventory_lots',
  'patient_qr_sessions',
  'profiles',
  'ttm_concept_relations',
  'ttm_concepts',
  'ttm_diagnostic_knowledge',
  'ttm_sources'
], 'every direct service-role Data API table must remain covered by the reviewed final ACL matrix');

const grants = read('supabase/migrations/202609010200_explicit_service_role_data_api_grants.sql');
assert.match(grants, /grant usage on schema public to service_role/i);
assert.match(grants, /grant select on table\s+public\.profiles,\s+public\.audit_logs\s+to authenticated/i);
for (const table of [
  'profiles', 'clinic_memberships', 'ttm_sources', 'ttm_concepts',
  'ttm_concept_relations', 'ttm_diagnostic_knowledge'
]) assert.match(grants, new RegExp(`public\\.${table}`));
assert.match(grants, /grant select, insert on table\s+public\.audit_logs\s+to service_role/i);
assert.match(grants, /grant select, update on table\s+public\.patient_qr_sessions\s+to service_role/i);
assert.doesNotMatch(grants, /grant\s+(?:all|delete|truncate)|grant[^;]+\bdelete\b/i);
assert.match(grants, /revoke all on table[\s\S]+from anon/i);

const historicalBroadGrants = read('supabase/migrations/202608010300_relational_clinical_pharmacy_billing.sql');
assert.match(historicalBroadGrants, /grant all privileges on table public\.%I to service_role/i);

const finalClosure = read('supabase/migrations/202609011000_owner_subscription_kill_switch_closure.sql');
assert.match(
  finalClosure,
  /revoke insert,update,delete,truncate,references,trigger\s+on all tables in schema public from service_role/i
);
assert.match(finalClosure, /grant insert,update on table public\.profiles to service_role/i);
assert.match(finalClosure, /grant insert,update on table public\.clinic_memberships to service_role/i);
assert.match(finalClosure, /grant insert on table public\.audit_logs to service_role/i);
assert.match(finalClosure, /grant insert on table public\.inventory_lots to service_role/i);
assert.match(finalClosure, /grant update on table public\.patient_qr_sessions to service_role/i);
assert.match(finalClosure, /revoke all privileges on all sequences in schema public from service_role/i);
assert.match(finalClosure, /grant usage on sequence %s to service_role/i);
for (const table of [
  'ttm_sources', 'ttm_concepts', 'ttm_concept_relations', 'ttm_diagnostic_knowledge'
]) assert.match(finalClosure, new RegExp(`public\\.${table}`));
assert.doesNotMatch(finalClosure, /grant[^;]+public\.dispensing_items[^;]+to service_role/i);
for (const table of ['clinic_memberships','audit_logs','inventory_lots','patient_qr_sessions']) {
  assert.match(finalClosure, new RegExp(`['"]${table}['"]`));
}

const qrHardening = read('supabase/migrations/202609010300_white_label_qr_issuer.sql');
assert.match(qrHardening, /select c\.code into v_issuer/i);
assert.match(qrHardening, /QR_ISSUER_MISMATCH/);
assert.doesNotMatch(qrHardening, /CHANANYA:PT1:/i);

console.log(`Service-role Data API contract passed: ${discovered.size} reviewed reads/writes, exact final DML allowlist, and tenant-derived QR issuer`);
