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
  /lock table pg_catalog\.pg_proc,[\s\S]*pg_catalog\.pg_aggregate\s+in access share mode;/
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
  'set local standard_conforming_strings = on;'
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
  "pg_catalog.current_setting('standard_conforming_strings')"
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
  "'runtime_role_graph.connected_routine_effective_diagnostics'",
  "'runtime_role_graph.connected_schema_effective_diagnostics'",
  "'function_default_acl.global_and_public_schema'",
  "'function_default_acl.future_public_execute'",
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
      pg_catalog.pg_aggregate
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
    standard_conforming_strings: 'on'
  });
  assert.deepEqual(second.observation_transaction.output_gucs, {
    client_encoding: 'UTF8',
    timezone: 'UTC',
    datestyle: 'ISO, YMD',
    intervalstyle: 'postgres',
    extra_float_digits: '3',
    bytea_output: 'hex',
    quote_all_identifiers: 'off',
    standard_conforming_strings: 'on'
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
  assert.equal(allSemantics.row_count, 4);
  assert.equal(appSemantics.row_count, 4);
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
  assert.equal(effective.row_count, 16);
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

  assert.equal(Object.keys(first.review_datasets).length, 20);
  assert.equal(first.composite_digest.row_count, 20);
  assert.equal(first.composite_digest.review_rows.length, 20);
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
