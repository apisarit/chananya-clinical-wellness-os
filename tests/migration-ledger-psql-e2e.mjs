import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST,
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST,
  MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION,
  MIGRATION_LEDGER_ACL_PHASE_STRICT,
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST,
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';
import {
  buildMigrationLedgerVerificationSql,
  preReconciliationVerificationStatus
} from '../scripts/generate-migration-ledger-verification-sql.mjs';
import { buildTenantBootstrapSql } from '../scripts/generate-tenant-bootstrap-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactArgument = process.argv[2];
if (!artifactArgument) {
  throw new Error('Pass the generated pre-reconciliation repair artifact path');
}

const artifactPath = path.resolve(root, artifactArgument);
const databaseHost = 'db.hsmnjwxurlmsizndjlun.supabase.co';
const databasePort = '5432';
const databaseUser = 'postgres';
const databasePassword = 'postgres';
const databaseName = 'postgres';
const baselineDatabase = 'cnyos_psql_e2e_baseline';
const clientImage = 'postgres:17';
const preReconciliationRepairSuccessStatus =
  'CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING';
const successStatus = 'CNYOS_STAGING_MIGRATION_LEDGER_RECONCILED';
const repairSuccessStatuses = [successStatus, preReconciliationRepairSuccessStatus];
const adminId = '33333333-3333-4333-a333-333333333333';
const staleNonce = '99999999-9999-4999-a999-999999999999';
const staleXid = '999999999';
const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-psql-e2e-'));

function runDockerClient(command, args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', [
    'run', '--rm', '--pull', 'never', '--network', 'host',
    '--add-host', `${databaseHost}:127.0.0.1`,
    '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${tempDirectory},dst=/e2e,readonly`,
    '-w', '/workspace',
    '-e', `PGPASSWORD=${databasePassword}`,
    clientImage, command, ...args
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const completed = {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}\n${result.stderr || ''}`
  };
  if (!allowFailure && completed.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${completed.status}:\n${completed.output}`
    );
  }
  return completed;
}

function psql(args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-h', databaseHost, '-p', databasePort, '-U', databaseUser,
    '-d', databaseName, '-A', '-t', ...args
  ], options);
}

function adminPsql(args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-h', databaseHost, '-p', databasePort, '-U', databaseUser,
    '-d', 'template1', '-A', '-t', ...args
  ], options);
}

async function writeRuntimeFile(name, source) {
  const hostPath = path.join(tempDirectory, name);
  await fs.writeFile(hostPath, source, 'utf8');
  return `/e2e/${name}`;
}

function replaceExact(source, needle, replacement, expectedCount, label) {
  const count = source.split(needle).length - 1;
  assert.equal(count, expectedCount, `${label} replacement count changed`);
  return source.split(needle).join(replacement);
}

const repairAuthorizationBlockerStatement =
  "  raise exception 'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED: complete live callable ACL and function-creator default ACL inventory review is required before any ledger repair';\n";

function unblockRepairForDisposableTest(artifact, label) {
  return replaceExact(
    artifact,
    repairAuthorizationBlockerStatement,
    '',
    2,
    `${label} exact live-inventory blockers`
  );
}

function jsonRows(output) {
  return output.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function assertNoRepairSuccess(result, label) {
  for (const status of repairSuccessStatuses) {
    assert.doesNotMatch(result.output, new RegExp(status), `${label} emitted success status`);
  }
  assert.doesNotMatch(
    result.output,
    /"ledger_reconciled"\s*:\s*true/,
    `${label} emitted success-shaped JSON`
  );
  assert.equal(
    jsonRows(result).some(row =>
      repairSuccessStatuses.includes(row.status) || row.ledger_reconciled === true),
    false,
    `${label} emitted parseable success JSON`
  );
}

function assertNoVerificationSuccess(result, label) {
  assert.doesNotMatch(
    result.output,
    new RegExp(preReconciliationVerificationStatus),
    `${label} emitted verification success status`
  );
  assert.doesNotMatch(
    result.output,
    /"verification_transaction_rolled_back"\s*:\s*true/,
    `${label} emitted success-shaped verification JSON`
  );
  assert.equal(
    jsonRows(result).some(row =>
      row.status === preReconciliationVerificationStatus ||
      row.verification_transaction_rolled_back === true ||
      row.advisory_lock_released === true),
    false,
    `${label} emitted parseable verification success JSON`
  );
}

function expectFailure(result, label, expected) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expected, `${label} did not reach the expected refusal/failure`);
  assertNoRepairSuccess(result, label);
}

function expectVerificationFailure(result, label, expected) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expected, `${label} did not reach the expected verification failure`);
  assertNoVerificationSuccess(result, label);
}

function oneJsonRow(result, label) {
  const rows = jsonRows(result).filter(row => row.status === successStatus);
  assert.equal(rows.length, 1, `${label} must emit exactly one repair success object`);
  return rows[0];
}

function oneVerificationJsonRow(result, label) {
  const parsedRows = jsonRows(result);
  const rows = parsedRows.filter(row =>
    row.status === preReconciliationVerificationStatus
  );
  assert.equal(rows.length, 1, `${label} must emit exactly one verification success object`);
  assert.equal(
    (result.output.match(new RegExp(preReconciliationVerificationStatus, 'g')) ?? []).length,
    1,
    `${label} must emit the verification status exactly once`
  );
  assert.doesNotMatch(
    result.output,
    new RegExp(`NOTICE:[^\n]*${preReconciliationVerificationStatus}`),
    `${label} must not emit verification success as a NOTICE`
  );
  assert.deepEqual(
    parsedRows.at(-1),
    rows[0],
    `${label} verification evidence must be the final parseable JSON object`
  );
  return rows[0];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function transitionGrantSql() {
  const tuples = [
    ...CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.aclTuples,
    ...CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.browserRpcAclTuples
  ];
  return tuples.map(([grantee, signature]) =>
    `grant execute on function ${signature} to ${grantee};`).join('\n');
}

function strictPostRemediationFixtureSql() {
  const triggerClosure = CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerInventory
    .map(([signature]) =>
      `revoke all on function ${signature} from public,anon,authenticated,service_role;`)
    .join('\n');
  const browserClosure = CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.browserRpcAclTuples
    .map(([grantee, signature]) =>
      `revoke execute on function ${signature} from ${grantee};`)
    .join('\n');
  return [
    triggerClosure,
    'alter function public.set_updated_at() set search_path=pg_catalog,public;',
    browserClosure,
    'revoke execute on function ' +
      `${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.procedureSignature} ` +
      'from public;',
    ''
  ].join('\n');
}

function hostileSearchPathFixtureSql(schemaName) {
  assert.match(schemaName, /^[a-z][a-z0-9_]+$/);
  return `
create schema ${schemaName};
create table ${schemaName}.pg_class(oid oid);
create function ${schemaName}.current_database()
returns name language sql immutable set search_path=pg_catalog
as $hostile$ select 'hostile_database'::name $hostile$;
create function ${schemaName}.current_setting(text)
returns text language sql immutable set search_path=pg_catalog
as $hostile$ select 'hostile_setting'::text $hostile$;
create function ${schemaName}.current_setting(text,boolean)
returns text language sql immutable set search_path=pg_catalog
as $hostile$ select 'hostile_setting'::text $hostile$;
`;
}

function receiptTableFixtureSql(committedAtDefault = 'pg_catalog.clock_timestamp()') {
  return `
create table supabase_migrations.cnyos_migration_ledger_repair_receipts (
  run_nonce uuid not null primary key,
  gate_token text not null,
  repair_xid text not null,
  evidence jsonb not null,
  committed_at timestamptz not null default ${committedAtDefault},
  unique (gate_token,repair_xid),
  constraint cnyos_repair_receipt_gate_token_check
    check (gate_token ~ '^[0-9a-f]{64}$'),
  constraint cnyos_repair_receipt_xid_check
    check (repair_xid ~ '^[0-9]+$'),
  constraint cnyos_repair_receipt_evidence_check check ((
    pg_catalog.jsonb_typeof(evidence)='object'
    and evidence->>'repair_gate_token'=gate_token
    and evidence->>'repair_run_nonce'=run_nonce::text
    and evidence->>'repair_transaction_xid'=repair_xid
  ) is true)
);
comment on table supabase_migrations.cnyos_migration_ledger_repair_receipts is
  'Committed CNYOS migration-ledger repair receipts. UUID and top-level XID replay guard; not migration provenance.';
revoke all on table supabase_migrations.cnyos_migration_ledger_repair_receipts
  from public,anon,authenticated,service_role;
`;
}

function advisoryLockProbeSql(phase) {
  return `
select jsonb_build_object(
  'test_advisory_lock_phase',${sqlString(phase)},
  'own_granted_advisory_locks',count(*)
)
from pg_catalog.pg_locks
where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted
  and classid::bigint=(202608302100::bigint >> 32)
  and objid::bigint=(202608302100::bigint & 4294967295::bigint)
  and objsubid=1;
`;
}

function sessionAdvisoryLockCount() {
  const result = psql(['-v', 'ON_ERROR_STOP=1', '-c', `
    select count(*)
    from pg_catalog.pg_locks
    where locktype='advisory' and granted
      and classid::bigint=(202608302100::bigint >> 32)
      and objid::bigint=(202608302100::bigint & 4294967295::bigint)
      and objsubid=1
  `]);
  return Number(result.stdout.trim());
}

function psqlStateLeakProbeSql() {
  const variables = [
    'cnyos_repair_probe_xid',
    'cnyos_repair_existing_transaction',
    'cnyos_repair_session_nonce',
    'cnyos_repair_committed_nonce',
    'cnyos_repair_committed_xid',
    'cnyos_repair_connection_ok',
    'cnyos_repair_server_identity_ok',
    'cnyos_repair_lock_unheld',
    'cnyos_repair_lock_acquired',
    'cnyos_repair_lock_released',
    'cnyos_repair_lock_fully_released',
    'cnyos_repair_evidence',
    'cnyos_repair_run_nonce'
  ];
  return [
    '\\set cnyos_test_repair_state_leaked false',
    ...variables.flatMap(variable => [
      `\\if :{?${variable}}`,
      '\\set cnyos_test_repair_state_leaked true',
      '\\endif'
    ]),
    "select jsonb_build_object('test_psql_repair_state_leaked'," +
      ":'cnyos_test_repair_state_leaked'::boolean," +
      "'test_temp_marker_leaked'," +
      "to_regclass('pg_temp.cnyos_migration_ledger_repair_evidence') is not null," +
      "'test_session_search_path',current_setting('search_path'));",
    '\\unset cnyos_test_repair_state_leaked',
    ''
  ].join('\n');
}

function verificationPsqlStateLeakProbeSql() {
  const variables = [
    'cnyos_verification_probe_xid',
    'cnyos_verification_existing_transaction',
    'cnyos_verification_server_identity_ok',
    'cnyos_verification_lock_unheld',
    'cnyos_verification_lock_acquired',
    'cnyos_verification_lock_released',
    'cnyos_verification_lock_fully_released',
    'cnyos_verification_evidence'
  ];
  return [
    '\\set cnyos_test_verification_state_leaked false',
    ...variables.flatMap(variable => [
      `\\if :{?${variable}}`,
      '\\set cnyos_test_verification_state_leaked true',
      '\\endif'
    ]),
    "select jsonb_build_object('test_psql_verification_state_leaked'," +
      ":'cnyos_test_verification_state_leaked'::boolean," +
      "'test_session_search_path',current_setting('search_path'));",
    '\\unset cnyos_test_verification_state_leaked',
    ''
  ].join('\n');
}

async function resetDatabase() {
  adminPsql(['-v', 'ON_ERROR_STOP=1', '-c', `drop database ${databaseName} with (force)`]);
  adminPsql([
    '-v', 'ON_ERROR_STOP=1', '-c',
    `create database ${databaseName} with template ${baselineDatabase} owner ${databaseUser}`
  ]);
}

function ledgerSnapshot() {
  const result = psql(['-v', 'ON_ERROR_STOP=1', '-c', `
    select jsonb_build_object(
      'rows',coalesce((
        select jsonb_agg(to_jsonb(ledger) order by version)
        from supabase_migrations.schema_migrations ledger
      ),'[]'::jsonb),
      'schema_acl',(select nspacl::text from pg_namespace where nspname='supabase_migrations'),
      'owner',owner_role.rolname,
      'relation_acl',ledger_relation.relacl::text,
      'comment',obj_description(ledger_relation.oid,'pg_class'),
      'relation_kind',ledger_relation.relkind::text,
      'persistence',ledger_relation.relpersistence::text,
      'is_partition',ledger_relation.relispartition,
      'row_security',ledger_relation.relrowsecurity,
      'force_row_security',ledger_relation.relforcerowsecurity,
      'replica_identity',ledger_relation.relreplident::text,
      'has_triggers_flag',ledger_relation.relhastriggers,
      'has_rules_flag',ledger_relation.relhasrules,
      'trigger_count',(select count(*) from pg_trigger where tgrelid=ledger_relation.oid),
      'rule_count',(select count(*) from pg_rewrite where ev_class=ledger_relation.oid),
      'policy_count',(select count(*) from pg_policy where polrelid=ledger_relation.oid),
      'inheritance_count',(select count(*) from pg_inherits
        where inhrelid=ledger_relation.oid or inhparent=ledger_relation.oid),
      'physical_column_count',(select count(*) from pg_attribute
        where attrelid=ledger_relation.oid and attnum > 0),
      'default_count',(select count(*) from pg_attrdef where adrelid=ledger_relation.oid),
      'columns',(select jsonb_agg(jsonb_build_object(
          'number',attribute.attnum,
          'name',attribute.attname,
          'type',format_type(attribute.atttypid,attribute.atttypmod),
          'type_modifier',attribute.atttypmod,
          'dimensions',attribute.attndims,
          'not_null',attribute.attnotnull,
          'dropped',attribute.attisdropped,
          'local',attribute.attislocal,
          'inheritance_count',attribute.attinhcount,
          'identity',attribute.attidentity::text,
          'generated',attribute.attgenerated::text,
          'has_missing',attribute.atthasmissing,
          'column_acl',attribute.attacl::text,
          'collation_matches_type',attribute.attcollation=type_definition.typcollation,
          'has_default',attribute.atthasdef,
          'default_expression',pg_get_expr(column_default.adbin,column_default.adrelid,true)
        ) order by attribute.attnum)
        from pg_attribute attribute
        join pg_type type_definition on type_definition.oid=attribute.atttypid
        left join pg_attrdef column_default
          on column_default.adrelid=attribute.attrelid
         and column_default.adnum=attribute.attnum
        where attribute.attrelid=ledger_relation.oid and attribute.attnum > 0)
    )
    from pg_class ledger_relation
    join pg_roles owner_role on owner_role.oid=ledger_relation.relowner
    where ledger_relation.oid='supabase_migrations.schema_migrations'::regclass
  `]);
  const rows = jsonRows(result);
  assert.equal(rows.length, 1, 'durable ledger snapshot must be one JSON value');
  return rows[0];
}

function receiptSnapshot() {
  const catalogResult = psql(['-v', 'ON_ERROR_STOP=1', '-c', `
    select jsonb_build_object(
      'exists',to_regclass('supabase_migrations.cnyos_migration_ledger_repair_receipts') is not null,
      'owner',owner_role.rolname,
      'acl',receipt_relation.relacl::text,
      'comment',obj_description(receipt_relation.oid,'pg_class'),
      'relation_kind',receipt_relation.relkind::text,
      'persistence',receipt_relation.relpersistence::text,
      'is_partition',receipt_relation.relispartition,
      'row_security',receipt_relation.relrowsecurity,
      'force_row_security',receipt_relation.relforcerowsecurity,
      'replica_identity',receipt_relation.relreplident::text,
      'has_triggers_flag',receipt_relation.relhastriggers,
      'has_rules_flag',receipt_relation.relhasrules,
      'trigger_count',(select count(*) from pg_trigger where tgrelid=receipt_relation.oid),
      'rule_count',(select count(*) from pg_rewrite where ev_class=receipt_relation.oid),
      'policy_count',(select count(*) from pg_policy where polrelid=receipt_relation.oid),
      'inheritance_count',(select count(*) from pg_inherits
        where inhrelid=receipt_relation.oid or inhparent=receipt_relation.oid),
      'physical_column_count',(select count(*) from pg_attribute
        where attrelid=receipt_relation.oid and attnum > 0),
      'live_column_count',(select count(*) from pg_attribute
        where attrelid=receipt_relation.oid and attnum > 0 and not attisdropped),
      'default_count',(select count(*) from pg_attrdef where adrelid=receipt_relation.oid),
      'columns',(select jsonb_agg(jsonb_build_object(
          'number',attribute.attnum,
          'name',attribute.attname,
          'type',format_type(attribute.atttypid,attribute.atttypmod),
          'type_modifier',attribute.atttypmod,
          'dimensions',attribute.attndims,
          'not_null',attribute.attnotnull,
          'dropped',attribute.attisdropped,
          'local',attribute.attislocal,
          'inheritance_count',attribute.attinhcount,
          'identity',attribute.attidentity::text,
          'generated',attribute.attgenerated::text,
          'has_missing',attribute.atthasmissing,
          'column_acl',attribute.attacl::text,
          'collation_matches_type',attribute.attcollation=type_definition.typcollation,
          'has_default',attribute.atthasdef,
          'default_expression',pg_get_expr(column_default.adbin,column_default.adrelid,true)
        ) order by attribute.attnum)
        from pg_attribute attribute
        join pg_type type_definition on type_definition.oid=attribute.atttypid
        left join pg_attrdef column_default
          on column_default.adrelid=attribute.attrelid
         and column_default.adnum=attribute.attnum
        where attribute.attrelid=receipt_relation.oid
          and attribute.attnum > 0),
      'constraints',(select jsonb_agg(jsonb_build_object(
          'name',constraint_definition.conname,
          'type',constraint_definition.contype::text,
          'deferrable',constraint_definition.condeferrable,
          'deferred',constraint_definition.condeferred,
          'validated',constraint_definition.convalidated,
          'local',constraint_definition.conislocal,
          'inheritance_count',constraint_definition.coninhcount,
          'no_inherit',constraint_definition.connoinherit,
          'definition',pg_get_constraintdef(constraint_definition.oid,true)
        ) order by constraint_definition.conname collate "C",
          constraint_definition.contype::text,
          pg_get_constraintdef(constraint_definition.oid,true))
        from pg_constraint constraint_definition
        where constraint_definition.conrelid=receipt_relation.oid),
      'indexes',(select jsonb_agg(jsonb_build_object(
          'name',index_relation.relname,
          'method',index_method.amname,
          'unique',index_definition.indisunique,
          'primary',index_definition.indisprimary,
          'valid',index_definition.indisvalid,
          'ready',index_definition.indisready,
          'live',index_definition.indislive,
          'immediate',index_definition.indimmediate,
          'nulls_not_distinct',index_definition.indnullsnotdistinct,
          'key_attribute_count',index_definition.indnkeyatts,
          'attribute_count',index_definition.indnatts,
          'has_expressions',index_definition.indexprs is not null,
          'has_predicate',index_definition.indpred is not null
        ) order by index_relation.relname collate "C")
        from pg_index index_definition
        join pg_class index_relation on index_relation.oid=index_definition.indexrelid
        join pg_am index_method on index_method.oid=index_relation.relam
        where index_definition.indrelid=receipt_relation.oid),
      'non_owner_acl',(select coalesce(jsonb_agg(jsonb_build_array(
          coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type,acl.is_grantable
        ) order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type),'[]'::jsonb)
        from aclexplode(coalesce(
          receipt_relation.relacl,
          acldefault('r',receipt_relation.relowner)
        )) acl
        left join pg_roles grantee on grantee.oid=acl.grantee
        where acl.grantee <> receipt_relation.relowner)
    )
    from pg_class receipt_relation
    join pg_roles owner_role on owner_role.oid=receipt_relation.relowner
    where receipt_relation.oid=
      to_regclass('supabase_migrations.cnyos_migration_ledger_repair_receipts')
  `]);
  const catalogRows = jsonRows(catalogResult);
  if (catalogRows.length === 0) return { exists: false };
  assert.equal(catalogRows.length, 1, 'receipt catalog snapshot must be one JSON value');
  const dataResult = psql(['-v', 'ON_ERROR_STOP=1', '-c', `
    select coalesce(jsonb_agg(to_jsonb(receipt) order by run_nonce),'[]'::jsonb)
    from supabase_migrations.cnyos_migration_ledger_repair_receipts receipt
  `]);
  const dataRows = dataResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
  assert.equal(dataRows.length, 1, 'receipt data snapshot must be one JSON value');
  return { ...catalogRows[0], rows: dataRows[0] };
}

function durableSnapshot() {
  return { ledger: ledgerSnapshot(), receipts: receiptSnapshot() };
}

function assertDurableUnchanged(label, before) {
  assert.deepEqual(durableSnapshot(), before, `${label} changed durable repair state`);
}

function assertSuccessfulEvidence(evidence, systemIdentifier, label) {
  assert.match(evidence.repair_run_nonce, /^[0-9a-f-]{36}$/i, `${label} nonce missing`);
  assert.match(String(evidence.repair_transaction_xid), /^\d+$/, `${label} repair XID missing`);
  assert.match(evidence.repair_gate_token, /^[0-9a-f]{64}$/, `${label} gate token missing`);
  assert.equal(evidence.ledger_reconciled, true);
  assert.equal(evidence.status, successStatus);
  assert.equal(evidence.acl_phase, MIGRATION_LEDGER_ACL_PHASE_STRICT);
  assert.equal(evidence.acl_remediation_pending, false);
  assert.equal(evidence.browser_rpc_acl_remediation_pending, false);
  assert.equal(evidence.trigger_function_acl_remediation_pending, false);
  assert.equal(
    evidence.repository_derived_treatment_session_public_execute_debt_pending,
    false
  );
  assert.equal(evidence.production_eligible, false);
  assert.equal(evidence.migration_count, 45);
  assert.equal(evidence.source_revision, sourceRevision);
  assert.equal(evidence.expected_deployment_id, config.deploymentId);
  assert.equal(evidence.expected_clinic_code, config.tenant.expectedClinicCode);
  assert.equal(evidence.expected_clinic_id, config.tenant.expectedClinicId);
  assert.equal(evidence.expected_project_ref, 'hsmnjwxurlmsizndjlun');
  assert.equal(evidence.expected_system_identifier, systemIdentifier);
  assert.equal(evidence.observed_system_identifier, systemIdentifier);
  assert.equal(evidence.expected_database_host, databaseHost);
  assert.equal(evidence.observed_psql_host, databaseHost);
  assert.equal(evidence.observed_psql_port, databasePort);
  assert.equal(evidence.observed_psql_user, databaseUser);
  assert.equal(evidence.observed_psql_database, databaseName);
  assert.equal(evidence.expected_current_database, databaseName);
  assert.equal(evidence.expected_session_user, databaseUser);
  assert.equal(evidence.expected_current_user, databaseUser);
  assert.equal(evidence.observed_current_database, databaseName);
  assert.equal(evidence.observed_session_user, databaseUser);
  assert.equal(evidence.observed_current_user, databaseUser);

  const durable = durableSnapshot();
  assert.equal(durable.ledger.rows.length, 45, `${label} did not durably record all migrations`);
  assert.deepEqual(
    durable.ledger.rows,
    entries.map(entry => ({
      version: entry.version,
      statements: [
        `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`
      ],
      name: entry.name
    })),
    `${label} durable post-COMMIT ledger does not exactly match the reviewed manifest`
  );
  assert.match(durable.ledger.comment, /Canonical Supabase CLI migration history/);
  assert.equal(durable.ledger.owner, databaseUser);
  assert.equal(durable.ledger.relation_kind, 'r');
  assert.equal(durable.ledger.persistence, 'p');
  assert.equal(durable.ledger.is_partition, false);
  assert.equal(durable.ledger.row_security, false);
  assert.equal(durable.ledger.force_row_security, false);
  assert.equal(durable.ledger.replica_identity, 'd');
  assert.equal(durable.ledger.has_triggers_flag, false);
  assert.equal(durable.ledger.has_rules_flag, false);
  assert.equal(durable.ledger.trigger_count, 0);
  assert.equal(durable.ledger.rule_count, 0);
  assert.equal(durable.ledger.policy_count, 0);
  assert.equal(durable.ledger.inheritance_count, 0);
  assert.equal(durable.ledger.physical_column_count, 3);
  assert.equal(durable.ledger.default_count, 0);

  const receipts = durable.receipts;
  assert.equal(receipts.exists, true, `${label} durable receipt relation is missing`);
  assert.equal(receipts.owner, databaseUser);
  assert.equal(receipts.acl, `{${databaseUser}=arwdDxtm/${databaseUser}}`);
  assert.deepEqual(receipts.non_owner_acl, []);
  assert.equal(
    receipts.comment,
    'Committed CNYOS migration-ledger repair receipts. UUID and top-level XID replay guard; not migration provenance.'
  );
  assert.equal(receipts.relation_kind, 'r');
  assert.equal(receipts.persistence, 'p');
  assert.equal(receipts.is_partition, false);
  assert.equal(receipts.row_security, false);
  assert.equal(receipts.force_row_security, false);
  assert.equal(receipts.replica_identity, 'd');
  assert.equal(receipts.has_triggers_flag, false);
  assert.equal(receipts.has_rules_flag, false);
  assert.equal(receipts.trigger_count, 0);
  assert.equal(receipts.rule_count, 0);
  assert.equal(receipts.policy_count, 0);
  assert.equal(receipts.inheritance_count, 0);
  assert.equal(receipts.physical_column_count, 5);
  assert.equal(receipts.live_column_count, 5);
  assert.equal(receipts.default_count, 1);
  assert.deepEqual(
    receipts.columns,
    [
      {
        number: 1,
        name: 'run_nonce',
        type: 'uuid',
        type_modifier: -1,
        dimensions: 0,
        not_null: true,
        dropped: false,
        local: true,
        inheritance_count: 0,
        identity: '',
        generated: '',
        has_missing: false,
        column_acl: null,
        collation_matches_type: true,
        has_default: false,
        default_expression: null
      },
      {
        number: 2,
        name: 'gate_token',
        type: 'text',
        type_modifier: -1,
        dimensions: 0,
        not_null: true,
        dropped: false,
        local: true,
        inheritance_count: 0,
        identity: '',
        generated: '',
        has_missing: false,
        column_acl: null,
        collation_matches_type: true,
        has_default: false,
        default_expression: null
      },
      {
        number: 3,
        name: 'repair_xid',
        type: 'text',
        type_modifier: -1,
        dimensions: 0,
        not_null: true,
        dropped: false,
        local: true,
        inheritance_count: 0,
        identity: '',
        generated: '',
        has_missing: false,
        column_acl: null,
        collation_matches_type: true,
        has_default: false,
        default_expression: null
      },
      {
        number: 4,
        name: 'evidence',
        type: 'jsonb',
        type_modifier: -1,
        dimensions: 0,
        not_null: true,
        dropped: false,
        local: true,
        inheritance_count: 0,
        identity: '',
        generated: '',
        has_missing: false,
        column_acl: null,
        collation_matches_type: true,
        has_default: false,
        default_expression: null
      },
      {
        number: 5,
        name: 'committed_at',
        type: 'timestamp with time zone',
        type_modifier: -1,
        dimensions: 0,
        not_null: true,
        dropped: false,
        local: true,
        inheritance_count: 0,
        identity: '',
        generated: '',
        has_missing: false,
        column_acl: null,
        collation_matches_type: true,
        has_default: true,
        default_expression: 'clock_timestamp()'
      }
    ]
  );
  assert.deepEqual(
    receipts.constraints.map(constraint => [
      constraint.name,
      constraint.type,
      constraint.definition
    ]),
    [
      [
        'cnyos_migration_ledger_repair_receipt_gate_token_repair_xid_key',
        'u',
        'UNIQUE (gate_token, repair_xid)'
      ],
      [
        'cnyos_migration_ledger_repair_receipts_pkey',
        'p',
        'PRIMARY KEY (run_nonce)'
      ],
      [
        'cnyos_repair_receipt_evidence_check',
        'c',
        "CHECK ((jsonb_typeof(evidence) = 'object'::text AND " +
          "(evidence ->> 'repair_gate_token'::text) = gate_token AND " +
          "(evidence ->> 'repair_run_nonce'::text) = run_nonce::text AND " +
          "(evidence ->> 'repair_transaction_xid'::text) = repair_xid) IS TRUE)"
      ],
      [
        'cnyos_repair_receipt_gate_token_check',
        'c',
        "CHECK (gate_token ~ '^[0-9a-f]{64}$'::text)"
      ],
      [
        'cnyos_repair_receipt_xid_check',
        'c',
        "CHECK (repair_xid ~ '^[0-9]+$'::text)"
      ]
    ]
  );
  assert.ok(receipts.constraints.every(constraint =>
    !constraint.deferrable && !constraint.deferred && constraint.validated &&
    constraint.local && constraint.inheritance_count === 0));
  assert.ok(receipts.constraints
    .filter(constraint => constraint.type === 'c')
    .every(constraint => !constraint.no_inherit));
  assert.deepEqual(receipts.indexes, [
    {
      name: 'cnyos_migration_ledger_repair_receipt_gate_token_repair_xid_key',
      method: 'btree',
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      immediate: true,
      nulls_not_distinct: false,
      key_attribute_count: 2,
      attribute_count: 2,
      has_expressions: false,
      has_predicate: false
    },
    {
      name: 'cnyos_migration_ledger_repair_receipts_pkey',
      method: 'btree',
      unique: true,
      primary: true,
      valid: true,
      ready: true,
      live: true,
      immediate: true,
      nulls_not_distinct: false,
      key_attribute_count: 1,
      attribute_count: 1,
      has_expressions: false,
      has_predicate: false
    }
  ]);
  const checksByName = new Map(receipts.constraints
    .filter(constraint => constraint.type === 'c')
    .map(constraint => [constraint.name, constraint.definition]));
  assert.equal(
    checksByName.get('cnyos_repair_receipt_gate_token_check'),
    "CHECK (gate_token ~ '^[0-9a-f]{64}$'::text)"
  );
  assert.equal(
    checksByName.get('cnyos_repair_receipt_xid_check'),
    "CHECK (repair_xid ~ '^[0-9]+$'::text)"
  );
  assert.equal(
    checksByName.get('cnyos_repair_receipt_evidence_check'),
    "CHECK ((jsonb_typeof(evidence) = 'object'::text AND " +
      "(evidence ->> 'repair_gate_token'::text) = gate_token AND " +
      "(evidence ->> 'repair_run_nonce'::text) = run_nonce::text AND " +
      "(evidence ->> 'repair_transaction_xid'::text) = repair_xid) IS TRUE)"
  );
  assert.equal(receipts.rows.length, 1, `${label} must create exactly one durable receipt`);
  const receipt = receipts.rows[0];
  assert.equal(receipt.run_nonce, evidence.repair_run_nonce);
  assert.equal(receipt.gate_token, evidence.repair_gate_token);
  assert.equal(receipt.repair_xid, String(evidence.repair_transaction_xid));
  assert.deepEqual(receipt.evidence, evidence);
  assert.match(receipt.committed_at, /^\d{4}-\d{2}-\d{2}T/);
}

function assertSuccessfulVerificationEvidence(
  evidence,
  systemIdentifier,
  sourceRevision,
  label
) {
  assert.equal(evidence.status, preReconciliationVerificationStatus);
  assert.equal(evidence.source_revision, sourceRevision);
  assert.equal(evidence.expected_deployment_id, config.deploymentId);
  assert.equal(evidence.expected_clinic_code, config.tenant.expectedClinicCode);
  assert.equal(evidence.expected_clinic_id, config.tenant.expectedClinicId);
  assert.equal(evidence.expected_project_ref, 'hsmnjwxurlmsizndjlun');
  assert.equal(evidence.expected_database_origin, new URL(config.database.url).origin);
  assert.equal(evidence.expected_database_host, databaseHost);
  assert.equal(evidence.expected_current_database, databaseName);
  assert.equal(evidence.expected_session_user, databaseUser);
  assert.equal(evidence.expected_current_user, databaseUser);
  assert.equal(evidence.expected_system_identifier, systemIdentifier);
  assert.equal(evidence.observed_system_identifier, systemIdentifier);
  assert.equal(evidence.observed_current_database, databaseName);
  assert.equal(evidence.observed_session_user, databaseUser);
  assert.equal(evidence.observed_current_user, databaseUser);
  assert.equal(evidence.migration_count, entries.length);
  assert.equal(evidence.acl_phase, MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION);
  assert.equal(evidence.verification_transaction_rolled_back, true);
  assert.equal(evidence.advisory_lock_released, true);
  assert.equal(evidence.ledger_reconciled, false);
  assert.equal(evidence.production_eligible, false);
  assert.equal(evidence.rollback_required, true);
  assert.equal(
    evidence.acl_remediation_pending,
    true,
    `${label} must identify the transitional ACL phase`
  );
}

const entries = loadMigrationEntries(root);
assert.equal(entries.length, 45, 'the psql fixture must load the reviewed 45 migrations');

const loaderPath = await writeRuntimeFile('load-reviewed-schema.sql', [
  '\\set ON_ERROR_STOP 1',
  '\\i /workspace/tests/fixtures/postgres17-supabase-compat.sql',
  ...entries.map(entry => `\\i /workspace/supabase/migrations/${entry.file}`),
  ''
].join('\n'));

const clientVersion = runDockerClient('psql', ['--version']).stdout.trim();
assert.match(clientVersion, /psql \(PostgreSQL\) 17\./, 'the test must use the PostgreSQL 17 client');
assert.match(
  psql(['-c', 'show server_version']).stdout.trim(),
  /^17\./,
  'the test must use a PostgreSQL 17 server'
);

psql(['-v', 'ON_ERROR_STOP=1', '-f', loaderPath]);

const config = JSON.parse(await fs.readFile(
  path.join(root, 'config', 'tenant.cnyos-staging.json'),
  'utf8'
));
const setupPath = await writeRuntimeFile('prepare-reviewed-staging-state.sql', `
\\set ON_ERROR_STOP 1
${buildTenantBootstrapSql(config)}
insert into auth.users(id,email,raw_user_meta_data)
values (${sqlString(adminId)},'staging-admin@example.test','{"full_name":"Staging Admin"}'::jsonb);
update public.profiles
set role='viewer',system_role='super_admin'
where id=${sqlString(adminId)}::uuid;
insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary)
values (${sqlString(config.tenant.expectedClinicId)}::uuid,${sqlString(adminId)}::uuid,'owner',true);
alter function public.set_updated_at() reset search_path;
${transitionGrantSql()}
create schema supabase_migrations authorization postgres;
create table supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);
`);
psql(['-v', 'ON_ERROR_STOP=1', '-f', setupPath]);

const originalArtifact = await fs.readFile(artifactPath, 'utf8');
const originalArtifactPath = await writeRuntimeFile('exact-generated-repair.sql', originalArtifact);
const sourceRevisionMatch = originalArtifact.match(
  /^-- Source revision: ([0-9a-f]{40}); migration count: 45\.$/m
);
assert.ok(sourceRevisionMatch, 'repair artifact must expose its exact 40-character source revision');
const sourceRevision = sourceRevisionMatch[1];
const regeneratedPreReconciliationArtifact = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});
assert.equal(
  originalArtifact,
  regeneratedPreReconciliationArtifact,
  'supplied pre-reconciliation repair artifact must exactly match the current source generator'
);
const originalStrictArtifact = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
});
// The generated strict artifact remains inert. Only this disposable CI copy
// removes the two exact source blockers so rollback/receipt behavior can run
// against an ephemeral PostgreSQL cluster.
const disposableUnblockedStrictArtifact = unblockRepairForDisposableTest(
  originalStrictArtifact,
  'strict repair source artifact'
);
const originalVerifier = buildMigrationLedgerVerificationSql({
  config,
  entries,
  sourceRevision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});
const originalVerifierPath = await writeRuntimeFile(
  'exact-generated-pre-reconciliation-verifier.sql',
  originalVerifier
);
assert.match(originalVerifier, /^\\set ON_ERROR_STOP 1$/m);
assert.match(
  originalVerifier,
  /^-- Generated read-only staging schema verification \(chananya-pre-reconciliation\)\.$/m
);
assert.equal(
  (originalVerifier.match(new RegExp(preReconciliationVerificationStatus, 'g')) ?? []).length,
  1,
  'generated verifier must contain its final status exactly once'
);
assert.equal(
  (originalVerifier.match(/7666007964130682852/g) ?? []).length,
  2,
  'reviewed verifier system-identifier bindings changed'
);
assert.equal(
  (originalVerifier.match(/^\\if(?:\s|$)/gm) ?? []).length,
  (originalVerifier.match(/^\\endif(?:\s|$)/gm) ?? []).length,
  'generated verifier psql conditionals must be balanced'
);
assert.equal(
  (originalVerifier.match(/select pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\) as cnyos_verification_lock_acquired/g) ?? [])
    .length,
  1,
  'verifier must try exactly one session advisory lock without waiting'
);
assert.equal(
  (originalVerifier.match(/select pg_catalog\.pg_advisory_lock\(202608302100::bigint\);/g) ?? [])
    .length,
  0,
  'verifier must not use a blocking session advisory lock'
);
assert.equal(
  (originalVerifier.match(/select pg_catalog\.pg_advisory_unlock\(202608302100::bigint\)/g) ?? [])
    .length,
  1,
  'verifier must release exactly one session advisory lock'
);
assert.equal(
  (originalVerifier.match(/\) as cnyos_verification_lock_(?:unheld|fully_released)/g) ?? [])
    .length,
  2,
  'verifier must prove the key is unheld before acquisition and after release'
);
assert.match(
  originalVerifier,
  /\\if :cnyos_verification_lock_fully_released\nselect \([\s\S]*\) as migration_ledger_verification_evidence;/,
  'verifier evidence must be gated by the zero-own-holds proof'
);
assert.match(originalVerifier, /begin isolation level repeatable read read only;/);
assert.match(originalVerifier, /'verification_transaction_rolled_back',true/);
assert.match(originalVerifier, /'advisory_lock_released',true/);
assert.match(originalVerifier, /as migration_ledger_verification_evidence;/);
assert.equal(
  (originalVerifier.match(/as migration_ledger_verification_evidence;/g) ?? []).length,
  1,
  'verifier must expose exactly one final evidence result'
);
assert.doesNotMatch(
  originalVerifier,
  /raise notice/i,
  'verifier success must be a final result row, never a NOTICE'
);
const verifierPreflightSearchPathIndex = originalVerifier.indexOf(
  'set search_path = pg_catalog, pg_temp, public;'
);
const verifierIdentityProbeIndex = originalVerifier.indexOf(
  'select (\n  pg_catalog.current_database() = '
);
const verifierTransactionProbeIndex = originalVerifier.indexOf(
  'select pg_catalog.pg_current_xact_id()::text as cnyos_verification_probe_xid'
);
const verifierOwnLockPreconditionIndex = originalVerifier.indexOf(
  ') as cnyos_verification_lock_unheld'
);
const verifierSessionLockIndex = originalVerifier.indexOf(
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_verification_lock_acquired'
);
const verifierReadOnlyBeginIndex = originalVerifier.indexOf(
  'begin isolation level repeatable read read only;'
);
const verifierLocalSearchPathIndex = originalVerifier.indexOf(
  'set local search_path = pg_catalog, pg_temp, public;',
  verifierReadOnlyBeginIndex
);
const verifierGuardIndex = originalVerifier.indexOf('do $ledger_guard$', verifierReadOnlyBeginIndex);
assert.ok(
  verifierPreflightSearchPathIndex >= 0 &&
  verifierPreflightSearchPathIndex < verifierIdentityProbeIndex &&
  verifierIdentityProbeIndex < verifierTransactionProbeIndex &&
  verifierTransactionProbeIndex < verifierOwnLockPreconditionIndex &&
  verifierOwnLockPreconditionIndex < verifierSessionLockIndex &&
  verifierSessionLockIndex < verifierReadOnlyBeginIndex &&
  verifierReadOnlyBeginIndex < verifierLocalSearchPathIndex &&
  verifierLocalSearchPathIndex < verifierGuardIndex,
  'verifier must pin both session and transaction search paths before catalog verification'
);
assert.match(
  originalVerifier,
  /rollback;\n\\unset cnyos_verification_lock_released\nselect pg_catalog\.pg_advisory_unlock/,
  'verifier must roll back its read-only snapshot before releasing the session lock'
);
assert.match(originalArtifact, /^\\set ON_ERROR_STOP 1$/m);
assert.match(
  originalArtifact,
  /^-- Generated one-time staging migration ledger recovery \(chananya-pre-reconciliation\)\.$/m
);
assert.doesNotMatch(originalArtifact, new RegExp(successStatus));
assert.match(
  originalArtifact,
  /raise exception 'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED:/
);
assert.equal(
  (originalArtifact.match(/CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/g) ?? [])
    .length,
  2,
  'pre-reconciliation repair must retain both guard and write-body live-inventory blockers'
);
const preReconciliationGuardIndex = originalArtifact.indexOf('do $ledger_guard$');
const liveCallableInventoryBlockIndex = originalArtifact.indexOf(
  "raise exception 'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED:"
);
const unreachablePreReconciliationWriteIndex = originalArtifact.indexOf('do $ledger_repair$');
assert.ok(
  preReconciliationGuardIndex >= 0 &&
  preReconciliationGuardIndex < liveCallableInventoryBlockIndex &&
  liveCallableInventoryBlockIndex < unreachablePreReconciliationWriteIndex,
  'pre-reconciliation live callable-ACL blocker must precede the repair write body'
);
assert.doesNotMatch(
  originalArtifact.slice(0, liveCallableInventoryBlockIndex),
  /drop table if exists pg_temp\.cnyos_migration_ledger_repair_evidence|pg_advisory_xact_lock/,
  'pre-reconciliation repair must reach its blocker before temp-marker or transaction-lock setup'
);

const repairArtifact = originalStrictArtifact;
function assertSourceRepairBlockerPlacement(artifact, label) {
  const guard = artifact.indexOf('do $ledger_guard$');
  const guardBlocker = artifact.indexOf(repairAuthorizationBlockerStatement, guard);
  const markerReset = artifact.indexOf(
    "execute 'drop table if exists pg_temp.cnyos_migration_ledger_repair_evidence';",
    guard
  );
  const catalogCheck = artifact.indexOf('select string_agg(procedure_signature', guard);
  const applicationHealthcheck = artifact.indexOf(
    'from public.hybrid_patient_identity_healthcheck()',
    guard
  );
  const markerCreate = artifact.indexOf(
    'create temporary table cnyos_migration_ledger_repair_evidence',
    guard
  );
  const write = artifact.indexOf('do $ledger_repair$', guard);
  const mutationBlocker = artifact.indexOf(repairAuthorizationBlockerStatement, write);
  const firstDurableDdl = artifact.indexOf(
    "execute 'create schema if not exists supabase_migrations'",
    write
  );
  const firstDurableDml = artifact.indexOf(
    'insert into supabase_migrations.schema_migrations',
    write
  );
  assert.ok(
    guard >= 0 &&
      guard < guardBlocker &&
      guardBlocker < markerReset &&
      guardBlocker < catalogCheck &&
      guardBlocker < applicationHealthcheck &&
      guardBlocker < markerCreate &&
      guardBlocker < write &&
      write < mutationBlocker &&
      mutationBlocker < firstDurableDdl &&
      mutationBlocker < firstDurableDml,
    `${label} blockers must precede temp/durable DDL, DML, catalog/application checks, and healthchecks`
  );
}
assertSourceRepairBlockerPlacement(originalArtifact, 'pre-reconciliation source repair');
assertSourceRepairBlockerPlacement(originalStrictArtifact, 'strict source repair');
assert.match(repairArtifact, /^\\set ON_ERROR_STOP 1$/m);
assert.match(
  repairArtifact,
  /^-- Generated one-time staging migration ledger recovery \(strict-post-remediation\)\.$/m
);
assert.doesNotMatch(repairArtifact, new RegExp(preReconciliationRepairSuccessStatus));
assert.equal(
  repairArtifact.split(repairAuthorizationBlockerStatement).length - 1,
  2,
  'strict source repair must retain identical guard and mutation live-inventory blockers'
);
const strictGuardIndex = repairArtifact.indexOf('do $ledger_guard$');
const strictGuardBlockerIndex = repairArtifact.indexOf(
  repairAuthorizationBlockerStatement,
  strictGuardIndex
);
const strictWriteIndex = repairArtifact.indexOf('do $ledger_repair$', strictGuardBlockerIndex);
const strictMutationBlockerIndex = repairArtifact.indexOf(
  repairAuthorizationBlockerStatement,
  strictWriteIndex
);
assert.ok(
  strictGuardIndex >= 0 &&
    strictGuardIndex < strictGuardBlockerIndex &&
    strictGuardBlockerIndex < strictWriteIndex &&
    strictWriteIndex < strictMutationBlockerIndex,
  'strict source repair must independently block both guard and mutation statements'
);
assert.doesNotMatch(repairArtifact, /^\\quit(?:\s|$)/m, 'repair artifact must not rely on psql \\quit');
for (const refusal of [
  'CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED',
  'CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED',
  'CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED',
  'CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED',
  'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD',
  'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_BUSY',
  'CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID',
  'CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID',
  'CNYOS_LEDGER_REPAIR_RECEIPT_CONSTRAINT_INVALID',
  'CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED',
  'CNYOS_LEDGER_REPAIR_ADVISORY_UNLOCK_FAILED'
]) {
  assert.match(repairArtifact, new RegExp(`raise exception '${refusal}'`));
}
const originalClusterIds = [...repairArtifact.matchAll(/7666007964130682852/g)];
assert.equal(originalClusterIds.length, 5, 'reviewed cluster binding occurrences changed');
assert.equal(
  (repairArtifact.match(/^\\if(?:\s|$)/gm) ?? []).length,
  (repairArtifact.match(/^\\endif(?:\s|$)/gm) ?? []).length,
  'generated psql conditionals must be balanced'
);
assert.equal(
  (repairArtifact.match(/select pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\) as cnyos_repair_lock_acquired/g) ?? [])
    .length,
  1,
  'repair must try exactly one session advisory lock without waiting'
);
assert.equal(
  (repairArtifact.match(/select pg_catalog\.pg_advisory_lock\(202608302100::bigint\);/g) ?? [])
    .length,
  0,
  'repair must never use a blocking session advisory lock'
);
assert.equal(
  (repairArtifact.match(/select pg_catalog\.pg_advisory_unlock\(202608302100::bigint\)/g) ?? [])
    .length,
  2,
  'both post-COMMIT proof branches must release the session advisory lock'
);
assert.equal(
  (repairArtifact.match(/\) as cnyos_repair_lock_fully_released/g) ?? []).length,
  2,
  'both post-COMMIT branches must prove the session owns zero remaining holds'
);
assert.match(
  repairArtifact,
  /\\if :cnyos_repair_lock_fully_released\nselect :'cnyos_repair_evidence'::jsonb as migration_ledger_evidence;/,
  'success evidence must be unreachable until the advisory key is fully released'
);
const preflightSearchPathIndex = repairArtifact.indexOf(
  'set search_path = pg_catalog, pg_temp, public;'
);
const connectionIdentityProbeIndex = repairArtifact.indexOf("select (\n  :'HOST' = ");
const serverIdentityProbeIndex = repairArtifact.indexOf(
  'select (\n  pg_catalog.current_database() = '
);
const transactionProbeIndex = repairArtifact.indexOf(
  'select pg_catalog.pg_current_xact_id()::text as cnyos_repair_probe_xid'
);
const ownLockPreconditionIndex = repairArtifact.indexOf(
  ') as cnyos_repair_lock_unheld'
);
const sessionLockIndex = repairArtifact.indexOf(
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_repair_lock_acquired'
);
assert.ok(
  preflightSearchPathIndex >= 0 &&
  preflightSearchPathIndex < connectionIdentityProbeIndex &&
  connectionIdentityProbeIndex < serverIdentityProbeIndex &&
  serverIdentityProbeIndex < transactionProbeIndex &&
  transactionProbeIndex < ownLockPreconditionIndex &&
  ownLockPreconditionIndex < sessionLockIndex,
  'session search_path must be pinned before every repair preflight probe and lock'
);
assert.match(
  repairArtifact,
  /\$cnyos_psql_preflight_abort\$;\n\\endif\nset search_path = pg_catalog, pg_temp, public;\nselect \(/,
  'session search_path pin must immediately follow the AUTOCOMMIT gate'
);
assert.ok(repairArtifact.includes(
  'begin isolation level repeatable read read write;\n' +
  'set local search_path = pg_catalog, pg_temp, public;\n' +
  'do $ledger_guard$\n'
), 'write-transaction path pin must immediately precede the repair guard');
assert.match(
  repairArtifact,
  /execute 'create temporary table cnyos_migration_ledger_repair_evidence .* on commit drop';/,
  'transactional repair marker must be dropped automatically by COMMIT'
);
const repairWriteBeginIndex = repairArtifact.indexOf(
  'begin isolation level repeatable read read write;'
);
const repairWriteSearchPathIndex = repairArtifact.indexOf(
  'set local search_path = pg_catalog, pg_temp, public;',
  repairWriteBeginIndex
);
const repairGuardIndex = repairArtifact.indexOf('do $ledger_guard$', repairWriteSearchPathIndex);
const repairGuardBlockerIndex = repairArtifact.indexOf(
  repairAuthorizationBlockerStatement,
  repairGuardIndex
);
const repairTransactionLockIndex = repairArtifact.indexOf(
  'perform pg_catalog.pg_advisory_xact_lock(202608302100::bigint);',
  repairGuardBlockerIndex
);
const repairInitialMarkerDropIndex = repairArtifact.indexOf(
  "execute 'drop table if exists pg_temp.cnyos_migration_ledger_repair_evidence';",
  repairTransactionLockIndex
);
const repairCommitIndex = repairArtifact.lastIndexOf('\ncommit;\n');
const postCommitReadOnlyIndex = repairArtifact.indexOf(
  'begin isolation level repeatable read read only;',
  repairCommitIndex
);
const postCommitSearchPathIndex = repairArtifact.indexOf(
  'set local search_path = pg_catalog, pg_temp, public;',
  postCommitReadOnlyIndex
);
const postCommitStatementTimeoutIndex = repairArtifact.indexOf(
  "set local statement_timeout = '60s';",
  postCommitSearchPathIndex
);
const postCommitLockTimeoutIndex = repairArtifact.indexOf(
  "set local lock_timeout = '5s';",
  postCommitStatementTimeoutIndex
);
const postCommitLedgerLockIndex = repairArtifact.indexOf(
  'lock table only supabase_migrations.schema_migrations in share mode;',
  postCommitLockTimeoutIndex
);
const postCommitReceiptLockIndex = repairArtifact.indexOf(
  'lock table only supabase_migrations.cnyos_migration_ledger_repair_receipts in share mode;',
  postCommitLedgerLockIndex
);
const postCommitProofSelectIndex = repairArtifact.indexOf(
  'select case when count(*)=1 then min(receipt.evidence::text) end as ' +
    'cnyos_repair_evidence',
  postCommitReceiptLockIndex
);
assert.ok(
  repairWriteBeginIndex >= 0 &&
  repairWriteBeginIndex < repairWriteSearchPathIndex &&
  repairWriteSearchPathIndex < repairGuardIndex &&
  repairGuardIndex < repairGuardBlockerIndex &&
  repairGuardBlockerIndex < repairTransactionLockIndex &&
  repairTransactionLockIndex < repairInitialMarkerDropIndex &&
  repairGuardIndex < repairCommitIndex &&
  repairCommitIndex < postCommitReadOnlyIndex &&
  postCommitReadOnlyIndex < postCommitSearchPathIndex &&
  postCommitSearchPathIndex < postCommitStatementTimeoutIndex &&
  postCommitStatementTimeoutIndex < postCommitLockTimeoutIndex &&
  postCommitLockTimeoutIndex < postCommitLedgerLockIndex &&
  postCommitLedgerLockIndex < postCommitReceiptLockIndex &&
  postCommitReceiptLockIndex < postCommitProofSelectIndex,
  'durable proof must lock both relations in its post-COMMIT read-only transaction before reading'
);
assert.match(
  repairArtifact.slice(repairCommitIndex, postCommitReadOnlyIndex +
    'begin isolation level repeatable read read only;'.length),
  /^\ncommit;\nbegin isolation level repeatable read read only;$/,
  'COMMIT must enter durable read-only proof without intervening DDL'
);
assert.ok(repairArtifact.includes(
  'commit;\n' +
  'begin isolation level repeatable read read only;\n' +
  'set local search_path = pg_catalog, pg_temp, public;\n' +
  "set local statement_timeout = '60s';\n" +
  "set local lock_timeout = '5s';\n" +
  'lock table only supabase_migrations.schema_migrations in share mode;\n' +
  'lock table only supabase_migrations.cnyos_migration_ledger_repair_receipts in share mode;\n'
), 'post-COMMIT proof must pin path and lock both relations before its snapshot');
assert.doesNotMatch(
  repairArtifact.slice(repairCommitIndex),
  /drop table (?:if exists )?pg_temp\.cnyos_migration_ledger_repair_evidence/,
  'ON COMMIT DROP must eliminate any post-COMMIT temp-table DDL'
);
assert.equal(
  repairArtifact.indexOf('\nselect ', postCommitReadOnlyIndex),
  postCommitProofSelectIndex - 1,
  'post-COMMIT proof must take both SHARE locks before its first SELECT/snapshot'
);

const wrongClusterWrapperPath = await writeRuntimeFile('exact-wrong-cluster-wrapper.sql', `
\\i ${originalArtifactPath}
\\echo CNYOS_UNREACHABLE_WRONG_CLUSTER_TAIL
`);
const wrongCluster = psql(['-f', wrongClusterWrapperPath], { allowFailure: true });
expectFailure(wrongCluster, 'exact generated artifact on the CI cluster', /CNYOS_LEDGER_REPAIR_WRONG_CLUSTER/);
assert.doesNotMatch(wrongCluster.output, /CNYOS_UNREACHABLE_WRONG_CLUSTER_TAIL/);

const wrongConnectionWrapperPath = await writeRuntimeFile('exact-wrong-connection-wrapper.sql', `
\\i ${originalArtifactPath}
\\echo CNYOS_UNREACHABLE_WRONG_CONNECTION_TAIL
`);
const wrongConnection = psql(
  ['-h', '127.0.0.1', '-f', wrongConnectionWrapperPath],
  { allowFailure: true }
);
expectFailure(
  wrongConnection,
  'exact generated artifact on the wrong psql host identity',
  /CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED/
);
assert.doesNotMatch(wrongConnection.output, /CNYOS_UNREACHABLE_WRONG_CONNECTION_TAIL/);

const systemIdentifier = psql([
  '-v', 'ON_ERROR_STOP=1', '-c', 'select system_identifier::text from pg_control_system()'
]).stdout.trim();
assert.match(systemIdentifier, /^\d+$/);

// The checked artifact remains immutable above.  This narrowly bound copy is
// the only safe way to exercise the post-cluster-identity path on an ephemeral
// CI cluster whose initdb-generated system identifier cannot equal staging's.
const testBoundPreReconciliationArtifact = replaceExact(
  originalArtifact,
  '7666007964130682852',
  systemIdentifier,
  5,
  'ephemeral pre-reconciliation system identifier'
);
const testBoundPreReconciliationArtifactPath = await writeRuntimeFile(
  'test-bound-generated-pre-reconciliation-repair.sql',
  testBoundPreReconciliationArtifact
);
const testBoundStrictArtifact = replaceExact(
  disposableUnblockedStrictArtifact,
  '7666007964130682852',
  systemIdentifier,
  5,
  'ephemeral strict-post-remediation system identifier'
);
const testBoundStrictArtifactPath = await writeRuntimeFile(
  'test-bound-generated-strict-post-remediation-repair.sql',
  testBoundStrictArtifact
);
assert.doesNotMatch(
  testBoundStrictArtifact,
  /CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/,
  'only the explicitly disposable strict behavioral copy may remove the two source blockers'
);
const testBoundVerifier = replaceExact(
  originalVerifier,
  '7666007964130682852',
  systemIdentifier,
  2,
  'ephemeral verifier system identifier'
);
const testBoundVerifierPath = await writeRuntimeFile(
  'test-bound-generated-pre-reconciliation-verifier.sql',
  testBoundVerifier
);

adminPsql(['-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${baselineDatabase} with (force)`]);
adminPsql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  `create database ${baselineDatabase} with template ${databaseName} owner ${databaseUser}`
]);

await resetDatabase();
const exactVerifierWrongClusterBefore = durableSnapshot();
const exactVerifierWrongClusterWrapperPath = await writeRuntimeFile(
  'exact-verifier-wrong-cluster-wrapper.sql',
  `\n\\i ${originalVerifierPath}\n\\echo CNYOS_UNREACHABLE_VERIFIER_WRONG_CLUSTER_TAIL\n`
);
assert.equal(sessionAdvisoryLockCount(), 0, 'verifier wrong-cluster test must start unlocked');
const exactVerifierWrongCluster = psql(
  ['-f', exactVerifierWrongClusterWrapperPath],
  { allowFailure: true }
);
expectVerificationFailure(
  exactVerifierWrongCluster,
  'exact generated verifier on the CI cluster',
  /CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER/
);
assert.doesNotMatch(
  exactVerifierWrongCluster.output,
  /CNYOS_UNREACHABLE_VERIFIER_WRONG_CLUSTER_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'failed wrong-cluster verifier must not leak its session advisory lock'
);
assertDurableUnchanged(
  'exact generated verifier wrong-cluster refusal',
  exactVerifierWrongClusterBefore
);

await resetDatabase();
psql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  hostileSearchPathFixtureSql('cnyos_verifier_hostile_path')
]);
const exactVerifierSuccessBefore = durableSnapshot();
assert.deepEqual(
  exactVerifierSuccessBefore.ledger.rows,
  [],
  'pre-reconciliation verifier must run before durable ledger repair'
);
assert.deepEqual(
  exactVerifierSuccessBefore.receipts,
  { exists: false },
  'pre-reconciliation verifier must not require or create a repair receipt'
);
const exactVerifierSuccessWrapperPath = await writeRuntimeFile(
  'test-bound-verifier-hostile-search-path.sql',
  `\nset search_path = cnyos_verifier_hostile_path, public, pg_catalog;\n` +
    "select jsonb_build_object('test_verifier_input_search_path'," +
      "pg_catalog.current_setting('search_path'));\n" +
    `\\i ${testBoundVerifierPath}\n`
);
const exactVerifierSuccess = psql(['-f', exactVerifierSuccessWrapperPath]);
assert.deepEqual(
  jsonRows(exactVerifierSuccess).filter(
    row => Object.hasOwn(row, 'test_verifier_input_search_path')
  ),
  [{ test_verifier_input_search_path: 'cnyos_verifier_hostile_path, public, pg_catalog' }],
  'verifier success must begin from the deliberately hostile session search_path'
);
const exactVerificationEvidence = oneVerificationJsonRow(
  exactVerifierSuccess,
  'test-bound exact generated pre-reconciliation verifier'
);
assertSuccessfulVerificationEvidence(
  exactVerificationEvidence,
  systemIdentifier,
  sourceRevision,
  'test-bound exact generated pre-reconciliation verifier'
);
assertDurableUnchanged(
  'successful exact generated pre-reconciliation verifier',
  exactVerifierSuccessBefore
);

const verifierLockPreconditionNeedle =
  '\\unset cnyos_verification_lock_unheld\n' +
  '\\unset cnyos_verification_lock_acquired\n' +
  'select not exists (\n';
let lockLifecycleVerifier = replaceExact(
  testBoundVerifier,
  verifierLockPreconditionNeedle,
  advisoryLockProbeSql('verification-before') + verifierLockPreconditionNeedle,
  1,
  'verifier session advisory lock precondition probe'
);
const verifierSessionLockNeedle =
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as ' +
    'cnyos_verification_lock_acquired\n' +
  '\\gset\n' +
  '\\if :cnyos_verification_lock_acquired\n';
lockLifecycleVerifier = replaceExact(
  lockLifecycleVerifier,
  verifierSessionLockNeedle,
  verifierSessionLockNeedle + advisoryLockProbeSql('verification-held'),
  1,
  'verifier session advisory lock acquisition probes'
);
const verifierUnlockSuccessNeedle = '\\if :cnyos_verification_lock_fully_released\n';
lockLifecycleVerifier = replaceExact(
  lockLifecycleVerifier,
  verifierUnlockSuccessNeedle,
  verifierUnlockSuccessNeedle + advisoryLockProbeSql('verification-after'),
  1,
  'verifier session advisory lock release probe'
);
const lockLifecycleVerifierPath = await writeRuntimeFile(
  'test-bound-verifier-lock-lifecycle.sql',
  lockLifecycleVerifier
);
const lockLifecycleVerifierWrapperPath = await writeRuntimeFile(
  'test-bound-verifier-lock-lifecycle-wrapper.sql',
  `\nset search_path = cnyos_verifier_hostile_path, public, pg_catalog;\n` +
    `\\i ${lockLifecycleVerifierPath}\n`
);
const lockLifecycleVerification = psql(['-f', lockLifecycleVerifierWrapperPath]);
assert.deepEqual(
  jsonRows(lockLifecycleVerification)
    .filter(row => row.test_advisory_lock_phase)
    .map(row => [row.test_advisory_lock_phase, row.own_granted_advisory_locks]),
  [
    ['verification-before', 0],
    ['verification-held', 1],
    ['verification-after', 0]
  ],
  'verifier session advisory lock lifecycle must be 0 -> 1 -> 0 in one psql session'
);
const lifecycleVerificationEvidence = oneVerificationJsonRow(
  lockLifecycleVerification,
  'instrumented pre-reconciliation verifier'
);
assertSuccessfulVerificationEvidence(
  lifecycleVerificationEvidence,
  systemIdentifier,
  sourceRevision,
  'instrumented pre-reconciliation verifier'
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'successful verifier must not leave a session advisory lock behind'
);
assertDurableUnchanged(
  'instrumented pre-reconciliation verifier',
  exactVerifierSuccessBefore
);

const verifierStateLeakWrapperPath = await writeRuntimeFile(
  'test-bound-verifier-psql-state.sql',
  `\nset search_path = cnyos_verifier_hostile_path, public, pg_catalog;\n` +
    `\\i ${testBoundVerifierPath}\n` +
    verificationPsqlStateLeakProbeSql()
);
const verifierStateLeak = psql(['-f', verifierStateLeakWrapperPath]);
assert.equal(
  jsonRows(verifierStateLeak).filter(
    row => row.status === preReconciliationVerificationStatus
  ).length,
  1,
  'psql state probe run must still emit exactly one verifier evidence object'
);
assert.doesNotMatch(
  verifierStateLeak.output,
  new RegExp(`NOTICE:[^\\n]*${preReconciliationVerificationStatus}`),
  'psql state probe run must not emit verifier success as a NOTICE'
);
assert.deepEqual(
  jsonRows(verifierStateLeak).filter(
    row => Object.hasOwn(row, 'test_psql_verification_state_leaked')
  ),
  [{
    test_psql_verification_state_leaked: false,
    test_session_search_path: 'pg_catalog, pg_temp, public'
  }],
  'verifier must close its psql conditionals and clear its client state'
);
assertDurableUnchanged(
  'pre-reconciliation verifier psql state probe',
  exactVerifierSuccessBefore
);

await resetDatabase();
const wrongVerifierIdentityBefore = durableSnapshot();
const wrongVerifierIdentityWrapperPath = await writeRuntimeFile(
  'test-bound-verifier-wrong-current-user.sql',
  `\nset role authenticated;\n` +
    `\\i ${testBoundVerifierPath}\n` +
    '\\echo CNYOS_UNREACHABLE_VERIFIER_WRONG_IDENTITY_TAIL\n'
);
const wrongVerifierIdentity = psql(
  ['-f', wrongVerifierIdentityWrapperPath],
  { allowFailure: true }
);
expectVerificationFailure(
  wrongVerifierIdentity,
  'pre-reconciliation verifier under the wrong current_user',
  /CNYOS_STAGING_VERIFICATION_SERVER_IDENTITY_REFUSED/
);
assert.doesNotMatch(
  wrongVerifierIdentity.output,
  /CNYOS_UNREACHABLE_VERIFIER_WRONG_IDENTITY_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'wrong-identity verifier refusal must not leak a session advisory lock'
);
assertDurableUnchanged('verifier wrong-identity refusal', wrongVerifierIdentityBefore);

await resetDatabase();
psql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  'alter function public.set_updated_at() set search_path=public'
]);
const driftedFunctionConfig = psql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  "select coalesce(array_to_string(proconfig,','),'') " +
    "from pg_catalog.pg_proc where oid='public.set_updated_at()'::regprocedure"
]).stdout.trim();
assert.equal(driftedFunctionConfig, 'search_path=public');
const driftedVerifierBefore = durableSnapshot();
const driftedVerifierWrapperPath = await writeRuntimeFile(
  'test-bound-verifier-schema-drift.sql',
  `\n\\i ${testBoundVerifierPath}\n` +
    '\\echo CNYOS_UNREACHABLE_VERIFIER_SCHEMA_DRIFT_TAIL\n'
);
const driftedVerifier = psql(
  ['-f', driftedVerifierWrapperPath],
  { allowFailure: true }
);
expectVerificationFailure(
  driftedVerifier,
  'pre-reconciliation verifier with trigger-function schema drift',
  /STAGING_TRIGGER_FUNCTION_(?:INVENTORY_OR_STATE|SEMANTICS)_INVALID/
);
assert.doesNotMatch(
  driftedVerifier.output,
  /CNYOS_UNREACHABLE_VERIFIER_SCHEMA_DRIFT_TAIL/
);
assert.equal(
  psql([
    '-v', 'ON_ERROR_STOP=1', '-c',
    "select coalesce(array_to_string(proconfig,','),'') " +
      "from pg_catalog.pg_proc where oid='public.set_updated_at()'::regprocedure"
  ]).stdout.trim(),
  driftedFunctionConfig,
  'read-only verifier must leave the refused schema drift untouched'
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'schema-drift verifier refusal must not leak a session advisory lock'
);
assertDurableUnchanged('verifier schema-drift refusal', driftedVerifierBefore);

await resetDatabase();
const blockedPreReconciliationRepairBefore = durableSnapshot();
assert.deepEqual(blockedPreReconciliationRepairBefore.ledger.rows, []);
assert.deepEqual(blockedPreReconciliationRepairBefore.receipts, { exists: false });
const blockedPreReconciliationRepairWrapperPath = await writeRuntimeFile(
  'test-bound-pre-reconciliation-repair-blocked.sql',
  `\n\\i ${testBoundPreReconciliationArtifactPath}\n` +
    '\\echo CNYOS_UNREACHABLE_PRE_RECONCILIATION_REPAIR_TAIL\n'
);
const blockedPreReconciliationRepair = psql(
  ['-f', blockedPreReconciliationRepairWrapperPath],
  { allowFailure: true }
);
expectFailure(
  blockedPreReconciliationRepair,
  'pre-reconciliation repair without a complete live callable ACL inventory',
  /CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/
);
assert.doesNotMatch(
  blockedPreReconciliationRepair.output,
  /CNYOS_UNREACHABLE_PRE_RECONCILIATION_REPAIR_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'blocked pre-reconciliation repair must not leak its session advisory lock'
);
assertDurableUnchanged(
  'pre-reconciliation live callable-ACL inventory refusal',
  blockedPreReconciliationRepairBefore
);

// psql's ON_ERROR_ROLLBACK uses savepoints, so a caller can deliberately
// recover the guard error and continue to the write statement. Both source
// blockers must fire independently and the recovered transaction must remain
// unable to create any durable repair state or success-shaped output.
await resetDatabase();
const sourceBlockerSavepointArtifact = replaceExact(
  replaceExact(
    replaceExact(
      testBoundPreReconciliationArtifact,
      '\\set ON_ERROR_STOP 1',
      '\\set ON_ERROR_STOP 0',
      1,
      'source-blocker savepoint ON_ERROR_STOP'
    ),
    '\\set ON_ERROR_ROLLBACK off',
    '\\set ON_ERROR_ROLLBACK on',
    1,
    'source-blocker savepoint ON_ERROR_ROLLBACK'
  ),
  'end\n$ledger_repair$;\ncommit;\n',
  'end\n$ledger_repair$;\n' +
    '\\set ON_ERROR_STOP 1\n' +
    'do $cnyos_source_blocker_recovery_abort$\n' +
    'begin\n' +
    "  raise exception 'CNYOS_LEDGER_REPAIR_SOURCE_BLOCKERS_RECOVERED';\n" +
    'end\n' +
    '$cnyos_source_blocker_recovery_abort$;\n' +
    'commit;\n',
  1,
  'source-blocker post-recovery stop restoration'
);
const sourceBlockerSavepointArtifactPath = await writeRuntimeFile(
  'source-blocker-savepoint-recovery.sql',
  sourceBlockerSavepointArtifact
);
const sourceBlockerSavepointBefore = durableSnapshot();
const sourceBlockerSavepointWrapperPath = await writeRuntimeFile(
  'source-blocker-savepoint-recovery-wrapper.sql',
  `\\i ${sourceBlockerSavepointArtifactPath}\n` +
    '\\echo CNYOS_UNREACHABLE_SOURCE_BLOCKER_SAVEPOINT_TAIL\n'
);
const sourceBlockerSavepointRecovery = psql(
  ['-f', sourceBlockerSavepointWrapperPath],
  { allowFailure: true }
);
expectFailure(
  sourceBlockerSavepointRecovery,
  'psql savepoint recovery through both source repair blockers',
  /CNYOS_LEDGER_REPAIR_SOURCE_BLOCKERS_RECOVERED/
);
assert.equal(
  (sourceBlockerSavepointRecovery.output.match(
    /CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/g
  ) ?? []).length,
  2,
  'psql savepoint recovery must encounter both independent source blockers'
);
assert.doesNotMatch(
  sourceBlockerSavepointRecovery.output,
  /CNYOS_UNREACHABLE_SOURCE_BLOCKER_SAVEPOINT_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'source-blocker savepoint recovery must not leak the session advisory lock'
);
assertDurableUnchanged(
  'psql savepoint recovery through both source repair blockers',
  sourceBlockerSavepointBefore
);

// All write-path tests run only against the explicitly disposable strict copy
// whose two exact source blockers were removed above, plus a fixture
// materialized to the strict post-remediation ACL/search_path state.
await resetDatabase();
psql(['-v', 'ON_ERROR_STOP=1', '-c', strictPostRemediationFixtureSql()]);
assert.equal(
  psql([
    '-v', 'ON_ERROR_STOP=1', '-c',
    "select coalesce(array_to_string(proconfig,','),'') " +
      "from pg_catalog.pg_proc where oid='public.set_updated_at()'::regprocedure"
  ]).stdout.trim(),
  'search_path=pg_catalog, public',
  'strict fixture must pin set_updated_at() before any repair write-path test'
);
adminPsql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  `drop database ${baselineDatabase} with (force)`
]);
adminPsql([
  '-v', 'ON_ERROR_STOP=1', '-c',
  `create database ${baselineDatabase} with template ${databaseName} owner ${databaseUser}`
]);

await resetDatabase();
const preheldSessionLockBefore = durableSnapshot();
const preheldSessionLockWrapperPath = await writeRuntimeFile(
  'preheld-session-lock-wrapper.sql',
  'select pg_catalog.pg_advisory_lock(202608302100::bigint);\n' +
    `\\i ${testBoundStrictArtifactPath}\n` +
    '\\echo CNYOS_UNREACHABLE_PREHELD_SESSION_LOCK_TAIL\n'
);
const preheldSessionLock = psql(
  ['-f', preheldSessionLockWrapperPath],
  { allowFailure: true }
);
expectFailure(
  preheldSessionLock,
  'same-session pre-held repair advisory key',
  /CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD/
);
assert.doesNotMatch(
  preheldSessionLock.output,
  /CNYOS_UNREACHABLE_PREHELD_SESSION_LOCK_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'same-session pre-held refusal must not leave the key held after client exit'
);
assertDurableUnchanged('same-session pre-held repair advisory key', preheldSessionLockBefore);

await resetDatabase();
const sessionLockNeedle =
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_repair_lock_acquired\n' +
  '\\gset\n' +
  '\\if :cnyos_repair_lock_acquired\n';
const lockLifecycleArtifact = replaceExact(
  testBoundStrictArtifact,
  sessionLockNeedle,
  sessionLockNeedle + advisoryLockProbeSql('held'),
  1,
  'session advisory lock lifecycle probe'
);
const lockLifecycleArtifactPath = await writeRuntimeFile(
  'test-bound-lock-lifecycle-repair.sql',
  lockLifecycleArtifact
);
const directPath = await writeRuntimeFile('direct-repair-with-lifecycle.sql', `
${hostileSearchPathFixtureSql('cnyos_hostile_path')}
set search_path = cnyos_hostile_path, public, pg_catalog;
${advisoryLockProbeSql('before')}
\\i ${lockLifecycleArtifactPath}
${advisoryLockProbeSql('after')}
${psqlStateLeakProbeSql()}
`);
const directSuccess = psql(['-f', directPath]);
assert.deepEqual(
  jsonRows(directSuccess)
    .filter(row => row.test_advisory_lock_phase)
    .map(row => [row.test_advisory_lock_phase, row.own_granted_advisory_locks]),
  [
    ['before', 0],
    ['held', 1],
    ['after', 0]
  ],
  'repair session advisory lock lifecycle must be 0 -> 1 -> 0 in one psql session'
);
assert.deepEqual(
  jsonRows(directSuccess)
    .filter(row => Object.hasOwn(row, 'test_psql_repair_state_leaked')),
  [{
    test_psql_repair_state_leaked: false,
    test_temp_marker_leaked: false,
    test_session_search_path: 'pg_catalog, pg_temp, public'
  }],
  'repair must close its psql conditionals and clear its client/temp state'
);
const directEvidence = oneJsonRow(directSuccess, 'direct -f');
assertSuccessfulEvidence(directEvidence, systemIdentifier, 'direct -f');
const afterDirectSuccess = durableSnapshot();
const incompleteReceiptEvidence = psql([
  '-v', 'ON_ERROR_STOP=1', '-c', `
    insert into supabase_migrations.cnyos_migration_ledger_repair_receipts(
      run_nonce,gate_token,repair_xid,evidence
    ) values (
      '11111111-1111-4111-a111-111111111111'::uuid,
      '${'a'.repeat(64)}',
      '111111111',
      '{}'::jsonb
    )
  `
], { allowFailure: true });
expectFailure(
  incompleteReceiptEvidence,
  'receipt evidence with missing bound fields',
  /cnyos_repair_receipt_evidence_check/
);
assertDurableUnchanged('receipt evidence with missing bound fields', afterDirectSuccess);
const forcedNonceArtifact = replaceExact(
  testBoundStrictArtifact,
  'select pg_catalog.gen_random_uuid()::text as cnyos_repair_run_nonce',
  `select '${directEvidence.repair_run_nonce}'::text as cnyos_repair_run_nonce`,
  1,
  'forced same-nonce replay'
);
const forcedNonceArtifactPath = await writeRuntimeFile(
  'adversarial-forced-same-nonce-replay.sql',
  forcedNonceArtifact
);
const forcedNonceWrapperPath = await writeRuntimeFile('forced-same-nonce-wrapper.sql', `
\\i ${forcedNonceArtifactPath}
\\echo CNYOS_UNREACHABLE_NONCE_REPLAY_TAIL
`);
const forcedNonceReplay = psql(['-f', forcedNonceWrapperPath], { allowFailure: true });
expectFailure(
  forcedNonceReplay,
  'forced same-nonce second invocation',
  /CNYOS_LEDGER_REPAIR_NONCE_REPLAY/
);
assert.doesNotMatch(forcedNonceReplay.output, /CNYOS_UNREACHABLE_NONCE_REPLAY_TAIL/);
assertDurableUnchanged('forced same-nonce second invocation', afterDirectSuccess);

await resetDatabase();
const nestedPath = await writeRuntimeFile('nested-repair.sql', `
\\set ON_ERROR_STOP 0
\\set ON_ERROR_ROLLBACK on
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_SETTINGS_AFTER_INCLUDE::ON_ERROR_STOP::ON_ERROR_ROLLBACK
`);
const nestedSuccess = psql(['-f', nestedPath]);
assert.match(
  nestedSuccess.output,
  /CNYOS_SETTINGS_AFTER_INCLUDE:(?:on|1):(?:off|0)/,
  'nested include must retain the artifact-enforced psql error settings'
);
assertSuccessfulEvidence(oneJsonRow(nestedSuccess, 'nested \\i'), systemIdentifier, 'nested \\i');

await resetDatabase();
const pristineDurableState = durableSnapshot();
const autocommitOffPath = await writeRuntimeFile('autocommit-off.sql', `
\\set AUTOCOMMIT off
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_AUTOCOMMIT_TAIL
`);
const autocommitOff = psql(['-f', autocommitOffPath], { allowFailure: true });
expectFailure(autocommitOff, 'AUTOCOMMIT off', /CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED/);
assert.doesNotMatch(autocommitOff.output, /CNYOS_UNREACHABLE_AUTOCOMMIT_TAIL/);
assertDurableUnchanged('AUTOCOMMIT off', pristineDurableState);

await resetDatabase();
const singleTransactionPath = await writeRuntimeFile('single-transaction-wrapper.sql', `
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_SINGLE_TRANSACTION_TAIL
`);
const singleTransaction = psql(
  ['--single-transaction', '-f', singleTransactionPath],
  { allowFailure: true }
);
expectFailure(
  singleTransaction,
  '--single-transaction',
  /CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED/
);
assert.doesNotMatch(singleTransaction.output, /CNYOS_UNREACHABLE_SINGLE_TRANSACTION_TAIL/);
assertDurableUnchanged('--single-transaction', pristineDurableState);

await resetDatabase();
const existingTransactionPath = await writeRuntimeFile('existing-transaction.sql', `
begin;
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_EXISTING_TRANSACTION_TAIL
`);
const existingTransaction = psql(['-f', existingTransactionPath], { allowFailure: true });
expectFailure(
  existingTransaction,
  'existing transaction',
  /CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED/
);
assert.doesNotMatch(existingTransaction.output, /CNYOS_UNREACHABLE_EXISTING_TRANSACTION_TAIL/);
assertDurableUnchanged('existing transaction', pristineDurableState);

await resetDatabase();
const wrongServerIdentityPath = await writeRuntimeFile('wrong-server-identity.sql', `
set role authenticated;
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_SERVER_IDENTITY_TAIL
`);
const wrongServerIdentity = psql(
  ['-f', wrongServerIdentityPath],
  { allowFailure: true }
);
expectFailure(
  wrongServerIdentity,
  'server-side current_user mismatch',
  /CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED/
);
assert.doesNotMatch(
  wrongServerIdentity.output,
  /CNYOS_UNREACHABLE_SERVER_IDENTITY_TAIL/
);
assertDurableUnchanged('server-side current_user mismatch', pristineDurableState);

const immediateHookSql = `
create function supabase_migrations.fail_cnyos_ledger_repair_test()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.version='202609010100' then
    raise exception 'TEST_LEDGER_REPAIR_ABORT';
  end if;
  return new;
end $$;
create trigger fail_cnyos_ledger_repair_test
before insert or update on supabase_migrations.schema_migrations
for each row execute function supabase_migrations.fail_cnyos_ledger_repair_test();
`;

await resetDatabase();
psql(['-v', 'ON_ERROR_STOP=1', '-c', immediateHookSql]);
const immediateHookState = durableSnapshot();
assert.equal(immediateHookState.ledger.has_triggers_flag, true);
assert.equal(immediateHookState.ledger.trigger_count, 1);
const stopOverridePath = await writeRuntimeFile('caller-error-settings.sql', `
\\set ON_ERROR_STOP off
\\set ON_ERROR_ROLLBACK on
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_ERROR_TAIL
`);
const stoppedFailure = psql(['-f', stopOverridePath], { allowFailure: true });
expectFailure(
  stoppedFailure,
  'artifact error-setting override with a ledger hook',
  /CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID/
);
assert.doesNotMatch(
  stoppedFailure.output,
  /TEST_LEDGER_REPAIR_ABORT/,
  'ledger trigger must be refused before it can execute'
);
assert.doesNotMatch(stoppedFailure.output, /CNYOS_UNREACHABLE_ERROR_TAIL/);
assertDurableUnchanged('artifact error-setting override', immediateHookState);

await resetDatabase();
const injectedFailureNeedle =
  "perform set_config('cnyos.migration_ledger_repair_committed_nonce'," +
  'v_run_nonce::text,false);';
const injectedFailureArtifact = replaceExact(
  testBoundStrictArtifact,
  injectedFailureNeedle,
  `raise exception 'TEST_LEDGER_REPAIR_ABORT';\n${injectedFailureNeedle}`,
  1,
  'test-bound mid-repair failure'
);
const continuationArtifact = replaceExact(
  replaceExact(
    replaceExact(
      injectedFailureArtifact,
      '\\set ON_ERROR_STOP 1',
      '\\set ON_ERROR_STOP 0',
      1,
      'savepoint ON_ERROR_STOP'
    ),
    '\\set ON_ERROR_ROLLBACK off',
    '\\set ON_ERROR_ROLLBACK on',
    1,
    'savepoint ON_ERROR_ROLLBACK'
  ),
  'end\n$ledger_repair$;\ncommit;\n',
  'end\n$ledger_repair$;\n\\set ON_ERROR_STOP 1\ncommit;\n',
  1,
  'savepoint post-error stop restoration'
);
const continuationArtifactPath = await writeRuntimeFile(
  'adversarial-savepoint-continuation-probe.sql',
  continuationArtifact
);
const staleMarkerPath = await writeRuntimeFile('stale-marker-savepoint-probe.sql', `
create temporary table cnyos_migration_ledger_repair_evidence (
  gate_token text not null,
  run_nonce uuid not null,
  repair_xid text not null,
  evidence jsonb,
  primary key (gate_token,run_nonce,repair_xid)
) on commit preserve rows;
insert into pg_temp.cnyos_migration_ledger_repair_evidence
values ('${'f'.repeat(64)}','${staleNonce}'::uuid,'${staleXid}',
  jsonb_build_object('status','${successStatus}','ledger_reconciled',true,
    'repair_run_nonce','${staleNonce}'::uuid,'repair_transaction_xid','${staleXid}'));
select set_config('cnyos.migration_ledger_repair_run_nonce','${staleNonce}',false);
select set_config('cnyos.migration_ledger_repair_committed_nonce','${staleNonce}',false);
select set_config('cnyos.migration_ledger_repair_committed_xid','${staleXid}',false);
\\i ${continuationArtifactPath}
\\echo CNYOS_UNREACHABLE_SAVEPOINT_TAIL
`);
const savepointContinuation = psql(['-f', staleMarkerPath], { allowFailure: true });
expectFailure(
  savepointContinuation,
  'adversarial savepoint continuation with stale marker',
  /CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED/
);
assert.match(savepointContinuation.output, /TEST_LEDGER_REPAIR_ABORT/);
assert.doesNotMatch(savepointContinuation.output, /CNYOS_UNREACHABLE_SAVEPOINT_TAIL/);
assertDurableUnchanged('adversarial savepoint continuation', pristineDurableState);

// Force a real PostgreSQL deferred-constraint failure at COMMIT after the
// entire repair body has run. This covers a failure that cannot be caught by
// statement-level error handling and proves ledger, receipt, and schema writes
// all roll back atomically without any post-COMMIT success result.
await resetDatabase();
const deferredCommitFailureBefore = durableSnapshot();
const deferredCommitFailureArtifact = replaceExact(
  testBoundStrictArtifact,
  'end\n$ledger_repair$;\ncommit;\n',
  'end\n$ledger_repair$;\n' +
    'set constraints cnyos_ledger_repair_commit_fk deferred;\n' +
    'insert into pg_temp.cnyos_ledger_repair_commit_child(id,parent_id) values (1,1);\n' +
    'commit;\n',
  1,
  'genuine deferred COMMIT failure'
);
const deferredCommitFailureArtifactPath = await writeRuntimeFile(
  'genuine-deferred-commit-failure-repair.sql',
  deferredCommitFailureArtifact
);
const deferredCommitFailureWrapperPath = await writeRuntimeFile(
  'genuine-deferred-commit-failure-wrapper.sql',
  `create temporary table cnyos_ledger_repair_commit_parent (
  id integer primary key
);
create temporary table cnyos_ledger_repair_commit_child (
  id integer primary key,
  parent_id integer,
  constraint cnyos_ledger_repair_commit_fk foreign key (parent_id)
    references cnyos_ledger_repair_commit_parent(id)
    deferrable initially deferred
);
\\i ${deferredCommitFailureArtifactPath}
\\echo CNYOS_UNREACHABLE_DEFERRED_COMMIT_TAIL
`
);
const deferredCommitFailure = psql(
  ['-f', deferredCommitFailureWrapperPath],
  { allowFailure: true }
);
expectFailure(
  deferredCommitFailure,
  'genuine deferred repair COMMIT failure',
  /cnyos_ledger_repair_commit_fk/
);
assert.doesNotMatch(
  deferredCommitFailure.output,
  /CNYOS_UNREACHABLE_DEFERRED_COMMIT_TAIL/
);
assert.equal(
  sessionAdvisoryLockCount(),
  0,
  'genuine deferred COMMIT failure must not leak the session advisory lock after client exit'
);
assertDurableUnchanged('genuine deferred repair COMMIT failure', deferredCommitFailureBefore);

await resetDatabase();
const maliciousDefaultSql = `
create function supabase_migrations.mutate_ledger_from_receipt_default_test()
returns timestamptz language plpgsql volatile set search_path=pg_catalog as $$
begin
  update supabase_migrations.schema_migrations
  set name='CNYOS_TEST_MALICIOUS_DEFAULT_MUTATION'
  where version=(select min(version) from supabase_migrations.schema_migrations);
  return pg_catalog.clock_timestamp();
end $$;
${receiptTableFixtureSql(
    'supabase_migrations.mutate_ledger_from_receipt_default_test()'
  )}
`;
psql(['-v', 'ON_ERROR_STOP=1', '-c', maliciousDefaultSql]);
const maliciousDefaultState = durableSnapshot();
assert.equal(
  maliciousDefaultState.receipts.columns.find(column => column.name === 'committed_at')
    .default_expression,
  'supabase_migrations.mutate_ledger_from_receipt_default_test()'
);
const maliciousDefaultWrapperPath = await writeRuntimeFile('malicious-default-wrapper.sql', `
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_MALICIOUS_DEFAULT_TAIL
`);
const maliciousDefault = psql(
  ['-f', maliciousDefaultWrapperPath],
  { allowFailure: true }
);
expectFailure(
  maliciousDefault,
  'malicious receipt committed_at default',
  /CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID/
);
assert.doesNotMatch(
  maliciousDefault.output,
  /CNYOS_UNREACHABLE_MALICIOUS_DEFAULT_TAIL/
);
assertDurableUnchanged('malicious receipt committed_at default', maliciousDefaultState);

await resetDatabase();
const maliciousRuleSql = `
${receiptTableFixtureSql()}
create rule suppress_cnyos_repair_receipt_update_test as
on update to supabase_migrations.cnyos_migration_ledger_repair_receipts
do instead nothing;
`;
psql(['-v', 'ON_ERROR_STOP=1', '-c', maliciousRuleSql]);
const maliciousRuleState = durableSnapshot();
assert.equal(maliciousRuleState.receipts.has_rules_flag, true);
assert.equal(maliciousRuleState.receipts.rule_count, 1);
const maliciousRuleWrapperPath = await writeRuntimeFile('malicious-rule-wrapper.sql', `
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_MALICIOUS_RULE_TAIL
`);
const maliciousRule = psql(
  ['-f', maliciousRuleWrapperPath],
  { allowFailure: true }
);
expectFailure(
  maliciousRule,
  'receipt rewrite rule hook',
  /CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID/
);
assert.doesNotMatch(maliciousRule.output, /CNYOS_UNREACHABLE_MALICIOUS_RULE_TAIL/);
assertDurableUnchanged('receipt rewrite rule hook', maliciousRuleState);

await resetDatabase();
const deferredSilentMutationSql = `
${receiptTableFixtureSql()}
create function supabase_migrations.silently_mutate_cnyos_ledger_at_commit_test()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  update supabase_migrations.schema_migrations
  set name='CNYOS_TEST_DEFERRED_SILENT_MUTATION'
  where version=(select min(version) from supabase_migrations.schema_migrations);
  return new;
end $$;
create constraint trigger silently_mutate_cnyos_ledger_at_commit_test
after insert on supabase_migrations.cnyos_migration_ledger_repair_receipts
deferrable initially deferred
for each row execute function
  supabase_migrations.silently_mutate_cnyos_ledger_at_commit_test();
`;
psql(['-v', 'ON_ERROR_STOP=1', '-c', deferredSilentMutationSql]);
const deferredSilentMutationState = durableSnapshot();
assert.equal(deferredSilentMutationState.receipts.has_triggers_flag, true);
assert.equal(deferredSilentMutationState.receipts.trigger_count, 1);
const deferredMutationWrapperPath = await writeRuntimeFile('deferred-mutation-wrapper.sql', `
\\i ${testBoundStrictArtifactPath}
\\echo CNYOS_UNREACHABLE_DEFERRED_MUTATION_TAIL
`);
const deferredSilentMutation = psql(
  ['-f', deferredMutationWrapperPath],
  { allowFailure: true }
);
expectFailure(
  deferredSilentMutation,
  'deferred silent ledger mutation hook',
  /CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID/
);
assert.doesNotMatch(
  deferredSilentMutation.output,
  /CNYOS_UNREACHABLE_DEFERRED_MUTATION_TAIL/
);
assertDurableUnchanged(
  'deferred silent ledger mutation hook',
  deferredSilentMutationState
);

await resetDatabase();
const postCommitBoundary =
  'commit;\nbegin isolation level repeatable read read only;\n';
const postCommitMutationName = 'CNYOS_TEST_POST_COMMIT_LEDGER_MUTATION';
const postCommitMutationBeforeUnlockProbe = replaceExact(
  testBoundStrictArtifact,
  postCommitBoundary,
  'commit;\n' +
    `update supabase_migrations.schema_migrations set name=${
      sqlString(postCommitMutationName)
    } where version=${sqlString(entries[0].version)};\n` +
    'begin isolation level repeatable read read only;\n',
  1,
  'test-bound post-COMMIT ledger mutation'
);
const failureUnlockNeedle =
  '\\else\n' +
  'rollback;\n' +
  '\\unset cnyos_repair_lock_released\n' +
  'select pg_catalog.pg_advisory_unlock(202608302100::bigint) as cnyos_repair_lock_released\n' +
  '\\gset\n';
const postCommitMutationArtifact = replaceExact(
  postCommitMutationBeforeUnlockProbe,
  failureUnlockNeedle,
  failureUnlockNeedle + advisoryLockProbeSql('proof-failure-after-unlock'),
  1,
  'post-COMMIT proof-failure advisory unlock probe'
);
const postCommitMutationArtifactPath = await writeRuntimeFile(
  'test-bound-post-commit-ledger-mutation.sql',
  postCommitMutationArtifact
);
const postCommitMutationWrapperPath = await writeRuntimeFile(
  'post-commit-ledger-mutation-wrapper.sql',
  `\\i ${postCommitMutationArtifactPath}
\\echo CNYOS_UNREACHABLE_POST_COMMIT_MUTATION_TAIL
`
);
const postCommitMutation = psql(
  ['-f', postCommitMutationWrapperPath],
  { allowFailure: true }
);
expectFailure(
  postCommitMutation,
  'test-bound post-COMMIT durable ledger mutation',
  /CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED/
);
assert.doesNotMatch(
  postCommitMutation.output,
  /CNYOS_UNREACHABLE_POST_COMMIT_MUTATION_TAIL/
);
assert.deepEqual(
  jsonRows(postCommitMutation)
    .filter(row => row.test_advisory_lock_phase === 'proof-failure-after-unlock')
    .map(row => row.own_granted_advisory_locks),
  [0],
  'post-COMMIT proof refusal must release the session advisory lock before aborting'
);
const postCommitMutationState = durableSnapshot();
assert.equal(postCommitMutationState.ledger.rows.length, entries.length);
assert.equal(postCommitMutationState.receipts.rows.length, 1);
assert.equal(
  postCommitMutationState.ledger.rows.find(row => row.version === entries[0].version).name,
  postCommitMutationName,
  'test-bound mutation must be durably committed before proof refuses success'
);

console.log(
  'PostgreSQL 17 psql ledger verifier/repair E2E passed: exact pre-reconciliation ' +
  'read-only evidence and mandatory live/default-ACL-inventory repair refusals, disposable ' +
  'strict repair evidence, exact catalogs and total checks, server identity, nonblocking ' +
  'advisory-lock lifecycles, durable post-COMMIT proof, replay denial, client transaction modes, ' +
  'source-blocker savepoint recovery, pre-write hook/default refusals, and genuine COMMIT-time ' +
  'rollback.'
);
