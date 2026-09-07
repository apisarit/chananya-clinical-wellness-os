import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-acl-candidate-psql-e2e-')
);
const clientImage = 'postgres:17';
const databaseHost = '127.0.0.1';
const databasePort = '5432';
const databaseUser = 'postgres';
const databasePassword = 'postgres';
const databaseName = 'cnyos_acl_candidate_e2e';
const candidates = [
  {
    label: 'trigger',
    sourcePath: path.join(
      root,
      'supabase',
      'manual',
      '202609060700_revoke_trigger_function_data_api_execute_candidate.sql'
    ),
    path: '/workspace/supabase/manual/202609060700_revoke_trigger_function_data_api_execute_candidate.sql',
    sourceGate: /CNYOS_TRIGGER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED/
  },
  {
    label: 'browser',
    sourcePath: path.join(
      root,
      'supabase',
      'manual',
      '202609060710_close_browser_rpc_acl_drift_candidate.sql'
    ),
    path: '/workspace/supabase/manual/202609060710_close_browser_rpc_acl_drift_candidate.sql',
    sourceGate: /CNYOS_BROWSER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED/
  }
];

function runDockerClient(command, args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', [
    'run', '--rm', '--pull', 'never', '--network', 'host',
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

  if (result.error) {
    throw new Error(
      `ACL candidate psql E2E requires Docker and ${clientImage}: ` +
      result.error.message
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
      `${command} ${args.join(' ')} failed with ${completed.status}:\n` +
      completed.output
    );
  }
  return completed;
}

function psql(args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', databaseName,
    ...args
  ], options);
}

function adminPsql(args = [], options = {}) {
  return runDockerClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', databaseHost,
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

function replaceExact(source, needle, replacement, expectedCount, label) {
  const count = source.split(needle).length - 1;
  assert.equal(count, expectedCount, `${label} replacement count changed`);
  return source.split(needle).join(replacement);
}

function parseJsonOutputLines(value) {
  return value.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function ownAdvisoryLockProbeSql(label) {
  return String.raw`
select pg_catalog.jsonb_build_object(
  'test_acl_candidate_handler_unlock','${label}',
  'own_granted_advisory_locks',pg_catalog.count(*)
)::text
from pg_catalog.pg_locks lock_row
where lock_row.locktype = 'advisory'
  and lock_row.pid = pg_catalog.pg_backend_pid()
  and lock_row.granted
  and lock_row.classid::bigint = (202608302100::bigint >> 32)
  and lock_row.objid::bigint =
      (202608302100::bigint & 4294967295::bigint)
  and lock_row.objsubid = 1;
`;
}

function snapshot() {
  const result = psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'sentinel', (
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(sentinel) order by sentinel.value),
      '[]'::pg_catalog.jsonb
    )
    from public.cnyos_acl_candidate_sentinel sentinel
  ),
  'public_routines', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          procedure.oid,
          procedure.proowner,
          procedure.proacl,
          procedure.prosecdef,
          procedure.proconfig
        ) order by procedure.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  ),
  'public_schema_acl', (
    select namespace.nspacl
    from pg_catalog.pg_namespace namespace
    where namespace.nspname = 'public'
  )
)::text;
`
  ]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'ACL candidate snapshot must be one JSON row');
  return JSON.parse(lines[0]);
}

function advisoryLockCount() {
  return Number(psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.count(*)::text
from pg_catalog.pg_locks lock_row
where lock_row.locktype = 'advisory'
  and lock_row.classid = 47::oid
  and lock_row.objid = 744839188::oid
  and lock_row.objsubid = 1
  and lock_row.granted;
`
  ]).stdout.trim());
}

function assertFailure(result, label, expectedError, baseline) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expectedError, `${label} missed its fail-closed gate`);
  assert.doesNotMatch(result.output, /CHECKS_PASSED|REMEDIATION_PASSED|READY/);
  assert.doesNotMatch(result.output, /CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL/);
  assert.deepEqual(snapshot(), baseline, `${label} changed durable or ACL state`);
  assert.equal(advisoryLockCount(), 0, `${label} leaked the advisory interlock`);
}

async function cleanFixture() {
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `drop database if exists ${databaseName} with (force);`
  ]);
}

async function createFixture() {
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `create database ${databaseName} owner ${databaseUser};`
  ]);
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create schema supabase_migrations;
create table public.clinics(marker integer);
create table supabase_migrations.schema_migrations(marker integer);
create table supabase_migrations.cnyos_migration_ledger_repair_receipts(marker integer);
create table public.cnyos_acl_candidate_sentinel(value integer primary key);
`
  ]);
}

let fixtureCreated = false;
try {
  await cleanFixture();
  await createFixture();
  fixtureCreated = true;

  const version = Number(psql([
    '--set=ON_ERROR_STOP=1',
    '--command', "select pg_catalog.current_setting('server_version_num');"
  ]).stdout.trim());
  assert.ok(
    version >= 170000 && version < 180000,
    `native ACL candidate E2E requires PostgreSQL 17, got ${version}`
  );

  const baseline = snapshot();
  assert.equal(advisoryLockCount(), 0);

  for (const candidate of candidates) {
    assertFailure(
      psql(['--file', candidate.path], { allowFailure: true }),
      `${candidate.label} exact source gate`,
      candidate.sourceGate,
      baseline
    );

    const preheldPath = await writeRuntimeFile(
      `${candidate.label}-preheld-lock.sql`,
      String.raw`\set ON_ERROR_STOP 1
select pg_catalog.pg_try_advisory_lock(202608302100::bigint)
  as cnyos_test_acl_candidate_preheld
\gset
\if :cnyos_test_acl_candidate_preheld
\else
do $cnyos_test_acl_candidate_prehold_abort$
begin
  raise exception 'CNYOS_TEST_ACL_CANDIDATE_PREHOLD_ACQUISITION_FAILED';
end
$cnyos_test_acl_candidate_prehold_abort$;
\endif
\i ${candidate.path}
\echo CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL
`
    );
    assertFailure(
      psql(['--file', preheldPath], { allowFailure: true }),
      `${candidate.label} same-session pre-held advisory key`,
      /CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_ALREADY_HELD/,
      baseline
    );

    const candidateSource = await fs.readFile(candidate.sourcePath, 'utf8');
    const continueAfterSourceGate = replaceExact(
      candidateSource,
      '\\set ON_ERROR_STOP 1',
      '\\set ON_ERROR_STOP 0',
      1,
      `${candidate.label} source-gate handler probe`
    );
    const instrumentedCandidatePath = await writeRuntimeFile(
      `${candidate.label}-source-gate-handler.sql`,
      continueAfterSourceGate
    );
    const handlerProbePath = await writeRuntimeFile(
      `${candidate.label}-source-gate-handler-wrapper.sql`,
      `\\i ${instrumentedCandidatePath}\n` +
      ownAdvisoryLockProbeSql(candidate.label) +
      String.raw`\set ON_ERROR_STOP 1
do $cnyos_acl_candidate_handler_probe_complete$
begin
  raise exception 'CNYOS_TEST_ACL_CANDIDATE_HANDLER_PROBE_COMPLETE';
end
$cnyos_acl_candidate_handler_probe_complete$;
\echo CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL
`
    );
    const handlerProbe = psql(
      ['--file', handlerProbePath],
      { allowFailure: true }
    );
    assert.notEqual(
      handlerProbe.status,
      0,
      `${candidate.label} source-gate handler probe unexpectedly succeeded`
    );
    assert.match(
      handlerProbe.output,
      candidate.sourceGate,
      `${candidate.label} source blocker was not exercised`
    );
    assert.match(
      handlerProbe.output,
      /CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED/,
      `${candidate.label} tail unlock did not report the handler's prior release`
    );
    assert.match(
      handlerProbe.output,
      /CNYOS_TEST_ACL_CANDIDATE_HANDLER_PROBE_COMPLETE/,
      `${candidate.label} same-session lock probe did not complete`
    );
    assert.doesNotMatch(
      handlerProbe.output,
      /CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL/,
      `${candidate.label} continued after the terminal test marker`
    );
    assert.deepEqual(
      parseJsonOutputLines(handlerProbe.stdout).filter(
        row => row.test_acl_candidate_handler_unlock === candidate.label
      ),
      [{
        test_acl_candidate_handler_unlock: candidate.label,
        own_granted_advisory_locks: 0
      }],
      `${candidate.label} source-gate handler must leave zero same-session holds`
    );
    assert.deepEqual(
      snapshot(),
      baseline,
      `${candidate.label} source-gate handler probe changed durable or ACL state`
    );
    assert.equal(
      advisoryLockCount(),
      0,
      `${candidate.label} source-gate handler probe leaked the advisory interlock`
    );

    const autocommitOffPath = await writeRuntimeFile(
      `${candidate.label}-autocommit-off.sql`,
      `\\set ON_ERROR_STOP 1\n` +
      `\\set AUTOCOMMIT off\n` +
      `insert into public.cnyos_acl_candidate_sentinel(value) values (701);\n` +
      `\\i ${candidate.path}\n` +
      `\\echo CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL\n`
    );
    assertFailure(
      psql(['--file', autocommitOffPath], { allowFailure: true }),
      `${candidate.label} AUTOCOMMIT=off seeded caller write`,
      /CNYOS_ACL_CANDIDATE_PSQL_AUTOCOMMIT_REQUIRED/,
      baseline
    );

    const outerTransactionPath = await writeRuntimeFile(
      `${candidate.label}-outer-transaction.sql`,
      `\\set ON_ERROR_STOP 1\n` +
      `begin;\n` +
      `insert into public.cnyos_acl_candidate_sentinel(value) values (702);\n` +
      `savepoint caller_statement;\n` +
      `\\i ${candidate.path}\n` +
      `\\echo CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL\n`
    );
    assertFailure(
      psql(['--file', outerTransactionPath], { allowFailure: true }),
      `${candidate.label} explicit outer transaction seeded caller write`,
      /CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED/,
      baseline
    );

    const singleTransactionPath = await writeRuntimeFile(
      `${candidate.label}-single-transaction.sql`,
      `\\set ON_ERROR_STOP 1\n` +
      `insert into public.cnyos_acl_candidate_sentinel(value) values (703);\n` +
      `\\i ${candidate.path}\n` +
      `\\echo CNYOS_UNREACHABLE_ACL_CANDIDATE_TAIL\n`
    );
    assertFailure(
      psql([
        '--single-transaction',
        '--file', singleTransactionPath
      ], { allowFailure: true }),
      `${candidate.label} --single-transaction seeded caller write`,
      /CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED/,
      baseline
    );
  }

  console.log(
    'ACL candidate psql E2E passed ' +
    '(PostgreSQL 17; exact inert source, seeded outer-write refusal, rollback and unlock)'
  );
} finally {
  try {
    await cleanFixture();
  } catch (error) {
    if (fixtureCreated) throw error;
  }
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
