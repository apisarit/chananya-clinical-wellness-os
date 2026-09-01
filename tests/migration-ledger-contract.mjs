import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';
import { buildTenantBootstrapSql } from '../scripts/generate-tenant-bootstrap-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'tenant.cnyos-staging.json'), 'utf8'));
const chananyaConfig = JSON.parse(await fs.readFile(path.join(root, 'config', 'tenant.chananya.json'), 'utf8'));
const entries = loadMigrationEntries(root);
const expectedOwnerControlMigrationHashes = new Map([
  ['202608311800_owner_subscription_control.sql', 'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'],
  ['202609010500_owner_drive_assignment.sql', '4dd57c65339b37a9e17aa388e65768a4de29949a3671cf2d9a07d6b65d63ccc7'],
  ['202609010600_owner_drive_backup_evidence.sql', '804b59ca0bc08e045683ba961b3af83ddcb07447e0932f6d765cfc42a6123de8'],
  ['202609010700_owner_control_historical_replay_guard.sql', '4d53620ca1cd20bf8d9288faf684ddf6d8fac5033ff0fd99da76a0e701d5d157'],
  ['202609010800_owner_subscription_concurrency.sql', '6d107c39307fc714fcf2b50425b5df6792b1063ac130969312975356b2a2378a'],
  ['202609010900_backup_restore_source_binding.sql', '4c2a4f2fb65eba3865825884f3e669ff59a03fcf4a271765b8cde8cd044fc234'],
  ['202609011000_owner_subscription_kill_switch_closure.sql', 'd94d5e83e22f7c88c43f1fbd5bf4d75dcc9cb2ec7618c14c4344eefd4dfe590a'],
  ['202609011100_owner_subscription_forward_only_guard.sql', '8d82eb555bf8e311aeb762ff597e5d896a1158fce78bfc410613665d3d7debf8'],
  ['202609011200_backup_terminal_run_guard.sql', 'a2ce8e32895e37952543debdd19f76df2b87706fbef05c987f56f7f1fbb51407'],
  ['202609011300_archive_delegate_execution_hardening.sql', 'f3bbdf8e9e8527dc1125c143e2bc8de6da42d5e1c3d6b19f0cb2db3ec9df89f7']
]);

assert.equal(entries.length, 45);
assert.deepEqual(entries, [...entries].sort((a, b) => a.file.localeCompare(b.file)));
assert.equal(config.tenant.expectedClinicId, '00000000-0000-4000-8000-00000000a001');
assert.ok(entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));
for (const [file, sha256] of expectedOwnerControlMigrationHashes) {
  assert.equal(
    entries.find(entry => entry.file === file)?.sha256,
    sha256,
    `${file} must keep its reviewed migration-ledger fingerprint`
  );
}

const recoverySql = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40)
});
const bootstrapSql = buildTenantBootstrapSql(config);
const chananyaBootstrapSql = buildTenantBootstrapSql(chananyaConfig);
assert.match(bootstrapSql, /insert into public\.clinics/i);
assert.match(bootstrapSql, /on conflict \(id\) do update/i);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
assert.match(bootstrapSql, /where clinics\.code = excluded\.code/i);
assert.match(bootstrapSql, /CLINICAL_OS_TENANT_BOOTSTRAP_READY/);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
assert.doesNotMatch(bootstrapSql, /^update public\.clinics/im);
assert.doesNotMatch(bootstrapSql, /`  active = true,/);
assert.match(recoverySql, /STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA/);
assert.match(recoverySql, /STAGING_SCHEMA_RELATIONS_MISSING/);
assert.match(recoverySql, /STAGING_SECURITY_DEFINERS_MISSING/);
assert.match(recoverySql, /public\.clinic_drive_backup_destinations/);
assert.match(recoverySql, /public\.clinic_drive_destination_events/);
assert.match(recoverySql, /public\.owner_control_historical_replay_guard/);
assert.match(recoverySql, /public\.list_owner_drive_assignments\(\)/);
assert.match(recoverySql, /public\.get_clinic_drive_backup_destination\(uuid,text\)/);
assert.match(recoverySql, /public\.set_clinic_drive_assignment\(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260831\(uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260829\(uuid,text\)/);
assert.match(recoverySql, /public\.export_clinic_backup_domain_v20260828\(uuid,text\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260831\(uuid\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260829\(uuid\)/);
assert.match(recoverySql, /public\.verify_clinic_restore_trace_v20260828\(uuid\)/);
assert.match(recoverySql, /public\.set_clinic_subscription_state\(uuid,uuid,text,boolean,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.set_clinic_subscription_state_v20260901\(uuid,uuid,text,boolean,bigint,text,uuid,text\)/);
assert.match(recoverySql, /public\.guard_owner_subscription_forward_only\(\)/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_CONCURRENCY_IMPLEMENTATION_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_GUARD_INVALID/);
assert.match(recoverySql, /trg_clinics_owner_subscription_forward_only/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_FORWARD_TRIGGER_INVALID/);
assert.match(recoverySql, /public\.practitioner_schedules/);
assert.match(recoverySql, /public\.appointment_events/);
assert.match(recoverySql, /public\.approval_actions/);
assert.match(recoverySql, /practitioner_schedules\.clinic_id/);
assert.match(recoverySql, /clinic_appointments\.clinic_id/);
assert.match(recoverySql, /appointment_events\.clinic_id/);
assert.match(recoverySql, /approval_tasks\.clinic_id/);
assert.match(recoverySql, /approval_actions\.clinic_id/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID/);
assert.match(recoverySql, /public\.assert_clinic_subscription_active\(uuid\)/);
assert.match(recoverySql, /public\.prepare_line_subscription_off_exception\(uuid,text\)/);
assert.match(recoverySql, /public\.enforce_active_subscription_tenant_write\(\)/);
assert.match(recoverySql, /public\.book_clinic_appointment\(uuid,uuid,text,text,text\)/);
assert.match(recoverySql, /public\.create_approval_task\(text,text,text,text,text,text,uuid,timestamptz,jsonb\)/);
assert.match(recoverySql, /public\.consume_patient_identity_rate_limit_for_clinic\(uuid,text,integer,integer\)/);
assert.match(recoverySql, /public\.register_line_oa_webhook_event_for_clinic\(uuid,text,text,text,text,text,timestamptz,boolean,text\)/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_KILL_SWITCH_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_ANON_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_LEGACY_PROCEDURE_MISSING/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT/);
assert.match(recoverySql, /public\.line_oa_queue_notification_v20260829\(uuid,text,timestamptz,timestamptz,text\)/);
assert.match(recoverySql, /public\.line_oa_register_gateway_v20260829\(text,text,text,text,text,timestamptz,boolean,text\)/);
assert.match(recoverySql, /STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/);
assert.match(recoverySql, /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/);
assert.match(recoverySql, /STAGING_SENSITIVE_CLOSED_PROCEDURE_RUNTIME_OWNER/);
assert.match(recoverySql, /STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER/);
assert.match(recoverySql, /STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_SENSITIVE_RELATION_OWNER_MISMATCH/);
assert.match(recoverySql, /public\.line_oa_operational_healthcheck\(\)/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_UNEXPECTED_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_LINE_HEALTHCHECK_BODY_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_RPC_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_SERVICE_RPC_GATE_INVALID/);
assert.match(recoverySql, /STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING/);
assert.match(recoverySql, /STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING/);
assert.match(recoverySql, /trg_cnyos_authenticated_subscription_statement_write/);
assert.match(recoverySql, /public\.enforce_authenticated_subscription_statement_write\(\)/);
assert.match(recoverySql, /STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_TRIGGER_INVALID/);
assert.match(recoverySql, /trg_cnyos_active_subscription_write/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_WRITE_TRIGGER_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_DML_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_SEQUENCE_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_RELATION_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_COLUMN_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_OWNER_MISMATCH/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_OWNER_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_ACL_MISSING/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_ACL_INVALID/);
assert.match(recoverySql, /STAGING_PUBLIC_SCHEMA_RUNTIME_PRIVILEGES_INVALID/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING/);
assert.match(recoverySql, /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/);
assert.match(recoverySql, /STAGING_UNGUARDED_SERVICE_ROLE_DML_PRESENT/);
assert.match(recoverySql, /STAGING_CURRENT_CLINIC_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_CURRENT_DEPARTMENT_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_CURRENT_ACCESS_SUBSCRIPTION_GATE_INVALID/);
assert.match(recoverySql, /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/);
assert.match(recoverySql, /STAGING_ACTIVE_SUBSCRIPTION_WRITE_GUARD_INVALID/);
assert.match(recoverySql, /STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_GUARD_INVALID/);
assert.match(recoverySql, /STAGING_LINE_OFF_EXCEPTION_CAPABILITY_INVALID/);
assert.match(recoverySql, /STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_LINE_FINISH_WEBHOOK_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_LINE_FINISH_NOTIFICATION_OFF_EXCEPTION_INVALID/);
assert.match(recoverySql, /STAGING_BROWSER_SECURITY_DEFINER_SUBSCRIPTION_GATE_MISSING/);
assert.match(recoverySql, /public\.begin_backup_export_run\(uuid,timestamptz,text\)/);
assert.match(recoverySql, /public\.get_exact_backup_restore_source\(text,timestamptz,text\)/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_BACKUP_EXPORT_EVIDENCE_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RESTORE_EVIDENCE_WRAPPER_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID/);
assert.match(recoverySql, /STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT/);
assert.match(recoverySql, /clinic_subscription_control_events\.expected_version/);
assert.match(recoverySql, /STAGING_OWNER_SUBSCRIPTION_EXPECTED_VERSION_INVALID/);
assert.match(recoverySql, /trg_clinic_subscription_control_events_append_only/);
assert.match(recoverySql, /trg_clinic_drive_destination_events_append_only/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_TRIGGER_INVALID/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_FUNCTION_INVALID/);
assert.match(recoverySql, /STAGING_APPEND_ONLY_FUNCTION_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_RLS_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT/);
assert.match(recoverySql, /STAGING_OWNER_REPLAY_GUARD_ROW_MISSING/);
assert.match(recoverySql, /schema_version='2026-09-01\.1'/);
assert.match(recoverySql, /transaction_table_count=12/);
assert.match(recoverySql, /BACKUP_RESTORE_CONTRACT_MISMATCH/);
assert.match(recoverySql, /MIGRATION_LEDGER_SHA256_CONFLICT/);
assert.doesNotMatch(recoverySql, /statements=coalesce/);
assert.match(recoverySql, /supabase_migrations\.schema_migrations/);
assert.match(recoverySql, /statements text\[\]/);
assert.match(recoverySql, /name text/);
assert.match(recoverySql, /CHANANYA_STAGING_MIGRATION_LEDGER_READY/);
assert.match(recoverySql, /set local search_path = pg_catalog, public;/i);
for (const entry of entries) {
  assert.match(recoverySql, new RegExp(entry.version));
  assert.match(recoverySql, new RegExp(entry.sha256));
}
assert.doesNotMatch(recoverySql, /qptxnrldzzinlcabudjv|sb_secret_|service_role\s*[:=]\s*['"][A-Za-z0-9_.-]{10,}/i);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: { ...config, deploymentId: 'chananya-clinical-production' },
    entries
  }),
  /staging\/non-production/
);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config,
    entries: entries.map(entry => entry.file === '202608311800_owner_subscription_control.sql'
      ? { ...entry, sha256: '0'.repeat(64) }
      : entry)
  }),
  /Immutable historical migration SHA mismatch/
);

const db = new PGlite();
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role authenticator login noinherit;
  grant anon,authenticated,service_role to authenticator;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to authenticated, service_role;
  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (
      substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||
      '-a'||substr(x,18,3)||'-'||substr(x,21,12)
    )::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2), 'hex')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`);

for (const entry of entries) {
  const source = (await fs.readFile(path.join(migrationsDir, entry.file), 'utf8'))
    .replace(/create extension if not exists pgcrypto\s*;/gi, '');
  await db.exec(source);
}

const trustedMigrationOwner = (await db.query(`
  select owner_role.rolname
  from pg_class c
  join pg_roles owner_role on owner_role.oid=c.relowner
  where c.oid=to_regclass('public.clinics')
`)).rows[0].rolname;
assert.match(trustedMigrationOwner, /^[a-z_][a-z0-9_$]*$/i);
const trustedMigrationOwnerSql = `"${trustedMigrationOwner.replaceAll('"', '""')}"`;
const trustedPublicSchemaOwner = (await db.query(`
  select owner_role.rolname
  from pg_namespace n
  join pg_roles owner_role on owner_role.oid=n.nspowner
  where n.nspname='public'
`)).rows[0].rolname;
assert.match(trustedPublicSchemaOwner, /^[a-z_][a-z0-9_$]*$/i);
const trustedPublicSchemaOwnerSql = `"${trustedPublicSchemaOwner.replaceAll('"', '""')}"`;

const LEGACY_CLINIC_ID = '00000000-0000-0000-0000-000000000001';
assert.equal(
  (await db.query('select count(*)::int count from public.clinics')).rows[0].count,
  0,
  'a pristine fresh migration chain must remove the historical clinic seed before tenant bootstrap'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_state where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  0,
  'a pristine fresh migration chain must remove the historical clinic-state seed'
);

await db.exec(chananyaBootstrapSql);
await db.exec(chananyaBootstrapSql);
assert.deepEqual(
  (await db.query('select id,code from public.clinics order by code')).rows,
  [{ id: LEGACY_CLINIC_ID, code: 'CHANANYA' }],
  'a fresh canonical deployment must still bootstrap exactly one CHANANYA clinic'
);
await db.exec(`
  delete from public.clinic_state where id='${LEGACY_CLINIC_ID}';
  delete from public.clinics where id='${LEGACY_CLINIC_ID}';
`);

const requiredServiceRolePrivileges = [
  ['profiles', ['SELECT', 'INSERT', 'UPDATE']],
  ['clinic_memberships', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_sources', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_concepts', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_concept_relations', ['SELECT', 'INSERT', 'UPDATE']],
  ['ttm_diagnostic_knowledge', ['SELECT', 'INSERT', 'UPDATE']],
  ['audit_logs', ['SELECT', 'INSERT']],
  ['inventory_lots', ['SELECT', 'INSERT']],
  ['patient_qr_sessions', ['SELECT', 'UPDATE']]
];
for (const [table, privileges] of requiredServiceRolePrivileges) {
  for (const privilege of privileges) {
    assert.equal(
      (await db.query(`select has_table_privilege('service_role','public.${table}','${privilege}') allowed`)).rows[0].allowed,
      true,
      `service_role must receive ${privilege} on ${table}`
    );
  }
  for (const privilege of ['DELETE', 'TRUNCATE']) {
    assert.equal(
      (await db.query(`select has_table_privilege('service_role','public.${table}','${privilege}') allowed`)).rows[0].allowed,
      false,
      `service_role must not receive ${privilege} on ${table}`
    );
  }
  assert.equal(
    (await db.query(`select has_table_privilege('anon','public.${table}','SELECT') allowed`)).rows[0].allowed,
    false,
    `anon must not read ${table}`
  );
}
for (const table of ['profiles', 'audit_logs']) {
  assert.equal(
    (await db.query(`select has_table_privilege('authenticated','public.${table}','SELECT') allowed`)).rows[0].allowed,
    true,
    `authenticated browser runtime must read ${table} through RLS`
  );
}

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${LEGACY_CLINIC_ID}','CHANANYA','Legacy seed','Legacy seed');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_LEGACY_SEED_PRESENT/);
await db.exec('rollback;');
await db.exec(`delete from public.clinics where id='${LEGACY_CLINIC_ID}'`);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('00000000-0000-4000-8000-00000000b002','${config.tenant.expectedClinicCode}','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select count(*)::int count from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].count, 0);
await db.exec(`delete from public.clinics where id='00000000-0000-4000-8000-00000000b002'`);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${config.tenant.expectedClinicId}','OTHER-STG','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select code from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].code, 'OTHER-STG');
await db.exec(`delete from public.clinics where id='${config.tenant.expectedClinicId}'`);

await db.exec(bootstrapSql);
await db.exec(bootstrapSql);
const stagingClinic = await db.query(`
  select id,code,active
  from public.clinics
  where id='${config.tenant.expectedClinicId}'
`);
assert.deepEqual(stagingClinic.rows, [{
  id: config.tenant.expectedClinicId,
  code: config.tenant.expectedClinicCode,
  active: true
}]);
assert.equal(
  (await db.query('select count(*)::int count from public.clinics')).rows[0].count,
  1,
  'an isolated white-label database must contain exactly one bootstrapped clinic'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinics where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  0,
  'the historical clinic seed must not survive a fresh white-label bootstrap'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_state where id='${config.tenant.expectedClinicId}'`)).rows[0].count,
  1,
  'tenant bootstrap must create the isolated clinic-state row'
);

const ADMIN_ID = '33333333-3333-4333-a333-333333333333';
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data)
  values ('${ADMIN_ID}','staging-admin@example.test','{"full_name":"Staging Admin"}');
  update public.profiles
  set role='viewer',system_role='super_admin'
  where id='${ADMIN_ID}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary)
  values ('${config.tenant.expectedClinicId}','${ADMIN_ID}','owner',true);
`);

const cleanupMigration = (await fs.readFile(
  path.join(migrationsDir, '202609010100_fresh_white_label_seed_cleanup.sql'),
  'utf8'
)).replace(/create extension if not exists pgcrypto\s*;/gi, '');
const ownerDriveAssignmentMigration = await fs.readFile(
  path.join(migrationsDir, '202609010500_owner_drive_assignment.sql'),
  'utf8'
);
const beginBackupFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.begin_backup_export_run(uuid,timestamptz,text)')
  ) definition
`)).rows[0].definition;
const beginBackupWithoutTerminalGuardDefinition = beginBackupFunctionDefinition.replace(
  /\n    if v_run\.status in \('completed', 'partial', 'failed'\) then\n      return query select v_run\.id, false;\n      return;\n    end if;\n/i,
  '\n'
);
assert.notEqual(
  beginBackupWithoutTerminalGuardDefinition,
  beginBackupFunctionDefinition,
  'the terminal-outcome negative fixture must remove the reviewed terminal guard'
);
const beginBackupReplayAndCorruptionDefinition = beginBackupFunctionDefinition.replace(
  'or v_run.request_id is not distinct from v_request_id',
  'and v_run.request_id is not distinct from v_request_id'
);
assert.notEqual(
  beginBackupReplayAndCorruptionDefinition,
  beginBackupFunctionDefinition,
  'the stale replay negative fixture must weaken OR to AND'
);
const exactRestoreSourceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.get_exact_backup_restore_source(text,timestamptz,text)')
  ) definition
`)).rows[0].definition;
const subscriptionAssertionFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.assert_clinic_subscription_active(uuid)')
  ) definition
`)).rows[0].definition;
const subscriptionAssertionAndCorruptionDefinition = subscriptionAssertionFunctionDefinition.replace(
  "if not v_clinic.active or v_clinic.subscription_state <> 'active' then",
  "if not v_clinic.active and v_clinic.subscription_state <> 'active' then"
);
assert.notEqual(
  subscriptionAssertionAndCorruptionDefinition,
  subscriptionAssertionFunctionDefinition,
  'the subscription assertion negative fixture must weaken OR to AND'
);
const appendOnlyFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.reject_append_only_mutation()')
  ) definition
`)).rows[0].definition;
const finalizeLineGatewayFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.finalize_line_oa_webhook_event(text,text,text,text,text)')
  ) definition
`)).rows[0].definition;
const finalizeLineGatewayWithoutRoleGateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /\n\s*if\s+auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'(?:::text)?\s+then\s+raise\s+exception\s+'SERVICE_ROLE_REQUIRED';\s+end\s+if;\s*/i,
  '\n'
);
assert.notEqual(
  finalizeLineGatewayWithoutRoleGateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE gateway negative fixture must remove the explicit service-role body gate'
);
const finalizeLineGatewayFalseAndRoleGateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /if\s+auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'(?:::text)?\s+then/i,
  "if false and auth.role() is distinct from 'service_role' then"
);
assert.notEqual(
  finalizeLineGatewayFalseAndRoleGateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE gateway negative fixture must preserve gate tokens while making the gate unreachable'
);
const finalizeLineGatewayOrTrueStateDefinition = finalizeLineGatewayFunctionDefinition.replace(
  /and\s+processing_status\s*=\s*'processing'(?:::text)?/i,
  "and (processing_status = 'processing' or true)"
);
assert.notEqual(
  finalizeLineGatewayOrTrueStateDefinition,
  finalizeLineGatewayFunctionDefinition,
  'the LINE finalizer negative fixture must preserve state tokens while allowing terminal replay'
);
const lineGatewayEvidenceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.line_oa_webhook_evidence(timestamptz)')
  ) definition
`)).rows[0].definition;
const lineGatewayEvidenceOrTrueWindowDefinition = lineGatewayEvidenceFunctionDefinition.replace(
  /where\s+e\.created_at\s*>=\s*greatest\s*\(/i,
  'where true or e.created_at >= greatest('
);
assert.notEqual(
  lineGatewayEvidenceOrTrueWindowDefinition,
  lineGatewayEvidenceFunctionDefinition,
  'the LINE evidence negative fixture must preserve window tokens while bypassing retention'
);
const lineOperationalHealthcheckFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure('public.line_oa_operational_healthcheck()')
  ) definition
`)).rows[0].definition;
const lineOperationalHealthcheckOrTrueDefinition = lineOperationalHealthcheckFunctionDefinition.replace(
  /or\s+public\.is_super_admin\(\)/i,
  'or true'
);
assert.notEqual(
  lineOperationalHealthcheckOrTrueDefinition,
  lineOperationalHealthcheckFunctionDefinition,
  'the LINE healthcheck negative fixture must remove the exact admin gate'
);
const linePreferenceFunctionDefinition = (await db.query(`
  select pg_get_functiondef(
    to_regprocedure(
      'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'
    )
  ) definition
`)).rows[0].definition;
await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${LEGACY_CLINIC_ID}','CHANANYA','Existing Chananya','Existing Chananya');
  insert into public.clinic_state(id) values ('${LEGACY_CLINIC_ID}');
`);
await db.exec(cleanupMigration);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinics where id='${LEGACY_CLINIC_ID}'`)).rows[0].count,
  1,
  'the fresh-seed cleanup must preserve populated existing installations'
);
await db.exec(`
  delete from public.clinic_state where id='${LEGACY_CLINIC_ID}';
  delete from public.clinics where id='${LEGACY_CLINIC_ID}';
`);

async function assertRecoveryGuard({ setup, expected, repair }) {
  await db.exec(setup);
  await assert.rejects(db.exec(recoverySql), expected);
  await db.exec('rollback;');
  await db.exec(repair);
}

await assertRecoveryGuard({
  setup: 'alter table public.clinic_drive_destination_events disable row level security',
  expected: /STAGING_OWNER_DRIVE_RLS_MISSING/,
  repair: 'alter table public.clinic_drive_destination_events enable row level security'
});
await assertRecoveryGuard({
  setup: 'alter table public.owner_control_historical_replay_guard no force row level security',
  expected: /STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING/,
  repair: 'alter table public.owner_control_historical_replay_guard force row level security'
});
await assertRecoveryGuard({
  setup: 'grant select on public.owner_control_historical_replay_guard to service_role',
  expected: /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke all on public.owner_control_historical_replay_guard from service_role'
});
await assertRecoveryGuard({
  setup: 'grant select(historical_sha256) on public.owner_control_historical_replay_guard to service_role',
  expected: /STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke select(historical_sha256) on public.owner_control_historical_replay_guard from service_role'
});
await assertRecoveryGuard({
  setup: `
    create policy corrupted_owner_replay_guard_policy
    on public.owner_control_historical_replay_guard
    for select to authenticated using (false)
  `,
  expected: /STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT/,
  repair: 'drop policy corrupted_owner_replay_guard_policy on public.owner_control_historical_replay_guard'
});
await assertRecoveryGuard({
  setup: 'delete from public.owner_control_historical_replay_guard',
  expected: /STAGING_OWNER_REPLAY_GUARD_ROW_MISSING/,
  repair: `
    insert into public.owner_control_historical_replay_guard(
      singleton,protected_migration,historical_sha256
    ) values (
      true,
      '202608311800_owner_subscription_control',
      'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
    )
  `
});
await assertRecoveryGuard({
  setup: `
    drop policy appointment_events_read on public.appointment_events;
    create policy appointment_events_read on public.appointment_events
      for select to authenticated
      using (
        (
          clinic_id=public.current_clinic_id()
          and (
            public.is_clinic_admin()
            or exists (
              select 1 from public.clinic_appointments a
              where a.id=appointment_events.appointment_id
                and a.clinic_id=appointment_events.clinic_id
                and a.practitioner_id=auth.uid()
            )
          )
        )
        or true
      )
  `,
  expected: /STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID/,
  repair: `
    drop policy appointment_events_read on public.appointment_events;
    create policy appointment_events_read on public.appointment_events
      for select to authenticated
      using (
        clinic_id=public.current_clinic_id()
        and (
          public.is_clinic_admin()
          or exists (
            select 1 from public.clinic_appointments a
            where a.id=appointment_events.appointment_id
              and a.clinic_id=appointment_events.clinic_id
              and a.practitioner_id=auth.uid()
          )
        )
      )
  `
});
await assertRecoveryGuard({
  setup: 'grant select on public.clinic_drive_backup_destinations to authenticated',
  expected: /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke all on public.clinic_drive_backup_destinations from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant update(environment) on public.clinic_drive_backup_destinations to authenticated',
  expected: /STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT/,
  repair: 'revoke update(environment) on public.clinic_drive_backup_destinations from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.list_owner_drive_assignments() to authenticated',
  expected: /STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.list_owner_drive_assignments() from authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) from service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) to authenticated',
  expected: /STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text) to service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text) from service_role'
});
await assertRecoveryGuard({
  setup: 'alter table public.approval_actions alter column clinic_id drop not null',
  expected: /STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID/,
  repair: 'alter table public.approval_actions alter column clinic_id set not null'
});
await assertRecoveryGuard({
  setup: 'alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey',
  expected: /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/,
  repair: `
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (task_id,clinic_id)
      references public.approval_tasks(id,clinic_id) on delete cascade
  `
});
await assertRecoveryGuard({
  setup: `
    alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey;
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (clinic_id)
      references public.clinics(id) on delete restrict
  `,
  expected: /STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID/,
  repair: `
    alter table public.approval_actions drop constraint approval_actions_task_clinic_fkey;
    alter table public.approval_actions
      add constraint approval_actions_task_clinic_fkey
      foreign key (task_id,clinic_id)
      references public.approval_tasks(id,clinic_id) on delete cascade
  `
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) from service_role',
  expected: /STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text) to service_role',
  expected: /STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text) from service_role'
});
await assertRecoveryGuard({
  setup: `
    alter function public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)
      rename to corrupted_line_oa_register_gateway_v20260829
  `,
  expected: /STAGING_SCHEMA_FUNCTIONS_MISSING/,
  repair: `
    alter function public.corrupted_line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)
      rename to line_oa_register_gateway_v20260829
  `
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.export_clinic_backup_domain_v20260828(uuid,text) to service_role',
  expected: /STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.export_clinic_backup_domain_v20260828(uuid,text) from service_role'
});
await assertRecoveryGuard({
  setup: 'alter function public.export_clinic_backup_domain_v20260831(uuid,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.export_clinic_backup_domain_v20260831(uuid,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: 'alter function public.verify_clinic_restore_trace_v20260829(uuid) security invoker',
  expected: /STAGING_SECURITY_DEFINERS_MISSING/,
  repair: 'alter function public.verify_clinic_restore_trace_v20260829(uuid) security definer'
});
await assertRecoveryGuard({
  setup: `
    create role archive_drift_owner nologin;
    grant create on schema public to archive_drift_owner;
    alter function public.export_clinic_backup_domain_v20260829(uuid,text)
      owner to archive_drift_owner
  `,
  expected: /STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH/,
  repair: `
    alter function public.export_clinic_backup_domain_v20260829(uuid,text) owner to postgres;
    revoke all on schema public from archive_drift_owner;
    drop role archive_drift_owner
  `
});
await assertRecoveryGuard({
  setup: `
    grant create on schema public to authenticated;
    alter function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      owner to authenticated
  `,
  expected: /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/,
  repair: `
    alter function public.finalize_line_oa_webhook_event(text,text,text,text,text) owner to postgres;
    revoke create on schema public from authenticated;
    revoke all on function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      from public,anon,authenticated,service_role;
    grant execute on function public.finalize_line_oa_webhook_event(text,text,text,text,text)
      to service_role
  `
});
await assertRecoveryGuard({
  setup: `
    grant create on schema public to service_role;
    alter table public.owner_control_historical_replay_guard owner to service_role
  `,
  expected: /STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER/,
  repair: `
    alter table public.owner_control_historical_replay_guard owner to postgres;
    revoke create on schema public from service_role
  `
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.line_oa_webhook_evidence(timestamptz) from service_role',
  expected: /STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING/,
  repair: 'grant execute on function public.line_oa_webhook_evidence(timestamptz) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.finalize_line_oa_webhook_event(text,text,text,text,text) to authenticated',
  expected: /STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.finalize_line_oa_webhook_event(text,text,text,text,text) from authenticated'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_webhook_evidence(timestamptz) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.line_oa_webhook_evidence(timestamptz) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayWithoutRoleGateDefinition,
  expected: /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayFalseAndRoleGateDefinition,
  expected: /STAGING_LINE_GATEWAY_ROLE_GATE_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: finalizeLineGatewayOrTrueStateDefinition,
  expected: /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/,
  repair: finalizeLineGatewayFunctionDefinition
});
await assertRecoveryGuard({
  setup: lineGatewayEvidenceOrTrueWindowDefinition,
  expected: /STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID/,
  repair: lineGatewayEvidenceFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create role sensitive_function_drift_owner nologin;
    grant create on schema public to sensitive_function_drift_owner;
    alter function public.begin_backup_export_run(uuid,timestamptz,text)
      owner to sensitive_function_drift_owner
  `,
  expected: /STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH/,
  repair: `
    alter function public.begin_backup_export_run(uuid,timestamptz,text)
      owner to ${trustedMigrationOwnerSql};
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role;
    revoke all on schema public from sensitive_function_drift_owner;
    drop role sensitive_function_drift_owner
  `
});
await assertRecoveryGuard({
  setup: `
    create role sensitive_relation_drift_owner nologin;
    grant create on schema public to sensitive_relation_drift_owner;
    alter table public.clinic_drive_backup_destinations
      owner to sensitive_relation_drift_owner
  `,
  expected: /STAGING_SENSITIVE_RELATION_OWNER_MISMATCH/,
  repair: `
    alter table public.clinic_drive_backup_destinations
      owner to ${trustedMigrationOwnerSql};
    revoke all on schema public from sensitive_relation_drift_owner;
    drop role sensitive_relation_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() security invoker',
  expected: /STAGING_SECURITY_DEFINERS_MISSING/,
  repair: 'alter function public.line_oa_operational_healthcheck() security definer'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() volatile',
  expected: /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/,
  repair: 'alter function public.line_oa_operational_healthcheck() stable'
});
await assertRecoveryGuard({
  setup: 'alter function public.line_oa_operational_healthcheck() reset search_path',
  expected: /STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID/,
  repair: 'alter function public.line_oa_operational_healthcheck() set search_path=public'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.line_oa_operational_healthcheck() from service_role',
  expected: /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/,
  repair: 'grant execute on function public.line_oa_operational_healthcheck() to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.line_oa_operational_healthcheck() to anon',
  expected: /STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT/,
  repair: 'revoke all on function public.line_oa_operational_healthcheck() from anon'
});
await assertRecoveryGuard({
  setup: lineOperationalHealthcheckOrTrueDefinition,
  expected: /STAGING_LINE_HEALTHCHECK_BODY_INVALID/,
  repair: lineOperationalHealthcheckFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create role unauthorized_executor login;
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to unauthorized_executor
  `,
  expected: /STAGING_SERVICE_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.begin_backup_export_run(uuid,timestamptz,text)
      from unauthorized_executor;
    drop role unauthorized_executor
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role with grant option
  `,
  expected: /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/,
  repair: `
    revoke all on function public.begin_backup_export_run(uuid,timestamptz,text)
      from service_role;
    grant execute on function public.begin_backup_export_run(uuid,timestamptz,text)
      to service_role
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.line_oa_operational_healthcheck()
      to authenticated with grant option
  `,
  expected: /STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING/,
  repair: `
    revoke all on function public.line_oa_operational_healthcheck()
      from authenticated;
    grant execute on function public.line_oa_operational_healthcheck()
      to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    create role browser_rpc_drift_executor login;
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to browser_rpc_drift_executor
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from browser_rpc_drift_executor;
    drop role browser_rpc_drift_executor
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to authenticated with grant option
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from authenticated;
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      to service_role
  `,
  expected: /STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID/,
  repair: `
    revoke all on function public.book_clinic_appointment(uuid,uuid,text,text,text)
      from service_role
  `
});
await assertRecoveryGuard({
  setup: 'alter function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: 'alter function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) set search_path=public',
  expected: /STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID/,
  repair: 'alter function public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text) set search_path=pg_catalog,public'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.set_line_oa_notification_preference_for_subject(
      p_subject_hash text,p_patient_id uuid,p_clinic_id uuid,p_environment text,
      p_deployment_id text,p_channel_hash text,p_enabled boolean
    )
    returns table (
      patient_id uuid,operational_messaging_enabled boolean,
      appointment_reminders_enabled boolean
    )
    language plpgsql volatile security definer
    set search_path=pg_catalog,public
    as $$
    begin
      if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
      if p_enabled then
        perform public.assert_clinic_subscription_active(p_clinic_id);
      else
        perform public.prepare_line_subscription_off_exception(
          p_clinic_id,'line-consent-withdrawal/v1'
        );
      end if;
      return query select * from public.line_oa_set_preference_v20260829(
        p_subject_hash,p_patient_id,p_clinic_id,p_environment,
        p_deployment_id,p_channel_hash,p_enabled
      );
    end;
    $$;
  `,
  expected: /STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID/,
  repair: linePreferenceFunctionDefinition
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_appointments disable trigger trg_cnyos_active_subscription_write',
  expected: /STAGING_ACTIVE_SUBSCRIPTION_WRITE_TRIGGER_INVALID/,
  repair: 'alter table public.clinic_appointments enable trigger trg_cnyos_active_subscription_write'
});
await assertRecoveryGuard({
  setup: 'alter table public.products disable trigger trg_cnyos_authenticated_subscription_statement_write',
  expected: /STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_TRIGGER_INVALID/,
  repair: 'alter table public.products enable trigger trg_cnyos_authenticated_subscription_statement_write'
});
await assertRecoveryGuard({
  setup: 'alter function public.assert_clinic_subscription_active(uuid) stable',
  expected: /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/,
  repair: 'alter function public.assert_clinic_subscription_active(uuid) volatile'
});
await assertRecoveryGuard({
  setup: subscriptionAssertionAndCorruptionDefinition,
  expected: /STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID/,
  repair: subscriptionAssertionFunctionDefinition
});
await assertRecoveryGuard({
  setup: 'revoke insert on public.inventory_lots from service_role',
  expected: /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/,
  repair: 'grant insert on public.inventory_lots to service_role'
});
await assertRecoveryGuard({
  setup: 'grant insert on public.inventory_lots to service_role with grant option',
  expected: /STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING/,
  repair: `
    revoke insert on public.inventory_lots from service_role;
    grant insert on public.inventory_lots to service_role
  `
});
await assertRecoveryGuard({
  setup: 'grant update(id) on public.inventory_lots to service_role',
  expected: /STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID/,
  repair: 'revoke update(id) on public.inventory_lots from service_role'
});
await assertRecoveryGuard({
  setup: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.appointment_events','id');
    begin execute format('grant usage on sequence %s to service_role',v_sequence::regclass); end;
    $$;
  `,
  expected: /STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID/,
  repair: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.appointment_events','id');
    begin execute format('revoke all on sequence %s from service_role',v_sequence::regclass); end;
    $$;
  `
});
await assertRecoveryGuard({
  setup: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.audit_logs','id');
    begin
      execute format(
        'grant usage on sequence %s to service_role with grant option',
        v_sequence::regclass
      );
    end;
    $$;
  `,
  expected: /STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING/,
  repair: `
    do $$
    declare v_sequence text := pg_get_serial_sequence('public.audit_logs','id');
    begin
      execute format('revoke all on sequence %s from service_role',v_sequence::regclass);
      execute format('grant usage on sequence %s to service_role',v_sequence::regclass);
    end;
    $$;
  `
});
await assertRecoveryGuard({
  setup: 'grant insert on public.audit_logs to authenticated',
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: 'revoke insert on public.audit_logs from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant update on public.patients to authenticated',
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: 'revoke update on public.patients from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.reject_production_order(uuid,text,text) to authenticated',
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID/,
  repair: 'revoke all on function public.reject_production_order(uuid,text,text) from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create role pdpa_acl_drift_reader login bypassrls;
    grant select on public.patients to pdpa_acl_drift_reader
  `,
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: `
    revoke all on public.patients from pdpa_acl_drift_reader;
    drop role pdpa_acl_drift_reader
  `
});
await assertRecoveryGuard({
  setup: `
    create role inherited_acl_attack login bypassrls;
    grant authenticated to inherited_acl_attack;
    do $$
    begin
      if not has_table_privilege('inherited_acl_attack','public.patients','SELECT') then
        raise exception 'membership attack fixture did not inherit patient read';
      end if;
    end
    $$;
  `,
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/,
  repair: `
    revoke authenticated from inherited_acl_attack;
    do $$
    begin
      if has_table_privilege('inherited_acl_attack','public.patients','SELECT') then
        raise exception 'membership repair retained patient read';
      end if;
    end
    $$;
    drop role inherited_acl_attack
  `
});
await assertRecoveryGuard({
  setup: 'alter role authenticated bypassrls',
  expected: /STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID/,
  repair: 'alter role authenticated nobypassrls'
});
await assertRecoveryGuard({
  setup: 'grant create on schema public to authenticated',
  expected: /STAGING_PUBLIC_SCHEMA_ACL_INVALID/,
  repair: 'revoke create on schema public from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create role authenticator_child_attack login bypassrls;
    grant authenticator to authenticator_child_attack
  `,
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID/,
  repair: `
    revoke authenticator from authenticator_child_attack;
    drop role authenticator_child_attack
  `
});
await assertRecoveryGuard({
  setup: `
    create role public_schema_drift_owner nologin;
    alter schema public owner to public_schema_drift_owner
  `,
  expected: /STAGING_PUBLIC_SCHEMA_OWNER_INVALID/,
  repair: `
    alter schema public owner to ${trustedPublicSchemaOwnerSql};
    drop role public_schema_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'revoke usage on schema public from authenticated',
  expected: /STAGING_PUBLIC_SCHEMA_ACL_MISSING/,
  repair: 'grant usage on schema public to authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke authenticated from authenticator',
  expected: /STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING/,
  repair: 'grant authenticated to authenticator'
});
await assertRecoveryGuard({
  setup: 'grant update(id) on public.patients to authenticated',
  expected: /STAGING_PUBLIC_COLUMN_ACL_INVALID/,
  repair: 'revoke update(id) on public.patients from authenticated'
});
await assertRecoveryGuard({
  setup: 'grant select on public.patients to authenticated with grant option',
  expected: /STAGING_PUBLIC_RELATION_ACL_MISSING/,
  repair: `
    revoke select on public.patients from authenticated;
    grant select on public.patients to authenticated
  `
});
await assertRecoveryGuard({
  setup: `
    create role sequence_acl_drift login;
    grant usage on sequence public.audit_logs_id_seq to sequence_acl_drift
  `,
  expected: /STAGING_PUBLIC_RELATION_ACL_INVALID/,
  repair: `
    revoke all on sequence public.audit_logs_id_seq from sequence_acl_drift;
    drop role sequence_acl_drift
  `
});
await assertRecoveryGuard({
  setup: 'revoke execute on function public.search_patients_for_checkin(text) from authenticated',
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING/,
  repair: 'grant execute on function public.search_patients_for_checkin(text) to authenticated'
});
await assertRecoveryGuard({
  setup: `
    create function public.unreviewed_security_definer_rpc()
    returns boolean language sql stable security definer
    set search_path=pg_catalog,public as $$ select true $$;
    revoke all on function public.unreviewed_security_definer_rpc() from public
  `,
  expected: /STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID/,
  repair: 'drop function public.unreviewed_security_definer_rpc()'
});
await assertRecoveryGuard({
  setup: `
    create role public_acl_drift_owner nologin;
    grant create on schema public to public_acl_drift_owner;
    alter table public.patients owner to public_acl_drift_owner
  `,
  expected: /STAGING_PUBLIC_RELATION_OWNER_MISMATCH/,
  repair: `
    alter table public.patients owner to ${trustedMigrationOwnerSql};
    revoke all on schema public from public_acl_drift_owner;
    drop role public_acl_drift_owner
  `
});
await assertRecoveryGuard({
  setup: 'grant update on public.appointments to service_role',
  expected: /STAGING_SERVICE_ROLE_DML_ACL_INVALID/,
  repair: 'revoke update on public.appointments from service_role'
});
await assertRecoveryGuard({
  setup: 'drop policy cnyos_active_subscription_boundary on public.products',
  expected: /STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING/,
  repair: `
    create policy cnyos_active_subscription_boundary on public.products
    as restrictive for all to authenticated
    using (public.current_clinic_id() is not null)
    with check (public.current_clinic_id() is not null)
  `
});
await assertRecoveryGuard({
  setup: 'alter view public.admin_task_summary set (security_invoker=false)',
  expected: /STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING/,
  repair: 'alter view public.admin_task_summary set (security_invoker=true)'
});
await assertRecoveryGuard({
  setup: 'alter table public.products disable row level security',
  expected: /STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS/,
  repair: 'alter table public.products enable row level security'
});
await assertRecoveryGuard({
  setup: 'alter table public.clinics disable trigger trg_clinics_owner_subscription_forward_only',
  expected: /STAGING_OWNER_SUBSCRIPTION_FORWARD_TRIGGER_INVALID/,
  repair: 'alter table public.clinics enable trigger trg_clinics_owner_subscription_forward_only'
});
await assertRecoveryGuard({
  setup: 'grant update on public.clinics to service_role',
  expected: /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/,
  repair: 'revoke update on public.clinics from service_role'
});
await assertRecoveryGuard({
  setup: 'grant update(subscription_state) on public.clinics to authenticated',
  expected: /STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT/,
  repair: 'revoke update(subscription_state) on public.clinics from authenticated'
});
await assertRecoveryGuard({
  setup: 'revoke all on function public.begin_backup_export_run(uuid,timestamptz,text) from service_role',
  expected: /STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING/,
  repair: 'grant execute on function public.begin_backup_export_run(uuid,timestamptz,text) to service_role'
});
await assertRecoveryGuard({
  setup: 'grant execute on function public.get_exact_backup_restore_source(text,timestamptz,text) to authenticated',
  expected: /STAGING_SERVICE_RPC_ACL_INVALID/,
  repair: 'revoke all on function public.get_exact_backup_restore_source(text,timestamptz,text) from authenticated'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.begin_backup_export_run(
      p_clinic_id uuid,
      p_scheduled_for timestamptz,
      p_request_id text
    ) returns table(run_id uuid, acquired boolean)
    language sql volatile security definer
    set search_path=pg_catalog,public
    as $$ select null::uuid,false $$
  `,
  expected: /STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: beginBackupWithoutTerminalGuardDefinition,
  expected: /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: beginBackupReplayAndCorruptionDefinition,
  expected: /STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID/,
  repair: beginBackupFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.set_clinic_drive_assignment(
      p_request_id uuid,
      p_clinic_id uuid,
      p_expected_clinic_code text,
      p_environment text,
      p_patients_folder_id text,
      p_products_folder_id text,
      p_pharmacy_folder_id text,
      p_transactions_folder_id text,
      p_manifests_folder_id text,
      p_expected_version bigint,
      p_reason text,
      p_actor_user_id uuid,
      p_actor_email text
    ) returns jsonb
    language sql volatile security definer
    set search_path=pg_catalog,public
    as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID/,
  repair: ownerDriveAssignmentMigration
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.get_exact_backup_restore_source(
      p_clinic_code text,
      p_scheduled_for timestamptz,
      p_environment text
    ) returns jsonb
    language sql stable security definer
    set search_path=pg_catalog,public
    as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID/,
  repair: exactRestoreSourceFunctionDefinition
});
await assertRecoveryGuard({
  setup: `
    create function public.set_clinic_subscription_state(
      uuid,uuid,text,boolean,text,uuid,text
    ) returns jsonb language sql as $$ select '{}'::jsonb $$
  `,
  expected: /STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT/,
  repair: 'drop function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_drive_destination_events disable trigger trg_clinic_drive_destination_events_append_only',
  expected: /STAGING_APPEND_ONLY_TRIGGER_INVALID/,
  repair: 'alter table public.clinic_drive_destination_events enable trigger trg_clinic_drive_destination_events_append_only'
});
await assertRecoveryGuard({
  setup: `
    create function public.corrupted_append_only_trigger()
    returns trigger language plpgsql as $$ begin return old; end $$;
    drop trigger trg_clinic_drive_destination_events_append_only
      on public.clinic_drive_destination_events;
    create trigger trg_clinic_drive_destination_events_append_only
    before update or delete on public.clinic_drive_destination_events
    for each row execute function public.corrupted_append_only_trigger()
  `,
  expected: /STAGING_APPEND_ONLY_TRIGGER_INVALID/,
  repair: `
    drop trigger trg_clinic_drive_destination_events_append_only
      on public.clinic_drive_destination_events;
    drop function public.corrupted_append_only_trigger();
    create trigger trg_clinic_drive_destination_events_append_only
    before update or delete on public.clinic_drive_destination_events
    for each row execute function public.reject_append_only_mutation()
  `
});
await assertRecoveryGuard({
  setup: 'alter table public.clinic_subscription_control_events disable trigger trg_clinic_subscription_control_events_append_only',
  expected: /STAGING_APPEND_ONLY_TRIGGER_INVALID/,
  repair: 'alter table public.clinic_subscription_control_events enable trigger trg_clinic_subscription_control_events_append_only'
});
await assertRecoveryGuard({
  setup: `
    create or replace function public.reject_append_only_mutation()
    returns trigger language plpgsql volatile security definer
    set search_path=pg_catalog
    as $$ begin return old; end $$
  `,
  expected: /STAGING_APPEND_ONLY_FUNCTION_INVALID/,
  repair: appendOnlyFunctionDefinition
});

const archivedBackupDirectCalls = [
  `select public.export_clinic_backup_domain_v20260831('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.export_clinic_backup_domain_v20260829('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.export_clinic_backup_domain_v20260828('${config.tenant.expectedClinicId}'::uuid,'patients')`,
  `select public.verify_clinic_restore_trace_v20260831('${config.tenant.expectedClinicId}'::uuid)`,
  `select public.verify_clinic_restore_trace_v20260829('${config.tenant.expectedClinicId}'::uuid)`,
  `select public.verify_clinic_restore_trace_v20260828('${config.tenant.expectedClinicId}'::uuid)`
];
const archivedLineDirectCalls = [
  'select public.line_oa_queue_notification_v20260829(null::uuid,null::text,null::timestamptz,null::timestamptz,null::text)',
  'select * from public.line_oa_set_preference_v20260829(null::text,null::uuid,null::uuid,null::text,null::text,null::text,null::boolean)',
  'select * from public.line_oa_complete_link_consent_v20260829(null::text,null::text,null::text,null::boolean,null::uuid,null::text,null::text,null::text)',
  'select * from public.line_oa_list_preferences_v20260829(null::text,null::uuid,null::text,null::text,null::text)',
  'select * from public.line_oa_claim_webhook_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::text,null::timestamptz,null::boolean,null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::jsonb)',
  'select public.line_oa_finish_webhook_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::text,null::text,null::boolean)',
  'select * from public.line_oa_claim_batch_v20260829(null::uuid,null::text,null::text,null::text,null::text,null::integer)',
  'select public.line_oa_finish_notification_v20260829(null::uuid,null::text,null::text,null::integer,null::text,null::text)',
  'select * from public.line_oa_register_gateway_v20260829(null::text,null::text,null::text,null::text,null::text,null::timestamptz,null::boolean,null::text)'
];

await db.exec(`
  reset role;
  select set_config('request.jwt.claim.role','service_role',false);
  set role service_role;
`);
try {
  for (const statement of [...archivedBackupDirectCalls, ...archivedLineDirectCalls]) {
    await assert.rejects(
      db.query(statement),
      /permission denied for function/i,
      `service_role must not directly execute archived delegate: ${statement}`
    );
  }

  const currentExport = (await db.query(`
    select public.export_clinic_backup_domain(
      '${config.tenant.expectedClinicId}'::uuid,
      'transactions'
    ) result
  `)).rows[0].result;
  assert.equal(currentExport.schema_version, '2026-09-01.1');
  assert.ok(
    currentExport.included_tables.includes('clinic_drive_destination_events'),
    'the current exporter must traverse its owner-only archives and retain Drive evidence'
  );

  const currentRestoreTrace = (await db.query(`
    select public.verify_clinic_restore_trace(
      '${config.tenant.expectedClinicId}'::uuid
    ) result
  `)).rows[0].result;
  assert.equal(currentRestoreTrace.schema_version, '2026-09-01.1');
  assert.equal(
    currentRestoreTrace.counts.clinic_drive_destination_events,
    0,
    'the current restore verifier must traverse its owner-only archive chain'
  );

  const currentLineWrapper = await db.query(`
    select * from public.list_line_oa_notification_preferences_for_subject(
      '${'a'.repeat(64)}',
      '${config.tenant.expectedClinicId}'::uuid,
      'staging',
      '${config.deploymentId}',
      '${'b'.repeat(64)}'
    )
  `);
  assert.equal(
    currentLineWrapper.rows.length,
    0,
    'the current LINE wrapper must remain able to execute its owner-only delegate'
  );

  assert.equal(
    (await db.query(`
      select public.finalize_line_oa_webhook_event(
        '${'c'.repeat(64)}','${'d'.repeat(64)}','ignored','not_applicable',null
      ) finalized
    `)).rows[0].finalized,
    false,
    'the service-only current LINE finalizer must remain callable'
  );
  assert.equal(
    (await db.query('select * from public.line_oa_webhook_evidence(null)')).rows.length,
    1,
    'the service-only LINE evidence RPC must return one aggregate row'
  );

  await db.exec(`select set_config('request.jwt.claim.role','',false)`);
  await assert.rejects(
    db.query(`
      select public.finalize_line_oa_webhook_event(
        '${'c'.repeat(64)}','${'d'.repeat(64)}','ignored','not_applicable',null
      )
    `),
    /SERVICE_ROLE_REQUIRED/,
    'the current LINE gateway body gate must reject a no-claim service-role session'
  );
} finally {
  await db.exec('reset role;');
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
}

await assertRecoveryGuard({
  setup: `
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values (
      '202608311800',
      'owner_subscription_control',
      array['-- recovered from supabase/migrations/202608311800_owner_subscription_control.sql; sha256 = d08745109128a0da763fd2c177933b7df21026fdb027b900bc62fec932076d39']::text[]
    )
  `,
  expected: /MIGRATION_LEDGER_SHA256_CONFLICT/,
  repair: `delete from supabase_migrations.schema_migrations where version='202608311800'`
});
await assertRecoveryGuard({
  setup: `
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values (
      '202608311800',
      'owner_subscription_control',
      array['  -- recovered from supabase/migrations/202608311800_owner_subscription_control.sql; sha256=d08745109128a0da763fd2c177933b7df21026fdb027b900bc62fec932076d39']::text[]
    )
  `,
  expected: /MIGRATION_LEDGER_SHA256_CONFLICT/,
  repair: `delete from supabase_migrations.schema_migrations where version='202608311800'`
});

await db.exec(`
  insert into supabase_migrations.schema_migrations(version,name,statements)
  values (
    '202608311800',
    'owner_subscription_control',
    array['select ''pre-existing raw Supabase ledger statement''::text']::text[]
  )
`);
await db.exec('set search_path=pg_catalog');
await db.exec(recoverySql);
await db.exec(recoverySql);
const ledger = await db.query(`
  select version,name,statements
  from supabase_migrations.schema_migrations
  order by version
`);
assert.equal(ledger.rows.length, entries.length);
assert.deepEqual(ledger.rows.map(row => row.version), entries.map(entry => entry.version));
assert.deepEqual(ledger.rows.map(row => row.name), entries.map(entry => entry.name));
for (const [index, row] of ledger.rows.entries()) {
  const entry = entries[index];
  const canonicalEvidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
  assert.ok(Array.isArray(row.statements));
  assert.equal(
    row.statements.filter(statement => /^\s*-- recovered from supabase\/migrations\/[^;]+;\s*sha256\s*=/i.test(statement)).length,
    1,
    `${entry.file} must have exactly one canonical SHA evidence statement`
  );
  assert.equal(
    row.statements.filter(statement => statement === canonicalEvidence).length,
    1,
    `${entry.file} must carry the exact repository SHA evidence`
  );
}
assert.ok(
  ledger.rows.find(row => row.version === '202608311800').statements
    .includes("select 'pre-existing raw Supabase ledger statement'::text"),
  'ledger recovery must preserve pre-existing raw statements while appending canonical SHA evidence'
);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const offRequestId = '44444444-4444-4444-a444-444444444444';
const onRequestId = '55555555-5555-4555-a555-555555555555';
const offSql = `
  select public.set_clinic_subscription_state(
    '${offRequestId}'::uuid,
    '${config.tenant.expectedClinicId}'::uuid,
    '${config.tenant.expectedClinicCode}',
    false,
    1,
    'Reviewed synthetic staging suspension',
    '${ADMIN_ID}'::uuid,
    'staging-admin@example.test'
  ) result
`;
await db.query(offSql);
await db.query(offSql);
assert.deepEqual(
  (await db.query(`select active,subscription_state,subscription_version from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows,
  [{ active: true, subscription_state: 'suspended', subscription_version: 2 }]
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_subscription_control_events where request_id='${offRequestId}'`)).rows[0].count,
  1,
  'retrying the same Owner request must be idempotent'
);
assert.equal(
  (await db.query(`select expected_version from public.clinic_subscription_control_events where request_id='${offRequestId}'`)).rows[0].expected_version,
  1,
  'the OFF evidence must bind the authoritative version observed by the Owner'
);

await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED/);
await db.exec('rollback;');
assert.equal(
  (await db.query(`select subscription_state from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].subscription_state,
  'suspended',
  'tenant bootstrap must never reactivate a suspended subscription'
);

await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','${ADMIN_ID}',false);
`);
assert.equal((await db.query('select public.current_clinic_id() clinic_id')).rows[0].clinic_id, null);
assert.equal(
  (await db.query(`select public.is_clinic_member('${config.tenant.expectedClinicId}'::uuid) allowed`)).rows[0].allowed,
  false,
  'an already-issued staff identity must lose database tenant access while OFF'
);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`
  select public.set_clinic_subscription_state(
    '${onRequestId}'::uuid,
    '${config.tenant.expectedClinicId}'::uuid,
    '${config.tenant.expectedClinicCode}',
    true,
    2,
    'Reviewed synthetic staging reactivation',
    '${ADMIN_ID}'::uuid,
    'staging-admin@example.test'
  ) result
`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
assert.equal(
  (await db.query('select public.current_clinic_id() clinic_id')).rows[0].clinic_id,
  config.tenant.expectedClinicId,
  'ON must restore only the original active membership boundary'
);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_subscription_control_events where clinic_id='${config.tenant.expectedClinicId}'`)).rows[0].count,
  2
);
assert.deepEqual(
  (await db.query(`
    select request_id,expected_version
    from public.clinic_subscription_control_events
    where request_id in ('${offRequestId}'::uuid,'${onRequestId}'::uuid)
    order by expected_version
  `)).rows,
  [
    { request_id: offRequestId, expected_version: 1 },
    { request_id: onRequestId, expected_version: 2 }
  ]
);

await db.close();
console.log(`Migration ledger contract passed: ${entries.length} exact migrations, staging guards, schema fingerprint and non-null SHA-256 evidence`);
