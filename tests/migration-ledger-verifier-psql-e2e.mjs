import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST,
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST,
  CHANANYA_REVIEWED_SYSTEM_IDENTIFIER,
  MIGRATION_LEDGER_ACL_PHASE_STRICT,
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';
import {
  buildMigrationLedgerVerificationSql,
  preReconciliationVerificationStatus,
  strictVerificationStatus,
  targetUnverifiedStrictVerificationStatus
} from '../scripts/generate-migration-ledger-verification-sql.mjs';
import { buildTenantBootstrapSql } from '../scripts/generate-tenant-bootstrap-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-verifier-psql-e2e-')
);
const clientImage = 'postgres:17';
const databasePort = '5432';
const databaseUser = 'postgres';
const databasePassword = 'postgres';
const databaseName = 'postgres';
const advisoryLockKey = '202608302100';
const priorLedgerBaselineDatabase = 'cnyos_psql_e2e_baseline';
const runtimeRoles = ['authenticator', 'service_role', 'authenticated', 'anon'];
const adminId = '33333333-3333-4333-a333-333333333333';
const successStatuses = [
  preReconciliationVerificationStatus,
  strictVerificationStatus,
  targetUnverifiedStrictVerificationStatus
];

const cnyosConfig = JSON.parse(await fs.readFile(
  path.join(root, 'config', 'tenant.cnyos-staging.json'),
  'utf8'
));
const jitarsaConfig = JSON.parse(await fs.readFile(
  path.join(root, 'config', 'tenant.jitarsa-staging.json'),
  'utf8'
));
const databaseHosts = [cnyosConfig, jitarsaConfig].map(config =>
  `db.${new URL(config.database.url).hostname.replace(/\.supabase\.co$/, '')}.supabase.co`
);

function dockerClientArguments(command, args, { detached = false, name } = {}) {
  return [
    'run',
    ...(detached ? ['--detach'] : []),
    '--rm',
    '--pull', 'never',
    ...(name ? ['--name', name] : []),
    '--network', 'host',
    ...databaseHosts.flatMap(host => ['--add-host', `${host}:127.0.0.1`]),
    '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${tempDirectory},dst=/e2e,readonly`,
    '-w', '/workspace',
    '-e', `PGPASSWORD=${databasePassword}`,
    clientImage,
    command,
    ...args
  ];
}

function runDockerClient(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(
    'docker',
    dockerClientArguments(command, args),
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    }
  );
  if (result.error) {
    throw new Error(
      `Verifier psql E2E requires Docker and ${clientImage}: ${result.error.message}`
    );
  }
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

function psql(host, args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', host,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', databaseName,
    ...args
  ], options);
}

function adminPsql(args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', '127.0.0.1',
    '-p', databasePort,
    '-U', databaseUser,
    '-d', 'template1',
    ...args
  ], options);
}

async function writeRuntimeFile(name, source) {
  const hostPath = path.join(tempDirectory, name);
  await fs.writeFile(hostPath, source, 'utf8');
  return `/e2e/${name}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function replaceExact(source, needle, replacement, expectedCount, label) {
  const count = source.split(needle).length - 1;
  assert.equal(count, expectedCount, `${label} replacement count changed`);
  return source.split(needle).join(replacement);
}

function jsonRows(result) {
  return result.stdout
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

function assertNoSuccessEvidence(result, label) {
  assert.equal(
    jsonRows(result).some(row =>
      successStatuses.includes(row.status) ||
      row.verification_transaction_rolled_back === true ||
      row.advisory_lock_released === true
    ),
    false,
    `${label} emitted success-shaped verification evidence`
  );
}

function expectVerifierFailure(result, label, expectedError) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expectedError, `${label} did not reach its refusal`);
  assertNoSuccessEvidence(result, label);
}

function oneEvidence(result, expectedStatus, label) {
  const parsed = jsonRows(result);
  const matches = parsed.filter(row => row.status === expectedStatus);
  assert.equal(parsed.length, 1, `${label} must emit exactly one JSON object`);
  assert.equal(matches.length, 1, `${label} must emit exactly one evidence object`);
  assert.deepEqual(
    parsed.at(-1),
    matches[0],
    `${label} evidence must be the final parseable JSON object`
  );
  return matches[0];
}

function assertCommonNonAuthorizingEvidence(evidence, expectedStatus, label) {
  assert.equal(evidence.status, expectedStatus, `${label} status changed`);
  assert.doesNotMatch(evidence.status, /PASSED/, `${label} used success-shaped status wording`);
  assert.equal(evidence.authorization, false, `${label} authorized an operation`);
  assert.equal(
    evidence.ledger_reconciliation_authorized,
    false,
    `${label} authorized ledger reconciliation`
  );
  assert.equal(
    evidence.live_callable_acl_inventory_required,
    true,
    `${label} omitted the live callable-ACL prerequisite`
  );
  assert.equal(
    evidence.live_callable_acl_inventory_complete,
    false,
    `${label} claimed the live callable-ACL inventory was complete`
  );
  assert.equal(
    evidence.ledger_reconciliation_blocked_pending_live_callable_acl_inventory,
    true,
    `${label} omitted the live callable-ACL blocker`
  );
  assert.equal(evidence.ledger_reconciled, false, `${label} claimed ledger reconciliation`);
  assert.equal(evidence.production_eligible, false, `${label} claimed production eligibility`);
  assert.equal(evidence.rollback_required, true, `${label} omitted mandatory rollback`);
  assert.equal(
    evidence.verification_transaction_rolled_back,
    true,
    `${label} did not prove verifier rollback`
  );
  assert.equal(
    evidence.advisory_lock_released,
    true,
    `${label} did not prove advisory-lock release`
  );
}

function transitionGrantSql() {
  return [
    ...CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.aclTuples,
    ...CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.browserRpcAclTuples
  ].map(([grantee, signature]) =>
    `grant execute on function ${signature} to ${grantee};`
  ).join('\n');
}

function strictPostRemediationFixtureSql() {
  const triggerClosure = CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerInventory
    .map(([signature]) =>
      `revoke all on function ${signature} from public,anon,authenticated,service_role;`
    )
    .join('\n');
  const browserClosure = CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.browserRpcAclTuples
    .map(([grantee, signature]) =>
      `revoke execute on function ${signature} from ${grantee};`
    )
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

function ownAdvisoryLockCount(host) {
  const result = psql(host, [
    '--set=ON_ERROR_STOP=1',
    '--command', `
select count(*)
from pg_catalog.pg_locks
where locktype='advisory' and granted
  and classid::bigint=(${advisoryLockKey}::bigint >> 32)
  and objid::bigint=(${advisoryLockKey}::bigint & 4294967295::bigint)
  and objsubid=1;
`
  ]);
  return Number(result.stdout.trim());
}

function databaseSnapshot(host) {
  const result = psql(host, [
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'clinics',(
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(clinic) order by clinic.id),
      '[]'::pg_catalog.jsonb
    )
    from public.clinics clinic
  ),
  'profiles',(
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(profile) order by profile.id),
      '[]'::pg_catalog.jsonb
    )
    from public.profiles profile
  ),
  'memberships',(
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(membership)
        order by membership.clinic_id,membership.profile_id
      ),
      '[]'::pg_catalog.jsonb
    )
    from public.clinic_memberships membership
  ),
  'ledger',(
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ledger) order by ledger.version),
      '[]'::pg_catalog.jsonb
    )
    from supabase_migrations.schema_migrations ledger
  ),
  'public_routine_security',(
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          procedure.oid::text,
          procedure.proowner::text,
          procedure.proacl::text,
          procedure.prosecdef,
          procedure.proconfig
        ) order by procedure.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
  )
)::text;
`
  ]);
  const rows = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(rows.length, 1, 'verifier database snapshot must be one JSON row');
  return JSON.parse(rows[0]);
}

async function dropDisposableDatabases() {
  for (const database of [databaseName, priorLedgerBaselineDatabase]) {
    adminPsql([
      '--set=ON_ERROR_STOP=1',
      '--command', `drop database if exists ${database} with (force);`
    ]);
  }
}

async function resetCluster() {
  await dropDisposableDatabases();
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `drop role if exists ${runtimeRoles.join(', ')};`
  ]);
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `create database ${databaseName} owner ${databaseUser};`
  ]);
}

async function prepareStrictDatabase(config, loaderPath) {
  await resetCluster();
  const host = `db.${new URL(config.database.url).hostname.replace(/\.supabase\.co$/, '')}.supabase.co`;
  psql(host, ['--set=ON_ERROR_STOP=1', '--file', loaderPath]);
  const setupPath = await writeRuntimeFile(
    `setup-${config.deploymentId}.sql`,
    `\\set ON_ERROR_STOP 1\n` +
      `${buildTenantBootstrapSql(config)}\n` +
      `insert into auth.users(id,email,raw_user_meta_data)\n` +
      `values (${sqlString(adminId)},'verifier-admin@example.test',` +
      `'${JSON.stringify({ full_name: 'Verifier Admin' })}'::jsonb);\n` +
      `update public.profiles\n` +
      `set role='viewer',system_role='super_admin'\n` +
      `where id=${sqlString(adminId)}::uuid;\n` +
      `insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary)\n` +
      `values (${sqlString(config.tenant.expectedClinicId)}::uuid,` +
      `${sqlString(adminId)}::uuid,'owner',true);\n` +
      `${transitionGrantSql()}\n` +
      `${strictPostRemediationFixtureSql()}\n` +
      `create schema supabase_migrations authorization postgres;\n` +
      `create table supabase_migrations.schema_migrations (\n` +
      `  version text not null primary key,\n` +
      `  statements text[],\n` +
      `  name text\n` +
      `);\n`
  );
  psql(host, ['--set=ON_ERROR_STOP=1', '--file', setupPath]);
  return host;
}

async function waitForLockCount(host, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = -1;
  while (Date.now() < deadline) {
    observed = ownAdvisoryLockCount(host);
    if (observed === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for advisory-lock count ${expected}; observed ${observed}`
  );
}

function startExternalLockHolder(host) {
  const name = `cnyos-verifier-lock-${process.pid}-${Date.now()}`;
  const result = spawnSync(
    'docker',
    dockerClientArguments(
      'psql',
      [
        '-X', '-q',
        '-h', host,
        '-p', databasePort,
        '-U', databaseUser,
        '-d', databaseName,
        '--set=ON_ERROR_STOP=1',
        '--command',
        `select pg_catalog.pg_advisory_lock(${advisoryLockKey}::bigint); ` +
          `select pg_catalog.pg_sleep(60);`
      ],
      { detached: true, name }
    ),
    { cwd: root, encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `failed to start verifier lock holder: ${result.error?.message || result.stderr}`
    );
  }
  return name;
}

function stopExternalLockHolder(name) {
  const result = spawnSync(
    'docker',
    ['stop', '--time', '1', name],
    { cwd: root, encoding: 'utf8' }
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || (result.status !== 0 && !/No such container/i.test(output))) {
    throw new Error(
      `failed to stop verifier lock holder: ${result.error?.message || output}`
    );
  }
}

const entries = loadMigrationEntries(root);
assert.equal(entries.length, 45, 'verifier fixture must load the reviewed migration set');
const loaderPath = await writeRuntimeFile('load-reviewed-schema.sql', [
  '\\set ON_ERROR_STOP 1',
  '\\i /workspace/tests/fixtures/postgres17-supabase-compat.sql',
  ...entries.map(entry => `\\i /workspace/supabase/migrations/${entry.file}`),
  ''
].join('\n'));

const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
});
if (gitRevision.error || gitRevision.status !== 0) {
  throw new Error(`unable to resolve verifier source revision: ${gitRevision.stderr}`);
}
const sourceRevision = (
  process.env.CNYOS_RELEASE_SHA || gitRevision.stdout.trim()
).toLowerCase();
assert.match(sourceRevision, /^[0-9a-f]{40}$/, 'verifier source revision must be a full SHA');

const cnyosStrictVerifier = buildMigrationLedgerVerificationSql({
  config: cnyosConfig,
  entries,
  sourceRevision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
});
const jitarsaStrictVerifier = buildMigrationLedgerVerificationSql({
  config: jitarsaConfig,
  entries,
  sourceRevision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
});

for (const [label, verifier] of [
  ['CNYOS', cnyosStrictVerifier],
  ['Jitarsa', jitarsaStrictVerifier]
]) {
  assert.equal(
    (verifier.match(
      /select pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\) as cnyos_verification_lock_acquired/g
    ) ?? []).length,
    1,
    `${label} verifier must acquire the session lock without waiting`
  );
  assert.doesNotMatch(
    verifier,
    /select pg_catalog\.pg_advisory_lock\(202608302100::bigint\);/,
    `${label} verifier retained a blocking session lock`
  );
  assert.match(verifier, /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_ALREADY_HELD/);
  assert.match(verifier, /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_UNAVAILABLE/);
  assert.match(verifier, /cnyos_verification_lock_fully_released/);
}

let primaryFailure = false;
try {
  const clientVersion = runDockerClient('psql', ['--version']).stdout.trim();
  assert.match(
    clientVersion,
    /psql \(PostgreSQL\) 17\./,
    'verifier test must use the PostgreSQL 17 client'
  );

  const cnyosHost = await prepareStrictDatabase(cnyosConfig, loaderPath);
  assert.match(
    psql(cnyosHost, ['--command', 'show server_version']).stdout.trim(),
    /^17\./,
    'verifier test must use a PostgreSQL 17 server'
  );
  const systemIdentifier = psql(cnyosHost, [
    '--set=ON_ERROR_STOP=1',
    '--command', 'select system_identifier::text from pg_catalog.pg_control_system();'
  ]).stdout.trim();
  assert.match(systemIdentifier, /^\d+$/, 'CI system identifier must be numeric');
  assert.notEqual(
    systemIdentifier,
    CHANANYA_REVIEWED_SYSTEM_IDENTIFIER,
    'ephemeral PostgreSQL unexpectedly shares the reviewed Chananya system identifier'
  );

  const exactCnyosVerifierPath = await writeRuntimeFile(
    'exact-generated-cnyos-strict-verifier.sql',
    cnyosStrictVerifier
  );
  const cnyosBaseline = databaseSnapshot(cnyosHost);
  assert.equal(ownAdvisoryLockCount(cnyosHost), 0);
  const wrongCluster = psql(
    cnyosHost,
    ['--file', exactCnyosVerifierPath],
    { allowFailure: true }
  );
  expectVerifierFailure(
    wrongCluster,
    'exact CNYOS verifier on the ephemeral cluster',
    /CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER/
  );
  assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
  assert.equal(ownAdvisoryLockCount(cnyosHost), 0);

  const testBoundCnyosVerifier = replaceExact(
    cnyosStrictVerifier,
    CHANANYA_REVIEWED_SYSTEM_IDENTIFIER,
    systemIdentifier,
    2,
    'ephemeral CNYOS verifier system identifier'
  );
  const testBoundCnyosVerifierPath = await writeRuntimeFile(
    'test-bound-cnyos-strict-verifier.sql',
    testBoundCnyosVerifier
  );

  const injectedWriteVerifier = replaceExact(
    testBoundCnyosVerifier,
    'begin isolation level repeatable read read only;\n',
    'begin isolation level repeatable read read only;\n' +
      "update public.clinics set name_en='CNYOS_FORBIDDEN_VERIFIER_WRITE';\n",
    1,
    'native read-only verifier write injection'
  );
  const injectedWriteVerifierPath = await writeRuntimeFile(
    'test-bound-cnyos-strict-verifier-injected-write.sql',
    injectedWriteVerifier
  );
  const injectedWrite = psql(
    cnyosHost,
    ['--file', injectedWriteVerifierPath],
    { allowFailure: true }
  );
  expectVerifierFailure(
    injectedWrite,
    'native write inside verifier read-only transaction',
    /cannot execute UPDATE in a read-only transaction/i
  );
  assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
  assert.equal(ownAdvisoryLockCount(cnyosHost), 0);

  const transactionModeCases = [
    {
      label: 'AUTOCOMMIT=off',
      expected: /CNYOS_STAGING_VERIFICATION_PSQL_AUTOCOMMIT_REQUIRED/,
      psqlArguments: [],
      source: `\\set AUTOCOMMIT off\n` +
        `update public.clinics set name_en='UNCOMMITTED AUTOCOMMIT';\n`
    },
    {
      label: 'explicit outer transaction',
      expected: /CNYOS_STAGING_VERIFICATION_PSQL_EXISTING_TRANSACTION_REFUSED/,
      psqlArguments: [],
      source: `begin;\n` +
        `update public.clinics set name_en='UNCOMMITTED OUTER';\n`
    },
    {
      label: '--single-transaction',
      expected: /CNYOS_STAGING_VERIFICATION_PSQL_EXISTING_TRANSACTION_REFUSED/,
      psqlArguments: ['--single-transaction'],
      source: `update public.clinics set name_en='UNCOMMITTED SINGLE';\n`
    }
  ];

  for (const testCase of transactionModeCases) {
    const wrapperPath = await writeRuntimeFile(
      `${testCase.label.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.sql`,
      `\\set ON_ERROR_STOP 1\n` +
        testCase.source +
        `\\i ${exactCnyosVerifierPath}\n` +
        `\\echo CNYOS_UNREACHABLE_VERIFIER_TRANSACTION_TAIL\n`
    );
    const result = psql(
      cnyosHost,
      [...testCase.psqlArguments, '--file', wrapperPath],
      { allowFailure: true }
    );
    expectVerifierFailure(result, testCase.label, testCase.expected);
    assert.doesNotMatch(
      result.output,
      /CNYOS_UNREACHABLE_VERIFIER_TRANSACTION_TAIL/,
      `${testCase.label} continued after refusal`
    );
    assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
    assert.equal(ownAdvisoryLockCount(cnyosHost), 0);
  }

  const sameSessionLockPath = await writeRuntimeFile(
    'same-session-pre-held-lock.sql',
    `\\set ON_ERROR_STOP 1\n` +
      `select pg_catalog.pg_advisory_lock(${advisoryLockKey}::bigint);\n` +
      `\\i ${exactCnyosVerifierPath}\n` +
      `\\echo CNYOS_UNREACHABLE_VERIFIER_PREHELD_LOCK_TAIL\n`
  );
  const sameSessionLock = psql(
    cnyosHost,
    ['--file', sameSessionLockPath],
    { allowFailure: true }
  );
  expectVerifierFailure(
    sameSessionLock,
    'same-session pre-held advisory lock',
    /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_ALREADY_HELD/
  );
  assert.doesNotMatch(
    sameSessionLock.output,
    /CNYOS_UNREACHABLE_VERIFIER_PREHELD_LOCK_TAIL/
  );
  assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
  assert.equal(ownAdvisoryLockCount(cnyosHost), 0);

  const holderName = startExternalLockHolder(cnyosHost);
  try {
    await waitForLockCount(cnyosHost, 1);
    const contentionStartedAt = Date.now();
    const contention = psql(
      cnyosHost,
      ['--file', exactCnyosVerifierPath],
      { allowFailure: true }
    );
    const contentionElapsedMs = Date.now() - contentionStartedAt;
    expectVerifierFailure(
      contention,
      'cross-session advisory-lock contention',
      /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_UNAVAILABLE/
    );
    assert.ok(
      contentionElapsedMs < 10_000,
      `contended verifier waited ${contentionElapsedMs}ms instead of refusing promptly`
    );
    assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
    assert.equal(
      ownAdvisoryLockCount(cnyosHost),
      1,
      'contended verifier disturbed the holder session lock'
    );
  } finally {
    stopExternalLockHolder(holderName);
  }
  await waitForLockCount(cnyosHost, 0);

  const cnyosStrictSuccess = psql(
    cnyosHost,
    ['--file', testBoundCnyosVerifierPath]
  );
  const cnyosEvidence = oneEvidence(
    cnyosStrictSuccess,
    strictVerificationStatus,
    'CNYOS strict verifier'
  );
  assertCommonNonAuthorizingEvidence(
    cnyosEvidence,
    strictVerificationStatus,
    'CNYOS strict verifier'
  );
  assert.equal(cnyosEvidence.acl_phase, MIGRATION_LEDGER_ACL_PHASE_STRICT);
  assert.equal(cnyosEvidence.source_revision, sourceRevision);
  assert.equal(cnyosEvidence.expected_deployment_id, cnyosConfig.deploymentId);
  assert.equal(cnyosEvidence.expected_clinic_code, cnyosConfig.tenant.expectedClinicCode);
  assert.equal(cnyosEvidence.expected_clinic_id, cnyosConfig.tenant.expectedClinicId);
  assert.equal(cnyosEvidence.target_identity_verified, true);
  assert.equal(cnyosEvidence.target_identity_verification, 'system-identifier-enforced');
  assert.equal(cnyosEvidence.expected_system_identifier, systemIdentifier);
  assert.equal(cnyosEvidence.observed_system_identifier, systemIdentifier);
  assert.deepEqual(databaseSnapshot(cnyosHost), cnyosBaseline);
  assert.equal(ownAdvisoryLockCount(cnyosHost), 0);

  const jitarsaHost = await prepareStrictDatabase(jitarsaConfig, loaderPath);
  const jitarsaBaseline = databaseSnapshot(jitarsaHost);
  const exactJitarsaVerifierPath = await writeRuntimeFile(
    'exact-generated-jitarsa-strict-verifier.sql',
    jitarsaStrictVerifier
  );
  const jitarsaStrictSuccess = psql(
    jitarsaHost,
    ['--file', exactJitarsaVerifierPath]
  );
  const jitarsaEvidence = oneEvidence(
    jitarsaStrictSuccess,
    targetUnverifiedStrictVerificationStatus,
    'Jitarsa strict verifier'
  );
  assertCommonNonAuthorizingEvidence(
    jitarsaEvidence,
    targetUnverifiedStrictVerificationStatus,
    'Jitarsa strict verifier'
  );
  assert.equal(jitarsaEvidence.acl_phase, MIGRATION_LEDGER_ACL_PHASE_STRICT);
  assert.equal(jitarsaEvidence.source_revision, sourceRevision);
  assert.equal(jitarsaEvidence.expected_deployment_id, jitarsaConfig.deploymentId);
  assert.equal(
    jitarsaEvidence.expected_clinic_code,
    jitarsaConfig.tenant.expectedClinicCode
  );
  assert.equal(jitarsaEvidence.expected_clinic_id, jitarsaConfig.tenant.expectedClinicId);
  assert.equal(jitarsaEvidence.target_identity_verified, false);
  assert.equal(
    jitarsaEvidence.target_identity_verification,
    'target-unverified-system-identifier-unpinned'
  );
  assert.equal(jitarsaEvidence.expected_system_identifier, null);
  assert.match(jitarsaEvidence.observed_system_identifier, /^\d+$/);
  assert.deepEqual(databaseSnapshot(jitarsaHost), jitarsaBaseline);
  assert.equal(ownAdvisoryLockCount(jitarsaHost), 0);

  console.log(
    'Migration ledger verifier psql E2E passed ' +
    '(PostgreSQL 17; transaction refusal, CNYOS cluster binding, nonblocking lock refusal, ' +
    'strict rollback evidence, and Jitarsa target-unverified evidence)'
  );
} catch (error) {
  primaryFailure = true;
  throw error;
} finally {
  try {
    await resetCluster();
  } catch (cleanupError) {
    if (!primaryFailure) throw cleanupError;
  }
  try {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!primaryFailure) throw cleanupError;
  }
}
