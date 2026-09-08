import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = path.join(
  root,
  'supabase/manual/public_routine_acl_inventory_read_only.sql'
);
const sql = await fs.readFile(artifactPath, 'utf8');
const captureStart = '-- CNYOS_OBSERVATION_CAPTURE_BEGIN';
const captureEnd = '-- CNYOS_OBSERVATION_CAPTURE_END';
const outputGucStart = '-- CNYOS_OBSERVATION_OUTPUT_GUCS_BEGIN';
const outputGucEnd = '-- CNYOS_OBSERVATION_OUTPUT_GUCS_END';

function indexOfOrThrow(source, needle, label) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `${label} is missing`);
  return index;
}

function assertOrdered(source, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `${label} is missing or out of order at ${needle}`);
    cursor = next;
  }
}

function materializeCapture(source) {
  const start = indexOfOrThrow(source, captureStart, 'capture start marker');
  const end = indexOfOrThrow(source, captureEnd, 'capture end marker');
  assert.ok(end > start, 'capture markers are out of order');
  return source
    .slice(start + captureStart.length, end)
    .replaceAll(
      ":'cnyos_observation_source_revision'",
      "'0123456789012345678901234567890123456789'"
    )
    .replaceAll(
      ":'cnyos_observation_project_label'",
      "'contract-test'"
    )
    .replace(/\\gset\s*$/, ';')
    .trim();
}

function blockBetween(source, startMarker, endMarker, label) {
  const start = indexOfOrThrow(source, startMarker, `${label} start marker`);
  const end = indexOfOrThrow(source, endMarker, `${label} end marker`);
  assert.ok(end > start, `${label} markers are out of order`);
  return source.slice(start + startMarker.length, end).trim();
}

function sha256Utf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertIndependentDigestOracle(observation) {
  for (const [name, value] of Object.entries(observation.review_datasets)) {
    assert.equal(typeof value.canonical_payload, 'string', `${name} payload missing`);
    assert.equal(
      Buffer.byteLength(value.canonical_payload, 'utf8'),
      value.payload_bytes,
      `${name} byte count differs from Node UTF-8 oracle`
    );
    assert.equal(
      sha256Utf8(value.canonical_payload),
      value.payload_sha256,
      `${name} SHA-256 differs from Node crypto oracle`
    );
    const lines = value.canonical_payload === ''
      ? []
      : value.canonical_payload.slice(0, -1).split('\n');
    assert.equal(
      value.canonical_payload === '' || value.canonical_payload.endsWith('\n'),
      true,
      `${name} nonempty payload must end in LF`
    );
    assert.equal(lines.length, value.row_count, `${name} line count mismatch`);
    assert.deepEqual(
      lines.map(line => JSON.parse(line)),
      value.digest_rows,
      `${name} canonical lines differ from emitted positional rows`
    );
    for (let index = 0; index < value.digest_rows.length; index += 1) {
      const digestRow = value.digest_rows[index];
      assert.equal(digestRow[1], name, `${name} digest row names another dataset`);
      assert.deepEqual(
        Object.fromEntries(digestRow[2]),
        value.review_rows[index],
        `${name} digest row omits or changes a human review field`
      );
    }
  }

  const composite = observation.composite_digest;
  assert.equal(typeof composite.canonical_payload, 'string');
  assert.equal(
    Buffer.byteLength(composite.canonical_payload, 'utf8'),
    composite.payload_bytes,
    'composite byte count differs from Node UTF-8 oracle'
  );
  assert.equal(
    sha256Utf8(composite.canonical_payload),
    composite.payload_sha256,
    'composite SHA-256 differs from Node crypto oracle'
  );
  assert.equal(composite.canonical_payload.endsWith('\n'), true);
  const compositeRows = composite.canonical_payload.slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(compositeRows.length, composite.row_count);
  assert.deepEqual(compositeRows, composite.review_rows);
}

function dataset(observation, name) {
  const value = observation.review_datasets[name];
  assert.ok(value, `missing review dataset ${name}`);
  assert.equal(typeof value.row_count, 'number');
  assert.equal(typeof value.payload_bytes, 'number');
  assert.match(value.payload_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(value.digest_rows));
  assert.ok(Array.isArray(value.review_rows));
  assert.equal(value.digest_rows.length, value.row_count);
  assert.equal(value.review_rows.length, value.row_count);
  assert.equal(
    value.digest_rows.every(row =>
      Array.isArray(row) &&
      row[0] === 'cnyos-observation-positional-digest-row/v1' &&
      typeof row[1] === 'string' && Array.isArray(row[2])
    ),
    true
  );
  return value;
}

assert.match(
  sql,
  /psql -X --quiet --no-align --tuples-only/,
  'the direct psql command must document -X and single-row output flags'
);
assertOrdered(sql, [
  '\\set QUIET on',
  '\\encoding UTF8',
  '\\pset format unaligned',
  '\\pset tuples_only on',
  '\\pset expanded off',
  '\\pset pager off'
], 'artifact-level UTF-8 and single-row output envelope');
assertOrdered(sql, [
  '\\set QUIET on',
  '\\pset format unaligned',
  '\\pset tuples_only on',
  '\\pset expanded off',
  '\\pset pager off',
  '\\set ON_ERROR_STOP 1'
], 'psql output envelope');
assert.match(sql, /^\\set ON_ERROR_STOP 1$/m);
assert.match(sql, /^\\set ON_ERROR_ROLLBACK off$/m);
assert.match(sql, /^\\if :AUTOCOMMIT$/m);
assert.match(
  sql,
  /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_AUTOCOMMIT_REQUIRED/
);
assert.match(
  sql,
  /pg_catalog\.pg_current_xact_id\(\)::text as cnyos_observation_probe_xid/
);
assert.match(
  sql,
  /CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_EXISTING_TRANSACTION_REFUSED/
);
assert.match(
  sql,
  /cnyos_observation_source_revision' ~ '\^\[0-9a-f\]\{40\}\$'/
);
assert.match(sql, /operator_supplied_metadata_only', true/);
assert.match(sql, /target_authorization_claimed', false/);
assert.match(
  sql,
  /CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_INTERLOCK_ALREADY_HELD/
);
assert.equal(
  (sql.match(/lock_row\.pid = pg_catalog\.pg_backend_pid\(\)/g) ?? []).length,
  2,
  'observer must check its own advisory holds before acquisition and after unlock'
);
assert.equal(
  (sql.match(/pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\)/g) ?? []).length,
  1,
  'observer must try the shared advisory key exactly once'
);
assert.equal(
  (sql.match(/pg_catalog\.pg_advisory_unlock\(202608302100::bigint\)/g) ?? []).length,
  1,
  'observer must unlock the shared advisory key exactly once'
);

assertOrdered(sql, [
  '\\set ON_ERROR_STOP 1',
  '\\if :AUTOCOMMIT',
  'select pg_catalog.pg_current_xact_id()::text as cnyos_observation_probe_xid',
  ') as cnyos_observation_lock_unheld',
  '\\if :cnyos_observation_lock_unheld',
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint)',
  'begin isolation level repeatable read read only;',
  'set local search_path = pg_catalog, pg_temp;',
  'lock table pg_catalog.pg_proc,',
  captureStart,
  ')::text as cnyos_public_routine_acl_observation',
  '\\gset',
  captureEnd,
  'rollback;',
  'select pg_catalog.pg_advisory_unlock(202608302100::bigint)',
  '\\if :cnyos_observation_lock_released',
  ') as cnyos_observation_lock_fully_released',
  '\\if :cnyos_observation_lock_fully_released',
  ":'cnyos_public_routine_acl_observation'::pg_catalog.jsonb",
  '\\unset cnyos_public_routine_acl_observation'
], 'observation lifecycle');
assert.match(
  sql,
  /'observation_transaction_rolled_back', true,[\s\S]*'advisory_lock_released', true/
);
assert.match(
  sql,
  /\) as cnyos_observation_lock_fully_released\n\\gset\n\\if :cnyos_observation_lock_fully_released\nselect \([\s\S]*as public_routine_acl_observation;/,
  'observer evidence must be gated by the zero-own-holds proof'
);

assert.match(
  sql,
  /lock table pg_catalog\.pg_proc,[\s\S]*pg_catalog\.pg_db_role_setting,[\s\S]*pg_catalog\.pg_database,[\s\S]*pg_catalog\.pg_trigger,[\s\S]*pg_catalog\.pg_event_trigger,[\s\S]*pg_catalog\.pg_constraint\s+in access share mode;/
);
assert.doesNotMatch(
  sql,
  /lock table[\s\S]*?in (?:row exclusive|share update exclusive|share|share row exclusive|exclusive|access exclusive) mode;/i,
  'a read-only transaction must not claim a write-conflicting catalog lock'
);

const captureSql = materializeCapture(sql);
const outputGucSql = blockBetween(
  sql,
  outputGucStart,
  outputGucEnd,
  'output GUC pin block'
);
assert.match(captureSql, /^with recursive\b/);
assert.doesNotMatch(
  captureSql,
  /^(?:insert|update|delete|merge|copy|create|alter|drop|truncate|grant|revoke|comment)\b/im,
  'the captured snapshot query must be read-only'
);

for (const pinnedSetting of [
  "set local timezone = 'UTC';",
  "set local datestyle = 'ISO, YMD';",
  "set local intervalstyle = 'postgres';",
  'set local extra_float_digits = 3;',
  "set local bytea_output = 'hex';",
  'set local quote_all_identifiers = off;',
  'set local standard_conforming_strings = on;',
  "set local lc_monetary = 'C';",
  "set local lc_numeric = 'C';",
  "set local lc_time = 'C';"
]) {
  assert.ok(
    outputGucSql.includes(pinnedSetting),
    `missing output GUC pin: ${pinnedSetting}`
  );
}
assertOrdered(sql, [
  'begin isolation level repeatable read read only;',
  'set local search_path = pg_catalog, pg_temp;',
  outputGucStart,
  outputGucEnd,
  'lock table pg_catalog.pg_proc,',
  captureStart
], 'output GUC pin lifecycle');
for (const recordedSetting of [
  "'client_encoding', pg_catalog.current_setting('client_encoding')",
  "'timezone', pg_catalog.current_setting('TimeZone')",
  "'datestyle', pg_catalog.current_setting('DateStyle')",
  "'intervalstyle', pg_catalog.current_setting('IntervalStyle')",
  "pg_catalog.current_setting('extra_float_digits')",
  "'bytea_output', pg_catalog.current_setting('bytea_output')",
  "pg_catalog.current_setting('quote_all_identifiers')",
  "pg_catalog.current_setting('standard_conforming_strings')",
  "'lc_monetary', pg_catalog.current_setting('lc_monetary')",
  "'lc_numeric', pg_catalog.current_setting('lc_numeric')",
  "'lc_time', pg_catalog.current_setting('lc_time')"
]) {
  assert.ok(captureSql.includes(recordedSetting), `missing recorded GUC ${recordedSetting}`);
}
assert.doesNotMatch(
  sql,
  /(?:digest|crypt|gen_salt|encrypt|decrypt)\s*\(/i,
  'the observer must use PostgreSQL 17 pg_catalog.sha256, not an extension helper'
);

assert.match(
  captureSql,
  /dependency\.classid = 'pg_catalog\.pg_proc'::pg_catalog\.regclass/
);
assert.match(captureSql, /dependency\.objid = procedure\.oid/);
assert.match(captureSql, /dependency\.objsubid = 0/);
assert.match(
  captureSql,
  /dependency\.refclassid =\s*'pg_catalog\.pg_extension'::pg_catalog\.regclass/
);
assert.match(captureSql, /dependency\.refobjsubid = 0/);
assert.match(captureSql, /dependency\.deptype = 'e'/);
assert.doesNotMatch(
  captureSql,
  /proname\s+(?:not\s+)?in\s*\(/i,
  'production classification must never exclude fixture/helper function names'
);

assert.match(captureSql, /acl\.grantee = 0::oid\s*\n\s*then 'PUBLIC'/);
assert.match(captureSql, /acl\.grantor = 0::oid\s*\n\s*then 'PUBLIC'/);
assert.match(captureSql, /\('PUBLIC'::text, true\)/);
assert.match(captureSql, /required\.is_public_pseudo_role then 0::oid/);
assert.match(captureSql, /routine_public_privileges as \(/);
assert.match(captureSql, /public_schema_public_privileges as \(/);
assert.doesNotMatch(captureSql, /has_(?:schema|function)_privilege\(\s*'public'/i);
assert.doesNotMatch(
  captureSql,
  /join pg_catalog\.pg_roles\s+\w+\s+on\s+\w+\.oid\s*=\s*0/i,
  'PUBLIC is OID zero and must not be modeled as a pg_roles row'
);

for (const required of [
  "'status', 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED'",
  "'authorization', false",
  "'production_eligible', false",
  "'public_routines.all.semantic'",
  "'public_routines.non_extension_application.semantic'",
  "'public_routines.extension_members.semantic'",
  "'public_routines.all.raw_acl'",
  "'public_routines.all.effective_access'",
  "'extensions.membership_dependencies'",
  "'public_schema.raw_acl'",
  "'public_schema.effective_access'",
  "'runtime_role_graph.anchors'",
  "'runtime_role_graph.nodes'",
  "'runtime_role_graph.edges'",
  "'current_database.security'",
  "'schemas.all_non_temporary.security'",
  "'database_role_settings.current_database_and_global'",
  "'runtime_role_graph.connected_routine_effective_diagnostics'",
  "'runtime_role_graph.connected_schema_effective_diagnostics'",
  "'function_default_acl.global_and_public_schema'",
  "'function_default_acl.future_public_execute'",
  "'trigger_bindings.all_non_internal'",
  "'event_trigger_bindings.all'",
  "'owner_role_security'",
  "'authorization_context'",
  "'function_schema_security'",
  "'acl_identity.unresolved_nonzero_oids'",
  "'absent_row_semantics'",
  "'future_public_function_execute_in_public_schema'",
  "'grantor_unresolved'",
  "'grantee_unresolved'",
  "'payload_bytes'",
  "'payload_sha256'",
  "'composite_digest'",
  "'digest_rows'",
  "'review_rows'"
]) {
  assert.ok(captureSql.includes(required), `missing required evidence field ${required}`);
}

assert.doesNotMatch(sql, /\b(?:PASS(?:ED)?|READY)\b/i);
assert.doesNotMatch(sql, /authorization', true/);
assert.doesNotMatch(sql, /production_eligible', true/);
assert.equal(
  (sql.match(/as public_routine_acl_observation;/g) ?? []).length,
  1,
  'the observer must have exactly one final observation SELECT'
);

const conditionalDepth = sql.split(/\r?\n/).reduce((depth, line) => {
  if (/^\\if\b/.test(line)) return depth + 1;
  if (/^\\endif\b/.test(line)) return depth - 1;
  assert.ok(depth >= 0, 'psql conditional depth became negative');
  return depth;
}, 0);
assert.equal(conditionalDepth, 0, 'psql conditionals must balance');

const db = new PGlite();
await db.waitReady;
await db.exec(`
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role authenticator nologin noinherit;
  create role app_owner nologin noinherit;
  create role handler_parent nologin noinherit bypassrls;
  alter role authenticated valid until '2035-07-08 09:10:11+07';

  grant anon to authenticator with inherit false, set true;
  grant authenticated to authenticator with inherit false, set true;
  grant service_role to authenticator with inherit false, set true;

  revoke all on schema public from public;
  grant usage on schema public to public;

  create function public.app_probe()
  returns integer language sql immutable as 'select 1';
  revoke all on function public.app_probe() from public;
  grant execute on function public.app_probe() to authenticated;

  create function public.public_probe(value integer)
  returns integer language sql immutable as 'select value';
  alter function public.public_probe(integer) owner to app_owner;

  create function public.secdef_probe()
  returns integer language sql volatile security definer
  set search_path = pg_catalog as 'select 2';
  revoke all on function public.secdef_probe() from public;
  grant execute on function public.secdef_probe() to service_role;

  create function public.cost_rows_probe()
  returns setof integer language sql immutable
  cost 123.456 rows 789.125 as 'select 3';
  revoke all on function public.cost_rows_probe() from public;
  grant execute on function public.cost_rows_probe() to authenticated;

  create table public.trigger_probe(id integer primary key);
  create table public.trigger_probe_child(
    id integer primary key,
    trigger_probe_id integer references public.trigger_probe(id)
  );
  create function public.trigger_probe_handler()
  returns trigger language plpgsql set search_path = pg_catalog as $$
  begin
    return new;
  end
  $$;
  revoke all on function public.trigger_probe_handler() from public;
  create trigger trigger_probe_before_update
  before update of id on public.trigger_probe
  for each row when (old.id is distinct from new.id)
  execute function public.trigger_probe_handler('alpha', 'beta');

  create schema private_probe;
  revoke all on schema private_probe
  from public, anon, authenticated, service_role;
  grant usage on schema private_probe to anon;
  create schema path_probe;
  revoke all on schema path_probe
  from public, anon, authenticated, service_role;
  grant usage on schema path_probe to anon;
  create table private_probe.trigger_probe(id integer);
  create function private_probe.trigger_probe_handler()
  returns trigger language plpgsql
  set search_path = pg_catalog, path_probe, pg_temp as $$
  begin
    return new;
  end
  $$;
  alter function private_probe.trigger_probe_handler() owner to app_owner;
  revoke all on function private_probe.trigger_probe_handler()
  from public, anon, authenticated, service_role;
  create trigger private_trigger_probe_before_insert
  before insert on private_probe.trigger_probe
  for each row execute function private_probe.trigger_probe_handler();
  create temporary table temporary_trigger_probe(id integer);
  create trigger temporary_trigger_probe_before_insert
  before insert on temporary_trigger_probe
  for each row execute function private_probe.trigger_probe_handler();

  create function public.event_trigger_probe_handler()
  returns event_trigger language plpgsql set search_path = pg_catalog as $$
  begin
    null;
  end
  $$;
  revoke all on function public.event_trigger_probe_handler() from public;
  create event trigger event_trigger_probe
  on ddl_command_end when tag in ('CREATE TABLE')
  execute function public.event_trigger_probe_handler();

  create function private_probe.event_trigger_probe_handler()
  returns event_trigger language plpgsql as $$
  begin
    null;
  end
  $$;
  alter function private_probe.event_trigger_probe_handler()
    owner to app_owner;
  revoke all on function private_probe.event_trigger_probe_handler()
  from public, anon, authenticated, service_role;
  create event trigger private_event_trigger_probe
  on sql_drop
  execute function private_probe.event_trigger_probe_handler();

  alter default privileges for role postgres
    revoke execute on functions from public;
`);

async function observe() {
  await db.exec(`
    begin isolation level repeatable read read only;
    set local search_path = pg_catalog, pg_temp;
    ${outputGucSql}
    lock table pg_catalog.pg_proc,
      pg_catalog.pg_namespace,
      pg_catalog.pg_authid,
      pg_catalog.pg_auth_members,
      pg_catalog.pg_depend,
      pg_catalog.pg_extension,
      pg_catalog.pg_language,
      pg_catalog.pg_default_acl,
      pg_catalog.pg_aggregate,
      pg_catalog.pg_type,
      pg_catalog.pg_db_role_setting,
      pg_catalog.pg_trigger,
      pg_catalog.pg_event_trigger,
      pg_catalog.pg_class,
      pg_catalog.pg_attribute,
      pg_catalog.pg_constraint
    in access share mode;
  `);
  try {
    const result = await db.query(captureSql);
    assert.equal(result.rows.length, 1);
    return JSON.parse(result.rows[0].cnyos_public_routine_acl_observation);
  } finally {
    await db.exec('rollback;');
  }
}

try {
  const before = await db.query(`
    select count(*)::int as routine_count,
      coalesce(string_agg(
        procedure.oid::text || ':' || coalesce(procedure.proacl::text, 'NULL'),
        E'\\n' order by procedure.oid
      ), '') as acl_state
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  `);
  const first = await observe();
  await db.exec(`
    set timezone = 'Asia/Bangkok';
    set quote_all_identifiers = on;
    set standard_conforming_strings = off;
    set extra_float_digits = -15;
    set datestyle = 'German, DMY';
    set intervalstyle = 'sql_standard';
    set bytea_output = 'escape';
  `);
  const hostileSession = (await db.query(`
    select
      current_setting('TimeZone') as timezone,
      current_setting('quote_all_identifiers') as quote_all_identifiers,
      current_setting('standard_conforming_strings')
        as standard_conforming_strings,
      current_setting('extra_float_digits') as extra_float_digits,
      current_setting('DateStyle') as datestyle,
      current_setting('IntervalStyle') as intervalstyle,
      current_setting('bytea_output') as bytea_output
  `)).rows[0];
  assert.deepEqual(hostileSession, {
    timezone: 'Asia/Bangkok',
    quote_all_identifiers: 'on',
    standard_conforming_strings: 'off',
    extra_float_digits: '-15',
    datestyle: 'German, DMY',
    intervalstyle: 'sql_standard',
    bytea_output: 'escape'
  });
  const second = await observe();
  const after = await db.query(`
    select count(*)::int as routine_count,
      coalesce(string_agg(
        procedure.oid::text || ':' || coalesce(procedure.proacl::text, 'NULL'),
        E'\\n' order by procedure.oid
      ), '') as acl_state
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  `);

  assert.deepEqual(after.rows, before.rows, 'observation changed routine or ACL state');
  assert.equal(first.status, 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED');
  assert.equal(first.artifact_schema, 'cnyos-public-routine-acl-observation/v2');
  assert.equal(first.authorization, false);
  assert.equal(first.production_eligible, false);
  assert.equal(first.source_metadata.operator_supplied_metadata_only, true);
  assert.equal(first.source_metadata.target_authorization_claimed, false);
  assert.equal(first.observation_transaction.transaction_isolation, 'repeatable read');
  assert.equal(first.observation_transaction.transaction_read_only, 'on');
  assert.equal(first.observation_transaction.search_path, 'pg_catalog, pg_temp');
  assert.deepEqual(first.observation_transaction.output_gucs, {
    client_encoding: 'UTF8',
    timezone: 'UTC',
    datestyle: 'ISO, YMD',
    intervalstyle: 'postgres',
    extra_float_digits: '3',
    bytea_output: 'hex',
    quote_all_identifiers: 'off',
    standard_conforming_strings: 'on',
    lc_monetary: 'C',
    lc_numeric: 'C',
    lc_time: 'C'
  });
  assert.deepEqual(second.observation_transaction.output_gucs, {
    client_encoding: 'UTF8',
    timezone: 'UTC',
    datestyle: 'ISO, YMD',
    intervalstyle: 'postgres',
    extra_float_digits: '3',
    bytea_output: 'hex',
    quote_all_identifiers: 'off',
    standard_conforming_strings: 'on',
    lc_monetary: 'C',
    lc_numeric: 'C',
    lc_time: 'C'
  });
  assert.equal(first.composite_digest.payload_sha256, second.composite_digest.payload_sha256);
  assert.equal(first.composite_digest.payload_bytes, second.composite_digest.payload_bytes);
  assert.match(first.composite_digest.payload_sha256, /^[0-9a-f]{64}$/);
  assertIndependentDigestOracle(first);
  assertIndependentDigestOracle(second);

  const allSemantics = dataset(first, 'public_routines.all.semantic');
  const appSemantics = dataset(
    first,
    'public_routines.non_extension_application.semantic'
  );
  const extensionSemantics = dataset(
    first,
    'public_routines.extension_members.semantic'
  );
  assert.equal(allSemantics.row_count, 6);
  assert.equal(appSemantics.row_count, 6);
  assert.equal(extensionSemantics.row_count, 0);
  assert.equal(
    appSemantics.review_rows.every(row =>
      row.classification === 'non_extension_application' &&
      row.pg_proc_catalog &&
      !Object.hasOwn(row.pg_proc_catalog, 'proacl') &&
      Object.hasOwn(row, 'pg_aggregate_catalog') &&
      Array.isArray(row.extension_memberships) &&
      typeof row.result_type === 'string' &&
      typeof row.result_schema === 'string' &&
      typeof row.returns_trigger === 'boolean' &&
      typeof row.returns_event_trigger === 'boolean' &&
      typeof row.data_api_candidate === 'boolean'
    ),
    true
  );
  const secdefSemantic = appSemantics.review_rows.find(row =>
    row.signature === 'public.secdef_probe()'
  );
  assert.ok(secdefSemantic);
  assert.equal(secdefSemantic.pg_proc_catalog.prosecdef, true);
  assert.match(secdefSemantic.function_definition, /SECURITY DEFINER/i);
  assert.equal(secdefSemantic.data_api_candidate, true);
  const costRowsSemantic = appSemantics.review_rows.find(row =>
    row.signature === 'public.cost_rows_probe()'
  );
  assert.ok(costRowsSemantic);
  assert.equal(costRowsSemantic.pg_proc_catalog.procost, 123.456);
  assert.equal(costRowsSemantic.pg_proc_catalog.prorows, 789.125);

  const rawAcl = dataset(first, 'public_routines.all.raw_acl');
  const appProbeAcl = rawAcl.review_rows.find(row =>
    row.signature === 'public.app_probe()'
  );
  const publicProbeAcl = rawAcl.review_rows.find(row =>
    row.signature === 'public.public_probe(integer)'
  );
  assert.ok(appProbeAcl);
  assert.ok(publicProbeAcl);
  assert.equal(appProbeAcl.proacl_is_null, false);
  assert.equal(
    appProbeAcl.expanded_acl_rows.some(row =>
      row.grantee_label === 'authenticated' && row.privilege_type === 'EXECUTE'
    ),
    true
  );
  assert.equal(
    appProbeAcl.expanded_acl_rows.some(row => row.grantee_oid === '0'),
    false
  );
  assert.equal(publicProbeAcl.proacl_is_null, true);
  assert.equal(
    publicProbeAcl.expanded_acl_rows.some(row =>
      row.grantee_oid === '0' && row.grantee_label === 'PUBLIC'
    ),
    true
  );

  const effective = dataset(first, 'public_routines.all.effective_access');
  assert.equal(effective.row_count, 24);
  for (const signature of [
    'public.app_probe()',
    'public.public_probe(integer)',
    'public.secdef_probe()',
    'public.cost_rows_probe()'
  ]) {
    assert.deepEqual(
      effective.review_rows
        .filter(row => row.signature === signature)
        .map(row => row.role_name)
        .sort(),
      ['PUBLIC', 'anon', 'authenticated', 'service_role'].sort()
    );
    assert.equal(
      effective.review_rows
        .filter(row => row.signature === signature)
        .every(row => row.role_exists === true),
      true
    );
  }
  const effectiveRow = (signature, roleName) => effective.review_rows.find(row =>
    row.signature === signature && row.role_name === roleName
  );
  assert.equal(effectiveRow('public.app_probe()', 'authenticated').function_execute, true);
  assert.equal(effectiveRow('public.app_probe()', 'authenticated').invocable_through_public_schema, true);
  assert.equal(effectiveRow('public.app_probe()', 'PUBLIC').function_execute, false);
  assert.equal(effectiveRow('public.public_probe(integer)', 'PUBLIC').function_execute, true);

  const schemaAcl = dataset(first, 'public_schema.raw_acl');
  assert.equal(schemaAcl.row_count, 1);
  assert.equal(
    schemaAcl.review_rows[0].expanded_acl_rows.some(row =>
      row.grantee_oid === '0' && row.grantee_label === 'PUBLIC' &&
      row.privilege_type === 'USAGE'
    ),
    true
  );
  dataset(first, 'public_schema.effective_access');

  const anchors = dataset(first, 'runtime_role_graph.anchors');
  assert.equal(anchors.row_count, 5);
  assert.equal(
    anchors.review_rows.some(row =>
      row.anchor_name === 'PUBLIC' && row.role_oid === '0' && row.pseudo_role === true
    ),
    true
  );
  const edges = dataset(first, 'runtime_role_graph.edges');
  assert.equal(edges.row_count, 3);
  assert.equal(
    edges.review_rows.every(row =>
      row.member_role_name === 'authenticator' && row.set_option === true
    ),
    true
  );
  const authenticatedRole = dataset(first, 'runtime_role_graph.nodes')
    .review_rows.find(row => row.role_name === 'authenticated');
  assert.ok(authenticatedRole);
  assert.equal(authenticatedRole.rolvaliduntil, '2035-07-08T02:10:11+00:00');

  const defaultAcl = dataset(
    first,
    'function_default_acl.global_and_public_schema'
  );
  assert.equal(
    defaultAcl.review_rows.some(row =>
      row.owner_name === 'postgres' && row.scope === 'global' &&
      row.catalog_row_present === true
    ),
    true
  );
  assert.equal(
    defaultAcl.review_rows.some(row =>
      row.owner_name === 'app_owner' && row.scope === 'global' &&
      row.catalog_row_present === false &&
      row.absent_row_semantics ===
        'hard_wired_function_default_applies_owner_and_public_execute'
    ),
    true
  );
  assert.equal(
    defaultAcl.review_rows.some(row =>
      row.owner_name === 'app_owner' && row.scope === 'public_schema' &&
      row.catalog_row_present === false &&
      row.absent_row_semantics ===
        'no_public_schema_specific_function_default_acl_contribution'
    ),
    true
  );

  const futurePublic = dataset(
    first,
    'function_default_acl.future_public_execute'
  );
  assert.equal(
    futurePublic.review_rows.some(row =>
      row.owner_name === 'postgres' &&
      row.global_catalog_row_present === true &&
      row.future_public_function_execute_in_public_schema === false
    ),
    true
  );
  assert.equal(
    futurePublic.review_rows.some(row =>
      row.owner_name === 'app_owner' &&
      row.global_catalog_row_present === false &&
      row.global_absent_uses_hard_wired_function_default === true &&
      row.future_public_function_execute_in_public_schema === true
    ),
    true
  );
  assert.equal(
    futurePublic.review_rows.some(row =>
      row.owner_effective_create_on_public === true
    ),
    true,
    'roles with effective CREATE on public must participate in future ACL review'
  );
  assert.equal(dataset(first, 'acl_identity.unresolved_nonzero_oids').row_count, 0);

  const triggerBindings = dataset(
    first,
    'trigger_bindings.all_non_internal'
  );
  const independentNonInternalTriggerCount = Number((await db.query(
    'select count(*)::int as count from pg_catalog.pg_trigger where not tgisinternal'
  )).rows[0].count);
  const independentInternalTriggerCount = Number((await db.query(
    'select count(*)::int as count from pg_catalog.pg_trigger where tgisinternal'
  )).rows[0].count);
  assert.ok(independentInternalTriggerCount > 0, 'foreign-key fixture needs internal triggers');
  assert.equal(triggerBindings.row_count, independentNonInternalTriggerCount);
  assert.equal(triggerBindings.row_count, 3);
  const publicTriggerBinding = triggerBindings.review_rows.find(row =>
    row.function_signature === 'public.trigger_probe_handler()'
  );
  const privateTriggerBinding = triggerBindings.review_rows.find(row =>
    row.function_signature === 'private_probe.trigger_probe_handler()'
  );
  assert.ok(publicTriggerBinding);
  assert.ok(privateTriggerBinding, 'non-public binding must be included in the closed world');
  const temporaryTriggerBinding = triggerBindings.review_rows.find(row =>
    row.trigger_name === 'temporary_trigger_probe_before_insert'
  );
  assert.ok(temporaryTriggerBinding, 'temporary-relation binding must be classified');
  assert.equal(temporaryTriggerBinding.temporary_relation, true);
  assert.equal(temporaryTriggerBinding.relation_persistence, 't');
  assert.equal(publicTriggerBinding.relation_schema, 'public');
  assert.equal(publicTriggerBinding.relation_name, 'trigger_probe');
  assert.equal(publicTriggerBinding.trigger_name, 'trigger_probe_before_update');
  assert.equal(publicTriggerBinding.relation_persistence, 'p');
  assert.deepEqual(publicTriggerBinding.update_columns, [{ attnum: 1, name: 'id' }]);
  assert.equal(publicTriggerBinding.argument_count, 2);
  assert.equal(publicTriggerBinding.arguments_hex, '616c706861006265746100');
  assert.match(publicTriggerBinding.definition, /UPDATE OF id/i);
  assert.match(publicTriggerBinding.definition, /IS DISTINCT FROM/i);
  assert.equal(typeof publicTriggerBinding.when_expression_tree, 'string');
  assert.equal(publicTriggerBinding.row_schema, 'cnyos-trigger-binding/v1');
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.pg_proc_catalog.prosecdef,
    false
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.owner_name,
    'app_owner'
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.owner_role_security
      .rolbypassrls,
    false
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.language_security
      .pg_language_catalog.lanpltrusted,
    true
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.language_security
      .raw_acl.expanded_acl_rows.some(row =>
        row.grantee_label === 'PUBLIC' && row.privilege_type === 'USAGE'
      ),
    true
  );
  assert.deepEqual(
    privateTriggerBinding.handler_semantics_and_raw_acl.pg_proc_catalog.proconfig,
    ['search_path=pg_catalog, path_probe, pg_temp']
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl
      .function_local_search_path_has_explicit_terminal_pg_temp,
    true
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl
      .function_local_search_path_contains_quoted_identifier,
    false
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl
      .function_local_search_path_potentially_temp_dynamic,
    false
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.raw_acl.expanded_acl_rows
      .some(row => row.grantee_label === 'anon'),
    false
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.effective_runtime_access
      .find(row => row.role_name === 'anon').function_execute,
    false
  );
  const privateHandlerSchemaSecurity = privateTriggerBinding
    .handler_semantics_and_raw_acl.function_schema_security;
  assert.equal(privateHandlerSchemaSecurity.schema_name, 'private_probe');
  assert.equal(
    privateHandlerSchemaSecurity.raw_acl.expanded_acl_rows.some(row =>
      row.grantee_label === 'anon' && row.privilege_type === 'USAGE'
    ),
    true
  );
  assert.equal(
    privateHandlerSchemaSecurity.effective_access_all_roles.find(row =>
      row.role_name === 'anon'
    ).create,
    false
  );
  const persistentSchemaSecurity = dataset(
    first,
    'schemas.all_non_temporary.security'
  );
  assert.equal(
    persistentSchemaSecurity.review_rows.every(row =>
      row.temporary_schema === false
    ),
    true
  );
  assert.ok(
    persistentSchemaSecurity.review_rows.some(row =>
      row.schema_name === 'path_probe'
    )
  );
  const embeddedSchemaDigest = privateTriggerBinding
    .handler_semantics_and_raw_acl.all_non_temporary_schema_security_digest;
  assert.equal(embeddedSchemaDigest.row_count, persistentSchemaSecurity.row_count);
  assert.equal(
    embeddedSchemaDigest.payload_bytes,
    persistentSchemaSecurity.payload_bytes
  );
  assert.equal(
    embeddedSchemaDigest.payload_sha256,
    persistentSchemaSecurity.payload_sha256
  );
  assert.equal(
    privateTriggerBinding.handler_semantics_and_raw_acl.authorization_context
      .role_nodes.some(row => row.role_name === 'handler_parent'),
    true
  );
  const currentDatabaseSecurity = dataset(first, 'current_database.security');
  assert.equal(currentDatabaseSecurity.row_count, 1);
  assert.equal(currentDatabaseSecurity.review_rows[0].database_name, 'template1');
  assert.equal(currentDatabaseSecurity.review_rows[0].owner_name, 'postgres');
  assert.equal(
    currentDatabaseSecurity.review_rows[0].effective_access_all_roles.find(row =>
      row.role_name === 'PUBLIC'
    ).temporary,
    true
  );
  assert.deepEqual(
    privateTriggerBinding.handler_semantics_and_raw_acl.authorization_context
      .current_database_security,
    currentDatabaseSecurity.review_rows[0]
  );
  assert.equal(
    triggerBindings.review_rows.every(row => row.is_internal === false),
    true
  );

  const eventTriggerBindings = dataset(
    first,
    'event_trigger_bindings.all'
  );
  const independentEventTriggerCount = Number((await db.query(
    'select count(*)::int as count from pg_catalog.pg_event_trigger'
  )).rows[0].count);
  assert.equal(eventTriggerBindings.row_count, independentEventTriggerCount);
  assert.equal(eventTriggerBindings.row_count, 2);
  const publicEventTriggerBinding = eventTriggerBindings.review_rows.find(row =>
    row.function_signature === 'public.event_trigger_probe_handler()'
  );
  const privateEventTriggerBinding = eventTriggerBindings.review_rows.find(row =>
    row.function_signature === 'private_probe.event_trigger_probe_handler()'
  );
  assert.ok(publicEventTriggerBinding);
  assert.ok(privateEventTriggerBinding, 'non-public event trigger must be included');
  assert.equal(publicEventTriggerBinding.event_trigger_name, 'event_trigger_probe');
  assert.equal(publicEventTriggerBinding.event, 'ddl_command_end');
  assert.deepEqual(publicEventTriggerBinding.tags, ['CREATE TABLE']);
  assert.equal(privateEventTriggerBinding.tags, null);
  assert.equal(
    publicEventTriggerBinding.row_schema,
    'cnyos-event-trigger-binding/v1'
  );
  assert.equal(
    privateEventTriggerBinding.handler_semantics_and_raw_acl.pg_proc_catalog
      .prosecdef,
    false
  );
  assert.equal(
    privateEventTriggerBinding.handler_semantics_and_raw_acl.owner_name,
    'app_owner'
  );
  assert.deepEqual(
    privateEventTriggerBinding.handler_semantics_and_raw_acl.pg_proc_catalog
      .proconfig,
    null
  );
  assert.equal(
    privateEventTriggerBinding.handler_semantics_and_raw_acl
      .function_local_search_path_absent,
    true
  );
  assert.equal(
    privateEventTriggerBinding.handler_semantics_and_raw_acl
      .function_local_search_path_potentially_temp_dynamic,
    true
  );
  assert.equal(
    privateEventTriggerBinding.handler_semantics_and_raw_acl.raw_acl
      .expanded_acl_rows.some(row => row.grantee_label === 'anon'),
    false
  );

  await db.exec('set quote_all_identifiers = off;');
  const privateTriggerHandlerRow = observation => observation.review_datasets[
    'trigger_bindings.all_non_internal'
  ].review_rows.find(row =>
    row.trigger_name === 'private_trigger_probe_before_insert'
  ).handler_semantics_and_raw_acl;
  const assertPrivateTriggerRestored = (observation, label) => {
    assert.equal(
      observation.review_datasets['trigger_bindings.all_non_internal']
        .payload_sha256,
      first.review_datasets['trigger_bindings.all_non_internal'].payload_sha256,
      `${label} must restore the exact trigger-binding digest`
    );
    assert.equal(
      observation.composite_digest.payload_sha256,
      first.composite_digest.payload_sha256,
      `${label} must restore the exact composite digest`
    );
  };
  const assertPrivateTriggerDrift = (observation, label) => {
    assert.notEqual(
      observation.review_datasets['trigger_bindings.all_non_internal']
        .payload_sha256,
      first.review_datasets['trigger_bindings.all_non_internal'].payload_sha256,
      `${label} must change the trigger-binding digest`
    );
  };

  await db.exec(`
    create or replace function private_probe.trigger_probe_handler()
    returns trigger language plpgsql security invoker
    set search_path = pg_catalog, path_probe, pg_temp as $$
    begin
      perform 1;
      return new;
    end
    $$;
  `);
  const bodyDrift = await observe();
  assertPrivateTriggerDrift(bodyDrift, 'private handler body drift');
  assert.match(privateTriggerHandlerRow(bodyDrift).pg_proc_catalog.prosrc, /perform 1/i);
  await db.exec(`
  create or replace function private_probe.trigger_probe_handler()
  returns trigger language plpgsql security invoker
  set search_path = pg_catalog, path_probe, pg_temp as $$
  begin
    return new;
  end
  $$;
  `);
  assertPrivateTriggerRestored(await observe(), 'private handler body restoration');

  await db.exec(`
    alter function private_probe.trigger_probe_handler() security definer;
  `);
  const securityDrift = await observe();
  assertPrivateTriggerDrift(securityDrift, 'private handler security-mode drift');
  assert.equal(privateTriggerHandlerRow(securityDrift).pg_proc_catalog.prosecdef, true);
  await db.exec(`
    alter function private_probe.trigger_probe_handler() security invoker;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'private handler security-mode restoration'
  );

  await db.exec(`
    alter function private_probe.trigger_probe_handler()
      set search_path = public;
  `);
  const searchPathDrift = await observe();
  assertPrivateTriggerDrift(searchPathDrift, 'private handler search_path drift');
  assert.deepEqual(
    privateTriggerHandlerRow(searchPathDrift).pg_proc_catalog.proconfig,
    ['search_path=public']
  );
  await db.exec(`
    alter function private_probe.trigger_probe_handler()
      set search_path = pg_catalog, path_probe, pg_temp;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'private handler search_path restoration'
  );

  await db.exec(`
    alter function private_probe.trigger_probe_handler()
      set search_path = "evil,pg_temp";
  `);
  const quotedCommaSearchPathDrift = await observe();
  const quotedCommaHandler = privateTriggerHandlerRow(quotedCommaSearchPathDrift);
  assertPrivateTriggerDrift(
    quotedCommaSearchPathDrift,
    'private handler quoted-comma search_path drift'
  );
  assert.deepEqual(
    quotedCommaHandler.pg_proc_catalog.proconfig,
    ['search_path="evil,pg_temp"']
  );
  assert.equal(
    quotedCommaHandler.function_local_search_path_contains_quoted_identifier,
    true
  );
  assert.equal(
    quotedCommaHandler.function_local_search_path_has_explicit_terminal_pg_temp,
    false
  );
  assert.equal(
    quotedCommaHandler.function_local_search_path_potentially_temp_dynamic,
    true
  );
  await db.exec(`
    alter function private_probe.trigger_probe_handler()
      set search_path = pg_catalog, path_probe, pg_temp;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'private handler quoted-comma search_path restoration'
  );

  await db.exec(`
    alter function private_probe.trigger_probe_handler() owner to postgres;
  `);
  const ownerDrift = await observe();
  assertPrivateTriggerDrift(ownerDrift, 'private handler owner drift');
  assert.equal(privateTriggerHandlerRow(ownerDrift).owner_name, 'postgres');
  await db.exec(`
    alter function private_probe.trigger_probe_handler() owner to app_owner;
  `);
  assertPrivateTriggerRestored(await observe(), 'private handler owner restoration');

  await db.exec(`
    grant execute on function private_probe.trigger_probe_handler() to anon;
  `);
  const aclDrift = await observe();
  assertPrivateTriggerDrift(aclDrift, 'private handler ACL drift');
  assert.equal(
    privateTriggerHandlerRow(aclDrift).raw_acl.expanded_acl_rows.some(row =>
      row.grantee_label === 'anon' && row.privilege_type === 'EXECUTE'
    ),
    true
  );
  assert.equal(
    privateTriggerHandlerRow(aclDrift).effective_runtime_access.find(row =>
      row.role_name === 'anon'
    ).function_execute,
    true
  );
  await db.exec(`
    revoke execute on function private_probe.trigger_probe_handler() from anon;
  `);
  assertPrivateTriggerRestored(await observe(), 'private handler ACL restoration');

  await db.exec(`
    grant create on schema path_probe to anon;
  `);
  const schemaAclDrift = await observe();
  assertPrivateTriggerDrift(schemaAclDrift, 'private handler-schema ACL drift');
  assert.equal(
    dataset(schemaAclDrift, 'schemas.all_non_temporary.security').review_rows
      .find(row => row.schema_name === 'path_probe')
      .effective_access_all_roles.find(row => row.role_name === 'anon').create,
    true
  );
  await db.exec(`
    revoke create on schema path_probe from anon;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'private handler-schema ACL restoration'
  );

  await db.exec(`
    alter role app_owner bypassrls;
  `);
  const ownerAttributeDrift = await observe();
  assertPrivateTriggerDrift(ownerAttributeDrift, 'handler-owner attribute drift');
  assert.equal(
    privateTriggerHandlerRow(ownerAttributeDrift).owner_role_security
      .rolbypassrls,
    true
  );
  await db.exec(`
    alter role app_owner nobypassrls;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'handler-owner attribute restoration'
  );

  await db.exec(`
    grant handler_parent to app_owner with inherit true, set true;
  `);
  const ownerMembershipDrift = await observe();
  assertPrivateTriggerDrift(ownerMembershipDrift, 'handler-owner membership drift');
  assert.equal(
    privateTriggerHandlerRow(ownerMembershipDrift).authorization_context
      .membership_edges.some(row =>
        row.granted_role_name === 'handler_parent' &&
        row.member_role_name === 'app_owner'
      ),
    true
  );
  await db.exec(`
    revoke handler_parent from app_owner;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'handler-owner membership restoration'
  );

  await db.exec(`
    alter role authenticator set search_path = private_probe, pg_catalog;
  `);
  const roleSettingDrift = await observe();
  assertPrivateTriggerDrift(roleSettingDrift, 'database role-setting drift');
  assert.equal(
    dataset(
      roleSettingDrift,
      'database_role_settings.current_database_and_global'
    ).review_rows.some(row =>
      row.role_name === 'authenticator' &&
      row.database_name === 'ALL_DATABASES'
    ),
    true
  );
  await db.exec(`
    alter role authenticator reset search_path;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'database role-setting restoration'
  );

  await db.exec(`
    alter language plpgsql owner to app_owner;
  `);
  const languageOwnerDrift = await observe();
  assertPrivateTriggerDrift(languageOwnerDrift, 'handler-language owner drift');
  assert.equal(
    privateTriggerHandlerRow(languageOwnerDrift).language_security.owner_name,
    'app_owner'
  );
  await db.exec(`
    alter language plpgsql owner to postgres;
  `);
  assertPrivateTriggerRestored(
    await observe(),
    'handler-language owner restoration'
  );

  await db.exec(`
    create or replace function private_probe.event_trigger_probe_handler()
    returns event_trigger language plpgsql as $$
    begin
      perform 1;
      null;
    end
    $$;
  `);
  const eventHandlerDrift = await observe();
  assert.notEqual(
    eventHandlerDrift.review_datasets['event_trigger_bindings.all']
      .payload_sha256,
    first.review_datasets['event_trigger_bindings.all'].payload_sha256,
    'private event-handler body drift must change the event-trigger digest'
  );
  const driftedPrivateEventHandler = eventHandlerDrift.review_datasets[
    'event_trigger_bindings.all'
  ].review_rows.find(row =>
    row.event_trigger_name === 'private_event_trigger_probe'
  ).handler_semantics_and_raw_acl;
  assert.match(driftedPrivateEventHandler.pg_proc_catalog.prosrc, /perform 1/i);
  await db.exec(`
  create or replace function private_probe.event_trigger_probe_handler()
  returns event_trigger language plpgsql as $$
  begin
    null;
  end
  $$;
  `);
  const restoredPrivateEventHandler = await observe();
  assert.equal(
    restoredPrivateEventHandler.review_datasets['event_trigger_bindings.all']
      .payload_sha256,
    first.review_datasets['event_trigger_bindings.all'].payload_sha256,
    'private event-handler restoration must restore its exact digest'
  );
  assert.equal(
    restoredPrivateEventHandler.composite_digest.payload_sha256,
    first.composite_digest.payload_sha256,
    'private event-handler restoration must restore the exact composite digest'
  );

  await db.exec(`
    alter table public.trigger_probe disable trigger trigger_probe_before_update;
    alter event trigger event_trigger_probe disable;
  `);
  const disabledBindings = await observe();
  assert.notEqual(
    disabledBindings.review_datasets['trigger_bindings.all_non_internal']
      .payload_sha256,
    first.review_datasets['trigger_bindings.all_non_internal'].payload_sha256,
    'disabling a trigger must change its closed-world binding digest'
  );
  assert.notEqual(
    disabledBindings.review_datasets['event_trigger_bindings.all'].payload_sha256,
    first.review_datasets['event_trigger_bindings.all'].payload_sha256,
    'disabling an event trigger must change its closed-world binding digest'
  );
  await db.exec(`
    alter table public.trigger_probe enable trigger trigger_probe_before_update;
    alter event trigger event_trigger_probe enable;
  `);
  const restoredBindings = await observe();
  assert.equal(
    restoredBindings.review_datasets['trigger_bindings.all_non_internal']
      .payload_sha256,
    first.review_datasets['trigger_bindings.all_non_internal'].payload_sha256
  );
  assert.equal(
    restoredBindings.review_datasets['event_trigger_bindings.all'].payload_sha256,
    first.review_datasets['event_trigger_bindings.all'].payload_sha256
  );
  assert.equal(
    restoredBindings.composite_digest.payload_sha256,
    first.composite_digest.payload_sha256
  );

  assert.equal(Object.keys(first.review_datasets).length, 25);
  assert.equal(first.composite_digest.row_count, 25);
  assert.equal(first.composite_digest.review_rows.length, 25);
  for (const [name, value] of Object.entries(first.review_datasets)) {
    assert.equal(
      first.composite_digest.review_rows.some(row =>
        row[0] === 'cnyos-observation-dataset-digest/v1' &&
        row[1] === name && row[2] === value.row_count &&
        row[3] === value.payload_bytes && row[4] === value.payload_sha256
      ),
      true,
      `composite digest manifest omitted ${name}`
    );
  }

} finally {
  await db.close();
}

const missingRoleDb = new PGlite();
await missingRoleDb.waitReady;
try {
  await missingRoleDb.exec(`
    create function public.missing_role_probe()
    returns integer language sql immutable as 'select 1';
  `);
  await missingRoleDb.exec(`
    begin isolation level repeatable read read only;
    set local search_path = pg_catalog, pg_temp;
    ${outputGucSql}
    lock table pg_catalog.pg_proc,
      pg_catalog.pg_namespace,
      pg_catalog.pg_authid,
      pg_catalog.pg_auth_members,
      pg_catalog.pg_depend,
      pg_catalog.pg_extension,
      pg_catalog.pg_language,
      pg_catalog.pg_default_acl,
      pg_catalog.pg_aggregate
    in access share mode;
  `);
  const result = await missingRoleDb.query(captureSql);
  const observation = JSON.parse(
    result.rows[0].cnyos_public_routine_acl_observation
  );
  assertIndependentDigestOracle(observation);
  const effective = dataset(
    observation,
    'public_routines.all.effective_access'
  );
  assert.deepEqual(
    effective.review_rows.map(row => [row.role_name, row.role_exists]).sort(),
    [
      ['PUBLIC', true],
      ['anon', false],
      ['authenticated', false],
      ['service_role', false]
    ].sort(),
    'required effective rows must remain present when runtime roles are absent'
  );
  assert.equal(
    effective.review_rows
      .filter(row => row.role_name !== 'PUBLIC')
      .every(row =>
        row.schema_usage === false && row.function_execute === false &&
        row.invocable_through_public_schema === false
      ),
    true
  );
} finally {
  await missingRoleDb.exec('rollback;');
  await missingRoleDb.close();
}

console.log(
  'public routine ACL inventory contract passed ' +
  '(PostgreSQL 17 PGlite; extension-member classification is statically ' +
  'checked because the PGlite image has no relocatable public extension)'
);
