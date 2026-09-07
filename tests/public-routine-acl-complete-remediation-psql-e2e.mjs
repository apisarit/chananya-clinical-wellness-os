import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientImage = 'postgres:17';
const nativeBinSetting = process.env.CNYOS_PSQL_BIN || '';
const nativePsql = nativeBinSetting
  ? (path.basename(nativeBinSetting) === 'psql'
      ? nativeBinSetting
      : path.join(nativeBinSetting, 'psql'))
  : '';
const databaseHost = process.env.CNYOS_PGHOST || '127.0.0.1';
const databasePort = process.env.CNYOS_PGPORT || '5432';
const databaseUser = process.env.CNYOS_PGUSER || 'postgres';
const databasePassword = process.env.CNYOS_PGPASSWORD || 'postgres';
const hostedExecutorPassword =
  `cnyos_e2e_${randomUUID().replaceAll('-', '')}`;
const disposableAcknowledgement =
  'I_ACKNOWLEDGE_DISPOSABLE_LOOPBACK_POSTGRESQL_17';
if (process.env.CNYOS_PG17_DISPOSABLE_ACK !== disposableAcknowledgement) {
  throw new Error(
    `Set CNYOS_PG17_DISPOSABLE_ACK=${disposableAcknowledgement}`
  );
}
if ((nativePsql && !path.isAbsolute(nativePsql)) ||
    databaseHost !== '127.0.0.1' ||
    !/^\d{4,5}$/.test(databasePort) || Number(databasePort) > 65535 ||
    databaseUser !== 'postgres') {
  throw new Error(
    'complete ACL E2E requires absolute psql (when set), 127.0.0.1, explicit port, postgres'
  );
}
if (/[\r\n\0]/u.test(databasePassword)) {
  throw new Error('CNYOS_PGPASSWORD contains an unsupported control character');
}
const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-complete-acl-psql-e2e-')
);
const escapePgpassField = value => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll(':', '\\:');
const passfilePath = path.join(temporaryDirectory, 'pgpass');
await fs.writeFile(
  passfilePath,
  `${escapePgpassField(databaseHost)}:${escapePgpassField(databasePort)}:*:` +
    `${escapePgpassField(databaseUser)}:${escapePgpassField(databasePassword)}\n` +
    `${escapePgpassField(databaseHost)}:${escapePgpassField(databasePort)}:*:` +
    `cnyos_hosted_executor:${escapePgpassField(hostedExecutorPassword)}\n`,
  { mode: 0o600, flag: 'wx' }
);
await fs.chmod(passfilePath, 0o600);
const databaseName =
  `cnyos_complete_acl_e2e_${randomUUID().replaceAll('-', '')}`;
const candidateHostPath = path.join(
  root,
  'supabase',
  'manual',
  '202609080900_close_complete_public_routine_acl_candidate.sql'
);
const candidateClientPath = nativePsql
  ? candidateHostPath
  : '/workspace/supabase/manual/202609080900_close_complete_public_routine_acl_candidate.sql';
const runtimeRoles = ['anon', 'authenticated', 'service_role'];
const privilegedHandlers = [
  'public.apply_stock_movement()',
  'public.handle_new_user()'
];
let databaseCreated = false;
let fixtureRolesCreated = false;

function runPsqlClient(command, args, { allowFailure = false } = {}) {
  assert.equal(command, 'psql', 'native/Docker harness only supports psql');
  const executable = nativePsql || 'docker';
  const executableArguments = nativePsql ? args : [
      'run', '--rm', '--pull', 'never', '--network', 'host',
      '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
      '--mount', `type=bind,src=${temporaryDirectory},dst=/e2e,readonly`,
      '-w', '/workspace',
      '-e', 'PGPASSFILE=/e2e/pgpass',
      '-e', 'PGAPPNAME=cnyos-complete-acl-native-e2e',
      '-e', 'PGCONNECT_TIMEOUT=3',
      clientImage, command, ...args
    ];
  const result = spawnSync(executable, executableArguments, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      LANG: process.env.LANG || 'C',
      PATH: process.env.PATH || '/usr/bin:/bin',
      PGPASSFILE: passfilePath,
      PGAPPNAME: 'cnyos-complete-acl-native-e2e',
      PGCONNECT_TIMEOUT: '3'
    }
  });
  if (result.error) {
    throw new Error(
      `focused ACL native E2E requires ${nativePsql || `Docker and ${clientImage}`}: ` +
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
  return runPsqlClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', databaseName,
    ...args
  ], options);
}

function psqlAs(roleName, args = [], options = {}) {
  return runPsqlClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', roleName,
    '-d', databaseName,
    ...args
  ], options);
}

function adminPsql(args = [], options = {}) {
  return runPsqlClient('psql', [
    '-X', '-q', '-A', '-t',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', 'template1',
    ...args
  ], options);
}

async function writeRuntimeFile(name, source) {
  const hostPath = path.join(temporaryDirectory, name);
  await fs.writeFile(hostPath, source, { encoding: 'utf8', mode: 0o600 });
  return nativePsql ? hostPath : `/e2e/${name}`;
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

function scalar(sql) {
  return psql([
    '--set=ON_ERROR_STOP=1',
    '--command', sql
  ]).stdout.trim();
}

function snapshot() {
  const result = psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'sentinel',(
    select coalesce(pg_catalog.jsonb_agg(value order by value),'[]'::jsonb)
    from public.cnyos_complete_acl_sentinel
  ),
  'inventory_lots',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(lot) order by lot.id
    ),'[]'::jsonb) from public.inventory_lots lot
  ),
  'stock_movements',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(movement) order by movement.id
    ),'[]'::jsonb) from public.stock_movements movement
  ),
  'profiles',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(profile) order by profile.id
    ),'[]'::jsonb) from public.profiles profile
  ),
  'public_routines',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        namespace.nspname || '.' || procedure.proname || '(' ||
          pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
        procedure.proowner::text,procedure.proacl,procedure.prosecdef,
        procedure.proconfig
      ) order by procedure.oid
    ),'[]'::jsonb)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid=procedure.pronamespace
    where namespace.nspname in ('public','auth')
  ),
  'default_acls',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(defaults) order by defaults.oid
    ),'[]'::jsonb) from pg_catalog.pg_default_acl defaults
  ),
  'triggers',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(trigger_row) order by trigger_row.oid
    ),'[]'::jsonb)
    from pg_catalog.pg_trigger trigger_row
    where not trigger_row.tgisinternal
  ),
  'event_triggers',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(event_row) order by event_row.oid
    ),'[]'::jsonb) from pg_catalog.pg_event_trigger event_row
  )
)::text;
`
  ]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'snapshot must be one JSON row');
  return JSON.parse(lines[0]);
}

function canonicalBindingSnapshot() {
  const output = scalar(String.raw`
select coalesce(pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_array(
    trigger_row.oid::text,trigger_row.tgname,trigger_row.tgrelid::text,
    trigger_row.tgfoid::text,trigger_row.tgenabled::text,
    trigger_row.tgtype,trigger_row.tgnargs,
    pg_catalog.encode(trigger_row.tgargs,'hex'),trigger_row.tgqual
  ) order by trigger_row.oid
),'[]'::jsonb)::text
from pg_catalog.pg_trigger trigger_row
where not trigger_row.tgisinternal;
`);
  return JSON.parse(output);
}

const semanticBindingSnapshotSelect = String.raw`
select pg_catalog.jsonb_build_object(
  'triggers',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'relation_schema',relation_namespace.nspname,
        'relation_name',relation.relname,
        'relation_kind',relation.relkind::text,
        'relation_persistence',relation.relpersistence::text,
        'trigger_name',trigger_row.tgname,
        'handler_signature',function_namespace.nspname || '.' ||
          procedure.proname || '(' ||
          pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
        'definition',pg_catalog.pg_get_triggerdef(trigger_row.oid,false),
        'enabled',trigger_row.tgenabled::text,
        'trigger_type',trigger_row.tgtype,
        'update_columns',trigger_row.tgattr::text,
        'argument_count',trigger_row.tgnargs,
        'arguments_hex',pg_catalog.encode(trigger_row.tgargs,'hex'),
        'deferrable',trigger_row.tgdeferrable,
        'initially_deferred',trigger_row.tginitdeferred,
        'when_expression_tree',trigger_row.tgqual::text,
        'old_transition_table',trigger_row.tgoldtable,
        'new_transition_table',trigger_row.tgnewtable,
        'handler_owner',function_owner.rolname,
        'handler_language',language.lanname,
        'handler_security_definer',procedure.prosecdef,
        'handler_config',procedure.proconfig,
        'handler_raw_acl',procedure.proacl::text,
        'handler_definition',pg_catalog.pg_get_functiondef(procedure.oid)
      ) order by relation_namespace.nspname collate "C",
        relation.relname collate "C",trigger_row.tgname collate "C"
    ),'[]'::jsonb)
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid=relation.relnamespace
    join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    join pg_catalog.pg_roles function_owner on function_owner.oid=procedure.proowner
    join pg_catalog.pg_language language on language.oid=procedure.prolang
    where not trigger_row.tgisinternal
  ),
  'event_triggers',(
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'event_trigger_name',event_row.evtname,
        'event',event_row.evtevent,
        'owner',event_owner.rolname,
        'handler_signature',function_namespace.nspname || '.' ||
          procedure.proname || '(' ||
          pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
        'enabled',event_row.evtenabled::text,
        'tags',(
          select pg_catalog.jsonb_agg(tag.value order by tag.value collate "C")
          from pg_catalog.unnest(event_row.evttags) tag(value)
        ),
        'handler_owner',function_owner.rolname,
        'handler_language',language.lanname,
        'handler_security_definer',procedure.prosecdef,
        'handler_config',procedure.proconfig,
        'handler_raw_acl',procedure.proacl::text,
        'handler_definition',pg_catalog.pg_get_functiondef(procedure.oid)
      ) order by event_row.evtname collate "C"
    ),'[]'::jsonb)
    from pg_catalog.pg_event_trigger event_row
    join pg_catalog.pg_roles event_owner on event_owner.oid=event_row.evtowner
    join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    join pg_catalog.pg_roles function_owner on function_owner.oid=procedure.proowner
    join pg_catalog.pg_language language on language.oid=procedure.prolang
  )
)::text;
`;

function semanticBindingSnapshot(mutation = '') {
  const output = scalar(mutation
    ? `begin;\n${mutation}\n${semanticBindingSnapshotSelect}\nrollback;`
    : semanticBindingSnapshotSelect
  );
  return JSON.parse(output);
}

function assertSemanticBindingMutationDetected(baseline, label, mutation) {
  const mutated = semanticBindingSnapshot(mutation);
  assert.notDeepEqual(mutated, baseline, `${label} escaped semantic binding pin`);
  assert.deepEqual(
    semanticBindingSnapshot(),
    baseline,
    `${label} rollback did not restore the binding baseline`
  );
}

const routineDefinitionSnapshotSelect = String.raw`
select coalesce(pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_array(
    namespace.nspname || '.' || procedure.proname || '(' ||
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
    )),'hex')
  ) order by namespace.nspname collate "C",procedure.proname collate "C",
    pg_catalog.pg_get_function_identity_arguments(procedure.oid) collate "C"
),'[]'::jsonb)::text
from pg_catalog.pg_proc procedure
join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
where namespace.nspname='public';
`;

function routineDefinitionSnapshot(mutation = '') {
  const output = scalar(mutation
    ? `begin;\n${mutation}\n${routineDefinitionSnapshotSelect}\nrollback;`
    : routineDefinitionSnapshotSelect
  );
  return JSON.parse(output);
}

function advisoryLockCount() {
  return Number(scalar(String.raw`
select pg_catalog.count(*)::text
from pg_catalog.pg_locks lock_row
where lock_row.locktype='advisory'
  and lock_row.classid::bigint=(202608302100::bigint >> 32)
  and lock_row.objid::bigint=(202608302100::bigint & 4294967295::bigint)
  and lock_row.objsubid=1 and lock_row.granted;
`));
}

async function cleanDatabase() {
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `drop database if exists ${databaseName} with (force);`
  ]);
  databaseCreated = false;
}

async function cleanFixtureRoles() {
  if (!fixtureRolesCreated) return;
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command',
    'drop role if exists anon, authenticated, service_role, supabase_admin, cnyos_hosted_executor;'
  ]);
  fixtureRolesCreated = false;
}

async function createFixture() {
  const existingRoles = Number(adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.count(*)
from pg_catalog.pg_roles
where rolname in (
  'anon','authenticated','service_role','supabase_admin',
  'cnyos_hosted_executor'
);
`
  ]).stdout.trim());
  assert.equal(
    existingRoles,
    0,
    'native E2E requires an isolated PostgreSQL cluster without fixture role names'
  );
  const createRolesPath = await writeRuntimeFile(
    'create-fixture-roles.sql',
    String.raw`
create role anon nologin nosuperuser nobypassrls;
create role authenticated nologin nosuperuser nobypassrls;
create role service_role nologin nosuperuser bypassrls;
create role supabase_admin login superuser bypassrls;
create role cnyos_hosted_executor login nosuperuser
  createdb createrole bypassrls password '${hostedExecutorPassword}';
grant pg_read_all_data to cnyos_hosted_executor;
`
  );
  adminPsql(['--set=ON_ERROR_STOP=1', '--file', createRolesPath]);
  fixtureRolesCreated = true;
  adminPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', `create database ${databaseName} owner ${databaseUser};`
  ]);
  databaseCreated = true;
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
create schema auth;
create schema supabase_migrations;
create table public.clinics(marker integer);
create table supabase_migrations.schema_migrations(marker integer);
create table supabase_migrations.cnyos_migration_ledger_repair_receipts(marker integer);
create table public.cnyos_complete_acl_sentinel(value integer primary key);
create table public.cnyos_hosted_lock_target(value integer);
alter table public.cnyos_hosted_lock_target owner to cnyos_hosted_executor;
grant maintain on table public.cnyos_complete_acl_sentinel
  to cnyos_hosted_executor;
create table public.inventory_lots(
  id integer primary key,
  current_quantity integer not null
);
create table public.stock_movements(
  id integer primary key,
  inventory_lot_id integer not null references public.inventory_lots(id),
  direction text not null,
  quantity integer not null,
  fail_after_apply boolean not null default false,
  expected_quantity_after_apply integer
);
create table auth.users(
  id integer primary key,
  email text not null
);
create table public.profiles(
  id integer primary key,
  email text not null
);
insert into public.inventory_lots(id,current_quantity) values (1,10);

create function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path=public
as $fixture$
begin
  if new.direction='in' then
    update public.inventory_lots
    set current_quantity=current_quantity+new.quantity
    where id=new.inventory_lot_id;
  else
    update public.inventory_lots
    set current_quantity=current_quantity-new.quantity
    where id=new.inventory_lot_id and current_quantity>=new.quantity;
    if not found then
      raise exception 'insufficient stock';
    end if;
  end if;
  return new;
end
$fixture$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $fixture$
begin
  insert into public.profiles(id,email) values(new.id,new.email);
  return new;
end
$fixture$;

create function public.cnyos_test_abort_after_apply()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $fixture$
declare
  v_quantity integer;
begin
  if new.fail_after_apply then
    select current_quantity into v_quantity
    from public.inventory_lots where id=new.inventory_lot_id;
    if v_quantity is distinct from new.expected_quantity_after_apply then
      raise exception 'CNYOS_TEST_APPLY_TRIGGER_DID_NOT_RUN_FIRST: %',v_quantity;
    end if;
    raise exception 'CNYOS_TEST_TRIGGER_ATOMIC_ROLLBACK';
  end if;
  return new;
end
$fixture$;

create function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text
)
returns integer
language sql
as $fixture$
  select 1
$fixture$;

create function public.cnyos_named_identity_integer(input_value integer)
returns integer
language sql
immutable
as $fixture$
  select input_value
$fixture$;

create function public.cnyos_named_identity_pair(left_value uuid,right_value text)
returns text
language sql
immutable
as $fixture$
  select left_value::text || right_value
$fixture$;

create trigger stock_movement_apply
after insert on public.stock_movements
for each row execute function public.apply_stock_movement();
create trigger zz_cnyos_test_abort_after_apply
after insert on public.stock_movements
for each row execute function public.cnyos_test_abort_after_apply();
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create function public.cnyos_test_event_handler()
returns event_trigger
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $fixture$
begin
  null;
end
$fixture$;

create event trigger cnyos_fixture_ddl
on ddl_command_end
execute function public.cnyos_test_event_handler();

grant temporary on database ${databaseName}
  to anon,authenticated,service_role;
grant usage on schema public,auth to anon,authenticated,service_role;
grant insert,select on public.stock_movements
  to anon,authenticated,service_role;
grant insert,select on auth.users to anon,authenticated,service_role;
grant insert on public.cnyos_complete_acl_sentinel to authenticated;
grant execute on function public.apply_stock_movement()
  to anon,authenticated,service_role;
grant execute on function public.handle_new_user()
  to anon,authenticated,service_role;
grant create on schema public to supabase_admin;
`
  ]);
}

function assertFailed(result, expected, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(result.output, expected, `${label} missed expected error`);
  assert.doesNotMatch(
    result.output,
    /CHECKS_PASSED|REMEDIATION_PASSED|\bREADY\b|CNYOS_UNREACHABLE_COMPLETE_ACL_TAIL/
  );
}

try {
  await createFixture();

  const version = Number(scalar(
    "select pg_catalog.current_setting('server_version_num');"
  ));
  assert.ok(
    version >= 170000 && version < 180000,
    `focused native ACL E2E requires PostgreSQL 17, got ${version}`
  );
  assert.equal(
    scalar("select rolsuper from pg_catalog.pg_roles where rolname=current_user;"),
    't',
    'fixture default-ACL rehearsal intentionally requires a superuser; it does not attest managed Supabase authority'
  );

  const hostedProfile = JSON.parse(psqlAs('cnyos_hosted_executor', [
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'login',role_row.rolcanlogin,
  'superuser',role_row.rolsuper,
  'createdb',role_row.rolcreatedb,
  'createrole',role_row.rolcreaterole,
  'bypassrls',role_row.rolbypassrls,
  'owns_lock_target',pg_catalog.pg_get_userbyid(relation.relowner)=role_row.rolname
)::text
from pg_catalog.pg_roles role_row
cross join pg_catalog.pg_class relation
where role_row.rolname=current_user
  and relation.oid='public.cnyos_hosted_lock_target'::regclass;
`
  ]).stdout.trim());
  assert.deepEqual(hostedProfile, {
    login: true,
    superuser: false,
    createdb: true,
    createrole: true,
    bypassrls: true,
    owns_lock_target: true
  });
  const unsupportedCatalogLock = psqlAs('cnyos_hosted_executor', [
    '--set=ON_ERROR_STOP=1',
    '--command',
    'begin; lock table pg_catalog.pg_proc in share mode nowait; rollback;'
  ], { allowFailure: true });
  assertFailed(
    unsupportedCatalogLock,
    /permission denied for table pg_proc/i,
    'hosted-like non-super system-catalog SHARE lock'
  );
  const hostedLockProofDo = String.raw`
do $cnyos_test_relation_lock_proof$
declare
  expected_relation_oids oid[];
  locked_relation_oids oid[];
begin
  select pg_catalog.array_agg(relation.oid order by relation.oid)
  into expected_relation_oids
  from pg_catalog.unnest(array[
    'public.cnyos_complete_acl_sentinel',
    'public.cnyos_hosted_lock_target'
  ]::text[]) reviewed(relation_name)
  join pg_catalog.pg_class relation
    on relation.oid=pg_catalog.to_regclass(reviewed.relation_name)
  where relation.relkind='r';

  select pg_catalog.array_agg(held.relation order by held.relation)
  into locked_relation_oids
  from (
    select distinct lock_row.relation
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype='relation'
      and lock_row.pid=pg_catalog.pg_backend_pid()
      and lock_row.database=(
        select database.oid from pg_catalog.pg_database database
        where database.datname=pg_catalog.current_database()
      )
      and lock_row.mode='ShareLock'
      and lock_row.granted
      and lock_row.relation is not null
  ) held;
  if coalesce(pg_catalog.cardinality(expected_relation_oids),0)<>2
     or coalesce(pg_catalog.cardinality(locked_relation_oids),0)<>2
     or locked_relation_oids is distinct from expected_relation_oids then
    raise exception 'CNYOS_TEST_TRIGGER_RELATION_LOCK_SET_INVALID';
  end if;
end
$cnyos_test_relation_lock_proof$;
`;
  const ownedRelationLock = psqlAs('cnyos_hosted_executor', [
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
begin;
lock table only
  public.cnyos_complete_acl_sentinel,
  public.cnyos_hosted_lock_target
in share mode nowait;
${hostedLockProofDo}
select pg_catalog.jsonb_build_object(
  'probe','hosted-like-relation-share-lock',
  'superuser',(
    select rolsuper from pg_catalog.pg_roles where rolname=current_user
  )
)::text;
rollback;
`
  ]);
  assert.deepEqual(parseJsonOutputLines(ownedRelationLock.stdout), [{
    probe: 'hosted-like-relation-share-lock',
    superuser: false
  }]);
  const missingRelationLock = psqlAs('cnyos_hosted_executor', [
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
begin;
lock table only public.cnyos_hosted_lock_target in share mode nowait;
${hostedLockProofDo}
rollback;
`
  ], { allowFailure: true });
  assertFailed(
    missingRelationLock,
    /CNYOS_TEST_TRIGGER_RELATION_LOCK_SET_INVALID/,
    'hosted-like missing reviewed relation ShareLock proof'
  );

  const namedIdentityArguments = JSON.parse(scalar(String.raw`
set search_path = pg_catalog, pg_temp;
select pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_object(
    'identity_arguments',
      pg_catalog.pg_get_function_identity_arguments(procedure.oid),
    'type_arguments',pg_catalog.replace(
      pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
    ),
    'candidate_signature',
      namespace.nspname || '.' || procedure.proname || '(' ||
      pg_catalog.replace(
        pg_catalog.oidvectortypes(procedure.proargtypes),', ',','
      ) || ')'
  ) order by procedure.proname collate "C"
)::text
from pg_catalog.pg_proc procedure
join pg_catalog.pg_namespace namespace
  on namespace.oid=procedure.pronamespace
where namespace.nspname='public'
  and procedure.proname in (
    'cnyos_named_identity_integer',
    'cnyos_named_identity_pair'
  );
`));
  assert.deepEqual(namedIdentityArguments, [
    {
      identity_arguments: 'input_value integer',
      type_arguments: 'integer',
      candidate_signature: 'public.cnyos_named_identity_integer(integer)'
    },
    {
      identity_arguments: 'left_value uuid, right_value text',
      type_arguments: 'uuid,text',
      candidate_signature: 'public.cnyos_named_identity_pair(uuid,text)'
    }
  ]);
  for (const fixture of namedIdentityArguments) {
    assert.notEqual(
      fixture.identity_arguments,
      fixture.type_arguments,
      'PG17 identity arguments unexpectedly omitted the fixture argument names'
    );
  }

  const candidateBaseline = snapshot();
  assert.equal(advisoryLockCount(), 0);
  const inertResult = psqlAs(
    'cnyos_hosted_executor',
    ['--file', candidateClientPath],
    { allowFailure: true }
  );
  assertFailed(
    inertResult,
    /CNYOS_COMPLETE_ACL_REMEDIATION_NOT_AUTHORIZED/,
    'exact inert candidate under hosted-like non-super role'
  );
  assert.deepEqual(snapshot(), candidateBaseline, 'inert candidate changed state');
  assert.equal(advisoryLockCount(), 0, 'inert candidate leaked advisory lock');

  const outerTransactionPath = await writeRuntimeFile(
    'outer-transaction.sql',
    String.raw`\set ON_ERROR_STOP 1
begin;
insert into public.cnyos_complete_acl_sentinel(value) values (701);
savepoint caller_statement;
\i ${candidateClientPath}
\echo CNYOS_UNREACHABLE_COMPLETE_ACL_TAIL
`
  );
  const outerResult = psql(
    ['--file', outerTransactionPath],
    { allowFailure: true }
  );
  assertFailed(
    outerResult,
    /CNYOS_COMPLETE_ACL_PSQL_EXISTING_TRANSACTION_REFUSED/,
    'seeded outer transaction refusal'
  );
  assert.deepEqual(snapshot(), candidateBaseline, 'outer transaction was not rolled back');

  const candidateSource = await fs.readFile(candidateHostPath, 'utf8');
  const continueAfterBlocker = replaceExact(
    candidateSource,
    '\\set ON_ERROR_STOP 1',
    '\\set ON_ERROR_STOP 0',
    1,
    'same-session advisory unlock probe'
  );
  const instrumentedPath = await writeRuntimeFile(
    'candidate-continue-after-blocker.sql',
    continueAfterBlocker
  );
  const handlerProbePath = await writeRuntimeFile(
    'candidate-handler-unlock-probe.sql',
    String.raw`\i ${instrumentedPath}
select pg_catalog.jsonb_build_object(
  'probe','complete-acl-handler-unlock',
  'own_granted_advisory_locks',pg_catalog.count(*)
)::text
from pg_catalog.pg_locks lock_row
where lock_row.locktype='advisory'
  and lock_row.pid=pg_catalog.pg_backend_pid()
  and lock_row.granted
  and lock_row.classid::bigint=(202608302100::bigint >> 32)
  and lock_row.objid::bigint=(202608302100::bigint & 4294967295::bigint)
  and lock_row.objsubid=1;
\set ON_ERROR_STOP 1
do $probe$
begin
  raise exception 'CNYOS_TEST_COMPLETE_ACL_HANDLER_PROBE_COMPLETE';
end
$probe$;
\echo CNYOS_UNREACHABLE_COMPLETE_ACL_TAIL
`
  );
  const handlerProbe = psql(
    ['--file', handlerProbePath],
    { allowFailure: true }
  );
  assertFailed(
    handlerProbe,
    /CNYOS_COMPLETE_ACL_REMEDIATION_NOT_AUTHORIZED/,
    'same-session handler unlock probe'
  );
  assert.doesNotMatch(
    handlerProbe.output,
    /CNYOS_COMPLETE_ACL_ADVISORY_INTERLOCK_RELEASE_FAILED/,
    'post-blocker continuation must release its advisory lock at the normal tail'
  );
  assert.match(
    handlerProbe.output,
    /CNYOS_TEST_COMPLETE_ACL_HANDLER_PROBE_COMPLETE/
  );
  assert.deepEqual(
    parseJsonOutputLines(handlerProbe.stdout).filter(
      row => row.probe === 'complete-acl-handler-unlock'
    ),
    [{ probe: 'complete-acl-handler-unlock', own_granted_advisory_locks: 0 }]
  );
  assert.deepEqual(snapshot(), candidateBaseline, 'handler probe changed state');
  assert.equal(advisoryLockCount(), 0, 'handler probe leaked advisory lock');

  const effectivePublicCreators = JSON.parse(scalar(String.raw`
select pg_catalog.jsonb_agg(
  role_row.rolname order by role_row.rolname collate "C"
)::text
from pg_catalog.pg_roles role_row
where pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE');
`));
  assert.deepEqual(
    effectivePublicCreators,
    ['pg_database_owner','postgres','supabase_admin'],
    'fixture must reproduce the closed-world staging public CREATE baseline'
  );
  const unexpectedCreatorProbe = JSON.parse(scalar(String.raw`
begin;
create role cnyos_unexpected_public_creator nologin nosuperuser;
grant create on schema public to cnyos_unexpected_public_creator;
select pg_catalog.jsonb_agg(
  role_row.rolname order by role_row.rolname collate "C"
)::text
from pg_catalog.pg_roles role_row
where pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE');
rollback;
`));
  assert.deepEqual(
    unexpectedCreatorProbe,
    [
      'cnyos_unexpected_public_creator',
      'pg_database_owner',
      'postgres',
      'supabase_admin'
    ],
    'closed-world CREATE probe failed to expose an additional effective creator'
  );
  assert.equal(
    scalar("select pg_catalog.to_regrole('cnyos_unexpected_public_creator') is null;"),
    't',
    'closed-world CREATE probe did not roll back its extra role'
  );
  const setOnlyCreatorProbe = JSON.parse(scalar(String.raw`
begin;
create role cnyos_set_only_login login noinherit nosuperuser;
grant postgres to cnyos_set_only_login with inherit false, set true;
select pg_catalog.jsonb_build_object(
  'effective_create',pg_catalog.has_schema_privilege(
    'cnyos_set_only_login','public','CREATE'
  ),
  'can_set_creator',pg_catalog.pg_has_role(
    'cnyos_set_only_login','postgres','SET'
  ),
  'guard_detects',exists (
    select 1
    from pg_catalog.pg_roles candidate_role
    cross join (values ('pg_database_owner'),('postgres'),('supabase_admin'))
      creator_name(role_name)
    join pg_catalog.pg_roles creator_role
      on creator_role.rolname=creator_name.role_name
    where candidate_role.rolname='cnyos_set_only_login'
      and candidate_role.rolcanlogin
      and candidate_role.rolname not in ('postgres','supabase_admin')
      and pg_catalog.pg_has_role(
        candidate_role.oid,creator_role.oid,'SET'
      )
  )
)::text;
rollback;
`));
  assert.deepEqual(setOnlyCreatorProbe, {
    effective_create: false,
    can_set_creator: true,
    guard_detects: true
  });
  assert.equal(
    scalar("select pg_catalog.to_regrole('cnyos_set_only_login') is null;"),
    't',
    'SET-only creator reachability probe did not roll back its role'
  );

  const semanticBindingsBefore = semanticBindingSnapshot();
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'same-count relation rebinding',
    String.raw`
create table public.cnyos_rebound_stock_movements(
  id integer, inventory_lot_id integer, direction text, quantity integer,
  fail_after_apply boolean, expected_quantity_after_apply integer
);
drop trigger stock_movement_apply on public.stock_movements;
create trigger stock_movement_apply
after insert on public.cnyos_rebound_stock_movements
for each row execute function public.apply_stock_movement();
`
  );
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'same-count trigger-name swap',
    String.raw`
drop trigger stock_movement_apply on public.stock_movements;
create trigger stock_movement_apply_swapped
after insert on public.stock_movements
for each row execute function public.apply_stock_movement();
`
  );
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'changed trigger condition/definition',
    String.raw`
create or replace trigger stock_movement_apply
after insert on public.stock_movements
for each row when (new.quantity > 0)
execute function public.apply_stock_movement();
`
  );
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'changed bound handler definition',
    String.raw`
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path=public
as $changed$
begin
  return new;
end
$changed$;
`
  );
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'same-count event-trigger rebinding',
    String.raw`
drop event trigger cnyos_fixture_ddl;
create event trigger cnyos_fixture_sql_drop
on sql_drop
execute function public.cnyos_test_event_handler();
`
  );
  assertSemanticBindingMutationDetected(
    semanticBindingsBefore,
    'changed event-handler definition',
    String.raw`
create or replace function public.cnyos_test_event_handler()
returns event_trigger
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $changed$
begin
  perform 1;
end
$changed$;
`
  );
  const routineDefinitionsBefore = routineDefinitionSnapshot();
  const driftedOrdinaryRoutine = routineDefinitionSnapshot(String.raw`
create or replace function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text
)
returns integer
language sql
as $changed$
  select 2
$changed$;
`);
  assert.notDeepEqual(
    driftedOrdinaryRoutine,
    routineDefinitionsBefore,
    'ordinary non-SECDEF RPC body drift escaped the all-routine definition pin'
  );
  assert.deepEqual(
    routineDefinitionSnapshot(),
    routineDefinitionsBefore,
    'ordinary non-SECDEF RPC drift probe did not roll back'
  );

  // Prove the pre-remediation primitive in a transaction that is rolled back.
  const exploitPath = await writeRuntimeFile(
    'pre-remediation-temp-trigger-exploit.sql',
    String.raw`\set ON_ERROR_STOP 1
begin;
set role anon;
create temp table temp_stock_movements(
  id integer,
  inventory_lot_id integer,
  direction text,
  quantity integer,
  fail_after_apply boolean,
  expected_quantity_after_apply integer
);
create trigger temp_stock_movement_apply
after insert on temp_stock_movements
for each row execute function public.apply_stock_movement();
insert into temp_stock_movements values(1,1,'in',5,false,null);
reset role;
select pg_catalog.jsonb_build_object(
  'probe','pre-remediation-temp-trigger',
  'quantity',(select current_quantity from public.inventory_lots where id=1)
)::text;
rollback;
`
  );
  const exploit = psql(['--file', exploitPath]);
  assert.deepEqual(
    parseJsonOutputLines(exploit.stdout).filter(
      row => row.probe === 'pre-remediation-temp-trigger'
    ),
    [{ probe: 'pre-remediation-temp-trigger', quantity: 15 }]
  );
  assert.equal(scalar(
    'select current_quantity from public.inventory_lots where id=1;'
  ), '10', 'pre-remediation exploit transaction did not roll back');

  const bindingBefore = canonicalBindingSnapshot();
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
revoke all privileges on function public.apply_stock_movement()
  from public,anon,authenticated,service_role;
revoke all privileges on function public.handle_new_user()
  from public,anon,authenticated,service_role;
alter function public.apply_stock_movement()
  set search_path to pg_catalog,public,pg_temp;
alter function public.handle_new_user()
  set search_path to pg_catalog,public,pg_temp;
`
  ]);
  assert.deepEqual(
    canonicalBindingSnapshot(),
    bindingBefore,
    'ACL/path remediation changed existing trigger bindings'
  );
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from (values ('anon'),('authenticated'),('service_role')) role_name(name)
cross join (values
  ('public.apply_stock_movement()'),
  ('public.handle_new_user()')
) handler(signature)
where pg_catalog.has_function_privilege(
  role_name.name,pg_catalog.to_regprocedure(handler.signature),'EXECUTE'
);
`)), 0, 'runtime role retained handler EXECUTE');
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from pg_catalog.pg_proc procedure
cross join lateral pg_catalog.aclexplode(coalesce(
  procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
)) acl
where procedure.oid in (
  'public.apply_stock_movement()'::regprocedure,
  'public.handle_new_user()'::regprocedure
) and acl.grantee<>procedure.proowner;
`)), 0, 'handler retained a non-owner raw ACL tuple');
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from pg_catalog.pg_proc procedure
where procedure.oid in (
  'public.apply_stock_movement()'::regprocedure,
  'public.handle_new_user()'::regprocedure
) and procedure.proconfig is distinct from
  array['search_path=pg_catalog, public, pg_temp']::text[];
`)), 0, 'reviewed handler search_path was not hardened');

  for (const roleName of runtimeRoles) {
    for (const handler of privilegedHandlers) {
      const shortName = handler.match(/\.([a-z0-9_]+)\(/i)[1];
      const tableShape = shortName === 'apply_stock_movement'
        ? String.raw`id integer, inventory_lot_id integer, direction text,
            quantity integer, fail_after_apply boolean,
            expected_quantity_after_apply integer`
        : 'id integer, email text';
      const denialPath = await writeRuntimeFile(
        `deny-${roleName}-${shortName}.sql`,
        String.raw`\set ON_ERROR_STOP 1
set role ${roleName};
create temp table cnyos_denial_target(${tableShape});
create trigger cnyos_denied_attachment
after insert on cnyos_denial_target
for each row execute function ${handler};
\echo CNYOS_UNREACHABLE_COMPLETE_ACL_TAIL
`
      );
      const denial = psql(
        ['--file', denialPath],
        { allowFailure: true }
      );
      assertFailed(
        denial,
        new RegExp(`permission denied for function (?:public\\.)?${shortName}`, 'i'),
        `${roleName} temp attachment of ${handler}`
      );
    }
  }

  // Existing bindings remain executable even though creating new bindings is denied.
  let movementId = 100;
  let userId = 200;
  for (const roleName of runtimeRoles) {
    psql([
      '--set=ON_ERROR_STOP=1',
      '--command', String.raw`
set role ${roleName};
insert into public.stock_movements(
  id,inventory_lot_id,direction,quantity,fail_after_apply
) values (${movementId},1,'in',2,false);
insert into auth.users(id,email)
values (${userId},'${roleName}@example.invalid');
reset role;
`
    ]);
    movementId += 1;
    userId += 1;
  }
  assert.deepEqual(JSON.parse(scalar(String.raw`
select pg_catalog.jsonb_build_object(
  'quantity',(select current_quantity from public.inventory_lots where id=1),
  'movements',(select count(*) from public.stock_movements),
  'profiles',(select count(*) from public.profiles)
)::text;
`)), { quantity: 16, movements: 3, profiles: 3 });

  const atomicPath = await writeRuntimeFile(
    'atomic-trigger-rollback.sql',
    String.raw`\set ON_ERROR_STOP 1
begin;
set role authenticated;
insert into public.cnyos_complete_acl_sentinel(value) values(801);
insert into public.stock_movements(
  id,inventory_lot_id,direction,quantity,
  fail_after_apply,expected_quantity_after_apply
) values(999,1,'in',7,true,23);
commit;
\echo CNYOS_UNREACHABLE_COMPLETE_ACL_TAIL
`
  );
  const atomic = psql(
    ['--file', atomicPath],
    { allowFailure: true }
  );
  assertFailed(
    atomic,
    /CNYOS_TEST_TRIGGER_ATOMIC_ROLLBACK/,
    'trigger workflow atomic rollback'
  );
  assert.deepEqual(JSON.parse(scalar(String.raw`
select pg_catalog.jsonb_build_object(
  'quantity',(select current_quantity from public.inventory_lots where id=1),
  'movement_exists',exists(
    select 1 from public.stock_movements where id=999
  ),
  'sentinel_exists',exists(
    select 1 from public.cnyos_complete_acl_sentinel where value=801
  )
)::text;
`)), { quantity: 16, movement_exists: false, sentinel_exists: false });

  // Exercise both global and schema-local default ACL closure in this disposable
  // superuser fixture for postgres and pg_database_owner. supabase_admin is kept
  // byte-for-byte unchanged as the explicit hosted-platform exception. This
  // proves PostgreSQL behavior only; the production candidate still requires an
  // independent acceptance decision for that residual creator risk. The global
  // revoke is essential: a schema-local revoke cannot negate PUBLIC's hard-wired
  // function default.
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
alter default privileges for role postgres
  grant execute on functions to public,anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon,authenticated,service_role;
alter default privileges for role supabase_admin
  grant execute on functions to public,anon,authenticated,service_role;
alter default privileges for role supabase_admin in schema public
  grant execute on functions to anon,authenticated,service_role;
alter default privileges for role pg_database_owner
  grant execute on functions to public,anon,authenticated,service_role;
alter default privileges for role pg_database_owner in schema public
  grant execute on functions to anon,authenticated,service_role;
`
  ]);
  const supabaseAdminDefaultBefore = scalar(String.raw`
select coalesce(pg_catalog.jsonb_agg(
  pg_catalog.to_jsonb(defaults) order by defaults.oid
),'[]'::jsonb)::text
from pg_catalog.pg_default_acl defaults
join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
where creator.rolname='supabase_admin'
  and defaults.defaclobjtype='f'
  and (defaults.defaclnamespace=0
    or defaults.defaclnamespace='public'::regnamespace);
`);
  psql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`

alter default privileges for role postgres
  revoke execute on functions from public,anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public,anon,authenticated,service_role;
alter default privileges for role pg_database_owner
  revoke execute on functions from public,anon,authenticated,service_role;
alter default privileges for role pg_database_owner in schema public
  revoke execute on functions from public,anon,authenticated,service_role;

set role postgres;
create function public.cnyos_future_postgres() returns integer
language sql as 'select 1';
reset role;
set role supabase_admin;
create function public.cnyos_future_supabase_admin() returns integer
language sql as 'select 1';
reset role;
set role pg_database_owner;
create function public.cnyos_future_pg_database_owner() returns integer
language sql as 'select 1';
reset role;
`
  ]);
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from (values ('anon'),('authenticated'),('service_role')) role_name(name)
cross join (values
  ('public.cnyos_future_postgres()'),
  ('public.cnyos_future_pg_database_owner()')
) future(signature)
where pg_catalog.has_function_privilege(
  role_name.name,pg_catalog.to_regprocedure(future.signature),'EXECUTE'
);
`)), 0, 'mutable-creator future function inherited runtime EXECUTE');
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from (values ('anon'),('authenticated'),('service_role')) role_name(name)
where pg_catalog.has_function_privilege(
  role_name.name,
  'public.cnyos_future_supabase_admin()'::regprocedure,
  'EXECUTE'
);
`)), 3, 'managed exception hazard was not detected');
  assert.equal(
    scalar(String.raw`
select coalesce(pg_catalog.jsonb_agg(
  pg_catalog.to_jsonb(defaults) order by defaults.oid
),'[]'::jsonb)::text
from pg_catalog.pg_default_acl defaults
join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
where creator.rolname='supabase_admin'
  and defaults.defaclobjtype='f'
  and (defaults.defaclnamespace=0
    or defaults.defaclnamespace='public'::regnamespace);
`),
    supabaseAdminDefaultBefore,
    'managed supabase_admin default ACL changed'
  );
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from pg_catalog.pg_proc procedure
cross join lateral pg_catalog.aclexplode(coalesce(
  procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
)) acl
left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
where procedure.oid in (
  'public.cnyos_future_postgres()'::regprocedure,
  'public.cnyos_future_pg_database_owner()'::regprocedure
) and acl.grantee<>procedure.proowner
  and (acl.grantee=0
    or grantee.rolname in ('anon','authenticated','service_role'));
`)), 0, 'mutable-creator future function retained PUBLIC/runtime raw ACL');
  assert.equal(Number(scalar(String.raw`
select pg_catalog.count(*)
from pg_catalog.pg_default_acl defaults
join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
where creator.rolname in ('postgres','pg_database_owner')
  and defaults.defaclobjtype='f'
  and (defaults.defaclnamespace=0
    or defaults.defaclnamespace='public'::regnamespace)
  and (acl.grantee=0
    or grantee.rolname in ('anon','authenticated','service_role'));
`)), 0, 'mutable creator default ACL retained PUBLIC/runtime grant');

  console.log(
    'focused public-routine ACL native E2E passed; the actual 147-routine/' +
    '141-path candidate remains blocked pending a full native rehearsal ' +
    '(PostgreSQL 17; hosted-like non-super inert run/relation lock; ' +
    'exact/missing ShareLock-set proof; named-argument/type-only signatures; ' +
    'unsupported system-catalog lock denied; rollback/unlock; ' +
    'closed-world and SET-only CREATE reachability drift; ' +
    'all-routine definition and binding-semantic drift; ' +
    'six temp-handler denials; existing workflows; ' +
    'atomic rollback; postgres/pg_database_owner default ACL closure; ' +
    'hosted supabase_admin exception detected; ' +
    `client=${nativePsql ? 'native' : 'docker'})`
  );
} finally {
  try {
    if (databaseCreated) await cleanDatabase();
  } finally {
    try {
      await cleanFixtureRoles();
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
