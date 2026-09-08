import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const migrationFiles = (await fs.readdir(migrationsDir))
  .filter(file => file.endsWith('.sql'))
  .sort();
const migrationEntries = await Promise.all(migrationFiles.map(async file => {
  const match = file.match(/^(\d{12,14})_([a-z0-9_]+)\.sql$/i);
  assert.ok(match, `canonical migration filename required: ${file}`);
  const source = await fs.readFile(path.join(migrationsDir, file));
  return {
    file,
    version: match[1],
    name: match[2],
    sha256: createHash('sha256').update(source).digest('hex')
  };
}));
const triggerSqlSource = await fs.readFile(
  path.join(root, 'supabase', 'manual', '202609060700_revoke_trigger_function_data_api_execute_candidate.sql'),
  'utf8'
);
const browserSqlSource = await fs.readFile(
  path.join(root, 'supabase', 'manual', '202609060710_close_browser_rpc_acl_drift_candidate.sql'),
  'utf8'
);
let triggerSql = triggerSqlSource;
let browserSql = browserSqlSource;
const triggerNotice = 'CNYOS_TRIGGER_FUNCTION_DATA_API_CHECKS_PASSED';
const browserNotice = 'CNYOS_BROWSER_RPC_ACL_DRIFT_CHECKS_PASSED';
const browserHelpers = [
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.clinical_financial_handoffs_healthcheck()',
  'public.department_persistence_healthcheck()',
  'public.production_execution_healthcheck()',
  'public.quality_release_healthcheck()',
  'public.prescription_dispensing_healthcheck()'
];
const browserWrites = [
  'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)',
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)'
];
const browserProcedures = [...browserHelpers, ...browserWrites];
const browserTransitionalTuples = [
  ['anon', 'public.book_clinic_appointment(uuid,uuid,text,text,text)'],
  ['anon', 'public.cancel_clinic_appointment(uuid,text)'],
  ['anon', 'public.clinical_financial_handoffs_healthcheck()'],
  ['anon', 'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)'],
  ['anon', 'public.current_user_role()'],
  ['anon', 'public.decide_approval_task(uuid,text,text)'],
  ['anon', 'public.department_persistence_healthcheck()'],
  ['anon', 'public.is_admin_or_super()'],
  ['anon', 'public.is_appointment_operator()'],
  ['anon', 'public.is_appointment_practitioner()'],
  ['anon', 'public.is_clinic_admin()'],
  ['anon', 'public.is_practitioner()'],
  ['anon', 'public.is_reception_or_admin()'],
  ['anon', 'public.prescription_dispensing_healthcheck()'],
  ['anon', 'public.production_execution_healthcheck()'],
  ['anon', 'public.quality_release_healthcheck()'],
  ['anon', 'public.set_clinic_appointment_status(uuid,text,text)'],
  ['service_role', 'public.book_clinic_appointment(uuid,uuid,text,text,text)'],
  ['service_role', 'public.cancel_clinic_appointment(uuid,text)'],
  ['service_role', 'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)'],
  ['service_role', 'public.decide_approval_task(uuid,text,text)'],
  ['service_role', 'public.set_clinic_appointment_status(uuid,text,text)']
];

assert.equal(migrationFiles.length, 45);
assert.equal((triggerSql.match(/do \$\$/g) || []).length, 1);
for (const [label, source] of [
  ['trigger', triggerSql],
  ['browser', browserSql]
]) {
  assert.match(source, /^-- This manual candidate is a psql program/);
  assert.match(source, /^\\set ON_ERROR_STOP 1$/m);
  assert.match(source, /^\\set ON_ERROR_ROLLBACK off$/m);
  assert.match(source, /^\\if :AUTOCOMMIT$/m);
  assert.match(source, /CNYOS_ACL_CANDIDATE_PSQL_AUTOCOMMIT_REQUIRED/);
  assert.match(source, /CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED/);
  assert.match(source, /select pg_catalog\.pg_current_xact_id\(\)::text as cnyos_acl_candidate_probe_xid/);
  assert.match(source, /pg_catalog\.pg_current_xact_id\(\)::text = :'cnyos_acl_candidate_probe_xid'/);
  assert.ok(
    source.indexOf('cnyos_acl_candidate_existing_transaction') <
      source.indexOf('-- CNYOS_ACL_SQL_ACQUISITION_BEGIN'),
    `${label} candidate must refuse an existing transaction before lock acquisition`
  );
  assert.match(source, /begin isolation level repeatable read read write;/);
  assert.match(source, /current_setting\('transaction_read_only'\) <> 'off'/);
  assert.equal(
    (source.match(/CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_ALREADY_HELD/g) || []).length,
    1,
    `${label} candidate must expose one same-session pre-held-key refusal`
  );
  assert.equal(
    (source.match(/lock_row\.pid = pg_catalog\.pg_backend_pid\(\)/g) || []).length,
    2,
    `${label} candidate must check its own holds before acquisition and after release`
  );
  const ownLockPrecondition = source.indexOf(
    "lock_row.pid = pg_catalog.pg_backend_pid()"
  );
  const tryLock = source.indexOf(
    'pg_catalog.pg_try_advisory_lock(202608302100::bigint)'
  );
  const tailUnlock = source.lastIndexOf(
    'pg_catalog.pg_advisory_unlock(202608302100::bigint)'
  );
  const residualHoldProof = source.indexOf(
    'lock_row.pid = pg_catalog.pg_backend_pid()',
    tailUnlock
  );
  assert.ok(
    ownLockPrecondition >= 0 && ownLockPrecondition < tryLock &&
      tryLock < tailUnlock && tailUnlock < residualHoldProof,
    `${label} candidate must reject a pre-held key and prove zero holds after tail unlock`
  );
  for (const setting of [
    "set local timezone = 'UTC';",
    "set local datestyle = 'ISO, YMD';",
    "set local intervalstyle = 'postgres';",
    'set local extra_float_digits = 3;',
    "set local bytea_output = 'hex';",
    'set local quote_all_identifiers = off;',
    'set local standard_conforming_strings = on;'
  ]) {
    assert.ok(source.includes(setting), `${label} candidate must pin ${setting}`);
  }
  for (const catalog of ['pg_type', 'pg_language', 'pg_operator', 'pg_collation']) {
    assert.match(source, new RegExp(`pg_catalog\\.${catalog}`));
  }
}
assert.match(triggerSql, /current_setting\('server_version_num'\)::integer \/ 10000 <> 17/);
assert.match(triggerSql, /current_setting\('server_encoding'\) <> 'UTF8'/);
assert.match(browserSql, /current_setting\('server_version_num'\)::integer \/ 10000 <> 17/);
assert.match(browserSql, /current_setting\('server_encoding'\) <> 'UTF8'/);
assert.match(triggerSql, /4c92389f247e80c27c63721eff19f321ed538c8e70d616df5aa36e193cb2eb0b/);
assert.match(triggerSql, /07535c64e7607d8cc9bc34b197a40e3923f4f56df84262d041d56541b1890737/);
assert.match(triggerSql, /9430970d3b25cbe3d5d4ab704740e62ce5a6864d9a804a732ed6f8919523fe54/);
assert.match(triggerSql, /7666007964130682852/);
assert.match(browserSql, /7666007964130682852/);
assert.doesNotMatch(triggerSql, /disposable-fixture|test_system_identifier|template1/i);
assert.doesNotMatch(browserSql, /disposable-fixture|test_system_identifier|template1/i);
assert.doesNotMatch(triggerSql, new RegExp(triggerNotice));
assert.doesNotMatch(browserSql, new RegExp(browserNotice));
assert.equal(browserTransitionalTuples.length, 22);
assert.equal(browserTransitionalTuples.filter(([role]) => role === 'anon').length, 17);
assert.equal(browserTransitionalTuples.filter(([role]) => role === 'service_role').length, 5);

const quoteSql = value => `'${String(value).replaceAll("'", "''")}'`;
const ledgerEvidence = entry =>
  `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
const ledgerTuple = entry => {
  const evidence = ledgerEvidence(entry);
  return `(${quoteSql(entry.version)},${quoteSql(entry.name)},array[${quoteSql(evidence)}]::text[])`;
};
const ledgerValues = migrationEntries.map(ledgerTuple).join(',\n');

async function setHostileOutputGucs(db) {
  await db.exec(`
    set timezone = 'Asia/Bangkok';
    set datestyle = 'German, DMY';
    set intervalstyle = 'sql_standard';
    set extra_float_digits = -1;
    set bytea_output = 'escape';
    set quote_all_identifiers = on;
    set standard_conforming_strings = off;
  `);
}

async function resetOutputGucs(db) {
  await db.exec(`
    reset timezone;
    reset datestyle;
    reset intervalstyle;
    reset extra_float_digits;
    reset bytea_output;
    reset quote_all_identifiers;
    reset standard_conforming_strings;
  `);
}

async function installCandidateClinicMarker(db) {
  await db.exec(`
    create table if not exists public.clinics (
      id uuid primary key,
      code text not null unique,
      name_th text not null,
      name_en text,
      active boolean not null default true
    );
    delete from public.clinics;
    insert into public.clinics(id,code,name_th,name_en,active) values (
      '00000000-0000-4000-8000-00000000c700',
      'CNYOS-ACL-DISPOSABLE','ACL disposable fixture','ACL disposable fixture',true
    );
  `);
}

async function installCandidateLedger(db) {
  await db.exec(`
    create schema if not exists supabase_migrations;
    create table supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values ${ledgerValues};
    create table supabase_migrations.cnyos_migration_ledger_repair_receipts (
      run_nonce uuid primary key,
      gate_token text not null,
      repair_xid text not null,
      committed_at timestamptz not null default clock_timestamp(),
      evidence jsonb not null
    );
  `);
  const systemIdentifier = (await db.query(
    'select system_identifier::text from pg_catalog.pg_control_system()'
  )).rows[0].system_identifier;
  const databaseName = (await db.query(
    'select current_database() database_name'
  )).rows[0].database_name;
  const runNonce = '00000000-0000-4000-8000-00000000c745';
  const gateToken = 'a'.repeat(64);
  const repairXid = '745';
  await db.query(`
    insert into supabase_migrations.cnyos_migration_ledger_repair_receipts(
      run_nonce,gate_token,repair_xid,evidence
    ) values ($1,$2,$3,$4::jsonb)
  `, [runNonce, gateToken, repairXid, JSON.stringify({
    status: 'CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING',
    repair_gate_token: gateToken,
    repair_run_nonce: runNonce,
    repair_transaction_xid: repairXid,
    expected_project_ref: testTargetMarkers.project_ref,
    expected_deployment_id: testTargetMarkers.deployment_id,
    expected_clinic_id: testTargetMarkers.clinic_id,
    expected_clinic_code: testTargetMarkers.clinic_code,
    expected_current_database: databaseName,
    observed_current_database: databaseName,
    expected_system_identifier: systemIdentifier,
    observed_system_identifier: systemIdentifier,
    acl_phase: 'chananya-pre-reconciliation',
    migration_manifest_sha256: 'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a',
    migration_count: 45,
    ledger_reconciled: true,
    acl_remediation_pending: true,
    browser_rpc_acl_remediation_pending: true,
    trigger_function_acl_remediation_pending: true,
    production_eligible: false,
    source_revision: 'a'.repeat(40)
  })]);
}

const testTargetMarkers = {
  project_ref: 'pglite-disposable-fixture',
  deployment_id: 'acl-candidate-disposable-fixture',
  environment: 'test',
  clinic_id: '00000000-0000-4000-8000-00000000c700',
  clinic_code: 'CNYOS-ACL-DISPOSABLE'
};
async function setCandidateAuthorization(db, kind, {
  authorization,
  markers = testTargetMarkers
} = {}) {
  const stem = kind === 'trigger' ? 'trigger_acl' : 'browser_rpc_acl';
  const defaultAuthorization = kind === 'trigger'
    ? 'cnyos-trigger-acl-candidate-disposable-fixture-only'
    : 'cnyos-browser-rpc-acl-candidate-disposable-fixture-only';
  const settings = {
    [`cnyos.${stem}_candidate_authorization`]: authorization ?? defaultAuthorization,
    [`cnyos.${stem}_target_project_ref`]: markers.project_ref ?? '',
    [`cnyos.${stem}_target_deployment_id`]: markers.deployment_id ?? '',
    [`cnyos.${stem}_target_environment`]: markers.environment ?? '',
    [`cnyos.${stem}_target_clinic_id`]: markers.clinic_id ?? '',
    [`cnyos.${stem}_target_clinic_code`]: markers.clinic_code ?? ''
  };
  for (const [name, value] of Object.entries(settings)) {
    await db.query('select pg_catalog.set_config($1,$2,false)', [name, value]);
  }
}

async function materializeCandidateForDisposableFixture(db, sql, kind, {
  systemIdentifier,
  enableProjectedCanonicalFixture = false
} = {}) {
  const actualSystemIdentifier = systemIdentifier ?? (await db.query(
    'select system_identifier::text from pg_catalog.pg_control_system()'
  )).rows[0].system_identifier;
  const actualDatabaseName = (await db.query(
    'select current_database() database_name'
  )).rows[0].database_name;
  const productionAuthorization = kind === 'trigger'
    ? 'chananya-staging-trigger-acl-candidate-202609060700-reconciled-45'
    : 'chananya-staging-browser-rpc-acl-candidate-202609060710-reconciled-45';
  const fixtureAuthorization = kind === 'trigger'
    ? 'cnyos-trigger-acl-candidate-disposable-fixture-only'
    : 'cnyos-browser-rpc-acl-candidate-disposable-fixture-only';
  const replacements = [
    [productionAuthorization, fixtureAuthorization, 1],
    ['7666007964130682852', actualSystemIdentifier, 1],
    ["current_database() <> 'postgres'", `current_database() <> ${quoteSql(actualDatabaseName)}`, 1],
    ['hsmnjwxurlmsizndjlun', testTargetMarkers.project_ref, 1],
    ['chananya-clinical-staging', testTargetMarkers.deployment_id, 1],
    ["'staging'", quoteSql(testTargetMarkers.environment), 1],
    ['00000000-0000-4000-8000-00000000a001', testTargetMarkers.clinic_id, 2],
    ['CHANANYA-STG', testTargetMarkers.clinic_code, 2]
  ];
  let materialized = sql;
  for (const [reviewed, fixture, expectedCount] of replacements) {
    assert.equal(
      materialized.split(reviewed).length - 1,
      expectedCount,
      `reviewed ${kind} target literal count changed: ${reviewed}`
    );
    materialized = materialized.replaceAll(reviewed, fixture);
  }
  if (enableProjectedCanonicalFixture) {
    const gate = kind === 'trigger'
      ? 'CNYOS_TRIGGER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED'
      : 'CNYOS_BROWSER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED';
    const gateStatement = `raise exception '${gate}';`;
    assert.equal(materialized.split(gateStatement).length - 1, 1);
    materialized = materialized.replace(
      gateStatement,
      'perform 1; -- CNYOS_PROJECTED_CANONICAL_FIXTURE_ONLY'
    );
    if (kind === 'browser') {
      const publicRoutineScope = "where function_namespace.nspname='public'";
      assert.equal(materialized.split(publicRoutineScope).length - 1, 4);
      materialized = materialized.replaceAll(
        publicRoutineScope,
        `${publicRoutineScope}\n` +
        `      and procedure.oid not in (\n` +
        `        to_regprocedure('public.gen_random_uuid()'),\n` +
        `        to_regprocedure('public.gen_random_bytes(integer)'),\n` +
        `        to_regprocedure('public.digest(text,text)')\n` +
        `      ) -- CNYOS_PGLITE_CRYPTO_FIXTURE_ONLY`
      );
    }
  }
  return materialized;
}

function candidateParts(sql) {
  const acquisitionMarker = '-- CNYOS_ACL_SQL_ACQUISITION_BEGIN\n';
  const acquisitionStart = sql.indexOf(acquisitionMarker);
  const start = sql.indexOf('do $$\n');
  const end = sql.indexOf('\nend $$;', start) + '\nend $$;'.length;
  const transactionMatch = sql.match(
    /begin isolation level repeatable read read (?:write|only);/
  );
  const transactionStart = transactionMatch?.index ?? -1;
  assert.ok(acquisitionStart >= 0 && start > acquisitionStart && end > start);
  assert.ok(transactionStart > 0 && transactionStart < start);
  assert.equal((sql.match(/do \$\$/g) || []).length, 1);
  const suffix = sql.slice(end).trim();
  assert.match(
    suffix,
    /^commit;\n\ndo \$cnyos_acl_interlock\$[\s\S]+CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED[\s\S]+\$cnyos_acl_interlock\$;$/
  );
  const releaseStart = suffix.indexOf('do $cnyos_acl_interlock$');
  return {
    preflight: sql.slice(0, acquisitionStart),
    acquisition: sql.slice(acquisitionStart + acquisitionMarker.length, transactionStart),
    prefix: sql.slice(transactionStart, start),
    statement: sql.slice(start, end),
    commit: suffix.slice(0, releaseStart),
    release: suffix.slice(releaseStart)
  };
}

function forceReadOnlyCandidate(sql) {
  const readWriteBegin = 'begin isolation level repeatable read read write;';
  assert.equal(
    sql.split(readWriteBegin).length - 1,
    1,
    'candidate must expose one exact read-write transaction declaration'
  );
  return sql.replace(
    readWriteBegin,
    'begin isolation level repeatable read read only;'
  );
}

async function executeProjectedCandidate(db, sql, options = {}) {
  const { acquisition, prefix, statement, commit, release } = candidateParts(sql);
  await db.exec(acquisition, options);
  await db.exec(prefix, options);
  await db.exec(statement, options);
  await db.exec(commit, options);
  await db.exec(release, options);
}

async function assertProductionSourceGate(db, sql, expectedError, snapshot) {
  const { acquisition, prefix, statement, commit, release } = candidateParts(sql);
  for (const useSavepoint of [false, true]) {
    const before = await snapshot(db);
    const beforeSearchPath = (await db.query('show search_path')).rows[0].search_path;
    const notices = [];
    const options = { onNotice: notice => notices.push(notice.message) };
    await db.exec(acquisition, options);
    await db.exec(prefix, options);
    if (useSavepoint) await db.exec('savepoint source_gate_client_statement;');
    await assert.rejects(db.exec(statement, options), expectedError);
    if (useSavepoint) {
      await db.exec('rollback to savepoint source_gate_client_statement;');
    }
    await db.exec(commit, options);
    await assert.rejects(
      db.exec(release, options),
      /CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED/,
      'the source gate must release the session advisory lock before rethrowing'
    );
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await db.query('show search_path')).rows[0].search_path, beforeSearchPath);
    assert.equal(notices.filter(message => /CHECKS_PASSED/.test(message)).length, 0);
    await assertNoSessionAdvisoryLocks(db);
  }
}

// Exercise both ordinary continue-on-error clients and clients that wrap each
// statement in a savepoint. In either mode a failing DO must leave no partial
// revokes/settings and must never emit success-shaped output.
async function assertAtomicFailure(db, sql, expectedError, noticePrefix, snapshot) {
  const { acquisition, prefix, statement, commit, release } = candidateParts(sql);
  for (const useSavepoint of [false, true]) {
    const before = await snapshot(db);
    const notices = [];
    const options = { onNotice: notice => notices.push(notice.message) };
    let prefixFailure = null;
    try {
      await db.exec(acquisition, options);
      await db.exec(prefix, options);
    } catch (error) {
      prefixFailure = error;
    }
    if (prefixFailure) {
      assert.match(prefixFailure.message, expectedError);
      await db.exec('rollback;', options).catch(() => {});
      await db.exec(release, options);
    } else {
      if (useSavepoint) await db.exec('savepoint client_statement;');
      let statementFailure = null;
      try {
        await db.exec(statement, options);
      } catch (error) {
        statementFailure = error;
      }
      assert.ok(statementFailure, 'candidate statement must fail closed');
      assert.match(statementFailure.message, expectedError);
      if (useSavepoint) await db.exec('rollback to savepoint client_statement;');
      await db.exec(commit, options);
      await assert.rejects(
        db.exec(release, options),
        /CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED/
      );
    }
    assert.deepEqual(
      await snapshot(db),
      before,
      'a failed candidate must preserve the complete reviewed catalog state'
    );
    assert.ok(
      !notices.some(message => message.startsWith(noticePrefix)),
      'a failed candidate must not report success'
    );
  }
}

async function assertDeferredCommitFailure(db, sql, noticePrefix, snapshot) {
  const { acquisition, prefix, statement, release } = candidateParts(sql);
  const before = await snapshot(db);
  const notices = [];
  const options = { onNotice: notice => notices.push(notice.message) };
  await db.exec(acquisition, options);
  await db.exec(prefix, options);
  try {
    await db.exec(`
      create temp table cnyos_deferred_commit_failure_probe(
        value integer,
        constraint cnyos_deferred_commit_failure_unique
          unique(value) deferrable initially deferred
      ) on commit drop;
      insert into cnyos_deferred_commit_failure_probe(value) values (1),(1);
    `, options);
    await db.exec(statement, options);
    await assert.rejects(db.exec('commit;', options), /duplicate key value|unique constraint/i);
    await db.exec(release, options);
  } catch (error) {
    await db.exec('rollback;').catch(() => {});
    throw error;
  }
  assert.deepEqual(
    await snapshot(db),
    before,
    'a deferred COMMIT failure must roll back the complete candidate mutation'
  );
  assert.ok(
    !notices.some(message => message.startsWith(noticePrefix)),
    'a deferred COMMIT failure must produce zero success-shaped output'
  );
}

async function assertNoSessionAdvisoryLocks(db) {
  assert.equal(
    (await db.query(`
      select count(*)::int count
      from pg_catalog.pg_locks
      where locktype='advisory'
        and classid::bigint=(202608302100::bigint >> 32)
        and objid::bigint=(202608302100::bigint & 4294967295::bigint)
        and objsubid=1
    `)).rows[0].count,
    0,
    'candidate must release its session advisory interlock'
  );
}

async function assertPreheldInterlockRefusal(db, sql, snapshot) {
  const { acquisition } = candidateParts(sql);
  const nativePidPredicate = 'lock_row.pid = pg_catalog.pg_backend_pid()';
  assert.equal(
    acquisition.split(nativePidPredicate).length - 1,
    1,
    'candidate acquisition must expose one same-session PID predicate'
  );
  // PGlite exposes emulated advisory locks in pg_locks with a null PID. The
  // production source keeps the native pg_backend_pid() predicate; this
  // test-only substitution lets the same precondition branch run in PGlite.
  const pgliteAcquisition = acquisition.replace(
    nativePidPredicate,
    'lock_row.pid is null -- CNYOS_PGLITE_ADVISORY_PID_FIXTURE_ONLY'
  );
  const before = await snapshot(db);
  await db.exec('select pg_catalog.pg_advisory_lock(202608302100::bigint);');
  try {
    await assert.rejects(
      db.exec(pgliteAcquisition),
      /CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_ALREADY_HELD/
    );
    assert.deepEqual(
      await snapshot(db),
      before,
      'same-session pre-held-key refusal must not change candidate state'
    );
    assert.equal(
      (await db.query(`
        select count(*)::int count
        from pg_catalog.pg_locks
        where locktype='advisory'
          and classid::bigint=(202608302100::bigint >> 32)
          and objid::bigint=(202608302100::bigint & 4294967295::bigint)
          and objsubid=1
      `)).rows[0].count,
      1,
      'candidate refusal must not add a reentrant hold or release the caller hold'
    );
  } finally {
    const released = (await db.query(`
      select pg_catalog.pg_advisory_unlock(202608302100::bigint) released
    `)).rows[0].released;
    assert.equal(released, true, 'test must release its pre-held advisory key');
  }
  await assertNoSessionAdvisoryLocks(db);
}

async function loadCanonicalMigrationFixture(db) {
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
  for (const file of migrationFiles) {
    const source = (await fs.readFile(path.join(migrationsDir, file), 'utf8'))
      .replace(/create extension if not exists pgcrypto\s*;/gi, '');
    await db.exec(source);
  }
}

async function triggerFunctionState(db) {
  return (await db.query(`
    select procedure.oid,procedure.proowner,procedure.proacl::text,
           procedure.proconfig,procedure.prosrc,procedure.probin,
           procedure.provolatile,procedure.proparallel,procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where exists (
      select 1
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
      join pg_catalog.pg_namespace relation_namespace
        on relation_namespace.oid=relation.relnamespace
      join pg_catalog.pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
      join pg_catalog.pg_namespace bound_function_namespace
        on bound_function_namespace.oid=bound_procedure.pronamespace
      where trigger.tgfoid=procedure.oid
        and not trigger.tgisinternal
        and (
          relation_namespace.nspname='public'
          or (relation_namespace.nspname='auth' and relation.relname='users')
          or bound_function_namespace.nspname='public'
        )
    )
    order by procedure.oid
  `)).rows;
}

async function triggerBindingState(db) {
  return (await db.query(`
    select trigger.oid,trigger.tgrelid,trigger.tgfoid,trigger.tgname,
           trigger.tgenabled,trigger.tgtype,trigger.tgattr::text,
           trigger.tgnargs,encode(trigger.tgargs,'hex') tgargs,
           trigger.tgdeferrable,trigger.tginitdeferred,
           pg_get_expr(trigger.tgqual,trigger.tgrelid,true) tgqual,
           trigger.tgoldtable,trigger.tgnewtable,trigger.tgconstraint,
           trigger.tgconstrrelid,trigger.tgconstrindid,trigger.tgparentid
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid=relation.relnamespace
    join pg_catalog.pg_proc procedure on procedure.oid=trigger.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where not trigger.tgisinternal
      and (
        relation_namespace.nspname='public'
        or (relation_namespace.nspname='auth' and relation.relname='users')
        or function_namespace.nspname='public'
      )
    order by trigger.oid
  `)).rows;
}

async function triggerSnapshot(db) {
  const [functions, bindings] = await Promise.all([
    triggerFunctionState(db),
    triggerBindingState(db)
  ]);
  return { functions, bindings };
}

async function browserSnapshot(db) {
  return (await db.query(`
    select procedure.oid,procedure.proowner,procedure.proacl::text,
           procedure.proconfig,procedure.prosrc,procedure.probin,
           procedure.provolatile,procedure.proparallel,procedure.prosecdef
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
    order by procedure.oid
  `)).rows;
}

const triggerDb = new PGlite();
// Model the psql adjacent-XID guard with a durable caller write. Detection must
// roll back the caller transaction before any candidate lock/BEGIN/COMMIT can
// run, so even a wrapper that would otherwise continue cannot commit that row.
await triggerDb.exec(
  'create table public.cnyos_acl_outer_write_probe(value integer primary key);'
);
await triggerDb.exec(`
  begin;
  insert into public.cnyos_acl_outer_write_probe(value) values (1);
`);
const firstAclOuterProbeXid = (await triggerDb.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
const secondAclOuterProbeXid = (await triggerDb.query(
  'select pg_catalog.pg_current_xact_id()::text xid'
)).rows[0].xid;
assert.equal(
  firstAclOuterProbeXid,
  secondAclOuterProbeXid,
  'an existing caller transaction must be visible to the ACL psql XID probe'
);
await triggerDb.exec('rollback;');
assert.equal(
  (await triggerDb.query(
    'select count(*)::int count from public.cnyos_acl_outer_write_probe'
  )).rows[0].count,
  0,
  'outer-transaction refusal must roll back a pre-existing caller write'
);
await triggerDb.exec('drop table public.cnyos_acl_outer_write_probe;');

const triggerProductionSql = await materializeCandidateForDisposableFixture(
  triggerDb, triggerSqlSource, 'trigger'
);
triggerSql = await materializeCandidateForDisposableFixture(
  triggerDb, triggerSqlSource, 'trigger',
  { enableProjectedCanonicalFixture: true }
);
try {
  await loadCanonicalMigrationFixture(triggerDb);
  await installCandidateClinicMarker(triggerDb);
  await installCandidateLedger(triggerDb);
  await assertPreheldInterlockRefusal(
    triggerDb,
    triggerProductionSql,
    triggerSnapshot
  );
  await assertProductionSourceGate(
    triggerDb,
    triggerProductionSql,
    /CNYOS_TRIGGER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED/,
    triggerSnapshot
  );
  assert.deepEqual(
    (await triggerDb.query(`
      select current_setting('server_version_num')::integer / 10000 major,
             current_setting('server_encoding') encoding
    `)).rows[0],
    { major: 17, encoding: 'UTF8' }
  );
  assert.equal((await triggerFunctionState(triggerDb)).length, 23);
  assert.equal((await triggerBindingState(triggerDb)).length, 168);
  assert.equal(
    (await triggerDb.query(`
      select count(*)::int count
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
      where not trigger.tgisinternal
        and namespace.nspname='auth' and relation.relname='users'
    `)).rows[0].count,
    1,
    'auth.users must be in the relation-centric review scope'
  );

  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_AUTHORIZATION_REQUIRED/,
    triggerNotice,
    triggerSnapshot
  );
  await setCandidateAuthorization(triggerDb, 'trigger', { authorization: 'wrong' });
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_AUTHORIZATION_INVALID/,
    triggerNotice,
    triggerSnapshot
  );

  await setCandidateAuthorization(triggerDb, 'trigger');

  await assertAtomicFailure(
    triggerDb,
    forceReadOnlyCandidate(triggerSql),
    /CNYOS_TRIGGER_CANDIDATE_READ_WRITE_REQUIRED/,
    triggerNotice,
    triggerSnapshot
  );

  const wrongSystemTriggerSql = await materializeCandidateForDisposableFixture(
    triggerDb,
    await fs.readFile(
      path.join(root, 'supabase', 'manual', '202609060700_revoke_trigger_function_data_api_execute_candidate.sql'),
      'utf8'
    ),
    'trigger',
    { systemIdentifier: '0', enableProjectedCanonicalFixture: true }
  );
  await setCandidateAuthorization(triggerDb, 'trigger');
  await assertAtomicFailure(
    triggerDb,
    wrongSystemTriggerSql,
    /CNYOS_TRIGGER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID/,
    triggerNotice,
    triggerSnapshot
  );

  for (const marker of Object.keys(testTargetMarkers)) {
    await setCandidateAuthorization(triggerDb, 'trigger', {
      markers: { ...testTargetMarkers, [marker]: '' }
    });
    await assertAtomicFailure(
      triggerDb,
      triggerSql,
      /CNYOS_TRIGGER_CANDIDATE_TARGET_MARKERS_INVALID/,
      triggerNotice,
      triggerSnapshot
    );
  }
  await setCandidateAuthorization(triggerDb, 'trigger');

  await triggerDb.exec(`
    update public.clinics set code='WRONG-CLINIC'
    where id='00000000-0000-4000-8000-00000000c700'
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_CLINIC_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    update public.clinics set code='CNYOS-ACL-DISPOSABLE'
    where id='00000000-0000-4000-8000-00000000c700'
  `);

  const missingLedgerEntry = migrationEntries.at(-1);
  await triggerDb.query(
    'delete from supabase_migrations.schema_migrations where version=$1',
    [missingLedgerEntry.version]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values ${ledgerTuple(missingLedgerEntry)}
  `);

  const firstLedgerEntry = migrationEntries[0];
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array['select 1']::text[] where version=$1`,
    [firstLedgerEntry.version]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2]::text[] where version=$1`,
    [firstLedgerEntry.version, ledgerEvidence(firstLedgerEntry)]
  );

  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set name=$2 where version=$1`,
    [firstLedgerEntry.version, migrationEntries[1].name]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set name=$2 where version=$1`,
    [firstLedgerEntry.version, firstLedgerEntry.name]
  );

  const secondLedgerEntry = migrationEntries[1];
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set name=case version when $1 then $4 when $2 then $3 end
     where version in ($1,$2)`,
    [
      firstLedgerEntry.version,
      secondLedgerEntry.version,
      firstLedgerEntry.name,
      secondLedgerEntry.name
    ]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set name=case version when $1 then $3 when $2 then $4 end
     where version in ($1,$2)`,
    [
      firstLedgerEntry.version,
      secondLedgerEntry.version,
      firstLedgerEntry.name,
      secondLedgerEntry.name
    ]
  );

  const originalEvidence = ledgerEvidence(firstLedgerEntry);
  const wrongHashEvidence = originalEvidence.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2]::text[] where version=$1`,
    [firstLedgerEntry.version, wrongHashEvidence]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2,'select 1']::text[] where version=$1`,
    [firstLedgerEntry.version, originalEvidence]
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2]::text[] where version=$1`,
    [firstLedgerEntry.version, originalEvidence]
  );

  await triggerDb.exec('create role rogue_trigger_owner; alter function public.handle_new_user() owner to rogue_trigger_owner;');
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_OWNER_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec('alter function public.handle_new_user() owner to postgres; drop role rogue_trigger_owner;');

  const originalHandleNewUser = (await triggerDb.query(
    "select pg_get_functiondef('public.handle_new_user()'::regprocedure) definition"
  )).rows[0].definition;
  assert.match(originalHandleNewUser, /return new;/i);
  await triggerDb.exec(originalHandleNewUser.replace(/return new;/i, 'perform 1; return new;'));
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_SEMANTICS_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(originalHandleNewUser);

  await triggerDb.exec('alter function public.handle_new_user() stable;');
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_SEMANTICS_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec('alter function public.handle_new_user() volatile;');

  const reviewedTriggerCost = Number((await triggerDb.query(`
    select procost::text cost
    from pg_catalog.pg_proc
    where oid='public.handle_new_user()'::regprocedure
  `)).rows[0].cost);
  await triggerDb.exec(`
    set extra_float_digits = -1;
    alter function public.handle_new_user() cost ${reviewedTriggerCost + 0.001};
  `);
  assert.equal(
    (await triggerDb.query(`
      select procost::text cost
      from pg_catalog.pg_proc
      where oid='public.handle_new_user()'::regprocedure
    `)).rows[0].cost,
    String(reviewedTriggerCost),
    'hostile float formatting must mask the small drift outside the candidate'
  );
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_SEMANTICS_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    alter function public.handle_new_user() cost ${reviewedTriggerCost};
    reset extra_float_digits;
  `);

  await triggerDb.exec(`
    create schema rogue_trigger_schema;
    create function rogue_trigger_schema.foreign_guard()
    returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger rogue_foreign_function_binding
    before insert on public.audit_logs
    for each row execute function rogue_trigger_schema.foreign_guard()
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_SCHEMA_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    drop trigger rogue_foreign_function_binding on public.audit_logs;
    drop schema rogue_trigger_schema cascade;
  `);

  // A public trigger function remains in scope even when its relation is in an
  // otherwise unreviewed schema; this exercises the third arm of the union.
  await triggerDb.exec(`
    create schema private_trigger_scope;
    create table private_trigger_scope.acl_probe(updated_at timestamptz);
    create trigger public_function_on_private_relation
    before update on private_trigger_scope.acl_probe
    for each row execute function public.set_updated_at()
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_BINDING_SNAPSHOT_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec('drop schema private_trigger_scope cascade;');

  await triggerDb.exec(`
    drop trigger stock_movement_apply on public.stock_movements;
    drop trigger trg_assign_audit_clinic on public.audit_logs;
    create trigger stock_movement_apply
    after insert on public.stock_movements
    for each row execute function public.assign_audit_clinic();
    create trigger trg_assign_audit_clinic
    before insert on public.audit_logs
    for each row execute function public.apply_stock_movement()
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_BINDING_SNAPSHOT_INVALID/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    drop trigger stock_movement_apply on public.stock_movements;
    drop trigger trg_assign_audit_clinic on public.audit_logs;
    create trigger stock_movement_apply
    after insert on public.stock_movements
    for each row execute function public.apply_stock_movement();
    create trigger trg_assign_audit_clinic
    before insert on public.audit_logs
    for each row execute function public.assign_audit_clinic()
  `);

  await triggerDb.exec(`
    create role inherited_trigger_executor;
    grant execute on function public.handle_new_user() to inherited_trigger_executor;
    grant inherited_trigger_executor to authenticated;
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    revoke inherited_trigger_executor from authenticated;
    revoke execute on function public.handle_new_user() from inherited_trigger_executor;
    drop role inherited_trigger_executor;
  `);

  await triggerDb.exec(`
    create role rogue_trigger_executor;
    grant execute on function public.handle_new_user() to rogue_trigger_executor;
  `);
  await assertAtomicFailure(
    triggerDb,
    triggerSql,
    /CNYOS_TRIGGER_FUNCTION_NONOWNER_ACL_PRESENT/,
    triggerNotice,
    triggerSnapshot
  );
  await triggerDb.exec(`
    revoke execute on function public.handle_new_user() from rogue_trigger_executor;
    drop role rogue_trigger_executor;
  `);

  await assertDeferredCommitFailure(
    triggerDb,
    triggerSql,
    triggerNotice,
    triggerSnapshot
  );

  const beforeBindings = await triggerBindingState(triggerDb);
  await triggerDb.exec(`
    create temp table pg_proc(blocker integer);
    create temp table pg_namespace(blocker integer);
    create temp table pg_trigger(blocker integer);
    create temp table pg_roles(blocker integer);
  `);
  await setHostileOutputGucs(triggerDb);
  const notices = [];
  await executeProjectedCandidate(triggerDb, triggerSql, {
    onNotice: notice => notices.push(notice.message)
  });
  await resetOutputGucs(triggerDb);
  assert.equal(notices.filter(message => message.startsWith(triggerNotice)).length, 0);
  await assertNoSessionAdvisoryLocks(triggerDb);
  await triggerDb.exec(`
    drop table pg_temp.pg_proc;
    drop table pg_temp.pg_namespace;
    drop table pg_temp.pg_trigger;
    drop table pg_temp.pg_roles;
  `);
  assert.deepEqual(await triggerBindingState(triggerDb), beforeBindings);
  assert.equal((await triggerFunctionState(triggerDb)).length, 23);
  assert.equal((await triggerBindingState(triggerDb)).length, 168);

  const ownerRows = (await triggerDb.query(`
    select distinct owner_role.rolname owner
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
    where exists (
      select 1
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
      join pg_catalog.pg_namespace relation_namespace
        on relation_namespace.oid=relation.relnamespace
      join pg_catalog.pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
      join pg_catalog.pg_namespace bound_function_namespace
        on bound_function_namespace.oid=bound_procedure.pronamespace
      where trigger.tgfoid=procedure.oid
        and not trigger.tgisinternal
        and (
          relation_namespace.nspname='public'
          or (relation_namespace.nspname='auth' and relation.relname='users')
          or bound_function_namespace.nspname='public'
        )
    )
  `)).rows;
  assert.deepEqual(ownerRows, [{ owner: 'postgres' }]);
  assert.deepEqual(
    (await triggerDb.query(`
      select procedure.proconfig
      from pg_catalog.pg_proc procedure
      where procedure.oid='public.set_updated_at()'::regprocedure
    `)).rows[0].proconfig,
    ['search_path=pg_catalog, public']
  );

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const remaining = (await triggerDb.query(`
      select count(*)::int count
      from pg_catalog.pg_proc procedure
      where exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
        join pg_catalog.pg_namespace relation_namespace
          on relation_namespace.oid=relation.relnamespace
        join pg_catalog.pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
        join pg_catalog.pg_namespace bound_function_namespace
          on bound_function_namespace.oid=bound_procedure.pronamespace
        where trigger.tgfoid=procedure.oid
          and not trigger.tgisinternal
          and (
            relation_namespace.nspname='public'
            or (relation_namespace.nspname='auth' and relation.relname='users')
            or bound_function_namespace.nspname='public'
          )
      )
        and has_function_privilege($1,procedure.oid,'EXECUTE')
    `, [role])).rows[0].count;
    assert.equal(remaining, 0, `${role} must not effectively execute a reviewed trigger function`);
  }

  assert.equal(
    (await triggerDb.query(`
      select count(*)::int count
      from pg_catalog.pg_proc procedure
      cross join lateral pg_catalog.aclexplode(
        coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))
      ) acl
      where acl.grantee <> procedure.proowner
        and exists (
          select 1
          from pg_catalog.pg_trigger trigger
          join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
          join pg_catalog.pg_namespace relation_namespace
            on relation_namespace.oid=relation.relnamespace
          join pg_catalog.pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
          join pg_catalog.pg_namespace bound_function_namespace
            on bound_function_namespace.oid=bound_procedure.pronamespace
          where trigger.tgfoid=procedure.oid
            and not trigger.tgisinternal
            and (
              relation_namespace.nspname='public'
              or (relation_namespace.nspname='auth' and relation.relname='users')
              or bound_function_namespace.nspname='public'
            )
        )
    `)).rows[0].count,
    0
  );

  // Trigger invocation is ACL-independent: runtime roles can still mutate a
  // permitted relation through set_updated_at(), but cannot call it as RPC.
  await triggerDb.exec(`
    grant usage on schema public to anon,authenticated,service_role;
    create table public.acl_probe(
      id integer primary key,
      value integer,
      updated_at timestamptz
    );
    grant select,insert,update on public.acl_probe to anon,authenticated,service_role;
    create trigger acl_probe_timestamp
    before insert or update on public.acl_probe
    for each row execute function public.set_updated_at()
  `);
  for (const [index, role] of ['anon', 'authenticated', 'service_role'].entries()) {
    await triggerDb.exec(`
      set role ${role};
      insert into public.acl_probe(id,value) values (${index + 1},1);
      update public.acl_probe set value=2 where id=${index + 1};
    `);
    await assert.rejects(
      triggerDb.exec('select public.set_updated_at();'),
      /permission denied for function set_updated_at/
    );
    await triggerDb.exec('reset role;');
  }
  assert.equal(
    (await triggerDb.query(
      'select count(*)::int count from public.acl_probe where value=2 and updated_at is not null'
    )).rows[0].count,
    3
  );
} finally {
  await triggerDb.close();
}

const browserDb = new PGlite();
const browserProductionSql = await materializeCandidateForDisposableFixture(
  browserDb, browserSqlSource, 'browser'
);
browserSql = await materializeCandidateForDisposableFixture(
  browserDb, browserSqlSource, 'browser',
  { enableProjectedCanonicalFixture: true }
);
const browserTriggerSql = await materializeCandidateForDisposableFixture(
  browserDb, triggerSqlSource, 'trigger',
  { enableProjectedCanonicalFixture: true }
);
try {
  await loadCanonicalMigrationFixture(browserDb);
  await installCandidateClinicMarker(browserDb);
  await installCandidateLedger(browserDb);
  await assertPreheldInterlockRefusal(
    browserDb,
    browserProductionSql,
    browserSnapshot
  );
  await assertProductionSourceGate(
    browserDb,
    browserProductionSql,
    /CNYOS_BROWSER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED/,
    browserSnapshot
  );
  assert.equal(
    (await browserDb.query(`
      select count(*)::int count
      from pg_catalog.pg_proc
      where oid=any($1::regprocedure[])
    `, [browserProcedures])).rows[0].count,
    20,
    'all browser candidate implementations must come from the canonical 45 migrations'
  );
  assert.ok(
    (await browserDb.query(`
      select count(distinct procedure.prosrc)::int count
      from pg_catalog.pg_proc procedure
      where procedure.oid=any($1::regprocedure[])
    `, [browserProcedures])).rows[0].count > 10,
    'success coverage must not substitute dummy boolean implementations'
  );

  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_CANDIDATE_AUTHORIZATION_REQUIRED/,
    browserNotice,
    browserSnapshot
  );
  await setCandidateAuthorization(browserDb, 'browser', { authorization: 'wrong' });
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_CANDIDATE_AUTHORIZATION_INVALID/,
    browserNotice,
    browserSnapshot
  );

  await setCandidateAuthorization(browserDb, 'browser');

  await assertAtomicFailure(
    browserDb,
    forceReadOnlyCandidate(browserSql),
    /CNYOS_BROWSER_CANDIDATE_READ_WRITE_REQUIRED/,
    browserNotice,
    browserSnapshot
  );

  const wrongSystemBrowserSql = await materializeCandidateForDisposableFixture(
    browserDb,
    await fs.readFile(
      path.join(root, 'supabase', 'manual', '202609060710_close_browser_rpc_acl_drift_candidate.sql'),
      'utf8'
    ),
    'browser',
    { systemIdentifier: '0', enableProjectedCanonicalFixture: true }
  );
  await setCandidateAuthorization(browserDb, 'browser');
  await assertAtomicFailure(
    browserDb,
    wrongSystemBrowserSql,
    /CNYOS_BROWSER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await setCandidateAuthorization(browserDb, 'browser', {
    markers: { ...testTargetMarkers, environment: 'staging' }
  });
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_CANDIDATE_TARGET_MARKERS_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await setCandidateAuthorization(browserDb, 'browser');

  const browserLedgerEntry = migrationEntries[2];
  const browserEvidence =
    `-- recovered from supabase/migrations/${browserLedgerEntry.file}; sha256=${browserLedgerEntry.sha256}`;
  await browserDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2,'select 1']::text[] where version=$1`,
    [browserLedgerEntry.version, browserEvidence]
  );
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_CANDIDATE_LEDGER_MANIFEST_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.query(
    `update supabase_migrations.schema_migrations
     set statements=array[$2]::text[] where version=$1`,
    [browserLedgerEntry.version, browserEvidence]
  );

  // The ordered candidate contract closes trigger-function execution first.
  // The materialized browser fixture excludes the three PGlite-only pgcrypto
  // compatibility shims. Production SQL instead uses extension ownership and
  // contains no helper-name exclusion.
  await setCandidateAuthorization(browserDb, 'trigger');
  const triggerClosureNotices = [];
  await executeProjectedCandidate(browserDb, browserTriggerSql, {
    onNotice: notice => triggerClosureNotices.push(notice.message)
  });
  assert.equal(
    triggerClosureNotices.filter(message => message.startsWith(triggerNotice)).length,
    0
  );
  await assertNoSessionAdvisoryLocks(browserDb);

  for (const [role, signature] of browserTransitionalTuples) {
    await browserDb.exec(`grant execute on function ${signature} to ${role};`);
  }
  await setCandidateAuthorization(browserDb, 'browser');

  await browserDb.exec(`
    grant execute on function public.current_access_context() to anon;
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec('revoke execute on function public.current_access_context() from anon;');

  await browserDb.exec(`
    grant execute on function public.is_clinic_admin()
      to authenticated with grant option;
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec(`
    revoke grant option for execute on function public.is_clinic_admin()
      from authenticated;
  `);

  await assertDeferredCommitFailure(
    browserDb,
    browserSql,
    browserNotice,
    browserSnapshot
  );

  await browserDb.exec(`
    create temp table pg_proc(blocker integer);
    create temp table pg_namespace(blocker integer);
    create temp table pg_roles(blocker integer);
  `);
  await setHostileOutputGucs(browserDb);
  const browserNotices = [];
  await executeProjectedCandidate(browserDb, browserSql, {
    onNotice: notice => browserNotices.push(notice.message)
  });
  await resetOutputGucs(browserDb);
  assert.equal(browserNotices.filter(message => message.startsWith(browserNotice)).length, 0);
  await assertNoSessionAdvisoryLocks(browserDb);
  await browserDb.exec(`
    drop table pg_temp.pg_proc;
    drop table pg_temp.pg_namespace;
    drop table pg_temp.pg_roles;
  `);

  for (const signature of browserProcedures) {
    const owner = (await browserDb.query(`
      select owner_role.rolname owner
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
      where procedure.oid=to_regprocedure($1)
    `, [signature])).rows[0]?.owner;
    assert.equal(owner, 'postgres', `${signature} must retain the reviewed postgres owner`);
    const rows = (await browserDb.query(`
      select coalesce(grantee.rolname,'PUBLIC') grantee,
             acl.privilege_type,acl.is_grantable,
             acl.grantor=procedure.proowner owner_grantor
      from pg_catalog.pg_proc procedure
      cross join lateral pg_catalog.aclexplode(
        coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))
      ) acl
      left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
      where procedure.oid=to_regprocedure($1)
        and acl.grantee <> procedure.proowner
      order by grantee
    `, [signature])).rows;
    const expectedGrantees = browserHelpers.includes(signature)
      ? ['authenticated', 'service_role']
      : ['authenticated'];
    assert.deepEqual(rows, expectedGrantees.map(grantee => ({
      grantee,
      privilege_type: 'EXECUTE',
      is_grantable: false,
      owner_grantor: true
    })));
  }

  // PGlite rewrites an internal SQL-body representation on ALTER FUNCTION, so
  // DDL-based negative cases are exercised after the projected success path.
  // The production fingerprint intentionally treats that rewrite as security-
  // relevant catalog drift.
  await browserDb.exec(`
    alter function public.unlock_clinical_record_for_amendment(uuid,text)
      rename to unlock_clinical_record_for_amendment_missing_probe;
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_RPC_REQUIRED_FUNCTION_MISSING/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec(`
    alter function public.unlock_clinical_record_for_amendment_missing_probe(uuid,text)
      rename to unlock_clinical_record_for_amendment;
  `);

  const reviewedFunctionCost = (await browserDb.query(`
    select procost::text cost
    from pg_catalog.pg_proc
    where oid='public.is_clinic_admin()'::regprocedure
  `)).rows[0].cost;
  await browserDb.exec(`
    set extra_float_digits = -1;
    alter function public.is_clinic_admin()
      cost ${Number(reviewedFunctionCost) + 0.001};
  `);
  assert.equal(
    (await browserDb.query(`
      select procost::text cost
      from pg_catalog.pg_proc
      where oid='public.is_clinic_admin()'::regprocedure
    `)).rows[0].cost,
    reviewedFunctionCost,
    'hostile float formatting must mask the small browser-function drift outside the candidate'
  );
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_RPC_FUNCTION_SEMANTICS_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec(`
    alter function public.is_clinic_admin() cost ${reviewedFunctionCost};
    reset extra_float_digits;
  `);
  await browserDb.exec(`
    alter function public.is_clinic_admin() cost ${Number(reviewedFunctionCost) + 1};
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_RPC_FUNCTION_SEMANTICS_INVALID/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec(`alter function public.is_clinic_admin() cost ${reviewedFunctionCost};`);

  // The count guard is intentionally evaluated before per-function formatting,
  // so both a new overload and an unrelated public routine are rejected even
  // after the reviewed ACL projection has otherwise completed successfully.
  await browserDb.exec(`
    create function public.is_clinic_admin(uuid)
    returns integer language sql as $$ select 1 $$;
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID: phase=pre-catalog-count/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec('drop function public.is_clinic_admin(uuid);');

  await browserDb.exec(`
    create function public.cnyos_unrelated_data_api_backdoor()
    returns integer language sql as $$ select 1 $$;
  `);
  await assertAtomicFailure(
    browserDb,
    browserSql,
    /CNYOS_BROWSER_PROJECTED_CANONICAL_PUBLIC_ROUTINE_MANIFEST_INVALID: phase=pre-catalog-count/,
    browserNotice,
    browserSnapshot
  );
  await browserDb.exec('drop function public.cnyos_unrelated_data_api_backdoor();');
} finally {
  await browserDb.close();
}

console.log(
  'ACL candidate PostgreSQL contract passed: pinned trigger semantic/binding snapshots, ' +
  'owner/body/executable/schema/equal-count drift, atomic rollback, exact browser owners/ACLs, ' +
  'and ACL-independent trigger behavior'
);
