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
  'cnyos_observer_handler_parent',
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
with bound_handler_oids(routine_oid) as (
  select trigger_definition.tgfoid
  from pg_catalog.pg_trigger trigger_definition
  where not trigger_definition.tgisinternal
  union
  select event_trigger.evtfoid
  from pg_catalog.pg_event_trigger event_trigger
),
bound_handler_language_oids(language_oid) as (
  select distinct procedure.prolang
  from bound_handler_oids bound_handler
  join pg_catalog.pg_proc procedure
    on procedure.oid = bound_handler.routine_oid
),
private_relation_oids(relation_oid) as (
  select relation.oid
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname in ('observer_private', 'observer_path')
)
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
  'bound_handler_routines', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(procedure) order by procedure.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from bound_handler_oids bound_handler
    join pg_catalog.pg_proc procedure
      on procedure.oid = bound_handler.routine_oid
  ),
  'bound_handler_dependencies', (
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
    from bound_handler_oids bound_handler
    join pg_catalog.pg_depend dependency
      on dependency.classid =
          'pg_catalog.pg_proc'::pg_catalog.regclass
     and dependency.objid = bound_handler.routine_oid
  ),
  'bound_handler_languages', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(language) order by language.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from bound_handler_language_oids bound_language
    join pg_catalog.pg_language language
      on language.oid = bound_language.language_oid
  ),
  'private_namespaces', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(namespace) order by namespace.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_namespace namespace
    where namespace.nspname in ('observer_private', 'observer_path')
  ),
  'private_relations', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(relation) order by relation.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from private_relation_oids private_relation
    join pg_catalog.pg_class relation
      on relation.oid = private_relation.relation_oid
  ),
  'private_relation_attributes', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(attribute)
        order by attribute.attrelid, attribute.attnum
      ),
      '[]'::pg_catalog.jsonb
    )
    from private_relation_oids private_relation
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = private_relation.relation_oid
  ),
  'private_relation_constraints', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(constraint_definition)
        order by constraint_definition.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from private_relation_oids private_relation
    join pg_catalog.pg_constraint constraint_definition
      on constraint_definition.conrelid = private_relation.relation_oid
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
  'application_triggers', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(trigger_definition) order by trigger_definition.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_trigger trigger_definition
    where not trigger_definition.tgisinternal
  ),
  'event_triggers', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(event_trigger) order by event_trigger.oid
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_event_trigger event_trigger
  ),
  'database_role_settings', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(role_setting)
        order by role_setting.setdatabase, role_setting.setrole
      ),
      '[]'::pg_catalog.jsonb
    )
    from pg_catalog.pg_db_role_setting role_setting
    where role_setting.setdatabase in (
      0::oid,
      (
        select database.oid
        from pg_catalog.pg_database database
        where database.datname = pg_catalog.current_database()
      )
    )
  ),
  'current_database', (
    select pg_catalog.to_jsonb(database) - 'datfrozenxid' - 'datminmxid'
    from pg_catalog.pg_database database
    where database.datname = pg_catalog.current_database()
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
      'cnyos_observer_handler_parent',
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
        'cnyos_observer_handler_parent',
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
        'cnyos_observer_handler_parent',
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
create role cnyos_observer_app_owner
  nologin noinherit nosuperuser nobypassrls;
create role cnyos_observer_handler_parent
  nologin noinherit nosuperuser nobypassrls;
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

alter role cnyos_observer_app_owner
  in database cnyos_acl_observer_e2e
  set statement_timeout = '15s';
revoke temporary on database cnyos_acl_observer_e2e from public;
grant temporary on database cnyos_acl_observer_e2e to public;

alter schema public owner to postgres;
revoke all on schema public from public;
grant usage on schema public to public;
grant usage, create on schema public to cnyos_observer_app_owner;

create extension pgcrypto with schema public;

create table public.observer_sentinel(value integer primary key);
insert into public.observer_sentinel(value) values (17), (1700);
create table public.observer_sentinel_child(
  id integer primary key,
  sentinel_value integer references public.observer_sentinel(value)
);

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

create function public.observer_money_default_probe(
  input money default 1234.56::money
)
returns money
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$ select input $function$;
alter function public.observer_money_default_probe(money)
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_money_default_probe(money)
  from public, anon, authenticated, authenticator, service_role;

create function public.observer_trigger_probe()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  return new;
end
$function$;
alter function public.observer_trigger_probe()
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_trigger_probe()
  from public, anon, authenticated, service_role;
create trigger observer_sentinel_before_update
before update of value on public.observer_sentinel
for each row when (old.value is distinct from new.value)
execute function public.observer_trigger_probe('alpha', 'beta');

create schema observer_private authorization cnyos_observer_app_owner;
revoke all on schema observer_private
  from public, anon, authenticated, authenticator, service_role;
create schema observer_path authorization cnyos_observer_app_owner;
revoke all on schema observer_path
  from public, anon, authenticated, authenticator, service_role;
create table observer_private.trigger_probe(id integer);
alter table observer_private.trigger_probe
  owner to cnyos_observer_app_owner;
create function observer_private.trigger_probe_handler()
returns trigger
language plpgsql
set search_path = pg_catalog, observer_path, pg_temp
as $function$
begin
  return new;
end
$function$;
alter function observer_private.trigger_probe_handler()
  owner to cnyos_observer_app_owner;
revoke all on function observer_private.trigger_probe_handler()
  from public, anon, authenticated, authenticator, service_role;
create trigger observer_private_before_insert
before insert on observer_private.trigger_probe
for each row execute function observer_private.trigger_probe_handler();

create function public.observer_event_trigger_probe()
returns event_trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  null;
end
$function$;
alter function public.observer_event_trigger_probe()
  owner to cnyos_observer_app_owner;
revoke all on function public.observer_event_trigger_probe()
  from public, anon, authenticated, service_role;
create event trigger observer_ddl_probe
on ddl_command_end when tag in ('CREATE TABLE')
execute function public.observer_event_trigger_probe();

create function observer_private.event_trigger_probe_handler()
returns event_trigger
language plpgsql
as $function$
begin
  null;
end
$function$;
alter function observer_private.event_trigger_probe_handler()
  owner to cnyos_observer_app_owner;
revoke all on function observer_private.event_trigger_probe_handler()
  from public, anon, authenticated, authenticator, service_role;
create event trigger observer_private_ddl_probe
on sql_drop
execute function observer_private.event_trigger_probe_handler();

revoke usage on language plpgsql from public;
grant usage on language plpgsql to public;

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

  const success = psql([
    ...observationVariables(),
    '--file', observationPath
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
set lc_monetary = 'POSIX';
set lc_numeric = 'POSIX';
set lc_time = 'POSIX';
select pg_catalog.jsonb_build_object(
  'test_hostile_output_gucs', pg_catalog.jsonb_build_object(
    'lc_monetary', pg_catalog.current_setting('lc_monetary'),
    'lc_numeric', pg_catalog.current_setting('lc_numeric'),
    'lc_time', pg_catalog.current_setting('lc_time')
  )
)::text;
\i ${observationPath}
`
  );
  const hostile = psql([
    ...observationVariables(),
    '--file', hostileWrapper
  ], {
    environment: { PGCLIENTENCODING: 'LATIN1' }
  });
  const hostileRows = parseJsonOutputLines(hostile.stdout);
  assert.equal(hostileRows.length, 2, 'hostile wrapper must emit two JSON rows');
  assert.equal(hostile.stderr, '', 'hostile observer stderr must be empty');
  const hostileSettingsRow = hostileRows.find(row =>
    row.test_hostile_output_gucs
  );
  assert.ok(hostileSettingsRow, 'hostile wrapper omitted its pre-observer GUCs');
  assert.deepEqual(
    hostileSettingsRow.test_hostile_output_gucs,
    {
      lc_monetary: 'POSIX',
      lc_numeric: 'POSIX',
      lc_time: 'POSIX'
    }
  );
  const hostileObservation = hostileRows.find(row =>
    row.status === observationStatus
  );
  assert.ok(hostileObservation, 'hostile wrapper omitted observer evidence');
  assert.deepEqual(
    hostileObservation.observation_transaction.output_gucs,
    observation.observation_transaction.output_gucs,
    'hostile session must be pinned to the baseline observer output GUCs'
  );
  assert.equal(
    hostileObservation.composite_digest.payload_sha256,
    observation.composite_digest.payload_sha256,
    'pinned output GUCs must make the hostile-locale digest deterministic'
  );
  assertNoMutationOrLock(baseline, 'successful hostile-session observation');

  const temporaryTriggerWrapper = await writeRuntimeFile(
    'temporary-trigger-observation.sql',
    String.raw`\set ON_ERROR_STOP 1
create temporary table observer_temporary_trigger_probe(id integer);
create trigger observer_temporary_before_insert
before insert on observer_temporary_trigger_probe
for each row execute function observer_private.trigger_probe_handler();
select pg_catalog.jsonb_build_object(
  'test_observer_noninternal_trigger_count', pg_catalog.count(*)
)::text
from pg_catalog.pg_trigger trigger_definition
where not trigger_definition.tgisinternal;
\i ${observationPath}
`
  );
  const temporaryTriggerRun = psql([
    ...observationVariables(),
    '--file', temporaryTriggerWrapper
  ]);
  assert.equal(
    temporaryTriggerRun.stderr,
    '',
    'temporary-trigger observer stderr must be empty'
  );
  const temporaryTriggerRows = parseJsonOutputLines(
    temporaryTriggerRun.stdout
  );
  assert.equal(
    temporaryTriggerRows.length,
    2,
    'temporary-trigger wrapper must emit its count and observer JSON'
  );
  const temporaryTriggerCountRow = temporaryTriggerRows.find(row =>
    Object.hasOwn(row, 'test_observer_noninternal_trigger_count')
  );
  const temporaryTriggerObservation = temporaryTriggerRows.find(row =>
    row.status === observationStatus
  );
  assert.ok(temporaryTriggerCountRow);
  assert.ok(temporaryTriggerObservation);
  const temporaryTriggerBindings = temporaryTriggerObservation.review_datasets[
    'trigger_bindings.all_non_internal'
  ];
  assert.equal(
    temporaryTriggerBindings.row_count,
    Number(temporaryTriggerCountRow.test_observer_noninternal_trigger_count),
    'observer and independent same-session noninternal trigger counts differ'
  );
  const temporaryTriggerBinding = temporaryTriggerBindings.review_rows.find(
    row => row.trigger_name === 'observer_temporary_before_insert'
  );
  assert.ok(temporaryTriggerBinding, 'temporary trigger binding was omitted');
  assert.equal(temporaryTriggerBinding.temporary_relation, true);
  assert.equal(temporaryTriggerBinding.relation_persistence, 't');
  assert.notEqual(
    temporaryTriggerBindings.payload_sha256,
    observation.review_datasets['trigger_bindings.all_non_internal']
      .payload_sha256,
    'temporary trigger must change the closed-world binding digest'
  );
  assertNoMutationOrLock(baseline, 'same-session temporary-trigger observation');

  assert.equal(
    observation.artifact_schema,
    'cnyos-public-routine-acl-observation/v2'
  );
  assert.equal(observation.status, observationStatus);
  assert.equal(observation.authorization, false);
  assert.equal(observation.production_eligible, false);
  assert.equal(observation.observation_transaction_rolled_back, true);
  assert.equal(observation.advisory_lock_released, true);
  assert.equal(observation.source_metadata.source_revision, sourceRevision);
  assert.equal(observation.source_metadata.project_label, projectLabel);
  assert.equal(observation.source_metadata.target_authorization_claimed, false);
  assert.equal(
    observation.observation_transaction.search_path,
    'pg_catalog, pg_temp'
  );
  assert.deepEqual(observation.observation_transaction.output_gucs, {
    bytea_output: 'hex',
    client_encoding: 'UTF8',
    datestyle: 'ISO, YMD',
    extra_float_digits: '3',
    intervalstyle: 'postgres',
    lc_monetary: 'C',
    lc_numeric: 'C',
    lc_time: 'C',
    quote_all_identifiers: 'off',
    standard_conforming_strings: 'on',
    timezone: 'UTC'
  });
  assert.ok(
    Number(observation.observed_server.server_version_num) >= 170000 &&
      Number(observation.observed_server.server_version_num) < 180000
  );
  assert.equal(
    Object.keys(observation.review_datasets).length,
    25,
    'observer v2 must expose the complete 25-dataset manifest'
  );
  assert.equal(observation.composite_digest.row_count, 25);
  assert.equal(observation.composite_digest.review_rows.length, 25);
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
    applicationSemanticDataset.review_rows.some(row =>
      row.signature === 'public.observer_money_default_probe(money)' &&
      row.arguments.includes('money') &&
      /default/i.test(row.arguments)
    ),
    'money-default fixture was not retained under pinned lc_monetary'
  );
  assert.ok(
    observation.review_datasets[
      'public_routines.extension_members.semantic'
    ].row_count > 0,
    'native extension-member routines were not observed'
  );
  const databaseRoleSettings = observation.review_datasets[
    'database_role_settings.current_database_and_global'
  ];
  assert.ok(databaseRoleSettings, 'database role-settings dataset is missing');
  assert.equal(
    databaseRoleSettings.review_rows.some(row =>
      row.database_name === databaseName &&
      row.role_name === 'cnyos_observer_app_owner' &&
      row.setconfig.includes('statement_timeout=15s')
    ),
    true,
    'database-specific owner setting was not observed'
  );
  const triggerBindings = observation.review_datasets[
    'trigger_bindings.all_non_internal'
  ];
  const independentNonInternalTriggerCount = Number(psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'select count(*) from pg_catalog.pg_trigger where not tgisinternal;'
  ]).stdout.trim());
  const independentInternalTriggerCount = Number(psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'select count(*) from pg_catalog.pg_trigger where tgisinternal;'
  ]).stdout.trim());
  assert.ok(independentInternalTriggerCount > 0, 'foreign-key fixture needs internal triggers');
  assert.equal(triggerBindings.row_count, independentNonInternalTriggerCount);
  const publicTriggerBinding = triggerBindings.review_rows.find(row =>
    row.function_signature === 'public.observer_trigger_probe()'
  );
  const privateTriggerBinding = triggerBindings.review_rows.find(row =>
    row.function_signature === 'observer_private.trigger_probe_handler()'
  );
  assert.ok(publicTriggerBinding);
  assert.ok(privateTriggerBinding, 'non-public trigger binding must be observed');
  const privateTriggerHandler =
    privateTriggerBinding.handler_semantics_and_raw_acl;
  assert.equal(
    privateTriggerHandler.row_schema,
    'cnyos-bound-trigger-handler/v1'
  );
  assert.equal(
    privateTriggerHandler.owner_name,
    'cnyos_observer_app_owner'
  );
  assert.equal(privateTriggerHandler.owner_role_security.rolsuper, false);
  assert.equal(privateTriggerHandler.owner_role_security.rolbypassrls, false);
  assert.equal(privateTriggerHandler.owner_role_security.rolinherit, false);
  const disconnectedParentNode = privateTriggerHandler.authorization_context
    .role_nodes.find(row =>
      row.role_name === 'cnyos_observer_handler_parent'
    );
  assert.ok(disconnectedParentNode);
  assert.equal(disconnectedParentNode.rolsuper, false);
  assert.equal(disconnectedParentNode.rolbypassrls, false);
  assert.deepEqual(
    privateTriggerHandler.pg_proc_catalog.proconfig,
    ['search_path=pg_catalog, observer_path, pg_temp']
  );
  assert.equal(
    privateTriggerHandler.function_local_search_path,
    'search_path=pg_catalog, observer_path, pg_temp'
  );
  assert.equal(privateTriggerHandler.function_local_search_path_absent, false);
  assert.equal(
    privateTriggerHandler.function_local_search_path_mentions_dynamic_user,
    false
  );
  assert.equal(
    privateTriggerHandler
      .function_local_search_path_mentions_session_specific_temp_schema,
    false
  );
  assert.equal(
    privateTriggerHandler.function_local_search_path_has_explicit_terminal_pg_temp,
    true
  );
  assert.equal(
    privateTriggerHandler.function_local_search_path_potentially_temp_dynamic,
    false
  );
  assert.equal(
    privateTriggerHandler.language_security.owner_name,
    'postgres'
  );
  assert.equal(
    privateTriggerHandler.language_security.pg_language_catalog.lanpltrusted,
    true
  );
  assert.equal(
    privateTriggerHandler.language_security.raw_acl.lanacl_is_null,
    false
  );
  assert.equal(
    privateTriggerHandler.language_security.raw_acl.expanded_acl_rows.some(row =>
      row.grantee_label === 'PUBLIC' && row.privilege_type === 'USAGE'
    ),
    true
  );
  assert.equal(privateTriggerHandler.raw_acl.proacl_is_null, false);
  assert.equal(
    privateTriggerHandler.raw_acl.expanded_acl_rows.some(row =>
      ['PUBLIC', 'anon', 'authenticated', 'authenticator', 'service_role']
        .includes(row.grantee_label) &&
      row.privilege_type === 'EXECUTE'
    ),
    false,
    'private trigger handler must not retain a runtime EXECUTE ACL'
  );
  assert.equal(
    privateTriggerHandler.effective_runtime_access
      .filter(row => row.role_name !== 'PUBLIC')
      .every(row => row.function_execute === false),
    true,
    'private trigger handler must not be executable by a runtime role'
  );
  assert.equal(
    privateTriggerHandler.function_schema_security.schema_name,
    'observer_private'
  );
  assert.equal(
    privateTriggerHandler.function_schema_security.owner_name,
    'cnyos_observer_app_owner'
  );
  assert.equal(
    privateTriggerHandler.function_schema_security.effective_access_all_roles
      .find(row => row.role_name === 'anon').create,
    false
  );
  assert.equal(
    privateTriggerHandler.authorization_context.membership_edges.some(row =>
      row.granted_role_name === 'cnyos_observer_handler_parent' ||
      row.member_role_name === 'cnyos_observer_app_owner'
    ),
    false,
    'private handler owner must begin disconnected from fixture memberships'
  );
  assert.equal(
    privateTriggerHandler.authorization_context
      .current_database_and_global_role_settings.some(row =>
        row.database_name === databaseName &&
        row.role_name === 'cnyos_observer_app_owner' &&
        row.setconfig.includes('statement_timeout=15s')
      ),
    true,
    'nested authorization context omitted database role settings'
  );
  const persistentSchemaSecurity = observation.review_datasets[
    'schemas.all_non_temporary.security'
  ];
  assert.equal(
    persistentSchemaSecurity.review_rows.every(row =>
      row.temporary_schema === false
    ),
    true
  );
  assert.ok(
    persistentSchemaSecurity.review_rows.some(row =>
      row.schema_name === 'observer_path'
    ),
    'cross-schema handler search-path schema was not observed'
  );
  assert.deepEqual(
    privateTriggerHandler.all_non_temporary_schema_security_digest,
    {
      row_schema: 'cnyos-all-persistent-schema-security-digest/v1',
      dataset_name: 'schemas.all_non_temporary.security',
      row_count: persistentSchemaSecurity.row_count,
      payload_bytes: persistentSchemaSecurity.payload_bytes,
      payload_sha256: persistentSchemaSecurity.payload_sha256
    }
  );
  const currentDatabaseSecurity = observation.review_datasets[
    'current_database.security'
  ];
  assert.equal(currentDatabaseSecurity.row_count, 1);
  assert.equal(
    currentDatabaseSecurity.review_rows[0].database_name,
    databaseName
  );
  assert.equal(currentDatabaseSecurity.review_rows[0].owner_name, 'postgres');
  assert.equal(
    currentDatabaseSecurity.review_rows[0].raw_acl.datacl_is_null,
    false
  );
  assert.equal(
    currentDatabaseSecurity.review_rows[0].effective_access_all_roles
      .find(row => row.role_name === 'PUBLIC').temporary,
    true
  );
  assert.deepEqual(
    privateTriggerHandler.authorization_context.current_database_security,
    currentDatabaseSecurity.review_rows[0]
  );
  assert.equal(publicTriggerBinding.relation_schema, 'public');
  assert.equal(publicTriggerBinding.relation_name, 'observer_sentinel');
  assert.equal(
    publicTriggerBinding.trigger_name,
    'observer_sentinel_before_update'
  );
  assert.equal(publicTriggerBinding.relation_persistence, 'p');
  assert.deepEqual(publicTriggerBinding.update_columns, [{ attnum: 1, name: 'value' }]);
  assert.equal(publicTriggerBinding.argument_count, 2);
  assert.equal(publicTriggerBinding.arguments_hex, '616c706861006265746100');
  assert.match(publicTriggerBinding.definition, /UPDATE OF value/i);
  assert.match(publicTriggerBinding.definition, /IS DISTINCT FROM/i);
  assert.equal(typeof publicTriggerBinding.when_expression_tree, 'string');
  assert.equal(
    triggerBindings.review_rows.every(row => row.is_internal === false),
    true
  );
  const eventTriggerBindings = observation.review_datasets[
    'event_trigger_bindings.all'
  ];
  const independentEventTriggerCount = Number(psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'select count(*) from pg_catalog.pg_event_trigger;'
  ]).stdout.trim());
  assert.equal(eventTriggerBindings.row_count, independentEventTriggerCount);
  const publicEventTriggerBinding = eventTriggerBindings.review_rows.find(row =>
    row.function_signature === 'public.observer_event_trigger_probe()'
  );
  const privateEventTriggerBinding = eventTriggerBindings.review_rows.find(row =>
    row.function_signature === 'observer_private.event_trigger_probe_handler()'
  );
  assert.ok(publicEventTriggerBinding);
  assert.ok(privateEventTriggerBinding, 'non-public event trigger must be observed');
  const privateEventHandler =
    privateEventTriggerBinding.handler_semantics_and_raw_acl;
  assert.equal(
    privateEventHandler.owner_name,
    'cnyos_observer_app_owner'
  );
  assert.equal(privateEventHandler.owner_role_security.rolsuper, false);
  assert.equal(privateEventHandler.owner_role_security.rolbypassrls, false);
  assert.equal(privateEventHandler.pg_proc_catalog.proconfig, null);
  assert.equal(privateEventHandler.function_local_search_path, null);
  assert.equal(privateEventHandler.function_local_search_path_absent, true);
  assert.equal(
    privateEventHandler.function_local_search_path_has_explicit_terminal_pg_temp,
    false
  );
  assert.equal(
    privateEventHandler.function_local_search_path_potentially_temp_dynamic,
    true
  );
  assert.equal(privateEventHandler.raw_acl.proacl_is_null, false);
  assert.equal(
    privateEventHandler.raw_acl.expanded_acl_rows.some(row =>
      ['PUBLIC', 'anon', 'authenticated', 'authenticator', 'service_role']
        .includes(row.grantee_label) &&
      row.privilege_type === 'EXECUTE'
    ),
    false,
    'private event handler must not retain a runtime EXECUTE ACL'
  );
  assert.equal(
    privateEventHandler.effective_runtime_access
      .filter(row => row.role_name !== 'PUBLIC')
      .every(row => row.function_execute === false),
    true,
    'private event handler must not be executable by a runtime role'
  );
  assert.equal(
    privateEventHandler.function_schema_security.schema_name,
    'observer_private'
  );
  assert.equal(
    publicEventTriggerBinding.event_trigger_name,
    'observer_ddl_probe'
  );
  assert.deepEqual(publicEventTriggerBinding.tags, ['CREATE TABLE']);
  assert.equal(privateEventTriggerBinding.tags, null);
  assertNoMutationOrLock(baseline, 'successful baseline observation');

  const observeCurrentState = label => {
    const result = psql([
      ...observationVariables(),
      '--file', observationPath
    ]);
    const lines = physicalOutputLines(result.stdout);
    assert.equal(lines.length, 1, `${label} must emit one observer JSON line`);
    assert.equal(result.stderr, '', `${label} observer stderr must be empty`);
    const currentObservation = JSON.parse(lines[0]);
    assert.equal(currentObservation.status, observationStatus);
    return currentObservation;
  };
  const privateTriggerHandlerRow = currentObservation =>
    currentObservation.review_datasets[
      'trigger_bindings.all_non_internal'
    ].review_rows.find(row =>
      row.trigger_name === 'observer_private_before_insert'
    ).handler_semantics_and_raw_acl;
  const privateEventHandlerRow = currentObservation =>
    currentObservation.review_datasets[
      'event_trigger_bindings.all'
    ].review_rows.find(row =>
      row.event_trigger_name === 'observer_private_ddl_probe'
    ).handler_semantics_and_raw_acl;
  const assertPrivateTriggerDrift = (currentObservation, label) => {
    assert.notEqual(
      currentObservation.review_datasets[
        'trigger_bindings.all_non_internal'
      ].payload_sha256,
      triggerBindings.payload_sha256,
      `${label} must change the trigger-binding digest`
    );
    assert.notEqual(
      currentObservation.composite_digest.payload_sha256,
      observation.composite_digest.payload_sha256,
      `${label} must change the composite digest`
    );
  };
  const assertPrivateTriggerRestored = (currentObservation, label) => {
    assert.equal(
      currentObservation.review_datasets[
        'trigger_bindings.all_non_internal'
      ].payload_sha256,
      triggerBindings.payload_sha256,
      `${label} must restore the exact trigger-binding digest`
    );
    assert.equal(
      currentObservation.composite_digest.payload_sha256,
      observation.composite_digest.payload_sha256,
      `${label} must restore the exact composite digest`
    );
    assertNoMutationOrLock(baseline, label);
  };
  const assertPrivateEventRestored = (currentObservation, label) => {
    assert.equal(
      currentObservation.review_datasets[
        'event_trigger_bindings.all'
      ].payload_sha256,
      eventTriggerBindings.payload_sha256,
      `${label} must restore the exact event-trigger digest`
    );
    assert.equal(
      currentObservation.composite_digest.payload_sha256,
      observation.composite_digest.payload_sha256,
      `${label} must restore the exact composite digest`
    );
    assertNoMutationOrLock(baseline, label);
  };

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create or replace function observer_private.trigger_probe_handler()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, observer_path, pg_temp
as $function$
begin
  perform 1;
  return new;
end
$function$;
`
  ]);
  const privateBodyDrift = observeCurrentState('private handler body drift');
  assertPrivateTriggerDrift(privateBodyDrift, 'private handler body drift');
  assert.match(
    privateTriggerHandlerRow(privateBodyDrift).pg_proc_catalog.prosrc,
    /perform 1/i
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create or replace function observer_private.trigger_probe_handler()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, observer_path, pg_temp
as $function$
begin
  return new;
end
$function$;
`
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler body restoration'),
    'private handler body restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'security definer;'
  ]);
  const privateSecurityDrift = observeCurrentState(
    'private handler security-mode drift'
  );
  assertPrivateTriggerDrift(
    privateSecurityDrift,
    'private handler security-mode drift'
  );
  assert.equal(
    privateTriggerHandlerRow(privateSecurityDrift).pg_proc_catalog.prosecdef,
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'security invoker;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler security-mode restoration'),
    'private handler security-mode restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'set search_path = public, pg_catalog;'
  ]);
  const privateSearchPathDrift = observeCurrentState(
    'private handler search_path drift'
  );
  assertPrivateTriggerDrift(
    privateSearchPathDrift,
    'private handler search_path drift'
  );
  assert.equal(
    privateTriggerHandlerRow(privateSearchPathDrift).pg_proc_catalog.proconfig
      .some(value =>
        value.startsWith('search_path=') &&
        value.includes('public') &&
        value.includes('pg_catalog')
      ),
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'set search_path = pg_catalog, observer_path, pg_temp;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler search_path restoration'),
    'private handler search_path restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'owner to cnyos_observer_handler_parent;'
  ]);
  const privateOwnerDrift = observeCurrentState('private handler owner drift');
  assertPrivateTriggerDrift(privateOwnerDrift, 'private handler owner drift');
  assert.equal(
    privateTriggerHandlerRow(privateOwnerDrift).owner_name,
    'cnyos_observer_handler_parent'
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter function observer_private.trigger_probe_handler() ' +
      'owner to cnyos_observer_app_owner;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler owner restoration'),
    'private handler owner restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'grant execute on function observer_private.trigger_probe_handler() ' +
      'to anon;'
  ]);
  const privateAclDrift = observeCurrentState('private handler ACL drift');
  assertPrivateTriggerDrift(privateAclDrift, 'private handler ACL drift');
  assert.equal(
    privateTriggerHandlerRow(privateAclDrift).raw_acl.expanded_acl_rows
      .some(row =>
        row.grantee_label === 'anon' &&
        row.privilege_type === 'EXECUTE'
      ),
    true
  );
  assert.equal(
    privateTriggerHandlerRow(privateAclDrift).effective_runtime_access
      .find(row => row.role_name === 'anon').function_execute,
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'revoke execute on function observer_private.trigger_probe_handler() ' +
      'from anon;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler ACL restoration'),
    'private handler ACL restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'grant create on schema observer_path to anon;'
  ]);
  const crossSchemaCreateDrift = observeCurrentState(
    'handler search-path cross-schema CREATE drift'
  );
  assertPrivateTriggerDrift(
    crossSchemaCreateDrift,
    'handler search-path cross-schema CREATE drift'
  );
  assert.notEqual(
    crossSchemaCreateDrift.review_datasets[
      'schemas.all_non_temporary.security'
    ].payload_sha256,
    persistentSchemaSecurity.payload_sha256,
    'cross-schema CREATE drift must change the schema dataset digest'
  );
  assert.equal(
    crossSchemaCreateDrift.review_datasets[
      'schemas.all_non_temporary.security'
    ].review_rows.find(row => row.schema_name === 'observer_path')
      .effective_access_all_roles.find(row => row.role_name === 'anon').create,
    true
  );
  assert.notEqual(
    privateTriggerHandlerRow(crossSchemaCreateDrift)
      .all_non_temporary_schema_security_digest.payload_sha256,
    privateTriggerHandler.all_non_temporary_schema_security_digest
      .payload_sha256,
    'cross-schema CREATE drift must change the embedded schema digest'
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'revoke create on schema observer_path from anon;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('handler search-path cross-schema CREATE restoration'),
    'handler search-path cross-schema CREATE restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'alter role cnyos_observer_app_owner bypassrls;'
  ]);
  const privateOwnerSecurityDrift = observeCurrentState(
    'private handler-owner BYPASSRLS drift'
  );
  assertPrivateTriggerDrift(
    privateOwnerSecurityDrift,
    'private handler-owner BYPASSRLS drift'
  );
  assert.equal(
    privateTriggerHandlerRow(privateOwnerSecurityDrift).owner_role_security
      .rolbypassrls,
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'alter role cnyos_observer_app_owner nobypassrls;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('private handler-owner BYPASSRLS restoration'),
    'private handler-owner BYPASSRLS restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'grant cnyos_observer_handler_parent ' +
      'to cnyos_observer_app_owner with inherit true, set true;'
  ]);
  const privateOwnerMembershipDrift = observeCurrentState(
    'private handler-owner disconnected membership drift'
  );
  assertPrivateTriggerDrift(
    privateOwnerMembershipDrift,
    'private handler-owner disconnected membership drift'
  );
  assert.equal(
    privateTriggerHandlerRow(privateOwnerMembershipDrift)
      .authorization_context.membership_edges.some(row =>
        row.granted_role_name === 'cnyos_observer_handler_parent' &&
        row.member_role_name === 'cnyos_observer_app_owner'
      ),
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'revoke cnyos_observer_handler_parent ' +
      'from cnyos_observer_app_owner;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState(
      'private handler-owner disconnected membership restoration'
    ),
    'private handler-owner disconnected membership restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter role authenticator ' +
      'set search_path = observer_private, pg_catalog;'
  ]);
  const databaseRoleSettingDrift = observeCurrentState(
    'ALTER ROLE setting drift'
  );
  assertPrivateTriggerDrift(databaseRoleSettingDrift, 'ALTER ROLE setting drift');
  assert.equal(
    databaseRoleSettingDrift.review_datasets[
      'database_role_settings.current_database_and_global'
    ].review_rows.some(row =>
      row.database_name === 'ALL_DATABASES' &&
      row.role_name === 'authenticator' &&
      row.setconfig.some(value =>
        value.startsWith('search_path=') &&
        value.includes('observer_private')
      )
    ),
    true
  );
  assert.equal(
    privateTriggerHandlerRow(databaseRoleSettingDrift).authorization_context
      .current_database_and_global_role_settings.some(row =>
        row.database_name === 'ALL_DATABASES' &&
        row.role_name === 'authenticator'
      ),
    true
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'alter role authenticator reset search_path;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('ALTER ROLE setting restoration'),
    'ALTER ROLE setting restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    `revoke temporary on database ${databaseName} from public;`
  ]);
  const databaseTemporaryAclDrift = observeCurrentState(
    'current-database TEMPORARY ACL drift'
  );
  assertPrivateTriggerDrift(
    databaseTemporaryAclDrift,
    'current-database TEMPORARY ACL drift'
  );
  assert.notEqual(
    databaseTemporaryAclDrift.review_datasets[
      'current_database.security'
    ].payload_sha256,
    currentDatabaseSecurity.payload_sha256,
    'TEMPORARY ACL drift must change the current-database dataset digest'
  );
  assert.equal(
    databaseTemporaryAclDrift.review_datasets[
      'current_database.security'
    ].review_rows[0].effective_access_all_roles.find(row =>
      row.role_name === 'PUBLIC'
    ).temporary,
    false
  );
  assert.equal(
    privateTriggerHandlerRow(databaseTemporaryAclDrift)
      .authorization_context.current_database_security
      .effective_access_all_roles.find(row => row.role_name === 'PUBLIC')
      .temporary,
    false
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    `grant temporary on database ${databaseName} to public;`
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('current-database TEMPORARY ACL restoration'),
    'current-database TEMPORARY ACL restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    `alter database ${databaseName} ` +
      'owner to cnyos_observer_handler_parent;'
  ]);
  const databaseOwnerDrift = observeCurrentState(
    'current-database owner drift'
  );
  assertPrivateTriggerDrift(
    databaseOwnerDrift,
    'current-database owner drift'
  );
  assert.notEqual(
    databaseOwnerDrift.review_datasets[
      'current_database.security'
    ].payload_sha256,
    currentDatabaseSecurity.payload_sha256,
    'database owner drift must change the current-database dataset digest'
  );
  assert.equal(
    databaseOwnerDrift.review_datasets[
      'current_database.security'
    ].review_rows[0].owner_name,
    'cnyos_observer_handler_parent'
  );
  assert.equal(
    privateTriggerHandlerRow(databaseOwnerDrift).authorization_context
      .current_database_security.owner_name,
    'cnyos_observer_handler_parent'
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', `alter database ${databaseName} owner to postgres;`
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('current-database owner restoration'),
    'current-database owner restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'alter language plpgsql owner to cnyos_observer_app_owner;'
  ]);
  const languageOwnerDrift = observeCurrentState(
    'handler-language owner drift'
  );
  assertPrivateTriggerDrift(languageOwnerDrift, 'handler-language owner drift');
  assert.equal(
    privateTriggerHandlerRow(languageOwnerDrift).language_security.owner_name,
    'cnyos_observer_app_owner'
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'alter language plpgsql owner to postgres;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('handler-language owner restoration'),
    'handler-language owner restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'revoke usage on language plpgsql from public;'
  ]);
  const languageAclDrift = observeCurrentState('handler-language ACL drift');
  assertPrivateTriggerDrift(languageAclDrift, 'handler-language ACL drift');
  assert.equal(
    privateTriggerHandlerRow(languageAclDrift).language_security.raw_acl
      .expanded_acl_rows.some(row =>
        row.grantee_label === 'PUBLIC' && row.privilege_type === 'USAGE'
      ),
    false
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', 'grant usage on language plpgsql to public;'
  ]);
  assertPrivateTriggerRestored(
    observeCurrentState('handler-language ACL restoration'),
    'handler-language ACL restoration'
  );

  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create or replace function observer_private.event_trigger_probe_handler()
returns event_trigger
language plpgsql
as $function$
begin
  perform 1;
  null;
end
$function$;
`
  ]);
  const privateEventBodyDrift = observeCurrentState(
    'private event-handler body drift'
  );
  assert.notEqual(
    privateEventBodyDrift.review_datasets[
      'event_trigger_bindings.all'
    ].payload_sha256,
    eventTriggerBindings.payload_sha256,
    'private event-handler body drift must change the event-trigger digest'
  );
  assert.notEqual(
    privateEventBodyDrift.composite_digest.payload_sha256,
    observation.composite_digest.payload_sha256,
    'private event-handler body drift must change the composite digest'
  );
  assert.match(
    privateEventHandlerRow(privateEventBodyDrift).pg_proc_catalog.prosrc,
    /perform 1/i
  );
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create or replace function observer_private.event_trigger_probe_handler()
returns event_trigger
language plpgsql
as $function$
begin
  null;
end
$function$;
`
  ]);
  assertPrivateEventRestored(
    observeCurrentState('private event-handler body restoration'),
    'private event-handler body restoration'
  );

  try {
    psql([
      '--set=ON_ERROR_STOP=1',
      '--command',
      'alter table public.observer_sentinel disable trigger ' +
        'observer_sentinel_before_update; ' +
        'alter event trigger observer_ddl_probe disable;'
    ]);
    const disabledBindingRun = psql([
      ...observationVariables(),
      '--file', observationPath
    ]);
    const disabledBindingLines = physicalOutputLines(disabledBindingRun.stdout);
    assert.equal(disabledBindingLines.length, 1);
    assert.equal(disabledBindingRun.stderr, '');
    const disabledBindingObservation = JSON.parse(disabledBindingLines[0]);
    assert.notEqual(
      disabledBindingObservation.review_datasets[
        'trigger_bindings.all_non_internal'
      ].payload_sha256,
      triggerBindings.payload_sha256,
      'native trigger disable must change the closed-world digest'
    );
    assert.notEqual(
      disabledBindingObservation.review_datasets[
        'event_trigger_bindings.all'
      ].payload_sha256,
      eventTriggerBindings.payload_sha256,
      'native event-trigger disable must change the closed-world digest'
    );
  } finally {
    psql([
      '--set=ON_ERROR_STOP=1',
      '--command',
      'alter table public.observer_sentinel enable trigger ' +
        'observer_sentinel_before_update; ' +
        'alter event trigger observer_ddl_probe enable;'
    ]);
  }
  const restoredBindingRun = psql([
    ...observationVariables(),
    '--file', observationPath
  ]);
  const restoredBindingLines = physicalOutputLines(restoredBindingRun.stdout);
  assert.equal(restoredBindingLines.length, 1);
  assert.equal(restoredBindingRun.stderr, '');
  const restoredBindingObservation = JSON.parse(restoredBindingLines[0]);
  assert.equal(
    restoredBindingObservation.review_datasets[
      'trigger_bindings.all_non_internal'
    ].payload_sha256,
    triggerBindings.payload_sha256
  );
  assert.equal(
    restoredBindingObservation.review_datasets[
      'event_trigger_bindings.all'
    ].payload_sha256,
    eventTriggerBindings.payload_sha256
  );
  assert.equal(
    restoredBindingObservation.composite_digest.payload_sha256,
    observation.composite_digest.payload_sha256
  );
  assertNoMutationOrLock(baseline, 'restored binding observation');

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
    String.raw`\set ON_ERROR_STOP 1
` + advisoryLockProbeSql('before') +
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
    String.raw`\set ON_ERROR_STOP 1
select pg_catalog.pg_try_advisory_lock(202608302100::bigint)
  as cnyos_test_observer_preheld
\gset
\if :cnyos_test_observer_preheld
\else
do $cnyos_test_observer_prehold_abort$
begin
  raise exception 'CNYOS_TEST_OBSERVER_PREHOLD_ACQUISITION_FAILED';
end
$cnyos_test_observer_prehold_abort$;
\endif
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
    String.raw`\set ON_ERROR_STOP 1
\set AUTOCOMMIT off
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
    String.raw`\set ON_ERROR_STOP 1
begin;
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
