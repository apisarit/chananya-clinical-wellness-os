import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-public-routine-observer-e2e-')
);
const clientImage = 'postgres:17';
const databaseHost = '127.0.0.1';
const databasePort = '5432';
const databaseUser = 'postgres';
const databasePassword = 'postgres';
const databaseName = 'cnyos_acl_observer_e2e';
const advisoryLockKey = '202608302100';
const observationStatus = 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED';
const observationPath =
  '/workspace/supabase/manual/public_routine_acl_inventory_read_only.sql';
const fixedRevision = '0123456789012345678901234567890123456789';
const sourceRevision = /^[0-9a-f]{40}$/.test(
  process.env.CNYOS_RELEASE_SHA ?? ''
)
  ? process.env.CNYOS_RELEASE_SHA
  : fixedRevision;
const projectLabel = 'postgres17-psql-e2e';
const fixtureRoles = [
  'cnyos_observer_app_owner',
  'authenticator',
  'service_role',
  'authenticated',
  'anon'
];

function dockerClientArguments(command, args, {
  detached = false,
  name,
  environment = {}
} = {}) {
  const environmentArguments = Object.entries(environment).flatMap(
    ([name, value]) => ['-e', `${name}=${value}`]
  );
  return [
    'run',
    ...(detached ? ['--detach'] : []),
    '--rm',
    '--pull', 'never',
    ...(name ? ['--name', name] : []),
    '--network', 'host',
    '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${tempDirectory},dst=/e2e,readonly`,
    '-w', '/workspace',
    '-e', `PGPASSWORD=${databasePassword}`,
    ...environmentArguments,
    clientImage, command, ...args
  ];
}

function runDockerClient(command, args, {
  allowFailure = false,
  environment = {}
} = {}) {
  const result = spawnSync('docker', dockerClientArguments(
    command,
    args,
    { environment }
  ), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  });

  if (result.error) {
    throw new Error(
      `PostgreSQL 17 psql E2E requires Docker and the ${clientImage} image: ` +
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

function advisoryLockProbeSql(phase) {
  return String.raw`
select pg_catalog.jsonb_build_object(
  'test_observer_advisory_lock_phase','${phase}',
  'own_granted_advisory_locks',pg_catalog.count(*)
)
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

function observationVariables() {
  return [
    `--set=cnyos_observation_source_revision=${sourceRevision}`,
    `--set=cnyos_observation_project_label=${projectLabel}`
  ];
}

function physicalOutputLines(value) {
  return value.split(/\r?\n/).filter(line => line.length > 0);
}

function parseJsonOutputLines(value) {
  return physicalOutputLines(value).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function assertNoObservationOutput(result, label) {
  assert.doesNotMatch(
    result.output,
    new RegExp(observationStatus),
    `${label} emitted the observation status`
  );
  assert.doesNotMatch(
    result.output,
    /"observation_transaction_rolled_back"\s*:\s*true/,
    `${label} emitted success-shaped observation evidence`
  );
  assert.equal(
    parseJsonOutputLines(result.stdout).some(row =>
      row.status === observationStatus ||
      row.observation_transaction_rolled_back === true ||
      row.advisory_lock_released === true
    ),
    false,
    `${label} emitted a parseable observation object`
  );
}

function stateSnapshot() {
  const result = psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'sentinel_rows', (
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(sentinel) order by sentinel.value),
      '[]'::pg_catalog.jsonb
    )
    from public.observer_sentinel sentinel
  ),
  'public_namespace', (
    select pg_catalog.to_jsonb(namespace)
    from pg_catalog.pg_namespace namespace
    where namespace.nspname = 'public'
  ),
  'public_routines', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(procedure) order by procedure.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  ),
  'public_routine_dependencies', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(dependency)
        order by dependency.classid,
          dependency.objid,
          dependency.objsubid,
          dependency.refclassid,
          dependency.refobjid,
          dependency.refobjsubid,
          dependency.deptype
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_depend dependency
    join pg_catalog.pg_proc procedure
      on dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     and dependency.objid = procedure.oid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  ),
  'default_acls', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(default_acl) order by default_acl.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_default_acl default_acl
  ),
  'fixture_roles', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(role_row) - 'rolpassword'
        order by role_row.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_authid role_row
    where role_row.rolname in (
      'anon',
      'authenticated',
      'service_role',
      'authenticator',
      'cnyos_observer_app_owner'
    )
  ),
  'fixture_memberships', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(membership)
        order by membership.roleid, membership.member, membership.grantor
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_auth_members membership
    where membership.roleid in (
      select role_row.oid
      from pg_catalog.pg_authid role_row
      where role_row.rolname in (
        'anon',
        'authenticated',
        'service_role',
        'authenticator',
        'cnyos_observer_app_owner'
      )
    )
    or membership.member in (
      select role_row.oid
      from pg_catalog.pg_authid role_row
      where role_row.rolname in (
        'anon',
        'authenticated',
        'service_role',
        'authenticator',
        'cnyos_observer_app_owner'
      )
    )
  )
)::text;
`
  ]);
  const lines = physicalOutputLines(result.stdout);
  assert.equal(lines.length, 1, 'state snapshot must be one JSON row');
  return JSON.parse(lines[0]);
}

function advisoryLockCount() {
  const result = psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.count(*)::text
from pg_catalog.pg_locks lock_row
where lock_row.locktype = 'advisory'
  and lock_row.classid::bigint = (${advisoryLockKey}::bigint >> 32)
  and lock_row.objid::bigint =
      (${advisoryLockKey}::bigint & 4294967295::bigint)
  and lock_row.objsubid = 1
  and lock_row.granted;
`
  ]);
  return Number(result.stdout.trim());
}

async function waitForAdvisoryLockCount(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = -1;
  while (Date.now() < deadline) {
    observed = advisoryLockCount();
    if (observed === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for observer advisory-lock count ${expected}; ` +
      `observed ${observed}`
  );
}

function startExternalLockHolder() {
  const name = `cnyos-observer-lock-${process.pid}-${Date.now()}`;
  const result = spawnSync(
    'docker',
    dockerClientArguments(
      'psql',
      [
        '-X', '-q',
        '-h', databaseHost,
        '-p', databasePort,
        '-U', databaseUser,
        '-d', databaseName,
        '--set=ON_ERROR_STOP=1',
        '--command',
        `select pg_catalog.pg_advisory_lock(${advisoryLockKey}::bigint); ` +
          'select pg_catalog.pg_sleep(60);'
      ],
      { detached: true, name }
    ),
    { cwd: root, encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `failed to start observer lock holder: ${result.error?.message || result.stderr}`
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
      `failed to stop observer lock holder: ${result.error?.message || output}`
    );
  }
}

function assertNoMutationOrLock(baseline, label) {
  assert.deepEqual(
    stateSnapshot(),
    baseline,
    `${label} changed database or ACL catalog state`
  );
  assert.equal(advisoryLockCount(), 0, `${label} leaked the observer advisory lock`);
}

function assertRefusal(result, label, expectedError, baseline) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expectedError, `${label} did not reach its refusal`);
  assertNoObservationOutput(result, label);
  assertNoMutationOrLock(baseline, label);
}

async function cleanFixture() {
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `drop database if exists ${databaseName} with (force);`
  ]);
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `drop role if exists ${fixtureRoles.join(', ')};`
  ]);
}

async function createFixture() {
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create role anon nologin;
create role authenticated nologin;
alter role authenticated valid until '2035-07-08 09:10:11+07';
create role service_role nologin bypassrls;
create role authenticator nologin noinherit;
create role cnyos_observer_app_owner nologin;
grant anon, authenticated to authenticator;
`
  ]);
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `create database ${databaseName} owner ${databaseUser};`
  ]);

  const fixturePath = await writeRuntimeFile('fixture.sql', String.raw`
\set ON_ERROR_STOP 1
set search_path = pg_catalog, pg_temp;

alter schema public owner to postgres;
revoke all on schema public from public;
grant usage on schema public to public;
grant usage, create on schema public to cnyos_observer_app_owner;

create extension pgcrypto with schema public;

create table public.observer_sentinel(value integer primary key);
insert into public.observer_sentinel(value) values (17), (1700);

create function public.observer_app_probe(input integer)
returns integer
language sql
immutable
strict
parallel safe
cost 5
set search_path = pg_catalog
as $function$ select input + 1 $function$;
alter function public.observer_app_probe(integer)
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_app_probe(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.observer_app_probe(integer)
  to authenticated;

create function public.observer_public_probe()
returns text
language sql
stable
set search_path = pg_catalog
as $function$ select 'public-probe'::text $function$;
alter function public.observer_public_probe()
  owner to cnyos_observer_app_owner;

create function public.observer_security_definer_probe()
returns text
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$ select 'security-definer-probe'::text $function$;
alter function public.observer_security_definer_probe()
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_security_definer_probe()
  from public, anon, authenticated, service_role;
grant execute on function public.observer_security_definer_probe()
  to service_role;

create function public.observer_unicode_probe()
returns text
language sql
stable
set search_path = pg_catalog
as $function$ select 'ภาษาไทย'::text $function$;
alter function public.observer_unicode_probe()
  owner to cnyos_observer_app_owner;

create function public.observer_cost_rows_probe()
returns setof integer
language sql
immutable
cost 123.456
rows 789.125
set search_path = pg_catalog
as $function$ values (1), (2) $function$;
alter function public.observer_cost_rows_probe()
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_cost_rows_probe()
  from public, anon, authenticated, service_role;
grant execute on function public.observer_cost_rows_probe()
  to anon;

alter default privileges for role cnyos_observer_app_owner
  revoke execute on functions from public;
alter default privileges for role cnyos_observer_app_owner in schema public
  grant execute on functions to authenticated;
`);
  psql(['--file', fixturePath]);
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
    `native observer E2E requires PostgreSQL 17, got ${version}`
  );

  const baseline = stateSnapshot();
  assert.equal(advisoryLockCount(), 0, 'fixture must not start with the observer lock held');

  const metadataRefusals = [
    {
      label: 'missing source revision',
      variables: [`--set=cnyos_observation_project_label=${projectLabel}`],
      expected: /CNYOS_PUBLIC_ROUTINE_OBSERVATION_SOURCE_REVISION_REQUIRED/
    },
    {
      label: 'missing project label',
      variables: [`--set=cnyos_observation_source_revision=${sourceRevision}`],
      expected: /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PROJECT_LABEL_REQUIRED/
    },
    {
      label: 'malformed source revision',
      variables: [
        '--set=cnyos_observation_source_revision=not-a-commit',
        `--set=cnyos_observation_project_label=${projectLabel}`
      ],
      expected: /CNYOS_PUBLIC_ROUTINE_OBSERVATION_METADATA_INVALID/
    },
    {
      label: 'malformed project label',
      variables: [
        `--set=cnyos_observation_source_revision=${sourceRevision}`,
        '--set=cnyos_observation_project_label=invalid/label'
      ],
      expected: /CNYOS_PUBLIC_ROUTINE_OBSERVATION_METADATA_INVALID/
    }
  ];
  for (const testCase of metadataRefusals) {
    assertRefusal(
      psql([
        ...testCase.variables,
        '--file', observationPath
      ], { allowFailure: true }),
      testCase.label,
      testCase.expected,
      baseline
    );
  }

  const hostileWrapper = await writeRuntimeFile(
    'hostile-observation.sql',
    String.raw`\set ON_ERROR_STOP 1
set timezone = 'Asia/Bangkok';
set quote_all_identifiers = on;
set standard_conforming_strings = off;
set extra_float_digits = -15;
set datestyle = 'German, DMY';
set intervalstyle = 'sql_standard';
set bytea_output = 'escape';
\i ${observationPath}
`
  );
  const success = psql([
    ...observationVariables(),
    '--file', hostileWrapper
  ], {
    environment: { PGCLIENTENCODING: 'LATIN1' }
  });
  const successLines = physicalOutputLines(success.stdout);
  assert.equal(successLines.length, 1, 'observer must emit one physical stdout line');
  assert.match(
    success.stdout,
    /^[^\r\n]+\n$/,
    'observer stdout must be exactly one JSON line followed by one LF'
  );
  assert.equal(success.stderr, '', 'successful observer stderr must be empty');

  const observation = JSON.parse(successLines[0]);
  assert.equal(observation.status, observationStatus);
  assert.equal(observation.authorization, false);
  assert.equal(observation.production_eligible, false);
  assert.equal(observation.observation_transaction_rolled_back, true);
  assert.equal(observation.advisory_lock_released, true);
  assert.equal(observation.source_metadata.source_revision, sourceRevision);
  assert.equal(observation.source_metadata.project_label, projectLabel);
  assert.equal(observation.source_metadata.target_authorization_claimed, false);
  assert.deepEqual(observation.observation_transaction.output_gucs, {
    bytea_output: 'hex',
    client_encoding: 'UTF8',
    datestyle: 'ISO, YMD',
    extra_float_digits: '3',
    intervalstyle: 'postgres',
    quote_all_identifiers: 'off',
    standard_conforming_strings: 'on',
    timezone: 'UTC'
  });
  assert.ok(
    Number(observation.observed_server.server_version_num) >= 170000 &&
      Number(observation.observed_server.server_version_num) < 180000
  );
  const applicationSemanticDataset = observation.review_datasets[
    'public_routines.non_extension_application.semantic'
  ];
  assert.ok(
    applicationSemanticDataset.row_count >= 5,
    'native fixture application routines were not observed'
  );
  assert.ok(
    applicationSemanticDataset.review_rows.some(row =>
      row.signature === 'public.observer_unicode_probe()' &&
      row.function_definition.includes('ภาษาไทย')
    ),
    'UTF-8 function text was not retained in the observation'
  );
  assert.ok(
    observation.review_datasets[
      'public_routines.extension_members.semantic'
    ].row_count > 0,
    'native extension-member routines were not observed'
  );
  assertNoMutationOrLock(baseline, 'successful hostile-session observation');

  const observationSource = await fs.readFile(
    path.join(root, 'supabase', 'manual', 'public_routine_acl_inventory_read_only.sql'),
    'utf8'
  );
  const acquisitionNeedle =
    '\\if :cnyos_observation_lock_acquired\n' +
    '\\else\n';
  const injectedPostAcquisitionFailure = replaceExact(
    observationSource,
    acquisitionNeedle,
    '\\if :cnyos_observation_lock_acquired\n' +
      advisoryLockProbeSql('failure-held') +
      'do $cnyos_test_observer_post_acquisition_failure$\n' +
      'begin\n' +
      "  raise exception 'CNYOS_TEST_OBSERVER_POST_ACQUISITION_FAILURE';\n" +
      'end\n' +
      '$cnyos_test_observer_post_acquisition_failure$;\n' +
      '\\else\n',
    1,
    'observer post-acquisition failure injection'
  );
  const injectedPostAcquisitionFailurePath = await writeRuntimeFile(
    'injected-post-acquisition-failure.sql',
    injectedPostAcquisitionFailure
  );
  const injectedFailure = psql([
    ...observationVariables(),
    '--file', injectedPostAcquisitionFailurePath
  ], { allowFailure: true });
  assertRefusal(
    injectedFailure,
    'injected failure immediately after observer lock acquisition',
    /CNYOS_TEST_OBSERVER_POST_ACQUISITION_FAILURE/,
    baseline
  );
  assert.deepEqual(
    parseJsonOutputLines(injectedFailure.stdout).filter(
      row => row.test_observer_advisory_lock_phase === 'failure-held'
    ),
    [{
      test_observer_advisory_lock_phase: 'failure-held',
      own_granted_advisory_locks: 1
    }],
    'injected failure must occur after one observer-owned lock is acquired'
  );

  const lifecycleObservation = replaceExact(
    observationSource,
    acquisitionNeedle,
    '\\if :cnyos_observation_lock_acquired\n' +
      advisoryLockProbeSql('held') +
      '\\else\n',
    1,
    'observer held-lock lifecycle probe'
  );
  const lifecycleObservationPath = await writeRuntimeFile(
    'instrumented-observation.sql',
    lifecycleObservation
  );
  const lifecycleWrapperPath = await writeRuntimeFile(
    'instrumented-observation-wrapper.sql',
    advisoryLockProbeSql('before') +
      `\\i ${lifecycleObservationPath}\n` +
      advisoryLockProbeSql('after')
  );
  const lifecycle = psql([
    ...observationVariables(),
    '--file', lifecycleWrapperPath
  ]);
  const lifecycleRows = parseJsonOutputLines(lifecycle.stdout);
  assert.deepEqual(
    lifecycleRows
      .filter(row => row.test_observer_advisory_lock_phase)
      .map(row => [
        row.test_observer_advisory_lock_phase,
        row.own_granted_advisory_locks
      ]),
    [
      ['before', 0],
      ['held', 1],
      ['after', 0]
    ],
    'observer advisory-lock lifecycle must be 0 -> 1 -> 0 in one psql session'
  );
  assert.equal(
    lifecycleRows.filter(row => row.status === observationStatus).length,
    1,
    'instrumented lifecycle must retain exactly one observer evidence object'
  );
  assert.equal(lifecycle.stderr, '', 'observer lifecycle stderr must be empty');
  assertNoMutationOrLock(baseline, 'instrumented observer lock lifecycle');

  const preheldWrapperPath = await writeRuntimeFile(
    'preheld-observer-lock.sql',
    String.raw`select true as cnyos_test_observer_preheld
from (select pg_catalog.pg_advisory_lock(202608302100::bigint)) held
\gset
\i ${observationPath}
\echo CNYOS_UNREACHABLE_OBSERVER_PREHELD_TAIL
`
  );
  const preheld = psql([
    ...observationVariables(),
    '--file', preheldWrapperPath
  ], { allowFailure: true });
  assertRefusal(
    preheld,
    'same-session pre-held observer advisory key',
    /CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_INTERLOCK_ALREADY_HELD/,
    baseline
  );
  assert.doesNotMatch(
    preheld.output,
    /CNYOS_UNREACHABLE_OBSERVER_PREHELD_TAIL/,
    'observer continued after same-session pre-held-key refusal'
  );

  const holderName = startExternalLockHolder();
  try {
    await waitForAdvisoryLockCount(1);
    const contentionStartedAt = Date.now();
    const contention = psql([
      ...observationVariables(),
      '--file', observationPath
    ], { allowFailure: true });
    const contentionElapsedMs = Date.now() - contentionStartedAt;
    assert.notEqual(contention.status, 0, 'contended observer unexpectedly succeeded');
    assert.match(
      contention.output,
      /CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_INTERLOCK_BUSY/,
      'contended observer missed its BUSY refusal'
    );
    assertNoObservationOutput(contention, 'cross-session advisory-lock contention');
    assert.ok(
      contentionElapsedMs < 10_000,
      `contended observer waited ${contentionElapsedMs}ms instead of refusing promptly`
    );
    assert.deepEqual(
      stateSnapshot(),
      baseline,
      'contended observer changed database or ACL catalog state'
    );
    assert.equal(
      advisoryLockCount(),
      1,
      'contended observer disturbed the external holder lock'
    );
  } finally {
    stopExternalLockHolder(holderName);
  }
  await waitForAdvisoryLockCount(0);
  assertNoMutationOrLock(baseline, 'cross-session advisory-lock contention cleanup');

  const autocommitOffWrapper = await writeRuntimeFile(
    'autocommit-off.sql',
    String.raw`\set AUTOCOMMIT off
\i ${observationPath}
`
  );
  assertRefusal(
    psql([
      ...observationVariables(),
      '--file', autocommitOffWrapper
    ], { allowFailure: true }),
    'AUTOCOMMIT=off include',
    /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_AUTOCOMMIT_REQUIRED/,
    baseline
  );

  const outerTransactionWrapper = await writeRuntimeFile(
    'outer-transaction.sql',
    String.raw`begin;
\i ${observationPath}
`
  );
  assertRefusal(
    psql([
      ...observationVariables(),
      '--file', outerTransactionWrapper
    ], { allowFailure: true }),
    'outer BEGIN include',
    /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_EXISTING_TRANSACTION_REFUSED/,
    baseline
  );

  assertRefusal(
    psql([
      '--single-transaction',
      ...observationVariables(),
      '--file', observationPath
    ], { allowFailure: true }),
    '--single-transaction execution',
    /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_EXISTING_TRANSACTION_REFUSED/,
    baseline
  );

  console.log(
    'public routine ACL observer psql E2E passed ' +
    '(PostgreSQL 17; exact output, rollback, unlock, refusal, and no-mutation contracts)'
  );
} finally {
  if (fixtureCreated) {
    await cleanFixture();
  } else {
    try {
      await cleanFixture();
    } catch {
      // Preserve the original setup failure; the isolated fixture names are
      // cleaned by the fresh CI PostgreSQL service when the job exits.
    }
  }
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
