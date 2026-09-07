import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANANYA_ACL_REHEARSAL_PROFILE,
  buildPublicRoutineAclStateSnapshotSql,
  sha256
} from '../scripts/generate-public-routine-acl-rollback-rehearsal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-acl-rollback-rehearsal-e2e-')
);
const databaseName = `cnyos_acl_rollback_${randomUUID().replaceAll('-', '')}`;
const databaseHost = process.env.CNYOS_PGHOST || '127.0.0.1';
const databasePort = process.env.CNYOS_PGPORT || '5432';
const databaseUser = process.env.CNYOS_PGUSER || 'postgres';
const databasePassword = process.env.CNYOS_PGPASSWORD || 'postgres';
const clientImage = 'postgres:17';
const nativeBinSetting = process.env.CNYOS_PSQL_BIN || '';
const nativePsql = nativeBinSetting
  ? (path.basename(nativeBinSetting) === 'psql'
      ? nativeBinSetting
      : path.join(nativeBinSetting, 'psql'))
  : '';
const disposableAcknowledgement =
  'I_ACKNOWLEDGE_DISPOSABLE_LOOPBACK_POSTGRESQL_17';
if (process.env.CNYOS_PG17_DISPOSABLE_ACK !== disposableAcknowledgement) {
  throw new Error(
    `Set CNYOS_PG17_DISPOSABLE_ACK=${disposableAcknowledgement}`
  );
}
if ((nativePsql && !path.isAbsolute(nativePsql)) || databaseHost !== '127.0.0.1' ||
    !/^\d{4,5}$/.test(databasePort) || Number(databasePort) > 65535 ||
    databaseUser !== 'postgres') {
  throw new Error(
    'ACL rollback E2E requires absolute psql (when set), 127.0.0.1, explicit port, postgres'
  );
}
if (/[\r\n\0]/u.test(databasePassword)) {
  throw new Error('CNYOS_PGPASSWORD contains an unsupported control character');
}
const escapePgpassField = value => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll(':', '\\:');
const passfilePath = path.join(temporaryDirectory, 'pgpass');
await fs.writeFile(
  passfilePath,
  `${escapePgpassField(databaseHost)}:${escapePgpassField(databasePort)}:*:` +
    `${escapePgpassField(databaseUser)}:${escapePgpassField(databasePassword)}\n`,
  { mode: 0o600, flag: 'wx' }
);
await fs.chmod(passfilePath, 0o600);
let databaseCreated = false;

function runPsql(args, {
  database = databaseName,
  allowFailure = false,
  readOnlyDefault = false
} = {}) {
  const common = [
    '-X', '--quiet', '--no-align', '--tuples-only', '--no-password',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', database,
    ...args
  ];
  const executable = nativePsql || 'docker';
  const executableArguments = nativePsql ? common : [
    'run', '--rm', '--pull', 'never', '--network', 'host',
    '--mount', `type=bind,src=${temporaryDirectory},dst=/e2e,readonly`,
    '-e', 'PGPASSFILE=/e2e/pgpass',
    '-e', 'PGAPPNAME=cnyos-acl-rollback-rehearsal-native-e2e',
    ...(readOnlyDefault
      ? ['-e', 'PGOPTIONS=-c default_transaction_read_only=on']
      : []),
    clientImage, 'psql', ...common
  ];
  const result = spawnSync(executable, executableArguments, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      LANG: process.env.LANG || 'C',
      PATH: process.env.PATH || '/usr/bin:/bin',
      PGPASSFILE: passfilePath,
      PGAPPNAME: 'cnyos-acl-rollback-rehearsal-native-e2e',
      PGCONNECT_TIMEOUT: '3',
      ...(readOnlyDefault
        ? { PGOPTIONS: '-c default_transaction_read_only=on' }
        : {})
    }
  });
  if (result.error) {
    throw new Error(
      `ACL rollback rehearsal native E2E requires ${nativePsql || clientImage}: ` +
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
    throw new Error(`psql failed with ${completed.status}:\n${completed.output}`);
  }
  return completed;
}

async function writeSql(name, source) {
  const hostPath = path.join(temporaryDirectory, name);
  await fs.writeFile(hostPath, source, { mode: 0o600 });
  return nativePsql ? hostPath : `/e2e/${name}`;
}

function parseSingleJson(stdout, label) {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `${label} must emit exactly one JSON row`);
  return JSON.parse(lines[0]);
}

function stateHash(snapshot) {
  return sha256(Buffer.from(JSON.stringify(snapshot.state), 'utf8'));
}

function baselineDetails() {
  return JSON.parse(runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'system_identifier',(
    select system_identifier::text from pg_catalog.pg_control_system()
  ),
  'public_routine_count',(
    select count(*)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
  ),
  'security_definer_count',(
    select count(*)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid=procedure.pronamespace
    where namespace.nspname='public' and procedure.prosecdef
  ),
  'trigger_count',(
    select count(*) from pg_catalog.pg_trigger where not tgisinternal
  ),
  'event_trigger_count',(
    select count(*) from pg_catalog.pg_event_trigger
  )
)::text;
`
  ]).stdout.trim());
}

const successProgram = String.raw`\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
select case when current_setting('transaction_read_only')='on'
  then true else public.cnyos_acl_rehearsal_startup_read_only_required() end
\gset
set session characteristics as transaction read only;
begin isolation level repeatable read read write;
do $fixture$
begin
  if current_setting('transaction_read_only')<>'off'
     or current_setting('transaction_isolation')<>'repeatable read' then
    raise exception 'CNYOS_TEST_REHEARSAL_TRANSACTION_GUARANTEE_INVALID';
  end if;
end
$fixture$;
revoke all privileges on function public.cnyos_acl_rehearsal_rpc(integer)
  from public;
alter function public.cnyos_acl_rehearsal_trigger()
  set search_path to pg_catalog,public,pg_temp;
\set cnyos_test_explicit_rollback_reached 1
rollback;
\if :{?cnyos_test_explicit_rollback_reached}
select pg_catalog.jsonb_build_object(
  'status','CNYOS_TEST_REHEARSAL_ROLLED_BACK',
  'transaction_read_only',current_setting('transaction_read_only'),
  'commit_allowed',false
)::text;
\else
do $$ begin raise exception 'CNYOS_TEST_REHEARSAL_ROLLBACK_NOT_REACHED'; end $$;
\endif
`;

const injectedFailureProgram = String.raw`\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
select case when current_setting('transaction_read_only')='on'
  then true else public.cnyos_acl_rehearsal_startup_read_only_required() end
\gset
set session characteristics as transaction read only;
begin isolation level repeatable read read write;
revoke all privileges on function public.cnyos_acl_rehearsal_rpc(integer)
  from public;
alter function public.cnyos_acl_rehearsal_trigger()
  set search_path to pg_catalog,public,pg_temp;
do $$
begin
  raise exception 'CNYOS_TEST_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION';
end
$$;
rollback;
`;

assert.doesNotMatch(successProgram, /^\s*commit\s*;/imu);
assert.doesNotMatch(injectedFailureProgram, /^\s*commit\s*;/imu);
assert.match(successProgram, /begin isolation level repeatable read read write;/i);
assert.match(injectedFailureProgram, /begin isolation level repeatable read read write;/i);
assert.ok(
  successProgram.lastIndexOf('rollback;') > successProgram.indexOf('revoke all privileges')
);
assert.ok(
  injectedFailureProgram.lastIndexOf('rollback;') >
    injectedFailureProgram.indexOf('CNYOS_TEST_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION')
);

try {
  const serverProbe = parseSingleJson(runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'server_version_num',current_setting('server_version_num'),
  'server_address',pg_catalog.host(pg_catalog.inet_server_addr()),
  'ssl',coalesce((select ssl from pg_catalog.pg_stat_ssl
                  where pid=pg_catalog.pg_backend_pid()),false),
  'database',current_database(),
  'session_user',session_user,
  'application_name',current_setting('application_name')
)::text;
`
  ], { database: 'template1' }).stdout, 'disposable server probe');
  const version = Number(serverProbe.server_version_num);
  assert.ok(
    version >= 170000 && version < 180000,
    `ACL rollback rehearsal native E2E requires PostgreSQL 17, got ${version}`
  );
  const { server_address: serverAddress, ...serverIdentity } = serverProbe;
  assert.match(
    serverAddress,
    /^(?:127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/,
    'disposable server must report loopback or an RFC1918 container address'
  );
  assert.deepEqual(serverIdentity, {
    ssl: false,
    database: 'template1',
    session_user: 'postgres',
    application_name: 'cnyos-acl-rollback-rehearsal-native-e2e',
    server_version_num: String(version)
  });
  runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `create database ${databaseName};`
  ], { database: 'template1' });
  databaseCreated = true;
  runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create table public.clinics(
  id uuid primary key,
  code text not null,
  active boolean not null
);
insert into public.clinics(id,code,active)
values('00000000-0000-4000-8000-00000000a001','CHANANYA-STG',true);
create table public.cnyos_acl_rehearsal_rows(value integer not null);
insert into public.cnyos_acl_rehearsal_rows values(10);
create function public.cnyos_acl_rehearsal_startup_read_only_required()
returns boolean
language plpgsql
as $function$
begin
  raise exception 'CNYOS_TEST_REHEARSAL_STARTUP_READ_ONLY_REQUIRED';
end
$function$;
create function public.cnyos_acl_rehearsal_rpc(p_value integer)
returns integer
language sql
set search_path=public
as 'select p_value + 1';
create function public.cnyos_acl_rehearsal_trigger()
returns trigger
language plpgsql
security definer
set search_path=public
as $function$
begin
  new.value := new.value + 1;
  return new;
end
$function$;
create trigger cnyos_acl_rehearsal_trigger
before insert on public.cnyos_acl_rehearsal_rows
for each row execute function public.cnyos_acl_rehearsal_trigger();
`
  ]);

  const baseline = baselineDetails();
  const profile = {
    ...CHANANYA_ACL_REHEARSAL_PROFILE,
    projectLabel: 'local-native-e2e',
    projectRef: 'local-native-e2e',
    deploymentId: 'local-native-e2e',
    systemIdentifier: baseline.system_identifier,
    databaseName,
    databaseUser,
    clinicId: '00000000-0000-4000-8000-00000000a001',
    clinicCode: 'CHANANYA-STG',
    applicationName: 'cnyos-acl-rollback-rehearsal-native-e2e',
    directHostAddress: '127.0.0.1',
    requireSsl: false,
    publicRoutineCount: Number(baseline.public_routine_count),
    securityDefinerCount: Number(baseline.security_definer_count),
    triggerCount: Number(baseline.trigger_count),
    eventTriggerCount: Number(baseline.event_trigger_count)
  };
  const snapshotPath = await writeSql(
    'state-snapshot.sql',
    buildPublicRoutineAclStateSnapshotSql({ profile, requireSsl: false })
  );
  const successPath = await writeSql('success.sql', successProgram);
  const failurePath = await writeSql('failure.sql', injectedFailureProgram);
  const before = parseSingleJson(
    runPsql(
      ['--set=AUTOCOMMIT=on', '--file', snapshotPath],
      { readOnlyDefault: true }
    ).stdout,
    'pre-rehearsal snapshot'
  );

  const success = runPsql([
    '--set=ON_ERROR_STOP=1', '--set=AUTOCOMMIT=on', '--file', successPath
  ], { readOnlyDefault: true });
  const successReceipt = parseSingleJson(success.stdout, 'success rehearsal');
  assert.deepEqual(successReceipt, {
    status: 'CNYOS_TEST_REHEARSAL_ROLLED_BACK',
    commit_allowed: false,
    transaction_read_only: 'on'
  });
  const afterSuccess = parseSingleJson(
    runPsql(
      ['--set=AUTOCOMMIT=on', '--file', snapshotPath],
      { readOnlyDefault: true }
    ).stdout,
    'post-success snapshot'
  );
  assert.equal(stateHash(afterSuccess), stateHash(before));
  assert.equal(runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'public_execute',pg_catalog.has_function_privilege(
    'public.cnyos_acl_rehearsal_rpc(integer)'::regprocedure,'EXECUTE'
  ),
  'trigger_config',(
    select proconfig from pg_catalog.pg_proc
    where oid='public.cnyos_acl_rehearsal_trigger()'::regprocedure
  )
)::text;
`
  ]).stdout.trim(), '{"public_execute": true, "trigger_config": ["search_path=public"]}');

  const injectedFailure = runPsql([
    '--set=ON_ERROR_STOP=1', '--set=AUTOCOMMIT=on', '--file', failurePath
  ], { allowFailure: true, readOnlyDefault: true });
  assert.equal(injectedFailure.status, 3);
  assert.match(
    injectedFailure.output,
    /CNYOS_TEST_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION/
  );
  const afterFailure = parseSingleJson(
    runPsql(
      ['--set=AUTOCOMMIT=on', '--file', snapshotPath],
      { readOnlyDefault: true }
    ).stdout,
    'post-failure snapshot'
  );
  assert.equal(stateHash(afterFailure), stateHash(before));
  assert.equal(
    sha256(Buffer.from(success.stdout, 'utf8')).length,
    64,
    'success transcript SHA-256 was not captured'
  );
  assert.equal(
    sha256(Buffer.from(injectedFailure.stderr, 'utf8')).length,
    64,
    'failure stderr SHA-256 was not captured'
  );

  console.log(
    'public-routine ACL rollback rehearsal native PostgreSQL 17 E2E passed ' +
    '(isolated toy fixture; outside-session read-only; explicit success ' +
    'ROLLBACK; injected failure connection abort; independent before/after ' +
    'ACL-catalog hashes; no COMMIT)'
  );
} finally {
  try {
    if (databaseCreated) {
      runPsql([
        '--set=ON_ERROR_STOP=1',
        '--command', `drop database ${databaseName};`
      ], { database: 'template1', allowFailure: true });
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
