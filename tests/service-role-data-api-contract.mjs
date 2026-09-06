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

const triggerClosureCandidate = read('supabase/manual/202609060700_revoke_trigger_function_data_api_execute_candidate.sql');
const browserRpcAclClosure = read('supabase/manual/202609060710_close_browser_rpc_acl_drift_candidate.sql');

function assertManualCandidateFailClosed(source, manifestGate) {
  assert.match(source, /^-- This manual candidate is a psql program/);
  assert.match(source, /^\\set ON_ERROR_STOP 1$/m);
  assert.match(source, /^\\set ON_ERROR_ROLLBACK off$/m);
  assert.match(source, /^\\if :AUTOCOMMIT$/m);
  assert.match(source, /CNYOS_ACL_CANDIDATE_PSQL_AUTOCOMMIT_REQUIRED/);
  assert.match(source, /CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED/);
  assert.match(source, /-- CNYOS_ACL_SQL_ACQUISITION_BEGIN\ndo \$cnyos_acl_interlock\$/);
  assert.match(source, /pg_try_advisory_lock\(202608302100::bigint\)/);
  assert.ok((source.match(/202608302100::bigint/g) || []).length >= 3);
  assert.doesNotMatch(source, /1129270603|\(1129270603,\s*36\)/);
  assert.match(source, /begin isolation level repeatable read read write;/);
  assert.match(source, /set local search_path = pg_catalog, pg_temp;/);
  assert.match(source, /current_setting\('transaction_isolation'\) <> 'repeatable read'/);
  assert.match(source, /current_database\(\) <> 'postgres'/);
  assert.match(source, /session_user <> 'postgres' or current_user <> 'postgres'/);
  assert.match(source, /cnyos_migration_ledger_repair_receipts/);
  assert.match(
    source,
    /CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING/
  );
  assert.match(source, new RegExp(manifestGate));
  assert.equal((source.match(new RegExp(manifestGate, 'g')) || []).length, 1);

  const transactionIndex = source.indexOf('begin isolation level repeatable read read write;');
  const outerTransactionRefusalIndex = source.indexOf(
    'CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED'
  );
  const lockAcquisitionIndex = source.indexOf('pg_try_advisory_lock(202608302100::bigint)');
  const catalogLockIndex = source.indexOf('lock table pg_catalog.pg_proc');
  const manifestGateIndex = source.indexOf(manifestGate);
  const mainStatementIndex = source.indexOf('\ndo $$\n');
  const firstMutationIndex = source.indexOf('revoke all privileges');
  assert.ok(outerTransactionRefusalIndex >= 0 && outerTransactionRefusalIndex < lockAcquisitionIndex);
  assert.ok(lockAcquisitionIndex < transactionIndex);
  assert.ok(transactionIndex >= 0 && transactionIndex < catalogLockIndex);
  assert.ok(catalogLockIndex < mainStatementIndex);
  assert.ok(mainStatementIndex < manifestGateIndex);
  assert.ok(manifestGateIndex < firstMutationIndex);
  assert.equal((source.match(/do \$\$/g) || []).length, 1);

  assert.match(
    source,
    /exception\s+when others then\s+perform pg_catalog\.pg_advisory_unlock\(202608302100::bigint\);\s+raise;/i
  );
  assert.match(
    source,
    /commit;\s+do \$cnyos_acl_interlock\$[\s\S]+pg_advisory_unlock\(202608302100::bigint\)[\s\S]+CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED/
  );
  assert.doesNotMatch(source, /raise\s+notice/i);
  assert.doesNotMatch(source, /CHECKS_PASSED/);
  assert.match(source, /default function ACLs/i);
  assert.doesNotMatch(source, /alter\s+default\s+privileges/i);
  assert.doesNotMatch(source, /disposable-fixture|test_system_identifier|template1/i);
}

assertManualCandidateFailClosed(
  triggerClosureCandidate,
  'CNYOS_TRIGGER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED'
);
assert.match(triggerClosureCandidate, /MIGRATION CANDIDATE/);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_CANDIDATE_AUTHORIZATION_REQUIRED/);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID/);
assert.match(triggerClosureCandidate, /7666007964130682852/);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_CANDIDATE_TARGET_MARKERS_INVALID/);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_CANDIDATE_DURABLE_LEDGER_RECEIPT_INVALID/);
assert.match(triggerClosureCandidate, /b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a/);
assert.match(triggerClosureCandidate, /execution interlock/i);
assert.match(triggerClosureCandidate, /not endpoint[\s\S]*security sign-off/i);
assert.match(triggerClosureCandidate, /Jitarsa must be reconciled independently/i);
assert.match(
  triggerClosureCandidate,
  /from pg_trigger trigger[\s\S]+procedure\.oid=trigger\.tgfoid[\s\S]+not trigger\.tgisinternal/i
);
assert.match(
  triggerClosureCandidate,
  /relation_namespace\.nspname='public'[\s\S]+relation_namespace\.nspname='auth'[\s\S]+relation\.relname='users'[\s\S]+function_namespace\.nspname='public'/i
);
assert.match(
  triggerClosureCandidate,
  /revoke all privileges on function %I\.%I\(%s\) from public, anon, authenticated, service_role/i
);
assert.match(
  triggerClosureCandidate,
  /alter function public\.set_updated_at\(\)[\s\S]+set search_path = pg_catalog, public/i
);
assert.match(triggerClosureCandidate, /CNYOS_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT/);
assert.match(triggerClosureCandidate, /CNYOS_SET_UPDATED_AT_SEARCH_PATH_MUTABLE/);
assert.doesNotMatch(triggerClosureCandidate, /grant\s+execute/i);

assertManualCandidateFailClosed(
  browserRpcAclClosure,
  'CNYOS_BROWSER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED'
);
assert.match(browserRpcAclClosure, /BROWSER RPC ACL DRIFT CLOSURE/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_CANDIDATE_AUTHORIZATION_REQUIRED/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID/);
assert.match(browserRpcAclClosure, /7666007964130682852/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_CANDIDATE_TARGET_MARKERS_INVALID/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_CANDIDATE_LEDGER_MANIFEST_INVALID/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_CANDIDATE_DURABLE_LEDGER_RECEIPT_INVALID/);
assert.match(browserRpcAclClosure, /b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a/);
assert.match(browserRpcAclClosure, /execution interlock/i);
assert.match(browserRpcAclClosure, /not[\s\S]*endpoint attestation[\s\S]*security sign-off/i);
assert.match(browserRpcAclClosure, /Jitarsa\s+remains unauthorized/i);
assert.doesNotMatch(browserRpcAclClosure, /disposable-fixture|test_system_identifier|template1/i);
assert.match(browserRpcAclClosure, /revoke all privileges on function %s from public, anon/i);
assert.match(browserRpcAclClosure, /revoke all privileges on function %s from service_role/i);
assert.match(
  browserRpcAclClosure,
  /public\.create_clinical_treatment_session\(uuid,text\[\],text,boolean,text,text,smallint,smallint,text,text\)/i
);
assert.match(browserRpcAclClosure, /public\.book_clinic_appointment\(uuid,uuid,text,text,text\)/i);
assert.match(browserRpcAclClosure, /public\.create_approval_task\(text,text,text,text,text,text,uuid,timestamptz,jsonb\)/i);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_RPC_ANON_EXECUTE_PRESENT/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_WRITE_SERVICE_EXECUTE_PRESENT/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_RPC_AUTHENTICATED_EXECUTE_MISSING/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_HELPER_SERVICE_EXECUTE_MISSING/);
assert.match(browserRpcAclClosure, /owner_role\.rolname is distinct from 'postgres'/i);
assert.equal(
  (browserRpcAclClosure.match(/CNYOS_BROWSER_RPC_OWNER_INVALID/g) || []).length,
  2,
  'browser RPC owner drift must fail both before and after ACL mutation'
);
assert.match(browserRpcAclClosure, /aclexplode\(coalesce\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/i);
assert.match(browserRpcAclClosure, /acl\.grantor = p\.proowner/i);
assert.match(browserRpcAclClosure, /not acl\.is_grantable/i);
assert.match(browserRpcAclClosure, /case when acl\.grantee=0 then 'PUBLIC'/i);
assert.doesNotMatch(browserRpcAclClosure, /coalesce\([^)]*rolname\s*,\s*'PUBLIC'/i);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_RPC_ACL_MISSING/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_RPC_ACL_INVALID/);
assert.match(browserRpcAclClosure, /v_expected_authenticated_signatures constant text\[\]/);
assert.match(browserRpcAclClosure, /v_expected_service_signatures constant text\[\]/);
assert.match(browserRpcAclClosure, /v_actual_anon_signatures is distinct from array\[\]::text\[\]/);
assert.match(browserRpcAclClosure, /replace\(oidvectortypes\(procedure\.proargtypes\),', ',','\)/);
assert.match(browserRpcAclClosure, /has_schema_privilege\('anon',function_namespace\.oid,'USAGE'\) and\s+has_function_privilege\('anon',procedure\.oid,'EXECUTE'\)/);
assert.match(browserRpcAclClosure, /has_schema_privilege\('authenticated',function_namespace\.oid,'USAGE'\) and\s+has_function_privilege\('authenticated',procedure\.oid,'EXECUTE'\)/);
assert.match(browserRpcAclClosure, /has_schema_privilege\('service_role',function_namespace\.oid,'USAGE'\) and\s+has_function_privilege\('service_role',procedure\.oid,'EXECUTE'\)/);
assert.ok((browserRpcAclClosure.match(/procedure\.prokind::text/g) || []).length >= 2);
assert.ok((browserRpcAclClosure.match(/procedure\.prosecdef/g) || []).length >= 2);
assert.match(browserRpcAclClosure, /cnyos-public-routine-acl\/v2/);
assert.match(browserRpcAclClosure, /a9d23d5e9225fd4f9a0757affdc8dbacb38d6f2efdc6fc95a59d2dcba600e4b8/);
assert.match(browserRpcAclClosure, /3bc63c84da258f7699654d4d38c49c7bba6840aa0e9038c7714812141fddb705/);
assert.match(browserRpcAclClosure, /6569ee52b64662ff6fd8ccfe26ecb7e4abe4b71165213797ead3ca5f72fa7581/);
assert.match(browserRpcAclClosure, /CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID/);
assert.match(browserRpcAclClosure, /PROJECTED_CANONICAL_AUTHENTICATED_EFFECTIVE_SIGNATURES_INVALID/);
assert.doesNotMatch(browserRpcAclClosure, /CNYOS_BROWSER_PUBLIC_EXECUTE_INVENTORY_INVALID/);
for (const predicate of [
  "dependency.classid='pg_proc'::regclass",
  'dependency.objid=procedure.oid',
  'dependency.objsubid=0',
  "dependency.refclassid='pg_extension'::regclass",
  "dependency.deptype='e'"
]) {
  assert.equal(
    browserRpcAclClosure.split(predicate).length - 1,
    4,
    `every projected public-routine query must pin extension ownership: ${predicate}`
  );
}
assert.doesNotMatch(
  browserRpcAclClosure,
  /CNYOS_PGLITE_CRYPTO_FIXTURE_ONLY|gen_random_uuid|gen_random_bytes|digest\(text,text\)/i
);
assert.doesNotMatch(browserRpcAclClosure, /grant\s+execute/i);

const orderedMigrationSources = fs.readdirSync(path.join(root, 'supabase', 'migrations'))
  .filter(file => file.endsWith('.sql'))
  .map(file => read(path.join('supabase', 'migrations', file)))
  .join('\n');
assert.doesNotMatch(
  orderedMigrationSources,
  /CNYOS_(?:TRIGGER|BROWSER)_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED/
);
assert.doesNotMatch(
  orderedMigrationSources,
  /chananya-staging-(?:trigger-acl|browser-rpc-acl)-candidate-20260906/
);

const privilegedInventory = read('supabase/manual/security_definer_exposure_inventory.sql');
assert.match(privilegedInventory, /has_function_privilege\('anon', p\.oid, 'EXECUTE'\)/i);
assert.match(privilegedInventory, /has_function_privilege\('authenticated', p\.oid, 'EXECUTE'\)/i);
assert.match(privilegedInventory, /has_function_privilege\('service_role', p\.oid, 'EXECUTE'\)/i);
assert.match(privilegedInventory, /internal_trigger/);
assert.match(privilegedInventory, /review_anon_security_definer/);

console.log(`Service-role Data API contract passed: ${discovered.size} reviewed reads/writes, exact final DML allowlist, tenant-derived QR issuer, trigger RPC closure, and browser RPC ACL drift closure candidates`);
